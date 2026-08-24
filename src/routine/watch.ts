/**
 * Beckett — the `watch` routine action's runtime (`src/routine/watch.ts`)
 * =======================================================================================
 * Orchestrates one poll-and-maybe-fire round for a `watch` routine (issue #1) — the event-post
 * half of the model-news feed integration. Composed entirely from pure/injected pieces so the
 * decision logic is unit-testable without a network or a filesystem:
 *
 *   - {@link ../routine/model-news.ts} — fetch the feed, defensively; the qualification predicate.
 *   - {@link ../routine/rate-limit.ts} — the hard 1/hour + 3/24h cap.
 *   - {@link ../routine/watch-store.ts} — the durable seen-set + post history this module reads
 *     and mutates through the `stateStore` dependency.
 *
 * Two entry points:
 *   - {@link runWatchCycle} — the REAL round: mutates state, and on a qualifying hit either
 *     dispatches the agent lane for real or (dry-run) reports a preview line, never both.
 *   - {@link previewWatchCycle} — a READ-ONLY simulation against the CURRENTLY persisted state,
 *     for `beckett routine fire <id> --dry-run`: fetches the live feed (so the preview is real,
 *     not a guess) but never mutates the store, never posts, never dispatches an agent.
 *
 * {@link startWatchLoop} is the self-scheduling driver (modeled on `startRoutineScheduler`) that
 * calls `runWatchCycle` once per routine's `pollIntervalMinutes`, reading `enabled` live off the
 * store each tick — so `beckett routine disable <id>` takes effect on the very next tick, no
 * daemon restart required.
 */

import type { Logger } from "../types.ts";
import type { Routine } from "./types.ts";
import { RoutineStore } from "./store.ts";
import { WatchStateStore, type WatchPostRecord, type WatchRoutineState } from "./watch-store.ts";
import { isQualifyingItem, pickModelId, type ModelNewsFetchResult, type ModelNewsItem } from "./model-news.ts";
import { withinRateLimit } from "./rate-limit.ts";

/** How often the driver checks whether ANY watch routine is due — routines can poll less often
 *  than this, never more; a routine's own `pollIntervalMinutes` is what actually gates a poll. */
export const WATCH_LOOP_TICK_MS = 60_000;

export type WatchCycleStatus =
  | "seeded"
  | "feed-error"
  | "no-qualifying"
  | "rate-limited"
  | "posted"
  | "dry-run-posted"
  | "not-configured";

export interface WatchCycleResult {
  status: WatchCycleStatus;
  postedModelId?: string;
  /** Model ids that qualified this round but were NOT posted about (already-posted dedup, an
   *  extra qualifying item in the same round, or the rate limit) — logged, never queued. */
  droppedModelIds: string[];
  error?: string;
}

export interface WatchOrigin {
  channelId: string | null;
  requesterId: string | null;
}

export interface WatchDeps {
  stateStore: WatchStateStore;
  fetchFeed: (url: string) => Promise<ModelNewsFetchResult>;
  now: () => Date;
  /** Runs the SAME agent-lane path `daily-x-shitpost` uses: `agentId` authors the post from
   *  `agentInput`-as-subject, and the browser lane publishes it. Rejects on any failure. Takes
   *  `agentId` per call (rather than being bound once) so ONE `WatchDeps` — and one poll loop —
   *  can serve every `watch` routine, each naming its own agent. */
  dispatchAgent: (
    agentId: string,
    agentInput: string,
    opts: { channelId: string; requesterId: string; credsEntry: string | null },
  ) => Promise<void>;
  /** One short line to a Discord channel — used for the dry-run preview line only; a REAL post's
   *  confirmation rides the browser lane's own outcome report (issue #50), not this. */
  reportChannel: (channelId: string, text: string) => Promise<void>;
  /** Fallback origin (env-resolved `BECKETT_ROUTINE_CHANNEL_ID` / `DISCORD_OWNER_ID`), exactly
   *  like every other routine action. */
  defaultOrigin: () => WatchOrigin;
  logger: Logger;
  /**
   * Observability hook: every completed cycle stamps lastFiredAt; an actual agent-lane attempt
   * (or a missing origin at post time) also records ok/failed. Optional so feed/qualify unit
   * tests stay isolated from the routine store.
   */
  reportHealth?: (event: {
    routineId: string;
    at: Date;
    dispatch?: { ok: true } | { ok: false; err: unknown };
  }) => Promise<void>;
}

/** The instruction handed to the agent — the item's own data, not composed prose, so the agent's
 *  own research/voice/verification rules (in its prompt, not here) do the actual writing. */
