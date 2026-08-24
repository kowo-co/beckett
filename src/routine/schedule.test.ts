import { expect, test, describe } from "bun:test";
import {
  isoWeekDate,
  isoWeekKey,
  isoWeekKeyOfDate,
  isValidTimeZone,
  localDateKey,
  nextFireAt,
  periodAdvanceMs,
  periodDateKey,
  periodKey,
  rollFireTime,
  windowBounds,
  zonedWallToUtc,
} from "./schedule.ts";
import { seededRng } from "./schedule.ts";
import { emptyRoutineState, type RoutineState, type Schedule, type Weekday } from "./types.ts";

const PT = "America/Los_Angeles";
const schedule: Schedule = {
  cadence: { kind: "daily" },
  window: { start: "12:00", end: "13:00", tz: PT },
};

describe("timezone math", () => {
  test("isValidTimeZone accepts IANA, rejects junk", () => {
    expect(isValidTimeZone(PT)).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
  });

  test("zonedWallToUtc resolves PDT (summer, UTC-7)", () => {
    // 2026-07-20 12:00 PT is 19:00 UTC in July (daylight time).
    const inst = zonedWallToUtc(PT, 2026, 7, 20, 12, 0);
    expect(inst.toISOString()).toBe("2026-07-20T19:00:00.000Z");
  });

  test("zonedWallToUtc resolves PST (winter, UTC-8)", () => {
    // 2026-01-20 12:00 PT is 20:00 UTC in January (standard time).
    const inst = zonedWallToUtc(PT, 2026, 1, 20, 12, 0);
    expect(inst.toISOString()).toBe("2026-01-20T20:00:00.000Z");
  });

  test("localDateKey / periodKey give the tz-local date", () => {
    // 2026-07-20T06:30Z is still 2026-07-19 23:30 in PT.
    const at = new Date("2026-07-20T06:30:00.000Z");
    expect(localDateKey(PT, at)).toBe("2026-07-19");
    expect(periodKey(schedule.cadence, schedule.window, at)).toBe("2026-07-19");
  });

  test("windowBounds spans exactly the window", () => {
    const { start, end } = windowBounds(schedule.window, "2026-07-20");
    expect(start.toISOString()).toBe("2026-07-20T19:00:00.000Z");
    expect(end.toISOString()).toBe("2026-07-20T20:00:00.000Z");
  });
});

describe("humanized fuzz (rollFireTime)", () => {
  test("chosen time always lands inside the window", () => {
    for (let i = 0; i < 200; i++) {
      const rng = seededRng(i);
      const fire = rollFireTime(schedule, "2026-07-20", rng);
      expect(fire.getTime()).toBeGreaterThanOrEqual(Date.parse("2026-07-20T19:00:00.000Z"));
      expect(fire.getTime()).toBeLessThan(Date.parse("2026-07-20T20:00:00.000Z"));
    }
  });

  test("rng endpoints map to the window edges", () => {
    const atStart = rollFireTime(schedule, "2026-07-20", () => 0);
    expect(atStart.toISOString()).toBe("2026-07-20T19:00:00.000Z");
    // Just under 1 → the last whole minute of the window (12:59 PT = 19:59Z).
    const atEnd = rollFireTime(schedule, "2026-07-20", () => 0.999999);
    expect(atEnd.toISOString()).toBe("2026-07-20T19:59:00.000Z");
  });

  test("the chosen minute VARIES run-to-run (seedable RNG)", () => {
    // The core acceptance property: different seeds produce different minutes.
    const minutes = new Set<number>();
    for (let seed = 0; seed < 30; seed++) {
      const fire = rollFireTime(schedule, "2026-07-20", seededRng(seed));
      minutes.add(fire.getUTCMinutes());
    }
    expect(minutes.size).toBeGreaterThan(5);
  });

  test("same seed reproduces the same minute (deterministic for tests)", () => {
    const a = rollFireTime(schedule, "2026-07-20", seededRng(42));
    const b = rollFireTime(schedule, "2026-07-20", seededRng(42));
    expect(a.toISOString()).toBe(b.toISOString());
  });
});

// ── weekly cadence (issue #85) ───────────────────────────────────────────────────────────────

const weekly: Schedule = {
  cadence: { kind: "weekly", weekday: "sunday" },
  window: { start: "08:00", end: "10:00", tz: PT },
};

/** Fresh (never-rolled, never-fired) state — what a routine looks like before its first tick. */
function freshState(): RoutineState {
  return emptyRoutineState();
}

