# Vouch Builder Take-Home

Welcome — thanks for taking the time.

## Live demo (deployed URL + sample curl)

Deployed on Cloudflare Workers at **`https://night-shift-handover.tothemoondigital.workers.dev`**.

Generate a handover from the bundled sample week — no request body, no local file,
runnable from any directory:

```bash
curl -s -X POST https://night-shift-handover.tothemoondigital.workers.dev/handover/sample | jq
```

Retarget the morning with `?morningOf=YYYY-MM-DD` (e.g. `...?morningOf=2026-05-28`).
To post your own data, hit `/handover` with a `{ hotel, events, nightLogs?, morningOf? }`
body — `payload.example.json` is a ready-to-send example (run from the repo root so the
relative path resolves):

```bash
curl -s -X POST https://night-shift-handover.tothemoondigital.workers.dev/handover \
  -H 'content-type: application/json' \
  --data @payload.example.json | jq
```

> The handover routes are **POST-only**; a `GET` returns 404. See [`DECISIONS.md`](DECISIONS.md)
> for the design rationale and [`CLAUDE.md`](CLAUDE.md) for the engine/agent rules.

## About this repo

**Start here:** read [`BRIEF.md`](BRIEF.md). It describes the task, what to build,
and how to submit.

Your sample data is in [`data/`](data/):
- `events.json` — structured front-desk events
- `night-logs.md` — one night logged as free text

Timebox is ~2 hours. We're looking for sharp tradeoffs, not completeness. Good luck.
