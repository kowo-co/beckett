/**
 * Zero-token progress cards (progress.cards_as_code): one self-editing status message per active
 * ticket, in the channel that filed it.
 *
 * {@link reduceProgressCard} decides WHAT the card says and {@link renderProgressCard} how it
 * reads; the service decides where it lands and how often. Every input is a
 * {@link ../dispatch/events.ts DispatchEvent} straight off the bus, so a ticket's whole run costs
 * no model turn at all — the daemon posts once and edits that same message thereafter.
 *
 * Failure policy mirrors {@link ../dispatch/digest-feed.ts DispatchDigestFeed}: a deleted target is
 * the one repost path (once), everything else is skipped and self-heals — each card carries the
 * FULL state, so the next edit shows whatever a dropped one would have. Unlike the digest feed the
 * anchor is durable (`<beckettDir>/progress-cards.json`), so a daemon restart keeps editing the
 * same card instead of leaving a stale one behind.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DiscordUnknownMessageError, type DiscordGateway } from "../discord/gateway.ts";
import type { DispatchEvent } from "../dispatch/events.ts";
import { log as rootLog } from "../log.ts";
import type { Logger } from "../types.ts";

/** The card's whole model — everything renderProgressCard needs, accumulated from dispatch events. */
export interface ProgressCardState {
  ref: string;
  phase: string;
  detail: string;
  alert: boolean;
  terminal: boolean;
  startedAt: number;
}

const STAGE_GERUND: Record<string, string> = {
  implement: "implementing",
  review: "in review",
  design: "designing",
  design_check: "design check",
  rework: "reworking",
};

const STAGE_NOUN: Record<string, string> = {
  implement: "implementation",
  review: "review",
  design: "design",
  design_check: "design check",
  rework: "rework",
};

/** What this event changes about the card, or null when it says nothing card-worthy. */
type Verdict = Pick<ProgressCardState, "phase" | "detail" | "alert" | "terminal">;

/**
 * Fold one dispatch event into the card state. Returns null when the event changes nothing worth
 * showing — the caller then leaves Discord alone entirely.
 */
export function reduceProgressCard(
  prev: ProgressCardState | null,
  event: DispatchEvent,
  nowMs: number,
): ProgressCardState | null {
  const verdict = verdictFor(event);
  if (!verdict) return null;
  const parsed = Date.parse(event.ts);
  return {
    ref: event.ticketRef || prev?.ref || event.ticketId,
    startedAt: prev?.startedAt ?? (Number.isFinite(parsed) ? parsed : nowMs),
    ...verdict,
  };
}

