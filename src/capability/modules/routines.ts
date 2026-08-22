/**
 * Beckett v6 — the routines extension (`src/capability/modules/routines.ts`)
 * =======================================================================================
 * Phase 3b of the v6 migration (docs/v6-architecture.md §6): the routines organ — named
 * recurring tasks with HUMANIZED fire times (issue #62) — on the extension contract,
 * following the Phase 2 browser.ts shape. This is the first organ whose `lifecycle.start`
 * runs a BACKGROUND LOOP under registry orchestration, and the first `startPhase: "late"`
 * organ: a firing routine dispatches INTO the live system (agent registry/runner + the
 * background browser lane), so its cron loop must arm only after the whole system is up —
 * the sanctioned late `startAll` position in `shell/main.ts`.
 *
 *   - `init` builds the durable {@link RoutineStore} and the scheduler's deps INERT — no
 *     interval is armed, nothing ticks. The CLI process registers this extension too (for
 *     the verb projection) but never runs any lifecycle hook.
 *   - `start` (late sweep) arms the cron loop via `startRoutineScheduler` — whose internals
 *     are untouched by this migration; only its call site moved here — plus the 5s post-boot
 *     prime tick, verbatim from the old boot wiring. Re-entry is a no-op (no double interval).
 *   - `stop` is idempotent: clears the prime, stops the loop, and allows a clean re-start.
 *     It rides the registry teardown sweep in `shell/main.ts` — AFTER the pollers stop, a
 *     sanctioned beat later than the old hand-wired first-line stop (a cron clearInterval
 *     there is accepted; per-period idempotency protects against any straggler tick).
 *   - `health` reports loop liveness, the routine census, and the next concrete fire.
 *
 * The dispatcher closure moved here from `shell/main.ts` byte-identically; its dependencies
 * (browser agent, agent registry/runner, the env-resolved fallback origin) are injected as
 * LAZY accessors resolved at FIRE time — the daemon constructs some of them after the
 * extension registers, and the late start guarantees they exist before the first fire.
 *
 * The CLI `routine` verb IS carried here (like quick's — its body binds no concierge state)
 * and projects into its existing `cli/beckett.ts` spine slot via `asCapability`, so the
 * pinned help token and every usage/failure string stay byte-identical. The concierge's
 * `routine.fire` bus command body stays in the concierge (it binds `routineOps`); only its
 * backing `fire()` is re-sourced from this extension's scheduler accessor.
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ActionClass, type Extension, type ExtensionContext } from "../../ext/contract.ts";
import { RoutineStore } from "../../routine/store.ts";
import {
  startRoutineScheduler,
  type RoutineScheduler,
  type RoutineSchedulerDeps,
} from "../../routine/scheduler.ts";
import { buildDispatchPlan, browserActionTargetsXSocial, type RoutineDispatchPlan } from "../../routine/plan.ts";
import { nextFireAt, isValidTimeZone } from "../../routine/schedule.ts";
import { WeekdaySchema, type Cadence, type Routine, type RoutineAction } from "../../routine/types.ts";
import { WatchStateStore } from "../../routine/watch-store.ts";
import { fetchModelNewsFeed } from "../../routine/model-news.ts";
import {
  runWatchCycle,
  previewWatchCycle,
  startWatchLoop,
  type WatchDeps,
  type WatchLoop,
  type WatchLoopDeps,
} from "../../routine/watch.ts";
import { defaultDepsUpdateDeps, runDepsUpdate } from "../../ops/deps-update.ts";
import { defaultProactiveSweepDeps, runProactiveSweep } from "../../ops/proactive-sweep.ts";
import { PROACTIVE_SWEEP_ID, type BuiltinRoutineOverrides } from "../../routine/builtins.ts";
import { freeTimeDeferReason } from "../../freetime/gate.ts";
import { formatWeeklyBill, readSpendLedger } from "../../spend.ts";
import { defaultRepoRoot } from "../../version/index.ts";
import { loadIdentity } from "../../agency/index.ts";
import { resolveSelfProjectOwner } from "../../github/owner.ts";
import type { AgentDefinition, AgentRunner } from "../../agent/index.ts";
import { extractPostText, composeXPostBrowserTask } from "../../agent/invoke.ts";
import { X_SOCIAL_ACCOUNT, SOCIAL_MEDIA_AGENT_ID } from "../../agent/builtins.ts";
import { needsGroundingSources, GROUNDING_UNAVAILABLE_NOTE } from "../../routine/social-grounding.ts";
import type { GroundingVerdict, GroundingVerifier } from "../../routine/social-verify.ts";
import {
  chillTransform,
  type ChilltextConfig,
  type ChillTransformInput,
  type ChillTransformResult,
} from "../../chilltext.ts";
import type { BrowserAgent } from "../../browser/agent.ts";
import { callBus } from "../../shell/control-bus.ts";
import { fail, out, parse } from "../../cli/io.ts";

/**
 * What the daemon injects beyond {@link ExtensionContext}: the dispatch closure's
 * dependencies, as LAZY accessors resolved at fire time (the same DI spirit as browser.ts's
 * keychain/onQuestion/onOutcome, made lazy because the daemon constructs the agent
 * registry/runner AFTER the extension registers — the late start keeps fires behind them).
 * All optional: the CLI registers with `{}` (its process never starts the scheduler; a real
 * fire routes through the bus), and an unwired dispatch fails loudly at fire time.
 */
export interface RoutinesExtensionDeps {
  /** The background browser lane a fire posts through (issue #50/#58). */
  browserAgent?: () => Pick<BrowserAgent, "run">;
  /** The live agent registry — agent-lane routines resolve their author agent at fire time. */
  agentRegistry?: () => { get(id: string): AgentDefinition | null };
  /** The generic invoke-lane runner that runs the resolved agent (issue #55/#72). */
  agentRunner?: () => Pick<AgentRunner, "run">;
  /**
   * The chilltext tone-rewrite call the agent lane's `POST:` contract routes through (W4A tune,
   * `dispatchAgentLane`). Injected so a test can exercise the REAL production wiring — the
   * `POST:` extraction, `composeXPostBrowserTask`, and the fail-open/280-char enforcement around
   * this call — without a live network hit. Default binds the real client (`src/chilltext.ts`)
   * to the real global `fetch`, exactly as prod runs it.
   */
  chillTransform?: (cfg: ChilltextConfig, req: ChillTransformInput) => Promise<ChillTransformResult | null>;
  /**
   * Fire-time fallback origin for a routine that names no channel/requester. The daemon binds
   * this to env (BECKETT_ROUTINE_CHANNEL_ID / DISCORD_OWNER_ID) so no id is baked into a
   * routine definition and the extension itself stays env-free.
   */
  defaultOrigin?: () => { channelId: string | null; requesterId: string | null };
  /**
   * How the `deps-update` lane is launched. Default: a detached `beckett routine deps-update`
   * subprocess. Injected so a test can assert the lane launches WITHOUT running git or npm — and
   * so it is visible in one place that this lane never reaches `browserAgent`.
   */
  spawnDepsUpdate?: (argv: string[]) => void;
  /**
   * How the `proactive-sweep` lane is launched (issue #79). Default: a detached `beckett routine
   * proactive-sweep` subprocess, exactly like `spawnDepsUpdate`. Injected for the same reason — so a
   * test can assert the lane forks BEFORE (and never resolves) the browser agent/registry/runner.
   */
  spawnProactiveSweep?: (argv: string[]) => void;
  /**
   * How the `self` lane wakes the concierge (issue #26). Default: a `routine.self` control-bus post
   * that frames a SYSTEM turn. Injected for the same reason `spawnDepsUpdate` is — so a test can
   * assert the lane forks BEFORE (and never resolves) the browser agent/registry/runner, without a
   * live socket. No credentials ride this lane, so nothing here names one.
   */
  wakeSelf?: (post: { routineId: string; prompt: string; channelId: string }) => void | Promise<void>;
  /**
   * How the weekly free-time session (docs/freetime.md) is launched. Default: a detached
   * `beckett free-time run` subprocess, exactly like `spawnDepsUpdate`. Injected for the same
   * reason — so a test can assert the session forks on the self lane BEFORE (and never resolves)
   * the browser agent/registry/runner, and never posts a `routine.self` concierge wake.
   */
  spawnFreeTime?: (argv: string[]) => void;
  /**
   * Is the worker fleet doing nothing right now? Bound by the daemon to the dispatcher's live
   * census. Free time is the ONLY consumer: an unprompted session must never compete with real
   * work for the machine, so a busy fleet defers the fire (before the period is claimed) instead
   * of running alongside it. Unwired ⇒ treated as idle: the CLI never arms a scheduler, and a
   * daemon that somehow lacks the accessor should still get its free time rather than starve.
   */
  isFleetIdle?: () => boolean;
  /** Is the concierge's turn queue empty? Second half of the same idle gate, same defaults. */
  conciergeQuiet?: () => boolean;
  /**
   * How the weekly spend report (#77) is launched. Default: a detached `beckett routine
   * spend-report` subprocess, exactly like `spawnDepsUpdate`. Injected for the same reason — so a
   * test can assert the bill forks off the scheduler tick and never resolves the browser lane.
   */
  spawnSpendReport?: (argv: string[]) => void;
  /**
   * The social-media agent's mandatory grounding step (real-sources ticket, Half 1):
   * `../../routine/social-grounding.ts#buildGroundingBlock`, fetched right before a COMPOSE fire
   * (never a `watch`/timeline-reply fire — see `needsGroundingSources`) and appended to the
   * agent's input. Deliberately NOT defaulted to the real fetch here: an unwired caller (a test
   * harness written before this dependency existed) must never make a live network call by
   * accident — it degrades to {@link GROUNDING_UNAVAILABLE_NOTE} instead. `shell/main.ts` always
   * wires the real implementation (`createDefaultGrounding`).
   */
  gatherGrounding?: () => Promise<string>;
  /**
   * The code-enforced verification gate (real-sources ticket, Half 2 — enforce grounding, not ask
   * for it): a separate, cheap model call that checks the COMPOSED post text against the exact
   * SOURCES block this fire was handed, independent of the agent that wrote it. Run right after
   * `dispatchAgentLane` extracts the post text and BEFORE it ever becomes a browser task — a
   * refused post is never dispatched (`../../routine/social-verify.ts`). Deliberately NOT
   * defaulted to the real `claude -p` spawn here — same discipline as `gatherGrounding`: an
   * unwired test harness must never spawn a live process by accident. `shell/main.ts` always
   * wires the real implementation (`createGroundingVerifier`); an unwired caller here degrades to
   * an inert pass (never refuses) rather than a live call, so only the intentionally-injected test
   * cases exercise refusal.
   */
  verifyGrounding?: GroundingVerifier;
  /**
   * How a refusal (or other fire-level notice on the compose path) reaches the origin channel
   * WITHOUT going through the browser lane — default posts over the daemon's own control bus
   * (`discord.reply`), exactly like the deps-update/proactive-sweep/spend-report lanes already do
   * (see `runRoutineDepsUpdate` etc. below). Injected so a test can assert the exact refusal text
   * without a live control socket.
   */
  notifyOrigin?: (channelId: string, text: string) => Promise<void>;
  /** Test seams — the scheduler's injectable clock/RNG/cadence (see {@link RoutineSchedulerDeps}). */
  now?: () => Date;
  rng?: () => number;
  intervalMs?: number;
  createStore?: (ctx: ExtensionContext) => RoutineStore;
  createScheduler?: (deps: RoutineSchedulerDeps) => RoutineScheduler;
  /** Test seams for the `watch` action's own store/loop/feed (issue #1) — kept separate from the
   *  scheduler's, since `watch` runs on its own interval, not the humanized fuzz-window one. */
  createWatchStateStore?: (ctx: ExtensionContext) => WatchStateStore;
  createWatchLoop?: (deps: WatchLoopDeps) => WatchLoop;
  fetchFeed?: (url: string) => ReturnType<typeof fetchModelNewsFeed>;
  watchIntervalMs?: number;
}

