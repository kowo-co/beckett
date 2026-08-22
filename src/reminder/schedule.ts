/**
 * Beckett — Reminder recurrence math (`src/reminder/schedule.ts`)
 * =======================================================================================
 * Unlike a routine's HUMANIZED fuzz window ({@link ../routine/schedule.ts}), a reminder fires at
 * an EXACT wall-clock time: "remind me at 9am" means 9am, not somewhere in a window. So this
 * module is narrower — given the instant a reminder just fired (or was created for) plus its
 * IANA timezone, compute the next occurrence that preserves the same LOCAL wall-clock time.
 *
 * DST correctness comes from the same trick `../routine/schedule.ts` already uses: calendar-date
 * arithmetic happens on naive UTC-midnight instants (never on the real `fireAt`, which may sit at
 * any offset), and the wall-clock hour/minute is re-resolved into a real UTC instant via
 * {@link zonedWallToUtc} for the LANDING date — so the DST offset in effect on that date, not the
 * origin date, is what's actually used. A daily 9am reminder that crosses a spring-forward stays
 * 9am local; the UTC instant it fires at simply shifts by an hour less than a full day.
 *
 * No date library: {@link zonedFields}/{@link zonedWallToUtc}/{@link isValidTimeZone} are
 * imported straight from `../routine/schedule.ts` rather than re-implemented — the exact reuse
 * the ticket asked for where it fits cleanly.
 */

import { isValidTimeZone, zonedFields, zonedWallToUtc } from "../routine/schedule.ts";
import type { Recurrence } from "./types.ts";

export { isValidTimeZone };

const DAY_MS = 86_400_000;

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

/** Add `days` (may be negative) to a naive calendar date — pure date-field arithmetic, no tz. */
export function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * DAY_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** True when the naive calendar date falls on a Saturday or Sunday. */
function isWeekend(date: CalendarDate): boolean {
  const dow = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * The next occurrence strictly after `at`, same local wall-clock time as `at`, per `recurrence`:
 *   - `daily`         → +1 calendar day.
 *   - `weekly`        → +7 calendar days (lands back on the same weekday by construction).
 *   - `weekday`       → +1 calendar day, then skip forward off any landing weekend.
 *   - `every-n-days`  → +`days` calendar days.
 *
 * Throws for `none` — a one-shot reminder has no next occurrence; the caller (the scheduler's
 * finalize step) must branch on `recurrence.kind === "none"` before reaching here.
 */
export function nextOccurrence(at: Date, tz: string, recurrence: Recurrence): Date {
  if (recurrence.kind === "none") {
    throw new Error("a one-shot reminder (recurrence: none) has no next occurrence");
  }
  const wall = zonedFields(tz, at);
  const step =
    recurrence.kind === "weekly" ? 7 : recurrence.kind === "every-n-days" ? recurrence.days : 1;
  let date = addCalendarDays(wall, step);
  if (recurrence.kind === "weekday") {
    while (isWeekend(date)) date = addCalendarDays(date, 1);
  }
  return zonedWallToUtc(tz, date.year, date.month, date.day, wall.hour, wall.minute);
}

/**
 * Roll `at` forward past `now` — the boot/late-catch-up path (issue's "late, once, never a
 * storm"): a recurring reminder that was due one or many times during downtime fires exactly
 * ONCE on the tick that finds it, then lands on the first FUTURE occurrence rather than
 * replaying every missed period. `at` is the occurrence that JUST fired (i.e. call this from the
 * scheduler's finalize step, after a successful dispatch, not before).
 */
export function rollPastDue(at: Date, tz: string, recurrence: Recurrence, now: Date): Date {
  let next = nextOccurrence(at, tz, recurrence);
  while (next.getTime() <= now.getTime()) next = nextOccurrence(next, tz, recurrence);
  return next;
}

/** The local weekday name of `at` in `tz`, lowercase (e.g. "monday") — used to fill a fresh `weekly` recurrence's `weekday` field from whatever `--when` resolved to. */
export function localWeekday(tz: string, at: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(at).toLowerCase();
}
