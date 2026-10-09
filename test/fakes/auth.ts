// A small stand-in for kervan-auth (SPEC §3): RFC 8414 metadata and a token
// endpoint that checks the private_key_jwt assertion against the client's
// metadata document the way the real server must.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createLocalJWKSet, generateKeyPair, jwtVerify, SignJWT, type JSONWebKeySet } from "jose";

export const SCOPES_SUPPORTED = ["shipments:read", "deliveries:write", "tickets:write", "help:read"];

export interface TokenRequestRecord {
  form: Record<string, string>;
  status: number;
  error?: string;
}

export interface FakeAuthOptions {
  allowedResources: string[];
  expiresIn?: number;
  /** Resolves a client id to its metadata document; defaults to fetching it. */
  resolveClient?: (clientId: string) => Promise<unknown>;
}

export interface FakeAuth {
  issuer: string;
  tokenEndpoint: string;
  requests: TokenRequestRecord[];
  issued: string[];
  isValid(token: string): boolean;
  /** Makes every token issued so far invalid, as after a key rotation. */
  revokeAll(): void;
  close(): Promise<void>;
}

export async function startFakeAuth(options: FakeAuthOptions): Promise<FakeAuth> {
  const { privateKey } = await generateKeyPair("ES256");
  const requests: TokenRequestRecord[] = [];
  const issued: string[] = [];
  const seenJti = new Set<string>();
  const revoked = new Set<string>();
  const expiresIn = options.expiresIn ?? 300;
  const resolveClient = options.resolveClient ?? (async (id: string) => (await fetch(id)).json());
  let issuer = "";

  const server: Server = createServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/.well-known/oauth-authorization-server") {
      return json(200, {
        issuer,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks.json`,
        grant_types_supported: ["client_credentials"],
        token_endpoint_auth_methods_supported: ["private_key_jwt"],
        token_endpoint_auth_signing_alg_values_supported: ["ES256"],
        scopes_supported: SCOPES_SUPPORTED,
        client_id_metadata_document_supported: true,
        resource_indicators_supported: true,
      });
    }
    if (req.method !== "POST" || req.url !== "/token") return json(404, { error: "not_found" });

    let body = "";
    for await (const chunk of req) body += chunk;
    const form = Object.fromEntries(new URLSearchParams(body));
    const fail = (status: number, error: string, description: string) => {
      requests.push({ form, status, error });
      json(status, { error, error_description: description });
    };

    if (form.grant_type !== "client_credentials") return fail(400, "unsupported_grant_type", "client_credentials only");
    if (form.client_assertion_type !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" || !form.client_assertion) {
      return fail(401, "invalid_client", "private_key_jwt required");
    }
    const clientId = form.client_id ?? "";
    let doc: { client_id?: string; scope?: string; jwks?: JSONWebKeySet };
    try {
      doc = (await resolveClient(clientId)) as typeof doc;
    } catch {
      return fail(401, "invalid_client", "metadata document unavailable");
    }
    if (doc.client_id !== clientId || !doc.jwks) return fail(401, "invalid_client", "client_id mismatch");
    try {
      const { payload } = await jwtVerify(form.client_assertion, createLocalJWKSet(doc.jwks), {
        algorithms: ["ES256"],
        issuer: clientId,
        subject: clientId,
        audience: `${issuer}/token`,
      });
      if (!payload.jti || seenJti.has(payload.jti)) throw new Error("jti replay");
      if (payload.exp === undefined || payload.iat === undefined || payload.exp - payload.iat > 60) throw new Error("exp too far");
      seenJti.add(payload.jti);
    } catch (err) {
      return fail(401, "invalid_client", (err as Error).message);
    }
    const scopes = (form.scope ?? "").split(" ").filter(Boolean);
    const allowed = new Set((doc.scope ?? "").split(" "));
    if (scopes.length === 0 || scopes.some((s) => !allowed.has(s) || !SCOPES_SUPPORTED.includes(s))) {
      return fail(400, "invalid_scope", "scope not allowed");
    }
    if (!form.resource || !options.allowedResources.includes(form.resource)) {
      return fail(400, "invalid_target", "resource not allowed");
    }

    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ scope: scopes.join(" "), client_id: clientId })
      .setProtectedHeader({ alg: "ES256", kid: "fake-auth" })
      .setIssuer(issuer)
      .setSubject(clientId)
      .setAudience(form.resource)
      .setIssuedAt(now)
      .setExpirationTime(now + expiresIn)
      .setJti(crypto.randomUUID())
      .sign(privateKey);
    issued.push(token);
    requests.push({ form, status: 200 });
    json(200, { access_token: token, token_type: "Bearer", expires_in: expiresIn, scope: scopes.join(" ") });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    tokenEndpoint: `${issuer}/token`,
    requests,
    issued,
    isValid: (token) => issued.includes(token) && !revoked.has(token),
    revokeAll: () => issued.forEach((t) => revoked.add(t)),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
