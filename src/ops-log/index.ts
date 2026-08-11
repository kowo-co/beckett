/**
 * Beckett — Discord ops-log mirror (`src/ops-log/index.ts`, issue #231)
 * =======================================================================================
 * Owner ask: "log everything in the ops channel … robust, expressive, legible." Registers one
 * `addLogSink` (`src/log.ts`) that renders every admitted daemon log event into a legible line
 * (`render.ts`), batches lines into one Discord message per ~2s window (`batch.ts`), and drives
 * a turn-in-flight heartbeat off the `turn start` / `turn done` / `turn failed` events
 * (`heartbeat.ts`). Wired from `src/shell/main.ts`, active only when `[ops_log] enabled` is true
 * AND a `channel_id` is configured.
 *
 * Fails open end to end: `addLogSink`'s own recursion guard (`src/log.ts`) keeps a sink that
 * logs from recursing into itself mid-dispatch, this module additionally EXCLUDES its own
 * component from ever being rendered/queued (belt-and-suspenders against the async case — a
 * batch-flush failure logged from a `setTimeout` callback, which is NOT inside the synchronous
 * sink-dispatch the built-in guard covers), and the batcher never lets a dead Discord channel
 * throw back into the logging path.
 */
import { addLogSink, log as rootLog, type LogRecord } from "../log.ts";
import type { Config, Logger, LogLevel } from "../types.ts";
import { renderEventLine } from "./render.ts";
import { createOpsLogBatcher, type OpsLogBatcher } from "./batch.ts";
import { createTurnHeartbeat, type TurnHeartbeat } from "./heartbeat.ts";

/** This module's OWN logger component. Records from it are never mirrored — no feedback loop. */
export const OPS_LOG_COMPONENT = "ops-log";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** `a === b` or `a` ends with a `.`-delimited `b` — tolerant of however many `.child(...)` calls
 *  a component's real runtime name picked up (see `render.ts`'s header for why that varies). */
export function componentMatches(component: string, name: string): boolean {
  return component === name || component.endsWith(`.${name}`);
}

/**
 * Whether the mirror should run at all: `[ops_log] enabled` AND a `channel_id` (issue #231
 * deliverable 4 — "only active when enabled && channel_id set"). A pure predicate so
 * `src/shell/main.ts`'s wiring and this module's own tests share one definition of "on".
 */
export function opsLogEnabled(config: Config["ops_log"]): boolean {
  return config.enabled && config.channel_id.trim().length > 0;
}

export interface OpsLogSinkOptions {
  config: Config["ops_log"];
  /** Post one message to the configured channel. Real wiring: `DiscordGateway.post`. */
  post: (channelId: string, content: string) => Promise<unknown>;
  logger?: Logger;
  now?: () => number;
  /** Timer seam (tests) — threaded into both the batcher and the heartbeat. */
  schedule?: (fn: () => void, ms: number) => { cancel(): void };
}

export interface OpsLogSink {
  /** Underlying pieces, exposed for tests that want to drive/inspect them directly. */
  readonly batcher: OpsLogBatcher;
  readonly heartbeat: TurnHeartbeat;
  /** Unregister the log sink, stop the heartbeat timer, and flush any queued lines. */
  stop(): Promise<void>;
}

/**
 * Register the ops-log mirror. Callers gate this on `config.ops_log.enabled &&
 * config.ops_log.channel_id` themselves (`src/shell/main.ts`) — this constructor does no
 * gating of its own, so tests can build one against a fake config/poster freely.
 */
export function startOpsLogSink(opts: OpsLogSinkOptions): OpsLogSink {
  const logger = (opts.logger ?? rootLog).child(OPS_LOG_COMPONENT);
  const cfg = opts.config;
  const channelId = cfg.channel_id;
  const minLevel = LEVEL_ORDER[cfg.level] ?? LEVEL_ORDER.info;
  const debugAllowlist = cfg.include_debug_components;

  const batcher = createOpsLogBatcher({
    post: async (content) => {
      await opts.post(channelId, content);
    },
    logger,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.schedule ? { schedule: opts.schedule } : {}),
  });

  const heartbeat = createTurnHeartbeat({
    push: (line) => batcher.push(line),
    logger,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.schedule ? { schedule: opts.schedule } : {}),
  });

  function admitted(rec: LogRecord): boolean {
    if (LEVEL_ORDER[rec.level] >= minLevel) return true;
    return debugAllowlist.some((c) => componentMatches(rec.component, c));
  }

  const unregister = addLogSink((rec) => {
    // No feedback loop (issue #231 deliverable 2): never render/queue/track our own lines.
    if (componentMatches(rec.component, OPS_LOG_COMPONENT)) return;

    // Turn-lifecycle tracking feeds the heartbeat regardless of the mirror's level filter —
    // the heartbeat's job (knowing whether a turn is live) is independent of what gets posted.
    if (rec.msg === "turn start") heartbeat.turnStarted();
    else if (rec.msg === "turn done" || rec.msg === "turn failed") heartbeat.turnEnded();

    if (!admitted(rec)) return;
    const line = renderEventLine(rec);
    heartbeat.noteEvent(line);
    batcher.push(line);
  });

  return {
    batcher,
    heartbeat,
    async stop() {
      unregister();
      heartbeat.stop();
      await batcher.flushNow();
    },
  };
}
