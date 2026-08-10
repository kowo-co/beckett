/**
 * Beckett — the free-time idle gate (`src/freetime/gate.ts`)
 * =======================================================================================
 * One pure decision, in its own module for one reason: the routines extension consults it on
 * every scheduler tick, and `beckett routine …` must not pay for the free-time runner's import
 * graph (memory store, hooks, harness plumbing) to ask a two-field question. {@link ./run.ts}
 * re-exports it so the module's public surface is still the runner.
 *
 * The gate is the starvation guard the whole feature rests on (docs/freetime.md): free time is
 * the only routine that yields. Asked BEFORE the scheduler claims the period, so a deferral
 * costs the window, not the week — the next tick asks again.
 */

/** What the daemon knows about whether the machine is busy, at the instant of a fire. */
export interface FreeTimeBusySignals {
  /** No workers live and none queued (the dispatcher's own census). */
  fleetIdle: boolean;
  /** No concierge turns queued or in flight. */
  conciergeQuiet: boolean;
}

/**
 * Why this free-time fire should wait, or null to go. Both signals must be quiet: a session that
 * runs while a worker is building or while someone is mid-conversation is competing with work
 * somebody actually asked for, and the whole premise of free time is that it costs nothing that
 * was owed to anyone.
 */
export function freeTimeDeferReason(busy: FreeTimeBusySignals): string | null {
  const noisy: string[] = [];
  if (!busy.fleetIdle) noisy.push("the worker fleet is busy");
  if (!busy.conciergeQuiet) noisy.push("the concierge has turns in flight");
  if (!noisy.length) return null;
  return `${noisy.join(" and ")} — free time waits for a quiet machine`;
}
