/**
 * TurnGate — a counting semaphore bounding how many concierge turns EXECUTE at once across the
 * whole session pool (OPS-80 §9.3). Sessions stay independently queued (per-channel FIFO with
 * priority jumps); the gate only meters the expensive part — a live `claude` turn — so N channels
 * can converse concurrently without unbounded parallel model calls.
 *
 * Fairness is FIFO across sessions: a released slot is handed DIRECTLY to the oldest waiter
 * (active never decrements on a handoff), so a burst of new acquires can neither overshoot the
 * limit nor starve a waiter. A slot is held for a session's full between-turns unit (the turn plus
 * its boundary rotation check) — rotation runs model turns of its own and must not exceed the cap.
 *
 * Priority acquires (issue #120) queue ahead of every waiting NORMAL acquire, so a person turn
 * never waits behind system turns from other channels; among same-class waiters FIFO holds.
 */
export class TurnGate {
  private active = 0;
  private readonly waiters: Array<{ resolve: () => void; priority: boolean }> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`TurnGate limit must be a positive integer (got ${limit})`);
    }
  }

  /**
   * Resolve with a release fn once a slot frees. Release is idempotent — a double call is a no-op.
   * A `priority` acquire (a person turn, issue #120) jumps ahead of every waiting normal acquire
   * but behind earlier priority ones — it never pre-empts a HELD slot.
   */
  async acquire(priority = false): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
    } else {
      // The releasing turn hands its slot straight to us — `active` already counts it.
      await new Promise<void>((resolve) => {
        const entry = { resolve, priority };
        if (priority) {
          // Ahead of every normal waiter, behind earlier priority ones (mirrors the session
          // turn-queue jump in ConciergeSession.ask).
          const firstNormal = this.waiters.findIndex((w) => !w.priority);
          if (firstNormal >= 0) this.waiters.splice(firstNormal, 0, entry);
          else this.waiters.push(entry);
        } else {
          this.waiters.push(entry);
        }
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next.resolve(); // direct handoff: the slot stays occupied, no decrement/increment gap
      else this.active -= 1;
    };
  }

  /** True when every slot is taken — the Concierge's "this turn will wait" fast-ack signal. */
  saturated(): boolean {
    return this.active >= this.limit;
  }

  stats(): { limit: number; active: number; waiting: number } {
    return { limit: this.limit, active: this.active, waiting: this.waiters.length };
  }
}
