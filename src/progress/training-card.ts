/**
 * Beckett — the training progress card (`src/progress/training-card.ts`)
 * =======================================================================================
 * The posting loop for `./training-source.ts`'s file-tailed progress: a single self-editing
 * Components V2 card per configured source, refreshed on a plain 60s timer — there is no
 * `DispatchEvent` to drive this off, since a systemd --user unit is not a Beckett run. Structured
 * the same way `../status/service.ts` structures the status dashboard (durable single-message
 * anchor, typed-deleted-message repost, never throw out of a cycle), generalized to N sources
 * because a card is keyed by the source's `unit`, not hardcoded to one channel/message.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { renderTrainingProgressCard, type TrainingProgressCardSnapshot } from "../discord/cards.ts";
import { DiscordUnknownMessageError, type DiscordGateway } from "../discord/gateway.ts";
import { log as rootLog } from "../log.ts";
import type { Logger } from "../types.ts";
import { renderTerminalWindow } from "./terminal-window.ts";
import {
  readFileTailProgress,
  type FileTailProgressSnapshot,
  type FileTailProgressSourceConfig,
  type TrainingStats,
} from "./training-source.ts";

export const TRAINING_PROGRESS_INTERVAL_MS = 60_000;

/** The persisted anchors live directly in the Beckett state directory, keyed by source unit. */
export function trainingProgressCardsPath(stateDir: string): string {
  return join(stateDir, "training-progress-cards.json");
}