export function buildAgentSubject(item: ModelNewsItem, modelId: string): string {
  const models = item.models.length ? item.models.join(", ") : modelId;
  return [
    "EVENT TRIGGER (not a scheduled lane): the model-news feed just reported a new model release.",
    "Decide, using your own research/voice/verification rules, whether this is worth a post — and",
    "if so, write it in your own words. Do not paste the feed summary below verbatim.",
    "",
    `Title: ${item.title || "(no title given)"}`,
    `Model id(s): ${models}`,
    `Published: ${item.publishedAt || "(unknown)"}`,
    `Source to verify before writing: ${item.source?.url || "(none given — verify independently)"}`,
    `Feed summary (context only, never verbatim): ${item.summary || "(none given)"}`,
  ].join("\n");
}

/** Pick the earliest-published qualifying item not already covered by `alreadyPosted` or by an
 *  earlier pick THIS round (same model announced via two feed items), dropping every other
 *  candidate's model id along the way — "extra qualifying items ... marked seen and logged as
 *  dropped rather than queued." */
function chooseCandidate(
  qualifying: ModelNewsItem[],
  alreadyPosted: ReadonlySet<string>,
): { chosen: ModelNewsItem | null; dropped: string[] } {
  const sorted = [...qualifying].sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
  let chosen: ModelNewsItem | null = null;
  const dropped: string[] = [];
  for (const item of sorted) {
    const modelId = pickModelId(item);
    if (alreadyPosted.has(modelId) || (chosen && pickModelId(chosen) === modelId)) {
      dropped.push(modelId);
      continue;
    }
    if (!chosen) chosen = item;
    else dropped.push(modelId);
  }
  return { chosen, dropped };
}

/** The post-history bucket a routine's mode reads/writes: dry-run and live never share caps. */
function bucketFor(posts: WatchPostRecord[], dryRun: boolean): WatchPostRecord[] {
  return posts.filter((p) => p.simulated === dryRun);
}

/**
 * Run one REAL poll-and-maybe-fire round. Always safe to call: a broken feed just logs and
 * returns `feed-error` with no state mutation beyond `lastPolledAt`; the cold-start round seeds
 * and returns without ever evaluating a single item for qualification.
 */
async function reportWatchHealth(
  routine: Routine,
  deps: WatchDeps,
  dispatch?: { ok: true } | { ok: false; err: unknown },
): Promise<void> {
  if (!deps.reportHealth) return;
  try {
    await deps.reportHealth({ routineId: routine.id, at: deps.now(), dispatch });
  } catch (err) {
    deps.logger.warn("model-news watch: health report failed", { routine: routine.id, error: String(err) });
  }
}

