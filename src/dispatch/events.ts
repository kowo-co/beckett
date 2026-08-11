/**
 * Durable, live-readable run/deploy stage telemetry.
 *
 * LEGACY ROWS. This ledger is append-only and predates the ticket rip-out, so `dispatch.jsonl`
 * on a live box still holds rows keyed `ticketId`/`ticketRef`. {@link readDispatchEvents}
 * normalizes those two field names onto `runId`/`runRef` as it reads, so history stays traceable
 * (`beckett task trace`), the digest keeps its sessions, and dream assembly keeps its sources —
 * without a migration pass over a file whose whole point is that nothing ever rewrites it.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * `interrupted` is deliberately distinct from `failed` (#4): a worker the daemon killed on its way
 * down did not fail the ticket, and must never be dressed as a failure in the feed.
 */
export type DispatchOutcome =
  | "started"
  | "passed"
  | "bounced"
  | "cancelled"
  | "failed"
  | "interrupted"
  | "held"
  | "info";

/** One immutable dispatch timeline row. Persisted before the live sink is notified. */
export interface DispatchEvent {
  ts: string;
  runId: string;
  /** Human-facing run reference (the run id) or public task branch reference. */
  runRef: string;
  /** Git branch ref, when known. Never omitted so trace consumers have a stable shape. */
  branchRef: string;
  /** Discord channel this work was deployed from, when known — card routing only. */
  channel?: string;
  stage: string;
  outcome: DispatchOutcome;
  /** Time since the first observed event for this run, in milliseconds. */
  elapsedMs: number;
  message?: string;
  error?: string;
}

/** A legacy pre-v7 row, as it still sits in an existing `dispatch.jsonl`. */
interface LegacyDispatchEvent extends Omit<DispatchEvent, "runId" | "runRef"> {
  ticketId?: string;
  ticketRef?: string;
  runId?: string;
  runRef?: string;
}

export interface DispatchEventInput {
  runId: string;
  runRef: string;
  branchRef?: string;
  channel?: string;
  stage: string;
  outcome: DispatchOutcome;
  message?: string;
  error?: string;
}

export interface DispatchEventBusOptions {
  /** One append-only JSONL ledger shared by all runs; rows are indexed by runId/ref. */
  path?: string;
  /** Deliberately asynchronous/best-effort. It must never be awaited by dispatch. */
  liveSink?: (event: DispatchEvent) => Promise<unknown> | unknown;
  now?: () => number;
  onSinkError?: (error: unknown) => void;
}

/**
 * The sole dispatch transition chokepoint. `emit` appends synchronously BEFORE scheduling the
 * optional Discord sink: a gateway outage can neither block dispatch nor lose the forensic row.
 */
