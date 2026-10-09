// The trace id of the current /converse turn, carried across async calls so
// outgoing requests (MCP, auth) can send it on as X-Trace-Id (SPEC §6).

import { AsyncLocalStorage } from "node:async_hooks";

export const TRACE_HEADER = "x-trace-id";

const store = new AsyncLocalStorage<string>();

export function withTraceId<T>(traceId: string, fn: () => T): T {
  return store.run(traceId, fn);
}

export function currentTraceId(): string | undefined {
  return store.getStore();
}

/** Adds X-Trace-Id to `headers` when a trace is active. */
export function traceHeaders(headers: Headers): Headers {
  const traceId = currentTraceId();
  if (traceId) headers.set(TRACE_HEADER, traceId);
  return headers;
}