export async function runWatchCycle(routine: Routine, deps: WatchDeps): Promise<WatchCycleResult> {
  const action = routine.action;
  if (action.kind !== "watch") {
    throw new Error(`runWatchCycle called on a non-watch routine: ${routine.id}`);
  }
  const now = deps.now();
  const feed = await deps.fetchFeed(action.feedUrl);

  if (!feed.ok) {
    deps.logger.warn("model-news watch: feed unavailable, skipping round", {
      routine: routine.id,
      reason: feed.reason,
    });
    await deps.stateStore.update(routine.id, (s) => ({ ...s, lastPolledAt: now.toISOString() }));
    const result = { status: "feed-error" as const, droppedModelIds: [], error: feed.reason };
    await reportWatchHealth(routine, deps);
    return result;
  }

  const prior = await deps.stateStore.get(routine.id);

  // Cold start (or a state file that never got past this point last time): seed from the LIVE
  // feed and post NOTHING. This is the one behavior the whole feature fails without — a fresh
  // install must never treat everything currently in the feed as breaking news.
  if (!prior.seeded) {
    const seenIds = feed.items.map((it) => ({ id: it.id, firstSeenAt: now.toISOString() }));
    await deps.stateStore.update(routine.id, (s) => ({
      ...s,
      seeded: true,
      seenIds: [...s.seenIds, ...seenIds],
      lastPolledAt: now.toISOString(),
    }));
    deps.logger.info("model-news watch: cold start — seeded seen-set, posting nothing", {
      routine: routine.id,
      count: seenIds.length,
    });
    const seeded = { status: "seeded" as const, droppedModelIds: [] };
    await reportWatchHealth(routine, deps);
    return seeded;
  }

  const seenSet = new Set(prior.seenIds.map((s) => s.id));
  const newlySeen = feed.items
    .filter((it) => !seenSet.has(it.id))
    .map((it) => ({ id: it.id, firstSeenAt: now.toISOString() }));
  const qualifying = feed.items.filter((it) => isQualifyingItem(it, { seenIds: seenSet, now }));

  const persistSeen = () =>
    deps.stateStore.update(routine.id, (s) => ({
      ...s,
      seenIds: [...s.seenIds, ...newlySeen],
      lastPolledAt: now.toISOString(),
    }));

  if (qualifying.length === 0) {
    await persistSeen();
    const idle = { status: "no-qualifying" as const, droppedModelIds: [] };
    await reportWatchHealth(routine, deps);
    return idle;
  }

  const postsBucket = bucketFor(prior.posts, action.dryRun);
  const alreadyPosted = new Set(postsBucket.map((p) => p.modelId));
  const { chosen, dropped } = chooseCandidate(qualifying, alreadyPosted);

  if (!chosen) {
    await persistSeen();
    if (dropped.length) {
      deps.logger.info("model-news watch: qualifying item(s) dropped (model already posted)", {
        routine: routine.id,
        dropped,
      });
    }
    const idle = { status: "no-qualifying" as const, droppedModelIds: dropped };
    await reportWatchHealth(routine, deps);
    return idle;
  }

  if (!withinRateLimit(postsBucket, now)) {
    dropped.push(pickModelId(chosen));
    await persistSeen();
    deps.logger.info("model-news watch: rate limited, dropping this round's candidate(s)", {
      routine: routine.id,
      dropped,
    });
    const limited = { status: "rate-limited" as const, droppedModelIds: dropped };
    await reportWatchHealth(routine, deps);
    return limited;
  }

  if (dropped.length) {
    deps.logger.info("model-news watch: extra qualifying item(s) dropped this round", {
      routine: routine.id,
      dropped,
    });
  }

  const modelId = pickModelId(chosen);
  const origin = deps.defaultOrigin();
  const channelId = action.channelId ?? origin.channelId;
  const requesterId = action.requesterId ?? origin.requesterId;

  if (action.dryRun) {
    const preview = `[dry-run] model-news watch would post about ${modelId} — "${chosen.title}" (${chosen.source?.url ?? "no source url"})`;
    deps.logger.info(preview, { routine: routine.id });
    if (channelId) {
      try {
        await deps.reportChannel(channelId, preview);
      } catch (err) {
        deps.logger.warn("model-news watch: dry-run report failed", { routine: routine.id, error: String(err) });
      }
    }
    await deps.stateStore.update(routine.id, (s) => ({
      ...s,
      seenIds: [...s.seenIds, ...newlySeen],
      posts: [...s.posts, { modelId, postedAt: now.toISOString(), url: null, simulated: true }],
      lastPolledAt: now.toISOString(),
    }));
    const dry = { status: "dry-run-posted" as const, postedModelId: modelId, droppedModelIds: dropped };
    await reportWatchHealth(routine, deps);
    return dry;
  }

  if (!channelId || !requesterId) {
    await persistSeen();
    const missingOrigin = new Error(
      "routine dispatch needs an origin channel + requester " +
        "(set BECKETT_ROUTINE_CHANNEL_ID and DISCORD_OWNER_ID, or the routine's channelId/requesterId)",
    );
    deps.logger.warn("model-news watch: no origin channel/requester resolved, skipping fire", {
      routine: routine.id,
    });
    await reportWatchHealth(routine, deps, { ok: false, err: missingOrigin });
    throw missingOrigin;
  }

  try {
    await deps.dispatchAgent(action.agentId, buildAgentSubject(chosen, modelId), {
      channelId,
      requesterId,
      credsEntry: action.credsEntry ?? null,
    });
  } catch (err) {
    await persistSeen();
    deps.logger.warn("model-news watch: agent dispatch failed", { routine: routine.id, error: String(err) });
    await reportWatchHealth(routine, deps, { ok: false, err });
    throw err;
  }

  await deps.stateStore.update(routine.id, (s) => ({
    ...s,
    seenIds: [...s.seenIds, ...newlySeen],
    posts: [...s.posts, { modelId, postedAt: now.toISOString(), url: null, simulated: false }],
    lastPolledAt: now.toISOString(),
  }));
  const posted = { status: "posted" as const, postedModelId: modelId, droppedModelIds: dropped };
  await reportWatchHealth(routine, deps, { ok: true });
  return posted;
}

export interface WatchPreview {
  wouldPost: boolean;
  status: WatchCycleStatus;
  modelId: string | null;
  item: { title: string; models: string[]; sourceUrl: string | null; publishedAt: string } | null;
  droppedModelIds: string[];
  /** What would be handed to the agent — null unless `wouldPost`. */
  agentSubject: string | null;
  reason: string;
}

/**
 * A READ-ONLY simulation of one round against the CURRENTLY persisted seen-set/post-history:
 * fetches the live feed (so this reflects reality, not a guess) but never writes to the watch
 * store, never posts to Discord, never dispatches the agent. Backs `beckett routine fire <id>
 * --dry-run`, which — like every other routine's dry-run — must prove the wiring without any
 * side effect.
 */
