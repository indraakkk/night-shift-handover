import { Hono } from "hono";
import type { HandoverRequest, Handover } from "./types";
import { normalize } from "./normalize";
import { classify } from "./classify";
import { reconcile } from "./reconcile";
import { ground } from "./ground";
import { makeLogger } from "./log";
import { morningForTimestamp } from "./date";
import sampleData from "./sample";

type Env = Record<string, never>; // no secrets — the pipeline is fully deterministic

const app = new Hono<{ Bindings: Env }>();

function requestId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/** Default the handover to the latest morning present in the data. */
function defaultMorning(events: { timestamp: string }[]): string {
  let best = "";
  for (const e of events) {
    const m = morningForTimestamp(e.timestamp);
    if (m && m > best) best = m;
  }
  return best || "unknown";
}

function build(req: HandoverRequest, generatedAt: string): Handover {
  const morningOf = req.morningOf || defaultMorning(req.events ?? []);
  const log = makeLogger({ requestId: requestId(), hotel: req.hotel?.id ?? "unknown", morningOf });

  log.info("ingest", "received request", {
    events: req.events?.length ?? 0,
    hasNightLogs: Boolean(req.nightLogs),
  });

  const src = normalize(req.events ?? [], req.nightLogs);
  log.info("normalize", "built source registry", { sources: src.registry.size, segments: src.segments.length });

  const observations = classify(src);
  log.info("classify", "classified sources", {
    high: observations.filter((o) => o.confidence === "high").length,
    low: observations.filter((o) => o.confidence === "low").length,
  });

  const engine = reconcile(observations, morningOf);
  log.info("reconcile", "threaded into items", { items: engine.items.length, flags: engine.flags.length });

  const grounded = ground(engine, src, log);
  return { hotel: req.hotel, morningOf, generatedAt, ...grounded };
}

app.get("/", (c) =>
  c.json({
    service: "vouch-night-handover",
    deterministic: true,
    usage: {
      generate: "POST /handover  body: { hotel, events, nightLogs?, morningOf? }",
      demo: "POST /handover/sample  (uses the bundled sample week; ?morningOf=YYYY-MM-DD optional)",
    },
  })
);

app.post("/handover", async (c) => {
  const body = (await c.req.json().catch(() => null)) as HandoverRequest | null;
  if (!body?.events || !Array.isArray(body.events)) {
    return c.json({ error: "body must include events: StructuredEvent[]" }, 400);
  }
  return c.json(build(body, new Date().toISOString()));
});

// Convenience: run the bundled sample without pasting the data.
app.post("/handover/sample", (c) => {
  const morningOf = c.req.query("morningOf");
  return c.json(build({ ...sampleData, morningOf }, new Date().toISOString()));
});

export default app;
