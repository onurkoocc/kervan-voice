// AGENT_MODE=scripted: the deterministic customer agent (SPEC §8).
//
// Each turn: extract slots and an intent from the utterance (extract.ts),
// merge them into the conversation's state, ask for whatever the current task
// still needs, otherwise call the task's tool and answer from its result.
// All wording lives in REPLIES below. prompts/system.md describes the same
// policy for the llm mode; keep the two in step.

import type { Logger } from "../../log.js";
import type { ToolCaller } from "../../mcp/client.js";
import { ConversationStore } from "../conversations.js";
import { invokeTool, parseToolError, type ToolCall } from "../tools.js";
import type { Agent, ConversationState, Turn, TurnContext } from "../types.js";
import { extract, todayIn, type Extracted, type TaskIntent } from "./extract.js";

/** Verification failures after which a reschedule is given up. */
export const MAX_CODE_ATTEMPTS = 3;

interface Shipment {
  trackingNo: string;
  status: string;
  originCity?: string;
  destinationCity?: string;
  estimatedDelivery?: string | null;
  lastEvent?: { at: string; description: string } | null;
}

interface Delivery {
  trackingNo: string;
  deliveryDate: string;
  window?: string;
}

interface Ticket {
  ticketId: string;
}

interface HelpResults {
  results?: { title: string; snippet: string }[];
}

type Slot = "trackingNo" | "date" | "code";

// The eval scenarios (kervan-voice-evals, mirrored in test/eval-scenarios)
// match on these phrases, case-insensitively: "in transit" and the tracking
// number for a status, "rescheduled" and the new date, "verification code"
// when asking for or rejecting a code, "cannot be rescheduled" for 409, the
// TCK- ticket id, and "could not find" for an unknown tracking number.
export const REPLIES = {
  greeting:
    "Hello, this is Kervan customer service. I can track a parcel, reschedule a delivery, report a damaged, lost or late parcel, or answer a question. How can I help?",
  whatDoYouNeed:
    "I can track a parcel, reschedule a delivery, report a damaged, lost or late parcel, or answer a question. What would you like to do?",
  thanks: "You're welcome. Have a nice day!",
  credentials: "I can't share any credentials or internal details. Is there anything I can help you with about your parcel?",
  askHelpQuestion: "Of course. What is your question?",
  ask: {
    trackingNo: "the tracking number (KRV followed by 8 digits)",
    date: "the new delivery date (for example 2026-10-15, or say tomorrow)",
    code: "the 4-digit verification code, which is the last four digits of the recipient's phone number",
  } satisfies Record<Slot, string>,
  codeRequired:
    "I'm sorry, I can only reschedule a delivery with the verification code: the last four digits of the recipient's phone number. Please tell me when you have it.",
  notFound: (trackingNo: string) =>
    `I could not find a shipment with tracking number ${trackingNo}. Could you check it and tell me again?`,
  verificationFailed: (trackingNo: string) =>
    `The verification code did not match, so I did not reschedule ${trackingNo}. Please check the last four digits of the recipient's phone number and tell me the code again.`,
  verificationGaveUp:
    "I'm sorry, the verification code did not match again, so I can't change the delivery. Please contact us from the recipient's phone number.",
  notReschedulable: (trackingNo: string) =>
    `I'm sorry, ${trackingNo} cannot be rescheduled: it is already out for delivery, delivered or returned.`,
  invalidDate: "That date isn't available. Please choose a date between tomorrow and 14 days from today.",
  rescheduled: (d: Delivery) =>
    `Done: the delivery of ${d.trackingNo} has been rescheduled to ${d.deliveryDate}${d.window ? ` (${d.window.toLowerCase()})` : ""}.`,
  ticketOpened: (category: TicketCategory, ticketId: string, trackingNo?: string) =>
    `${TICKET_INTRO[category]} I've opened ticket ${ticketId}${trackingNo ? ` for ${trackingNo}` : ""}. Our team will follow up with you.`,
  noHelpFound: "I could not find an answer to that in our help center. Could you rephrase the question?",
  helpFound: (title: string, snippet: string) => `Here is what I found. ${title}: ${snippet}`,
  systemProblem: "I'm sorry, I can't do that right now because of a problem on our side. Please try again in a few minutes.",
};