export async function previewWatchCycle(
  routine: Routine,
  deps: Pick<WatchDeps, "fetchFeed" | "now" | "stateStore" | "defaultOrigin">,
): Promise<WatchPreview> {
  const action = routine.action;
  if (action.kind !== "watch") {
    throw new Error(`previewWatchCycle called on a non-watch routine: ${routine.id}`);
  }
  const now = deps.now();
  const feed = await deps.fetchFeed(action.feedUrl);
  if (!feed.ok) {
    return {
      wouldPost: false,
      status: "feed-error",
      modelId: null,
      item: null,
      droppedModelIds: [],
      agentSubject: null,
      reason: `feed unavailable: ${feed.reason}`,
    };
  }

  const state = await deps.stateStore.get(routine.id);
  if (!state.seeded) {
    return {
      wouldPost: false,
      status: "seeded",
      modelId: null,
      item: null,
      droppedModelIds: [],
      agentSubject: null,
      reason: `cold start — a real round would seed ${feed.items.length} item(s) as seen and post nothing`,
    };
  }

  const seenSet = new Set(state.seenIds.map((s) => s.id));
  const qualifying = feed.items.filter((it) => isQualifyingItem(it, { seenIds: seenSet, now }));
  if (qualifying.length === 0) {
    return {
      wouldPost: false,
      status: "no-qualifying",
      modelId: null,
      item: null,
      droppedModelIds: [],
      agentSubject: null,
      reason: "no unseen item in the feed right now is both newModel and published in the last 24h",
    };
  }

  const postsBucket = bucketFor(state.posts, action.dryRun);
  const alreadyPosted = new Set(postsBucket.map((p) => p.modelId));
  const { chosen, dropped } = chooseCandidate(qualifying, alreadyPosted);

  if (!chosen) {
    return {
      wouldPost: false,
      status: "no-qualifying",
      modelId: null,
      item: null,
      droppedModelIds: dropped,
      agentSubject: null,
      reason: "every qualifying item's model id has already been posted about",
    };
  }

  const modelId = pickModelId(chosen);
  if (!withinRateLimit(postsBucket, now)) {
    return {
      wouldPost: false,
      status: "rate-limited",
      modelId,
      item: {
        title: chosen.title,
        models: chosen.models,
        sourceUrl: chosen.source?.url ?? null,
        publishedAt: chosen.publishedAt,
      },
      droppedModelIds: [...dropped, modelId],
      agentSubject: null,
      reason: "the hourly/24h event-post cap is already reached",
    };
  }

  return {
    wouldPost: true,
    status: "posted",
    modelId,
    item: {
      title: chosen.title,
      models: chosen.models,
      sourceUrl: chosen.source?.url ?? null,
      publishedAt: chosen.publishedAt,
    },
    droppedModelIds: dropped,
    agentSubject: buildAgentSubject(chosen, modelId),
    reason: "would dispatch the agent lane now",
  };
}

export interface WatchLoop {
  tick(): Promise<void>;
  stop(): void;
}

export interface WatchLoopDeps {
  /** Read live each tick, so `enable`/`disable` take effect with no daemon restart. */
  routineStore: RoutineStore;
  watchDeps: WatchDeps;
  now?: () => Date;
  intervalMs?: number;
}

/**
 * The self-scheduling driver (modeled on `startRoutineScheduler`): each tick, for every enabled
 * `watch` routine whose `pollIntervalMinutes` has elapsed since its last poll (or that has never
 * polled at all — the cold-start round runs on the very first tick, not after a full interval),
 * runs one real cycle. A crashing routine's cycle is caught and logged, never taking the loop
 * down or blocking a sibling routine's poll.
 */
export function startWatchLoop(deps: WatchLoopDeps): WatchLoop {
  const now = deps.now ?? (() => new Date());
  const interval = deps.intervalMs ?? WATCH_LOOP_TICK_MS;

  async function tick(): Promise<void> {
    let routines: Routine[];
    try {
      routines = await deps.routineStore.list();
    } catch (err) {
      deps.watchDeps.logger.warn("model-news watch tick could not read the routine store", { error: String(err) });
      return;
    }
    for (const routine of routines) {
      if (routine.action.kind !== "watch" || !routine.enabled) continue;
      try {
        const state = await deps.watchDeps.stateStore.get(routine.id);
        const dueAt = state.lastPolledAt
          ? Date.parse(state.lastPolledAt) + routine.action.pollIntervalMinutes * 60_000
          : -Infinity;
        if (now().getTime() >= dueAt) {
          await runWatchCycle(routine, deps.watchDeps);
        }
      } catch (err) {
        deps.watchDeps.logger.warn("model-news watch cycle failed", { routine: routine.id, error: String(err) });
      }
    }
  }

  const timer = setInterval(() => void tick().catch(() => {}), interval);
  timer.unref?.();

  return {
    tick,
    stop() {
      clearInterval(timer);
    },
  };
}
