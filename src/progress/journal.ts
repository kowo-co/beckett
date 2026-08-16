/**
 * Beckett — the ticket journal (`src/progress/journal.ts`)
 * =======================================================================================
 * The PRIVATE destination for every worker's granular {@link WorkerEvent} firehose. This used to
 * be a user-facing Discord thread (`src/discord/progress.ts`); under the Coworker-as-a-Service
 * model the verbose play-by-play never lands in front of a human. Instead each ticket gets an
 * append-only, ticket-keyed journal file under `<beckettDir>/journal/`, and the Concierge pulls
 * it ON DEMAND (`beckett journal <ticket> --tail N`) as a separate context when someone asks how
 * the work is going — reading the detail privately and answering with a clean human summary.
 *
 * Design points:
 *  - **Fire-and-forget.** Injected into the dispatcher as the {@link ProgressSink}; a journal
 *    write failure must never disturb the work itself, so every append is best-effort and logged.
 *  - **No coalescing needed.** The old hub batched lines to stay under Discord rate limits; a
 *    local file has no such ceiling, so each event appends one timestamped line immediately and
 *    a daemon crash loses nothing buffered.
 *  - **Ticket-keyed, stage-tagged.** One file per ticket identifier; implement/review/rework
 *    workers all append to the same file, tagged by stage, so the whole lifecycle reads in order.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkerEvent, Logger } from "../types.ts";
import { log as rootLog } from "../log.ts";

/** Which worker produced an event — used to tag journal lines (implement / review / rework). */
export interface ProgressContext {
  stage: string;
  workerId: string;
}

/** The narrow sink the dispatcher wires a worker's event stream into. */
export interface ProgressSink {
  event(ticketIdent: string, ev: WorkerEvent, ctx: ProgressContext): void;
}

export interface TicketJournalOptions {
  /**
   * Directory holding one `<ticket>.log` per ticket (conventionally `<beckettDir>/journal`).
   * Omit to disable the journal (events drop silently — mirrors "persistence disabled" elsewhere).
   */
  dir?: string;
  logger?: Logger;
  /** Clock override (tests). Defaults to `Date.now`. */
  now?: () => number;
}

/** Default `--tail` window for reads: enough recent play-by-play without replaying a whole run. */
export const DEFAULT_TAIL_LINES = 200;

/**
 * Append-only, ticket-keyed store for worker progress events. Implements {@link ProgressSink}
 * (the dispatcher's side) and exposes {@link read} (the Concierge/CLI side).
 */
export class TicketJournal implements ProgressSink {
  private readonly dir?: string;
  private readonly log: Logger;
  private readonly now: () => number;
  /** Lazily created on first append so constructing a journal never touches the filesystem. */
  private dirReady = false;
  /** Per-ticket toolId → tool name, so a later `tool_result` error can name the failed tool. */
  private readonly toolNamesByTicket = new Map<string, Map<string, string>>();

  constructor(opts: TicketJournalOptions) {
    this.dir = opts.dir;
    this.log = (opts.logger ?? rootLog).child("journal");
    this.now = opts.now ?? Date.now;
  }

  /** Route one worker event into the ticket's journal file. Best-effort; never throws. */
  event(ticketIdent: string, ev: WorkerEvent, ctx: ProgressContext): void {
    const dir = this.dir;
    if (!dir) return; // journal disabled (no resolvable path)
    let toolNames = this.toolNamesByTicket.get(ticketIdent);
    if (!toolNames) {
      toolNames = new Map();
      this.toolNamesByTicket.set(ticketIdent, toolNames);
    }
    const line = formatEvent(ev, ctx, toolNames);
    if (line === null) return; // noise (partial text, turn ticks, echoes) — not worth keeping
    try {
      if (!this.dirReady) {
        mkdirSync(dir, { recursive: true });
        this.dirReady = true;
      }
      const stamp = new Date(this.now()).toISOString();
      appendFileSync(this.file(dir, ticketIdent), `${stamp} ${line}\n`, "utf8");
    } catch (err) {
      this.log.warn("journal append failed (dropped)", {
        ticket: ticketIdent,
        error: String(err),
      });
    }
    // Terminal events end the worker; drop its tool-name map so long-lived daemons don't accrue.
    if (ev.kind === "finished" || ev.kind === "error") this.toolNamesByTicket.delete(ticketIdent);
  }

  /**
   * Read the last `tail` journal lines for a ticket (the on-demand context pull). Returns null
   * when the ticket has no journal yet — the caller distinguishes "no detail recorded" from an
   * empty run.
   */
  read(ticketIdent: string, tail: number = DEFAULT_TAIL_LINES): string | null {
    if (!this.dir) return null;
    const file = this.file(this.dir, ticketIdent);
    if (!existsSync(file)) return null;
    try {
      const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);
      const window = tail > 0 ? lines.slice(-tail) : lines;
      const elided = lines.length - window.length;
      const head = elided > 0 ? [`… ${elided} earlier lines elided (--tail ${tail})`] : [];
      return [...head, ...window].join("\n");
    } catch (err) {
      this.log.warn("journal read failed", { ticket: ticketIdent, error: String(err) });
      return null;
    }
  }

  /** The journal path for a ticket, with the identifier sanitized so it can't escape the dir. */
  private file(dir: string, ticketIdent: string): string {
    return join(dir, `${safeIdent(ticketIdent)}.log`);
  }
}

/** Collapse anything path-hostile in a ticket identifier ("OPS-120" stays as-is). */
function safeIdent(ident: string): string {
  const safe = ident.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe || "unknown";
}

/** Read one ticket's journal tail without a daemon — the `beckett journal` CLI path. */
export function readJournal(dir: string, ticketIdent: string, tail: number = DEFAULT_TAIL_LINES): string | null {
  return new TicketJournal({ dir }).read(ticketIdent, tail);
}

