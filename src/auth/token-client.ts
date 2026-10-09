// OAuth client_credentials with private_key_jwt (SPEC §3.3). The token
// endpoint is read from the issuer's RFC 8414 metadata; the access token is
// cached until shortly before it expires.

import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { traceHeaders } from "../trace.js";
import type { ClientKey } from "./keys.js";

export const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
/** Assertion lifetime; SPEC §3.3 allows at most 60 s. */
export const ASSERTION_TTL_SECONDS = 30;

export interface TokenSource {
  getToken(): Promise<string>;
  /** Drop the cached token, e.g. after the resource server rejected it. */
  invalidate(): void;
}

export interface TokenClientOptions {
  issuer: string;
  clientId: string;
  key: ClientKey;
  scope: string;
  resource: string;
  fetch?: typeof fetch;
  /** Milliseconds since the epoch; injectable for tests. */
  now?: () => number;
  /** Refresh this many seconds before expiry (capped at half the lifetime). */
  refreshSkewSeconds?: number;
}

export class TokenError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    description?: string,
  ) {
    super(description ? `${error}: ${description}` : error);
    this.name = "TokenError";
  }
}

interface ServerMetadata {
  issuer: string;
  token_endpoint: string;
}

interface CachedToken {
  value: string;
  refreshAt: number;
}

export class TokenClient implements TokenSource {
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private metadata?: Promise<ServerMetadata>;
  private cached?: CachedToken;
  private inflight?: Promise<string>;

  constructor(private readonly options: TokenClientOptions) {
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async getToken(): Promise<string> {
    if (this.cached && this.now() < this.cached.refreshAt) return this.cached.value;
    this.inflight ??= this.requestToken().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  async tokenEndpoint(): Promise<string> {
    this.metadata ??= this.fetchMetadata().catch((err: unknown) => {
      this.metadata = undefined;
      throw err;
    });
    return (await this.metadata).token_endpoint;
  }

  /** The private_key_jwt client assertion: iss = sub = client_id, aud = token endpoint. */
  async buildAssertion(audience: string): Promise<string> {
    const { clientId, key } = this.options;
    const iat = Math.floor(this.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: key.kid, typ: "JWT" })
      .setIssuer(clientId)
      .setSubject(clientId)
      .setAudience(audience)
      .setIssuedAt(iat)
      .setExpirationTime(iat + ASSERTION_TTL_SECONDS)
      .setJti(randomUUID())
      .sign(key.privateKey);
  }

  private async requestToken(): Promise<string> {
    const endpoint = await this.tokenEndpoint();
    const { clientId, scope, resource } = this.options;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_assertion_type: ASSERTION_TYPE,
      client_assertion: await this.buildAssertion(endpoint),
      scope,
      resource,
    });
    const startedAt = this.now();
    const res = await this.fetch(endpoint, {
      method: "POST",
      headers: traceHeaders(new Headers({ "content-type": "application/x-www-form-urlencoded", accept: "application/json" })),
      body,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new TokenError(res.status, str(json.error) ?? "token_request_failed", str(json.error_description));
    }
    const token = str(json.access_token);
    const expiresIn = typeof json.expires_in === "number" ? json.expires_in : NaN;
    if (!token || str(json.token_type)?.toLowerCase() !== "bearer" || !(expiresIn > 0)) {
      throw new TokenError(res.status, "invalid_token_response", "missing access_token, token_type or expires_in");
    }
    const skew = Math.min(this.options.refreshSkewSeconds ?? 30, expiresIn / 2);
    this.cached = { value: token, refreshAt: startedAt + (expiresIn - skew) * 1000 };
    return token;
  }

  private async fetchMetadata(): Promise<ServerMetadata> {
    const { issuer } = this.options;
    const res = await this.fetch(`${issuer}/.well-known/oauth-authorization-server`, {
      headers: traceHeaders(new Headers({ accept: "application/json" })),
    });
    if (!res.ok) throw new TokenError(res.status, "metadata_unavailable", `issuer metadata answered ${res.status}`);
    const json = (await res.json()) as Record<string, unknown>;
    const tokenEndpoint = str(json.token_endpoint);
    if (json.issuer !== issuer || !tokenEndpoint) {
      throw new TokenError(res.status, "invalid_metadata", "issuer mismatch or no token_endpoint");
    }
    return { issuer, token_endpoint: tokenEndpoint };
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
