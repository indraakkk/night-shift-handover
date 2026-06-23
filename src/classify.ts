import type { Observation, ObsStatus, Bucket, StructuredEvent } from "./types";
import type { NormalizedSource } from "./normalize";
import { morningForTimestamp, parseLogHeaderMorning } from "./date";

// --- Heuristics, kept as named constants so they are auditable in one place ---

const CATEGORY_BY_TYPE: Record<string, string> = {
  check_in: "checkin",
  check_in_issue: "checkin",
  maintenance: "maintenance",
  compliance: "compliance",
  complaint: "complaint",
  lost_keycard: "keycard",
  deposit_issue: "deposit",
  facilities: "facilities",
  no_show: "no_show",
  walk_in: "walkin",
  finance_note: "finance",
  incident: "incident",
  early_checkout_request: "checkout",
  damage_report: "damage",
  note: "note",
  guest_message: "guest_message",
};

const CATEGORY_KEYWORDS: [RegExp, string][] = [
  [/aircon|air ?con|compressor/i, "maintenance"],
  [/leak|drip|carpet|water|corridor/i, "facilities"],
  [/deposit/i, "deposit"],
  [/no[ -]?show/i, "no_show"],
  [/wi[- ]?fi/i, "wifi"],
  [/passport|immigration|scanner/i, "compliance"],
  [/safe ?box|safe\b/i, "safe_box"],
  [/door ajar|not slept|nobody|in-house|checked out|reconcile/i, "occupancy"],
  [/keycard/i, "keycard"],
  [/noise/i, "complaint"],
];

const RESOLVED_CUES = /\b(settled|resolved|fixed|stopped|sorted|mopped|dry|done|deactivated)\b|all (fine|good)|smooth/i;
const OPEN_CUES = /\b(still|not fixed|out of order|not settled|never|please chase|unresolved|pending|stays out)\b/i;
const UNCERTAIN_CUES = /\b(assume|probably|i think|maybe|not sure|never came back)\b/i;

// Anything that reads as an instruction TO the system is content to flag, never obey.
// Broadened to survive conjugations/gerunds and paraphrase, since logs are free-form.
const INSTRUCTION_CUES =
  /\b(ignor(e|es|ing|ed)|disregard(s|ing|ed)?|overrid(e|es|ing|den)|system note|mark(s|ing|ed)? .{0,30}approved|report(s|ing|ed)? (the night|all|every|everything|each) .{0,30}(as )?(all )?(clear|resolved|complete)|add(s|ing|ed)? .{0,30}(credit|goodwill))\b/i;

// A proposed action that has not been verified/approved — flag, don't rubber-stamp.
const NEEDS_VERIFY_CUES = /no photos|no manager approval|could not verify|needs investigation|unverified|morning team to confirm/i;

// On-fire = safety, hard deadline, guest blocked, or money about to walk out the door.
// (A handled medical note that self-reports "declined ambulance / okay" is NOT on fire.)
const ONFIRE_CUES = /\b(leak|deadline|48[ -]?hour|blocked|never collected|checks? out|checkout tomorrow|emergency|safe ?box|immigration|passport)\b/i;

const CJK = /[㐀-鿿豈-﫿぀-ヿ]/;

function statusFromEvent(s: string): ObsStatus {
  if (s === "resolved") return "resolved";
  if (s === "unresolved") return "open";
  if (s === "pending") return "pending";
  return "unknown";
}

function bucketFor(status: ObsStatus, text: string): Bucket {
  if (status === "resolved") return "fyi";
  if (ONFIRE_CUES.test(text)) return "on_fire";
  if (status === "open" || status === "pending") return "pending";
  return "fyi";
}

const ROOM_RANGE = (n: number) => n >= 108 && n <= 399;
// Words that, if they follow a 3-digit number, mean it's a quantity/amount, not a room.
const UNIT_AFTER = /^\s*(towels?|dollars?|sgd|usd|guests?|people|pax|minutes?|mins?|nights?|days?|ml|kg|%|emails?|calls?)\b/i;

/**
 * Extract a room number conservatively. An explicit marker (room/rm/#/房) wins; otherwise
 * a standalone 3-digit token in 108-399 that is NOT money (SGD/$) and NOT a quantity unit.
 * Deliberately narrow: on unseen text we would rather miss a room than invent one.
 */
