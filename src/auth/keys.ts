// The client's ES256 signing key (SPEC §2): generated at start and kept in
// memory, or loaded from the PEM file named by CLIENT_KEY_FILE.

import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { calculateJwkThumbprint, type JWK } from "jose";

export interface ClientKey {
  privateKey: KeyObject;
  /** Public JWK as published in the client metadata document. */
  publicJwk: JWK;
  kid: string;
}

export async function loadClientKey(file?: string): Promise<ClientKey> {
  const privateKey = file ? readPem(file) : generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  return fromPrivateKey(privateKey);
}

export async function fromPrivateKey(privateKey: KeyObject): Promise<ClientKey> {
  const details = privateKey.asymmetricKeyDetails;
  if (privateKey.asymmetricKeyType !== "ec" || details?.namedCurve !== "prime256v1") {
    throw new Error("client key must be an EC P-256 private key (ES256)");
  }
  const { kty, crv, x, y } = createPublicKey(privateKey).export({ format: "jwk" });
  const base = { kty, crv, x, y } as JWK;
  const kid = await calculateJwkThumbprint(base, "sha256");
  return { privateKey, kid, publicJwk: { ...base, kid, alg: "ES256", use: "sig" } };
}

function readPem(file: string): KeyObject {
  // Accepts PKCS#8 ("PRIVATE KEY") and SEC1 ("EC PRIVATE KEY") PEM.
  return createPrivateKey(readFileSync(file, "utf8"));
}
