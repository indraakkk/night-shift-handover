# Build → Test → Deploy Plan (deterministic, no LLM)

## Architecture (no model anywhere in the pipeline)

```
POST /handover  { hotel, events, nightLogs?, morningOf? }
        │
   normalize.ts   both formats → one citable source registry (evt_* + nl_*)
        │
   classify.ts    each source → an Observation (room, category, status, bucket, morning)
        │            • structured events: trusted fields
        │            • free-text English: regex room + keyword status/category
        │            • free-text non-Latin (CJK): PUNT → surface verbatim, flag needs_review
        │            • any instruction-like text: flag untrusted_instruction (never obeyed)
        │
   reconcile.ts   group Observations into Issues by thread key (room:category);
        │            classify each thread vs morningOf:
        │              still_open / newly_resolved / new_tonight ; drop already-closed
        │            heuristic contradiction + incomplete flags
        │
   ground.ts      GATE: every item/flag must cite a real source id; every free-text
        │            quote must literally appear in the log → else moved to `rejected`
        │
      JSON         { items[], flags[], rejected[], hotel, morningOf, generatedAt }
```

**Why this answers the brief:** grounding is enforced in *code*, not model goodwill. The
LLM is gone, so "stop it inventing facts" becomes "the code can only ever echo source
fields." Injection (evt_0026) is inert because nothing in the pipeline executes text.

## Deliberate skips (documented in DECISIONS.md)
- **Multilingual punt:** non-Latin free-text (e.g. the Chinese 312 no-show charge, 208
  safe-box) is *not* interpreted — surfaced verbatim and flagged for human review. The
  honest cost: we lose that the 312 charge was applied (so we flag the resulting
  contradiction with evt_0012) and lose the 208 urgency. This is the deterministic
  tradeoff vs. an LLM.
- Bucketing (on_fire/pending/fyi) is heuristic — the one place judgment is encoded.

## Test plan
1. `npm install`
2. `npx tsx test/run.ts` — pure-engine assertions on the sample, target morning 2026-05-30:
   - room 112 aircon → **still_open** (opened 05-26, never resolved)
   - corridor leak (215) → **NOT shown** (resolved 05-29, before target) — proves no re-report
   - compliance passport backlog → **still_open**, on_fire (48h deadline), updated tonight
   - 309 deposit → **still_open**, on_fire (checkout, never collected)
   - damage 226 → **new_tonight**, pending, flag needs_verification (no photos/approval)
   - evt_0026 → flag **untrusted_instruction**; **no SGD 1000 credit anywhere** in output
   - 205 → **contradiction/needs_verification** flag (system in-house vs log "looks empty")
   - 312 no-show → contradiction flag (evt_0010 "not charged" vs evt_0012 dispute; charge
     itself sits in a punted Chinese entry → needs_review flag references it)
   - 208 safe-box & wifi-unknown-room → **needs_review/incomplete** flags, no invented room
   - every item/flag `sources[]` resolves to a real id (ground gate); `rejected` is empty
3. `npx wrangler dev` → `curl localhost:8787/handover/sample` smoke test.

## Deploy plan (Cloudflare, self-contained — no API key needed)
1. `npx wrangler login`            # one-time, interactive (run with `! npx wrangler login`)
2. `npx wrangler deploy`           # publishes to <name>.<subdomain>.workers.dev
3. Verify:
   ```
   curl -s https://vouch-night-handover.<subdomain>.workers.dev/handover/sample | jq
   ```
4. Real-data POST (input arrives as data, not a file):
   ```
   curl -s -X POST https://vouch-night-handover.<subdomain>.workers.dev/handover \
     -H 'content-type: application/json' \
     --data @payload.json | jq        # payload.json = { hotel, events, nightLogs, morningOf }
   ```

Because there is no model, deploy needs no secret — `wrangler deploy` is the whole story.
