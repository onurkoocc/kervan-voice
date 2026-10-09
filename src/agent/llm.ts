// AGENT_MODE=llm: the same MCP tools driven by a Claude model through the
// Anthropic Messages API, with prompts/system.md as the system prompt.
// Not exercised by the tests (SPEC §8); it never runs unless chosen.

import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "../log.js";
import type { ToolCaller } from "../mcp/client.js";
import { ConversationStore } from "./conversations.js";
import { todayIn } from "./scripted/extract.js";
import { invokeTool, type ToolCall } from "./tools.js";
import type { Agent, ConversationState, Turn, TurnContext } from "./types.js";

/** Model round trips per customer turn before the agent gives up. */
const MAX_STEPS = 8;

/** A local tool the model calls when the customer's request is finished. */
const END_CONVERSATION: Anthropic.Tool = {
  name: "end_conversation",
  description: "Call this once the customer's request is fully handled or the customer says goodbye.",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
};

const FALLBACK_REPLY = "I'm sorry, I can't help with that right now. Please try again in a few minutes.";

export function loadSystemPrompt(): string {
  return readFileSync(new URL("../../prompts/system.md", import.meta.url), "utf8");
}

interface Conversation {
  messages: Anthropic.MessageParam[];
  state: ConversationState;
}

export interface LlmAgentOptions {
  tools: ToolCaller;
  logger: Logger;
  model: string;
  apiKey: string | undefined;
  systemPrompt?: string;
  client?: Anthropic;
}

export class LlmAgent implements Agent {
  private readonly client: Anthropic;
  private readonly system: string;
  private readonly conversations = new ConversationStore<Conversation>(() => ({ messages: [], state: "open" }));
  private toolList?: Promise<Anthropic.Tool[]>;

  constructor(private readonly options: LlmAgentOptions) {
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey });
    this.system = options.systemPrompt ?? loadSystemPrompt();
  }

  async converse(conversationId: string, utterance: string, ctx: TurnContext): Promise<Turn> {
    const conv = this.conversations.get(conversationId);
    conv.messages.push({ role: "user", content: utterance });
    conv.state = "open";
    const calls: ToolCall[] = [];
    let reply = "";

    for (let step = 0; step < MAX_STEPS; step++) {
      const started = performance.now();
      const response = await this.client.messages.create({
        model: this.options.model,
        max_tokens: 4096,
        output_config: { effort: "medium" },
        // The date goes last so the stable prompt stays a cacheable prefix.
        system: `${this.system}\nToday's date in Europe/Istanbul is ${todayIn()}.`,
        tools: await this.tools(),
        messages: conv.messages,
      });
      this.options.logger.info("model call", {
        trace_id: ctx.traceId,
        model: response.model,
        stop_reason: response.stop_reason,
        duration_ms: Math.round(performance.now() - started),
      });
      conv.messages.push({ role: "assistant", content: response.content });
      reply = textOf(response.content) || reply;

      if (response.stop_reason === "refusal") {
        reply = FALLBACK_REPLY;
        break;
      }
      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (response.stop_reason !== "tool_use" || toolUses.length === 0) break;

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        if (use.name === END_CONVERSATION.name) {
          conv.state = "done";
          results.push({ type: "tool_result", tool_use_id: use.id, content: "ok" });
          continue;
        }
        const call = await invokeTool(this.options.tools, this.options.logger, ctx.traceId, use.name, asArgs(use.input));
        calls.push(call);
        results.push({ type: "tool_result", tool_use_id: use.id, content: call.text || JSON.stringify(call.result), is_error: call.is_error });
      }
      conv.messages.push({ role: "user", content: results });
    }

    return {
      reply: reply || FALLBACK_REPLY,
      tool_calls: calls.map(({ text: _text, ...call }) => call),
      state: conv.state,
    };
  }

  private tools(): Promise<Anthropic.Tool[]> {
    this.toolList ??= this.options.tools
      .listTools()
      .then((tools) => [
        ...tools.map((t) => ({
          name: t.name,
          description: t.description ?? t.name,
          input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        })),
        END_CONVERSATION,
      ])
      .catch((err: unknown) => {
        this.toolList = undefined;
        throw err;
      });
    return this.toolList;
  }
}

function textOf(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function asArgs(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}
