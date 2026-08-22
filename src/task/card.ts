/**
 * One self-editing Discord card per task (#104).
 *
 * A task's progress used to arrive as a string of separate messages — queued, running, review,
 * done — one ping per transition. This owns the single embed that replaces that churn: posted when
 * the task is filed and edited in place for the rest of its life, so six updates become one message
 * that changes. It carries ONLY machine state; genuine milestones spoken in Beckett's voice stay as
 * ordinary messages the concierge sends separately.
 *
 * The edit/repost loop mirrors {@link ../status/service.ts StatusDashboardService}: edit the stored
 * message, and repost exactly once — never in a loop — when Discord reports the target was deleted.
 * Every other failure (offline, rate limited, permission) skips this tick and waits for the next
 * lifecycle change, so a bad gateway can never spin.
 */
import { renderTaskCard } from "../discord/cards.ts";
import { DiscordMessageEditError, DiscordUnknownMessageError, type DiscordGateway } from "../discord/gateway.ts";
import { log as rootLog } from "../log.ts";
import type { Logger } from "../types.ts";
import { taskCardSnapshot } from "./status.ts";
import type { TaskStore, WorkTask } from "./store.ts";

export interface TaskCardServiceOptions {
  store: Pick<TaskStore, "getTask" | "setCard">;
  gateway: Pick<DiscordGateway, "post" | "editMessage" | "deleteMessage">;
  /** Where a task's card is FIRST posted (attached thread → grounded workspace → origin channel). */
  resolveChannel: (task: WorkTask) => string | null;
  logger?: Logger;
}

/**
 * The renderer generation the service posts. Discord's Components V2 flag is immutable per
 * message, so a card posted WITHOUT it (a pre-versioning legacy embed, `v` absent) can never be
 * edited into the V2 shape — {@link TaskCardService.render} deletes and reposts it once instead.
 */
const CARD_VERSION = 2;

export class TaskCardService {
  private readonly logger: Logger;
  /** Per-task serialization: the initial post must persist its id before the next edit reads it. */
  private readonly inflight = new Map<number, Promise<void>>();

  constructor(private readonly opts: TaskCardServiceOptions) {
    this.logger = opts.logger ?? rootLog.child("task.card");
  }

  /**
   * Bring task #`taskNumber`'s card into line with the store: post it if it has none yet, otherwise
   * edit it in place. Never throws — a failure is logged and retried on the next lifecycle change.
   * Calls for the same task are serialized so a filing's post and a fast poll's edit cannot race.
   */
  refresh(taskNumber: number): Promise<void> {
    const prior = this.inflight.get(taskNumber) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(() => this.render(taskNumber));
    this.inflight.set(taskNumber, next);
    void next.finally(() => {
      if (this.inflight.get(taskNumber) === next) this.inflight.delete(taskNumber);
    });
    return next;
  }

  /**
   * Post a brand-new card for a task at an explicit channel, taking over as the canonical card
   * from now on — used when a task moves into a thread just created for it (#112), where editing
   * the old card in place would leave the new room with no live state at all. Unlike {@link
   * refresh}, this throws on failure: the caller is an ephemeral component reply that must report
   * the failure to the person who clicked, not silently retry on the next lifecycle tick.
   */
  postFresh(taskNumber: number, channelId: string): Promise<void> {
    const prior = this.inflight.get(taskNumber) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(async () => {
      const task = this.opts.store.getTask(taskNumber);
      if (!task) throw new Error(`no such task: #${taskNumber}`);
      await this.postAt(task, channelId);
    });
    this.inflight.set(taskNumber, next);
    // Unlike refresh's `next` (which never rejects), this one can — the cleanup chain needs its
    // own catch so an unawaited rejection here doesn't surface as an unhandled promise rejection
    // alongside the one the caller is (or isn't) awaiting on the returned `next`.
    void next
      .finally(() => {
        if (this.inflight.get(taskNumber) === next) this.inflight.delete(taskNumber);
      })
      .catch(() => {});
    return next;
  }

