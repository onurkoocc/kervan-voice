import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadClientKey } from "../src/auth/keys.js";
import { clientMetadata } from "../src/auth/metadata.js";
import { loadConfig } from "../src/config.js";
import { startVoice, type Voice } from "./fakes/voice.js";

describe("client metadata document", () => {
  it("has the SPEC §3.2 shape with a public ES256 key", async () => {
    const config = loadConfig({ PUBLIC_URL: "http://voice:7000/" });
    const doc = clientMetadata(config.clientId, await loadClientKey());
    expect(Object.keys(doc).sort()).toEqual(
      ["client_id", "client_name", "grant_types", "jwks", "scope", "token_endpoint_auth_method"].sort(),
    );
    expect(doc).toMatchObject({
      client_id: "http://voice:7000/client-metadata.json",
      client_name: "Kervan customer agent",
      grant_types: ["client_credentials"],
      token_endpoint_auth_method: "private_key_jwt",
      scope: "shipments:read deliveries:write tickets:write help:read",
    });
    expect(doc.jwks.keys).toHaveLength(1);
    const key = doc.jwks.keys[0]!;
    expect(Object.keys(key).sort()).toEqual(["alg", "crv", "kid", "kty", "use", "x", "y"]);
    expect(key).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig" });
    expect(key.kid).toMatch(/^[\w-]{43}$/);
    expect(key).not.toHaveProperty("d");
  });

  it("loads the key from CLIENT_KEY_FILE and keeps its kid stable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kervan-voice-"));
    try {
      const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const file = join(dir, "client.pem");
      writeFileSync(file, privateKey.export({ format: "pem", type: "pkcs8" }));
      const a = await loadClientKey(file);
      const b = await loadClientKey(file);
      expect(a.kid).toBe(b.kid);
      expect(a.publicJwk).toEqual(b.publicJwk);

      const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
      writeFileSync(file, rsa.export({ format: "pem", type: "pkcs8" }));
      await expect(loadClientKey(file)).rejects.toThrow(/P-256/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("GET /client-metadata.json", () => {
  let voice: Voice;
  beforeAll(async () => {
    voice = await startVoice({ issuer: "http://127.0.0.1:9", mcpUrl: "http://127.0.0.1:9/mcp", resource: "x" });
  });
  afterAll(() => voice.close());

  it("serves the document whose client_id is its own URL", async () => {
    const res = await fetch(voice.clientId);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const doc = (await res.json()) as { client_id: string };
    expect(doc).toEqual(voice.metadata);
    expect(doc.client_id).toBe(voice.clientId);
  });
});