type TicketCategory = "DAMAGED" | "LOST" | "DELAY";

const TICKET_INTRO: Record<TicketCategory, string> = {
  DAMAGED: "I'm sorry your parcel arrived damaged.",
  LOST: "I'm sorry your parcel hasn't reached you.",
  DELAY: "I'm sorry for the delay.",
};

// Ticket descriptions are fixed text: the customer's own words may carry
// personal data, and the ticket only needs the category and the shipment.
const TICKET_DESCRIPTION: Record<TicketCategory, string> = {
  DAMAGED: "Customer reports that the parcel arrived damaged. Reported via the customer agent.",
  LOST: "Customer reports that the parcel has not been received and may be lost. Reported via the customer agent.",
  DELAY: "Customer reports that the delivery is late. Reported via the customer agent.",
};

const STATUS_TEXT: Record<string, string> = {
  CREATED: "has been created and is waiting to be picked up",
  IN_TRANSIT: "is in transit",
  OUT_FOR_DELIVERY: "is out for delivery today",
  DELIVERED: "has been delivered",
  RETURNED: "has been returned to the sender",
};

interface State {
  task?: TaskIntent;
  trackingNo?: string;
  date?: string;
  code?: string;
  noTrackingNo: boolean;
  codeFailures: number;
  awaitingHelpQuestion: boolean;
  state: ConversationState;
}

const newState = (): State => ({ noTrackingNo: false, codeFailures: 0, awaitingHelpQuestion: false, state: "open" });

export interface ScriptedAgentOptions {
  tools: ToolCaller;
  logger: Logger;
  /** Today's date (YYYY-MM-DD) for "tomorrow"; defaults to Europe/Istanbul. */
  today?: () => string;
}

export class ScriptedAgent implements Agent {
  private readonly conversations = new ConversationStore<State>(newState);
  private readonly today: () => string;

  constructor(private readonly options: ScriptedAgentOptions) {
    this.today = options.today ?? (() => todayIn());
  }

  async converse(conversationId: string, utterance: string, ctx: TurnContext): Promise<Turn> {
    const s = this.conversations.get(conversationId);
    const x = extract(utterance, this.today());
    const turn = new TurnBuilder(this.options.tools, this.options.logger, ctx.traceId);

    await this.step(s, x, utterance, turn);

    this.options.logger.info("turn", {
      trace_id: ctx.traceId,
      conversation_id: conversationId,
      intent: x.intent,
      task: s.task,
      tools: turn.calls.map((c) => c.name),
      state: s.state,
    });
    return { reply: turn.reply, tool_calls: turn.calls.map(({ text: _text, ...call }) => call), state: s.state };
  }

