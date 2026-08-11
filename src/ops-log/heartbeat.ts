/**
 * Beckett — ops-log turn heartbeat (`src/ops-log/heartbeat.ts`)
 * =======================================================================================
 * Issue #231 deliverable 3, and the whole reason the issue exists: "a 5-minute typing
 * indicator with zero visibility (it was fine — an inline browser errand + a session re-ground
 * — but nobody could see that from Discord)." While ANY concierge turn is in flight for more
 * than {@link DEFAULT_THRESHOLD_MS}, post `⏳ still working — 2m, last: <most recent
 * sink-visible event>` every ~60s; stop the instant no turn is live.
 *
 * Deliberately ONE global heartbeat, not one per channel: "while any concierge turn is in
 * flight" (the spec's own wording) is a single daemon-wide condition, and the "last:" line is
 * daemon-wide too — a live turn's silence is usually explained by something that has nothing to
 * do with its own channel (a browser lease, a session re-ground), so the most recently mirrored
 * event system-wide is the honest answer to "is Beckett doing anything?", not a channel-scoped
 * one that would show nothing on the exact turns this feature exists to explain.
 */
import { log as rootLog } from "../log.ts";
import type { Logger } from "../types.ts";
import { fmtDuration } from "./render.ts";

export const DEFAULT_INTERVAL_MS = 60_000;
export const DEFAULT_THRESHOLD_MS = 60_000;

export interface TurnHeartbeatOptions {
  /** Enqueue one heartbeat line (the ops-log batcher). */
  push: (line: string) => void;
  intervalMs?: number;
  thresholdMs?: number;
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

export class TurnHeartbeat {
  private readonly push: (line: string) => void;
  private readonly intervalMs: number;
  private readonly thresholdMs: number;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => { cancel(): void };

  private liveCount = 0;
  private oldestStartedAt = 0;
  private lastEventLine = "";
  private timer: { cancel(): void } | null = null;

  constructor(opts: TurnHeartbeatOptions) {
    this.push = opts.push;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.thresholdMs = opts.thresholdMs ?? DEFAULT_THRESHOLD_MS;
    this.logger = opts.logger ?? rootLog.child("ops-log.heartbeat");
    this.now = opts.now ?? Date.now;
    this.schedule = opts.schedule ?? defaultSchedule;
  }

  /** Record the most recently MIRRORED event line — the heartbeat's "last:" field. */
  noteEvent(line: string): void {
    this.lastEventLine = line;
  }

  /** A turn started. The FIRST live turn arms the ~60s tick; a concurrent one just counts. */
  turnStarted(): void {
    if (this.liveCount === 0) this.oldestStartedAt = this.now();
    this.liveCount += 1;
    this.armTimer();
  }

  /** A turn ended (done or failed). The timer stops the instant nothing is left live. */
  turnEnded(): void {
    if (this.liveCount === 0) return; // a stray "done" with no matching "start" — never go negative
    this.liveCount -= 1;
    if (this.liveCount === 0) this.stop();
  }

  /** True while at least one turn is tracked live (tests). */
  isLive(): boolean {
    return this.liveCount > 0;
  }

  /** Stop the timer without clearing live state (hard shutdown). */
  stop(): void {
    this.timer?.cancel();
    this.timer = null;
  }

  private armTimer(): void {
    if (this.timer) return;
    this.timer = this.schedule(() => this.tick(), this.intervalMs);
  }

  private tick(): void {
    this.timer = null;
    if (this.liveCount === 0) return; // ended between the arm and the fire — say nothing
    const elapsed = this.now() - this.oldestStartedAt;
    if (elapsed >= this.thresholdMs) {
      try {
        this.push(`⏳ still working — ${fmtDuration(elapsed)}, last: ${this.lastEventLine || "no recent activity"}`);
      } catch (err) {
        // The heartbeat must never be the thing that breaks a live turn.
        this.logger.warn("ops-log heartbeat push failed", { err: String(err) });
      }
    }
    this.armTimer();
  }
}

export function createTurnHeartbeat(opts: TurnHeartbeatOptions): TurnHeartbeat {
  return new TurnHeartbeat(opts);
}
