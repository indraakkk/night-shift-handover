# Vouch Builder Take-Home

Welcome — thanks for taking the time.

## Live demo (deployed URL + sample curl)

Deployed on Cloudflare Workers at **`https://night-shift-handover.tothemoondigital.workers.dev`**.

### Just want to see a handover? (zero setup)

Paste this into a terminal — nothing to install, nothing to download. It runs the
bundled sample week and prints the handover as JSON:

```bash
curl -s -X POST https://night-shift-handover.tothemoondigital.workers.dev/handover/sample
```

See a different morning by adding `?morningOf=YYYY-MM-DD` (keep the quotes):

```bash
curl -s -X POST "https://night-shift-handover.tothemoondigital.workers.dev/handover/sample?morningOf=2026-05-28"
```

The output is plain JSON. To pretty-print it, optionally pipe to a formatter — `| jq`
(a separate tool, [jqlang.github.io/jq](https://jqlang.github.io/jq/)) or `| python3 -m json.tool`
(already on most machines). If you don't have either, skip it — the raw output is the same data.

### Want to send your own data? (advanced — needs the repo)

`POST /handover` takes the night's data in the request body
(`{ hotel, events, nightLogs?, morningOf? }`). `payload.example.json` in this repo is a
ready-to-send example. `--data @payload.example.json` tells curl to send that **file's
contents** as the body (the `@` means "read from this file"), so you must have the repo
cloned and run the command **from the repo root**:

```bash
curl -s -X POST https://night-shift-handover.tothemoondigital.workers.dev/handover \
  -H 'content-type: application/json' \
  --data @payload.example.json
```

To retarget the morning here, edit the `"morningOf"` field inside the JSON body
(the `?morningOf=` query param only applies to `/handover/sample`).

> The handover routes are **POST-only**; a `GET` returns 404. See [`DECISIONS.md`](DECISIONS.md)
> for the design rationale and [`CLAUDE.md`](CLAUDE.md) for the engine/agent rules.

## About this repo

**Start here:** read [`BRIEF.md`](BRIEF.md). It describes the task, what to build,
and how to submit.

Your sample data is in [`data/`](data/):
- `events.json` — structured front-desk events
- `night-logs.md` — one night logged as free text

Timebox is ~2 hours. We're looking for sharp tradeoffs, not completeness. Good luck.
