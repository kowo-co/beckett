/**
 * Beckett — dream input assembly (`src/dream/assemble.ts`)
 * =======================================================================================
 * The READ-ONLY half of the dream pass: gather the day's logs — plural — into one in-memory
 * document the reflection model reads. Nothing here writes.
 *
 * THREE durable sources, each with its own provenance prefix, none of them privileged over the
 * others:
 *
 *   1. `channel:<channelId>:<messageId>` — the attributed per-channel conversation windows kept
 *      by {@link ../concierge/channel-context.ts} (`<beckettDir>/channels`, one JSONL per Discord
 *      channel, written every turn, survives restarts). This is REAL conversation: what people
 *      said to Beckett and what Beckett said back.
 *   2. `journal:<ticket>:<line>` — per-ticket worker journals (`<beckettDir>/journal/<t>.log`,
 *      issue #31): the play-by-play of what the fleet actually did today — stages, tool calls,
 *      file changes, failures, verdicts.
 *   3. `dispatch:<runId>:<n>` — the dispatch event ledger (`<eventsDir>/dispatch.jsonl`,
 *      {@link ../dispatch/events.ts}): the run-level timeline of what started, passed, bounced,
 *      or failed.
 *
 * Sources 2 and 3 shipped as "follow-ups, not read" on day one; they are read now. Provenance is
 * preserved PER SOURCE — a memory derived from a worker journal cites a journal line, not a
 * conversation — so a human reading a dream node can always go find the literal line it came
 * from, and the run's validation (`planDreamMemories`) still refuses any id that was not
 * assembled tonight, whichever source it claims to come from.
 *
 * DM windows are never read. The gate is in code, not doctrine: a channel is included only when
 * its recorded meta names a guild (`meta.guildId` non-null). A DM channel (null guildId) — or
 * any channel with no recorded meta at all — is skipped before its window is even loaded. The
 * two new sources have no DM analogue: a worker journal and the dispatch ledger are records of
 * Beckett's own machine, never of somebody's private conversation.
 *
 * Sections are CAPPED (newest kept, per source and across sources) with honest notes about what
 * was elided — gentle on the model's context the same way the write side is gentle on disk.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Logger } from "../types.ts";
import type { ChannelContextStore, ChannelEntry } from "../concierge/channel-context.ts";
import { readDispatchEvents } from "../dispatch/events.ts";

/** Most recently-active channels included in one pass. Quieter channels are elided, not dropped. */
const CHANNELS_MAX = 12;
/** Most recent messages kept per channel. Older-in-window messages are elided, not dropped. */
const CHANNEL_ENTRIES_MAX = 80;
/** Most recently-touched worker journals included in one pass. */
const JOURNALS_MAX = 8;
/** Most recent journal lines kept per ticket. A single run can write thousands. */
const JOURNAL_LINES_MAX = 60;
/** Most recent runs whose dispatch rows are included. */
const DISPATCH_RUNS_MAX = 12;
/** Most recent ledger rows kept per run. */
const DISPATCH_ROWS_MAX = 30;

/** Which log a section came out of — the prefix of every source id it contributes. */
export type DreamSourceKind = "channel" | "journal" | "dispatch";

/** One source's window, rendered for the model, plus its line-granular provenance. */
export interface DreamSection {
  kind: DreamSourceKind;
  /** The id inside the kind: a Discord channel id, a ticket identifier, or a run id. */
  channelId: string;
  /** A human label when one exists (a channel's `#name`); null when the id is the whole name. */
  channelName: string | null;
  /** `<kind>:<id>:<n>` for every line actually rendered into `text`. */
  sourceIds: string[];
  text: string;
}

export interface DreamInputs {
  fromIso: string;
  toIso: string;
  sections: DreamSection[];
  /** The full provenance vocabulary — union of every section's sourceIds. */
  sourceIds: string[];
  /** Honest caveats: what was capped, missing, or unreadable. */
  notes: string[];
  /** True when there was nothing in the window — the quiet-day short-circuit. */
  empty: boolean;
}

export interface AssembleDreamDeps {
  /** The channel-context store; null degrades to no conversation sections. */
  channels: ChannelContextStore | null;
  /** `<beckettDir>/journal` — per-ticket worker journals. Null/absent = the source is skipped. */
  journalDir?: string | null;
  /** `<eventsDir>/dispatch.jsonl` — the run event ledger. Null/absent = the source is skipped. */
  dispatchLedger?: string | null;
  /** How far back "the day" reaches, in hours. */
  windowHours: number;
  logger: Logger;
  now?: () => Date;
}