/** The built extension plus the accessors `shell/main.ts` wires into the concierge's v5 setters. */
export interface RoutinesExtension extends Extension {
  /** The daemon-owned durable routine store. Throws before `lifecycle.init` has run. */
  store(): RoutineStore;
  /** The live cron scheduler. Throws before `lifecycle.start` (the late sweep) has run. */
  scheduler(): RoutineScheduler;
}

// ── shared display helpers (moved verbatim from cli/beckett.ts) ─────────────────────────────

/**
 * "Sun 2026-07-26, 09:14 America/Los_Angeles" — a routine's next concrete fire, humanized. The
 * weekday is spelled out because a weekly routine's whole point is WHICH day, and reading that off
 * a bare date is exactly the check a person wants to make at a glance.
 */
function describeNextFire(routine: Routine): string {
  if (!routine.schedule) return "n/a (event-driven, no fixed schedule)";
  const at = nextFireAt(routine.schedule, routine.state, new Date(), Math.random);
  const tz = routine.schedule.window.tz;
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(at);
  const rolled = routine.state.periodKey && routine.state.chosenFireAt ? "" : " (window; exact time not rolled yet)";
  return `${local} ${tz}${rolled}`;
}

/** "daily" / "weekly (sunday)" — the cadence as a person reads it in `routine ls`. */
function describeCadence(cadence: Cadence): string {
  return cadence.kind === "weekly" ? `weekly (${cadence.weekday})` : cadence.kind;
}

function summarizeRoutine(routine: Routine): Record<string, unknown> {
  const base = {
    id: routine.id,
    name: routine.name,
    builtin: routine.builtin,
    enabled: routine.enabled,
    action: routine.action.kind,
    lastFiredAt: routine.state.lastFiredAt ?? null,
  };
  // `watch` has no schedule/window — it polls on its own interval and fires 0..n times a day.
  if (routine.action.kind === "watch") {
    return {
      ...base,
      cadence: `every ${routine.action.pollIntervalMinutes}m (event-driven)`,
      window: "n/a",
      nextFire: describeNextFire(routine),
      dryRun: routine.action.dryRun,
    };
  }
  const w = routine.schedule!.window;
  return {
    ...base,
    cadence: describeCadence(routine.schedule!.cadence),
    window: `${w.start}-${w.end} ${w.tz}`,
    nextFire: describeNextFire(routine),
  };
}

/**
 * The cadence a `routine add` asked for. `weekday` present → weekly on that day, else daily. One
 * resolver so the CLI flag and the `routines.add` capability can never disagree about what
 * "--weekly sunday" means.
 */
function cadenceFrom(weekday: string | undefined): Cadence {
  if (!weekday) return { kind: "daily" };
  return { kind: "weekly", weekday: WeekdaySchema.parse(weekday.trim().toLowerCase()) };
}

// ── v6 invocation schemas ──────────────────────────────────────────────────────────────────

const InspectArgs = z.object({
  id: z.string().trim().min(1, "routines.inspect needs a routine id"),
});

const AddArgs = z.object({
  id: z.string().trim().min(1, "a routine needs an id"),
  /** 24h HH:MM-HH:MM — the daily window the fuzzed fire time is rolled inside. */
  window: z
    .string()
    .regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/, "window must look like 12:00-13:00 (24h HH:MM-HH:MM)"),
  tz: z.string().refine(isValidTimeZone, "tz must be a valid IANA timezone, e.g. America/Los_Angeles"),
  task: z.string().trim().min(1, "a routine needs a self-contained browser task"),
  /** Present → a WEEKLY routine firing on that weekday; absent → daily (issue #85). */
  weekday: WeekdaySchema.optional(),
  name: z.string().optional(),
  /** jingle keychain entry NAME the browser lane injects at fire time — never a secret value. */
  credsEntry: z.string().optional(),
  /** Where fires report. May only restate the origin's channel, never redirect it. */
  channelId: z.string().optional(),
});

const RemoveArgs = z.object({
  id: z.string().trim().min(1, "routines.remove needs a routine id"),
});

/** Beckett's own CLI entry, resolved off this module so nothing has to guess where it is. */
const BECKETT_CLI_ENTRY = join(import.meta.dir, "../../cli/beckett.ts");

const FireArgs = z.object({
  id: z.string().trim().min(1, "routines.fire needs a routine id"),
  /** Bypass per-period idempotency (a real re-fire). */
  force: z.boolean().optional(),
  /** Build and return the dispatch plan WITHOUT running the agent or posting. */
  dryRun: z.boolean().optional(),
});

