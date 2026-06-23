import type { StructuredEvent } from "./types";

export interface NormalizedSource {
  /** Every source the model is allowed to cite, keyed by id. */
  registry: Map<string, { format: "json" | "freetext"; text: string; timestamp?: string }>;
  /** The events, untouched, for the prompt. */
  events: StructuredEvent[];
  /** Free-text split into citable bullets with synthetic ids (nl_1, nl_2 ...). */
  segments: { id: string; text: string }[];
  /** The raw night log, whitespace-normalized, used to substring-verify quotes. */
  freetextNormalized: string;
}

/** Collapse runs of whitespace so quote matching is robust to wrapping/indent. */
export function squashWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Deterministic, no model: turn both input formats into one citable registry.
 * The structured events keep their own ids; the free-text log is split into
 * bullet-level segments so the model has concrete handles to cite.
 */
export function normalize(events: StructuredEvent[], nightLogs?: string): NormalizedSource {
  const registry: NormalizedSource["registry"] = new Map();

  for (const e of events) {
    registry.set(e.id, {
      format: "json",
      text: `${e.type} | room ${e.room ?? "-"} | status=${e.status} | ${e.description}`,
      timestamp: e.timestamp,
    });
  }

  const segments: { id: string; text: string }[] = [];
  if (nightLogs && nightLogs.trim()) {
    // Split on markdown bullets and blank-line-separated paragraphs.
    const rawBullets = nightLogs
      .split(/\n(?=\s*[-*]\s)|\n\s*\n/g)
      .map((b) => b.trim())
      .filter((b) => b.length > 0 && !/^#/.test(b) && !/^>/.test(b));

    rawBullets.forEach((text, i) => {
      const id = `nl_${i + 1}`;
      segments.push({ id, text });
      registry.set(id, { format: "freetext", text });
    });
  }

  return {
    registry,
    events,
    segments,
    freetextNormalized: squashWhitespace(nightLogs ?? ""),
  };
}