function verdictFor(event: DispatchEvent): Verdict | null {
  // A worker the daemon killed on its way down did not fail the ticket (#4); say so and keep the
  // card alive so the restart's re-staff edits the same message.
  if (event.outcome === "interrupted") {
    return { phase: "interrupted by a restart", detail: "", alert: false, terminal: false };
  }
  const [base = "", qualifier = ""] = event.stage.split(":");
  if (base === "restart-restaff") return null;
  const detail = clip(event.error || event.message);
  const gerund = STAGE_GERUND[base] ?? base.replace(/[-_]/g, " ");
  const noun = STAGE_NOUN[base] ?? base.replace(/[-_]/g, " ");

  // The v7 run engine's deploy receipt (architecture.md "Run cards = the deploy receipt"): the
  // supervisor fires this the instant `beckett task deploy` admits a run — before a worktree
  // exists or a worker spawns — so a card appears within seconds of the CLI call.
  if (base === "run" && qualifier === "deploy") {
    return event.outcome === "started" ? { phase: "queued", detail: "", alert: false, terminal: false } : null;
  }

  // A run reaching `done` (bare stage, run/supervisor.ts's own vocabulary — distinct from the
  // ticket dispatcher's `state:done`). The publish path traces the shipped PR/push URL as the
  // message right before this fires, so it reads as the receipt's final line.
  if (base === "done" && !qualifier) {
    return event.outcome === "passed"
      ? { phase: "shipped", detail: clip(event.message), alert: false, terminal: true }
      : null;
  }

  if (qualifier === "staff") {
    if (event.outcome === "held") {
      return { phase: "queued", detail: "waiting for a worker slot", alert: false, terminal: false };
    }
    if (event.outcome === "failed") return { phase: "worker couldn't start", detail, alert: true, terminal: false };
    return null;
  }
  if (qualifier === "wedge") return { phase: "stalled", detail, alert: true, terminal: false };

  if (base === "watchdog") {
    if (event.outcome === "held") return { phase: "parked for a human", detail, alert: true, terminal: true };
    return { phase: "retrying", detail: "re-staffing", alert: false, terminal: false };
  }
  if (base === "restaff") return { phase: "retrying", detail, alert: false, terminal: false };
  if (base === "worktree" || base === "repo") {
    return event.outcome === "failed" ? { phase: "setup failed", detail, alert: true, terminal: false } : null;
  }
  if (base === "state") {
    const to = event.stage.slice("state:".length);
    if (event.outcome === "started") return null;
    if (event.outcome === "failed") {
      return { phase: `couldn't move to ${to.replace(/_/g, " ")}`, detail, alert: true, terminal: false };
    }
    if (to === "done") return { phase: "done", detail: "", alert: false, terminal: true };
    if (to === "cancelled") return { phase: "cancelled", detail: "", alert: false, terminal: true };
    return null;
  }
  if (base === "park") {
    return event.outcome === "held" ? { phase: "parked for a human", detail, alert: true, terminal: true } : null;
  }
  if (base === "cancel") return { phase: "cancelled", detail: "", alert: false, terminal: true };
  if (base === "publish" || base === "publish-retry") {
    if (event.outcome === "started") return { phase: "publishing", detail: "", alert: false, terminal: false };
    if (event.outcome === "failed") return { phase: "publish failed", detail, alert: true, terminal: false };
    return null;
  }
  if (base === "pr") {
    return event.message ? { phase: "pr opened", detail: clip(event.message), alert: false, terminal: false } : null;
  }
  if (base === "git-push") {
    return event.message ? { phase: "pushed", detail: clip(event.message), alert: false, terminal: false } : null;
  }
  if (base === "dispatch") {
    return event.outcome === "failed" ? { phase: "dispatcher error", detail, alert: true, terminal: false } : null;
  }
  if (base === "preview" || base === "dependency-promotion") return null;

  // A worker stage: implement/review/design/design_check/rework, or one a future extension adds.
  switch (event.outcome) {
    case "started":
      return { phase: gerund, detail: "", alert: false, terminal: false };
    case "passed":
      return { phase: `${noun} done`, detail: "", alert: false, terminal: false };
    case "failed":
      return { phase: `${noun} failed`, detail, alert: true, terminal: false };
    case "held":
      return { phase: "held", detail: clip(event.message), alert: false, terminal: false };
    case "cancelled":
      return { phase: "cancelled", detail: "", alert: false, terminal: true };
    default:
      return null;
  }
}

/** Discord's atomic message cap is 2000; stay clear of it so a long detail can never drop a card. */
const MAX_CARD_CHARS = 1900;

/** A run's live `## Checklist` progress (`../run/spec-file.ts`'s codec, read fs-free here). */
export interface CardChecklist {
  done: number;
  total: number;
}

/**
 * One glanceable card: marker, ref, phase, elapsed — plus the run's checklist progress when a
 * `specReader` resolved one, and the detail line last. With a checklist, everything folds onto
 * one line (`… 12m — 3/7 checked · <detail>`); without one, detail falls back to its own line
 * (unchanged from before run cards existed) so ticket cards render exactly as they always have.
 */
export function renderProgressCard(state: ProgressCardState, nowMs: number, checklist?: CardChecklist | null): string {
  const marker = markerFor(state);
  let text = `${marker} **${state.ref}** · ${state.phase} · ${elapsedWord(nowMs - state.startedAt)}`;
  if (checklist) {
    text += ` — ${checklist.done}/${checklist.total} checked`;
    if (state.detail) text += ` · ${state.detail}`;
  } else if (state.detail) {
    text += `\n— ${state.detail}`;
  }
  return text.length > MAX_CARD_CHARS ? `${text.slice(0, MAX_CARD_CHARS - 1)}…` : text;
}

function markerFor(state: ProgressCardState): string {
  if (state.terminal && (state.phase === "done" || state.phase === "shipped")) return "✓";
  if (state.terminal && state.phase === "cancelled") return "⛔";
  if (state.terminal || state.alert) return "⚠";
  return "▸";
}

function elapsedWord(ms: number): string {
  const span = Math.max(0, ms);
  if (span < 60_000) return `${Math.floor(span / 1000)}s`;
  const minutes = Math.floor(span / 60_000);
  if (span < 3_600_000) return `${minutes}m`;
  return `${Math.floor(span / 3_600_000)}h ${minutes % 60}m`;
}

