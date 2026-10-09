// Starts kervan-voice in process, wired like main.ts, against the fakes.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ScriptedAgent } from "../../src/agent/scripted/policy.js";
import type { Agent, Turn } from "../../src/agent/types.js";
import { loadClientKey } from "../../src/auth/keys.js";
import { CLIENT_SCOPES, clientMetadata, type ClientMetadata } from "../../src/auth/metadata.js";
import { TokenClient } from "../../src/auth/token-client.js";
import { CLIENT_METADATA_PATH } from "../../src/config.js";
import { Logger } from "../../src/log.js";
import { McpToolClient } from "../../src/mcp/client.js";
import { createApp } from "../../src/server.js";

export interface Voice {
  url: string;
  clientId: string;
  metadata: ClientMetadata;
  logs: string[];
  tokens: TokenClient;
  converse(conversationId: string, utterance: string): Promise<Turn>;
  close(): Promise<void>;
}

export interface StartVoiceOptions {
  issuer: string;
  mcpUrl: string;
  resource: string;
  today?: string;
  /** Replaces the scripted agent (server tests). */
  agent?: Agent;
}

export async function startVoice(options: StartVoiceOptions): Promise<Voice> {
  const http: Server = createServer();
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const clientId = `${url}${CLIENT_METADATA_PATH}`;

  const logs: string[] = [];
  const logger = new Logger("voice", { sinks: [(line) => logs.push(line)] });
  const key = await loadClientKey();
  const tokens = new TokenClient({
    issuer: options.issuer,
    clientId,
    key,
    scope: CLIENT_SCOPES.join(" "),
    resource: options.resource,
  });
  const tools = new McpToolClient({ url: options.mcpUrl, tokens });
  const today = options.today ?? "2026-10-09";
  const agent = options.agent ?? new ScriptedAgent({ tools, logger, today: () => today });
  const metadata = clientMetadata(clientId, key);
  http.on("request", createApp({ metadata, agent, logger }));

  return {
    url,
    clientId,
    metadata,
    logs,
    tokens,
    async converse(conversationId, utterance) {
      const res = await fetch(`${url}/converse`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversation_id: conversationId, utterance }),
      });
      if (res.status !== 200) throw new Error(`converse answered ${res.status}: ${await res.text()}`);
      return (await res.json()) as Turn;
    },
    async close() {
      await tools.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
