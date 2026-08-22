/**
 * Beckett — the file-tailing training progress source (`src/progress/training-source.ts`)
 * =======================================================================================
 * ro's other ask: a window into the throttled CPU pretrain, which is a systemd --user unit, not a
 * Beckett run — so the run engine never sees it.
 * This is a SIBLING progress source with its own read path: bounded tails of the unit's own
 * `loss.jsonl` (structured, one record per step) and console log (`train.out`, human-readable),
 * plus a `systemctl --user is-active` check — never a write into the unit's scratch directory, and
 * never a full-file read of either log (they grow for days).
 *
 * `FileTailProgressSourceConfig` is the whole generalization: naming the unit, the two log paths,
 * the token budget, and the channel is enough to add a second file-tailed source later without
 * touching this module — a progress SOURCE, not a babble-shaped special case. `./training-card.ts`
 * is the one production config and the posting loop; this module stays fs-bound and Discord-free.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { spawnSync } from "node:child_process";

// =======================================================================================
// Bounded file reads — never a full read of a log that grows for days
// =======================================================================================

/**
 * Read at most `maxBytes` from one end of a file and split it into complete lines. The line
 * adjacent to wherever the read was clipped (the first line of a tail read that started mid-file,
 * the last line either way) is dropped rather than trusted — it may be truncated mid-record, or
 * (for the very last line of the file) still being written. Missing file → `[]`, never a throw.
 */
function readBoundedLines(path: string, opts: { maxBytes: number; fromEnd: boolean; maxLines: number }): string[] {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return [];
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return [];
    const length = Math.min(size, opts.maxBytes);
    const start = opts.fromEnd ? size - length : 0;
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
    const parts = buf.toString("utf8").split("\n");
    parts.pop(); // a trailing "" from a final \n, or an unterminated in-progress line — drop either way
    if (opts.fromEnd && start > 0) parts.shift(); // a partial first line from a mid-file tail read
    const nonEmpty = parts.filter((line) => line.length > 0);
    return opts.fromEnd ? nonEmpty.slice(-opts.maxLines) : nonEmpty.slice(0, opts.maxLines);
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}

/** The last (at most) `maxLines` complete lines within the last `maxBytes` of the file. */
export function tailLines(path: string, maxBytes: number, maxLines: number): string[] {
  return readBoundedLines(path, { maxBytes, fromEnd: true, maxLines });
}

/** The first (at most) `maxLines` complete lines within the first `maxBytes` of the file. */
export function headLines(path: string, maxBytes: number, maxLines: number): string[] {
  return readBoundedLines(path, { maxBytes, fromEnd: false, maxLines });
}

// =======================================================================================
// loss.jsonl — one record per training step
// =======================================================================================

