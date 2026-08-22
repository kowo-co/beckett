/**
 * Human-facing / concierge-context clock formatting.
 *
 * Persisted timestamps (jsonl ledgers, run state, journals, event records) stay ISO/UTC.
 * Anything a person or the concierge *reads* goes through these helpers so wall-clock
 * strings match the daemon's configured display timezone (default America/Los_Angeles).
 */

import { log } from "./log.ts";

const DEFAULT_DISPLAY_TIME_ZONE = "America/Los_Angeles";

let activeTimeZone = DEFAULT_DISPLAY_TIME_ZONE;
let partsFormatter: Intl.DateTimeFormat | null = null;
let partsTimeZone: string | null = null;

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function resolveDisplayTimeZone(raw: string | undefined | null): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return DEFAULT_DISPLAY_TIME_ZONE;
  if (isValidTimeZone(trimmed)) return trimmed;
  log.child("time-display").warn("invalid display timezone; falling back", {
    timezone: trimmed,
    fallback: DEFAULT_DISPLAY_TIME_ZONE,
  });
  return DEFAULT_DISPLAY_TIME_ZONE;
}

/** Install the daemon's display timezone (called from `loadConfig`). */
export function applyDisplayTimeZoneFromConfig(raw: string | undefined | null): string {
  activeTimeZone = resolveDisplayTimeZone(raw);
  partsFormatter = null;
  partsTimeZone = null;
  return activeTimeZone;
}

function instant(input: number | Date | string): Date | null {
  const date = input instanceof Date ? input : new Date(input);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function parts(date: Date, tz: string): Record<string, string> {
  if (!partsFormatter || partsTimeZone !== tz) {
    partsFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      hour12: false,
    });
    partsTimeZone = tz;
  }
  const out: Record<string, string> = {};
  for (const part of partsFormatter.formatToParts(date)) {
    if (part.type !== "literal") out[part.type] = part.value;
  }
  return out;
}

function zone(tz?: string): string {
  return tz ?? activeTimeZone;
}

/** `HH:MM` in the display timezone. */
export function formatDisplayTime(input: number | Date | string, tz?: string): string {
  const date = instant(input);
  if (!date) return "";
  const p = parts(date, zone(tz));
  return `${p.hour}:${p.minute}`;
}

/** `YYYY-MM-DD` in the display timezone. */
export function formatDisplayDate(input: number | Date | string, tz?: string): string {
  const date = instant(input);
  if (!date) return typeof input === "string" ? input : "";
  const p = parts(date, zone(tz));
  return `${p.year}-${p.month}-${p.day}`;
}

/** `YYYY-MM-DD HH:MM` in the display timezone. */
export function formatDisplayDateTime(input: number | Date | string, tz?: string): string {
  const date = instant(input);
  if (!date) return "";
  const p = parts(date, zone(tz));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
