/**
 * Beckett — chilltext transform transcript (`src/concierge/chilltext-log.ts`)
 * =======================================================================================
 * Durable before/after record of every `deliverChilled` transform call (`./chill-gate.ts`), so
 * an incident like 2026-08-18 — a rewrite handing the user's own triggering message back as
 * Beckett's reply — is reconstructable hours later from disk, not inferred from the channel
 * transcript (which only ever holds the OUTPUT bubble). One record per call: the `input` the
 * rewrite model saw, the pre-chill `agentOutput`, exactly what chilltext returned per bubble, what
 * actually got posted after the echo/mention guards ran, and the outcome (`ok` / `bypassed` /
 * `fallback` / `threw`).
 *
 * Bounded at {@link MAX_RECORDS} lines (default 500): unlike the 200-char warn-log snippets
 * `chill-gate.ts` already logs on an echo trip, this ledger holds FULL message text by design (the
 * whole point is an inspectable before/after), so it cannot be append-only forever. Every write
 * re-trims the file down to the newest `MAX_RECORDS` lines — at up to four ~2000-char bubbles plus
 * a ~6000-char input/output pair per record, 500 records tops out in the low single-digit
 * megabytes, never unbounded.
 *
 * Opt-in by design, same shape as `deliverChilled`'s `recordPost` seam: `chill-gate.ts` only
 * writes when a caller supplies `logPath` (the real Concierge call sites resolve it from
 * `buildPaths(config).chilltextLog`); with no path, nothing is written and nothing on disk is
 * touched — the seam a test can safely leave unset. Every write is wrapped so a failure (disk
 * full, permissions, a torn directory) is swallowed, never blocking or dropping a delivery — the
 * same fail-open posture as the transform it is logging.
 *
 * Read by `beckett chilltext-log` (`src/cli/core.ts`) — the answer to "show me the logs."
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "../types.ts";

/** Newest-lines cap enforced on every write (module comment above explains the sizing). */
export const MAX_RECORDS = 500;

/** How many records `beckett chilltext-log` prints when `--tail` is omitted. */
export const DEFAULT_TAIL_RECORDS = 10;

type ChillTransformOutcome = "ok" | "bypassed" | "fallback" | "threw";

/** One rewritten bubble's before/after/echo-guard verdict. */
interface ChillTransformBubbleRecord {
  /** Exactly what chilltext returned for this bubble, before the echo/mention guards touched it. */
  rewritten: string;
  /** What was actually posted, after the per-bubble echo guard and mention repair. */
  posted: string;
  /** True when the echo guard flagged this bubble as echoing `input` — whether it was repaired
   * (see `echoRepaired`) or replaced wholesale with the original `agentOutput`. */
  echoFallback: boolean;
  /** `detectEchoedInput`'s scores for this bubble. `null` when the guard didn't run (no `input`) or threw. */
  echoContentScore: number | null;
  echoFullScore: number | null;
  /** True when `echoFallback` was resolved by stripping an echoed leading/trailing span and
   * shipping the remainder, rather than discarding the bubble for `agentOutput` wholesale. Omitted
   * (not `false`) when no repair applied, so an older record shape still round-trips unchanged. */
  echoRepaired?: boolean;
}

export interface ChillTransformLogRecord {
  ts: string;
  channelId: string;
  /** The user's triggering message forwarded as `input`, or `null` when none was supplied. */
  input: string | null;
  /** The pre-chill reply text (`deliverChilled`'s `text` argument). */
  agentOutput: string;
  outcome: ChillTransformOutcome;
  /** Wall-clock time of the transform attempt (excludes bubble posting/delay). */
  durationMs: number;
  /** `null` on `bypassed`/`fallback`/`threw` — chilltext produced no bubbles that call. */
  bubbles: ChillTransformBubbleRecord[] | null;
  /** The caught error's message. Present only on `threw`. */
  error?: string;
}

/**
 * Append one record, then trim the file back to the newest {@link MAX_RECORDS} lines. Never
 * throws: a write failure is caught and, when a logger is given, warned through it — the caller
 * (`deliverChilled`) must never have a delivery blocked or dropped by a logging fault.
 */
export function appendChillTransformLog(path: string, record: ChillTransformLogRecord, logger?: Logger): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const existing = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((line) => line.trim()) : [];
    existing.push(JSON.stringify(record));
    const kept = existing.length > MAX_RECORDS ? existing.slice(existing.length - MAX_RECORDS) : existing;
    writeFileSync(path, `${kept.join("\n")}\n`);
  } catch (err) {
    logger?.warn("chilltext transform log write failed — delivery unaffected", { error: String(err) });
  }
}

function isChillTransformLogRecord(value: unknown): value is ChillTransformLogRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.ts === "string" &&
    typeof row.channelId === "string" &&
    typeof row.agentOutput === "string" &&
    typeof row.outcome === "string" &&
    typeof row.durationMs === "number"
  );
}

/** Read valid rows only, newest last. A crash-truncated final write is silently dropped. */
export function readChillTransformLog(path: string): ChillTransformLogRecord[] {
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const rows: ChillTransformLogRecord[] = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (isChillTransformLogRecord(value)) rows.push(value);
    } catch {
      /* crash-truncated JSONL tail: ignore */
    }
  }
  return rows;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Render one record: header line, then the before/after pair, then each bubble side by side. */
function formatChillTransformRecord(record: ChillTransformLogRecord): string {
  const lines = [
    `── ${record.ts} · channel ${record.channelId} · ${record.outcome.toUpperCase()} · ${record.durationMs}ms`,
    `  input:  ${oneLine(record.input ?? "(none)")}`,
    `  before: ${oneLine(record.agentOutput)}`,
  ];
  if (record.error) lines.push(`  error:  ${record.error}`);
  for (const [i, bubble] of (record.bubbles ?? []).entries()) {
    const echoLabel = bubble.echoRepaired ? "ECHO REPAIR" : "ECHO FALLBACK";
    const echoNote = bubble.echoFallback
      ? ` [${echoLabel} content=${bubble.echoContentScore?.toFixed(2)} full=${bubble.echoFullScore?.toFixed(2)}]`
      : "";
    lines.push(`  bubble ${i + 1} rewritten: ${oneLine(bubble.rewritten)}`);
    lines.push(`  bubble ${i + 1} posted:    ${oneLine(bubble.posted)}${echoNote}`);
  }
  return lines.join("\n");
}

/** Render the last `tail` records, oldest first, for `beckett chilltext-log`. */
export function formatChillTransformLog(records: ChillTransformLogRecord[], tail: number): string {
  const shown = records.slice(-tail);
  if (shown.length === 0) return "(no chilltext transforms recorded yet)";
  return shown.map(formatChillTransformRecord).join("\n\n");
}