function extractRoom(text: string): string | null {
  const marked = /(?:room|rm|#|房)\s*#?\s*(\d{3})/i.exec(text);
  if (marked && ROOM_RANGE(parseInt(marked[1], 10))) return marked[1];

  const re = /(\d{3})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 5), m.index);
    if (/(SGD|\$)\s*$/i.test(before)) continue; // money
    const after = text.slice(m.index + 3);
    if (UNIT_AFTER.test(after)) continue; // quantity, not a room
    if (ROOM_RANGE(parseInt(m[1], 10))) return m[1];
  }
  return null;
}

function categoryFromText(text: string): string {
  for (const [re, cat] of CATEGORY_KEYWORDS) if (re.test(text)) return cat;
  return "note";
}

function classifyEvent(e: StructuredEvent): Observation {
  const status = statusFromEvent(e.status);
  const text = e.description;
  const room = e.room ?? extractRoom(text);
  const category = CATEGORY_BY_TYPE[e.type] ?? e.type;
  const obs: Observation = {
    ref: { id: e.id, format: "json", quote: text },
    room,
    category,
    status,
    bucket: bucketFor(status, text),
    morning: morningForTimestamp(e.timestamp),
    text,
    confidence: "high",
  };
  if (INSTRUCTION_CUES.test(text)) {
    obs.flag = "untrusted_instruction";
    obs.flagDetail = `Source ${e.id} contains instruction-like text and is reported as content only, never acted on.`;
    obs.bucket = "fyi";
  } else if (NEEDS_VERIFY_CUES.test(text)) {
    obs.flag = "needs_verification";
    obs.flagDetail = `Source ${e.id}: an action is proposed but not yet verified/approved — confirm before acting.`;
  }
  return obs;
}

function classifySegment(
  id: string,
  text: string,
  morning: string | null
): Observation {
  // The multilingual PUNT: any non-Latin script → do not interpret. Surface verbatim.
  if (CJK.test(text)) {
    return {
      ref: { id, format: "freetext", quote: text },
      room: extractRoom(text), // room digits are still safe to read if present
      category: "unparsed",
      status: "unknown",
      bucket: "pending",
      morning,
      text,
      confidence: "low",
      flag: "incomplete",
      // Carry the actual text — "surfaced verbatim" must mean the operator can SEE it.
      flagDetail: `Free-text entry not in English — surfaced verbatim for human review (not auto-interpreted): «${text}»`,
    };
  }

  const room = extractRoom(text);
  const category = categoryFromText(text);
  let status: ObsStatus = "unknown";
  if (OPEN_CUES.test(text)) status = "open";
  else if (RESOLVED_CUES.test(text)) status = "resolved";

  const obs: Observation = {
    ref: { id, format: "freetext", quote: text },
    room,
    category,
    status,
    bucket: bucketFor(status === "unknown" ? "pending" : status, text),
    morning,
    text,
    confidence: room ? "high" : "low",
  };

  if (INSTRUCTION_CUES.test(text)) {
    obs.flag = "untrusted_instruction";
    obs.flagDetail = `Free-text ${id} contains instruction-like text and is reported as content only.`;
    obs.bucket = "fyi";
  } else if (UNCERTAIN_CUES.test(text)) {
    obs.flag = "incomplete";
    obs.flagDetail = `Free-text ${id} is self-reported as uncertain — not asserted: «${text.slice(0, 160)}»`;
    obs.status = "pending";
    obs.confidence = "low"; // never let an uncertain claim become an operational action item
  } else if (!room) {
    obs.flag = "incomplete";
    obs.flagDetail = `Free-text ${id} could not be tied to a specific room — surfaced for human review.`;
  }
  return obs;
}

/** Deterministically classify every source into an Observation. */
export function classify(src: NormalizedSource): Observation[] {
  const contextYear = src.events[0]?.timestamp?.slice(0, 4) ?? "2026";
  // Parse the shift's morning from the raw log header (it's stripped from `segments`).
  const headerMorning = parseLogHeaderMorning(src.freetextNormalized, contextYear);

  const obs: Observation[] = [];
  for (const e of src.events) obs.push(classifyEvent(e));
  for (const s of src.segments) obs.push(classifySegment(s.id, s.text, headerMorning));
  return obs;
}
