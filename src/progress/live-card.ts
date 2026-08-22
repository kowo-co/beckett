/**
 * Beckett — the live-progress-with-terminal card (`src/progress/live-card.ts`)
 * =======================================================================================
 * ro's ask, verbatim: "a component v2 card in #live-progress that shows the active progress with
 * a 'window' into the terminal." One self-editing Components V2 card per RUN, posted into
 * {@link ../concierge/index.ts#liveProgressChannelId its own channel} — the state line
 * `../progress/cards.ts#renderProgressCard` already renders, plus a fixed-height monospace pane
 * of the run's most recent journal lines below it, scrolling as the run works.
 *
 * This is deliberately a SIBLING of {@link ../progress/cards.ts ProgressCardService}, not a
 * replacement: it reuses that module's whole state machine ({@link reduceProgressCard}, {@link
 * ProgressCardState}, {@link renderProgressCard}) so the two cards agree on what a
 * `DispatchEvent` means, and only adds the terminal window + a Components V2 render + its own
 * anchor/coalescing loop. The terminal content itself comes from `./journal.ts`'s existing
 * per-run log — no new capture path, no tmux.
 *
 * Failure/lifecycle discipline mirrors `ProgressCardService` exactly: a deleted target is
 * reposted once, every other failure (offline, rate limited, permission) skips the tick and
 * self-heals on the next event, and a terminal event stops the record from tracking further
 * updates. The one difference: **the window freezes rather than collapses**. On the run's
 * terminal event this delivers ONE last render carrying whatever lines the journal has at that
 * moment, then stops — the last few lines of work are exactly what someone reaches for after a
 * failure, and collapsing them away would throw out the one part of the card worth keeping once
 * the run goes quiet.
 */
import { renderLiveProgressCard, type LiveProgressCardSnapshot } from "../discord/cards.ts";
import { DiscordUnknownMessageError, type DiscordGateway } from "../discord/gateway.ts";
import type { DispatchEvent } from "../dispatch/events.ts";
import { log as rootLog } from "../log.ts";
import type { Logger } from "../types.ts";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { reduceProgressCard, renderProgressCard, type CardChecklist, type ProgressCardState } from "./cards.ts";
import { TERMINAL_WINDOW_LINES, renderTerminalWindow } from "./terminal-window.ts";

/**
 * Coalescing floor between two edits of the SAME card. Deliberately tighter than
 * `ProgressCardService`'s 15s default — this card exists to feel like a live terminal, and 15s of
 * silence between scrolls would defeat that. 5s still comfortably respects Discord's edit rate
 * limit (5 requests/5s per route): at most one PATCH per card per interval, however many
 * dispatch/activity events land inside it.
 */
const DEFAULT_MIN_EDIT_INTERVAL_MS = 5_000;

/** Ceiling on tracked runs — matches `ProgressCardService`'s bound for the same reason. */
const MAX_TRACKED = 300;

export interface LiveProgressCardServiceOptions {
  gateway: Pick<DiscordGateway, "post" | "editMessage">;
  /** Durable anchor store, conventionally `<beckettDir>/live-progress-cards.json`. */
  statePath: string;
  /** Where the card lands; null = this run gets no live-progress card. */
  resolveChannel: (event: DispatchEvent) => string | null;
  /** A run's raw journal tail, most-recent last — `../progress/journal.ts#TicketJournal.readLines`. */
  readJournalLines: (runId: string, tail: number) => string[] | null;
  /** Same seam as `ProgressCardService.specReader` — the run's live `## Checklist` progress. */
  specReader?: (runId: string) => CardChecklist | null;
  logger?: Logger;
  now?: () => number;
  /** Floor between consecutive edits of one card. Default {@link DEFAULT_MIN_EDIT_INTERVAL_MS}. */
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

export class LiveProgressCardService {
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly minEditIntervalMs: number;
  private readonly schedule: (fn: () => void, ms: number) => { cancel(): void };
  private readonly records = new Map<string, CardRecord>();
  /** Per-run serialization: a post must persist its id before the next edit reads it. */
  private readonly inflight = new Map<string, Promise<void>>();
  private persisted: Map<string, PersistedCard> | null = null;

