// One place where both agent modes call a tool: timing, logging (tool name
// and status only, never arguments) and turning transport failures into an
// error record instead of an exception.

import type { Logger } from "../log.js";
import type { ToolCaller } from "../mcp/client.js";
import type { ToolCallRecord } from "./types.js";

export interface ToolCall extends ToolCallRecord {
  /** Text of the tool result; for errors e.g. "409 not_reschedulable". */
  text: string;
}

export const TOOL_UNAVAILABLE = "tool_unavailable";

export async function invokeTool(
  tools: ToolCaller,
  logger: Logger,
  traceId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCall> {
  const started = performance.now();
  try {
    const outcome = await tools.callTool(name, args);
    logger.info(outcome.isError ? "tool error" : "tool call", {
      trace_id: traceId,
      tool: name,
      status: outcome.isError ? errorStatus(outcome.text) : undefined,
      duration_ms: Math.round(performance.now() - started),
    });
    return {
      name,
      arguments: args,
      is_error: outcome.isError,
      result: outcome.isError ? outcome.text : outcome.result,
      text: outcome.text,
    };
  } catch (err) {
    logger.error("tool call failed", {
      trace_id: traceId,
      tool: name,
      duration_ms: Math.round(performance.now() - started),
      error: (err as Error).name,
      detail: String((err as Error).message).slice(0, 200),
    });
    return { name, arguments: args, is_error: true, result: TOOL_UNAVAILABLE, text: TOOL_UNAVAILABLE };
  }
}

/** "409 not_reschedulable" → { status: 409, code: "not_reschedulable" }. */
export function parseToolError(text: string): { status?: number; code: string } {
  const match = /^(\d{3})\s+([a-z_]+)/.exec(text.trim());
  if (match) return { status: Number(match[1]), code: match[2]! };
  const scope = /^([a-z_]+):/.exec(text.trim());
  return { code: scope?.[1] ?? text.trim() };
}

function errorStatus(text: string): number | undefined {
  return parseToolError(text).status;
}
