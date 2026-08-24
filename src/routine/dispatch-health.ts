/**
 * Beckett — loud routine-dispatch failure (`src/routine/dispatch-health.ts`)
 * =======================================================================================
 * Dispatch that throws used to be one `level: "warn"` journal line and nothing a human (or
 * Beckett) would see. This module is the decision core for that class: persist consecutive
 * failures + last-alerted signature, alert once per signature then again at 5/20, emit one
 * recovery line when a previously-failing routine succeeds, and name enabled routines whose
 * origin cannot resolve at boot. Pure — the scheduler and the extension post the lines.
 */

import type { Routine, RoutineState } from "./types.ts";
import { buildDispatchPlan } from "./plan.ts";

/** Re-alert the same error signature when consecutive failures hit these counts (after the first). */
const ROUTINE_FAILURE_REALERT_AT: readonly number[] = [5, 20];

interface RoutineOriginFallback {
  channelId: string | null;
  requesterId: string | null;
}

/** Channel + requester after plan fields fall back to env. Null if either half is missing. */
export function resolveRoutineOrigin(
  channelId: string | null | undefined,
  requesterId: string | null | undefined,
  fallback: RoutineOriginFallback,
): { channelId: string; requesterId: string } | null {
  const channel = (channelId ?? fallback.channelId)?.trim() || "";
  const requester = (requesterId ?? fallback.requesterId)?.trim() || "";
  if (!channel || !requester) return null;
  return { channelId: channel, requesterId: requester };
}

/** Stable-enough fingerprint of a dispatch error — no stacks, no timestamps. */
function errorSignature(err: unknown): string {
  return shortError(err).toLowerCase().replace(/\s+/g, " ").slice(0, 200);
}

function shortError(err: unknown): string {
  let text = err instanceof Error ? err.message : String(err);
  text = text.replace(/^Error:\s*/i, "").trim();
  const first = text.split(/\n/)[0] ?? text;
  return first.slice(0, 180);
}

function shouldAlertFailure(state: RoutineState, signature: string, realertAt = ROUTINE_FAILURE_REALERT_AT): boolean {
  if (state.lastAlertedSignature !== signature) return true;
  return realertAt.includes(state.consecutiveFailures) && state.lastAlertedAtCount !== state.consecutiveFailures;
}

interface DispatchHealthUpdate {
  state: RoutineState;
  /** Ops-channel line to post, or null to stay quiet. */
  alert: string | null;
}

const HEALTH_RECORDED = Symbol("beckett.routineHealthRecorded");

/** True when {@link applyWatchCycleHealth} already persisted this thrown dispatch error. */
export function isRoutineHealthAlreadyRecorded(err: unknown): boolean {
  return typeof err === "object" && err !== null && HEALTH_RECORDED in err;
}

function markHealthRecorded(err: unknown): void {
  if (typeof err === "object" && err !== null) {
    (err as Record<symbol, boolean>)[HEALTH_RECORDED] = true;
  }
}

export function applyDispatchFailure(
  prev: RoutineState,
  err: unknown,
  opts: { routineId: string; now?: Date; realertAt?: readonly number[] } = { routineId: "routine" },
): DispatchHealthUpdate {
  const signature = errorSignature(err);
  const consecutiveFailures = prev.consecutiveFailures + 1;
  const next: RoutineState = {
    ...prev,
    lastOutcome: "failed",
    lastError: shortError(err),
    consecutiveFailures,
  };
  const alertNow = shouldAlertFailure(next, signature, opts.realertAt ?? ROUTINE_FAILURE_REALERT_AT);
  if (alertNow) {
    next.lastAlertedSignature = signature;
    next.lastAlertedAtCount = consecutiveFailures;
  }
  return {
    state: next,
    alert: alertNow ? formatFailureLine(opts.routineId, next.lastError!, consecutiveFailures) : null,
  };
}

/**
 * A watch poll always stamps `lastFiredAt`. Agent-lane attempts (ok or throw) also apply the
 * consecutive-failure / recovery rules; a quiet seed/no-qualifying/feed-error round does not
 * pretend the dispatch succeeded.
 */
export function applyWatchCycleHealth(
  prev: RoutineState,
  routineId: string,
  at: Date,
  dispatch?: { ok: true } | { ok: false; err: unknown },
): DispatchHealthUpdate {
  const withFire: RoutineState = { ...prev, lastFiredAt: at.toISOString() };
  if (!dispatch) return { state: withFire, alert: null };
  if (!dispatch.ok) markHealthRecorded(dispatch.err);
  return dispatch.ok
    ? applyDispatchSuccess(withFire, routineId, at)
    : applyDispatchFailure(withFire, dispatch.err, { routineId });
}

export function applyDispatchSuccess(prev: RoutineState, routineId: string, at: Date): DispatchHealthUpdate {
  const recovering = prev.consecutiveFailures > 0 || prev.lastOutcome === "failed";
  const misses = prev.consecutiveFailures;
  const state: RoutineState = {
    ...prev,
    lastSucceededAt: at.toISOString(),
    lastOutcome: "ok",
    lastError: null,
    consecutiveFailures: 0,
    lastAlertedSignature: null,
    lastAlertedAtCount: 0,
  };
  return {
    state,
    alert: recovering ? formatRecoveryLine(routineId, misses) : null,
  };
}

function formatFailureLine(routineId: string, error: string, consecutive: number): string {
  return (
    `routine \`${routineId}\` failed to dispatch (${consecutive} consecutive): ${error}. ` +
    `I'll stay quiet on the same error until it changes or the count hits 5 or 20.`
  );
}

function formatRecoveryLine(routineId: string, consecutiveMisses: number): string {
  const n = Math.max(consecutiveMisses, 1);
  return `routine \`${routineId}\` dispatched again after ${n} miss${n === 1 ? "" : "es"}. whatever that was, it's over.`;
}

export function enabledRoutinesMissingOrigin(routines: Routine[], fallback: RoutineOriginFallback): string[] {
  const missing: string[] = [];
  for (const routine of routines) {
    if (!routine.enabled) continue;
    const plan = buildDispatchPlan(routine);
    if (!resolveRoutineOrigin(plan.channelId, plan.requesterId, fallback)) missing.push(routine.id);
  }
  return missing.sort();
}

export function formatOriginStartupLine(ids: string[]): string | null {
  if (ids.length === 0) return null;
  return (
    `enabled routine${ids.length === 1 ? "" : "s"} that can't resolve an origin ` +
    `(channel + requester) and will fail on fire: ${ids.map((id) => `\`${id}\``).join(", ")}. ` +
    `set BECKETT_ROUTINE_CHANNEL_ID and DISCORD_OWNER_ID, or the routine's channelId/requesterId.`
  );
}