/** `channel:<channelId>:<messageId>` — the conversation half of the provenance vocabulary. */
export function channelSourceId(channelId: string, messageId: string): string {
  return `channel:${channelId}:${messageId}`;
}

/** `journal:<ticket>:<line>` — the worker-journal half. `line` is 1-based within the file. */
export function journalSourceId(ticket: string, line: number): string {
  return `journal:${ticket}:${line}`;
}

/** `dispatch:<runId>:<n>` — the ledger half. `n` is 1-based within that run's rows in-window. */
export function dispatchSourceId(runId: string, index: number): string {
  return `dispatch:${runId}:${index}`;
}

/** Gather the day's logs, read-only. Never throws — a broken source becomes a note. */
export function assembleDreamInputs(deps: AssembleDreamDeps): DreamInputs {
  const now = deps.now?.() ?? new Date();
  const cutoff = now.getTime() - Math.max(1, deps.windowHours) * 60 * 60_000;
  const notes: string[] = [];
  const sections: DreamSection[] = [];

  if (deps.channels) sections.push(...sessionSections(deps.channels, cutoff, notes));
  else notes.push("sessions: no channel store available");

  if (deps.journalDir) sections.push(...journalSections(deps.journalDir, cutoff, notes));
  if (deps.dispatchLedger) sections.push(...dispatchSections(deps.dispatchLedger, cutoff, notes));

  const sourceIds = [...new Set(sections.flatMap((s) => s.sourceIds))];
  return {
    fromIso: new Date(cutoff).toISOString(),
    toIso: now.toISOString(),
    sections,
    sourceIds,
    notes,
    empty: sections.every((s) => !s.text.trim()),
  };
}

// ── source 1: the day's conversations ──────────────────────────────────────────────────

function sessionSections(
  channels: ChannelContextStore,
  cutoff: number,
  notes: string[],
): DreamSection[] {
  try {
    const parts: Array<{ channelId: string; name: string | null; lastTs: number; entries: ChannelEntry[] }> = [];
    for (const info of channels.listChannels()) {
      // THE DM gate (in code, fail-closed): only a channel whose recorded meta names a guild is
      // read. Null guildId marks a DM; missing meta is treated as private by default. The
      // window itself is not even loaded for an excluded channel.
      const meta = channels.getMeta(info.channelId);
      if (!meta || meta.guildId === null) continue;
      const inWindow = channels.recent(info.channelId).filter((e) => e.ts >= cutoff);
      if (!inWindow.length) continue;
      parts.push({ channelId: info.channelId, name: meta.name, lastTs: inWindow[inWindow.length - 1]!.ts, entries: inWindow });
    }
    parts.sort((a, b) => b.lastTs - a.lastTs);
    if (parts.length > CHANNELS_MAX) {
      notes.push(`sessions: ${parts.length - CHANNELS_MAX} quieter channels elided`);
    }
    return parts.slice(0, CHANNELS_MAX).map((p) => renderChannelSection(p, notes));
  } catch (err) {
    notes.push(`sessions unreadable: ${String(err)}`);
    return [];
  }
}

function renderChannelSection(
  part: { channelId: string; name: string | null; entries: ChannelEntry[] },
  notes: string[],
): DreamSection {
  const tail = part.entries.slice(-CHANNEL_ENTRIES_MAX);
  const elided = part.entries.length - tail.length;
  if (elided > 0) notes.push(`sessions: channel:${part.channelId} elided ${elided} earlier messages`);
  const lines = tail.map((e) => renderSessionLine(part.channelId, e));
  return {
    kind: "channel",
    channelId: part.channelId,
    channelName: part.name ? `#${part.name}` : null,
    sourceIds: tail.map((e) => channelSourceId(part.channelId, e.messageId)),
    text: lines.join("\n"),
  };
}

/** One transcript line, message id first so it doubles as a provenance lookup key. */
function renderSessionLine(channelId: string, e: ChannelEntry): string {
  const stamp = isoStamp(new Date(e.ts).toISOString());
  const who = e.kind === "beckett" ? "beckett" : `${e.authorName} (user:${e.authorId})`;
  return `[${channelSourceId(channelId, e.messageId)}] ${stamp} ${who}: ${e.content.replace(/\r?\n/g, "\n    ")}`;
}

// ── source 2: the day's worker journals ────────────────────────────────────────────────

/**
 * One section per ticket whose journal was touched inside the window. A journal line is
 * `<ISO timestamp> <text>`; the timestamp is what puts a line in or out of the window, and the
 * line's 1-BASED POSITION IN THE FILE is its provenance id — stable for an append-only log, and
 * exactly what `sed -n '<n>p'` needs to show a human the literal line a memory came from.
 */
