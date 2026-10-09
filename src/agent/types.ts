// The /converse contract (SPEC §8) and what every agent mode implements.

export type ConversationState = "open" | "done";

export interface ToolCallRecord {
  name: string;
  arguments: Record<string, unknown>;
  is_error: boolean;
  result: unknown;
}

export interface Turn {
  reply: string;
  tool_calls: ToolCallRecord[];
  state: ConversationState;
}

export interface TurnContext {
  traceId: string;
}

export interface Agent {
  converse(conversationId: string, utterance: string, ctx: TurnContext): Promise<Turn>;
}
