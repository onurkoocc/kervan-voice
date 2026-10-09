// Client ID metadata document (CIMD, SPEC §3.2).

import type { JWK } from "jose";
import type { ClientKey } from "./keys.js";

/** Every scope the agent may ask for; it asks for all of them. */
export const CLIENT_SCOPES = ["shipments:read", "deliveries:write", "tickets:write", "help:read"] as const;

export interface ClientMetadata {
  client_id: string;
  client_name: string;
  grant_types: ["client_credentials"];
  token_endpoint_auth_method: "private_key_jwt";
  scope: string;
  jwks: { keys: JWK[] };
}

export function clientMetadata(clientId: string, key: ClientKey): ClientMetadata {
  return {
    client_id: clientId,
    client_name: "Kervan customer agent",
    grant_types: ["client_credentials"],
    token_endpoint_auth_method: "private_key_jwt",
    scope: CLIENT_SCOPES.join(" "),
    jwks: { keys: [key.publicJwk] },
  };
}