/** One line, no code-fence escapes, short enough that a stack trace can't become the card. */
function clip(value: string | undefined, max = 200): string {
  if (!value) return "";
  const flat = value.replace(/[`*_~]/g, "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// =======================================================================================
// The service
// =======================================================================================

export interface ProgressCardServiceOptions {
  gateway: Pick<DiscordGateway, "post" | "editMessage">;
  /** Durable anchor store, conventionally `<beckettDir>/progress-cards.json`. */
  statePath: string;
  /** Where a ticket's card lives; null = this ticket gets no card. */
  resolveChannel: (event: DispatchEvent) => string | null;
  /**
   * A run's live `## Checklist` progress, keyed by `DispatchEvent.ticketId` (the run id) —
   * injected so this module stays fs-free in tests. Production wires `parseSpecChecklist` over
   * the run's workspace (`../run/supervisor.ts`'s `runSpecReader`). Returns null when the run has
   * no workspace yet, no spec.md, or isn't a run at all (e.g. a ticket-dispatcher event) — the
   * card then renders exactly as it did before checklists existed.
   */
  specReader?: (ticketId: string) => CardChecklist | null;
  logger?: Logger;
  now?: () => number;
  /** Floor between consecutive edits of one card. Default 15_000. */
  minEditIntervalMs?: number;
  /** Timer seam (tests). Default wraps setTimeout/clearTimeout. */
  schedule?: (fn: () => void, ms: number) => { cancel(): void };
}

interface PersistedCard {
  channelId: string;
  messageId: string;
  startedAt: number;
  updatedAt: number;
}

interface CardRecord {
  state: ProgressCardState;
  anchor?: { channelId: string; messageId: string };
  lastEvent: DispatchEvent;
  lastDeliveredAt: number;
  pending?: { cancel(): void };
  repostedOnce: boolean;
}

/** Ceiling on tracked tickets; a daemon that never sees a terminal event still can't grow forever. */
const MAX_TRACKED = 300;

export class ProgressCardService {
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly minEditIntervalMs: number;
  private readonly schedule: (fn: () => void, ms: number) => { cancel(): void };
  private readonly records = new Map<string, CardRecord>();
  /** Per-ticket serialization: a post must persist its id before the next edit reads it. */
  private readonly inflight = new Map<string, Promise<void>>();
  private persisted: Map<string, PersistedCard> | null = null;

  constructor(private readonly opts: ProgressCardServiceOptions) {
    this.logger = opts.logger ?? rootLog.child("progress.cards");
    this.now = opts.now ?? Date.now;
    this.minEditIntervalMs = opts.minEditIntervalMs ?? 15_000;
    this.schedule =
      opts.schedule ??
      ((fn, ms) => {
        const timer = setTimeout(fn, Math.max(0, ms));
        timer.unref?.();
        return { cancel: () => clearTimeout(timer) };
      });
  }

  /**
   * Observe one dispatch event. Never rejects: a card is decoration on a durable timeline, and a
   * Discord hiccup must never reach the dispatch path that emitted the event.
   */
  observe(event: DispatchEvent): Promise<void> {
    try {
      const key = event.ticketId || event.ticketRef;
      if (!key) return Promise.resolve();
      const existing = this.records.get(key);
      const state = reduceProgressCard(existing?.state ?? null, event, this.now());
      if (!state) return Promise.resolve();
      const record = existing ?? this.createRecord(key, state, event);
      record.state = state;
      record.lastEvent = event;

      if (!record.anchor || state.terminal) {
        record.pending?.cancel();
        record.pending = undefined;
        return this.enqueue(key);
      }
      if (record.pending) return Promise.resolve(); // the trailing edit will carry this state
      const wait = record.lastDeliveredAt + this.minEditIntervalMs - this.now();
      if (wait <= 0) return this.enqueue(key);
      record.pending = this.schedule(() => {
        record.pending = undefined;
        void this.enqueue(key);
      }, wait);
      return Promise.resolve();
    } catch (error) {
      this.logger.warn("progress card observe failed", { ticket: event.ticketRef, error: String(error) });
      return Promise.resolve();
    }
  }

  private createRecord(key: string, state: ProgressCardState, event: DispatchEvent): CardRecord {
    // A restart adopts the previous run's anchor and clock, so the card is edited, not duplicated.
    const saved = this.load().get(key);
    if (saved && Number.isFinite(saved.startedAt)) state.startedAt = saved.startedAt;
    const record: CardRecord = {
      state,
      ...(saved ? { anchor: { channelId: saved.channelId, messageId: saved.messageId } } : {}),
      lastEvent: event,
      lastDeliveredAt: 0,
      repostedOnce: false,
    };
    this.records.set(key, record);
    this.evictOverflow();
    return record;
  }

  private evictOverflow(): void {
    if (this.records.size <= MAX_TRACKED) return;
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [key, record] of this.records) {
      if (record.lastDeliveredAt < oldest) {
        oldest = record.lastDeliveredAt;
        oldestKey = key;
      }
    }
    if (!oldestKey) return;
    this.records.get(oldestKey)?.pending?.cancel();
    this.records.delete(oldestKey);
    this.forget(oldestKey);
  }

  private enqueue(key: string): Promise<void> {
    const prior = this.inflight.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(() => this.deliver(key));
    this.inflight.set(key, next);
    void next.finally(() => {
      if (this.inflight.get(key) === next) this.inflight.delete(key);
    });
    return next;
  }

  private async deliver(key: string): Promise<void> {
    const record = this.records.get(key);
    if (!record) return;
    const checklist = this.opts.specReader?.(record.lastEvent.ticketId) ?? null;
    const text = renderProgressCard(record.state, this.now(), checklist);
    record.lastDeliveredAt = this.now();
    try {
      if (record.anchor) {
        try {
          await this.opts.gateway.editMessage(record.anchor.channelId, record.anchor.messageId, { content: text });
          return;
        } catch (error) {
          if (!(error instanceof DiscordUnknownMessageError)) {
            // Offline / rate limited / permissions: the next card carries the same full state.
            this.logger.debug("progress card edit failed; folding into the next update", {
              ticket: record.state.ref,
              error: String(error),
            });
            return;
          }
          record.anchor = undefined;
          this.forget(key);
          if (record.repostedOnce) {
            this.logger.debug("progress card was deleted twice; leaving it alone", { ticket: record.state.ref });
            return;
          }
          record.repostedOnce = true;
          this.logger.debug("progress card was deleted; posting a replacement", { ticket: record.state.ref });
        }
      }
      const channelId = this.opts.resolveChannel(record.lastEvent);
      if (!channelId) {
        this.logger.debug("no channel for progress card", { ticket: record.state.ref });
        return;
      }
      try {
        const messageId = await this.opts.gateway.post(channelId, text, {
          singleMessage: true,
          // The durable timeline is the dispatch bus's JSONL. Never grow a Discord backlog for a
          // status line that a later card would restate anyway.
          queueIfOffline: false,
        });
        record.anchor = { channelId, messageId };
        this.remember(key, record);
      } catch (error) {
        this.logger.debug("progress card post failed", { ticket: record.state.ref, error: String(error) });
      }
    } catch (error) {
      // Delivery must never reject: observe() and the enqueue chain both hang off this promise,
      // and a card failure may not surface as an unhandled rejection in the dispatch loop.
      this.logger.warn("progress card delivery failed", { ticket: record.state.ref, error: String(error) });
    } finally {
      if (record.state.terminal) {
        record.pending?.cancel();
        this.records.delete(key);
        this.forget(key);
      }
    }
  }

  // ---------------------------------------------------------------------------------------
  // Durable anchors
  // ---------------------------------------------------------------------------------------

  private load(): Map<string, PersistedCard> {
    if (this.persisted) return this.persisted;
    const cards = new Map<string, PersistedCard>();
    this.persisted = cards;
    try {
      if (!existsSync(this.opts.statePath)) return cards;
      const parsed = JSON.parse(readFileSync(this.opts.statePath, "utf8")) as {
        version?: number;
        cards?: Record<string, Partial<PersistedCard>>;
      };
      if (!parsed || parsed.version !== 1 || !parsed.cards) return cards;
      for (const [key, value] of Object.entries(parsed.cards)) {
        if (!value || typeof value.channelId !== "string" || typeof value.messageId !== "string") continue;
        cards.set(key, {
          channelId: value.channelId,
          messageId: value.messageId,
          startedAt: typeof value.startedAt === "number" ? value.startedAt : this.now(),
          updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : this.now(),
        });
      }
    } catch {
      // A torn or hand-edited store is not worth a boot failure: the worst case is a fresh card.
    }
    return cards;
  }

  private remember(key: string, record: CardRecord): void {
    if (!record.anchor) return;
    this.load().set(key, {
      channelId: record.anchor.channelId,
      messageId: record.anchor.messageId,
      startedAt: record.state.startedAt,
      updatedAt: this.now(),
    });
    this.save();
  }

  private forget(key: string): void {
    if (!this.load().delete(key)) return;
    this.save();
  }

  private save(): void {
    const cards = this.load();
    try {
      mkdirSync(dirname(this.opts.statePath), { recursive: true });
      const tmp = `${this.opts.statePath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, cards: Object.fromEntries(cards) }, null, 2));
      renameSync(tmp, this.opts.statePath);
    } catch (err) {
      // Fail open: a lost anchor costs one duplicate card after a restart, not a dropped event.
      this.logger.warn("progress card state write failed", {
        path: this.opts.statePath,
        error: (err as Error).message,
      });
    }
  }
}

export function createProgressCardService(opts: ProgressCardServiceOptions): ProgressCardService {
  return new ProgressCardService(opts);
}
