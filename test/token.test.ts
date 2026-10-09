import { afterEach, describe, expect, it } from "vitest";
import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { loadClientKey } from "../src/auth/keys.js";
import { CLIENT_SCOPES, clientMetadata } from "../src/auth/metadata.js";
import { ASSERTION_TYPE, TokenClient, TokenError } from "../src/auth/token-client.js";
import { startFakeAuth, type FakeAuth } from "./fakes/auth.js";

const CLIENT_ID = "http://voice:7000/client-metadata.json";
const RESOURCE = "http://mcp:3001/mcp";

let auth: FakeAuth | undefined;
afterEach(async () => {
  await auth?.close();
  auth = undefined;
});

async function setup(opts: { expiresIn?: number; resource?: string; now?: () => number } = {}) {
  const key = await loadClientKey();
  const metadata = clientMetadata(CLIENT_ID, key);
  auth = await startFakeAuth({
    allowedResources: [RESOURCE],
    expiresIn: opts.expiresIn ?? 300,
    resolveClient: async (id) => (id === CLIENT_ID ? metadata : Promise.reject(new Error("unknown"))),
  });
  const client = new TokenClient({
    issuer: auth.issuer,
    clientId: CLIENT_ID,
    key,
    scope: CLIENT_SCOPES.join(" "),
    resource: opts.resource ?? RESOURCE,
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { auth, client, key, metadata };
}

describe("client assertion", () => {
  it("carries iss = sub = client_id, aud = token endpoint, a short exp and a unique jti", async () => {
    const { auth, client, metadata } = await setup();
    const endpoint = await client.tokenEndpoint();
    expect(endpoint).toBe(`${auth.issuer}/token`);

    const a = await client.buildAssertion(endpoint);
    const b = await client.buildAssertion(endpoint);
    const header = decodeProtectedHeader(a);
    expect(header).toMatchObject({ alg: "ES256", kid: metadata.jwks.keys[0]!.kid });

    const { payload } = await jwtVerify(a, createLocalJWKSet(metadata.jwks), { algorithms: ["ES256"] });
    expect(payload.iss).toBe(CLIENT_ID);
    expect(payload.sub).toBe(CLIENT_ID);
    expect(payload.aud).toBe(endpoint);
    expect(payload.exp! - payload.iat!).toBeGreaterThan(0);
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(60);
    expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(decodeJwt(b).jti).not.toBe(payload.jti);
  });
});

describe("token client", () => {
  it("sends the SPEC §3.3 form and returns the access token", async () => {
    const { auth, client } = await setup();
    const token = await client.getToken();
    expect(token).toBe(auth.issued[0]);
    expect(auth.requests).toHaveLength(1);
    expect(auth.requests[0]).toMatchObject({
      status: 200,
      form: {
        grant_type: "client_credentials",
        client_id: CLIENT_ID,
        client_assertion_type: ASSERTION_TYPE,
        scope: "shipments:read deliveries:write tickets:write help:read",
        resource: RESOURCE,
      },
    });
    expect(decodeJwt(token)).toMatchObject({ aud: RESOURCE, sub: CLIENT_ID });
  });

  it("caches the token and refreshes it shortly before expiry", async () => {
    let now = Date.now();
    const { auth, client } = await setup({ expiresIn: 300, now: () => now });

    const first = await client.getToken();
    now += 200_000;
    expect(await client.getToken()).toBe(first);
    expect(auth.requests).toHaveLength(1);

    now += 80_000; // 280 s: inside the 30 s refresh window
    const second = await client.getToken();
    expect(second).not.toBe(first);
    expect(auth.requests).toHaveLength(2);
    expect(await client.getToken()).toBe(second);
  });

  it("refreshes short-lived tokens at half their lifetime", async () => {
    let now = Date.now();
    const { auth, client } = await setup({ expiresIn: 20, now: () => now });
    await client.getToken();
    now += 9_000;
    await client.getToken();
    expect(auth.requests).toHaveLength(1);
    now += 2_000;
    await client.getToken();
    expect(auth.requests).toHaveLength(2);
  });

  it("makes one request for concurrent callers", async () => {
    const { auth, client } = await setup();
    const tokens = await Promise.all([client.getToken(), client.getToken(), client.getToken()]);
    expect(new Set(tokens).size).toBe(1);
    expect(auth.requests).toHaveLength(1);
  });

  it("fetches a new token after invalidate()", async () => {
    const { auth, client } = await setup();
    const first = await client.getToken();
    client.invalidate();
    expect(await client.getToken()).not.toBe(first);
    expect(auth.requests).toHaveLength(2);
  });

  it("surfaces RFC 6749 errors as TokenError", async () => {
    const { client } = await setup({ resource: "http://elsewhere/mcp" });
    const err = await client.getToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TokenError);
    expect(err).toMatchObject({ status: 400, error: "invalid_target" });
  });
});
