// MCP client for kervan-mcp's customer tools (SPEC §4), over Streamable HTTP
// with the access token as a Bearer header (and the turn's X-Trace-Id) on
// every request.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { TokenSource } from "../auth/token-client.js";
import { traceHeaders } from "../trace.js";

export type ToolName = "get_shipment" | "reschedule_delivery" | "open_ticket" | "search_help";

export interface ToolOutcome {
  isError: boolean;
  /** structuredContent, else the parsed JSON text, else the raw text. */
  result: unknown;
  /** The first text content; for errors, e.g. "409 not_reschedulable". */
  text: string;
}

export interface ToolDescription {
  name: string;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
}

export interface ToolCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome>;
  listTools(): Promise<ToolDescription[]>;
  close(): Promise<void>;
}

export interface McpToolClientOptions {
  url: string;
  tokens: TokenSource;
  fetch?: FetchLike;
}

export class McpToolClient implements ToolCaller {
  private connection?: Promise<Client>;

  constructor(private readonly options: McpToolClientOptions) {}

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    const result = await this.withClient((client) => client.callTool({ name, arguments: args }));
    const content = Array.isArray(result.content) ? result.content : [];
    const first = content.find((c): c is { type: "text"; text: string } => c?.type === "text");
    const text = first?.text ?? "";
    const isError = result.isError === true;
    let value: unknown = text;
    if (!isError) value = result.structuredContent ?? parseJson(text);
    return { isError, result: value, text };
  }

  async listTools(): Promise<ToolDescription[]> {
    const { tools } = await this.withClient((client) => client.listTools());
    return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    if (connection) await (await connection.catch(() => undefined))?.close();
  }

  /** Runs `fn`; on a 401 drops the token and the session and tries once more. */
  private async withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.connect());
    } catch (err) {
      await this.close();
      if (!isUnauthorized(err)) throw err;
      this.options.tokens.invalidate();
      return fn(await this.connect());
    }
  }

  private connect(): Promise<Client> {
    this.connection ??= (async () => {
      const client = new Client({ name: "kervan-voice", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(new URL(this.options.url), {
        fetch: this.bearerFetch,
      });
      await client.connect(transport);
      return client;
    })().catch((err: unknown) => {
      this.connection = undefined;
      throw err;
    });
    return this.connection;
  }

  private readonly bearerFetch: FetchLike = async (url, init) => {
    const headers = traceHeaders(new Headers(init?.headers));
    headers.set("authorization", `Bearer ${await this.options.tokens.getToken()}`);
    return (this.options.fetch ?? fetch)(url, { ...init, headers });
  };
}

function isUnauthorized(err: unknown): boolean {
  return err instanceof UnauthorizedError || (err instanceof StreamableHTTPError && err.code === 401);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
