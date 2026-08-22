/**
 * Beckett — Routine schedule math (`src/routine/schedule.ts`)
 * =======================================================================================
 * The humanized-timing core (issue #62): given a routine's cadence + fuzz window in a named
 * timezone, compute
 *
 *   - the **period key** for an instant (the unit a routine fires at most once per — the
 *     tz-local calendar date for `daily`, the tz-local ISO week for `weekly`), and
 *   - a **concrete fire time** chosen uniformly at random inside the window for that period
 *     (for `weekly`, inside the window on the cadence's chosen weekday).
 *
 * Everything here is PURE and the randomness is INJECTED (`rng: () => number` in [0,1)), so
 * "the chosen minute varies run-to-run" is verified deterministically in tests by feeding a
 * seeded RNG. No external date library — timezone↔UTC conversion is done with the built-in
 * `Intl.DateTimeFormat`, which every supported runtime ships with the IANA tz database.
 */

import type { Cadence, FuzzWindow, Schedule, Weekday } from "./types.ts";
import { toMinutes, WEEKDAYS } from "./types.ts";

/** One calendar day in ms. Only used for whole-date arithmetic on UTC-midnight instants. */
const DAY_MS = 86_400_000;

/**
 * A tiny deterministic PRNG (Mulberry32) so a seed reproduces a run in tests. Lives here beside
 * the schedule math it feeds (`rollFireTime`) — the only injection point for randomness now that
 * composition is the agent's job, not the routine's.
 */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Validate an IANA timezone id up front so a typo fails at add-time, not at fire-time. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The wall-clock the named zone shows at instant `at`, as calendar fields (h23). Exported for
 * reuse by {@link ../reminder/schedule.ts}'s fixed-wall-clock recurrence math, which needs the
 * same DST-safe zoned⇄UTC conversion this module already built for the fuzz-window cadence.
 */
export function zonedFields(
  tz: string,
  at: Date,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const part of dtf.formatToParts(at)) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/** Offset (localWall − UTC) in ms the zone is at instant `at`. Positive east of UTC. */
function tzOffsetMs(tz: string, at: Date): number {
  const f = zonedFields(tz, at);
  const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return asUtc - at.getTime();
}

/**
 * Convert a wall-clock (y-mo-d h:mi in `tz`) to the UTC instant it names. Two-pass so a time
 * near a DST transition resolves against the offset actually in effect at the result instant,
 * not the offset at the naive guess.
 */
export function zonedWallToUtc(
  tz: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let inst = naive - tzOffsetMs(tz, new Date(naive));
  inst = naive - tzOffsetMs(tz, new Date(inst));
  return new Date(inst);
}

/** The tz-local calendar date of `at` as "YYYY-MM-DD". */
export function localDateKey(tz: string, at: Date): string {
  const f = zonedFields(tz, at);
  const mm = String(f.month).padStart(2, "0");
  const dd = String(f.day).padStart(2, "0");
  return `${f.year}-${mm}-${dd}`;
}

// ── ISO week arithmetic (the `weekly` cadence's period key) ─────────────────────────────────
//
// Plain whole-date math on UTC-midnight instants: a tz-local calendar date is turned into a
// naive "YYYY-MM-DD" by localDateKey FIRST, so nothing below ever has to reason about offsets.
// Only windowBounds crosses back into a real timezone, exactly as it already did for daily.

/** "YYYY-MM-DD" → the UTC-midnight instant of that naive calendar date, in ms. */
function dateKeyToUtcMs(dateKey: string): number {
  const [year, month, day] = dateKey.split("-").map(Number);
  return Date.UTC(year!, month! - 1, day!);
}

/** The inverse of {@link dateKeyToUtcMs}: a UTC-midnight instant → "YYYY-MM-DD". */
function utcMsToDateKey(ms: number): string {
  const at = new Date(ms);
  const mm = String(at.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(at.getUTCDate()).padStart(2, "0");
  return `${at.getUTCFullYear()}-${mm}-${dd}`;
}

/**
 * The ISO-8601 week-numbering key of a naive calendar date, e.g. "2026-W30". Weeks run Monday→
 * Sunday and belong to the year that holds their Thursday, which is what makes this a sound
 * once-per-week idempotency key across a New Year boundary: 2027-01-01 (a Friday) keys to
 * "2026-W53", the same week as 2026-12-28, so a Sunday routine can't fire twice in one week.
 */
export function isoWeekKeyOfDate(dateKey: string): string {
  const ms = dateKeyToUtcMs(dateKey);
  const mondayIndex = (new Date(ms).getUTCDay() + 6) % 7; // 0 = Monday … 6 = Sunday
  const thursday = ms + (3 - mondayIndex) * DAY_MS;
  const isoYear = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(isoYear, 0, 1)) / (7 * DAY_MS)) + 1;
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** The ISO week key of the tz-local date `at` falls on. */
export function isoWeekKey(tz: string, at: Date): string {
  return isoWeekKeyOfDate(localDateKey(tz, at));
}

