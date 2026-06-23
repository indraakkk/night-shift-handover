/**
 * Structured logging. Every line is one JSON object so another builder — or an
 * AI agent debugging a bad handover — can grep by hotel, night, and stage and
 * see exactly why the output looks the way it does.
 */
export interface LogContext {
  requestId: string;
  hotel: string;
  morningOf: string;
}

export function makeLogger(ctx: LogContext) {
  const emit = (level: string, stage: string, msg: string, data?: unknown) => {
    // Single JSON line — Cloudflare tail / Logpush friendly.
    console.log(
      JSON.stringify({ level, stage, msg, ...ctx, data: data ?? null })
    );
  };
  return {
    info: (stage: string, msg: string, data?: unknown) => emit("info", stage, msg, data),
    warn: (stage: string, msg: string, data?: unknown) => emit("warn", stage, msg, data),
    error: (stage: string, msg: string, data?: unknown) => emit("error", stage, msg, data),
  };
}

export type Logger = ReturnType<typeof makeLogger>;
