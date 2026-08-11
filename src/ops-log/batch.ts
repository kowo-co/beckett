/**
 * Beckett — ops-log batching queue (`src/ops-log/batch.ts`)
 * =======================================================================================
 * Coalesces rendered ops-log lines into one Discord message per ~2s window (issue #231
 * deliverable 2): a bounded in-memory queue (never grows past {@link DEFAULT_MAX_QUEUED} — a
 * flood of events drops the newest ones with a running counter, rather than growing forever),
 * joined into one post ≤ {@link DEFAULT_MAX_CHARS} characters, with a trailing `… +N more` line
 * covering whatever the char cap or the queue bound had to drop. Rate-limit safe by
 * construction: at most one post per window, ever.
 *
 * Fails open: a throwing `post` is caught and logged (never rethrown), so a Discord outage can
 * never take down the caller — the whole point of a log mirror is that it must never become a
 * NEW way for the daemon to break.
 *
 * `now`/`schedule` follow the same injectable-clock seam as `src/progress/cards.ts`, so tests
 * drive the window with a fake clock instead of real timers.
 */
import { log as rootLog } from "../log.ts";
import type { Logger } from "../types.ts";

export const DEFAULT_WINDOW_MS = 2_000;
export const DEFAULT_MAX_CHARS = 1_900;
/** Bounded queue depth (issue #231 deliverable 2 — "bounded queue"). Not config-exposed: this
 *  is a safety valve, not a tuning knob. */
export const DEFAULT_MAX_QUEUED = 500;

export interface OpsLogBatcherOptions {
  /** Deliver one already-assembled message. Must never throw out of {@link OpsLogBatcher} —
   *  a rejection is caught and logged, batch dropped, caller never blocked. */
  post: (content: string) => Promise<void>;
  windowMs?: number;
  maxChars?: number;
  maxQueued?: number;
  logger?: Logger;
  now?: () => number;
  /** Timer seam (tests). Default wraps setTimeout/clearTimeout, unref'd. */
  schedule?: (fn: () => void, ms: number) => { cancel(): void };
}

function defaultSchedule(fn: () => void, ms: number): { cancel(): void } {
  const timer = setTimeout(fn, Math.max(0, ms));
  (timer as unknown as { unref?: () => void }).unref?.();
  return { cancel: () => clearTimeout(timer) };
}

/** Join `lines`, dropping from the end (counted) until the message plus its drop suffix fits. */
export function buildBatchMessage(lines: readonly string[], maxChars: number, alreadyDropped = 0): string {
  let dropped = alreadyDropped;
  const kept = [...lines];
  let joined = kept.join("\n");
  let suffix = dropped > 0 ? `\n… +${dropped} more` : "";
  while (kept.length > 0 && joined.length + suffix.length > maxChars) {
    kept.pop();
    dropped += 1;
    joined = kept.join("\n");
    suffix = `\n… +${dropped} more`;
  }
  if (kept.length === 0) return dropped > 0 ? `… +${dropped} more` : "";
  return joined + suffix;
}

export class OpsLogBatcher {
  private readonly post: (content: string) => Promise<void>;
  private readonly windowMs: number;
  private readonly maxChars: number;
  private readonly maxQueued: number;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => { cancel(): void };

  private queue: string[] = [];
  private droppedSinceFlush = 0;
  private timer: { cancel(): void } | null = null;
  private flushing: Promise<void> | null = null;

  constructor(opts: OpsLogBatcherOptions) {
    this.post = opts.post;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
    this.maxQueued = opts.maxQueued ?? DEFAULT_MAX_QUEUED;
    this.logger = opts.logger ?? rootLog.child("ops-log.batch");
    this.now = opts.now ?? Date.now;
    this.schedule = opts.schedule ?? defaultSchedule;
  }

  /** Enqueue one rendered line. Opens the window's timer on the first line since the last flush. */
  push(line: string): void {
    if (this.queue.length >= this.maxQueued) {
      this.droppedSinceFlush += 1;
      return;
    }
    this.queue.push(line);
    this.armTimer();
  }

  /** Lines currently queued (tests). */
  queued(): number {
    return this.queue.length;
  }

  private armTimer(): void {
    if (this.timer) return;
    this.timer = this.schedule(() => {
      this.timer = null;
      void this.flush();
    }, this.windowMs);
  }

  /** Flush the current queue as one message. Never throws — fails open on any post error. */
  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.queue.length === 0) return;
    const lines = this.queue;
    const dropped = this.droppedSinceFlush;
    this.queue = [];
    this.droppedSinceFlush = 0;
    const content = buildBatchMessage(lines, this.maxChars, dropped);
    if (!content) return;
    const active = this.post(content).catch((err) => {
      // Fails open (issue #231 deliverable 2): a dead/misconfigured Discord channel must never
      // throw back into the log pipeline. Logged via the injected logger, whose component the
      // sink deliberately excludes from mirroring — this line can never re-enter this batcher.
      this.logger.warn("ops-log post failed — batch dropped", { lines: lines.length, err: String(err) });
    });
    this.flushing = active;
    try {
      await active;
    } finally {
      if (this.flushing === active) this.flushing = null;
    }
  }

  /** Cancel the pending timer (if any) and flush right now (tests / graceful shutdown). */
  async flushNow(): Promise<void> {
    this.timer?.cancel();
    this.timer = null;
    await this.flush();
  }

  /** Stop the pending timer without flushing (hard shutdown). */
  stop(): void {
    this.timer?.cancel();
    this.timer = null;
  }
}

export function createOpsLogBatcher(opts: OpsLogBatcherOptions): OpsLogBatcher {
  return new OpsLogBatcher(opts);
}