export class DispatchEventBus {
  private readonly startedAt = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly options: DispatchEventBusOptions = {}) {
    this.now = options.now ?? Date.now;
    this.loadStarts();
  }

  emit(input: DispatchEventInput): DispatchEvent {
    const event = this.build(input);
    // This is intentionally before the live sink. If this throws, callers see a real durability
    // failure rather than falsely claiming an observable transition happened.
    if (this.options.path) {
      mkdirSync(dirname(this.options.path), { recursive: true, mode: 0o700 });
      appendFileSync(this.options.path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    }
    this.notify(event);
    return event;
  }

  /**
   * A live-ONLY row: notify the sink, append nothing. For repaints of a live surface that carry no
   * transition — the run engine's activity blurb (`../run/activity.ts`) repaints a progress card
   * every ~20s, and a forensic ledger whose whole point is that nothing rewrites it must not fill
   * up with a hundred "still editing index.html" rows per run.
   *
   * Everything a person or a tool reconstructs a run from still goes through {@link emit}.
   */
  emitEphemeral(input: DispatchEventInput): DispatchEvent {
    const event = this.build(input);
    this.notify(event);
    return event;
  }

  private build(input: DispatchEventInput): DispatchEvent {
    const now = this.now();
    const started = this.startedAt.get(input.runId) ?? now;
    this.startedAt.set(input.runId, started);
    return {
      ts: new Date(now).toISOString(),
      runId: input.runId,
      runRef: input.runRef,
      branchRef: input.branchRef ?? "",
      ...(input.channel ? { channel: input.channel } : {}),
      stage: input.stage,
      outcome: input.outcome,
      elapsedMs: Math.max(0, now - started),
      ...(input.message ? { message: input.message } : {}),
      ...(input.error ? { error: input.error } : {}),
    };
  }

  private notify(event: DispatchEvent): void {
    if (!this.options.liveSink) return;
    queueMicrotask(() => {
      // Start with a resolved promise so a synchronously throwing sink is also contained.
      Promise.resolve().then(() => this.options.liveSink!(event)).catch((error) => this.options.onSinkError?.(error));
    });
  }

  private loadStarts(): void {
    const path = this.options.path;
    if (!path || !existsSync(path)) return;
    try {
      for (const event of readDispatchEvents(path)) {
        const ts = Date.parse(event.ts);
        if (Number.isFinite(ts) && !this.startedAt.has(event.runId)) this.startedAt.set(event.runId, ts - event.elapsedMs);
      }
    } catch {
      // A malformed historical line must not stop the supervisor; valid rows remain traceable.
    }
  }
}

export function readDispatchEvents(path: string, idOrRef?: string): DispatchEvent[] {
  if (!existsSync(path)) return [];
  const wanted = idOrRef?.trim().toLowerCase();
  const rows: DispatchEvent[] = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line) as LegacyDispatchEvent;
      if (!raw || typeof raw.stage !== "string") continue;
      // Pre-v7 rows carry `ticketId`/`ticketRef`; normalize both spellings onto the run keys so
      // one reader serves the whole history.
      const runId = raw.runId ?? raw.ticketId;
      const runRef = raw.runRef ?? raw.ticketRef;
      if (typeof runId !== "string" || typeof runRef !== "string") continue;
      const row: DispatchEvent = { ...raw, runId, runRef };
      delete (row as LegacyDispatchEvent).ticketId;
      delete (row as LegacyDispatchEvent).ticketRef;
      if (!wanted || runId.toLowerCase() === wanted || runRef.toLowerCase() === wanted || row.branchRef.toLowerCase() === wanted.replace(/^#/, "")) rows.push(row);
    } catch { /* append-only ledger tolerates a torn final line */ }
  }
  return rows.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

const MARKERS: Record<DispatchOutcome, string> = {
  started: "▶",
  passed: "✓",
  bounced: "↩",
  cancelled: "⛔",
  failed: "✗",
  interrupted: "⟲",
  held: "⏸",
  info: "•",
};

/**
 * The FORENSIC row: marker, UTC clock, internal stage name, outcome, elapsed, raw detail. This
 * shape belongs to `beckett task trace` and nowhere else — the Discord feed speaks the digest in
 * ./digest.ts instead (#4).
 */
export function formatDispatchEvent(event: DispatchEvent): string {
  const stamp = event.ts.slice(11, 19);
  const elapsed = formatElapsed(event.elapsedMs);
  const alert = event.outcome === "failed" ? " 🚨 ALERT" : "";
  const detail = event.error ?? event.message;
  return `${MARKERS[event.outcome]} ${stamp} · ${event.runRef} · ${event.stage} · ${event.outcome.toUpperCase()} · ${elapsed}${alert}${detail ? ` — ${oneLine(detail)}` : ""}`;
}

export function formatDispatchTrace(events: DispatchEvent[], id: string): string {
  if (!events.length) return `No dispatch trace for ${id}.`;
  return [`Dispatch trace · ${events[0]!.runRef} (${events[0]!.runId})`, ...events.map(formatDispatchEvent)].join("\n");
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}