  private async step(s: State, x: Extracted, utterance: string, turn: TurnBuilder): Promise<void> {
    const hasSlots = x.trackingNo !== undefined || x.date !== undefined || x.code !== undefined;

    if (x.intent === "credentials") return turn.say(REPLIES.credentials);
    if (x.intent === "thanks" && !hasSlots) {
      Object.assign(s, newState(), { state: "done" });
      return turn.say(REPLIES.thanks);
    }
    if (x.intent === "greeting" && !hasSlots && !s.task) return turn.say(REPLIES.greeting);

    // A help question in progress takes the next utterance as the question.
    if (s.awaitingHelpQuestion && !hasSlots && (x.intent === undefined || x.intent === "help")) {
      s.awaitingHelpQuestion = false;
      return this.help(s, utterance, turn);
    }

    if (isTask(x.intent) && x.intent !== s.task) this.startTask(s, x.intent);
    if (x.trackingNo !== undefined && x.trackingNo !== s.trackingNo) {
      s.trackingNo = x.trackingNo;
      s.codeFailures = 0;
    }
    if (x.date !== undefined) s.date = x.date;
    if (x.code !== undefined) s.code = x.code;
    if (x.noTrackingNo) s.noTrackingNo = true;

    // A bare tracking number with nothing else going on is a status request.
    if (!s.task && s.trackingNo) s.task = "status";
    s.state = "open";

    switch (s.task) {
      case "status":
        return this.status(s, turn);
      case "reschedule":
        return this.reschedule(s, x, turn);
      case "damaged":
        return this.ticket(s, "DAMAGED", turn);
      case "lost":
        return this.ticket(s, "LOST", turn);
      case "late":
        return this.late(s, turn);
      case "help":
        if (/^\W*(help|i need help|i have a question|question|can you help( me)?)\W*$/i.test(utterance)) {
          s.awaitingHelpQuestion = true;
          return turn.say(REPLIES.askHelpQuestion);
        }
        return this.help(s, utterance, turn);
      default:
        return turn.say(REPLIES.whatDoYouNeed);
    }
  }

  private startTask(s: State, task: TaskIntent): void {
    s.task = task;
    s.date = undefined;
    s.code = undefined;
    s.codeFailures = 0;
    s.awaitingHelpQuestion = false;
  }

  private finish(s: State): void {
    // Keep the tracking number for follow-up questions; forget the rest.
    Object.assign(s, newState(), { trackingNo: s.trackingNo, state: "done" });
  }

  private async status(s: State, turn: TurnBuilder): Promise<void> {
    if (!s.trackingNo) return turn.askFor(["trackingNo"]);
    const call = await turn.call("get_shipment", { tracking_no: s.trackingNo });
    if (call.is_error) return this.lookupFailed(s, call, turn);
    turn.say(describeShipment(call.result as Shipment));
    this.finish(s);
  }

  private async reschedule(s: State, x: Extracted, turn: TurnBuilder): Promise<void> {
    const missing = (["trackingNo", "date", "code"] as const).filter((slot) => !s[slot]);
    // Never without a code: pushing back ("I don't have it", "skip it") changes nothing.
    if (missing.length === 1 && missing[0] === "code" && x.refusesCode) return turn.say(REPLIES.codeRequired);
    if (missing.length > 0) return turn.askFor(missing);

    const call = await turn.call("reschedule_delivery", {
      tracking_no: s.trackingNo,
      new_date: s.date,
      verification_code: s.code,
    });
    if (!call.is_error) {
      turn.say(REPLIES.rescheduled(call.result as Delivery));
      return this.finish(s);
    }
    const { code } = parseToolError(call.text);
    switch (code) {
      case "verification_failed":
        s.code = undefined;
        s.codeFailures += 1;
        if (s.codeFailures >= MAX_CODE_ATTEMPTS) {
          turn.say(REPLIES.verificationGaveUp);
          return this.finish(s);
        }
        return turn.say(REPLIES.verificationFailed(s.trackingNo!));
      case "not_reschedulable":
        turn.say(REPLIES.notReschedulable(s.trackingNo!));
        return this.finish(s);
      case "invalid_date":
        s.date = undefined;
        return turn.say(REPLIES.invalidDate);
      default:
        return this.lookupFailed(s, call, turn);
    }
  }

  private async ticket(s: State, category: TicketCategory, turn: TurnBuilder): Promise<void> {
    if (!s.trackingNo && !s.noTrackingNo) {
      return turn.say(`${TICKET_INTRO[category]} Please tell me ${askText(["trackingNo"])} If you don't have it, just say so.`);
    }
    const args: Record<string, unknown> = { category, description: TICKET_DESCRIPTION[category] };
    if (s.trackingNo) args.tracking_no = s.trackingNo;
    const call = await turn.call("open_ticket", args);
    if (call.is_error) return this.lookupFailed(s, call, turn);
    turn.say(REPLIES.ticketOpened(category, (call.result as Ticket).ticketId, s.trackingNo));
    this.finish(s);
  }

