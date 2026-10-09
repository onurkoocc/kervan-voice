// Entry point: wire configuration, keys, token client, MCP client and the
// agent, then serve HTTP.

import { createServer } from "node:http";
import { LlmAgent } from "./agent/llm.js";
import { ScriptedAgent } from "./agent/scripted/policy.js";
import type { Agent } from "./agent/types.js";
import { loadClientKey } from "./auth/keys.js";
import { CLIENT_SCOPES, clientMetadata } from "./auth/metadata.js";
import { TokenClient } from "./auth/token-client.js";
import { loadConfig } from "./config.js";
import { Logger } from "./log.js";
import { McpToolClient } from "./mcp/client.js";
import { createApp } from "./server.js";

const config = loadConfig();
const logger = new Logger("voice", { file: config.logFile });

const key = await loadClientKey(config.clientKeyFile);
const tokens = new TokenClient({
  issuer: config.authIssuer,
  clientId: config.clientId,
  key,
  scope: CLIENT_SCOPES.join(" "),
  resource: config.mcpResource,
});
const tools = new McpToolClient({ url: config.mcpUrl, tokens });

const agent: Agent =
  config.agentMode === "llm"
    ? new LlmAgent({ tools, logger, model: config.agentModel, apiKey: config.anthropicApiKey })
    : new ScriptedAgent({ tools, logger });

const server = createServer(createApp({ metadata: clientMetadata(config.clientId, key), agent, logger }));
server.listen(config.port, () => {
  logger.info("listening", {
    port: config.port,
    client_id: config.clientId,
    agent_mode: config.agentMode,
    key_source: config.clientKeyFile ? "file" : "generated",
  });
});

const shutdown = (): void => {
  logger.info("shutting down");
  server.close(() => {
    void tools.close().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
