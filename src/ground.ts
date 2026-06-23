import type { Handover, HandoverItem, Flag, EngineOutput } from "./types";
import type { NormalizedSource } from "./normalize";
import { squashWhitespace } from "./normalize";
import type { Logger } from "./log";

/**
 * The grounding guarantee lives HERE, in code — not in the model's good behaviour.
 * Every item/flag must cite source ids that actually exist, and any free-text
 * quote must literally appear in the night log. Anything that fails is moved to
 * `rejected` (surfaced, never silently dropped) so a bad handover is debuggable.
 */
export function ground(
  model: EngineOutput,
  src: NormalizedSource,
  log: Logger
): Pick<Handover, "items" | "flags" | "rejected"> {
  const items: HandoverItem[] = [];
  const flags: Flag[] = [];
  const rejected: Handover["rejected"] = [];

  const citationsOk = (sources: string[]): string | null => {
    if (!sources || sources.length === 0) return "no source citation";
    for (const id of sources) {
      if (!src.registry.has(id)) return `unknown source id "${id}"`;
    }
    return null;
  };

  const quoteOk = (item: HandoverItem): string | null => {
    if (!item.quote) return null; // quote only required for free-text-derived claims
    const needle = squashWhitespace(item.quote);
    if (needle && !src.freetextNormalized.includes(needle)) {
      return `quote not found verbatim in night log: "${item.quote.slice(0, 60)}"`;
    }
    return null;
  };

  for (const item of model.items) {
    const reason = citationsOk(item.sources) ?? quoteOk(item);
    if (reason) {
      log.warn("ground.reject", "item failed grounding", { title: item.title, reason });
      rejected.push({ item, reason });
      continue;
    }
    items.push(item);
  }

  for (const flag of model.flags) {
    const reason = citationsOk(flag.sources);
    if (reason) {
      log.warn("ground.reject", "flag failed grounding", { detail: flag.detail, reason });
      rejected.push({ item: flag, reason });
      continue;
    }
    flags.push(flag);
  }

  log.info("ground.done", "grounding complete", {
    kept_items: items.length,
    kept_flags: flags.length,
    rejected: rejected.length,
  });
  return { items, flags, rejected };
}