  private async render(taskNumber: number): Promise<void> {
    const task = this.opts.store.getTask(taskNumber);
    if (!task) return;
    const snapshot = taskCardSnapshot(task);
    const card = renderTaskCard(snapshot);

    // A stale-generation card can never be edited into the current shape (the V2 flag is
    // immutable), so it is replaced outright: delete the old message best-effort, then post fresh.
    if (task.card && task.card.v !== CARD_VERSION) {
      try {
        await this.opts.gateway.deleteMessage(task.card.channelId, task.card.messageId);
      } catch (error) {
        this.logger.debug("legacy card delete failed; posting replacement anyway", {
          task: taskNumber,
          error: String(error),
        });
      }
      await this.repost(task, task.card.channelId);
      return;
    }

    if (task.card) {
      try {
        await this.opts.gateway.editMessage(task.card.channelId, task.card.messageId, { card });
        return;
      } catch (error) {
        // Deleted target is the ONE repost path; everything else (offline, rate limit, permission)
        // is skipped this tick and picked up on the next change, so retries never loop.
        if (!(error instanceof DiscordUnknownMessageError)) {
          if (isPermanentFailure(error)) {
            // A 4xx on the payload shape (e.g. 400 Invalid Form Body) never clears on retry: every
            // subsequent render sends the same rejected card and fails identically, forever. Log it
            // loud, with Discord's response body, so the next one takes minutes to find, not months.
            this.logger.error("task card edit rejected by Discord; this payload will keep failing", {
              task: taskNumber,
              channelId: task.card.channelId,
              messageId: task.card.messageId,
              error: String(error),
              response: discordResponseBody(error),
            });
          } else {
            this.logger.warn("task card edit failed; will retry on next change", {
              task: taskNumber,
              error: String(error),
            });
          }
          return;
        }
        this.logger.warn("task card was deleted; posting replacement", {
          task: taskNumber,
          channelId: task.card.channelId,
          messageId: task.card.messageId,
        });
      }
    }

    // Reuse the deleted card's channel so the replacement lands where the task already reported;
    // only a task that never had a card resolves a fresh destination.
    const channelId = task.card?.channelId ?? this.opts.resolveChannel(task);
    if (!channelId) {
      this.logger.debug("task has no channel for a card; skipping", { task: taskNumber });
      return;
    }
    await this.repost(task, channelId);
  }

  /** Post + persist a fresh card, logging (never throwing) on failure. */
  private async repost(task: WorkTask, channelId: string): Promise<void> {
    try {
      await this.postAt(task, channelId);
    } catch (error) {
      if (isPermanentFailure(error)) {
        // A permanent 4xx (bad payload, missing channel) fails identically on every future render;
        // surface it loud with the response body rather than the misleading "will retry" warning.
        this.logger.error("task card post rejected by Discord; this payload will keep failing", {
          task: task.number,
          channelId,
          error: String(error),
          response: discordResponseBody(error),
        });
      } else {
        this.logger.warn("task card post failed; will retry on next change", {
          task: task.number,
          channelId,
          error: String(error),
        });
      }
    }
  }

  /** The one post+persist funnel behind both a fresh post ({@link render}) and {@link postFresh}. */
  private async postAt(task: WorkTask, channelId: string): Promise<void> {
    const snapshot = taskCardSnapshot(task);
    const messageId = await this.opts.gateway.post(channelId, "", {
      card: renderTaskCard(snapshot),
      singleMessage: true,
      queueIfOffline: false,
    });
    await this.opts.store.setCard(task.number, { channelId, messageId, v: CARD_VERSION });
  }
}

/**
 * A rejection the identical render will hit forever — a payload-shape or authorization 4xx —
 * rather than offline / 429 rate limit / 403 permission, which a later tick may clear. The edit
 * path arrives already typed (a generic {@link DiscordMessageEditError} kind `failed` is the
 * permanent bucket; permission/transient are their own kinds); the post path throws the raw REST
 * error, so its HTTP status is read directly.
 */
function isPermanentFailure(error: unknown): boolean {
  if (error instanceof DiscordMessageEditError) return error.kind === "failed";
  const status = (error as { status?: unknown } | null | undefined)?.status;
  const code = typeof status === "number" ? status : typeof status === "string" ? Number(status) : NaN;
  return Number.isFinite(code) && code >= 400 && code < 500 && code !== 429 && code !== 403;
}

/**
 * Discord's parsed JSON response behind a failure, for the error log. discord.js exposes it as
 * `.rawError` (the body that names the rejection, e.g. `{ code: 50035, errors: {…} }`); the typed
 * edit errors wrap that original REST error as `.cause`, so reach through both.
 */
function discordResponseBody(error: unknown): string {
  const source = error instanceof DiscordMessageEditError ? error.cause : error;
  const raw = (source as { rawError?: unknown } | null | undefined)?.rawError;
  if (raw !== undefined) {
    try {
      return JSON.stringify(raw);
    } catch {
      return String(raw);
    }
  }
  return String(source ?? error);
}