export const createRoutinesExtension =
  (deps: RoutinesExtensionDeps) =>
  (ctx: ExtensionContext): RoutinesExtension => {
    // Built by lifecycle.init; the scheduler is armed only by lifecycle.start (late sweep).
    let store: RoutineStore | null = null;
    let schedulerDeps: RoutineSchedulerDeps | null = null;
    let scheduler: RoutineScheduler | null = null;
    let primeTimer: ReturnType<typeof setTimeout> | null = null;
    // The `watch` action's own runtime state (issue #1) — a SEPARATE durable store from
    // routines.json/RoutineState, because a cold start must seed from the LIVE feed, not from
    // whatever period-fire bookkeeping happened to be on disk. Built INERT by init; its poll
    // loop arms alongside the scheduler in the same late start.
    let watchStateStore: WatchStateStore | null = null;
    let watchLoop: WatchLoop | null = null;

    function requireStore(): RoutineStore {
      if (!store) throw new Error("the routines extension is not initialized (lifecycle.init has not run)");
      return store;
    }
    function requireScheduler(): RoutineScheduler {
      if (!scheduler) throw new Error("the routine scheduler is not started (lifecycle.start has not run)");
      return scheduler;
    }

    /** The `watch` action's runtime deps — ONE shared object serves every `watch` routine (and
     *  the automatic poll loop, a real `--force` fire, and — via `previewWatchCycle` — a
     *  `--dry-run` fire): `dispatchAgent` takes the target `agentId` per call rather than being
     *  bound to one routine, so nothing here needs to vary by routine. */
    function watchDeps(): WatchDeps {
      if (!watchStateStore) throw new Error("the routines extension is not initialized (lifecycle.init has not run)");
      return {
        stateStore: watchStateStore,
        fetchFeed: deps.fetchFeed ?? ((url) => fetchModelNewsFeed(url)),
        now: deps.now ?? (() => new Date()),
        dispatchAgent: (agentId, agentInput, opts) => dispatchAgentLane(agentId, agentInput, opts),
        reportChannel: (channelId, text) =>
          callBus(join(ctx.paths.beckettDir, "control.sock"), "discord.reply", { channelId, text }, 30_000).then(
            () => undefined,
          ),
        defaultOrigin: () => deps.defaultOrigin?.() ?? { channelId: null, requesterId: null },
        logger: ctx.logger.child("model-news-watch"),
      };
    }

    /**
     * Launch the `deps-update` lane as its own `beckett routine deps-update` process (issue #85).
     * Detached and NOT awaited: it resolves as soon as the lane has TAKEN the work, exactly like
     * the browser lane's enqueue, so a multi-minute clone/install/test cycle never sits inside a
     * scheduler tick. The subprocess owns its own reporting — it posts the single summary line to
     * `channelId` itself, so a daemon restart mid-run loses the report but never the daemon.
     */
    function spawnDepsUpdate(
      plan: RoutineDispatchPlan,
      origin: { channelId: string; requesterId: string },
    ): void {
      const target = plan.depsUpdate;
      if (!target) throw new Error("deps-update routine is missing its update target");
      const argv = [
        "routine", "deps-update",
        "--routine", plan.routineId,
        "--base", target.base,
        "--channel", origin.channelId,
        "--requester", origin.requesterId,
        ...(target.repo ? ["--repo", target.repo] : []),
        ...(target.sourceRepo ? ["--source", target.sourceRepo] : []),
      ];
      if (deps.spawnDepsUpdate) {
        deps.spawnDepsUpdate(argv);
        return;
      }
      const proc = Bun.spawn([process.execPath, BECKETT_CLI_ENTRY, ...argv], {
        cwd: ctx.paths.home,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      proc.unref?.();
      ctx.logger.info("deps-update lane launched off-process", { routineId: plan.routineId, pid: proc.pid });
    }

    /**
     * Launch the `proactive-sweep` lane as its own `beckett routine proactive-sweep` process (issue
     * #79). The deps-update pattern exactly: detached, NOT awaited (it resolves once the lane has
     * TAKEN the work), its own reporting (it posts the single summary line to `channelId` itself).
     * Sweeping a handful of repos — each a few GitHub reads and, on a finding, a branch + a PR — can
     * take a while and must never sit inside a scheduler tick, and a crash in it can't reach the
     * daemon. The opt-in repo list rides argv, comma-joined; an empty list means the subprocess
     * sweeps nothing.
     */
    function spawnProactiveSweep(
      plan: RoutineDispatchPlan,
      origin: { channelId: string; requesterId: string },
    ): void {
      const target = plan.proactiveSweep;
      if (!target) throw new Error("proactive-sweep routine is missing its sweep target");
      const argv = [
        "routine", "proactive-sweep",
        "--routine", plan.routineId,
        "--channel", origin.channelId,
        "--requester", origin.requesterId,
        ...(target.repos.length > 0 ? ["--repos", target.repos.join(",")] : []),
      ];
      if (deps.spawnProactiveSweep) {
        deps.spawnProactiveSweep(argv);
        return;
      }
      const proc = Bun.spawn([process.execPath, BECKETT_CLI_ENTRY, ...argv], {
        cwd: ctx.paths.home,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      proc.unref?.();
      ctx.logger.info("proactive-sweep lane launched off-process", { routineId: plan.routineId, pid: proc.pid });
    }

    /**
     * Launch the weekly free-time session (docs/freetime.md) as its own `beckett free-time run`
     * process — the deps-update pattern exactly: detached, not awaited, and it owns whatever
     * reporting it does (its journal entry under `~/.beckett/free-time` is the record; the
     * optional one-line share is posted by the RUNNER after the session exits, never by the
     * session itself). It rides the SELF lane's pre-browser fork, so like a plain self wake it
     * can never resolve the browser agent, an agent registry entry, or a creds entry.
     */
    function spawnFreeTime(
      plan: RoutineDispatchPlan,
      origin: { channelId: string; requesterId: string },
    ): void {
      const argv = [
        "free-time", "run",
        "--routine", plan.routineId,
        // Provenance only — the session's share goes to `[free_time] channel_id`, not here.
        "--requester", origin.requesterId,
      ];
      if (deps.spawnFreeTime) {
        deps.spawnFreeTime(argv);
        return;
      }
      const proc = Bun.spawn([process.execPath, BECKETT_CLI_ENTRY, ...argv], {
        cwd: ctx.paths.home,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      proc.unref?.();
      ctx.logger.info("free-time session launched off-process", { routineId: plan.routineId, pid: proc.pid });
    }

    /**
     * The scheduler's pre-claim veto ({@link RoutineDispatcher.deferReason}), free time only.
     * Consulted BEFORE the period is claimed, so a deferral costs the window and not the week:
     * the next 30s tick asks again, and if the fleet is still working, again, until the fleet
     * goes quiet or the week rolls over. A disabled session is NOT deferred — it falls through to
     * dispatch, which refuses it once and lets the period close.
     */
    function deferReason(plan: RoutineDispatchPlan): string | null {
      if (!plan.freeTime || !ctx.config.free_time.enabled) return null;
      return freeTimeDeferReason({
        fleetIdle: deps.isFleetIdle?.() ?? true,
        conciergeQuiet: deps.conciergeQuiet?.() ?? true,
      });
    }

    /**
     * Launch the weekly spend report (#77) as its own `beckett routine spend-report` process — the
     * deps-update pattern exactly: detached, not awaited, owns its own reporting (it posts the one
     * per-task bill to `channelId` itself). It rides no browser dependency: reading the ledger and
     * posting a summary wants neither a web session, an agent, nor credentials.
     */
    function spawnSpendReport(
      plan: RoutineDispatchPlan,
      routine: Routine,
      origin: { channelId: string; requesterId: string },
    ): void {
      const since = routine.action?.kind === "spend-report" ? routine.action.since : "7d";
      const argv = [
        "routine", "spend-report",
        "--routine", plan.routineId,
        "--channel", origin.channelId,
        "--requester", origin.requesterId,
        "--since", since,
      ];
      if (deps.spawnSpendReport) {
        deps.spawnSpendReport(argv);
        return;
      }
      const proc = Bun.spawn([process.execPath, BECKETT_CLI_ENTRY, ...argv], {
        cwd: ctx.paths.home,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      proc.unref?.();
      ctx.logger.info("spend-report lane launched off-process", { routineId: plan.routineId, pid: proc.pid });
    }

    /**
     * The `agent` lane's body: resolve the agent LIVE from the registry (so editing its prompt —
     * or, for `watch`, the routine's target agent — takes effect with no redeploy), let it author
     * the post, then hand what it authored to the PRIVILEGED in-process browser lane. Shared by
     * `dispatchPlan`'s own `agent` branch AND `watch`'s `dispatchAgent` dependency
     * ({@link watchDeps}) — a qualifying watch fire is THE SAME agent-lane path `daily-x-shitpost`
     * uses, not a second implementation of it.
     */
    async function dispatchAgentLane(
      agentId: string,
      agentInput: string,
      origin: { channelId: string; requesterId: string; credsEntry?: string | null },
    ): Promise<void> {
      if (!deps.browserAgent || !deps.agentRegistry || !deps.agentRunner) {
        // Only reachable in a process that armed the scheduler without the daemon's deps —
        // the CLI never starts it, and the daemon always injects all three.
        throw new Error("routine dispatch is not wired (the daemon injects the browser lane + agent registry/runner)");
      }
      const def = deps.agentRegistry().get(agentId);
      if (!def) throw new Error(`routine references unknown agent: ${agentId}`);
      // The mandatory grounding step (Half 1): a plain compose fire (daily-x-shitpost, the legacy
      // x-shitpost shape) gets a SOURCES block appended to its input BEFORE the agent ever writes
      // a word. A `watch` event fire or a TIMELINE REPLY ROUND is already grounded some other way
      // (the specific feed item; the live page) and skips this — see `needsGroundingSources`. The
      // SAME condition gates the content-verification gate below (Half 2): neither fetches nor
      // checks against a SOURCES block that was never built for this fire. A feed failure/empty
      // pool degrading to {@link GROUNDING_UNAVAILABLE_NOTE} is NOT routed into the format hard
      // stop below — that note is itself real, honest grounding content (it tells the agent
      // plainly that nothing is available and to pick a sourceless lane instead of inventing), so
      // a compose fire that reads it and still emits a valid `POST:` line is allowed to post.
      const gated = agentId === SOCIAL_MEDIA_AGENT_ID && needsGroundingSources(agentInput);
      let sources: string | null = null;
      let input = agentInput;
      if (gated) {
        sources = deps.gatherGrounding
          ? await deps.gatherGrounding().catch((err) => {
              ctx.logger.warn("social-media grounding fetch failed; composing with no fetched sources", {
                error: String(err),
              });
              return GROUNDING_UNAVAILABLE_NOTE;
            })
          : GROUNDING_UNAVAILABLE_NOTE;
        input = `${agentInput}\n\n${sources}`;
      }

      // Author a draft: run the agent, extract its `POST: <text>` contract. Shared by the first
      // attempt and the one allowed retry below.
      const runAgent = deps.agentRunner;
      async function author(withInput: string): Promise<{ postText: string | null; rawOutput: string }> {
        const outcome = await runAgent().run(def!, withInput, {
          channelId: origin.channelId,
          requesterId: origin.requesterId,
        });
        if (outcome.state !== "done" || !outcome.output.trim()) {
          throw new Error(`agent ${agentId} did not author a post: ${outcome.error ?? outcome.state}`);
        }
        return { postText: extractPostText(outcome.output), rawOutput: outcome.output };
      }

      let { postText, rawOutput } = await author(input);

      // The social-media agent's OUTPUT CONTRACT (src/agent/builtins.ts) is `POST: <text>` — it
      // authors ONLY the post text; CODE builds the actual browser task from it below, routed
      // through chilltext's tone pass first (W4A tune). An agent that hasn't adopted the contract
      // (no `POST:` line) falls back to the legacy shape: its whole output IS the task — but ONLY
      // for a job that is exempt from the OUTPUT CONTRACT itself (a TIMELINE REPLY ROUND, grounded
      // by the live page it reads, and explicitly told in the prompt not to use `POST:`). Every
      // OTHER social-media fire — a plain compose, the legacy x-shitpost shape, AND an EVENT
      // TRIGGER (the `watch` lane, src/routine/watch.ts's `buildAgentSubject`) — is expected to
      // emit `POST:` regardless of whether it needed a fetched SOURCES block: an EVENT TRIGGER
      // skips the SOURCES fetch above (`needsGroundingSources` returns false for it — it's already
      // grounded in the specific feed item named in its own input) but still goes through this same
      // agent call and the same OUTPUT CONTRACT, so it has the identical fallback hole a plain
      // compose fire does. Falling back here would ship this agent's raw, self-authored, freeform
      // output straight to the background browser lane's own model as its task — a second,
      // completely ungrounded agent invocation, so it is a hard stop, not a silent downgrade. So
      // the gate here is NOT `needsGroundingSources` (that only decides whether to fetch a SOURCES
      // block); it's "every social-media fire except a TIMELINE REPLY ROUND" — no `POST:` line on
      // any of those is now a hard stop. This is a FORMAT check only (did the agent emit the
      // contract at all) — it runs unconditionally and does not retry, unlike the
      // content-verification gate below, which only applies to `gated` fires and checks what the
      // `POST:` text actually says.
      //
      // CORRECTED POST-MORTEM: an earlier version of this comment blamed the fabricated
      // AWS-lockout post (live 2026-08-22T01:32:28Z) on `daily-x-shitpost-4` falling through this
      // exact fallback hole, and PR #334 hardened this agent-lane path on the strength of that
      // claim. That attribution was WRONG: `daily-x-shitpost-4` fired at 2026-08-22T01:34:25.691Z
      // — two minutes AFTER the fabricated post was already live — so it never touched that post,
      // and this function was never reached. The actual cause was `x-social-evening` (fired
      // 2026-08-22T01:32:25.685Z), a user-created `action: "browser"` routine. A `browser`-lane
      // routine's static task never enters `dispatchAgentLane` at all — it goes straight from
      // `dispatchPlan` to the background browser lane (below) as a raw string, with no SOURCES
      // block, no `POST:` contract, and no verification gate, so the browser-driving model both
      // composed and published in one ungrounded step. That bypass — not this fallback — is what
      // let the AWS-lockout post ship, and it is why the fix PR #334 shipped survived it: hardening
      // an agent-lane path a `browser` routine never uses closes nothing. It is now refused
      // structurally at dispatch for any `browser`-lane routine that targets X/social
      // (`browserActionTargetsXSocial` in `../../routine/plan.ts`; see the refusal check in
      // `dispatchPlan` below).
      const isTimelineReplyRound = agentInput.includes("TIMELINE REPLY ROUND");
      if (!postText && agentId === SOCIAL_MEDIA_AGENT_ID && !isTimelineReplyRound) {
        throw new Error(
          `agent ${agentId} did not follow the POST: output contract on a compose fire — ` +
            "refusing to hand its raw output to the browser lane as an ungrounded freeform task " +
            `(output started: ${JSON.stringify(rawOutput.slice(0, 200))})`,
        );
      }

      // The code-enforced verification gate (real-sources ticket, Half 2 — enforce grounding, not
      // ask for it): the format check above only proves the agent EMITTED a `POST:` line — it says
      // nothing about whether that text's claims are true. A self-graded prompt rule already failed
      // once on content (the AWS-lockout fabrication, 2026-08-22), so a SEPARATE model call checks
      // the composed text against the EXACT sources block this fire was handed, independent of the
      // agent that wrote it. One retry, with the refusal reason fed back, is allowed; a second
      // refusal means no post this round — logged, reported to the origin channel, and NEVER
      // dispatched to the browser lane.
      if (gated && postText) {
        const verify = deps.verifyGrounding ?? (async () => ({ claims: [], reason: "verifier unwired", grounded: true }) as GroundingVerdict);
        let verdict = await verify(postText, sources!);
        if (!verdict.grounded) {
          ctx.logger.warn("social post refused by the grounding gate; retrying once", {
            postText,
            reason: verdict.reason,
          });
          const retryInput = [
            input,
            "",
            "Your previous draft was REFUSED by the grounding-verification gate — it will NOT be",
            `published: "${postText}"`,
            `Refusal reason: ${verdict.reason}`,
            "Write a DIFFERENT post whose factual claims all trace to the SOURCES block above, or pick",
            "a lane that asserts no fact at all (BAD OPINION, STUPID ON PURPOSE, PING SOMEONE, OVERLY",
            "INVESTED) instead of inventing one.",
          ].join("\n");
          const retry = await author(retryInput);
          postText = retry.postText;
          rawOutput = retry.rawOutput;
          verdict = postText
            ? await verify(postText, sources!)
            : { claims: [], reason: "retry authored no POST: text", grounded: false };
          if (!verdict.grounded) {
            ctx.logger.warn("social post refused by the grounding gate twice; skipping this round", {
              postText,
              reason: verdict.reason,
            });
            const notify =
              deps.notifyOrigin ??
              ((channelId: string, text: string) =>
                callBus(join(ctx.paths.beckettDir, "control.sock"), "discord.reply", { channelId, text }, 30_000).then(
                  () => undefined,
                ));
            await notify(
              origin.channelId,
              [
                "social post refused (grounding check failed twice this round — nothing published).",
                `reason: ${verdict.reason}`,
                `last attempt: "${postText ?? rawOutput.trim()}"`,
              ].join("\n"),
            ).catch((err) => {
              ctx.logger.warn("could not report the grounding refusal to the origin channel", { error: String(err) });
            });
            return;
          }
        }
      }

      const doChillTransform = deps.chillTransform ?? chillTransform;
      const browserTask = postText
        ? await composeXPostBrowserTask(postText, X_SOCIAL_ACCOUNT, ctx.config.social.chill, {
            // The social lane reuses the SAME `[concierge.chilltext]` endpoint config the
            // concierge gate uses (url/timeout/system); whether the pass runs at all is
            // `[social].chill`, checked by composeXPostBrowserTask, not `chilltext.enabled`.
            chillTransform: (req) => doChillTransform(ctx.config.concierge.chilltext, req),
          })
        : rawOutput.trim();
      // Credential injection (from the jingle entry NAMED by credsEntry), the X verification
      // pause/resume, and the confirmation back to the origin channel are all the browser agent's
      // job (issue #50) — including the one-line "posted, here's the URL" report a qualifying
      // watch fire promises: it rides the SAME onOutcome relay every other browser-lane post does.
      await deps.browserAgent().run(browserTask, {
        channelId: origin.channelId,
        requesterId: origin.requesterId,
        credsEntry: origin.credsEntry ?? null,
      });
    }

    /**
     * The dispatch executor, moved from `shell/main.ts` byte-identically (messages and check
     * order preserved). Runs OFF the scheduler's tick path — the scheduler never blocks on
     * browser work. Resolution of every dependency is deferred to HERE, fire time.
     */
    async function dispatchPlan(plan: RoutineDispatchPlan, routine: Routine): Promise<void> {
      // Resolve the origin channel/requester at fire time (the daemon binds this to
      // BECKETT_ROUTINE_CHANNEL_ID / DISCORD_OWNER_ID) so no id is baked into a routine.
      const fallback = deps.defaultOrigin?.() ?? { channelId: null, requesterId: null };
      const channelId = plan.channelId ?? fallback.channelId;
      const requesterId = plan.requesterId ?? fallback.requesterId;
      if (!channelId || !requesterId) {
        throw new Error(
          "routine dispatch needs an origin channel + requester " +
            "(set BECKETT_ROUTINE_CHANNEL_ID and DISCORD_OWNER_ID, or the routine's channelId/requesterId)",
        );
      }

      // The LOCAL maintenance lane (issue #85) forks BEFORE every browser dependency below: a
      // dependency update wants a checkout and a package manager, not a web session, so it must
      // never resolve — let alone require — the browser agent or the agent registry. It runs as its
      // OWN `beckett routine deps-update` subprocess off this process: an unattended job that
      // clones, installs, and runs a full test suite for minutes on end has no business holding a
      // scheduler tick, and a crash in it can't reach the daemon.
      if (plan.lane === "deps-update") {
        spawnDepsUpdate(plan, { channelId, requesterId });
        return;
      }

      // The proactive rot sweep (issue #79) forks here for the SAME reason deps-update does: it
      // wants GitHub reads and PR opens, not a web session, so it must never resolve — let alone
      // require — the browser agent or the agent registry. Its own `beckett routine proactive-sweep`
      // subprocess off this process; a crash in it can't reach the daemon.
      if (plan.lane === "proactive-sweep") {
        spawnProactiveSweep(plan, { channelId, requesterId });
        return;
      }

      // The weekly bill (#77) forks here too, before every browser dependency below: reading the
      // spend ledger and posting a per-task breakdown wants no web session, no agent, no creds. It
      // runs as its OWN `beckett routine spend-report` subprocess, off this process.
      if (plan.lane === "spend-report") {
        spawnSpendReport(plan, routine, { channelId, requesterId });
        return;
      }

      // The event-listener lane (issue #1): no I/O happened in `buildDispatchPlan` (it stays
      // pure), so the REAL poll — fetch, qualify, dedup, rate-limit, and (on a genuine hit) the
      // agent dispatch — happens HERE, exactly once per fire (the automatic loop's own interval
      // gate, or a manual `fire`/`--force`, both land in this one place).
      if (plan.lane === "watch") {
        await runWatchCycle(routine, watchDeps());
        return;
      }

      // The self lane (issue #26): the ONLY lane that wakes Beckett's OWN concierge, not the
      // browser. It forks HERE — before the browser dependency check below, for the SAME reason
      // deps-update does — because a turn that puts Beckett on its own open-loop ledger has no
      // business resolving a browser lane, an agent, or a creds entry. Forking early makes it
      // structurally impossible for a self routine to reach any of them. The wake itself is one
      // bus post to the concierge, which frames a SYSTEM turn; no credentials ride this lane.
      if (plan.lane === "self") {
        // Free time (docs/freetime.md) forks FIRST, inside the self lane: it shares the lane's
        // "never the browser" structure but runs as the contained `beckett free-time run`
        // subprocess instead of a concierge turn, plus one more check: `[free_time] enabled=false`
        // is the human off-switch, and it is honored HERE — before anything spawns — so turning
        // free time off takes effect on the next fire without touching the routine. A refused fire
        // keeps its claimed period: the week closes quietly rather than retrying a session nobody
        // wants every 30 seconds.
        if (plan.freeTime) {
          if (!ctx.config.free_time.enabled) {
            ctx.logger.info("free-time fire refused: [free_time] enabled=false", { routineId: plan.routineId });
            return;
          }
          spawnFreeTime(plan, { channelId, requesterId });
          return;
        }
        if (!plan.selfPrompt) throw new Error("self-lane routine is missing its prompt");
        const post = { routineId: plan.routineId, prompt: plan.selfPrompt, channelId };
        if (deps.wakeSelf) {
          await deps.wakeSelf(post);
          return;
        }
        await callBus(join(ctx.paths.beckettDir, "control.sock"), "routine.self", post, 30_000);
        return;
      }

      if (!deps.browserAgent || !deps.agentRegistry || !deps.agentRunner) {
        // Only reachable in a process that armed the scheduler without the daemon's deps —
        // the CLI never starts it, and the daemon always injects all three.
        throw new Error("routine dispatch is not wired (the daemon injects the browser lane + agent registry/runner)");
      }

      // The task string posted to the browser lane. For the `browser` lane it's the routine's
      // static task; for the `agent` lane the agent AUTHORS it live (issue #55/#72).
      if (plan.lane === "agent") {
        if (!plan.agentId) throw new Error("agent-lane routine is missing an agentId");
        await dispatchAgentLane(plan.agentId, plan.agentInput ?? "", {
          channelId,
          requesterId,
          credsEntry: plan.credsEntry,
        });
        return;
      }
      if (!plan.browserTask) throw new Error("routine dispatch produced no browser task");

      // The X/social bypass (2026-08-22, see the corrected post-mortem in `dispatchAgentLane`
      // above): an `action: "browser"` routine's task lands HERE as a raw, self-contained string
      // that never passed through an agent — no SOURCES block, no `POST:` contract, no
      // verification gate. `buildDispatchPlan` (`../../routine/plan.ts`) already refused any such
      // plan whose task/creds target X/social (`browserActionTargetsXSocial`); honor that refusal
      // HERE, the one place a browser-lane routine actually reaches the privileged browser agent,
      // so nothing that calls `dispatchPlan` can route around it.
      if (plan.refusalReason) {
        ctx.logger.warn("browser-lane routine refused at dispatch: targets X/social", {
          routineId: plan.routineId,
          task: plan.browserTask,
        });
        const notify =
          deps.notifyOrigin ??
          ((cid: string, text: string) =>
            callBus(join(ctx.paths.beckettDir, "control.sock"), "discord.reply", { channelId: cid, text }, 30_000).then(
              () => undefined,
            ));
        await notify(
          channelId,
          [
            `routine "${plan.routineId}" refused — an "action: browser" routine may not target X/social.`,
            plan.refusalReason,
          ].join("\n"),
        ).catch((err) => {
          ctx.logger.warn("could not report the browser-lane refusal to the origin channel", { error: String(err) });
        });
        return;
      }

      // Post via the PRIVILEGED in-process browser lane — the routine holds the channel/requester
      // authorization, so a headless run can post without a Discord mention token. Credential
      // injection (from the jingle entry NAMED by credsEntry), the X verification pause/resume,
      // and the confirmation back to the origin channel are all the browser agent's job (issue #50).
      await deps.browserAgent().run(plan.browserTask, {
        channelId,
        requesterId,
        credsEntry: plan.credsEntry,
      });
    }

    /**
     * The carried v5 CLI verb — `cli/beckett.ts::runRoutine` moved verbatim (the CLI
     * characterization suite pins the help token; every usage/`fail` string is preserved).
     * `out`/`fail` are CLI-surface only: this run function is dispatched by the CLI spine in a
     * `beckett` process, never by the daemon — daemon dispatch goes through `invoke` below.
     * It reads a FRESH store per call (CLI-process semantics, same as the task registry) and
     * routes a real fire through the bus, exactly as before.
     */
    function cliRoutineStore(): RoutineStore {
      return new RoutineStore(join(ctx.paths.beckettDir, "routines.json"), { builtins: builtinOverrides() });
    }

    /**
     * The built-in overrides sourced from config. Free time's window is seed-only (applied once,
     * so a fresh routines.json is seeded with the SAME window whichever process happens to create
     * it first — a weekday config typo fails the config schema, not here). The proactive sweep's
     * repo list is applied on every load — see `RoutineStore.reconcileProactiveSweep`.
     */
    function builtinOverrides(): BuiltinRoutineOverrides {
      const ft = ctx.config.free_time;
      return {
        freeTime: {
          weekday: WeekdaySchema.parse(ft.weekday),
          window: { start: ft.window_start, end: ft.window_end, tz: ft.tz },
        },
        proactiveSweep: { repos: ctx.config.proactive_sweep.repos },
      };
    }

    /**
     * `previewWatchCycle`'s deps for a CLI-local `--dry-run` — same watch-state.json the daemon's
     * loop reads, a real (unprivileged) feed fetch, and the same env-resolved origin fallback
     * every routine action uses. No daemon required: a dry-run must work even if the daemon is
     * down, exactly like every other routine's `--dry-run`.
     */
    function cliWatchPreviewDeps(): Pick<WatchDeps, "fetchFeed" | "now" | "stateStore" | "defaultOrigin"> {
      return {
        stateStore: new WatchStateStore(join(ctx.paths.beckettDir, "watch-state.json")),
        fetchFeed: (url) => fetchModelNewsFeed(url),
        now: () => new Date(),
        defaultOrigin: () => ({
          channelId: process.env.BECKETT_ROUTINE_CHANNEL_ID?.trim() ?? null,
          requesterId: process.env.DISCORD_OWNER_ID?.trim() ?? null,
        }),
      };
    }

    /**
     * `beckett routine deps-update` — the `deps-update` action's BODY, run as its own process by
     * {@link spawnDepsUpdate} (and by a human who wants to run the weekly job by hand). It owns the
     * three things the routine promises:
     *
     *   - the update happens in a throwaway clone of `--source` (default: the daemon's own source
     *     root), so the live checkout at that path is only ever READ;
     *   - publishing is `beckett gh push` + `beckett gh pr create` against `--base`, and there is no
     *     deploy step anywhere in the path — the deliverable is a PR;
     *   - EXACTLY ONE line goes to `--channel`, whatever the outcome. An unattended weekly job that
     *     fails silently is indistinguishable from one that never ran, so a failure reports too —
     *     it just says "no PR" instead of a link.
     */
    async function runRoutineDepsUpdate(argv: string[]): Promise<void> {
      const { flags } = parse(argv);
      // `--routine` / `--requester` are provenance only — nothing about the update branches on
      // them. They ride the log so an unattended run is traceable back to the routine that fired
      // it and the identity it was attributed to.
      const logger = ctx.logger.child("deps-update").child(String(flags.routine ?? "manual"));
      logger.info("deps-update starting", { requester: flags.requester ? String(flags.requester) : null });

      // One identity load serves both the default repo and the commit author.
      let identity: { account: string; owner: string; noreplyEmail: string };
      try {
        const loaded = loadIdentity(ctx.config);
        identity = {
          account: loaded.github.account,
          owner: loaded.github.owner ?? loaded.github.account,
          noreplyEmail: loaded.github.noreplyEmail,
        };
      } catch (err) {
        fail(`deps-update cannot resolve Beckett's GitHub identity: ${(err as Error).message}`);
        return;
      }

      const selfRepo = process.env.BECKETT_SELF_PROJECT?.trim() || "beckett";
      // The self-repo moved to kowo-co (#114); the REST API 301s the old owner, so target the
      // self-project owner rather than the default managed-project owner (identity.owner).
      const repo = flags.repo ? String(flags.repo) : `${resolveSelfProjectOwner()}/${selfRepo}`;
      const base = flags.base ? String(flags.base) : "main";
      const sourceRepo = flags.source ? String(flags.source) : defaultRepoRoot();
      const channelId = flags.channel
        ? String(flags.channel)
        : (process.env.BECKETT_ROUTINE_CHANNEL_ID ?? "").trim();

      // Date-stamped so a week's run is identifiable in `gh pr list` and a re-run collides loudly
      // rather than silently stacking branches.
      const stamp = new Date().toISOString().slice(0, 10);
      const workRoot = join(tmpdir(), "beckett-deps-update");
      mkdirSync(workRoot, { recursive: true });

      const result = await runDepsUpdate(
        {
          repo,
          base,
          sourceRepo,
          workRoot,
          branch: `beckett/deps-update-${stamp}`,
          author: { name: identity.account, email: identity.noreplyEmail },
        },
        defaultDepsUpdateDeps({ beckettCli: [process.execPath, BECKETT_CLI_ENTRY], logger }),
      );
      // The summary rides the log too: this process's stdout is discarded when the scheduler
      // launched it, so the daemon log is the only place an operator can read the outcome if the
      // Discord post below never lands.
      logger.info("deps-update finished", {
        status: result.status,
        prUrl: result.prUrl,
        summary: result.summary,
      });

      // ONE line, terse, then done. A failed post must not fail the run — the update either landed
      // as a PR or it didn't, and that fact is already true regardless of Discord.
      if (channelId) {
        try {
          await callBus(join(ctx.paths.beckettDir, "control.sock"), "discord.reply", { channelId, text: result.summary }, 30_000);
        } catch (err) {
          logger.warn("deps-update could not post its summary", { error: String(err) });
        }
      } else {
        // Only reachable for a hand-run with no channel configured — the scheduler always passes one.
        logger.info("deps-update posted nothing (no channel configured)");
      }
      out(result);
    }

    /**
     * `beckett routine proactive-sweep` — the `proactive-sweep` action's BODY, run as its own process
     * by {@link spawnProactiveSweep} (and by a human who wants to run the sweep by hand). It owns the
     * guarantees the routine promises:
     *
     *   - it sweeps ONLY the `--repos` it is handed (the routine's explicit opt-in list); no `--repos`
     *     means it sweeps nothing and touches no GitHub API at all;
     *   - publishing is `beckett gh` (a branch via the contents API + `beckett gh pr create`), and
     *     there is no merge and no force-push anywhere in the path — the deliverable is labelled PRs;
     *   - EXACTLY ONE line goes to `--channel`, UNLESS nothing was opted in (a dormant sweep stays
     *     silent — it would be noise to report "no repos opted in" every single day).
     */
    async function runRoutineProactiveSweep(argv: string[]): Promise<void> {
      const { flags } = parse(argv);
      // `--routine` / `--requester` are provenance only — nothing about the sweep branches on them.
      const logger = ctx.logger.child("proactive-sweep").child(String(flags.routine ?? "manual"));
      logger.info("proactive-sweep starting", { requester: flags.requester ? String(flags.requester) : null });

      let identity: { account: string; noreplyEmail: string };
      try {
        const loaded = loadIdentity(ctx.config);
        identity = { account: loaded.github.account, noreplyEmail: loaded.github.noreplyEmail };
      } catch (err) {
        fail(`proactive-sweep cannot resolve Beckett's GitHub identity: ${(err as Error).message}`);
        return;
      }

      const repos = flags.repos
        ? String(flags.repos).split(",").map((r) => r.trim()).filter(Boolean)
        : [];
      const channelId = flags.channel
        ? String(flags.channel)
        : (process.env.BECKETT_ROUTINE_CHANNEL_ID ?? "").trim();
      const dateStamp = new Date().toISOString().slice(0, 10);

      const result = await runProactiveSweep(
        { repos, author: { name: identity.account, email: identity.noreplyEmail }, dateStamp },
        defaultProactiveSweepDeps({ beckettCli: [process.execPath, BECKETT_CLI_ENTRY], logger }),
      );
      logger.info("proactive-sweep finished", { status: result.status, opened: result.opened, summary: result.summary });

      // Report one line — but NOT for the dormant "no repos opted in" case, which fires daily and
      // would otherwise spam the channel. A real sweep (clean, opened, or errored) always reports.
      if (channelId && result.status !== "no-repos") {
        try {
          await callBus(join(ctx.paths.beckettDir, "control.sock"), "discord.reply", { channelId, text: result.summary }, 30_000);
        } catch (err) {
          logger.warn("proactive-sweep could not post its summary", { error: String(err) });
        }
      }
      out(result);
    }

    /**
     * `beckett routine spend-report` (#77) — the `spend-report` action's BODY, run as its own
     * process by {@link spawnSpendReport} (and by a human who wants this week's bill on demand). It
     * reads the append-only spend ledger, rolls it up per task over the `--since` window, and posts
     * EXACTLY ONE per-task breakdown to `--channel`. Reuses the existing telemetry — it invents no
     * new metering. An empty/absent ledger posts a plain "nothing recorded" line rather than
     * failing: a fresh install has no history to bill, and that is not an error.
     */
    async function runRoutineSpendReport(argv: string[]): Promise<void> {
      const { flags } = parse(argv);
      // `--routine` / `--requester` are provenance only — nothing here branches on them.
      const logger = ctx.logger.child("spend-report").child(String(flags.routine ?? "manual"));
      const since = flags.since ? String(flags.since) : "7d";
      const channelId = flags.channel
        ? String(flags.channel)
        : (process.env.BECKETT_ROUTINE_CHANNEL_ID ?? "").trim();

      let text: string;
      try {
        text = formatWeeklyBill(readSpendLedger(ctx.config.paths.spend), { since });
      } catch (err) {
        // A ledger read/format failure still reports — an unattended weekly job that fails silently
        // is indistinguishable from one that never ran.
        logger.warn("spend-report could not build the bill", { error: String(err) });
        text = `🧾 **Weekly bill** — could not read the spend ledger (${(err as Error).message}).`;
      }
      logger.info("spend-report built", { since, channel: channelId || null });

      if (channelId) {
        try {
          await callBus(join(ctx.paths.beckettDir, "control.sock"), "discord.reply", { channelId, text }, 30_000);
        } catch (err) {
          logger.warn("spend-report could not post its bill", { error: String(err) });
        }
      } else {
        // Only reachable for a hand-run with no channel configured — the scheduler always passes one.
        logger.info("spend-report posted nothing (no channel configured)");
      }
      out({ since, channelId: channelId || null, text });
    }

    async function runRoutine(argv: string[]): Promise<void> {
      const sock = join(ctx.paths.beckettDir, "control.sock");
      const [sub, ...rest] = argv;
      const store = cliRoutineStore();

      if (!sub || sub === "list") {
        const routines = await store.list();
        out(routines.map(summarizeRoutine));
      }

      if (sub === "inspect") {
        const id = rest[0];
        if (!id) fail("usage: beckett routine inspect <id>");
        const routine = await store.get(id!);
        if (!routine) fail(`no such routine: ${id}`);
        out({ ...summarizeRoutine(routine!), state: routine!.state, createdAt: routine!.createdAt });
      }

      if (sub === "add") {
        const { _, flags } = parse(rest);
        const id = _[0];
        if (!id) {
          fail('usage: beckett routine add <id> --window 12:00-13:00 --tz <IANA> (--task "<browser task>" | --self "<prompt>") [--weekly <weekday>] [--name <n>] [--creds <entry>] [--channel <id>]');
        }
        const windowRaw = String(flags.window ?? "");
        const m = windowRaw.match(/^(\d{2}:\d{2})-(\d{2}:\d{2})$/);
        if (!m) fail("--window must look like 12:00-13:00 (24h HH:MM-HH:MM)");
        const tz = String(flags.tz ?? "");
        if (!tz || !isValidTimeZone(tz)) fail("--tz must be a valid IANA timezone, e.g. America/Los_Angeles");
        const task = flags.task ? String(flags.task) : "";
        const selfPrompt = flags.self ? String(flags.self) : "";
        // The self lane (issue #26) and the browser lane are two different destinations — one wakes
        // Beckett, the other wakes the browser — so a single routine can be exactly one of them.
        if (task.trim() && selfPrompt.trim()) {
          fail('--task and --self are mutually exclusive: a routine either runs a browser --task or wakes Beckett with --self');
        }
        if (!task.trim() && !selfPrompt.trim()) {
          fail('a routine needs a --task "<self-contained browser task>" or a --self "<prompt>"');
        }
        const credsEntryFlag = flags.creds ? String(flags.creds) : null;
        // Fail fast (issue: close the browser-action grounding bypass): a `browser` routine whose
        // task/creds target X/social would only ever be refused at fire time, forever — reject it
        // here so the operator hears about the grounded alternative immediately, not after a
        // silent no-op every window. Dispatch itself refuses too (`dispatchPlan` /
        // `browserActionTargetsXSocial`) — this is fail-fast, not the enforcement point.
        if (task.trim() && browserActionTargetsXSocial(task, credsEntryFlag)) {
          fail(
            'a "browser" routine may not target X/social (no SOURCES block, no POST: contract, no ' +
              'verification gate on that lane) — add an "agent" routine on the social-media agent instead',
          );
        }
        // No --weekly → daily, exactly as before. A typo'd weekday fails HERE, at add time, for
        // the same reason a bad --tz does: a cadence that can't resolve must never reach the store.
        let cadence: Cadence;
        try {
          cadence = cadenceFrom(flags.weekly ? String(flags.weekly) : undefined);
        } catch {
          fail("--weekly must be a weekday name, e.g. sunday");
          return;
        }
        // A self routine carries its own prompt and NO creds — its lane never touches the browser.
        const action: RoutineAction = selfPrompt.trim()
          ? {
              kind: "self",
              prompt: selfPrompt,
              channelId: flags.channel ? String(flags.channel) : undefined,
            }
          : {
              kind: "browser",
              task,
              credsEntry: flags.creds ? String(flags.creds) : undefined,
              channelId: flags.channel ? String(flags.channel) : undefined,
            };
        try {
          const routine = await store.add({
            id: id!,
            name: flags.name ? String(flags.name) : id!,
            enabled: true,
            action,
            schedule: {
              cadence,
              window: { start: m[1]!, end: m[2]!, tz },
            },
          });
          out(summarizeRoutine(routine));
        } catch (err) {
          fail((err as Error).message);
        }
      }

      if (sub === "remove" || sub === "rm") {
        const id = rest[0];
        if (!id) fail("usage: beckett routine remove <id>");
        const removed = await store.remove(id!);
        if (!removed) fail(`no such routine: ${id}`);
        out(`removed routine ${id}`);
      }

      if (sub === "enable" || sub === "disable") {
        const id = rest[0];
        if (!id) fail(`usage: beckett routine ${sub} <id>`);
        try {
          const routine = await store.setEnabled(id!, sub === "enable");
          out(summarizeRoutine(routine));
        } catch (err) {
          fail((err as Error).message);
        }
      }

      if (sub === "fire") {
        const { _, flags } = parse(rest);
        const id = _[0];
        if (!id) fail("usage: beckett routine fire <id> [--dry-run | --force]");
        const dryRun = flags["dry-run"] === true || flags.dryrun === true;
        const force = flags.force === true;
        const routine = await store.get(id!);
        if (!routine) fail(`no such routine: ${id}`);
        if (dryRun && routine!.action.kind === "watch") {
          // A `watch` dry-run needs the LIVE feed to say anything useful, so — unlike every other
          // lane's dry-run — it does real (read-only) I/O. It still never touches the bus/daemon:
          // fetching the feed and reading the watch store are both plain, unprivileged operations
          // this CLI process can do itself, and `previewWatchCycle` never mutates either.
          const preview = await previewWatchCycle(routine!, cliWatchPreviewDeps());
          out({
            dryRun: true,
            routine: id,
            lane: "watch",
            ...preview,
            note: preview.wouldPost
              ? "dry-run did NOT dispatch the agent or post. To fire for real: beckett routine fire " + id + " --force"
              : "dry-run did NOT mutate the watch state (seen-set/post-history) — nothing here counts against a real round.",
          });
        }
        if (dryRun) {
          // Build the exact dispatch plan WITHOUT running the agent or posting — proves the wiring,
          // no live post. For the agent lane the post text is authored at fire time, so it's not shown.
          const plan = buildDispatchPlan(routine!);
          out({
            dryRun: true,
            routine: id,
            lane: plan.lane,
            wouldDispatchTo: describeLaneTarget(plan),
            preview: plan.preview,
            agentId: plan.agentId,
            agentInput: plan.agentInput,
            credsEntry: plan.credsEntry,
            browserTask: plan.browserTask,
            depsUpdate: plan.depsUpdate,
            proactiveSweep: plan.proactiveSweep,
            selfPrompt: plan.selfPrompt,
            note: "dry-run did NOT run the agent or post. To fire for real: beckett routine fire " + id + " --force",
          });
        }
        // A real fire routes through the daemon so it dispatches on the browser lane, off this process.
        try {
          const res = await callBus(sock, "routine.fire", { id, force }, 30_000);
          if (!res.ok) fail(res.error ?? "routine fire failed");
          out(res.data);
        } catch (err) {
          fail((err as Error).message);
        }
      }

      if (sub === "watch-mode") {
        const [id, mode] = rest;
        if (!id || (mode !== "live" && mode !== "dry-run")) {
          fail("usage: beckett routine watch-mode <id> live|dry-run");
        }
        try {
          const routine = await store.setWatchDryRun(id!, mode === "dry-run");
          out(summarizeRoutine(routine));
        } catch (err) {
          fail((err as Error).message);
        }
      }

      // Show the proactive rot sweep's EXPLICIT opt-in repo list (issue #79) — the config the sweep
      // gates on. This is a READ ONLY: the list itself is declared in `[proactive_sweep] repos` in
      // config.toml and applied on every routine-store load, so there is exactly one source of
      // truth for an allow-list. The `--routine` flag targets a non-default sweep routine; it
      // defaults to the built-in `proactive-sweep`. Note: reconcileProactiveSweep forces the SAME
      // config list onto every proactive-sweep routine on every load, so `--routine` only changes
      // which routine's enabled/id fields are shown — the repos list is identical across all of them.
      if (sub === "proactive") {
        const { _, flags } = parse(rest);
        const [op] = _;
        const targetId = flags.routine ? String(flags.routine) : PROACTIVE_SWEEP_ID;

        if (!op || op === "list") {
          const routine = await store.get(targetId);
          if (!routine) fail(`no such routine: ${targetId}`);
          if (routine!.action.kind !== "proactive-sweep") fail(`routine ${targetId} is not a proactive-sweep routine`);
          out({
            routine: targetId,
            enabled: routine!.enabled,
            repos: (routine!.action as { repos: string[] }).repos,
            source: "config.toml [proactive_sweep] repos",
          });
        } else {
          fail(
            "beckett routine proactive list  (repos are declared in config.toml under [proactive_sweep] repos — " +
              "edit that, then restart the daemon)",
          );
        }
      }

      fail(
        "usage: beckett routine list | inspect <id> | add <id> ... | remove <id> | enable <id> | disable <id> | " +
          "fire <id> [--dry-run|--force] | watch-mode <id> live|dry-run | proactive list",
      );
    }

    /** Kept for the CLI dry-run/plan output: which executor a lane actually hands the work to. */
    function describeLaneTarget(plan: RoutineDispatchPlan): string {
      if (plan.lane === "deps-update") return "beckett routine deps-update (local maintenance subprocess)";
      if (plan.lane === "proactive-sweep") return "beckett routine proactive-sweep (local maintenance subprocess)";
      if (plan.lane === "spend-report") return "beckett routine spend-report (posts the per-task bill; never the browser)";
      if (plan.lane === "self") return "the concierge (a framed SYSTEM turn — wakes Beckett, never the browser)";
      if (plan.lane === "agent") return `invoke agent ${plan.agentId} → beckett browser (background lane)`;
      return "beckett browser (background lane)";
    }

    return {
      manifest: {
        id: "routines",
        version: "1.0.0",
        // The v5 spine literal's exact summary — asCapability projects it into the CLI slot.
        summary: "humanized recurring routines: add/list/remove/inspect + fire (dry-run or --force)",
        // Default FREE (matches the v5 spine slot the projection must reproduce); every
        // mutating capability overrides to a non-FREE posture below.
        actionClass: ActionClass.FREE,
        kind: "extension",
      },

      // --- v6 discovery + dispatch (router prose sourced from the routine module docs) ---
      capabilities: [
        {
          id: "routines.list",
          description:
            "List every named recurring routine — enabled state, its daily fuzz window, and " +
            "the next concrete fire time, humanized. Use when someone asks what is scheduled, " +
            "what runs daily, or when a routine fires next.",
          examples: ["what routines are scheduled?", "when does the daily post fire?"],
        },
        {
          id: "routines.inspect",
          description:
            "Inspect one routine by id: its definition plus the persisted per-period state " +
            "(the rolled fire time, the last-fired period). Use to debug why a routine did or " +
            "did not fire.",
          input: InspectArgs,
          examples: ["did the daily-x-shitpost routine fire today?"],
        },
        {
          id: "routines.add",
          description:
            "Schedule a NEW named recurring routine: a self-contained browser task that fires " +
            "once per day — or once per week on a named weekday — at a fuzzed time inside a 24h " +
            "HH:MM-HH:MM window in a given IANA timezone, dispatched through the background " +
            "browser lane. Use when someone asks for something to happen every day (\"post this " +
            "daily around noon\") or every week (\"check this every Sunday morning\").",
          actionClass: ActionClass.HANDSHAKE_GATED,
          input: AddArgs,
          examples: [
            "every day between 12:00 and 13:00 PT, check the status page and post a summary",
            "every Sunday morning between 08:00 and 10:00 PT, check the status page",
          ],
        },
        {
          id: "routines.remove",
          description:
            "Remove a routine by id so it never fires again (a removed built-in stays removed). " +
            "Use for \"stop the daily post\" / \"cancel that routine\".",
          actionClass: ActionClass.HANDSHAKE_GATED,
          input: RemoveArgs,
          examples: ["stop the daily shitpost routine"],
        },
        {
          id: "routines.fire",
          description:
            "Fire a named routine NOW through the live scheduler instead of waiting for its " +
            "window — dryRun builds and returns the dispatch plan without running the agent or " +
            "posting; force bypasses the once-per-period guard. A real fire dispatches on the " +
            "background browser lane under the routine's stored authorization.",
          actionClass: ActionClass.ALWAYS_ASK,
          input: FireArgs,
          examples: ["run the daily post now instead of waiting for the window"],
        },
      ],

      // Routes to the SAME store/scheduler core the CLI verbs and the routine.fire bus command
      // use, and NEVER exits the process: every failure — including a pre-init/pre-start call —
      // comes back as an ok:false result the caller can surface.
      invoke: async (call) => {
        try {
          switch (call.capabilityId) {
            case "routines.list": {
              const routines = await requireStore().list();
              return { ok: true, data: { routines: routines.map(summarizeRoutine) } };
            }
            case "routines.inspect": {
              const a = call.args as z.infer<typeof InspectArgs>;
              const routine = await requireStore().get(a.id);
              if (!routine) return { ok: false, error: `no such routine: ${a.id}` };
              return {
                ok: true,
                data: { ...summarizeRoutine(routine), state: routine.state, createdAt: routine.createdAt },
              };
            }
            case "routines.add": {
              // Defense in depth, the same rule as browser.task: identity comes from the
              // token-derived origin (the ext.invoke gate already refuses unauthenticated
              // non-FREE calls; this backstops a future direct caller).
              if (!call.origin?.userId) {
                return { ok: false, error: "routine changes need an authenticated authorized request" };
              }
              const a = call.args as z.infer<typeof AddArgs>;
              // A report channel may only RESTATE the origin channel, never redirect a
              // routine's fires somewhere the authorized request was not made (quick's rule).
              const requestedChannelId = a.channelId?.trim();
              if (requestedChannelId && call.origin.channelId && requestedChannelId !== call.origin.channelId) {
                return { ok: false, error: "routines must report to the channel where the authorized request began" };
              }
              // Fail fast, same rule and reason as `beckett routine add` (issue: close the
              // browser-action grounding bypass): `routines.add` only ever builds `kind: "browser"`
              // actions — this is exactly the seam a natural-language "post to X every morning"
              // request reaches (it's how `x-social-morning`/`x-social-evening` were created). A
              // task/creds pair that targets X/social is refused here so the concierge can say why,
              // instead of silently creating a routine that will refuse itself every fire.
              if (browserActionTargetsXSocial(a.task, a.credsEntry ?? null)) {
                return {
                  ok: false,
                  error:
                    'a "browser" routine may not target X/social (no SOURCES block, no POST: contract, no ' +
                    "verification gate on that lane) — social posts must go through the grounded social-media agent instead",
                };
              }
              const m = a.window.match(/^(\d{2}:\d{2})-(\d{2}:\d{2})$/)!;
              const routine = await requireStore().add({
                id: a.id,
                name: a.name?.trim() || a.id,
                enabled: true,
                action: {
                  kind: "browser",
                  task: a.task,
                  ...(a.credsEntry ? { credsEntry: a.credsEntry } : {}),
                  ...(requestedChannelId ? { channelId: requestedChannelId } : {}),
                },
                schedule: {
                  cadence: cadenceFrom(a.weekday),
                  window: { start: m[1]!, end: m[2]!, tz: a.tz },
                },
              });
              return { ok: true, data: summarizeRoutine(routine) };
            }
            case "routines.remove": {
              if (!call.origin?.userId) {
                return { ok: false, error: "routine changes need an authenticated authorized request" };
              }
              const a = call.args as z.infer<typeof RemoveArgs>;
              const removed = await requireStore().remove(a.id);
              if (!removed) return { ok: false, error: `no such routine: ${a.id}` };
              return { ok: true, data: { removed: a.id } };
            }
            case "routines.fire": {
              if (!call.origin?.userId) {
                return { ok: false, error: "firing a routine needs an authenticated authorized request" };
              }
              const a = call.args as z.infer<typeof FireArgs>;
              // The LIVE scheduler (armed by the late start) — a dry run still builds the plan
              // through it so fireNow's semantics stay the single source of truth.
              const plan = await requireScheduler().fireNow(a.id, {
                ...(a.force !== undefined ? { force: a.force } : {}),
                ...(a.dryRun !== undefined ? { dryRun: a.dryRun } : {}),
              });
              return {
                ok: true,
                data: {
                  routineId: plan.routineId,
                  lane: plan.lane,
                  preview: plan.preview,
                  credsEntry: plan.credsEntry,
                  dryRun: a.dryRun === true,
                },
              };
            }
            default:
              return { ok: false, error: `routines: unknown capability "${call.capabilityId}"` };
          }
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      },

      lifecycle: {
        // A firing routine dispatches INTO the live system — the cron loop must arm at the
        // daemon's sanctioned LATE position (after pollers/mail/agents), never the early sweep.
        startPhase: "late",
        // Construction only — the store (durable routines.json) plus the scheduler's deps,
        // fully INERT: no interval armed, nothing ticks until start().
        init: () => {
          store =
            deps.createStore?.(ctx) ??
            new RoutineStore(join(ctx.paths.beckettDir, "routines.json"), { builtins: builtinOverrides() });
          watchStateStore =
            deps.createWatchStateStore?.(ctx) ??
            new WatchStateStore(
              join(ctx.paths.beckettDir, "watch-state.json"),
              deps.now ? { now: deps.now } : {},
            );
          schedulerDeps = {
            store,
            logger: ctx.logger.child("routine"),
            dispatcher: {
              dispatch: (plan, routine) => dispatchPlan(plan, routine),
              deferReason: (plan) => deferReason(plan),
            },
            ...(deps.now ? { now: deps.now } : {}),
            ...(deps.rng ? { rng: deps.rng } : {}),
            ...(deps.intervalMs !== undefined ? { intervalMs: deps.intervalMs } : {}),
          };
        },
        // Arms the loop exactly as the old boot did: startRoutineScheduler (interval armed at
        // construction, internals untouched) + the 5s post-boot prime so a routine whose
        // window is live right now is caught up without waiting a full tick. Re-entry is a
        // no-op — a second sweep must never arm a second interval (redundant roll/persist
        // churn; per-period idempotency would still prevent a double FIRE). The `watch` poll
        // loop arms alongside it, off the SAME store — `beckett routine enable/disable` needs
        // no restart because both loops re-read the store live every tick.
        start: () => {
          if (scheduler) return;
          if (!schedulerDeps || !store) {
            throw new Error("the routines extension is not initialized (lifecycle.init has not run)");
          }
          const started = deps.createScheduler?.(schedulerDeps) ?? startRoutineScheduler(schedulerDeps);
          scheduler = started;
          // Prime once shortly after boot. Best-effort; failures are logged inside the scheduler.
          primeTimer = setTimeout(() => void started.tick().catch(() => {}), 5_000);
          primeTimer.unref?.();

          const watchLoopDeps = {
            routineStore: store,
            watchDeps: watchDeps(),
            ...(deps.now ? { now: deps.now } : {}),
            ...(deps.watchIntervalMs !== undefined ? { intervalMs: deps.watchIntervalMs } : {}),
          };
          watchLoop = deps.createWatchLoop?.(watchLoopDeps) ?? startWatchLoop(watchLoopDeps);
        },
        // Idempotent: clears the prime + interval; a later start() may re-arm cleanly.
        stop: () => {
          if (primeTimer) {
            clearTimeout(primeTimer);
            primeTimer = null;
          }
          scheduler?.stop();
          scheduler = null;
          watchLoop?.stop();
          watchLoop = null;
        },
        health: async () => {
          if (!store) return { ok: false, detail: "not initialized" };
          try {
            const routines = await store.list();
            const enabled = routines.filter((r) => r.enabled);
            const at = (deps.now ?? (() => new Date()))();
            const rng = deps.rng ?? Math.random;
            let next: Date | null = null;
            for (const routine of enabled) {
              // `watch` has no schedule to project a "next fire" from — it fires 0..n times a
              // day depending on the feed, not on a fixed clock.
              if (!routine.schedule) continue;
              const fire = nextFireAt(routine.schedule, routine.state, at, rng);
              if (!next || fire.getTime() < next.getTime()) next = fire;
            }
            const watching = enabled.filter((r) => r.action.kind === "watch").length;
            return {
              ok: true,
              detail:
                `scheduler ${scheduler ? "running" : "idle"}; ` +
                `${enabled.length}/${routines.length} routines enabled` +
                (watching ? `; ${watching} watch loop ${watchLoop ? "running" : "idle"}` : "") +
                (next ? `; next fire ${next.toISOString()}` : ""),
            };
          } catch (err) {
            return { ok: false, detail: (err as Error).message };
          }
        },
      },

      // --- carried v5 facets: the CLI verb + its pinned help token, projected into the same
      // cli/beckett.ts spine slot via asCapability. The routine.fire bus command stays
      // concierge-owned (its body binds this.routineOps — see the header).
      cliVerbs: [
        // `routine deps-update` is declared FIRST only for readability; resolveCliVerb matches the
        // longest verb, so the two-word name always wins over the bare `routine` below it. It
        // carries no `cliHelp` token of its own (like spend/journal/config): it is a routine's BODY
        // launched by the scheduler, not a surface a person is meant to browse to.
        {
          name: "routine deps-update",
          summary: "run the weekly dependency update in an isolated clone and open a PR",
          usage:
            "beckett routine deps-update [--repo <owner/name>] [--base main] [--source <checkout>] [--channel <id>]",
          run: runRoutineDepsUpdate,
        },
        {
          name: "routine proactive-sweep",
          summary: "sweep opted-in repos for rot (red CI / advisories / broken README links) and open labelled PRs",
          usage:
            "beckett routine proactive-sweep [--repos <owner/name,owner/name>] [--channel <id>]",
          run: runRoutineProactiveSweep,
        },
        {
          // Like `routine deps-update`: a routine's BODY launched by the scheduler, not a browsing
          // surface. Two-word name wins over the bare `routine` via longest-verb matching.
          name: "routine spend-report",
          summary: "post the per-task spend bill for a rolling window to a channel",
          usage: "beckett routine spend-report [--since 7d] [--channel <id>]",
          run: runRoutineSpendReport,
        },
        {
          name: "routine",
          summary: "named recurring tasks that fire at a fuzzed time inside a daily window, or on an event",
          usage:
            'beckett routine list | inspect <id> | add <id> --window 12:00-13:00 --tz <IANA> --task "<task>" [--weekly <weekday>] [--creds <entry>] | remove <id> | enable|disable <id> | fire <id> [--dry-run|--force] | watch-mode <id> live|dry-run',
          run: runRoutine,
        },
      ],
      busCommands: [],
      cliHelp: "routine list|inspect|add|remove|fire",

      store: requireStore,
      scheduler: requireScheduler,
    };
  };
