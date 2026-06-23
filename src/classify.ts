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
const INSTRUCTION_CUES = /\b(ignore (all|other|previous|the)|system note|disregard|override|mark .* approved|report .* all clear|add .* (credit|goodwill))\b/i;

// A proposed action that has not been verified/approved — flag, don't rubber-stamp.
const NEEDS_VERIFY_CUES = /no photos|no manager approval|could not verify|needs investigation|unverified|morning team to confirm/i;

// On-fire = safety, hard deadline, guest blocked, or money about to walk out the door.
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

/** Extract a plausible room number (108-399), ignoring money like "SGD 100/500". */
function extractRoom(text: string): string | null {
  const re = /(SGD\s*|\$\s*)?\b(\d{3})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[1]) continue; // preceded by a currency marker → it's money, not a room
    const n = parseInt(m[2], 10);
    if (n >= 108 && n <= 399) return m[2];
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
      flagDetail: "Free-text entry not in English — surfaced verbatim for human review (not auto-interpreted).",
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
    obs.flagDetail = `Free-text ${id} is self-reported as uncertain ("assume/probably") — not asserted as resolved.`;
    obs.status = "pending";
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