function journalSections(dir: string, cutoff: number, notes: string[]): DreamSection[] {
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".log"));
  } catch (err) {
    notes.push(`journals unreadable: ${String(err)}`);
    return [];
  }
  const parts: Array<{ ticket: string; lastTs: number; lines: Array<{ n: number; ts: number; text: string }> }> = [];
  for (const file of files) {
    const ticket = basename(file, ".log");
    try {
      // A journal that has not been touched since the cutoff cannot contribute a line.
      if (statSync(join(dir, file)).mtimeMs < cutoff) continue;
      const inWindow: Array<{ n: number; ts: number; text: string }> = [];
      const raw = readFileSync(join(dir, file), "utf8").split("\n");
      for (const [i, line] of raw.entries()) {
        if (!line.trim()) continue;
        const space = line.indexOf(" ");
        if (space <= 0) continue;
        const ts = Date.parse(line.slice(0, space));
        if (!Number.isFinite(ts) || ts < cutoff) continue;
        inWindow.push({ n: i + 1, ts, text: line.slice(space + 1) });
      }
      if (!inWindow.length) continue;
      parts.push({ ticket, lastTs: inWindow[inWindow.length - 1]!.ts, lines: inWindow });
    } catch (err) {
      notes.push(`journals: ${ticket} unreadable: ${String(err)}`);
    }
  }
  parts.sort((a, b) => b.lastTs - a.lastTs);
  if (parts.length > JOURNALS_MAX) notes.push(`journals: ${parts.length - JOURNALS_MAX} quieter tickets elided`);
  return parts.slice(0, JOURNALS_MAX).map((p) => {
    const tail = p.lines.slice(-JOURNAL_LINES_MAX);
    const elided = p.lines.length - tail.length;
    if (elided > 0) notes.push(`journals: ${p.ticket} elided ${elided} earlier lines`);
    return {
      kind: "journal" as const,
      channelId: p.ticket,
      channelName: null,
      sourceIds: tail.map((l) => journalSourceId(p.ticket, l.n)),
      text: tail
        .map((l) => `[${journalSourceId(p.ticket, l.n)}] ${isoStamp(new Date(l.ts).toISOString())} ${l.text}`)
        .join("\n"),
    };
  });
}

// ── source 3: the dispatch event ledger ────────────────────────────────────────────────

/**
 * One section per run with rows inside the window. The id's `n` is the row's 1-based position
 * among THAT RUN's in-window rows — a run-local counter rather than a file offset, because the
 * ledger is one shared append-only file across every run and a global offset would say nothing
 * useful to a human reading a dream node's provenance.
 */
function dispatchSections(path: string, cutoff: number, notes: string[]): DreamSection[] {
  let rows: ReturnType<typeof readDispatchEvents>;
  try {
    rows = readDispatchEvents(path);
  } catch (err) {
    notes.push(`dispatch ledger unreadable: ${String(err)}`);
    return [];
  }
  const byRun = new Map<string, Array<{ n: number; ts: number; text: string }>>();
  const lastTs = new Map<string, number>();
  for (const row of rows) {
    const ts = Date.parse(row.ts);
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    const list = byRun.get(row.runId) ?? [];
    const detail = row.error ?? row.message ?? "";
    list.push({
      n: list.length + 1,
      ts,
      text: `${row.runRef} · ${row.stage} · ${row.outcome}${detail ? ` — ${detail.replace(/\s+/g, " ").trim().slice(0, 300)}` : ""}`,
    });
    byRun.set(row.runId, list);
    lastTs.set(row.runId, ts);
  }
  const runs = [...byRun.keys()].sort((a, b) => (lastTs.get(b) ?? 0) - (lastTs.get(a) ?? 0));
  if (runs.length > DISPATCH_RUNS_MAX) notes.push(`dispatch: ${runs.length - DISPATCH_RUNS_MAX} older runs elided`);
  return runs.slice(0, DISPATCH_RUNS_MAX).map((runId) => {
    const all = byRun.get(runId)!;
    const tail = all.slice(-DISPATCH_ROWS_MAX);
    const elided = all.length - tail.length;
    if (elided > 0) notes.push(`dispatch: ${runId} elided ${elided} earlier rows`);
    return {
      kind: "dispatch" as const,
      channelId: runId,
      channelName: null,
      sourceIds: tail.map((r) => dispatchSourceId(runId, r.n)),
      text: tail
        .map((r) => `[${dispatchSourceId(runId, r.n)}] ${isoStamp(new Date(r.ts).toISOString())} ${r.text}`)
        .join("\n"),
    };
  });
}

/** "YYYY-MM-DD HH:MM" from an ISO instant — the one stamp shape every source line shares. */
function isoStamp(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}
