import type { Observation, EngineOutput, HandoverItem, Flag, Bucket, Thread } from "./types";

const BUCKET_RANK: Record<Bucket, number> = { on_fire: 3, pending: 2, fyi: 1 };
// Genuinely hotel-wide threads (no single room). finance/deposit notes are per-room.
const HOTEL_WIDE = new Set(["compliance", "facilities", "walkin"]);

const CATEGORY_LABEL: Record<string, string> = {
  maintenance: "Maintenance",
  facilities: "Facilities",
  deposit: "Deposit",
  compliance: "Compliance / immigration",
  complaint: "Complaint",
  no_show: "No-show",
  damage: "Damage",
  occupancy: "Occupancy",
  checkin: "Check-in",
  checkout: "Check-out",
  incident: "Incident",
  guest_message: "Guest message",
  safe_box: "Safe box",
  wifi: "Wi-Fi",
  finance: "Finance",
  keycard: "Keycard",
  walkin: "Walk-in",
  note: "Note",
};

/** Roomed issues thread by room (one guest/stay over the week); hotel-wide ones by category. */
function threadKey(o: Observation): string {
  if (o.room && !HOTEL_WIDE.has(o.category)) return `room:${o.room}`;
  return `cat:${o.category}`;
}

function pickBucket(obs: Observation[]): Bucket {
  let best: Bucket = "fyi";
  for (const o of obs) if (BUCKET_RANK[o.bucket] > BUCKET_RANK[best]) best = o.bucket;
  return best;
}

const has = (obs: Observation[], re: RegExp) => obs.some((o) => re.test(o.text));

export function reconcile(observations: Observation[], morningOf: string): EngineOutput {
  const items: HandoverItem[] = [];
  const flags: Flag[] = [];

  // 1) Flags surfaced directly by the classifier (injection, punted/multilingual, incomplete).
  for (const o of observations) {
    if (o.flag) flags.push({ kind: o.flag, detail: o.flagDetail ?? o.text, sources: [o.ref.id] });
  }

  // 2) Thread the confidently-parsed, interpretable observations across nights.
  //    Untrusted-instruction sources are surfaced ONLY as a flag — never restated as an
  //    operational item (so injected text like a fake credit can't become a line manager reads).
  const threadable = observations.filter(
    (o) => o.confidence === "high" && o.category !== "unparsed" && o.flag !== "untrusted_instruction"
  );
  const groups = new Map<string, Observation[]>();
  for (const o of threadable) {
    const k = threadKey(o);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(o);
  }

  for (const [, group] of groups) {
    const obs = [...group].sort((a, b) => (a.morning ?? "").localeCompare(b.morning ?? ""));
    const latest = obs[obs.length - 1];
    const openedMorning = obs.find((o) => o.morning)?.morning ?? null;
    const resolved = latest.status === "resolved";

    let thread: Thread;
    if (resolved) {
      const resolvedMorning = latest.morning;
      if (resolvedMorning && resolvedMorning < morningOf) continue; // closed before target — don't re-report
      thread = openedMorning && openedMorning < morningOf ? "newly_resolved" : "new_tonight";
    } else {
      thread = openedMorning === morningOf ? "new_tonight" : "still_open";
    }

    const bucket = resolved ? "fyi" : pickBucket(obs);
    const category = latest.category;
    const hotelWide = HOTEL_WIDE.has(category);
    // Hotel-wide threads (e.g. passport backlog spanning several rooms) aren't pinned to one room.
    const room = hotelWide ? null : obs.find((o) => o.room)?.room ?? null;
    const label = CATEGORY_LABEL[category] ?? category;
    const carried = thread === "still_open" && openedMorning && openedMorning < morningOf
      ? ` (carried since ${openedMorning})`
      : "";

    items.push({
      title: room ? `Room ${room} — ${label}` : label,
      detail: latest.text + carried,
      bucket,
      thread,
      room,
      sources: obs.map((o) => o.ref.id),
      quote: obs.find((o) => o.ref.format === "freetext")?.ref.quote,
    });
  }

  // 3) Cross-source contradiction heuristics (documented, intentionally conservative).
  const byRoom = new Map<string, Observation[]>();
  for (const o of observations) if (o.room) (byRoom.get(o.room) ?? byRoom.set(o.room, []).get(o.room)!).push(o);

  for (const [room, obs] of byRoom) {
    const inHouse = has(obs, /in-house|in house|staying|through (sat|sun|mon|tue|wed|thu|fri)/i);
    const vacant = has(obs, /ajar|not slept|nobody|looks like|checked out early|reconcile/i);
    if (inHouse && vacant) {
      flags.push({
        kind: "contradiction",
        detail: `Room ${room}: system records the guest as in-house, but a night-log note reports the room looks unoccupied. Reconcile before billing.`,
        sources: obs.map((o) => o.ref.id),
      });
    }
    const notCharged = has(obs, /not yet charged|did not arrive|not charged/i);
    const disputed = has(obs, /disputes the charge|cancellation window/i);
    if (notCharged && disputed) {
      flags.push({
        kind: "contradiction",
        detail: `Room ${room}: structured events show the no-show was NOT charged, yet a later note disputes a charge that was applied — the charge itself appears only in an unparsed free-text entry. Reconcile.`,
        sources: obs.map((o) => o.ref.id),
      });
    }
  }

  return { items, flags };
}
