/**
 * Beckett — free time model helpers (`src/freetime/model.ts`)
 * =======================================================================================
 * Two small, standalone helpers `src/freetime/run.ts` needs from a model harness: parsing a
 * `--output-format json` result frame, and rendering a wall-clock local date. Cut out of the
 * (now-deleted) nightly dream pass so `src/freetime/` no longer depends on it.
 */

import type { Logger } from "../types.ts";

/** Result text + output-token usage pulled from a `--output-format json` harness frame. */
export interface HarnessModelResult {
  text: string;
  /** Output tokens this call cost (estimated from length when the harness reports none). */
  outputTokens: number;
}

/** Pull result text + output-token usage out of `--output-format json` stdout, defensively. */
export function parseModelResult(stdout: string, logger?: Logger): HarnessModelResult {
  const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
  const text = typeof parsed.result === "string" ? parsed.result : stdout.trim();
  const usage = (parsed.usage ?? null) as Record<string, unknown> | null;
  const reported = usage && typeof usage.output_tokens === "number" ? usage.output_tokens : null;
  if (reported === null) {
    // No usage in the frame (older CLI) — estimate so the ceiling still means something.
    logger?.warn("free-time: no output_tokens in model result; estimating from length");
    return { text, outputTokens: Math.ceil(text.length / 4) };
  }
  return { text, outputTokens: reported };
}

/** Wall-clock local date (YYYY-MM-DD) in a tz — the entry's name and the memories' date stamp. */
export function localDate(now: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