describe("ISO week keys (the weekly period key)", () => {
  test("every day Mon→Sun shares ONE key, so a weekly routine fires at most once", () => {
    // 2026-W30 runs Mon 2026-07-20 → Sun 2026-07-26.
    const week = ["07-20", "07-21", "07-22", "07-23", "07-24", "07-25", "07-26"]
      .map((md) => isoWeekKeyOfDate("2026-" + md));
    expect(new Set(week)).toEqual(new Set(["2026-W30"]));
    // The Monday after rolls over — a NEW period, so the routine becomes eligible again.
    expect(isoWeekKeyOfDate("2026-07-27")).toBe("2026-W31");
  });

  test("the key belongs to the year holding the week's Thursday (New Year is not a double-fire)", () => {
    // 2027-01-01 is a Friday, in the same ISO week as 2026-12-28 — one key, one fire.
    expect(isoWeekKeyOfDate("2026-12-28")).toBe("2026-W53");
    expect(isoWeekKeyOfDate("2027-01-01")).toBe("2026-W53");
    expect(isoWeekKeyOfDate("2027-01-03")).toBe("2026-W53");
    expect(isoWeekKeyOfDate("2027-01-04")).toBe("2027-W01");
    // ...and 2026-01-01 (a Thursday) is genuinely week 1 of its own year.
    expect(isoWeekKeyOfDate("2026-01-01")).toBe("2026-W01");
  });

  test("periodKey reads the ISO week in the window's timezone, not UTC", () => {
    // 2026-07-27T05:00Z is still Sun 2026-07-26 22:00 in PT — the PREVIOUS ISO week.
    const at = new Date("2026-07-27T05:00:00.000Z");
    expect(isoWeekKey(PT, at)).toBe("2026-W30");
    expect(periodKey(weekly.cadence, weekly.window, at)).toBe("2026-W30");
    // The same instant is already Monday in UTC, where it would key to W31 — the bug this avoids.
    expect(isoWeekKeyOfDate("2026-07-27")).toBe("2026-W31");
  });

  test("isoWeekDate places a weekday inside its week, Monday first and Sunday LAST", () => {
    expect(isoWeekDate("2026-W30", "monday")).toBe("2026-07-20");
    expect(isoWeekDate("2026-W30", "sunday")).toBe("2026-07-26");
    // Sunday is day 7 of the week it fires in, never day 1 of the next one.
    expect(isoWeekKeyOfDate(isoWeekDate("2026-W30", "sunday"))).toBe("2026-W30");
    // Across the year boundary: W53's Sunday falls in the next calendar year.
    expect(isoWeekDate("2026-W53", "sunday")).toBe("2027-01-03");
  });

  test("key→date→key round-trips for every day across four years, week 53s included", () => {
    // The invariant the idempotency guard rests on: a date's ISO week, resolved back to that
    // date's own weekday, must land on the same date. Walks 2024–2027 so it crosses a leap year,
    // both 52- and 53-week years, and every New Year split.
    let ms = Date.UTC(2024, 0, 1);
    const end = Date.UTC(2028, 0, 1);
    let checked = 0;
    const weeks = new Set<string>();
    for (; ms < end; ms += 86_400_000) {
      const at = new Date(ms);
      const dateKey = at.toISOString().slice(0, 10);
      const weekday = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][
        at.getUTCDay()
      ] as Weekday;
      const key = isoWeekKeyOfDate(dateKey);
      weeks.add(key);
      expect(isoWeekDate(key, weekday)).toBe(dateKey);
      checked++;
    }
    expect(checked).toBe(1461); // 4 years incl. the 2024 leap day
    // 2026 has 53 ISO weeks; the set must contain that key and never a W00 or W54.
    expect(weeks.has("2026-W53")).toBe(true);
    expect([...weeks].some((k) => k.endsWith("-W00") || k.endsWith("-W54"))).toBe(false);
  });

  test("periodDateKey resolves a period to the date its window sits on", () => {
    expect(periodDateKey(schedule.cadence, "2026-07-20")).toBe("2026-07-20"); // daily: the key IS the date
    expect(periodDateKey(weekly.cadence, "2026-W30")).toBe("2026-07-26");
  });

  test("periodAdvanceMs steps one day for daily, one week for weekly", () => {
    expect(periodAdvanceMs(schedule.cadence)).toBe(86_400_000);
    expect(periodAdvanceMs(weekly.cadence)).toBe(7 * 86_400_000);
  });
});

