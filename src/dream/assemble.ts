/**
 * Beckett — dream input assembly (`src/dream/assemble.ts`)
 * =======================================================================================
 * The READ-ONLY half of the dream pass (issue #36): gather the last 24 hours of Beckett's own
 * day — worker journals, ticket state transitions, the open-loop ledger, calibration/veto
 * records, and stored GUILD channel windows — into one in-memory document the reflection model
 * reads. Nothing here writes, and nothing here opens a DM:
 *
 *   - **DM windows are never read.** The gate is in code, not doctrine: a channel is included
 *     only when its recorded meta names a guild (`meta.guildId` non-null). A DM channel (null
 *     guildId) — or any channel with no recorded meta at all — is skipped before its window is
 *     even loaded. `visibility.test`-style proof lives in `assemble.test.ts`.
 *   - Loop/calibration reads go through the same fail-closed `canView` audience gating every
 *     other reader uses, as `SELF_AUDIENCE` — which excludes dm-scoped facts by construction.
 *   - Every included source contributes a stable source id (`journal:#31`, `loop:x`, …). The
 *     run validates each dream memory's provenance against this list, so an inference can only
 *     ever cite sources that were actually on the table tonight.
 *   - Sections are CAPPED (newest kept) with honest notes about what was elided — gentle on
 *     the model's context the same way the write side is gentle on the disk.
 *
 * Calibration is a sibling ticket that may not have merged on a given install; its read is
 * wrapped so absence degrades to an honest note, never a crash.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../types.ts";
import { readDispatchEvents } from "../dispatch/events.ts";
import { listLoops } from "../memory/loops.ts";
import { listCalibration } from "../memory/calibration.ts";
import { SELF_AUDIENCE } from "../memory/search.ts";
import type { MemoryStore } from "../memory/index.ts";
import { renderEntryLine, type ChannelContextStore } from "../concierge/channel-context.ts";

/** The replay window: the last 24 hours before the fire. */
export const DREAM_WINDOW_MS = 24 * 60 * 60_000;

// Per-section caps — newest lines win, elisions are noted. Bounds the synthesis prompt without
// pretending the day was smaller than it was.
const JOURNAL_LINES_PER_TICKET = 60;
const JOURNAL_MAX_TICKETS = 20;
const TRANSITIONS_MAX = 120;
const CHANNEL_ENTRIES_MAX = 40;
const CHANNELS_MAX = 10;

export interface DreamSourceSection {
  key: "journals" | "transitions" | "loops" | "calibration" | "channels";
  title: string;
  /** Stable ids of the concrete sources this section drew from (provenance vocabulary). */
  sourceIds: string[];
  /** Rendered, capped text. Empty string = nothing in the window. */
  text: string;
}

export interface DreamInputs {
  fromIso: string;
  toIso: string;
  sections: DreamSourceSection[];
  /** The full provenance vocabulary — union of every section's sourceIds. */
  sourceIds: string[];
  /** Honest caveats: what was capped, missing, or unreadable. */
  notes: string[];
  /** True when every section came back empty — the quiet-day short-circuit. */
  empty: boolean;
}

export interface AssembleDreamDeps {
  /** `<beckettDir>/journal` — per-ticket worker journals. */
  journalDir: string;
  /** `<eventsDir>/dispatch.jsonl` — the ticket state-transition ledger (OPS-167). */
  dispatchEventsPath: string;
  /** The memory graph for loops + calibration; null degrades both to notes. */
  memory: MemoryStore | null;
  /** The stored channel windows; null degrades the channel section to a note. */
  channels: ChannelContextStore | null;
  logger: Logger;
  now?: () => Date;
}

