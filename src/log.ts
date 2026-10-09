// JSON-lines logging (SPEC §6). One object per line on stdout and, when
// LOG_FILE is set, appended to that file. Callers pass intents, tool names,
// tracking numbers and statuses; never raw utterances, names, phones, emails
// or tokens.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Level = "info" | "warn" | "error";

export interface LogFields {
  trace_id?: string;
  tool?: string;
  status?: number;
  duration_ms?: number;
  [key: string]: unknown;
}

export type LogSink = (line: string) => void;

export class Logger {
  private readonly sinks: LogSink[];

  constructor(
    private readonly service: string,
    options: { file?: string | undefined; sinks?: LogSink[] } = {},
  ) {
    this.sinks = options.sinks ?? [(line) => process.stdout.write(line + "\n")];
    if (options.file) this.sinks.push(fileSink(options.file));
  }

  info(msg: string, fields: LogFields = {}): void {
    this.write("info", msg, fields);
  }

  warn(msg: string, fields: LogFields = {}): void {
    this.write("warn", msg, fields);
  }

  error(msg: string, fields: LogFields = {}): void {
    this.write("error", msg, fields);
  }

  private write(level: Level, msg: string, fields: LogFields): void {
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      service: this.service,
      msg,
    };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && !(key in entry)) entry[key] = value;
    }
    const line = JSON.stringify(entry);
    for (const sink of this.sinks) sink(line);
  }
}

function fileSink(file: string): LogSink {
  let broken = false;
  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch {
    // appendFileSync below reports the problem once
  }
  return (line) => {
    if (broken) return;
    try {
      appendFileSync(file, line + "\n");
    } catch (err) {
      broken = true;
      process.stderr.write(`cannot write LOG_FILE ${file}: ${(err as Error).message}\n`);
    }
  };
}
