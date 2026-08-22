import { expect, test } from "bun:test";
import { parseWhen } from "./when.ts";

const PT = "America/Los_Angeles";
const NOW = new Date("2026-07-20T16:00:00.000Z"); // 2026-07-20 09:00 PT (Monday)

test('"in 20m" resolves 20 minutes ahead of now', () => {
  expect(parseWhen("in 20m", PT, NOW).toISOString()).toBe("2026-07-20T16:20:00.000Z");
});

test('"in 3h" resolves 3 hours ahead of now', () => {
  expect(parseWhen("in 3h", PT, NOW).toISOString()).toBe("2026-07-20T19:00:00.000Z");
});

test('"in 2 days" resolves 2 days ahead of now', () => {
  expect(parseWhen("in 2 days", PT, NOW).toISOString()).toBe("2026-07-22T16:00:00.000Z");
});

test('"tomorrow 9am" resolves 9am PT the next calendar day', () => {
  expect(parseWhen("tomorrow 9am", PT, NOW).toISOString()).toBe("2026-07-21T16:00:00.000Z");
});

test('"tomorrow" with no time defaults to 9am PT', () => {
  expect(parseWhen("tomorrow", PT, NOW).toISOString()).toBe("2026-07-21T16:00:00.000Z");
});

test('"tomorrow 9:30pm" resolves 21:30 PT the next calendar day', () => {
  expect(parseWhen("tomorrow 9:30pm", PT, NOW).toISOString()).toBe("2026-07-22T04:30:00.000Z");
});

test("an absolute ISO instant is parsed as-is", () => {
  expect(parseWhen("2026-08-01T12:00:00.000Z", PT, NOW).toISOString()).toBe("2026-08-01T12:00:00.000Z");
});

test("garbage input throws a usage-shaped error", () => {
  expect(() => parseWhen("whenever, idk", PT, NOW)).toThrow(/could not parse/);
});

test("an invalid time-of-day throws rather than silently clamping", () => {
  expect(() => parseWhen("tomorrow 25:99", PT, NOW)).toThrow(/invalid time of day/);
});