/** Factory matching the repo's `createX` convention. */
export function createTicketJournal(opts: TicketJournalOptions): TicketJournal {
  return new TicketJournal(opts);
}

// =======================================================================================
// event → line formatting
// =======================================================================================

/** Longest tool-input hint we inline before truncating (keeps each line compact). */
const HINT_MAX = 80;
/** Longest finish/error summary we inline in the journal. */
const SUMMARY_MAX = 400;

/**
 * Turn one {@link WorkerEvent} into a compact journal line, or null to drop it. We keep the
 * play-by-play someone reconstructing a run would want — stage boundaries, tool calls, file edits,
 * scope-guard blocks, plan ticks, failures, and the verdict — and drop pure noise (streaming text,
 * per-turn ticks, user echoes, tool_result successes that just mirror the preceding call).
 * `toolNames` (when present) lets a `tool_result` error name the tool that failed.
 */
export function formatEvent(
  ev: WorkerEvent,
  ctx: ProgressContext,
  toolNames?: Map<string, string>,
): string | null {
  const stage = ctx.stage;
  switch (ev.kind) {
    case "session_started":
      return `▸ ${stage} worker started (${ev.model})`;
    case "tool_call": {
      if (toolNames) toolNames.set(ev.toolId, ev.tool);
      const hint = toolHint(ev.tool, ev.input);
      return `  · ${ev.tool}${hint ? `  ${hint}` : ""}`;
    }
    case "tool_result": {
      if (!ev.isError) return null; // successes just echo the call — skip
      const tool = toolNames?.get(ev.toolId) ?? "tool";
      return `  ! ${tool} errored`;
    }
    case "file_change": {
      if (!ev.paths.length) return null;
      const shown = ev.paths.slice(0, 4).map((p) => `${changeMark(p.kind)} ${p.path}`).join(", ");
      const more = ev.paths.length > 4 ? ` (+${ev.paths.length - 4} more)` : "";
      return `  ~ ${shown}${more}`;
    }
    case "plan_update": {
      const done = ev.items.filter((i) => i.done).length;
      return `  = plan ${done}/${ev.items.length}`;
    }
    case "hook_decision": {
      // Scope-guard blocks + other hook denials are exactly the "all the hooks listed" signal.
      const verdict = ev.decision ? String(ev.decision) : "decision";
      const reason = ev.reason ? `: ${truncate(String(ev.reason), HINT_MAX)}` : "";
      return `  x hook ${verdict}${reason}`;
    }
    case "finished": {
      const mark = ev.status === "success" ? "✓" : "✗";
      const s = summaryFromStructured(ev.structuredOutput);
      return `${mark} ${stage} ${ev.status}${s ? `: ${truncate(s, SUMMARY_MAX)}` : ""}`;
    }
    case "error":
      return `⚠ ${stage}: ${truncate(ev.message, SUMMARY_MAX)}`;
    // Deliberately silent: streaming assistant text, per-turn start/complete ticks, user echoes,
    // unknown raw lines. They're either noise or belong to the sparse main-channel feed, not here.
    default:
      return null;
  }
}

/** Pull the done-signal `summary` (the blocker's detail falls back) from a finished event's structured output. */
function summaryFromStructured(structured: unknown | null): string {
  if (!structured || typeof structured !== "object") return "";
  const o = structured as Record<string, unknown>;
  if (typeof o.summary === "string" && o.summary.trim()) return o.summary.trim();
  const blocker = o.blocker;
  if (blocker && typeof blocker === "object") {
    const detail = (blocker as Record<string, unknown>).detail;
    if (typeof detail === "string" && detail.trim()) return detail.trim();
  }
  return "";
}

/** A short, human hint for a tool call (the command, the path) — never the full input blob. */
function toolHint(tool: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const pick = (k: string): string | null => (typeof o[k] === "string" ? (o[k] as string) : null);
  const command = pick("command"); // Bash
  const path = pick("file_path") ?? pick("path"); // Read / Edit / Write / notebooks
  const raw =
    command ??
    path ??
    pick("pattern") ?? // Grep
    pick("query") ?? // search tools
    pick("url") ??
    "";
  if (!raw) return "";
  const flat = raw.replace(/\s+/g, " ").trim();
  // A path hint truncated head-first loses the ONE segment a reader (and `../run/activity.ts`'s
  // blurb) wants — the filename — because worktree paths are long and the interesting end is the
  // far end. Keep the same ceiling and the same head truncation, but always retain the basename.
  return command === null && path !== null ? truncatePath(flat, HINT_MAX) : truncate(flat, HINT_MAX);
}

/**
 * Truncate a PATH to `n` chars while keeping its final segment: `/home/beckett/Projects/…` becomes
 * `/home/beckett/Proj…index.html` rather than `/home/beckett/Projects/beckett/.beckett/worktr…`.
 * The line's structure, marker and stamp are untouched — only which characters survive changes.
 */
function truncatePath(path: string, n: number): string {
  if (path.length <= n) return path;
  const base = path.slice(path.lastIndexOf("/") + 1);
  // A single segment longer than the budget has no prefix worth keeping; fall back to plain
  // head truncation so the result can never exceed `n`.
  if (!base || base.length + 2 > n) return truncate(path, n);
  return `${path.slice(0, n - base.length - 1)}…${base}`;
}

/** Single-char mark for a file change kind. */
function changeMark(kind: "add" | "update" | "delete"): string {
  return kind === "add" ? "+" : kind === "delete" ? "-" : "~";
}

/** Truncate to `n` chars with an ellipsis, collapsing nothing else. */
function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}
