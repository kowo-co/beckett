import { afterEach, expect, test } from "bun:test";
import {
  applyDisplayTimeZoneFromConfig,
  formatDisplayDate,
  formatDisplayDateTime,
  formatDisplayTime,
} from "./time-display.ts";

afterEach(() => {
  applyDisplayTimeZoneFromConfig(undefined);
});

const PDT = Date.parse("2026-07-15T19:30:00.000Z"); // 12:30 America/Los_Angeles (PDT)
const PST = Date.parse("2026-01-15T20:30:00.000Z"); // 12:30 America/Los_Angeles (PST)
const UTC_NEXT_DAY = Date.parse("2026-07-16T06:00:00.000Z"); // 23:00 previous calendar day in PT

test("unset config resolves to America/Los_Angeles", () => {
  expect(applyDisplayTimeZoneFromConfig(undefined)).toBe("America/Los_Angeles");
  expect(applyDisplayTimeZoneFromConfig("")).toBe("America/Los_Angeles");
  expect(applyDisplayTimeZoneFromConfig("   ")).toBe("America/Los_Angeles");
  expect(formatDisplayTime(PDT)).toBe("12:30");
});

test("invalid timezone falls back instead of throwing", () => {
  expect(applyDisplayTimeZoneFromConfig("Not/AZone")).toBe("America/Los_Angeles");
  expect(applyDisplayTimeZoneFromConfig("Definitely/Fake")).toBe("America/Los_Angeles");
  expect(() => formatDisplayTime(PDT)).not.toThrow();
});

test("a known UTC instant renders PT wall-clock on both sides of DST", () => {
  expect(formatDisplayTime(PDT)).toBe("12:30");
  expect(formatDisplayTime(PST)).toBe("12:30");
  expect(formatDisplayDateTime(PDT)).toBe("2026-07-15 12:30");
  expect(formatDisplayDateTime(PST)).toBe("2026-01-15 12:30");
});

test("date form follows the display calendar day, not the UTC date", () => {
  expect(formatDisplayDate(UTC_NEXT_DAY)).toBe("2026-07-15");
  expect(new Date(UTC_NEXT_DAY).toISOString().slice(0, 10)).toBe("2026-07-16");
});

test("an explicit timezone argument overrides the daemon default", () => {
  expect(formatDisplayTime(PDT, "UTC")).toBe("19:30");
  expect(formatDisplayDateTime(PDT, "UTC")).toBe("2026-07-15 19:30");
});

test("a valid config timezone is installed for subsequent formats", () => {
  expect(applyDisplayTimeZoneFromConfig("UTC")).toBe("UTC");
  expect(formatDisplayTime(PDT)).toBe("19:30");
});
