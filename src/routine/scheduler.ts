/**
 * Beckett — Routine scheduler (`src/routine/scheduler.ts`)
 * =======================================================================================
 * The daemon hook that fires routines (issue #62). Modeled on `startRoutineMaintenance`
 * ({@link ../memory/maintain.ts}): a self-scheduling `setInterval` whose failures are logged
 * and swallowed so a broken routine never takes the daemon down. Wired in `boot()`.
 *
 * Each tick, for every enabled routine, it re-reads the store (single source of truth) and:
 *
 *   1. **Rolls** a concrete fire time if the current period has no chosen time yet — and
 *      persists it. A restart mid-window sees `state.periodKey` already equal to the current
 *      period, so it does NOT re-roll (the day's time is stable across restarts).
 *   2. **Fires** when now ≥ the chosen time and this period hasn't fired. Firing is idempotent
 *      per period: it CLAIMS the period (writes `lastFiredPeriodKey` + persists) BEFORE
 *      dispatching, so a crash mid-dispatch can never double-post.
 *   3. **Defers**, if the dispatcher vetoes this fire — asked BEFORE the claim, so a deferred
 *      routine is retried on the next tick inside the same period instead of losing it. Only
 *      free time (docs/freetime.md) uses this; a dispatcher without `deferReason` behaves
 *      exactly as before.
 *
 * A manual `fireNow` never consults the veto: a human asking for it now outranks the guard.
 *
 * Dispatch runs OFF this process: the injected `dispatch` executor hands the plan to the
 * `beckett browser` background lane. The scheduler never blocks on browser work.
 */

import type { Logger } from "../types.ts";
import type { RoutineStore } from "./store.ts";
import type { Routine } from "./types.ts";
import { periodDateKey, periodKey, rollFireTime, windowBounds } from "./schedule.ts";
import { toMinutes } from "./types.ts";
import { buildDispatchPlan, type RoutineDispatchPlan } from "./plan.ts";
import { applyDispatchFailure, applyDispatchSuccess, isRoutineHealthAlreadyRecorded } from "./dispatch-health.ts";

/**
 * At most this many LATE fires (a routine whose window has already fully elapsed, not merely a
 * few ticks behind) may catch up in a single tick. A boot right after a long downtime otherwise
 * evaluates every enabled routine in one pass, and every one whose window already passed today
 * fires within the same second — the 2026-08-22T00:57 restart storm that fired three sibling
 * `daily-x-shitpost` lanes together. A late routine that loses the race is NOT retried later this
 * tick or a later one: {@link evaluate} marks its period spent right away, so it rolls cleanly to
 * its next period (tomorrow, for a daily routine) instead of piling up.
 *
 * FIXED-time routines (a one-minute window — `builtins.ts`'s `fixedFireWindow`, which the nightly
 * dream pass uses) are exempt: with a 60-second window, any tick landing a minute off reads as
 * "late", and losing the slot would mark the day spent and silently skip a pass whose whole
 * contract is that it runs at its time. The exemption cannot storm — the period is still claimed
 * exactly once, so it is at most one extra cheap local job per tick.
 */
const LATE_CATCH_UP_BUDGET_PER_TICK = 1;

/** Default tick cadence — 30s keeps the fired minute within half a minute of the chosen time. */
export const ROUTINE_TICK_MS = 30_000;

export interface RoutineDispatcher {
  /** Execute a plan through the background lane. Resolves once the lane has TAKEN the work. */
  dispatch(plan: RoutineDispatchPlan, routine: Routine): Promise<void>;
  /**
   * OPTIONAL pre-claim veto, consulted BEFORE the period is claimed: a reason to hold this fire
   * for a later tick, or null to fire now. The one deliberate hole in "claim, then dispatch" —
   * and it is safe precisely because it happens BEFORE the claim: a deferred routine's period is
   * never marked fired, so the next 30s tick re-evaluates it, and every routine that does NOT
   * defer keeps byte-identical crash-safe once-per-period behavior.
   *
   * Free time (docs/freetime.md) is the only user: a session that would compete with live work is
   * pushed later in the same week rather than running alongside it. A dispatcher that never
   * defers (the default: this method absent) is the old code path exactly.
   */
  deferReason?(plan: RoutineDispatchPlan, routine: Routine): string | null;
}

export interface RoutineSchedulerDeps {
  store: RoutineStore;
  dispatcher: RoutineDispatcher;
  logger: Logger;
  /** Injectable clock + RNG so schedule/compose behavior is deterministic in tests. */
  now?: () => Date;
  rng?: () => number;
  intervalMs?: number;
  /**
   * One short line to the ops-log channel when a dispatch failure is first seen (or re-alerts
   * at 5/20) and when a previously-failing routine recovers. Missing → persist + log only.
   */
  alert?: (line: string) => Promise<void>;
}