/** Gather the last 24h, read-only. Never throws — a broken source becomes a note. */
export function assembleDreamInputs(deps: AssembleDreamDeps): DreamInputs {
  const now = deps.now?.() ?? new Date();
  const cutoff = now.getTime() - DREAM_WINDOW_MS;
  const notes: string[] = [];
  const sections: DreamSourceSection[] = [
    journalsSection(deps, cutoff, notes),
    transitionsSection(deps, cutoff, notes),
    loopsSection(deps, notes),
    calibrationSection(deps, cutoff, notes),
    channelsSection(deps, cutoff, notes),
  ];
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

// ── worker journals ────────────────────────────────────────────────────────────────────

function journalsSection(deps: AssembleDreamDeps, cutoff: number, notes: string[]): DreamSourceSection {
  const section: DreamSourceSection = { key: "journals", title: "worker journals", sourceIds: [], text: "" };
  try {
    if (!existsSync(deps.journalDir)) return section;
    const files = readdirSync(deps.journalDir).filter((f) => f.endsWith(".log"));
    // Cheap pre-filter: a journal untouched since the cutoff has no lines in the window.
    const fresh = files
      .map((f) => ({ f, mtime: statMtime(join(deps.journalDir, f)) }))
      .filter((x) => x.mtime >= cutoff)
      .sort((a, b) => b.mtime - a.mtime);
    if (fresh.length > JOURNAL_MAX_TICKETS) {
      notes.push(`journals: ${fresh.length - JOURNAL_MAX_TICKETS} less-recent ticket journals elided`);
    }
    const parts: string[] = [];
    for (const { f } of fresh.slice(0, JOURNAL_MAX_TICKETS)) {
      const ticket = f.replace(/\.log$/, "");
      const lines = readFileSync(join(deps.journalDir, f), "utf8")
        .split("\n")
        .filter((l) => tsOf(l) >= cutoff);
      if (!lines.length) continue;
      const tail = lines.slice(-JOURNAL_LINES_PER_TICKET);
      const elided = lines.length - tail.length;
      section.sourceIds.push(`journal:${ticket}`);
      parts.push(
        `### journal:${ticket}${elided > 0 ? ` (… ${elided} earlier lines elided)` : ""}\n${tail.join("\n")}`,
      );
    }
    section.text = parts.join("\n\n");
  } catch (err) {
    notes.push(`journals unreadable: ${String(err)}`);
  }
  return section;
}

// ── ticket state transitions ───────────────────────────────────────────────────────────

function transitionsSection(deps: AssembleDreamDeps, cutoff: number, notes: string[]): DreamSourceSection {
  const section: DreamSourceSection = { key: "transitions", title: "ticket state transitions", sourceIds: [], text: "" };
  try {
    const rows = readDispatchEvents(deps.dispatchEventsPath).filter(
      (r) => Date.parse(r.ts) >= cutoff && (r.stage.startsWith("state:") || r.outcome === "failed"),
    );
    const kept = rows.slice(-TRANSITIONS_MAX);
    if (rows.length > kept.length) notes.push(`transitions: ${rows.length - kept.length} older rows elided`);
    const ids = new Set<string>();
    const lines = kept.map((r) => {
      ids.add(`run:${r.runRef}`);
      const detail = r.error ?? r.message ?? "";
      return `${r.ts.slice(0, 16)} ${r.runRef} ${r.stage} ${r.outcome}${detail ? ` — ${detail}` : ""}`;
    });
    section.sourceIds = [...ids];
    section.text = lines.join("\n");
  } catch (err) {
    notes.push(`ticket transitions unreadable: ${String(err)}`);
  }
  return section;
}

// ── the open-loop ledger ───────────────────────────────────────────────────────────────

function loopsSection(deps: AssembleDreamDeps, notes: string[]): DreamSourceSection {
  const section: DreamSourceSection = { key: "loops", title: "open-loop ledger", sourceIds: [], text: "" };
  if (!deps.memory) {
    notes.push("loops: no memory store available");
    return section;
  }
  try {
    // The whole standing ledger, not just tonight's — the ask is explicitly "whether any two
    // open loops combine". SELF_AUDIENCE keeps dm-scoped loops out by construction.
    const loops = listLoops(deps.memory, { all: false, audience: SELF_AUDIENCE });
    section.sourceIds = loops.map((l) => `loop:${l.node.name}`);
    section.text = loops
      .map(
        (l) =>
          `- loop:${l.node.name} ${l.overdue ? "OVERDUE " : ""}${l.due} [${l.kind}] (${l.lastTouched ? `touched ${l.lastTouched}` : "never touched"}) ${l.node.description} — closes when: ${l.closes}`,
      )
      .join("\n");
  } catch (err) {
    notes.push(`loops unreadable: ${String(err)}`);
  }
  return section;
}

// ── calibration / veto records ─────────────────────────────────────────────────────────

function calibrationSection(deps: AssembleDreamDeps, cutoff: number, notes: string[]): DreamSourceSection {
  const section: DreamSourceSection = { key: "calibration", title: "calibration (vetoes/hits)", sourceIds: [], text: "" };
  if (!deps.memory) {
    notes.push("calibration: no memory store available");
    return section;
  }
  try {
    const cutoffDate = new Date(cutoff).toISOString().slice(0, 10);
    const records = listCalibration(deps.memory, { audience: SELF_AUDIENCE }).filter(
      (r) => r.observed >= cutoffDate,
    );
    section.sourceIds = records.map((r) => `calibration:${r.node.name}`);
    section.text = records
      .map((r) => `- calibration:${r.node.name} [${r.kind}] ${r.observed} in ${r.channel} re ${r.about} — "${r.reason}"`)
      .join("\n");
  } catch (err) {
    // The calibration ledger lands on a sibling ticket; degrade gracefully wherever it isn't.
    notes.push(`calibration unavailable: ${String(err)}`);
  }
  return section;
}

// ── stored guild channel windows (NEVER DMs) ───────────────────────────────────────────

function channelsSection(deps: AssembleDreamDeps, cutoff: number, notes: string[]): DreamSourceSection {
  const section: DreamSourceSection = { key: "channels", title: "guild channel windows", sourceIds: [], text: "" };
  if (!deps.channels) {
    notes.push("channels: no channel store available");
    return section;
  }
  try {
    const parts: Array<{ id: string; name: string | null; lastTs: number; lines: string[] }> = [];
    for (const info of deps.channels.listChannels()) {
      // THE DM gate (in code, fail-closed): only a channel whose recorded meta names a guild is
      // read. Null guildId marks a DM; missing meta is treated as private by default. The
      // window itself is not even loaded for excluded channels.
      const meta = deps.channels.getMeta(info.channelId);
      if (!meta || meta.guildId === null) continue;
      const recent = deps.channels.recent(info.channelId).filter((e) => e.ts >= cutoff);
      if (!recent.length) continue;
      const tail = recent.slice(-CHANNEL_ENTRIES_MAX);
      const lines = tail.map((e) => renderEntryLine(e, { withDate: true }));
      if (recent.length > tail.length) lines.unshift(`(… ${recent.length - tail.length} earlier messages elided)`);
      parts.push({ id: info.channelId, name: meta.name, lastTs: tail[tail.length - 1]!.ts, lines });
    }
    parts.sort((a, b) => b.lastTs - a.lastTs);
    if (parts.length > CHANNELS_MAX) notes.push(`channels: ${parts.length - CHANNELS_MAX} quieter channels elided`);
    const kept = parts.slice(0, CHANNELS_MAX);
    section.sourceIds = kept.map((p) => `channel:${p.id}`);
    section.text = kept
      .map((p) => `### channel:${p.id}${p.name ? ` (#${p.name})` : ""}\n${p.lines.join("\n")}`)
      .join("\n\n");
  } catch (err) {
    notes.push(`channels unreadable: ${String(err)}`);
  }
  return section;
}

// ── small helpers ──────────────────────────────────────────────────────────────────────

function statMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** Epoch ms of a journal line's leading ISO stamp, or 0 for anything unstamped. */
function tsOf(line: string): number {
  const m = line.match(/^(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\s/);
  return m ? Date.parse(m[1]!) : 0;
}
