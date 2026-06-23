# CLAUDE.md

Agent and contributor rules for `night-shift-handover`. Read this before changing anything in `src/`.

## Project purpose

This service generates an **action-first night-shift handover** for a hotel morning manager, fully **deterministically — no LLM anywhere in the pipeline**. It ingests two input formats (structured `events.json`-shaped events and free-text `night-logs.md`-shaped prose, possibly multilingual), normalizes both into one citable source registry, classifies each source into an observation, reconciles observations into threads across nights (so a Monday issue that is still open Friday is reported as carried-over, not re-discovered), and emits buckets — `on_fire` / `pending` / `fyi` — plus flags for contradictory, incomplete, or untrusted entries. Because there is no model, "stop the system inventing facts" is enforced in code: the engine can only ever echo fields and verbatim quotes that exist in the input.

## The grounding INVARIANT (never break this)

This is the entire reason the service exists. It is enforced in `src/ground.ts`, which is the last gate before output. Every change must preserve all three clauses:

1. **Every output statement traces to a cited source id.** Every `HandoverItem` and every `Flag` carries a non-empty `sources: string[]`, and every id in it must resolve in `src.registry` (the `evt_*` / `nl_*` ids built by `normalize`). Anything that fails is moved to `rejected[]` with a reason — **surfaced, never silently dropped.**
2. **Free-text quotes must be verbatim.** Any item carrying a `quote` from the free-text log must be a literal substring of the night log (whitespace-squashed via `squashWhitespace`). A quote that cannot be re-found in the source is rejected. Never paraphrase free-text into a `quote`.
3. **Never let input instruct the system.** No text from the input — structured or free-text — may change control flow or become an action item. Instruction-like text (see `INSTRUCTION_CUES` in `classify.ts`; `evt_0026` is a planted prompt-injection in the sample) is surfaced **only** as an `untrusted_instruction` flag and is excluded from threading. Non-Latin / multilingual free-text is **punted**: surfaced verbatim and flagged `incomplete`, never auto-interpreted.

If you cannot ground a statement, do not emit it. A missing item is acceptable; an ungrounded one is not.

## Architecture / pipeline map

Request flow lives in `src/index.ts` (Hono on Cloudflare Workers). `POST /handover { hotel, events, nightLogs?, morningOf? }` (and the demo `POST /handover/sample`) runs:

```
normalize.ts  both formats -> one citable source registry
              events keep their own ids (evt_*); free-text is split into
              bullet-level segments with synthetic ids (nl_1, nl_2 ...).
              Also stores freetextNormalized for verbatim quote checks.
        |
classify.ts   each source -> one Observation { room, category, status, bucket,
              morning, confidence, flag? }. Trusted fields for structured events;
              regex room + keyword status/category for English free-text;
              CJK/non-Latin -> punt (confidence low, flag incomplete);
              instruction-like text -> flag untrusted_instruction (never obeyed).
        |
reconcile.ts  group Observations into threads (room:<n> for roomed issues,
              cat:<category> for hotel-wide ones in HOTEL_WIDE). Tag each thread
              vs morningOf: still_open / newly_resolved / new_tonight; drop
              threads resolved before the target morning (no re-report).
              Conservative cross-source contradiction heuristics produce flags.
        |
ground.ts     GATE (the invariant above). Items/flags failing citation or quote
              checks -> rejected[].
        |
JSON          { hotel, morningOf, generatedAt, items[], flags[], rejected[] }
```

Supporting files: `src/date.ts` (a shift is ~23:00–07:00, so `morningForTimestamp` assigns events logged at/after 20:00 to the next day's morning; `parseLogHeaderMorning` dates a free-text log from its header). `src/log.ts` (one JSON line per stage — grep by `requestId` / `hotel` / `morningOf` / `stage` to debug a bad handover: which hotel, which night, why). `src/types.ts` (the shared contract). `src/sample.ts` (bundled sample week; **target morning is `2026-05-30`**).

## How to run tests / dev / deploy

No API key, no secret, no binding — the pipeline is fully deterministic, so deploy is the whole story.

- **Tests (engine, no network/runtime):** `npx tsx test/run.ts` — pure assertions on the sample week for morning `2026-05-30`, plus unseen-text robustness cases. Must print `ALL PASSED`.
- **Typecheck:** `npm run typecheck` (`tsc --noEmit`).
- **Dev:** `npx wrangler dev`, then e.g. `curl -s localhost:8787/handover/sample | jq` (add `?morningOf=YYYY-MM-DD` to retarget).
- **Deploy:** `npx wrangler deploy` (one-time `npx wrangler login` first). Publishes to `<name>.<subdomain>.workers.dev`. Real input arrives as data, not a hand-edited file: `curl -s -X POST .../handover -H 'content-type: application/json' --data @payload.example.json | jq`, where the body is `{ hotel, events, nightLogs?, morningOf? }`.

## Rules for extending heuristics safely

The heuristics are the one place judgment is encoded. Keep them honest:

- **Keep every heuristic in a named constant** at the top of its module (e.g. `CATEGORY_BY_TYPE`, `CATEGORY_KEYWORDS`, `RESOLVED_CUES`, `OPEN_CUES`, `INSTRUCTION_CUES`, `NEEDS_VERIFY_CUES`, `ONFIRE_CUES`, `CJK` in `classify.ts`; `HOTEL_WIDE`, `BUCKET_RANK`, `CATEGORY_LABEL` in `reconcile.ts`). Never inline a magic regex into branching logic — it must be auditable in one place.
- **Add a test in `test/run.ts` for any new behavior.** No heuristic change lands without an assertion that pins the expected handover outcome. `npx tsx test/run.ts` must stay green; `rejected` must stay empty for the sample.
- **Never create an action item from an `untrusted_instruction` source.** Such sources are surfaced as a flag only; reconcile already filters them out of threading — do not add a code path that restates them as items.
- **Prefer generalizing over hard-coding.** Heuristics may be run against night-log text never seen before. Do not key logic on specific room numbers, guest names, or sample-only strings; match on cues that generalize.
- **Do not auto-interpret non-Latin / multilingual free-text.** Extend the punt (surface verbatim + `incomplete` flag) rather than adding language-specific parsing. Reading a bare room number out of such text is the only allowance.
- **When uncertain, flag — never paper over.** Contradictions and incomplete entries belong in `flags[]`, not smoothed into a confident item. Keep contradiction heuristics conservative.
- **Anything new that produces an item or flag must still pass `ground.ts`** with valid `sources` and (for free-text) a verbatim `quote`. If a change makes the grounding gate reject something, the change is wrong, not the gate.