  constructor(private readonly opts: LiveProgressCardServiceOptions) {
    this.logger = opts.logger ?? rootLog.child("live-progress-card");
    this.now = opts.now ?? Date.now;
    this.minEditIntervalMs = opts.minEditIntervalMs ?? DEFAULT_MIN_EDIT_INTERVAL_MS;
    this.schedule =
      opts.schedule ??
      ((fn, ms) => {
        const timer = setTimeout(fn, Math.max(0, ms));
        timer.unref?.();
        return { cancel: () => clearTimeout(timer) };
      });
  }

  /**
   * Observe one dispatch event. Never rejects — a card is decoration on a durable timeline, and a
   * Discord hiccup must never reach the dispatch path that emitted the event.
   */
  observe(event: DispatchEvent): Promise<void> {
    try {
      const key = event.runId || event.runRef;
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
      this.logger.warn("live progress card observe failed", { run: event.runRef, error: String(error) });
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
    const checklist =
      this.opts.specReader?.(record.lastEvent.runId) ??
      (record.lastEvent.stage === "run:deploy" ? { done: 0, total: 0 } : null);
    const headerText = renderProgressCard(record.state, this.now(), checklist);
    // The window is LIVE only while the run is active: past this point the record is deleted (in
    // `finally` below) after ONE last delivery, so no further read/render ever happens for it —
    // the lines below are whatever the journal held at the instant the run went terminal.
    const lines = this.opts.readJournalLines(record.lastEvent.runId, TERMINAL_WINDOW_LINES) ?? [];
    const snapshot: LiveProgressCardSnapshot = {
      headerText,
      terminalWindow: renderTerminalWindow(lines),
      alert: record.state.alert,
      terminal: record.state.terminal,
    };
    const card = renderLiveProgressCard(snapshot);
    record.lastDeliveredAt = this.now();
    try {
      if (record.anchor) {
        try {
          await this.opts.gateway.editMessage(record.anchor.channelId, record.anchor.messageId, { card });
          return;
        } catch (error) {
          if (!(error instanceof DiscordUnknownMessageError)) {
            // Offline / rate limited / permissions: the next card carries the same full state.
            this.logger.debug("live progress card edit failed; folding into the next update", {
              run: record.state.ref,
              error: String(error),
            });
            return;
          }
          record.anchor = undefined;
          this.forget(key);
          if (record.repostedOnce) {
            this.logger.debug("live progress card was deleted twice; leaving it alone", { run: record.state.ref });
            return;
          }
          record.repostedOnce = true;
          this.logger.debug("live progress card was deleted; posting a replacement", { run: record.state.ref });
        }
      }
      const channelId = this.opts.resolveChannel(record.lastEvent);
      if (!channelId) {
        this.logger.debug("no channel for live progress card", { run: record.state.ref });
        return;
      }
      try {
        const messageId = await this.opts.gateway.post(channelId, "", {
          card,
          singleMessage: true,
          // The durable timeline is the dispatch bus's JSONL; never grow a Discord backlog for a
          // card a later render would restate anyway.
          queueIfOffline: false,
        });
        record.anchor = { channelId, messageId };
        this.remember(key, record);
      } catch (error) {
        this.logger.debug("live progress card post failed", { run: record.state.ref, error: String(error) });
      }
    } catch (error) {
      // Delivery must never reject: observe() and the enqueue chain both hang off this promise.
      this.logger.warn("live progress card delivery failed", { run: record.state.ref, error: String(error) });
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
      this.logger.warn("live progress card state write failed", {
        path: this.opts.statePath,
        error: (err as Error).message,
      });
    }
  }
}

export function createLiveProgressCardService(opts: LiveProgressCardServiceOptions): LiveProgressCardService {
  return new LiveProgressCardService(opts);
}
