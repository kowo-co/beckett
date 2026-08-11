/**
 * Beckett — ops-log rendering table (`src/ops-log/render.ts`)
 * =======================================================================================
 * Translates KNOWN daemon log events ({@link LogRecord}, `src/log.ts`) into one legible line
 * each, for the Discord ops-log mirror (issue #231 — "log everything in the ops channel …
 * robust, expressive, legible"). An event NOT in the table falls back to a compact
 * `component: msg (k=v k=v)` line — never a raw JSON dump.
 *
 * Matched by MSG TEXT alone, not by (component, msg): the real runtime `component` string is
 * not a stable match key here. `src/shell/main.ts` wires one "shell.v4"-rooted logger through
 * several more `.child(...)` calls before handing it to each module, and at least one call site
 * (`Concierge`'s constructor) calls `.child("concierge")` a SECOND time on a logger that is
 * already `.child("concierge")`-derived — so the same logical event's `component` field is
 * `"shell.v4.concierge.concierge"` in production, not the bare `"concierge"` a naive reading of
 * the call site would suggest. The msg strings below are what call sites actually keep stable;
 * this table's job is legibility, not component-path archaeology.
 */
import type { LogRecord } from "../log.ts";

type Renderer = (rec: LogRecord) => string;

function str(v: unknown, fallback = "?"): string {
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** "12s" under a minute, else "2m" / "2m5s". Shared with the turn heartbeat. */
export function fmtDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? `${m}m` : `${m}m${s}s`;
}

/** "905k" for four-digit-plus token counts, else the plain number. */
export function fmtTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** First 8 chars — a UUID's first hyphen-delimited group, e.g. "40158bf8". */
export function shortId(id: unknown): string {
  const s = typeof id === "string" ? id : "";
  return s ? s.slice(0, 8) : "?";
}

function channelLabel(rec: LogRecord): string {
  const name = str(rec.channelName, "");
  if (name) return `#${name}`;
  return str(rec.channelId, "?");
}

function authorLabel(rec: LogRecord): string {
  const author = str(rec.author, "");
  if (author) return `@${author}`;
  const userId = str(rec.userId, "");
  return userId ? `@${userId}` : "someone";
}

const DECISION_LABEL: Record<string, string> = {
  send: "sent",
  pass: "passed",
  superseded: "superseded",
};

function decisionLabel(rec: LogRecord): string {
  const decision = str(rec.decision, "?");
  return DECISION_LABEL[decision] ?? decision;
}

/**
 * msg text → renderer. Built by grepping the codebase's real log call sites (session/turn/run
 * lifecycle, deploy/restart, discord gateway, browser lease, publish outbox) for the highest-
 * signal ~20 events (issue #231's ask). `turn start` / `turn done` / `turn failed` are new call
 * sites added alongside this module (`Concierge.runDirectedTurn`) — nothing else logged a clean
 * turn boundary to hang the heartbeat (deliverable 3) or these lines off of.
 */
const KNOWN_EVENTS: Record<string, Renderer> = {
  // ── session lifecycle ──────────────────────────────────────────────────────────────────
  "concierge online": (r) => `⚙ concierge online (${str(r.model)})`,
  "concierge re-grounding on a fresh session": (r) =>
    `⚙ session re-ground starting (${fmtTokens(num(r.contextTokens))} ctx) reason=${str(r.reason)}`,
  "concierge re-grounding complete": (r) => `⚙ session re-ground ${shortId(r.from)}→${shortId(r.to)}`,
  "concierge claude process exited": (r) => `⚠ concierge process exited (code ${str(r.code)}) ${shortId(r.sessionId)}`,
  "recycled idle concierge session child (live cap)": (r) => `♻ session recycled (live cap) ${str(r.scope)}`,
  "recycled idle concierge session child (idle timer)": (r) => `♻ session recycled (idle) ${str(r.scope)}`,
  "evicted idle concierge session entry": (r) => `♻ session evicted (idle) ${str(r.scope)}`,

  // ── turn lifecycle ─────────────────────────────────────────────────────────────────────
  "turn start": (r) => `▶ turn start ${channelLabel(r)} from ${authorLabel(r)}`,
  "turn done": (r) => `✔ turn done ${fmtDuration(num(r.elapsedMs))} → ${decisionLabel(r)}`,
  "turn failed": (r) => `✖ turn failed ${fmtDuration(num(r.elapsedMs))}: ${str(r.err)}`,

  // ── run lifecycle ──────────────────────────────────────────────────────────────────────
  "worker spawned for run": (r) => `▶ worker spawned ${str(r.run)} stage=${str(r.stage)} harness=${str(r.harness)}`,
  "run done": (r) => `▲ run done ${str(r.run)}`,
  "run parked for a human": (r) => `⚠ run parked ${str(r.run)}: ${str(r.reason)}`,
  "run cancelled — aborting worker": (r) => `✖ run cancelled ${str(r.run)}`,

  // ── deploy / restart ───────────────────────────────────────────────────────────────────
  "booting beckett v4": (r) => `⚙ booting beckett ${str(r.version)}`,
  "beckett online": (r) => `✔ beckett online (${num(r.liveRuns)} live run${num(r.liveRuns) === 1 ? "" : "s"})`,
  "shutting down beckett": (r) => `⏻ shutting down (${str(r.signal)})`,

  // ── discord gateway ────────────────────────────────────────────────────────────────────
  "discord shard disconnected": (r) => `⇅ discord shard disconnected (code ${str(r.code)})`,
  "discord shard reconnecting": () => `⇅ discord shard reconnecting`,
  "discord shard RESUMEd": (r) => `✔ discord shard resumed (${num(r.replayedEvents)} events replayed)`,

  // ── browser lease ──────────────────────────────────────────────────────────────────────
  "browser lease acquired": (r) => `▶ browser lease acquired ${str(r.runId)}`,
  "browser lease released": (r) => `✔ browser lease released ${str(r.runId)}`,

  // ── publish outbox ─────────────────────────────────────────────────────────────────────
  "queued GitHub publish for retry": (r) => `⚠ publish attempt ${str(r.attempt)} queued for retry: ${str(r.item)}`,
  "queued GitHub publish still failing": (r) => `⚠ publish attempt failed: ${str(r.error)}`,
};

/** The known msg strings this table renders — handy for tests and for `#231` bookkeeping. */
export const KNOWN_EVENT_MESSAGES: readonly string[] = Object.freeze(Object.keys(KNOWN_EVENTS));

function fieldValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 60 ? `${s.slice(0, 57)}...` : s;
  } catch {
    return "[unserializable]";
  }
}

const MARKER_FOR_LEVEL: Record<string, string> = { error: "✖", warn: "⚠", info: "•", debug: "·" };

/** Compact `component: msg (k=v k=v)` line for anything NOT in {@link KNOWN_EVENT_MESSAGES}. */
export function renderFallback(rec: LogRecord): string {
  const { level, component, msg, ts: _ts, ...fields } = rec;
  const kv = Object.entries(fields)
    .map(([k, v]) => `${k}=${fieldValue(v)}`)
    .join(" ");
  const marker = MARKER_FOR_LEVEL[level] ?? "•";
  const line = kv ? `${marker} ${component}: ${msg} (${kv})` : `${marker} ${component}: ${msg}`;
  return line.length > 400 ? `${line.slice(0, 397)}...` : line;
}

/** One rendered line for a log record — the known-event rendering, else the compact fallback. */
export function renderEventLine(rec: LogRecord): string {
  const known = KNOWN_EVENTS[rec.msg];
  return known ? known(rec) : renderFallback(rec);
}
