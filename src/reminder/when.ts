/**
 * Beckett — reminder `--when` parsing (`src/reminder/when.ts`)
 * =======================================================================================
 * `beckett remind create`'s `--when` accepts an absolute time OR one of the two simple relative
 * forms the ticket scoped in: `in <N><unit>` ("in 20m", "in 3h", "in 2d") and `tomorrow <time>`
 * ("tomorrow 9am", "tomorrow 9:30pm"). Deliberately narrow — no general natural-language date
 * parsing (scope ceiling). Absolute input falls through to `Date.parse` (anything
 * `Date`-parseable: ISO-8601, `2026-08-25T09:00:00Z`, `2026-08-25 09:00`, …).
 */

import { zonedFields, zonedWallToUtc } from "../routine/schedule.ts";
import { addCalendarDays } from "./schedule.ts";

const RELATIVE = /^in\s+(\d+)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d)$/i;
const TOMORROW = /^tomorrow(?:\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i;

const UNIT_MS: Record<"m" | "h" | "d", number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** The unit family ("m"/"h"/"d") a relative-time unit token belongs to. */
function unitFamily(unit: string): "m" | "h" | "d" {
  const u = unit.toLowerCase();
  if (u.startsWith("h")) return "h";
  if (u.startsWith("d")) return "d";
  return "m";
}

/**
 * Parse `raw` into an absolute UTC instant. `tz` grounds the relative forms ("tomorrow" is
 * tomorrow in `tz`'s wall-clock, not UTC's). Throws with a usage-shaped message on anything it
 * cannot parse, rather than silently guessing.
 */
export function parseWhen(raw: string, tz: string, now: Date): Date {
  const trimmed = raw.trim();

  const rel = trimmed.match(RELATIVE);
  if (rel) {
    const amount = Number(rel[1]);
    const ms = amount * UNIT_MS[unitFamily(rel[2]!)];
    return new Date(now.getTime() + ms);
  }

  const tom = trimmed.match(TOMORROW);
  if (tom) {
    let hour = tom[1] ? Number(tom[1]) : 9; // bare "tomorrow" → 9am, a reasonable default
    const minute = tom[2] ? Number(tom[2]) : 0;
    const ampm = tom[3]?.toLowerCase();
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) throw new Error(`--when "${raw}" has an invalid time of day`);
    const today = zonedFields(tz, now);
    const tomorrowDate = addCalendarDays(today, 1);
    return zonedWallToUtc(tz, tomorrowDate.year, tomorrowDate.month, tomorrowDate.day, hour, minute);
  }

  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) return parsed;

  throw new Error(
    `could not parse --when "${raw}" — use an absolute time, "in <N>m/h/d" (e.g. "in 20m"), or "tomorrow 9am"`,
  );
}
