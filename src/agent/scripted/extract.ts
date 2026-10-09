// What the scripted policy understands in one English utterance: slots
// (tracking number, date, verification code) and an intent. Pure functions,
// no I/O, so the policy can be read and tested on its own.

export type TaskIntent = "status" | "reschedule" | "damaged" | "lost" | "late" | "help";
export type Intent = TaskIntent | "credentials" | "thanks" | "greeting";

export interface Extracted {
  trackingNo?: string;
  /** YYYY-MM-DD; "tomorrow" is resolved against `today`. */
  date?: string;
  /** 4-digit verification code. */
  code?: string;
  intent?: Intent;
  /** The customer says they have no tracking number. */
  noTrackingNo?: boolean;
  /** The customer has no verification code or wants to skip it. */
  refusesCode?: boolean;
}

const TRACKING_NO = /\bKRV\d{8}\b/i;
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const CODE = /(?<![\d-])\d{4}(?![\d-])/;

// Checked in this order; the first match wins.
const INTENT_PATTERNS: [Intent, RegExp][] = [
  ["credentials", /\b(access token|token|api key|password|secret|credentials?|client key|private key)\b/i],
  ["damaged", /\b(damaged?|broken|crushed|smashed|dented|torn|soaked|wet)\b/i],
  ["lost", /\b(lost|missing|never (arrived|came|got it)|not received|didn'?t receive|did not receive|haven'?t received)\b/i],
  [
    "reschedule",
    /\b(re-?schedul\w*|postpone\w*|change (the |my )?(delivery )?(date|day)|(another|different|later) (day|date)|move (the |my )?delivery|deliver (it )?(on|tomorrow))\b/i,
  ],
  ["late", /\b(late|delay\w*|overdue|taking (so|too) long|still (hasn'?t|has not|not) (arrived|come))\b/i],
  ["status", /\b(where|status|track\w*|when will|when is|arriv\w*|update on)\b/i],
  ["help", /\b(how|what|why|which|can i|do you|is it possible|policy|policies|help|question|opening hours|refund\w*|return\w*|insurance)\b|\?/i],
  ["thanks", /\b(thanks|thank you|thx|bye|goodbye|that'?s all|that is all|nothing else)\b/i],
  ["greeting", /^\s*(hi|hello|hey|good (morning|afternoon|evening))\b/i],
];

// "How do I reschedule a delivery?" or "What happens if my parcel is damaged?"
// without a tracking number is a general question for the knowledge base, not
// a request to act.
const GENERAL_QUESTION = /^\s*(how (do|can|does|long|much)|what (is|are|happens|if)|do you|is it possible)\b/i;

const REFUSES_CODE =
  /\b(don'?t|do not|haven'?t|have no|no|without)\b[^.?!]*\b(code|verification)\b|\b(skip|bypass|ignore)\b[^.?!]*\b(code|verification|check)/i;

const TASK_INTENTS = new Set<Intent>(["status", "reschedule", "damaged", "lost", "late"]);

const NO_TRACKING_NO = /\b(don'?t|do not|no|haven'?t( got)?) (have|know|remember)?\s*(a |the |my )?(tracking|number)\b|\bno tracking\b/i;

export function extract(utterance: string, today: string): Extracted {
  const out: Extracted = {};
  let rest = utterance;

  const tracking = TRACKING_NO.exec(rest);
  if (tracking) {
    out.trackingNo = tracking[0].toUpperCase();
    rest = rest.replace(tracking[0], " ");
  }

  const iso = ISO_DATE.exec(rest);
  if (iso && isValidDate(iso[0])) {
    out.date = iso[0];
    rest = rest.replace(iso[0], " ");
  } else if (/\btomorrow\b/i.test(rest)) {
    out.date = addDays(today, 1);
  }

  const code = CODE.exec(rest);
  if (code) out.code = code[0];

  if (!out.code && REFUSES_CODE.test(utterance)) out.refusesCode = true;

  const intent = detectIntent(utterance);
  if (NO_TRACKING_NO.test(utterance)) {
    out.noTrackingNo = true;
    // "I don't have the tracking number" mentions tracking but asks for nothing.
    if (intent === "status") return out;
  }
  if (intent) out.intent = intent;
  return out;
}

export function detectIntent(utterance: string): Intent | undefined {
  for (const [intent, pattern] of INTENT_PATTERNS) {
    if (!pattern.test(utterance)) continue;
    if (TASK_INTENTS.has(intent) && isGeneralQuestion(utterance)) return "help";
    return intent;
  }
  return undefined;
}

function isGeneralQuestion(utterance: string): boolean {
  return GENERAL_QUESTION.test(utterance) && !TRACKING_NO.test(utterance);
}

export function isValidDate(iso: string): boolean {
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Today's date in the service clock zone of kervan-core (SPEC §5). */
export function todayIn(timeZone = "Europe/Istanbul", now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
