/**
 * Beckett — nightly self-repair error surfaces (`src/self-repair/sources.ts`)
 * =======================================================================================
 * The pass reads where errors actually land on this box. Each collector degrades to empty on a
 * missing or corrupt file — a fresh install has nothing to report, and that is not an error.
 *
 * Surfaces, and why they are here:
 *
 *   - `<beckettDir>/journal/*.log` — the private per-run worker firehose. Failures, hook
 *     denials, and `⚠` lines are the only ones that name a defect; successes are noise.
 *   - `<beckettDir>/events/dispatch.jsonl` — the durable run/deploy stage ledger. `failed` /
 *     `bounced` rows carry the error the supervisor already classified.
 *   - `<beckettDir>/uptime.jsonl` — daemon lifecycle. An `unclean_restart` is the daemon
 *     crashing and coming back; a clean boot is not a defect.
 *   - `<beckettDir>/logs/**` — prettified per-worker logs when present. JSON lines at
 *     `error`/`warn` from the structured logger.
 *   - `journalctl --user -u beckett.service` — stderr the systemd user unit captured. Optional
 *     and best-effort: a box without the unit, or without journalctl, contributes nothing.
 *
 * We do not read Discord, memory, or dream journals. Those are not error surfaces.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readDispatchEvents } from "../dispatch/events.ts";
import type { Paths } from "../types.ts";
import { readLifecycleLedger, uptimeLedgerPath } from "../uptime.ts";
import { extractSite, type ErrorEvent } from "./cluster.ts";

export interface CollectErrorOptions {
  now?: Date;
  lookbackMs?: number;
  /** Injectable journalctl reader. Default: the systemd user unit, best-effort. */
  readJournalctl?: (sinceIso: string) => Promise<string[]>;
  /** Cap bytes read per log/journal file so a huge file cannot stall the pass. */
  maxFileBytes?: number;
}

const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
/** Fail lines the journal actually writes — not a worker's own grep for the word "fail". */
const JOURNAL_FAIL = /^(?:⚠|✗| {0,2}! \S+ errored| {0,2}x hook )/i;

export async function collectErrorEvents(paths: Paths, opts: CollectErrorOptions = {}): Promise<ErrorEvent[]> {
  const now = opts.now ?? new Date();
  const lookbackMs = opts.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const since = now.getTime() - lookbackMs;
  const events: ErrorEvent[] = [];

  events.push(...fromJournals(paths.journalDir, since, now.getTime(), maxFileBytes));
  events.push(...fromDispatch(join(paths.eventsDir, "dispatch.jsonl"), since, now.getTime()));
  events.push(...fromUptime(uptimeLedgerPath(paths.beckettDir), since, now.getTime()));
  events.push(...fromLogsDir(paths.logsDir, since, now.getTime(), maxFileBytes));

  const sinceIso = new Date(since).toISOString();
  const journalctl = opts.readJournalctl ?? defaultJournalctl;
  try {
    const lines = await journalctl(sinceIso);
    for (const line of lines) {
      const parsed = parseJournalctlLine(line);
      if (parsed && inWindow(parsed.at, since, now.getTime())) events.push(parsed);
    }
  } catch {
    // A missing unit or a journalctl that is not installed is not a defect of the pass.
  }

  return events;
}

function inWindow(at: string, since: number, until: number): boolean {
  const ts = Date.parse(at);
  return Number.isFinite(ts) && ts >= since && ts <= until + 60_000;
}

function fromJournals(dir: string, since: number, until: number, maxBytes: number): ErrorEvent[] {
  const out: ErrorEvent[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".log")) continue;
    const ticket = name.replace(/\.log$/, "");
    for (const line of readTail(join(dir, name), maxBytes)) {
      const m = line.match(/^(\S+)\s+(.*)$/);
      if (!m) continue;
      const [, at, rest] = m;
      if (!rest || !JOURNAL_FAIL.test(rest) || !inWindow(at!, since, until)) continue;
      out.push({
        at: at!,
        source: `journal:${ticket}`,
        message: rest,
        site: extractSite(rest),
      });
    }
  }
  return out;
}

function fromDispatch(path: string, since: number, until: number): ErrorEvent[] {
  let rows: ReturnType<typeof readDispatchEvents>;
  try {
    rows = readDispatchEvents(path);
  } catch {
    return [];
  }
  const notable = new Set(["failed", "bounced"]);
  const out: ErrorEvent[] = [];
  for (const row of rows) {
    if (!notable.has(row.outcome) || !inWindow(row.ts, since, until)) continue;
    const message = (row.error || row.message || `${row.stage} ${row.outcome}`).trim();
    if (!message) continue;
    out.push({
      at: row.ts,
      source: `dispatch:${row.runRef}`,
      message,
      site: extractSite(message),
    });
  }
  return out;
}