/** One `loss.jsonl` row, camelCased. Exactly the keys the training script emits. */
export interface TrainingStepRecord {
  step: number;
  loss: number;
  tokensSeen: number;
  docsConsumed: number;
  elapsedS: number;
  tokensPerS: number;
  wallClock: string;
  threads: number;
  batchSize: number;
  blockSize: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Parse each line as one `loss.jsonl` record; a malformed or partial line is dropped, not thrown. */
export function parseJsonlRecords(lines: string[]): TrainingStepRecord[] {
  const out: TrainingStepRecord[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const r = parsed as Record<string, unknown>;
    if (
      !isFiniteNumber(r.step) ||
      !isFiniteNumber(r.loss) ||
      !isFiniteNumber(r.tokens_seen) ||
      !isFiniteNumber(r.docs_consumed) ||
      !isFiniteNumber(r.elapsed_s) ||
      !isFiniteNumber(r.tokens_per_s) ||
      typeof r.wall_clock !== "string" ||
      !isFiniteNumber(r.threads) ||
      !isFiniteNumber(r.batch_size) ||
      !isFiniteNumber(r.block_size)
    ) {
      continue;
    }
    out.push({
      step: r.step,
      loss: r.loss,
      tokensSeen: r.tokens_seen,
      docsConsumed: r.docs_consumed,
      elapsedS: r.elapsed_s,
      tokensPerS: r.tokens_per_s,
      wallClock: r.wall_clock,
      threads: r.threads,
      batchSize: r.batch_size,
      blockSize: r.block_size,
    });
  }
  return out;
}

// =======================================================================================
// Pure math — token budget, trend, ETA
// =======================================================================================

export interface TrainingStats {
  latest: TrainingStepRecord;
  /** Mean loss over the recent window (most recent steps in the tail). */
  recentAvgLoss: number;
  /** Mean loss over the first window (earliest steps the head read could see), or null this early. */
  firstAvgLoss: number | null;
  /** 0-100, clamped to the token budget. */
  tokensPct: number;
  /** A fixed-width text bar, e.g. `[####----------------]`. */
  progressBar: string;
  /** Milliseconds to the token budget at the latest observed rate, or null when the rate is 0. */
  etaMs: number | null;
}

/** `[####----------------]` — filled proportional to `pct` (0-100), clamped. */
export function renderProgressBar(pct: number, width = 20): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Derive the card's numbers from two windows of records: `recent` (the tail, most-recent-last) and
 * `first` (the head, earliest-first). Null when `recent` is empty — no step data yet, not an error.
 */
export function deriveTrainingStats(
  recent: TrainingStepRecord[],
  first: TrainingStepRecord[],
  tokenBudget: number,
): TrainingStats | null {
  if (recent.length === 0) return null;
  const latest = recent[recent.length - 1]!;
  const recentAvgLoss = average(recent.map((r) => r.loss));
  const firstAvgLoss = first.length > 0 ? average(first.map((r) => r.loss)) : null;
  const tokensPct = tokenBudget > 0 ? Math.max(0, Math.min(100, (latest.tokensSeen / tokenBudget) * 100)) : 0;
  const remainingTokens = Math.max(0, tokenBudget - latest.tokensSeen);
  const etaMs = latest.tokensPerS > 0 ? (remainingTokens / latest.tokensPerS) * 1000 : null;
  return { latest, recentAvgLoss, firstAvgLoss, tokensPct, progressBar: renderProgressBar(tokensPct), etaMs };
}

// =======================================================================================
// systemd --user unit liveness
// =======================================================================================

/** `systemctl --user is-active <unit>` — read-only, never touches the unit or its scratch dir. */
export function isSystemdUserUnitActive(unit: string): boolean {
  const result = spawnSync("systemctl", ["--user", "is-active", unit], { encoding: "utf8", timeout: 5_000 });
  if (result.error) return false;
  return result.stdout?.trim() === "active";
}

// =======================================================================================
// The progress source
// =======================================================================================

/** Everything one file-tailed progress source needs — the whole generalization. */
export interface FileTailProgressSourceConfig {
  /** Card header label, e.g. "throttled CPU pretrain". */
  label: string;
  /** systemd --user unit gating whether the card's numbers are live. */
  unit: string;
  /** The structured per-step log — see {@link TrainingStepRecord} for the exact keys expected. */
  jsonlPath: string;
  /** The human console log — becomes the card's "window into the terminal". */
  consoleLogPath: string;
  /** Tokens in one epoch; powers the percent, bar, and ETA. */
  tokenBudget: number;
  /** Where the card lands. */
  channelId: string;
}

export interface FileTailProgressSnapshot {
  label: string;
  active: boolean;
  stats: TrainingStats | null;
  /** The console log's last lines, oldest first — feeds the terminal window renderer directly. */
  consoleLines: string[];
}

/** Bounded-byte budgets: generous enough for the windows below, never a whole-file read. */
const JSONL_TAIL_BYTES = 64 * 1024;
const JSONL_HEAD_BYTES = 8 * 1024;
const JSONL_TAIL_MAX_LINES = 200;
const JSONL_HEAD_MAX_LINES = 60;
/** How many of the most-recent / earliest steps make up each trend window. */
const RECENT_WINDOW_STEPS = 20;
const FIRST_WINDOW_STEPS = 20;
const CONSOLE_TAIL_BYTES = 4 * 1024;
/** ro asked for "the last ~8-10 lines" of the console. */
const CONSOLE_WINDOW_LINES = 10;

interface ReadFileTailProgressDeps {
  isUnitActive?: (unit: string) => boolean;
}

/**
 * Read one source end to end: is the unit active, what does the structured log say (bounded tail
 * for "now", bounded head for the trend baseline), and the console tail. Every read degrades to
 * empty/null on a missing or mid-write file — this never throws.
 */
export function readFileTailProgress(
  config: FileTailProgressSourceConfig,
  deps: ReadFileTailProgressDeps = {},
): FileTailProgressSnapshot {
  const isUnitActive = deps.isUnitActive ?? isSystemdUserUnitActive;
  const active = isUnitActive(config.unit);
  const recentAll = parseJsonlRecords(tailLines(config.jsonlPath, JSONL_TAIL_BYTES, JSONL_TAIL_MAX_LINES));
  const firstAll = parseJsonlRecords(headLines(config.jsonlPath, JSONL_HEAD_BYTES, JSONL_HEAD_MAX_LINES));
  const stats = deriveTrainingStats(recentAll.slice(-RECENT_WINDOW_STEPS), firstAll.slice(0, FIRST_WINDOW_STEPS), config.tokenBudget);
  const consoleLines = tailLines(config.consoleLogPath, CONSOLE_TAIL_BYTES, CONSOLE_WINDOW_LINES);
  return { label: config.label, active, stats, consoleLines };
}