export interface RoutineScheduler {
  /** One scheduling pass over all routines (exposed for tests + boot priming). */
  tick(): Promise<void>;
  /** Fire one routine now. `force` bypasses the schedule; `dryRun` builds+returns the plan only. */
  fireNow(id: string, opts?: { force?: boolean; dryRun?: boolean }): Promise<RoutineDispatchPlan>;
  stop(): void;
}

export function startRoutineScheduler(deps: RoutineSchedulerDeps): RoutineScheduler {
  const now = deps.now ?? (() => new Date());
  const rng = deps.rng ?? Math.random;
  const interval = deps.intervalMs ?? ROUTINE_TICK_MS;

  async function emitAlert(line: string): Promise<void> {
    if (!deps.alert) return;
    try {
      await deps.alert(line);
    } catch (err) {
      deps.logger.warn("routine ops alert failed", { error: String(err) });
    }
  }

  async function recordOutcome(
    id: string,
    base: Routine["state"],
    result: { ok: true; at: Date } | { ok: false; err: unknown; at: Date },
  ): Promise<void> {
    const update = result.ok
      ? applyDispatchSuccess(base, id, result.at)
      : applyDispatchFailure(base, result.err, { routineId: id });
    await deps.store.setState(id, update.state);
    if (update.alert) await emitAlert(update.alert);
  }

  async function evaluate(routine: Routine, catchUpBudget: { remaining: number }): Promise<void> {
    if (!routine.enabled) return;
    // `watch` routines have no `schedule` — they poll on their own interval via a SEPARATE loop
    // ({@link ./watch.ts}'s `startWatchLoop`), not this humanized-period one. Nothing below this
    // line applies to them.
    if (routine.action.kind === "watch" || !routine.schedule) return;
    const at = now();
    const key = periodKey(routine.schedule.cadence, routine.schedule.window, at);
    let state = routine.state;

    // 1. New period → roll a fresh fire time and persist. Same period → keep the chosen time
    //    (restart-safe: never re-roll a day that's already been rolled).
    if (state.periodKey !== key || !state.chosenFireAt) {
      const chosen = rollFireTime(routine.schedule, key, rng);
      state = { ...state, periodKey: key, chosenFireAt: chosen.toISOString() };
      await deps.store.setState(routine.id, state);
      deps.logger.info("routine period rolled", { id: routine.id, period: key, fireAt: state.chosenFireAt });
    }

    // 2. Fire once per period, at/after the chosen time.
    if (state.lastFiredPeriodKey === key) return;
    if (!state.chosenFireAt || at.getTime() < new Date(state.chosenFireAt).getTime()) return;

    // 3. The pre-claim veto (docs/freetime.md). Asked BEFORE the claim on purpose: a deferred
    //    fire leaves `lastFiredPeriodKey` untouched, so the next tick retries it inside the SAME
    //    period — the routine loses the window, never the week. Nothing else in the tick moves,
    //    so a routine whose dispatcher does not implement this is unaffected.
    const plan = buildDispatchPlan(routine);
    const defer = deps.dispatcher.deferReason?.(plan, routine) ?? null;
    if (defer) {
      deps.logger.info("routine fire deferred", { id: routine.id, period: key, reason: defer });
      return;
    }

    // 4. The boot catch-up guard: a fire whose WINDOW has fully elapsed (not just its chosen
    //    minute) is "late" — the daemon was down through it. At most
    //    `LATE_CATCH_UP_BUDGET_PER_TICK` late routines may claim+dispatch per tick; any others
    //    roll straight to their next period instead of storming in together.
    const windowEnd = windowBounds(routine.schedule.window, periodDateKey(routine.schedule.cadence, key)).end;
    // A FIXED-time routine (a one-minute window — see `fixedFireWindow`) is exempt from the
    // budget. The guard exists to stop a boot storm of BROWSER-posting siblings landing in the
    // same second; a fixed-time lane is one cheap local job whose whole contract is that it runs
    // at its time, and with a 60-second window it would read as "late" on any tick that lands a
    // minute off. Losing that race marks the period spent, so the exemption is the difference
    // between "ran a little after midnight" and "silently skipped today". It cannot storm: the
    // period is still claimed exactly once, so this is at most one extra fire per tick.
    const spanMinutes = toMinutes(routine.schedule.window.end) - toMinutes(routine.schedule.window.start);
    const isLate = at.getTime() > windowEnd.getTime() && spanMinutes > 1;
    if (isLate) {
      if (catchUpBudget.remaining <= 0) {
        const skipped = { ...state, lastFiredPeriodKey: key };
        await deps.store.setState(routine.id, skipped);
        deps.logger.info(
          "routine fire skipped: window already elapsed and this tick's catch-up budget is spent — rolling to the next period",
          { id: routine.id, period: key, windowEnd: windowEnd.toISOString() },
        );
        return;
      }
      catchUpBudget.remaining -= 1;
    }

    // Claim the period BEFORE dispatching so a crash mid-dispatch never double-fires.
    const claimed = { ...state, lastFiredPeriodKey: key, lastFiredAt: at.toISOString() };
    await deps.store.setState(routine.id, claimed);
    deps.logger.info("routine firing", { id: routine.id, period: key, preview: plan.preview });
    try {
      await deps.dispatcher.dispatch(plan, routine);
      await recordOutcome(routine.id, claimed, { ok: true, at });
    } catch (err) {
      // The period stays claimed (no double-fire); surface the failure where a human will see it.
      await recordOutcome(routine.id, claimed, { ok: false, err, at });
      deps.logger.error("routine dispatch failed", { id: routine.id, period: key, error: String(err) });
    }
  }

  async function tick(): Promise<void> {
    let routines: Routine[];
    try {
      routines = await deps.store.list();
    } catch (err) {
      deps.logger.warn("routine tick could not read the store", { error: String(err) });
      return;
    }
    const catchUpBudget = { remaining: LATE_CATCH_UP_BUDGET_PER_TICK };
    for (const routine of routines) {
      try {
        await evaluate(routine, catchUpBudget);
      } catch (err) {
        deps.logger.warn("routine evaluation failed", { id: routine.id, error: String(err) });
      }
    }
  }

  async function fireNow(id: string, opts: { force?: boolean; dryRun?: boolean } = {}): Promise<RoutineDispatchPlan> {
    const routine = await deps.store.get(id);
    if (!routine) throw new Error(`no such routine: ${id}`);
    const plan = buildDispatchPlan(routine);

    // `watch` has no period to be idempotent PER — its own qualify/dedup/rate-limit pass (run by
    // the dispatcher, {@link ../capability/modules/routines.ts}) is what keeps a manual fire safe,
    // the same rails that gate its automatic interval poll. So: a dry-run returns the (feed-blind)
    // pure plan here — the CLI builds a real, feed-aware preview itself via `previewWatchCycle`
    // without going through the daemon at all — and every other fire (force or not) just runs a
    // real poll cycle right now, `force` bypassing nothing but the "wait for the next interval"
    // wall-clock gate that only the separate poll loop enforces.
    if (routine.action.kind === "watch") {
      if (opts.dryRun) return plan;
      try {
        await deps.dispatcher.dispatch(plan, routine);
      } catch (err) {
        // runWatchCycle already persisted+alerted when the agent lane threw. An origin
        // refusal that never entered the cycle still needs the same record.
        if (!isRoutineHealthAlreadyRecorded(err)) {
          await recordOutcome(id, routine.state, { ok: false, err, at: now() });
        }
        throw err;
      }
      return plan;
    }

    if (opts.dryRun) return plan;
    if (!routine.schedule) throw new Error(`routine ${id} has no schedule (only a "watch" action may omit one)`);
    const schedule = routine.schedule;
    let claimed = routine.state;
    if (!opts.force) {
      // Non-forced manual fire still respects per-period idempotency.
      const key = periodKey(schedule.cadence, schedule.window, now());
      if (routine.state.lastFiredPeriodKey === key) {
        throw new Error(`routine ${id} already fired this period (${key}); use --force to fire again`);
      }
      claimed = {
        ...routine.state,
        lastFiredPeriodKey: key,
        lastFiredAt: now().toISOString(),
      };
      await deps.store.setState(id, claimed);
    } else {
      claimed = { ...routine.state, lastFiredAt: now().toISOString() };
      await deps.store.setState(id, claimed);
    }
    const at = now();
    try {
      await deps.dispatcher.dispatch(plan, routine);
      await recordOutcome(id, claimed, { ok: true, at });
    } catch (err) {
      await recordOutcome(id, claimed, { ok: false, err, at });
      throw err;
    }
    return plan;
  }

  const timer = setInterval(() => void tick().catch(() => {}), interval);
  timer.unref?.();

  return {
    tick,
    fireNow,
    stop() {
      clearInterval(timer);
    },
  };
}
