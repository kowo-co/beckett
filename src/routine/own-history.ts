/**
 * Beckett — the social-media agent's own-history grounding sources (`src/routine/own-history.ts`)
 * =======================================================================================
 * The "Beckett's own real history" half of the mandatory grounding step (real-sources ticket,
 * Half 1): real excerpts from the run ledger (`../dispatch/events.ts`'s `dispatch.jsonl`), the
 * deploy/uptime ledger (`../uptime.ts`), and the ticket journal (`../progress/journal.ts`) — so a
 * "deploy that ate itself" post is only ever backed by a deploy that actually ate itself, never a
 * plausible-sounding one. Every reader here degrades to an empty list on a missing/corrupt file
 * rather than throwing — a fresh install (or a history-free week) has nothing to report, and that
 * is not an error.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readDispatchEvents, type DispatchOutcome } from "../dispatch/events.ts";
import { readLifecycleLedger, readUptime } from "../uptime.ts";
import { readJournal } from "../progress/journal.ts";

export interface OwnHistoryItem {
  id: string;
  summary: string;
  at: string;
  source: "run ledger" | "uptime ledger" | "journal";
}

/** How far back an incident is still fair game to reference — recent enough to still be real news. */
const OWN_HISTORY_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** Outcomes worth surfacing as a real incident — a clean pass is not a story. */
const NOTABLE_OUTCOMES: ReadonlySet<DispatchOutcome> = new Set(["failed", "bounced", "interrupted", "held"]);

function withinAge(at: string, now: Date, maxAgeMs: number): boolean {
  const ts = Date.parse(at);
  return Number.isFinite(ts) && now.getTime() - ts <= maxAgeMs && now.getTime() - ts >= -60_000;
}

/** Recent notable rows off the run ledger — the "denial you got hit with" material. */
export function recentRunIncidents(
  dispatchEventsPath: string,
  now: Date,
  maxAgeMs: number = OWN_HISTORY_MAX_AGE_MS,
): OwnHistoryItem[] {
  let events: ReturnType<typeof readDispatchEvents>;
  try {
    events = readDispatchEvents(dispatchEventsPath);
  } catch {
    return [];
  }
  return events
    .filter((e) => NOTABLE_OUTCOMES.has(e.outcome) && withinAge(e.ts, now, maxAgeMs))
    .map((e) => ({
      id: `run-${e.runId}-${e.ts}`,
      summary: `${e.runRef} · ${e.stage} · ${e.outcome}${e.error ? ` — ${e.error}` : e.message ? ` — ${e.message}` : ""}`,
      at: e.ts,
      source: "run ledger" as const,
    }));
}

/** Recent downtime / unclean-restart facts off the deploy/uptime ledger. */
export function recentUptimeIncidents(
  uptimeLedgerPath: string,
  now: Date,
  maxAgeMs: number = OWN_HISTORY_MAX_AGE_MS,
): OwnHistoryItem[] {
  let events: ReturnType<typeof readLifecycleLedger>;
  try {
    events = readLifecycleLedger(uptimeLedgerPath);
  } catch {
    events = [];
  }
  const items: OwnHistoryItem[] = [];
  for (const event of events) {
    if (event.kind !== "unclean_restart" || !withinAge(event.at, now, maxAgeMs)) continue;
    items.push({
      id: `uptime-restart-${event.at}`,
      summary: `the daemon restarted unclean (crashed and came back) at ${event.at}`,
      at: event.at,
      source: "uptime ledger",
    });
  }
  let snapshot: ReturnType<typeof readUptime>;
  try {
    snapshot = readUptime(uptimeLedgerPath, now.getTime());
  } catch {
    return items;
  }
  for (const w of snapshot.downtimeWindows) {
    if (!withinAge(w.bootAt, now, maxAgeMs)) continue;
    items.push({
      id: `uptime-window-${w.bootAt}`,
      summary: `down from ${w.shutdownAt} to ${w.bootAt} (${Math.round(w.durationMs / 60_000)}m)`,
      at: w.bootAt,
      source: "uptime ledger",
    });
  }
  return items;
}

/** A regex-detected "notable" journal line: a failure mark, a warning mark, or a hook denial. */
const NOTABLE_LINE = /[✗⚠]|hook (?:deny|denied|block|blocked)/i;
/** A journal line is `${ISO stamp} ${rest}` — split those back out. */
const JOURNAL_LINE = /^(\S+)\s+(.*)$/;

/** A handful of recently-touched tickets' journals, scanned for one notable line each. */
export function recentJournalHighlights(
  journalDir: string,
  now: Date,
  opts: { maxFiles?: number; maxAgeMs?: number } = {},
): OwnHistoryItem[] {
  const maxFiles = opts.maxFiles ?? 5;
  const maxAgeMs = opts.maxAgeMs ?? OWN_HISTORY_MAX_AGE_MS;
  let names: string[];
  try {
    names = readdirSync(journalDir);
  } catch {
    return [];
  }
  const files = names
    .filter((name) => name.endsWith(".log"))
    .map((name) => {
      const path = join(journalDir, name);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        // a concurrent append/rotate raced this read — treat as oldest, it'll sort last
      }
      return { ticket: name.replace(/\.log$/, ""), mtimeMs };
    })
    .filter((f) => now.getTime() - f.mtimeMs <= maxAgeMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxFiles);

  const items: OwnHistoryItem[] = [];
  for (const file of files) {
    const tail = readJournal(journalDir, file.ticket, 200);
    if (!tail) continue;
    const notable = tail.split("\n").find((line) => NOTABLE_LINE.test(line));
    if (!notable) continue;
    const m = notable.match(JOURNAL_LINE);
    const at = m && Number.isFinite(Date.parse(m[1]!)) ? m[1]! : new Date(file.mtimeMs).toISOString();
    const rest = m ? m[2]! : notable.trim();
    items.push({ id: `journal-${file.ticket}`, summary: `${file.ticket}: ${rest}`, at, source: "journal" });
  }
  return items;
}

export interface OwnHistoryPaths {
  dispatchEventsPath: string;
  uptimeLedgerPath: string;
  journalDir: string;
}

/** All three real sources, combined and time-sorted newest first. */
export function gatherOwnHistory(
  paths: OwnHistoryPaths,
  now: Date,
  maxAgeMs: number = OWN_HISTORY_MAX_AGE_MS,
): OwnHistoryItem[] {
  const items = [
    ...recentRunIncidents(paths.dispatchEventsPath, now, maxAgeMs),
    ...recentUptimeIncidents(paths.uptimeLedgerPath, now, maxAgeMs),
    ...recentJournalHighlights(paths.journalDir, now, { maxAgeMs }),
  ];
  return items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
