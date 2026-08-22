/**
 * Beckett — Reminder scheduler (`src/reminder/scheduler.ts`)
 * =======================================================================================
 * The daemon hook that fires reminders. Modeled on {@link ../routine/scheduler.ts} (a
 * self-scheduling `setInterval` whose failures are logged and swallowed so one broken reminder
 * never takes the daemon down), but the fire condition is simpler — a reminder has an exact
 * `fireAt` instant, not a fuzzed period — so the CLAIM/dispatch/FINALIZE shape below diverges
 * from the routine scheduler on purpose. See the header of {@link ../reminder/types.ts} for why:
 * a one-shot reminder must be impossible to either lose or double-deliver across a restart, and
 * the routine scheduler's "claim, then dispatch, and if dispatch throws the period just stays
 * claimed" behavior would LOSE a one-shot reminder on any dispatch failure (it has no next
 * period to roll to).
 *
 * ── THE CRASH-SAFETY STATE MACHINE ─────────────────────────────────────────────────────────
 * Each tick, for every reminder:
 *
 *   1. **`pending` and due** (`now >= fireAt`) → CLAIM: persist `status: "firing"` BEFORE
 *      dispatching. A crash before this write leaves the reminder untouched — still `pending`,
 *      still due, retried next tick, no attempt was ever made.
 *   2. **Already `firing`** (a claim left over from a previous tick — either a live retry after a
 *      dispatch failure within THIS run, across a normal tick boundary, or a claim orphaned by a
 *      crash before a previous restart) → treated as due regardless of `fireAt`, and dispatch is
 *      attempted (or re-attempted). This is the one deliberate bias, shared with
 *      `owed-run-notifications.ts`: "replay is better than silence" for the rare crash window
 *      between a delivery actually going out and the finalize write landing. Every other window
 *      (crash before dispatch, or dispatch itself throwing) has NO double-delivery risk at all —
 *      only this one narrow, accepted-elsewhere-in-this-codebase window does.
 *   3. **Dispatch throws** → the claim is released back to `pending` (not left stuck `firing`)
 *      so the next tick retries it. The reminder is never lost.
 *   4. **Dispatch resolves** → FINALIZE: a one-shot (`recurrence.kind === "none"`) reminder is
 *      REMOVED from the store — the self-clearing behavior ro asked for. A recurring one is
 *      rolled to its next occurrence (see `./schedule.ts#rollPastDue`, which also absorbs any
 *      number of periods missed during downtime into a single "late, once" fire) and returned to
 *      `pending`.
 *
 * Dispatch itself is injected ({@link ReminderDispatcher}) — this module never knows whether a
 * delivery is a Discord post or a concierge wake; see `../capability/modules/reminders.ts` for
 * the real one.
 */

import type { Logger } from "../types.ts";
import type { ReminderStore } from "./store.ts";
import type { Reminder } from "./types.ts";
import { rollPastDue } from "./schedule.ts";
import { buildDeliveryPlan, type ReminderDeliveryPlan } from "./plan.ts";

/** Default tick cadence — matches the routine scheduler's; reminders don't need finer than this. */
export const REMINDER_TICK_MS = 30_000;

export interface ReminderDispatcher {
  /** Deliver one reminder (external Discord post or internal concierge wake). Throw on failure. */
  dispatch(reminder: Reminder): Promise<void>;
}

export interface ReminderSchedulerDeps {
  store: ReminderStore;
  dispatcher: ReminderDispatcher;
  logger: Logger;
  /** Injectable clock so due-checking is deterministic in tests. */
  now?: () => Date;
  intervalMs?: number;
}

export interface ReminderScheduler {
  /** One scheduling pass over all reminders (exposed for tests + boot priming). */
  tick(): Promise<void>;
  /** Fire one reminder now. `dryRun` builds+returns the plan without dispatching. */
  fireNow(id: string, opts?: { dryRun?: boolean }): Promise<ReminderDeliveryPlan>;
  stop(): void;
}

export function startReminderScheduler(deps: ReminderSchedulerDeps): ReminderScheduler {
  const now = deps.now ?? (() => new Date());
  const interval = deps.intervalMs ?? REMINDER_TICK_MS;

  /** Finalize a reminder that just delivered successfully. */
  async function finalize(reminder: Reminder): Promise<void> {
    if (reminder.recurrence.kind === "none") {
      await deps.store.removeOneShot(reminder.id);
      deps.logger.info("reminder fired and cleared (one-shot)", { id: reminder.id });
      return;
    }
    const next = rollPastDue(new Date(reminder.fireAt), reminder.tz, reminder.recurrence, now());
    await deps.store.rollRecurring(reminder.id, next);
    deps.logger.info("reminder fired and rolled forward", {
      id: reminder.id,
      nextFireAt: next.toISOString(),
    });
  }

  async function deliver(reminder: Reminder): Promise<void> {
    try {
      await deps.dispatcher.dispatch(reminder);
    } catch (err) {
      // Release the claim so the NEXT tick retries — never leave it stuck `firing` with no
      // fresh attempt, and never finalize (remove/roll) a reminder that was never delivered.
      await deps.store.setPending(reminder.id);
      deps.logger.warn("reminder dispatch failed; will retry next tick", {
        id: reminder.id,
        error: String(err),
      });
      return;
    }
    await finalize(reminder);
  }

  async function evaluate(reminder: Reminder): Promise<void> {
    if (reminder.status === "firing") {
      // Orphaned or in-flight claim — retry regardless of fireAt (see module header §2).
      await deliver(reminder);
      return;
    }
    if (now().getTime() < Date.parse(reminder.fireAt)) return; // not due yet
    const claimed = await deps.store.setFiring(reminder.id);
    if (!claimed) return; // lost the race (removed/claimed concurrently) — nothing to do
    await deliver(reminder);
  }

  async function tick(): Promise<void> {
    let reminders: Reminder[];
    try {
      reminders = await deps.store.list();
    } catch (err) {
      deps.logger.warn("reminder tick could not read the store", { error: String(err) });
      return;
    }
    for (const reminder of reminders) {
      try {
        await evaluate(reminder);
      } catch (err) {
        deps.logger.warn("reminder evaluation failed", { id: reminder.id, error: String(err) });
      }
    }
  }

  async function fireNow(id: string, opts: { dryRun?: boolean } = {}): Promise<ReminderDeliveryPlan> {
    const reminder = await deps.store.get(id);
    if (!reminder) throw new Error(`no such reminder: ${id}`);
    const plan = buildDeliveryPlan(reminder);
    if (opts.dryRun) return plan;

    const claimed = await deps.store.setFiring(id);
    if (!claimed) throw new Error(`reminder ${id} is already firing`);
    try {
      await deps.dispatcher.dispatch(reminder);
    } catch (err) {
      await deps.store.setPending(id);
      throw err;
    }
    await finalize(reminder);
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
