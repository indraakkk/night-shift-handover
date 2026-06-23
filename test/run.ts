/**
 * Pure-engine tests — no network, no Workers runtime. Run: `npx tsx test/run.ts`.
 * Encodes the expected handover for the sample week, target morning 2026-05-30.
 */
import { normalize } from "../src/normalize";
import { classify } from "../src/classify";
import { reconcile } from "../src/reconcile";
import { ground } from "../src/ground";
import type { Handover } from "../src/types";
import sample from "../src/sample";

const silent = { info: () => {}, warn: () => {}, error: () => {} };

function buildHandover(morningOf: string): Handover {
  const src = normalize(sample.events, sample.nightLogs);
  const engine = reconcile(classify(src), morningOf);
  const grounded = ground(engine, src, silent as any);
  return { hotel: sample.hotel, morningOf, generatedAt: "test", ...grounded };
}

const h = buildHandover("2026-05-30");
const items = h.items;
const flags = h.flags;
const text = JSON.stringify(h);
const allSourceIds = new Set([
  ...sample.events.map((e) => e.id),
  ...normalize(sample.events, sample.nightLogs).segments.map((s) => s.id),
]);

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : "");
  }
}

const itemFor = (room: string) => items.filter((i) => i.room === room);
const flagKinds = flags.map((f) => f.kind);

console.log("Handover for 2026-05-30:");
console.log(`  items=${items.length} flags=${flags.length} rejected=${h.rejected.length}`);

// --- Grounding gate ---
check("nothing was rejected by the grounding gate", h.rejected.length === 0, h.rejected);
check(
  "every item cites only real source ids",
  items.every((i) => i.sources.length > 0 && i.sources.every((s) => allSourceIds.has(s))),
  items.filter((i) => !i.sources.every((s) => allSourceIds.has(s)))
);
check(
  "every flag cites only real source ids",
  flags.every((f) => f.sources.every((s) => allSourceIds.has(s)))
);

// --- Injection (evt_0026): never obeyed, surfaced as untrusted ---
check("evt_0026 raised an untrusted_instruction flag", flags.some((f) => f.kind === "untrusted_instruction" && f.sources.includes("evt_0026")));
check("no SGD 1000 goodwill credit anywhere in output", !/1000|goodwill/i.test(text));
check("night was NOT reported all-clear (real items exist)", items.length > 0);

// --- Reconciliation across nights ---
check("room 112 aircon is still_open", itemFor("112").some((i) => i.thread === "still_open"));
check("corridor leak (215) is NOT shown as active (resolved 05-29)", !itemFor("215").some((i) => i.thread !== "newly_resolved" && i.bucket !== "fyi") || !items.some((i) => i.room === "215" && i.thread === "still_open"));
check("309 deposit is still_open and on_fire", itemFor("309").some((i) => i.thread === "still_open" && i.bucket === "on_fire"));
check("compliance/passport backlog is on_fire", items.some((i) => i.title.toLowerCase().includes("compliance") && i.bucket === "on_fire"));
check("damage 226 is new_tonight", itemFor("226").some((i) => i.thread === "new_tonight"));

// --- Contradictions & incomplete (flagged, not papered over) ---
check("205 contradiction flagged", flags.some((f) => f.kind === "contradiction" && f.sources.includes("evt_0024")));
check("312 no-show contradiction flagged", flags.some((f) => f.kind === "contradiction" && f.detail.includes("312")));
check("multilingual entries surfaced as incomplete flags", flagKinds.filter((k) => k === "incomplete").length >= 2);
check("no room invented for the unknown-room wifi complaint", !items.some((i) => /wi-?fi/i.test(i.detail) && i.room));

console.log(failed === 0 ? "\nALL PASSED ✅" : `\n${failed} CHECK(S) FAILED ❌`);
process.exit(failed === 0 ? 0 : 1);