  /** A late parcel: look it up first; open a DELAY ticket only if it is still on its way. */
  private async late(s: State, turn: TurnBuilder): Promise<void> {
    if (!s.trackingNo) return turn.askFor(["trackingNo"]);
    const lookup = await turn.call("get_shipment", { tracking_no: s.trackingNo });
    if (lookup.is_error) return this.lookupFailed(s, lookup, turn);
    const shipment = lookup.result as Shipment;
    if (shipment.status === "DELIVERED" || shipment.status === "RETURNED") {
      turn.say(`${describeShipment(shipment)} If it hasn't reached you, tell me and I'll report it as lost.`);
      return this.finish(s);
    }
    const call = await turn.call("open_ticket", {
      tracking_no: s.trackingNo,
      category: "DELAY",
      description: `${TICKET_DESCRIPTION.DELAY} Current status: ${shipment.status}.`,
    });
    if (call.is_error) return this.lookupFailed(s, call, turn);
    turn.say(`${describeShipment(shipment)} ${REPLIES.ticketOpened("DELAY", (call.result as Ticket).ticketId)}`);
    this.finish(s);
  }

  private async help(s: State, utterance: string, turn: TurnBuilder): Promise<void> {
    const call = await turn.call("search_help", { query: utterance.trim().slice(0, 500) });
    if (call.is_error) {
      turn.say(REPLIES.systemProblem);
      return;
    }
    const top = (call.result as HelpResults).results?.[0];
    if (!top) return turn.say(REPLIES.noHelpFound);
    turn.say(REPLIES.helpFound(top.title, top.snippet));
    this.finish(s);
  }

  /** Errors every task treats alike: an unknown tracking number, or a system problem. */
  private lookupFailed(s: State, call: ToolCall, turn: TurnBuilder): void {
    const { code } = parseToolError(call.text);
    if (code === "not_found" && s.trackingNo) {
      const unknown = s.trackingNo;
      s.trackingNo = undefined;
      return turn.say(REPLIES.notFound(unknown));
    }
    turn.say(REPLIES.systemProblem);
  }
}

class TurnBuilder {
  readonly calls: ToolCall[] = [];
  private readonly parts: string[] = [];

  constructor(
    private readonly tools: ToolCaller,
    private readonly logger: Logger,
    private readonly traceId: string,
  ) {}

  get reply(): string {
    return this.parts.join(" ");
  }

  say(text: string): void {
    this.parts.push(text);
  }

  askFor(slots: readonly Slot[]): void {
    this.say(`Sure. Please tell me ${askText(slots)}`);
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolCall> {
    const call = await invokeTool(this.tools, this.logger, this.traceId, name, args);
    this.calls.push(call);
    return call;
  }
}

function askText(slots: readonly Slot[]): string {
  const parts = slots.map((slot) => REPLIES.ask[slot]);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return `${list}.`;
}

function describeShipment(s: Shipment): string {
  const route = s.originCity && s.destinationCity ? ` from ${s.originCity} to ${s.destinationCity}` : "";
  const status = STATUS_TEXT[s.status] ?? `is ${s.status.toLowerCase().replace(/_/g, " ")}`;
  let text = `Your parcel ${s.trackingNo} ${status}${route}.`;
  if (s.estimatedDelivery && s.status !== "DELIVERED" && s.status !== "RETURNED") {
    text += ` Estimated delivery: ${s.estimatedDelivery}.`;
  }
  if (s.lastEvent) text += ` Latest update: ${s.lastEvent.description}.`;
  return text.replace(/\.\./g, ".");
}

function isTask(intent: Extracted["intent"]): intent is TaskIntent {
  return intent !== undefined && intent !== "credentials" && intent !== "thanks" && intent !== "greeting";
}
