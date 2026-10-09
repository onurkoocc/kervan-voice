// Replays every kervan-voice-evals scenario (mirrored in test/eval-scenarios)
// against the scripted agent and the fakes, with the evals' deterministic
// checks: tool calls in order (arguments as a subset, expect_error),
// reply_contains, forbidden_tools and final_state.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { addDays } from "../src/agent/scripted/extract.js";
import type { ToolCallRecord, Turn } from "../src/agent/types.js";
import { startFakeAuth, type FakeAuth } from "./fakes/auth.js";
import { startFakeMcp, type FakeMcp } from "./fakes/mcp.js";
import { startVoice, type Voice } from "./fakes/voice.js";

const TODAY = "2026-10-09";
const RESOURCE = "http://mcp:3001/mcp";
const MIRROR = new URL("./eval-scenarios/", import.meta.url);
const UPSTREAM = new URL("../../kervan-voice-evals/scenarios/", import.meta.url);

interface ExpectedCall {
  name: string;
  arguments?: Record<string, string>;
  expect_error?: boolean;
}

interface Scenario {
  id: string;
  description: string;
  turns: string[];
  expect: {
    tool_calls?: ExpectedCall[];
    reply_contains?: string[];
    forbidden_tools?: string[];
    final_state?: "open" | "done";
  };
}

/** {{today}}, {{today+N}}, {{today-N}} → ISO dates, as the evals expand them. */
function expand<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(/\{\{today(?:([+-])(\d+))?\}\}/g, (_m, sign?: string, n?: string) =>
      addDays(TODAY, sign ? (sign === "-" ? -1 : 1) * Number(n) : 0),
    ) as T;
  }
  if (Array.isArray(value)) return value.map(expand) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)])) as T;
  }
  return value;
}

const files = (dir: URL) => readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort();
const scenarios = files(MIRROR).map((f) => expand(parse(readFileSync(new URL(f, MIRROR), "utf8")) as Scenario));

function matches(call: ToolCallRecord, want: ExpectedCall): boolean {
  if (call.name !== want.name || call.is_error !== (want.expect_error ?? false)) return false;
  return Object.entries(want.arguments ?? {}).every(([k, v]) => call.arguments[k] === v);
}

let auth: FakeAuth;
let mcp: FakeMcp;
let voice: Voice;

beforeAll(async () => {
  auth = await startFakeAuth({ allowedResources: [RESOURCE] });
  mcp = await startFakeMcp((token) => auth.isValid(token), TODAY);
  voice = await startVoice({ issuer: auth.issuer, mcpUrl: mcp.url, resource: RESOURCE, today: TODAY });
});

afterAll(async () => {
  await voice?.close();
  await mcp?.close();
  await auth?.close();
});

describe("kervan-voice-evals scenarios", () => {
  it("are all mirrored", () => {
    expect(scenarios.map((s) => s.id)).toEqual(files(MIRROR).map((f) => f.replace(/\.yaml$/, "")));
    expect(scenarios.length).toBeGreaterThanOrEqual(10);
  });

  it.skipIf(!existsSync(UPSTREAM))("match the copies in the sibling kervan-voice-evals checkout", () => {
    expect(files(MIRROR)).toEqual(files(UPSTREAM));
    for (const f of files(MIRROR)) {
      const norm = (u: URL) => readFileSync(new URL(f, u), "utf8").replace(/\r\n/g, "\n");
      expect(norm(MIRROR), f).toBe(norm(UPSTREAM));
    }
  });

  it.each(scenarios.map((s) => [s.id, s] as const))("%s", async (id, scenario) => {
    const turns: Turn[] = [];
    for (const utterance of scenario.turns) turns.push(await voice.converse(`eval-${id}`, utterance));
    const calls = turns.flatMap((t) => t.tool_calls);
    const last = turns.at(-1)!;
    const { tool_calls = [], reply_contains = [], forbidden_tools = [], final_state } = scenario.expect;

    let from = 0;
    for (const want of tool_calls) {
      const at = calls.findIndex((c, i) => i >= from && matches(c, want));
      expect(at, `${want.name} ${JSON.stringify(want)} in ${JSON.stringify(calls)}`).toBeGreaterThanOrEqual(0);
      from = at + 1;
    }
    for (const text of reply_contains) expect(last.reply.toLowerCase()).toContain(text.toLowerCase());
    for (const name of forbidden_tools) expect(calls.map((c) => c.name)).not.toContain(name);
    if (final_state) expect(last.state).toBe(final_state);
  });
});
