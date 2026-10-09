// HTTP surface (SPEC §8): GET /health, GET /client-metadata.json, POST /converse.
// docs/openapi.json describes exactly these.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import type { Agent } from "./agent/types.js";
import type { ClientMetadata } from "./auth/metadata.js";
import { CLIENT_METADATA_PATH } from "./config.js";
import type { Logger } from "./log.js";
import { TRACE_HEADER, withTraceId } from "./trace.js";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_UTTERANCE = 4000;
const MAX_CONVERSATION_ID = 200;

export interface AppDeps {
  metadata: ClientMetadata;
  agent: Agent;
  logger: Logger;
}

export function createApp({ metadata, agent, logger }: AppDeps): RequestListener {
  return (req, res) => {
    const traceId = headerTraceId(req) ?? randomUUID();
    res.setHeader(TRACE_HEADER, traceId);
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    const route = (method: string, handler: () => void | Promise<void>): void => {
      if (req.method !== method && !(method === "GET" && req.method === "HEAD")) {
        res.setHeader("allow", method);
        return send(res, 405, { error: "method_not_allowed" });
      }
      Promise.resolve(handler()).catch((err: unknown) => {
        logger.error("request failed", { trace_id: traceId, path, error: (err as Error).name });
        if (!res.headersSent) send(res, 500, { error: "internal_error" });
        else res.end();
      });
    };

    switch (path) {
      case "/health":
        return route("GET", () => send(res, 200, { status: "ok" }));
      case CLIENT_METADATA_PATH:
        return route("GET", () => send(res, 200, metadata, { "cache-control": "public, max-age=60" }));
      case "/converse":
        return route("POST", async () => {
          const started = performance.now();
          const body = await readJson(req);
          const input = parseConverse(body);
          if (typeof input === "string") return send(res, 400, { error: "invalid_request", message: input });
          const turn = await withTraceId(traceId, () =>
            agent.converse(input.conversation_id, input.utterance, { traceId }),
          );
          send(res, 200, turn);
          logger.info("converse", {
            trace_id: traceId,
            status: 200,
            state: turn.state,
            tool_calls: turn.tool_calls.length,
            duration_ms: Math.round(performance.now() - started),
          });
        });
      default:
        return send(res, 404, { error: "not_found" });
    }
  };
}

interface ConverseRequest {
  conversation_id: string;
  utterance: string;
}

function parseConverse(body: unknown): ConverseRequest | string {
  if (body === undefined) return "body must be JSON";
  if (body === null || typeof body !== "object" || Array.isArray(body)) return "body must be a JSON object";
  const { conversation_id, utterance } = body as Record<string, unknown>;
  if (typeof conversation_id !== "string" || conversation_id === "" || conversation_id.length > MAX_CONVERSATION_ID) {
    return `conversation_id must be a non-empty string of at most ${MAX_CONVERSATION_ID} characters`;
  }
  if (typeof utterance !== "string" || utterance.trim() === "" || utterance.length > MAX_UTTERANCE) {
    return `utterance must be a non-empty string of at most ${MAX_UTTERANCE} characters`;
  }
  return { conversation_id, utterance };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(json),
    ...headers,
  });
  res.end(json);
}

function headerTraceId(req: IncomingMessage): string | undefined {
  const value = req.headers[TRACE_HEADER];
  return typeof value === "string" && /^[\w.-]{1,128}$/.test(value) ? value : undefined;
}
