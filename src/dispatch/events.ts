/** Durable, live-readable dispatch/deploy stage telemetry (OPS-167). */
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
  ticketId: string;
  /** Human-facing ticket identifier or public task branch reference. */
  ticketRef: string;
  /** Git branch ref, when known. Never omitted so trace consumers have a stable shape. */
  branchRef: string;
  /** Discord channel that filed the ticket, when known (Ticket.originChannel) — card routing only. */
  channel?: string;
  stage: string;
  outcome: DispatchOutcome;
  /** Time since the first observed event for this ticket, in milliseconds. */
  elapsedMs: number;
  message?: string;
  error?: string;
}

export interface DispatchEventInput {
  ticketId: string;
  ticketRef: string;
  branchRef?: string;
  channel?: string;
  stage: string;
  outcome: DispatchOutcome;
  message?: string;
  error?: string;
}

export interface DispatchEventBusOptions {
  /** One append-only JSONL ledger shared by all tickets; rows are indexed by ticketId/ref. */
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
    const now = this.now();
    const started = this.startedAt.get(input.ticketId) ?? now;
    this.startedAt.set(input.ticketId, started);
    const event: DispatchEvent = {
      ts: new Date(now).toISOString(),
      ticketId: input.ticketId,
      ticketRef: input.ticketRef,
      branchRef: input.branchRef ?? "",
      ...(input.channel ? { channel: input.channel } : {}),
      stage: input.stage,
      outcome: input.outcome,
      elapsedMs: Math.max(0, now - started),
      ...(input.message ? { message: input.message } : {}),
      ...(input.error ? { error: input.error } : {}),
    };
    // This is intentionally before the live sink. If this throws, callers see a real durability
    // failure rather than falsely claiming an observable transition happened.
    if (this.options.path) {
      mkdirSync(dirname(this.options.path), { recursive: true, mode: 0o700 });
      appendFileSync(this.options.path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    }
    if (this.options.liveSink) {
      queueMicrotask(() => {
        // Start with a resolved promise so a synchronously throwing sink is also contained.
        Promise.resolve().then(() => this.options.liveSink!(event)).catch((error) => this.options.onSinkError?.(error));
      });
    }
    return event;
  }

  private loadStarts(): void {
    const path = this.options.path;
    if (!path || !existsSync(path)) return;
    try {
      for (const event of readDispatchEvents(path)) {
        const ts = Date.parse(event.ts);
        if (Number.isFinite(ts) && !this.startedAt.has(event.ticketId)) this.startedAt.set(event.ticketId, ts - event.elapsedMs);
      }
    } catch {
      // A malformed historical line must not stop the dispatcher; valid rows remain traceable.
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
      const row = JSON.parse(line) as DispatchEvent;
      if (!row || typeof row.ticketId !== "string" || typeof row.ticketRef !== "string" || typeof row.stage !== "string") continue;
      if (!wanted || row.ticketId.toLowerCase() === wanted || row.ticketRef.toLowerCase() === wanted || row.branchRef.toLowerCase() === wanted.replace(/^#/, "")) rows.push(row);
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
 * shape belongs to `beckett ticket trace` and nowhere else — the Discord feed speaks the digest in
 * ./digest.ts instead (#4).
 */
export function formatDispatchEvent(event: DispatchEvent): string {
  const stamp = event.ts.slice(11, 19);
  const elapsed = formatElapsed(event.elapsedMs);
  const alert = event.outcome === "failed" ? " 🚨 ALERT" : "";
  const detail = event.error ?? event.message;
  return `${MARKERS[event.outcome]} ${stamp} · ${event.ticketRef} · ${event.stage} · ${event.outcome.toUpperCase()} · ${elapsed}${alert}${detail ? ` — ${oneLine(detail)}` : ""}`;
}

export function formatDispatchTrace(events: DispatchEvent[], id: string): string {
  if (!events.length) return `No dispatch trace for ${id}.`;
  return [`Dispatch trace · ${events[0]!.ticketRef} (${events[0]!.ticketId})`, ...events.map(formatDispatchEvent)].join("\n");
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}
