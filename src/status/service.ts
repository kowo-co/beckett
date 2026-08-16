/** Durable, single-message status dashboard update loop. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { renderStatusDashboardEmbed } from "../discord/status.ts";
import { DiscordUnknownMessageError, type DiscordGateway } from "../discord/gateway.ts";
import { log as rootLog } from "../log.ts";
import type { Logger } from "../types.ts";
import type { StatusDashboardSnapshot } from "./types.ts";

export const STATUS_DASHBOARD_INTERVAL_MS = 60_000;

/** The persisted id lives directly in the Beckett state directory, alongside other daemon state. */
export function statusDashboardMessagePath(stateDir: string): string {
  return join(stateDir, "status-dashboard-message.json");
}

export interface StatusDashboardServiceOptions {
  gateway: Pick<DiscordGateway, "post" | "editMessage">;
  /**
   * Where the single dashboard message lives. `null` (the staging daemon, #141, whose cards channel
   * is `disabled`) keeps the cycle running — presence still updates — but posts nothing to
   * Discord, so DEV never narrates into a prod channel.
   */
  channelId: string | null;
  statePath: string;
  collectSnapshot: () => Promise<StatusDashboardSnapshot>;
  logger?: Logger;
  intervalMs?: number;
}

/**
 * Owns exactly one Discord status message. Every cycle is isolated: a bad collector or gateway
 * only loses that update, never the next interval tick.
 */
export class StatusDashboardService {
  private readonly logger: Logger;
  private readonly intervalMs: number;
  private messageId: string | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly opts: StatusDashboardServiceOptions) {
    this.logger = opts.logger ?? rootLog.child("status.dashboard");
    this.intervalMs = opts.intervalMs ?? STATUS_DASHBOARD_INTERVAL_MS;
    this.messageId = readMessageId(opts.statePath, this.logger);
  }

  /** Render immediately, then update the same message every 60 seconds. */
  async start(): Promise<void> {
    if (this.timer) return;
    await this.runCycle();
    this.timer = setInterval(() => { void this.runCycle(); }, this.intervalMs);
    this.timer.unref?.();
    this.logger.info("status dashboard started", { channelId: this.opts.channelId, intervalMs: this.intervalMs });
  }

  /** Stop future updates. An already-running cycle remains contained and cannot reject outward. */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.logger.info("status dashboard stopped", { channelId: this.opts.channelId });
  }

  /** Public for deterministic integration tests and harmless manual update requests. */
  async runCycle(): Promise<void> {
    if (this.running) {
      this.logger.warn("status dashboard cycle skipped; prior cycle is still running");
      return;
    }
    this.running = true;
    try {
      // Always collect (its side effect updates presence), then render. With no channel configured
      // (staging), stop here — the snapshot ran, but nothing is posted/edited.
      const embed = renderStatusDashboardEmbed(await this.opts.collectSnapshot());
      if (!this.opts.channelId) return;
      if (this.messageId) {
        try {
          await this.opts.gateway.editMessage(this.opts.channelId, this.messageId, { embeds: [embed] });
          return;
        } catch (error) {
          // This typed branch, rather than text matching, is the only repost path.
          if (!(error instanceof DiscordUnknownMessageError)) throw error;
          this.logger.warn("status dashboard message was deleted; posting replacement", {
            channelId: this.opts.channelId,
            messageId: this.messageId,
          });
          this.messageId = null;
        }
      }
      const messageId = await this.opts.gateway.post(this.opts.channelId, "", {
        embeds: [embed],
        singleMessage: true,
        queueIfOffline: false,
      });
      this.messageId = messageId;
      persistMessageId(this.opts.statePath, messageId);
    } catch (error) {
      // The interval callback never awaits this promise; containment here prevents unhandled rejections.
      this.logger.warn("status dashboard cycle failed; skipping update", { error: String(error) });
    } finally {
      this.running = false;
    }
  }
}

function readMessageId(path: string, logger: Logger): string | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { messageId?: unknown };
    return typeof value.messageId === "string" && value.messageId ? value.messageId : null;
  } catch (error) {
    logger.warn("status dashboard message state unreadable; posting a new message", { path, error: String(error) });
    return null;
  }
}

function persistMessageId(path: string, messageId: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ messageId }, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export function createStatusDashboardService(opts: StatusDashboardServiceOptions): StatusDashboardService {
  return new StatusDashboardService(opts);
}
