import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Logger } from "../src/log.js";

describe("JSON-lines logger", () => {
  it("writes one object per line to the sinks and appends to LOG_FILE", () => {
    const dir = mkdtempSync(join(tmpdir(), "kervan-voice-log-"));
    try {
      const file = join(dir, "nested", "voice.jsonl");
      const lines: string[] = [];
      const logger = new Logger("voice", { file, sinks: [(l) => lines.push(l)] });
      logger.info("tool call", { trace_id: "t1", tool: "get_shipment", duration_ms: 3, status: undefined });
      logger.warn("second", { service: "spoofed" });

      const written = readFileSync(file, "utf8").trim().split("\n");
      expect(written).toEqual(lines);
      const first = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(first).toMatchObject({ level: "info", service: "voice", msg: "tool call", trace_id: "t1", tool: "get_shipment" });
      expect(first).not.toHaveProperty("status");
      expect(new Date(first.ts as string).toISOString()).toBe(first.ts);
      expect(JSON.parse(lines[1]!)).toMatchObject({ level: "warn", service: "voice" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