function fromUptime(path: string, since: number, until: number): ErrorEvent[] {
  let rows: ReturnType<typeof readLifecycleLedger>;
  try {
    rows = readLifecycleLedger(path);
  } catch {
    return [];
  }
  const out: ErrorEvent[] = [];
  for (const row of rows) {
    if (row.kind !== "unclean_restart" || !inWindow(row.at, since, until)) continue;
    out.push({
      at: row.at,
      source: "uptime",
      message: "daemon unclean restart (crashed and came back)",
      site: null,
    });
  }
  return out;
}

function fromLogsDir(dir: string, since: number, until: number, maxBytes: number): ErrorEvent[] {
  const out: ErrorEvent[] = [];
  const files: string[] = [];
  walkLogs(dir, files, 0);
  for (const file of files) {
    for (const line of readTail(file, maxBytes)) {
      const parsed = parseLogLine(line, file);
      if (parsed && inWindow(parsed.at, since, until)) out.push(parsed);
    }
  }
  return out;
}

function walkLogs(dir: string, out: string[], depth: number): void {
  if (depth > 4) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkLogs(path, out, depth + 1);
    else if (name.endsWith(".log") || name.endsWith(".jsonl")) out.push(path);
  }
}

function parseLogLine(line: string, file: string): ErrorEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) {
    try {
      const rec = JSON.parse(trimmed) as Record<string, unknown>;
      const level = String(rec.level ?? "");
      if (level !== "error" && level !== "warn") return null;
      const msg = String(rec.msg ?? rec.message ?? "").trim();
      if (!msg) return null;
      const at = typeof rec.ts === "string" ? rec.ts : new Date().toISOString();
      const component = typeof rec.component === "string" ? rec.component : "log";
      const err = typeof rec.error === "string" ? ` ${rec.error}` : "";
      const message = `${component}: ${msg}${err}`;
      return { at, source: `logs:${component}`, message, site: extractSite(message) };
    } catch {
      return null;
    }
  }
  if (!/error|warn|fail/i.test(trimmed)) return null;
  const m = trimmed.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(.*)$/);
  const at = m?.[1] ?? null;
  const message = m?.[2] ?? trimmed;
  if (!at) return null;
  return { at, source: `logs:${file}`, message, site: extractSite(message) };
}

function parseJournalctlLine(line: string): ErrorEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  // short-iso: `2026-08-24T07:01:02-07:00 hostname process[pid]: message`
  const m = trimmed.match(/^(\d{4}-\d{2}-\d{2}T[\d:+-]+)\s+\S+\s+\S+:\s+(.*)$/);
  if (!m) {
    if (!/error|fail|warn/i.test(trimmed)) return null;
    return {
      at: new Date().toISOString(),
      source: "journalctl",
      message: trimmed,
      site: extractSite(trimmed),
    };
  }
  const at = new Date(m[1]!).toISOString();
  if (!Number.isFinite(Date.parse(at))) return null;
  const message = m[2]!.trim();
  if (!message) return null;
  if (message.startsWith("{")) {
    const json = parseLogLine(message, "journalctl");
    if (json) return { ...json, source: "journalctl", at };
  }
  if (!/error|fail|warn|uncaught/i.test(message) && !message.startsWith("{")) {
    // Structured logger JSON on stderr is the interesting case; skip info chatter.
    return null;
  }
  return { at, source: "journalctl", message, site: extractSite(message) };
}

function readTail(path: string, maxBytes: number): string[] {
  if (!existsSync(path)) return [];
  try {
    const buf = readFileSync(path);
    const slice = buf.length > maxBytes ? buf.subarray(buf.length - maxBytes) : buf;
    const text = slice.toString("utf8");
    return text.split("\n").filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

async function defaultJournalctl(sinceIso: string): Promise<string[]> {
  try {
    const proc = Bun.spawn(
      [
        "journalctl",
        "--user",
        "-u",
        "beckett.service",
        "--since",
        sinceIso,
        "-o",
        "short-iso",
        "--no-pager",
        "-p",
        "warning",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exit !== 0) return [];
    return stdout.split("\n").filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}