/** The calendar date ("YYYY-MM-DD") that `weekday` falls on inside ISO week `weekKey`. */
export function isoWeekDate(weekKey: string, weekday: Weekday): string {
  const m = weekKey.match(/^(\d{4})-W(\d{2})$/);
  if (!m) throw new Error(`not an ISO week key: ${weekKey}`);
  const isoYear = Number(m[1]);
  const week = Number(m[2]);
  // Jan 4 is always in ISO week 1, so week 1's Monday is the Monday on-or-before Jan 4.
  const jan4 = Date.UTC(isoYear, 0, 4);
  const week1Monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS;
  return utcMsToDateKey(week1Monday + ((week - 1) * 7 + WEEKDAYS.indexOf(weekday)) * DAY_MS);
}

/**
 * The key of the period `at` falls in. A routine fires at most once per period key: the tz-local
 * date for `daily`, the tz-local ISO week for `weekly`.
 */
export function periodKey(cadence: Cadence, window: FuzzWindow, at: Date): string {
  switch (cadence.kind) {
    case "daily":
      return localDateKey(window.tz, at);
    case "weekly":
      return isoWeekKey(window.tz, at);
  }
}

/**
 * The tz-local calendar DATE whose window a period's fire lands in. For `daily` the period key
 * already IS that date; for `weekly` it is the cadence's weekday inside the keyed ISO week. This
 * is the one place the two cadences differ downstream — {@link windowBounds} and everything above
 * it stay date-keyed and cadence-blind.
 */
export function periodDateKey(cadence: Cadence, key: string): string {
  switch (cadence.kind) {
    case "daily":
      return key;
    case "weekly":
      return isoWeekDate(key, cadence.weekday);
  }
}

/**
 * How far ahead "the next period" is — the step {@link nextFireAt} walks when the current period
 * is spent (already fired, or its window elapsed unfired). One real day / one real week; a DST
 * shift moves the wall-clock, never which period the landing instant belongs to.
 */
export function periodAdvanceMs(cadence: Cadence): number {
  switch (cadence.kind) {
    case "daily":
      return DAY_MS;
    case "weekly":
      return 7 * DAY_MS;
  }
}

/**
 * The [start, end) UTC instants of the window on the calendar DATE `dateKey` ("YYYY-MM-DD").
 * Cadence-blind: a weekly period resolves to its date via {@link periodDateKey} first.
 */
export function windowBounds(window: FuzzWindow, dateKey: string): { start: Date; end: Date } {
  const [year, month, day] = dateKey.split("-").map(Number);
  const [sh, sm] = window.start.split(":").map(Number);
  const [eh, em] = window.end.split(":").map(Number);
  return {
    start: zonedWallToUtc(window.tz, year!, month!, day!, sh!, sm!),
    end: zonedWallToUtc(window.tz, year!, month!, day!, eh!, em!),
  };
}

/**
 * Roll a concrete fire instant uniformly at random inside the window for period `key`. Chosen
 * to whole-minute granularity so the humanized time reads naturally (12:07, 12:41, …) and so
 * "the chosen minute varies run-to-run" is the observable, testable property. `rng` returns a
 * float in [0,1); inject a seeded one in tests.
 *
 * A `weekly` period's window sits on the cadence's weekday inside the keyed ISO week — the fuzz
 * is identical, it just lands on one day of seven instead of every day.
 */
export function rollFireTime(schedule: Schedule, key: string, rng: () => number): Date {
  const { start } = windowBounds(schedule.window, periodDateKey(schedule.cadence, key));
  const spanMinutes = toMinutes(schedule.window.end) - toMinutes(schedule.window.start);
  const minute = Math.min(spanMinutes - 1, Math.floor(rng() * spanMinutes));
  return new Date(start.getTime() + minute * 60_000);
}

/**
 * The next concrete fire time for display: the persisted `chosenFireAt` while the current period
 * is still pending (so `routine ls` shows the same instant the scheduler will actually fire at,
 * even once it's a few seconds overdue), else the roll for the NEXT period. `rng` is only
 * consulted for a period that has no persisted roll.
 *
 * "Spent" means either already fired this period — which is why `lastFiredPeriodKey` is read here
 * and matters much more for weekly (a fired Sunday would otherwise read as "next fire" for the
 * six days after it) — or the window elapsed without a fire at all.
 */
export function nextFireAt(
  schedule: Schedule,
  state: { periodKey: string | null; chosenFireAt: string | null; lastFiredPeriodKey: string | null },
  now: Date,
  rng: () => number,
): Date {
  const key = periodKey(schedule.cadence, schedule.window, now);
  if (state.lastFiredPeriodKey !== key) {
    if (state.periodKey === key && state.chosenFireAt) return new Date(state.chosenFireAt);
    const rolled = rollFireTime(schedule, key, rng);
    if (rolled.getTime() >= now.getTime()) return rolled;
  }
  // This period is spent (fired, or its window fully elapsed unfired) — roll the next one's.
  const nextKey = periodKey(
    schedule.cadence,
    schedule.window,
    new Date(now.getTime() + periodAdvanceMs(schedule.cadence)),
  );
  return rollFireTime(schedule, nextKey, rng);
}
