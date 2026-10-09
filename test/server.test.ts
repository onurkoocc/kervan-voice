import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Agent } from "../src/agent/types.js";
import { startVoice, type Voice } from "./fakes/voice.js";

const echo: Agent = {
  converse: async (id, utterance) => ({ reply: `${id}:${utterance.length}`, tool_calls: [], state: "open" }),
};

let voice: Voice;
beforeAll(async () => {
  voice = await startVoice({ issuer: "http://127.0.0.1:9", mcpUrl: "http://127.0.0.1:9/mcp", resource: "x", agent: echo });
});
afterAll(() => voice.close());

describe("HTTP surface", () => {
  it("answers /health", async () => {
    const res = await fetch(`${voice.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(res.headers.get("x-trace-id")).toBeTruthy();
  });

  it("runs a /converse turn and echoes the trace id", async () => {
    const res = await fetch(`${voice.url}/converse`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-trace-id": "trace-1" },
      body: JSON.stringify({ conversation_id: "c1", utterance: "hello" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-trace-id")).toBe("trace-1");
    expect(await res.json()).toEqual({ reply: "c1:5", tool_calls: [], state: "open" });
  });

  it.each([
    ["not json", "{"],
    ["missing utterance", JSON.stringify({ conversation_id: "c1" })],
    ["empty conversation id", JSON.stringify({ conversation_id: "", utterance: "hi" })],
    ["array body", "[]"],
  ])("rejects %s with 400", async (_name, body) => {
    const res = await fetch(`${voice.url}/converse`, { method: "POST", body });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });

  it("answers 404 and 405", async () => {
    expect((await fetch(`${voice.url}/nope`)).status).toBe(404);
    const res = await fetch(`${voice.url}/converse`);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});

describe("docs/openapi.json", () => {
  const doc = JSON.parse(readFileSync(new URL("../docs/openapi.json", import.meta.url), "utf8")) as {
    openapi: string;
    paths: Record<string, Record<string, unknown>>;
  };

  it("parses and lists exactly the served paths", () => {
    expect(doc.openapi).toMatch(/^3\./);
    expect(Object.keys(doc.paths).sort()).toEqual(["/client-metadata.json", "/converse", "/health"]);
    expect(Object.keys(doc.paths["/converse"]!)).toEqual(["post"]);
    expect(Object.keys(doc.paths["/health"]!)).toEqual(["get"]);
    expect(Object.keys(doc.paths["/client-metadata.json"]!)).toEqual(["get"]);
  });

  it("describes what the service actually serves", async () => {
    const res = await fetch(voice.clientId);
    const served = Object.keys((await res.json()) as object).sort();
    const schemas = (doc as unknown as { components: { schemas: Record<string, { required: string[] }> } }).components
      .schemas;
    expect([...schemas.ClientMetadata!.required].sort()).toEqual(served);
    expect([...schemas.ConverseResponse!.required].sort()).toEqual(["reply", "state", "tool_calls"]);
  });
});