describe("weekly fuzz lands on the chosen weekday inside the window", () => {
  test("every roll is on the Sunday of its week, inside 08:00–10:00 PT", () => {
    for (let seed = 0; seed < 200; seed++) {
      const fire = rollFireTime(weekly, "2026-W30", seededRng(seed));
      // Sun 2026-07-26 08:00 PT = 15:00Z (PDT, UTC-7); 10:00 PT = 17:00Z.
      expect(fire.getTime()).toBeGreaterThanOrEqual(Date.parse("2026-07-26T15:00:00.000Z"));
      expect(fire.getTime()).toBeLessThan(Date.parse("2026-07-26T17:00:00.000Z"));
      expect(localDateKey(PT, fire)).toBe("2026-07-26");
    }
  });

  test("the chosen minute still varies run-to-run (humanized, not clockwork)", () => {
    const instants = new Set<string>();
    for (let seed = 0; seed < 40; seed++) {
      instants.add(rollFireTime(weekly, "2026-W30", seededRng(seed)).toISOString());
    }
    expect(instants.size).toBeGreaterThan(20);
  });

  test("a seed reproduces the same instant, so a restart mid-week cannot re-roll it", () => {
    const a = rollFireTime(weekly, "2026-W30", seededRng(7));
    const b = rollFireTime(weekly, "2026-W30", seededRng(7));
    expect(a.toISOString()).toBe(b.toISOString());
  });

  test("the window follows the zone across DST, not a fixed UTC offset", () => {
    // Both are Sunday 08:00 PT; March is PDT (UTC-7), November is PST (UTC-8).
    expect(rollFireTime(weekly, isoWeekKeyOfDate("2026-03-08"), () => 0).toISOString())
      .toBe("2026-03-08T15:00:00.000Z");
    expect(rollFireTime(weekly, isoWeekKeyOfDate("2026-11-01"), () => 0).toISOString())
      .toBe("2026-11-01T16:00:00.000Z");
  });
});

describe("weekly nextFireAt", () => {
  test("mid-week, the next fire is THIS week's Sunday window", () => {
    // Mon 2026-07-20 12:30 PT.
    const at = new Date("2026-07-20T19:30:00.000Z");
    const next = nextFireAt(weekly, freshState(), at, () => 0);
    expect(next.toISOString()).toBe("2026-07-26T15:00:00.000Z");
    expect(localDateKey(PT, next)).toBe("2026-07-26");
  });

  test("a restart mid-week returns the ALREADY-CHOSEN instant, never a new roll", () => {
    const chosen = "2026-07-26T15:41:00.000Z";
    const next = nextFireAt(
      weekly,
      { ...freshState(), periodKey: "2026-W30", chosenFireAt: chosen },
      new Date("2026-07-22T19:30:00.000Z"),
      () => 0.999, // would roll a different minute if consulted — it must not be
    );
    expect(next.toISOString()).toBe(chosen);
  });

  test("once this week has fired, the next fire is NEXT week's Sunday — not the fired instant", () => {
    const at = new Date("2026-07-26T16:00:00.000Z"); // Sun, just after a fire
    const next = nextFireAt(
      weekly,
      {
        periodKey: "2026-W30",
        chosenFireAt: "2026-07-26T15:20:00.000Z",
        lastFiredPeriodKey: "2026-W30",
      },
      at,
      () => 0,
    );
    expect(next.toISOString()).toBe("2026-08-02T15:00:00.000Z"); // the following Sunday
    expect(next.getTime()).toBeGreaterThan(at.getTime());
  });

  test("a Sunday whose window elapsed unfired rolls forward to the next week", () => {
    const at = new Date("2026-07-26T20:00:00.000Z"); // Sun 13:00 PT — after the 08:00–10:00 window
    const next = nextFireAt(weekly, freshState(), at, () => 0);
    expect(next.toISOString()).toBe("2026-08-02T15:00:00.000Z");
  });

  test("daily still points at tomorrow's window once today has fired", () => {
    const at = new Date("2026-07-20T19:45:00.000Z");
    const next = nextFireAt(
      schedule,
      {
        periodKey: "2026-07-20",
        chosenFireAt: "2026-07-20T19:30:00.000Z",
        lastFiredPeriodKey: "2026-07-20",
      },
      at,
      () => 0,
    );
    expect(next.toISOString()).toBe("2026-07-21T19:00:00.000Z");
  });
});
