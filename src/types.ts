// ---- Inputs (what the service accepts as DATA, not files) ----

export interface Hotel {
  id: string;
  name: string;
  rooms?: number;
  timezone?: string;
}

export interface StructuredEvent {
  id: string;
  timestamp: string;
  type: string;
  room: string | null;
  guest: string | null;
  description: string;
  status: "resolved" | "unresolved" | "pending" | string;
}

export interface HandoverRequest {
  hotel: Hotel;
  events: StructuredEvent[];
  /** Raw free-text night log(s), e.g. the contents of night-logs.md. */
  nightLogs?: string;
  /** ISO date (YYYY-MM-DD) of the morning the handover is FOR. Defaults to latest shift. */
  morningOf?: string;
}

// ---- Normalized internal model ----

/**
 * A SourceRef is the unit of grounding. Every claim in the handover must point
 * back to one or more of these, and every freetext-derived ref must carry a
 * verbatim quote we can re-find in the original log.
 */
export interface SourceRef {
  id: string; // evt_0007  OR  nl_3 (synthetic id for a free-text bullet)
  format: "json" | "freetext";
  quote: string; // verbatim text from the source (for freetext, validated as a substring)
}

// ---- LLM output contract (validated in code before we trust it) ----

export type Bucket = "on_fire" | "pending" | "fyi";
export type Thread = "still_open" | "newly_resolved" | "new_tonight";

export interface HandoverItem {
  title: string;
  detail: string;
  bucket: Bucket;
  thread: Thread;
  room: string | null;
  /** Source ids this item is grounded in. Validated to exist. */
  sources: string[];
  /**
   * For any claim drawn from the free-text log, a verbatim substring of that
   * log supporting it. Validated to literally appear in the source. Optional
   * for purely structured-event items.
   */
  quote?: string;
}

export interface Flag {
  kind: "contradiction" | "incomplete" | "untrusted_instruction" | "needs_verification";
  detail: string;
  sources: string[];
}

export interface EngineOutput {
  items: HandoverItem[];
  flags: Flag[];
}

// ---- Deterministic engine internals ----

export type ObsStatus = "open" | "resolved" | "pending" | "unknown";

/** One source (event or free-text bullet) after deterministic classification. */
export interface Observation {
  ref: SourceRef;
  room: string | null;
  category: string;
  status: ObsStatus;
  bucket: Bucket;
  /** The morning (YYYY-MM-DD) this observation belongs to, or null if undatable. */
  morning: string | null;
  /** Verbatim text we are allowed to echo (event description or free-text bullet). */
  text: string;
  /** "low" => we could not confidently parse it (e.g. non-Latin) — the multilingual punt. */
  confidence: "high" | "low";
  /** If set, this observation is surfaced as a flag rather than an action item. */
  flag?: Flag["kind"];
  flagDetail?: string;
}

export interface Handover extends EngineOutput {
  hotel: Hotel;
  morningOf: string;
  generatedAt: string;
  /** Items dropped because their citations did not validate — surfaced, never hidden. */
  rejected: { item: HandoverItem | Flag; reason: string }[];
}
