import { expect, test } from "bun:test";
import { nextOccurrence, rollPastDue, isValidTimeZone } from "./schedule.ts";
import type { Recurrence } from "./types.ts";

const PT = "America/Los_Angeles";

test("daily recurrence advances exactly one calendar day, same wall-clock time", () => {
  const at = new Date("2026-07-20T16:00:00.000Z"); // 09:00 PT
  const next = nextOccurrence(at, PT, { kind: "daily" });
  expect(next.toISOString()).toBe("2026-07-21T16:00:00.000Z"); // 09:00 PT the next day
});

test("weekly recurrence advances exactly seven calendar days (same weekday)", () => {
  const at = new Date("2026-07-20T16:00:00.000Z"); // Monday 09:00 PT
  const next = nextOccurrence(at, PT, { kind: "weekly", weekday: "monday" });
  expect(next.toISOString()).toBe("2026-07-27T16:00:00.000Z");
});

test("weekday recurrence skips Saturday/Sunday", () => {
  // Friday 2026-07-24 09:00 PT -> next is Monday 2026-07-27, not Saturday.
  const friday = new Date("2026-07-24T16:00:00.000Z");
  const next = nextOccurrence(friday, PT, { kind: "weekday" });
  expect(next.toISOString()).toBe("2026-07-27T16:00:00.000Z");
});

test("every-n-days recurrence advances by the configured number of days", () => {
  const at = new Date("2026-07-20T16:00:00.000Z");
  const next = nextOccurrence(at, PT, { kind: "every-n-days", days: 3 });
  expect(next.toISOString()).toBe("2026-07-23T16:00:00.000Z");
});

test("a one-shot recurrence has no next occurrence", () => {
  const at = new Date("2026-07-20T16:00:00.000Z");
  expect(() => nextOccurrence(at, PT, { kind: "none" })).toThrow(/no next occurrence/);
});

test("daily recurrence stays 9am PT across the spring-forward DST boundary", () => {
  // 2026-03-08 is the US spring-forward date: PT goes from UTC-8 (PST) to UTC-7 (PDT).
  const beforeDst = new Date("2026-03-07T17:00:00.000Z"); // 09:00 PST
  const next = nextOccurrence(beforeDst, PT, { kind: "daily" });
  // Same 09:00 local wall-clock, but the UTC instant shifted an hour earlier — the DST offset
  // in effect on the LANDING date (PDT, UTC-7) was used, not the origin date's (PST, UTC-8).
  expect(next.toISOString()).toBe("2026-03-08T16:00:00.000Z"); // 09:00 PDT
});

test("daily recurrence stays 9am PT across the fall-back DST boundary", () => {
  // 2026-11-01 is the US fall-back date: PT goes from UTC-7 (PDT) back to UTC-8 (PST).
  const beforeStandard = new Date("2026-10-31T16:00:00.000Z"); // 09:00 PDT
  const next = nextOccurrence(beforeStandard, PT, { kind: "daily" });
  expect(next.toISOString()).toBe("2026-11-01T17:00:00.000Z"); // 09:00 PST
});

test("rollPastDue collapses any number of missed periods into exactly one future occurrence", () => {
  // A daily reminder last fired 2026-07-01 09:00 PT; "now" is ten days later. rollPastDue must
  // land on the first occurrence still in the future, not replay every missed day.
  const lastFired = new Date("2026-07-01T16:00:00.000Z");
  const now = new Date("2026-07-11T12:00:00.000Z"); // 05:00 PT, 2026-07-11 (before that day's 09:00 fire)
  const next = rollPastDue(lastFired, PT, { kind: "daily" }, now);
  expect(next.getTime()).toBeGreaterThan(now.getTime());
  // The first 09:00 PT strictly after `now` is later that SAME day, 2026-07-11.
  expect(next.toISOString()).toBe("2026-07-11T16:00:00.000Z");
});

test("rollPastDue is a no-op step when the very next occurrence is already in the future", () => {
  const lastFired = new Date("2026-07-20T16:00:00.000Z");
  const now = new Date("2026-07-20T18:00:00.000Z"); // same day, shortly after firing
  const next = rollPastDue(lastFired, PT, { kind: "daily" }, now);
  expect(next.toISOString()).toBe("2026-07-21T16:00:00.000Z");
});

test("isValidTimeZone accepts a real IANA zone and rejects a typo", () => {
  expect(isValidTimeZone("America/Los_Angeles")).toBe(true);
  expect(isValidTimeZone("Not/AZone")).toBe(false);
});

test("every-n-days recurrence also carries missed periods correctly via rollPastDue", () => {
  const recurrence: Recurrence = { kind: "every-n-days", days: 3 };
  const lastFired = new Date("2026-07-01T16:00:00.000Z");
  const now = new Date("2026-07-10T12:00:00.000Z");
  const next = rollPastDue(lastFired, PT, recurrence, now);
  // 07-04, 07-07, 07-10 (still <= now at 12:00 vs fire at 16:00Z=09:00PT... 07-10 09:00PT=16:00Z < 12:00Z? No: 16:00Z is LATER than 12:00Z same day)
  // So 07-10 09:00PT is actually AFTER 07-10 12:00Z (which is 05:00 PT) -> it qualifies as the first future occurrence.
  expect(next.toISOString()).toBe("2026-07-10T16:00:00.000Z");
});
