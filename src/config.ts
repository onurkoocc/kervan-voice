// Configuration comes from the environment only (SPEC §2). Defaults are the
// compose values, so a service started by compose needs nothing else.

export type AgentMode = "scripted" | "llm";

export interface Config {
  port: number;
  publicUrl: string;
  clientId: string;
  authIssuer: string;
  mcpUrl: string;
  mcpResource: string;
  agentMode: AgentMode;
  agentModel: string;
  anthropicApiKey: string | undefined;
  clientKeyFile: string | undefined;
  logFile: string | undefined;
}

export const CLIENT_METADATA_PATH = "/client-metadata.json";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const publicUrl = stripTrailingSlash(env.PUBLIC_URL || "http://voice:7000");
  const agentMode = env.AGENT_MODE || "scripted";
  if (agentMode !== "scripted" && agentMode !== "llm") {
    throw new Error(`AGENT_MODE must be "scripted" or "llm", not "${agentMode}"`);
  }
  const port = Number(env.PORT || "7000");
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT is not a valid port: "${env.PORT}"`);
  }
  return {
    port,
    publicUrl,
    clientId: `${publicUrl}${CLIENT_METADATA_PATH}`,
    authIssuer: stripTrailingSlash(env.AUTH_ISSUER || "http://auth:9000"),
    mcpUrl: env.MCP_URL || "http://mcp:3001/mcp",
    mcpResource: env.MCP_RESOURCE || "http://mcp:3001/mcp",
    agentMode,
    agentModel: env.AGENT_MODEL || "claude-sonnet-5-5",
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    clientKeyFile: env.CLIENT_KEY_FILE || undefined,
    logFile: env.LOG_FILE || undefined,
  };
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