// =======================================================================================
// Text rendering — pure, no fs/Discord
// =======================================================================================

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${Math.round(tokens)}`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function trendText(stats: TrainingStats): string {
  if (stats.firstAvgLoss === null) return `recent window avg ${stats.recentAvgLoss.toFixed(3)}`;
  const arrow = stats.recentAvgLoss <= stats.firstAvgLoss ? "↓" : "↑";
  return `recent window avg ${stats.recentAvgLoss.toFixed(3)} vs first window ${stats.firstAvgLoss.toFixed(3)} ${arrow}`;
}

/**
 * The card's status line. Active-with-data is the rich render (step/loss/trend/tokens/rate/ETA);
 * active-with-no-data-yet and inactive both degrade honestly instead of guessing — an inactive
 * unit NEVER renders the live fields (tok/s, ETA) as if they still applied.
 */
export function renderTrainingHeaderText(snapshot: FileTailProgressSnapshot, tokenBudget: number): string {
  if (!snapshot.active) {
    const last = snapshot.stats
      ? ` — last observed step ${snapshot.stats.latest.step}, ${formatTokens(snapshot.stats.latest.tokensSeen)} tokens`
      : "";
    return `⚫ **${snapshot.label}** · stopped — the systemd unit is not active${last}`;
  }
  if (!snapshot.stats) return `▸ **${snapshot.label}** · active — no step data yet`;
  const { latest, tokensPct, progressBar, etaMs } = snapshot.stats;
  const lines = [
    `🔵 **${snapshot.label}** · step ${latest.step} · loss ${latest.loss.toFixed(4)} (${trendText(snapshot.stats)})`,
    `${progressBar} ${tokensPct.toFixed(1)}% · ${formatTokens(latest.tokensSeen)} / ${formatTokens(tokenBudget)} tokens`,
    `${latest.tokensPerS.toFixed(1)} tok/s · elapsed ${formatDuration(latest.elapsedS * 1_000)} · ETA ${etaMs === null ? "unknown" : formatDuration(etaMs)}`,
  ];
  return lines.join("\n");
}

// =======================================================================================
// The service
// =======================================================================================

export interface TrainingProgressCardServiceOptions {
  gateway: Pick<DiscordGateway, "post" | "editMessage">;
  /** Durable anchor store, conventionally `<beckettDir>/training-progress-cards.json`. */
  statePath: string;
  /** One entry per file-tailed process; an empty list makes the service a no-op. */
  sources: FileTailProgressSourceConfig[];
  logger?: Logger;
  intervalMs?: number;
  /** Test seam — forwarded to `readFileTailProgress` for every source on every cycle. */
  isUnitActive?: (unit: string) => boolean;
}

interface PersistedAnchor {
  channelId: string;
  messageId: string;
}

/** Owns one Discord message per source. Every cycle is isolated: a bad source only loses its own update. */
export class TrainingProgressCardService {
  private readonly logger: Logger;
  private readonly intervalMs: number;
  private readonly anchors: Map<string, PersistedAnchor>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly opts: TrainingProgressCardServiceOptions) {
    this.logger = opts.logger ?? rootLog.child("training-progress-card");
    this.intervalMs = opts.intervalMs ?? TRAINING_PROGRESS_INTERVAL_MS;
    this.anchors = readAnchors(opts.statePath, this.logger);
  }

  /** Render immediately, then update every source's card on the interval. A no-op with zero sources. */
  async start(): Promise<void> {
    if (this.timer || this.opts.sources.length === 0) return;
    await this.runCycle();
    this.timer = setInterval(() => { void this.runCycle(); }, this.intervalMs);
    this.timer.unref?.();
    this.logger.info("training progress card started", { sources: this.opts.sources.length, intervalMs: this.intervalMs });
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.logger.info("training progress card stopped");
  }

  /** Public for deterministic tests. Never rejects — a source failure must not sink the others. */
  async runCycle(): Promise<void> {
    if (this.running) {
      this.logger.warn("training progress card cycle skipped; prior cycle is still running");
      return;
    }
    this.running = true;
    try {
      for (const source of this.opts.sources) await this.deliver(source);
    } finally {
      this.running = false;
    }
  }

  private async deliver(source: FileTailProgressSourceConfig): Promise<void> {
    try {
      const snapshot = readFileTailProgress(source, { isUnitActive: this.opts.isUnitActive });
      const cardSnapshot: TrainingProgressCardSnapshot = {
        headerText: renderTrainingHeaderText(snapshot, source.tokenBudget),
        terminalWindow: renderTerminalWindow(snapshot.consoleLines),
        active: snapshot.active,
      };
      const card = renderTrainingProgressCard(cardSnapshot);
      const anchor = this.anchors.get(source.unit);
      if (anchor) {
        try {
          await this.opts.gateway.editMessage(anchor.channelId, anchor.messageId, { card });
          return;
        } catch (error) {
          if (!(error instanceof DiscordUnknownMessageError)) {
            this.logger.debug("training progress card edit failed; will retry next cycle", {
              unit: source.unit, error: String(error),
            });
            return;
          }
          this.anchors.delete(source.unit);
          this.save();
          this.logger.debug("training progress card was deleted; posting a replacement", { unit: source.unit });
        }
      }
      try {
        const messageId = await this.opts.gateway.post(source.channelId, "", {
          card, singleMessage: true, queueIfOffline: false,
        });
        this.anchors.set(source.unit, { channelId: source.channelId, messageId });
        this.save();
      } catch (error) {
        this.logger.debug("training progress card post failed", { unit: source.unit, error: String(error) });
      }
    } catch (error) {
      // A cycle must never reject: the interval callback doesn't await it, and one source's bug
      // must not block every other source's card.
      this.logger.warn("training progress card cycle failed for source", { unit: source.unit, error: String(error) });
    }
  }

  private save(): void {
    persistAnchors(this.opts.statePath, this.anchors, this.logger);
  }
}

function readAnchors(path: string, logger: Logger): Map<string, PersistedAnchor> {
  const anchors = new Map<string, PersistedAnchor>();
  try {
    if (!existsSync(path)) return anchors;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      version?: number;
      anchors?: Record<string, Partial<PersistedAnchor>>;
    };
    if (!parsed || parsed.version !== 1 || !parsed.anchors) return anchors;
    for (const [unit, value] of Object.entries(parsed.anchors)) {
      if (!value || typeof value.channelId !== "string" || typeof value.messageId !== "string") continue;
      anchors.set(unit, { channelId: value.channelId, messageId: value.messageId });
    }
  } catch (error) {
    // A torn or hand-edited store is not worth a boot failure: the worst case is a fresh card.
    logger.warn("training progress card state unreadable; starting fresh", { path, error: String(error) });
  }
  return anchors;
}

function persistAnchors(path: string, anchors: Map<string, PersistedAnchor>, logger: Logger): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, anchors: Object.fromEntries(anchors) }, null, 2));
    renameSync(tmp, path);
  } catch (err) {
    // Fail open: a lost anchor costs one duplicate card after a restart, not a dropped update.
    logger.warn("training progress card state write failed", { path, error: (err as Error).message });
  }
}

export function createTrainingProgressCardService(opts: TrainingProgressCardServiceOptions): TrainingProgressCardService {
  return new TrainingProgressCardService(opts);
}
