/**
 * Beckett v7 — the RunSupervisor (`src/run/supervisor.ts`)
 * =======================================================================================
 * The engine. The daemon's one staffing loop: no board, no poller, no ticket ceremony. A run reaches it one of three ways —
 *
 *   1. the `run.deploy` control-bus ping (`beckett task deploy` just created it),
 *   2. the boot scan of {@link RunStore.live} (daemon restart / crash recovery),
 *   3. the staffing watchdog (a live run that has sat workerless past its grace),
 *
 * — and from there it drives implement → review → publish → done, with a bounded rework
 * loop and a park for anything a human has to look at. `run.cancel` is the one lever that stops a
 * live run (abort + reap the worker, drop the reservation, state → `cancelled`).
 *
 * The review stage is GATED by the run's cast (`reviewTierFor`): `self` (explicit, or derived from
 * a low/medium implement effort) publishes straight off a passing implement stage; `fresh` (the
 * default) spawns the separate adversarial reviewer.
 *
 * WHAT IS DELIBERATELY REUSED, NOT REBUILT. Every worker prompt, persona, done-signal parse,
 * and driver launch stays in `src/dispatch/stages.ts` + `src/dispatch/spawn.ts`, untouched.
 * The supervisor reaches them through {@link runAsWorkItem} (`./adapter.ts`), which projects a
 * Run onto the narrow {@link WorkItem} shape they read.
 *
 * BEHAVIORS PORTED VERBATIM FROM THE DISPATCHER (each is load-bearing, each was a bug once):
 *   - claim-before-dispatch: the reservation Symbol goes into {@link staffing} SYNCHRONOUSLY,
 *     before any await, and a retiring spawn's `finally` can only release ITS OWN token.
 *   - the per-run budget ceiling, which excludes spend rows older than `run.createdAt`.
 *   - the staffing watchdog: re-staff once, then park with a message.
 *   - periodic worktree checkpointing + the crash-recovery ledger (`--resume <sessionId>`,
 *     park when a restart-interrupted worker cannot resume).
 *   - the durable publish outbox: the row owns the worktree until it publishes or a human
 *     takes it, so a GitHub hiccup can never turn finished work back into work.
 *
 * WHAT IS NEW IN V7: the spec.md scaffold + spec-gate Stop hook are written BEFORE the
 * implement worker spawns; workers carry `--name <run.sessionName>` and accept cross-session
 * messages; and an `--ultracode` run's implement stage is cast onto opus at the deepest tier.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Config, Harness, Logger, WorkerEvent } from "../types.ts";
import type { HarnessSpec } from "./cast.ts";
import { applySonnetFirst, DEFAULT_IMPLEMENT_MODEL, isOpusModel } from "./cast.ts";
import type { WorkItem } from "./work-item.ts";
import type { ProgressSink } from "../progress/journal.ts";
import { formatEvent } from "../progress/journal.ts";
import {
  ACTIVITY_CONTEXT_LINES,
  ACTIVITY_STAGE,
  clampThrottleSecs,
  deriveActivity,
  newActivityThrottle,
  shouldRefreshActivity,
  summarizeActivity as summarizeActivityDefault,
  type ActivityThrottleState,
  type SummarizeActivityOptions,
} from "./activity.ts";
import { log } from "../log.ts";
import { projectSlug } from "./cast.ts";
import { classifyDiffSurface, reviewDepthLine } from "./review-depth.ts";
import { hardCapSeconds, sweepLedgeredWorker } from "../drivers/proc.ts";
import {
  commitWorktree,
  createWorktree,
  ensureProjectRepo,
  fetchRemote,
  hasDiffSince,
  headSha,
  readBranchVsMain,
  readDiff,
  removeWorktree,
} from "../worker/worktree.ts";
import { spawnWorker, type WorkerHandle } from "../dispatch/spawn.ts";
import {
  defaultEffortFor,
  parseDoneSignal,
  stageRegistry,
  type StageView,
} from "../dispatch/stages.ts";
import { DispatchEventBus, type DispatchEventBusOptions, type DispatchOutcome } from "../dispatch/events.ts";
import {
  PublishOutbox,
  PUBLISH_RETRY_DELAYS_MS,
  classifyBranchLanding,
  planPublishRetry,
  publishFailureReason,
  publishFixHint,
  publishParkAdvice,
  type PublishOperation,
  type PublishRetryPlan,
} from "../dispatch/publish-outbox.ts";
import { appendSpendRecord, readSpendLedger, spendForTicket, type SpendOutcome } from "../spend.ts";
import { resolveProjectOwner, selfProjectSlug } from "../github/owner.ts";
import { specGateSpec } from "../hooks/registry.ts";
import { parseSpecChecklist, renderSpecScaffold, specRunId, SPEC_FILE_REL, type ParsedSpecChecklist } from "./spec-file.ts";
import { runAsWorkItem } from "./adapter.ts";
import type { RunStore } from "./store.ts";
import type { Run, RunStage, RunStateChange } from "./types.ts";
import { RUN_TERMINAL } from "./types.ts";

// =======================================================================================
// Collaborators
// =======================================================================================

/** The git ops the supervisor performs; injectable so tests never touch real git. */
export interface RunGitOps {
  commitWorktree: typeof commitWorktree;
  headSha: typeof headSha;
  hasDiffSince: typeof hasDiffSince;
  ensureProjectRepo: typeof ensureProjectRepo;
  readDiff: typeof readDiff;
  createWorktree: typeof createWorktree;
  removeWorktree: typeof removeWorktree;
  fetchRemote: typeof fetchRemote;
  readBranchVsMain: typeof readBranchVsMain;
}

/**
 * The control-bus subscription port. Production wires the concierge's bus (the `run.deploy`
 * ping `beckett task deploy` sends); tests hand in a trivial fake. Absent → the supervisor
 * still works, driven by its boot scan + watchdog alone.
 */
export interface RunBusPort {
  on(verb: string, handler: (args: Record<string, unknown>) => void | Promise<void>): void;
}

export interface RunSupervisorDeps {
  store: RunStore;
  config: Config;
  /** Absolute path of a run's own project repo (`~/Projects/<slug>`). */
  resolveRepoRoot: (run: Run) => string;
  /** Control-bus subscription for `run.deploy` / `run.steer`. Omitted in tests. */
  bus?: RunBusPort;
  /** Override any git op (tests inject fakes); unset ops use the real worktree.ts impl. */
  gitOps?: Partial<RunGitOps>;
  /** Stage lookup; defaults to the shared built-in view (implement/review live there). */
  stages?: StageView;
  /** Publish a finished run's branch to GitHub. Omitted → publishing is skipped (local-only). */
  publishRepo?: (args: {
    slug: string;
    repoRoot: string;
    description: string;
    ticket?: string;
    baseSha?: string;
    commitMessage?: string;
  }) => Promise<{ url: string; kind: "pushed" | "pr"; prUrl?: string }>;
  /** Granular worker events → the run's private journal (keyed by run id). */
  progress?: ProgressSink;
  /** Central telemetry bus; digests/cards/dream all read these rows unchanged. */
  dispatchEvents?: DispatchEventBus;
  dispatchEventsPath?: string;
  dispatchLiveSink?: DispatchEventBusOptions["liveSink"];
  /** `<beckettDir>/run-publish-outbox.jsonl` — durable publish retries, one row per run. */
  publishOutboxPath?: string;
  /** `<beckettDir>/run-state.json` — the crash-recovery ledger + buffered steering. */
  runtimeStatePath?: string;
  /** Append-only spend JSONL; defaults to `[paths] spend`. */
  spendLedgerPath?: string;
  /** Harness health probe (`preflightFor`); omitted → every harness is presumed healthy. */
  preflight?: (harness: Harness) => Promise<{ ok: boolean; problems: string[] }>;
  /** Fired when a run's PR opens, so the GitHub poller watches it keyed by run id. */
  onPrOpened?: (info: { prUrl: string; run: Run }) => void | Promise<void>;
  /**
   * Fired on every run state transition, so the concierge can surface milestones to the channel
   * that asked. Best-effort by contract: a throwing listener is logged and never fails the patch.
   */
  onStateChange?: (event: RunStateChange) => void;
  /** Fired on every successful publication (push or PR). */
  onPublished?: (info: { url: string; kind: "pushed" | "pr"; prUrl?: string; run: Run }) => unknown;
  /** Test seam for the orphan sweep; default ps-verifies + kills. */
  sweepOrphan?: (pid: number, expectedBin: string) => boolean;
  /**
   * The OPTIONAL model polish for the activity blurb (`./activity.ts`'s
   * {@link summarizeActivity}). Injected so tests never spawn a CLI or touch the network;
   * production leaves it unset, and `[runs.activity] provider = "off"` (the default) means it is
   * never called at all.
   */
  summarizeActivity?: (journalLines: string[], opts: SummarizeActivityOptions) => Promise<string | null>;
  /** Clock seam for the blurb throttle (tests). Defaults to `Date.now`. */
  now?: () => number;
  logger?: Logger;
}

/** A spawn deferred because the live-run cap was reached. */
interface PendingRunSpawn {
  runId: string;
  stage: RunStage;
}

/** One live worker's crash-recovery ledger entry (the dispatcher's `LedgeredWorker`, re-keyed). */
interface LedgeredRunWorker {
  stage: RunStage;
  workerId: string;
  sessionId: string;
  pid: number;
  workspace: string;
  harness: string;
  spawnedAt: number;
  lastCheckpointAt?: number;
  lastCheckpointSha?: string;
}

/**
 * A stage this daemon OWES a run: its worker died of a lifecycle cause (a daemon shutdown, a
 * harness crash) rather than finishing, so the run parked holding work nobody is driving.
 *
 * Durable on purpose — the publish outbox survives a restart and workers had no equivalent, which
 * is issue #244: after the 2026-08-12 restart the betterwright run stayed `parked`, its review
 * never re-ran, and its branch was never pushed. Written at the instant of the park (the one
 * moment both the stage AND the cause are in hand) and consumed once, on the next boot.
 */
interface OwedResume {
  stage: RunStage;
  /** The lifecycle cause, verbatim — what the boot log and the run's timeline say. */
  cause: string;
  /** Epoch ms of the death, so a boot can report how long the run sat owed. */
  at: number;
}

interface RunRuntimeState {
  version: 1;
  liveLedger: Record<string, LedgeredRunWorker>;
  pendingSteers: Record<string, string[]>;
  /** Stages owed a re-dispatch after a lifecycle death (#244). Absent on pre-#244 state files. */
  owedResumes?: Record<string, OwedResume>;
}

interface SpendStageMeta {
  harness: string;
  model: string;
  effort: string;
  startedAt: number;
}

type PublishOutcome =
  | { status: "skipped" }
  | { status: "published"; url: string; kind: "pushed" | "pr"; prUrl?: string }
  | { status: "failed"; error: string };

/**
 * The project slug a run's code lives in.
 *
 * `run.repo === null` means BECKETT ITSELF — that is the binding Run contract (`src/run/types.ts`,
 * architecture.md §"The run model"), and it is the DEFAULT path: `beckett task deploy "…"` with no
 * `--repo` is a change to Beckett. Falling back to the run id instead (the ticket dispatcher's
 * per-ticket-sandbox precedent) would `git init` a brand-new empty `~/Projects/run-2026…` and let
 * the worker implement into a void, so the fallback here is the self-project slug and nothing else.
 *
 * Exported because `shell/main.ts` resolves the repo ROOT from the same slug — the two must never
 * disagree about which checkout a run owns.
 */
export function runProjectSlug(run: Pick<Run, "repo">, env: Record<string, string | undefined> = process.env): string {
  return projectSlug(run.repo?.trim() || selfProjectSlug(env));
}

/**
 * `progress/cards.ts`'s `specReader` adapter: reads a run's LIVE `## Checklist` progress off its
 * workspace, keyed by `DispatchEvent.runId` (the id the supervisor stamps every trace
 * with). Exported standalone — `shell/main.ts` wires it into `createProgressCardService` — so
 * the card module itself never touches the filesystem. `store` is typed to the one method this
 * needs so a test can hand in a trivial fake instead of a real `RunStore`.
 */
export function runSpecReader(
  store: Pick<RunStore, "get">,
): (runId: string) => { done: number; total: number } | null {
  return (runId) => {
    const run = store.get(runId);
    if (!run?.workspace) return null;
    const path = join(run.workspace, SPEC_FILE_REL);
    if (!existsSync(path)) return null;
    try {
      const parsed = parseSpecChecklist(readFileSync(path, "utf8"));
      return { done: parsed.done, total: parsed.total };
    } catch {
      return null; // a torn/mid-write spec.md is not worth surfacing as a card error
    }
  };
}

/** Watchdog grace: reuse the dispatcher's `[supervise] staffing_watchdog_s` (default 120s). */
const DEFAULT_WATCHDOG_GRACE_S = 120;
/** The watchdog tick, mirroring the dispatcher: never slower than half the grace, floor 15s. */
const WATCHDOG_MIN_INTERVAL_MS = 15_000;
/** Publish-outbox drain cadence — the shortest retry delay, so a due row waits at most one tick. */
const PUBLISH_DRAIN_INTERVAL_MS = PUBLISH_RETRY_DELAYS_MS[0];
/**
 * The longest a run may sit in `publishing` with nothing scheduled to move it before
 * {@link RunSupervisor.reconcilePublishing} parks it. Comfortably longer than the whole retry
 * ladder (30s + 2m + 10m plus drain slack), because a row with a real `nextAttemptAt` is EXEMPT —
 * this budget only ever measures a run nothing is going to touch again.
 */
export const PUBLISH_STALL_MS = 20 * 60_000;

// =======================================================================================
// RunSupervisor
// =======================================================================================

export class RunSupervisor {
  private readonly store: RunStore;
  private readonly config: Config;
  private readonly git: RunGitOps;
  private readonly stages: StageView;
  private readonly logger: Logger;
  private readonly resolveRepoRoot: (run: Run) => string;
  private readonly publishRepo?: RunSupervisorDeps["publishRepo"];
  private readonly progress?: ProgressSink;
  private readonly preflight?: RunSupervisorDeps["preflight"];
  private readonly onPrOpened?: RunSupervisorDeps["onPrOpened"];
  private readonly onStateChange?: RunSupervisorDeps["onStateChange"];
  private readonly onPublished?: RunSupervisorDeps["onPublished"];
  private readonly sweepOrphan: (pid: number, expectedBin: string) => boolean;
  private readonly bus?: RunBusPort;
  private readonly events: DispatchEventBus;
  private readonly publishOutbox?: PublishOutbox;
  private readonly runtimeStatePath?: string;
  private readonly spendLedgerPath: string;

  /** Live worker handles, keyed by run id. */
  private readonly workers = new Map<string, WorkerHandle>();
  /** Claim-before-dispatch reservations. The Symbol is the token a `finally` compares against. */
  private readonly staffing = new Map<string, symbol>();
  private readonly pending: PendingRunSpawn[] = [];
  private readonly liveLedger = new Map<string, LedgeredRunWorker>();
  private readonly pendingSteers = new Map<string, string[]>();
  /** Stages owed a boot re-dispatch because their worker died mid-flight (#244). Persisted. */
  private readonly owedResumes = new Map<string, OwedResume>();
  private readonly resumables = new Map<string, { stage: RunStage; sessionId: string; harness: string }>();
  private readonly restartInterrupted = new Map<string, RunStage>();
  private readonly finishing = new Set<string>();
  private readonly spendMetaByWorker = new Map<string, SpendStageMeta>();
  private readonly unstaffedSince = new Map<string, number>();
  /**
   * When the current publish attempt for a run started — the clock {@link reconcilePublishing}
   * measures a stall against. Seeded from `updatedAt` for a run the daemon inherited (a restart
   * loses the in-process map but not the ledger), and restarted by every real attempt so a retry
   * that is genuinely running is never mistaken for a wedge.
   */
  private readonly publishStallClock = new Map<string, number>();
  private readonly watchdogRestaffed = new Set<string>();
  private readonly budgetBlocked = new Set<string>();
  /**
   * The live activity blurb's whole state, per run: the tail of journal lines the worker produced,
   * its refresh throttle, and the phrase last put on the card. EPHEMERAL on purpose — a blurb is
   * decoration on a durable timeline, so none of this is written to runs.json or survives a
   * restart, and a restarted daemon simply derives a fresh phrase from the next tool call.
   */
  private readonly activityLines = new Map<string, string[]>();
  private readonly activityThrottles = new Map<string, ActivityThrottleState>();
  private readonly activityPublished = new Map<string, { phrase: string; at: number }>();
  private readonly summarizeActivity: (
    journalLines: string[],
    opts: SummarizeActivityOptions,
  ) => Promise<string | null>;
  private readonly now: () => number;
  private recoveredWorkers: Record<string, LedgeredRunWorker> | null = null;

  private watchdogTimer?: ReturnType<typeof setInterval>;
  private watchdogInFlight = false;
  /** Epoch ms of the last completed staffing pass — the status dashboard's liveness signal. */
  private lastTickAt: number | null = null;
  private publishDrainTimer?: ReturnType<typeof setInterval>;
  private checkpointTimer?: ReturnType<typeof setInterval>;
  private checkpointInFlight = false;
  private started = false;
  /**
   * THE SHUTDOWN FLAG (#247). Raised by {@link stop}, which `shell/main.ts` calls early in its
   * drain — ahead of every teardown that can take a worker with it — so a worker that dies after
   * this point died BECAUSE the daemon is going down, and its park says so instead of quoting
   * whatever the model happened to be saying.
   */
  private shuttingDown = false;

  constructor(deps: RunSupervisorDeps) {
    this.store = deps.store;
    this.config = deps.config;
    this.resolveRepoRoot = deps.resolveRepoRoot;
    this.git = {
      commitWorktree,
      headSha,
      hasDiffSince,
      ensureProjectRepo,
      readDiff,
      createWorktree,
      removeWorktree,
      fetchRemote,
      readBranchVsMain,
      ...deps.gitOps,
    };
    this.stages = deps.stages ?? stageRegistry;
    this.logger = deps.logger ?? log.child("run.supervisor");
    this.publishRepo = deps.publishRepo;
    this.progress = deps.progress;
    this.preflight = deps.preflight;
    this.onPrOpened = deps.onPrOpened;
    this.onStateChange = deps.onStateChange;
    this.onPublished = deps.onPublished;
    this.bus = deps.bus;
    this.sweepOrphan =
      deps.sweepOrphan ?? ((pid, expectedBin) => sweepLedgeredWorker(pid, expectedBin, this.logger));
    this.summarizeActivity = deps.summarizeActivity ?? summarizeActivityDefault;
    this.now = deps.now ?? Date.now;
    this.events =
      deps.dispatchEvents ??
      new DispatchEventBus({
        path: deps.dispatchEventsPath,
        liveSink: deps.dispatchLiveSink,
        onSinkError: (error) =>
          this.logger.warn("run event sink failed (persisted timeline is intact)", { error: String(error) }),
      });
    this.publishOutbox = deps.publishOutboxPath
      ? new PublishOutbox(deps.publishOutboxPath, this.logger.child("run-publish-outbox"))
      : undefined;
    this.runtimeStatePath = deps.runtimeStatePath;
    this.spendLedgerPath =
      deps.spendLedgerPath ??
      this.config.paths?.spend ??
      join(process.env.HOME ?? "/home/beckett", ".beckett", "spend.jsonl");
    this.loadRuntimeState();
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────────────────

  /**
   * Arm the engine. Subscribes the `run.deploy` bus ping, recovers whatever the previous
   * daemon left mid-flight, re-admits every live run, then arms the checkpoint + watchdog
   * loops. Idempotent — a second call is a no-op.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.bus?.on("run.deploy", async (args) => {
      const runId = typeof args.runId === "string" ? args.runId : "";
      if (runId) await this.admit(runId);
    });
    this.bus?.on("run.steer", async (args) => {
      const runId = typeof args.runId === "string" ? args.runId : "";
      const note = typeof args.note === "string" ? args.note : "";
      if (runId && note.trim()) await this.steer(runId, note);
    });
    this.bus?.on("run.cancel", async (args) => {
      const runId = typeof args.runId === "string" ? args.runId : "";
      const reason = typeof args.reason === "string" && args.reason.trim() ? args.reason.trim() : undefined;
      if (runId) await this.cancel(runId, reason);
    });
    await this.recoverFromCrash();
    // BEFORE the boot scan below, so a run whose stage this daemon owes is back in a staffable
    // state by the time `admitRun` walks the ledger (#244).
    await this.requeueOwedStages();
    await this.replayPublishes();
    await this.resumeInterruptedPublishes();
    for (const run of this.store.live()) this.admitRun(run);
    this.startCheckpointLoop();
    this.startStaffingWatchdog();
    this.startPublishDrainLoop();
    this.logger.info("run supervisor started", { live: this.store.live().length });
  }

  /**
   * Tear down the timers (daemon shutdown). Idempotent; live workers are left to their drain.
   *
   * Also raises {@link shuttingDown}: from here on a worker death is the RESTART's doing, and both
   * the recorded cause (#247) and the owed-resume ledger (#244) key on knowing that.
   */
  stop(): void {
    this.shuttingDown = true;
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    if (this.publishDrainTimer) clearInterval(this.publishDrainTimer);
    this.checkpointTimer = undefined;
    this.watchdogTimer = undefined;
    this.publishDrainTimer = undefined;
    this.started = false;
  }

  /** The `run.deploy` entry point: staff this run's current stage if it isn't already staffed. */
  async admit(runId: string): Promise<void> {
    const run = this.store.get(runId);
    if (!run) {
      this.logger.warn("run.deploy for an unknown run", { runId });
      return;
    }
    // The deploy receipt (progress cards): fire the FIRST observable event for this run right
    // here, before a worktree exists or a worker spawns, so a card shows "queued" within seconds
    // of the CLI call instead of waiting on provisioning to finish. Guarded to run state "queued"
    // only: a duplicate run.deploy bus ping (or a manual re-admit) against a run already past
    // admission must not flip its live card's phase back to "queued" mid-flight.
    if (run.state === "queued") this.trace(run, "run:deploy", "started", "queued");
    this.admitRun(run);
  }

  /**
   * When the staffing watchdog last completed a pass, or null before its first. This is the
   * dashboard's honest "is the engine still turning" signal: there is no out-of-process service
   * left to ping, so liveness is the loop's own heartbeat.
   */
  lastReconcileAt(): number | null {
    return this.lastTickAt;
  }

  /**
   * Live status rows for `beckett status` (the run board's source).
   *
   * `startedAt` is the live worker's spawn time (null when nothing is running for this run) — the
   * one field the deploy drain guard needs to say "reviewer, age 4m" instead of naming a bare id
   * (`src/deploy/run-drain.ts`, #243). Additive: every existing consumer reads the other four.
   */
  live(): Array<{
    runId: string;
    state: string;
    stage: string | null;
    workerId: string | null;
    startedAt: number | null;
  }> {
    const rows: Array<{
      runId: string;
      state: string;
      stage: string | null;
      workerId: string | null;
      startedAt: number | null;
    }> = [];
    for (const run of this.store.live()) {
      const handle = this.workers.get(run.id);
      rows.push({
        runId: run.id,
        state: run.state,
        stage: handle ? (handle.stage as RunStage) : this.stageFor(run),
        workerId: handle?.id ?? null,
        startedAt: handle ? this.liveLedger.get(run.id)?.spawnedAt ?? null : null,
      });
    }
    return rows;
  }

  // ── admission ─────────────────────────────────────────────────────────────────────────

  /** The stage a run in this state wants staffed, or null when nothing should run. */
  private stageFor(run: Run): RunStage | null {
    switch (run.state) {
      case "queued":
      case "implementing":
        return "implement";
      case "reviewing":
        return "review";
      default:
        // `publishing` is owned by the publish outbox row; terminal states staff nothing.
        return null;
    }
  }

  private admitRun(run: Run): void {
    if (RUN_TERMINAL.has(run.state)) return;
    const stage = this.stageFor(run);
    if (!stage) return;
    this.spawnGuarded(run, stage);
  }

  /** True if a worker is live, OR a spawn is mid-flight, for this run (airtight dedup). */
  private isStaffed(runId: string): boolean {
    return this.workers.has(runId) || this.staffing.has(runId);
  }

  private isPending(runId: string): boolean {
    return this.pending.some((p) => p.runId === runId);
  }

  /** True when live workers + admitted-but-not-yet-live spawns already fill `runs.max_live`. */
  private atCap(): boolean {
    return this.workers.size + this.staffing.size >= (this.config.runs?.max_live ?? 3);
  }

  /**
   * Per-run spend ceiling. Sums this run's accrued cost from the spend ledger, EXCLUDING rows
   * that predate `run.createdAt` — run ids are date-stamped and unique, but the guard keeps the
   * dispatcher's posture so a re-created id can never inherit a prior incarnation's bill. A cap
   * of 0 disables it; a ledger read failure reads as "not over" so observability can never wedge
   * staffing.
   */
  private budgetCeiling(run: Run): { over: boolean; spentUsd: number; capUsd: number } {
    const capUsd = this.config.runs?.budget_usd_per_run || this.config.budget?.per_task_usd_cap || 0;
    if (capUsd <= 0) return { over: false, spentUsd: 0, capUsd: 0 };
    const createdAt = Date.parse(run.createdAt ?? "");
    if (!Number.isFinite(createdAt)) {
      this.logger.warn("budget ceiling run creation time unavailable — allowing staffing", { run: run.id });
      return { over: false, spentUsd: 0, capUsd };
    }
    try {
      const spentUsd = spendForTicket(readSpendLedger(this.spendLedgerPath), run.id, createdAt);
      return { over: spentUsd >= capUsd, spentUsd, capUsd };
    } catch (err) {
      this.logger.warn("budget ceiling read failed — allowing staffing", { run: run.id, error: String(err) });
      return { over: false, spentUsd: 0, capUsd };
    }
  }

  /** Spawn immediately if a slot is free, else enqueue for {@link pump}. */
  private spawnGuarded(run: Run, stage: RunStage): void {
    // `finishing` is deliberately NOT consulted here: the stage-advance call comes FROM inside a
    // finish handler, and the flag exists only to keep the watchdog from reading a mid-finish run
    // as wedged. `isStaffed` is the real dedup.
    if (this.isStaffed(run.id)) return;
    const budget = this.budgetCeiling(run);
    if (budget.over) {
      this.trace(run, `${stage}:staff`, "held", `per-run budget reached ($${budget.spentUsd.toFixed(2)} ≥ $${budget.capUsd.toFixed(2)})`);
      if (!this.budgetBlocked.has(run.id)) {
        this.budgetBlocked.add(run.id);
        this.logger.warn("staffing blocked: per-run budget ceiling reached", {
          run: run.id,
          spentUsd: budget.spentUsd,
          capUsd: budget.capUsd,
        });
      }
      return;
    }
    if (this.atCap()) {
      if (!this.isPending(run.id)) this.pending.push({ runId: run.id, stage });
      this.trace(run, `${stage}:staff`, "held", "queued at live-run cap");
      return;
    }
    this.launchSpawn(run, stage);
  }

  /**
   * Reserve the run's slot SYNCHRONOUSLY BEFORE the async spawn, so two admissions racing
   * through {@link spawnGuarded} cannot both pass the dedup/cap checks. The token makes a
   * retiring spawn's `finally` harmless: it releases only its OWN reservation, never one a
   * replacement established while it was reaping.
   */
  private launchSpawn(run: Run, stage: RunStage): void {
    const reservation = Symbol(`${run.id}:${stage}`);
    this.staffing.set(run.id, reservation);
    this.trace(run, `${stage}:staff`, "started", "staffing admitted");
    void this.doSpawn(run, stage, reservation)
      .catch(() => {
        /* doSpawn handles its own failures */
      })
      .finally(() => {
        if (this.staffing.get(run.id) === reservation) this.staffing.delete(run.id);
        this.pump();
      });
  }

  /** Admit queued spawns while slots are free (FIFO). */
  private pump(): void {
    while (this.pending.length > 0 && !this.atCap()) {
      const next = this.pending.shift()!;
      const run = this.store.get(next.runId);
      if (!run || RUN_TERMINAL.has(run.state) || this.isStaffed(run.id)) continue;
      this.launchSpawn(run, next.stage);
    }
  }

  // ── the spawn path ────────────────────────────────────────────────────────────────────

  /** Resolve the cast for a stage, applying the ultracode override and (implement) sonnet-first. */
  private async castFor(run: Run, stage: RunStage): Promise<HarnessSpec> {
    let explicit = run.cast?.[stage];
    // Ultracode is an IMPLEMENT-stage override and never overrides an explicit cast — a human
    // who named a harness for this stage meant it.
    if (stage === "implement" && run.ultracode && !explicit) {
      return { harness: "claude", model: "claude-opus-5", effort: "ultracode" };
    }
    // Sonnet-first (issue #249): the IMPLEMENT stage's default is the enforced `claude-sonnet-5`,
    // not whichever `harness.claude.default_model` an install names — and an opus cast with no
    // stated reason downgrades to sonnet rather than deploying silently. Review is untouched (it
    // keeps its own default-cast path below, unmodified) — the doctrine only gates the builder.
    if (stage === "implement") {
      const { spec, downgradeNote } = applySonnetFirst(explicit);
      if (downgradeNote) {
        this.trace(run, "implement:cast", "info", downgradeNote);
        // The run record is the audit surface (issue #249): a downgrade that leaves `run.cast`
        // reading the original opus request would make the ledger lie about what actually ran.
        // Patch it to the resolved (downgraded) spec so `runs.json` and the trace agree.
        await this.patchRun(run.id, { cast: { ...run.cast, implement: spec } });
      } else if (isOpusModel(spec.model) && spec.reason) {
        // A human-quoted opus cast (or one that already carried a reason) rode through
        // unchanged — trace it so an install can grep for casts nobody typed at the CLI default.
        this.trace(run, "implement:cast", "info", `opus implement kept — reason: ${spec.reason}`);
      }
      explicit = spec;
    }
    return this.stages.resolveCast(stage, explicit, runAsWorkItem(run), this.config);
  }

  /** The worker settings a v7 run adds on top of the rendered hooks. */
  private settingsExtraFor(run: Run, stage: RunStage): Record<string, unknown> {
    return {
      // Cross-session messaging: the concierge asks a live worker for status by name.
      crossSessionInbound: "accept",
      ...(stage === "implement" && run.ultracode ? { workflowSizeGuideline: "large" } : {}),
    };
  }

  /** Read the run's committed spec.md checklist, if it has one yet. */
  private readSpec(run: Run): ParsedSpecChecklist | undefined {
    if (!run.workspace) return undefined;
    const path = join(run.workspace, SPEC_FILE_REL);
    if (!existsSync(path)) return undefined;
    try {
      const text = readFileSync(path, "utf8");
      // A spec stamped with ANOTHER run's id must never feed this run's briefs: a worktree cut
      // from a base that carries a committed spec.md would otherwise hand a review stage the
      // previous run's acceptance criteria (which is exactly what happened on 2026-08-12).
      const owner = specRunId(text);
      if (owner !== undefined && owner !== run.id) return undefined;
      return parseSpecChecklist(text);
    } catch {
      return undefined;
    }
  }

  private async doSpawn(run: Run, stage: RunStage, reservation: symbol): Promise<void> {
    const stageStartedAt = Date.now();
    const repoRoot = this.resolveRepoRoot(run);
    const slug = runProjectSlug(run);

    // 1. The run's own project repo (clone-or-init). A provisioning failure parks rather than
    //    spawning a worker with nowhere to work.
    this.trace(run, "repo", "started", "provisioning/cloning project repository");
    try {
      await this.git.ensureProjectRepo(repoRoot, slug, this.projectOwner(slug));
      this.trace(run, "repo", "passed", "repository ready (cloned or initialized)");
    } catch (err) {
      this.trace(run, "repo", "failed", undefined, (err as Error).message);
      await this.noteSpawnFailure(run, `could not provision the project repo at \`${repoRoot}\`: ${(err as Error).message}`);
      return;
    }

    // 2. The run's own worktree on `run.branch`, cut from a freshly fetched origin/main the
    //    first time and reused by every later stage (so review sees the in-progress work).
    let workspace: string;
    try {
      workspace = await this.prepareWorktree(run, repoRoot);
    } catch (err) {
      this.trace(run, "worktree", "failed", undefined, (err as Error).message);
      await this.noteSpawnFailure(run, `could not allocate a worktree under \`${repoRoot}\`: ${(err as Error).message}`);
      return;
    }

    // 3. The spec scaffold — written BEFORE the worker exists, so its very first read of
    //    .beckett/spec.md finds the goal and the placeholder the Stop hook will hold it to.
    //    Lives under .beckett/ (SPEC_FILE_REL), never the worktree root: that dir is already
    //    info/exclude'd and stripped from the index by the pre-commit scaffolding guard, so the
    //    spec is structurally uncommittable — unlike the legacy root spec.md, which was tracked,
    //    committed, and pushed to trunk. A legacy root spec.md stamped for THIS run is migrated
    //    into place (a worker restarted after an older beckett wrote it there); one stamped for
    //    another run — or unstamped — is left alone, it is not provably ours to move.
    //    "Already exists" is NOT enough to skip the write: past runs committed their spec.md, so a
    //    fresh worktree can be born holding the PREVIOUS run's spec — the bare existsSync guard
    //    here is how two 2026-08-12 review stages got another run's acceptance criteria. Replace
    //    any spec stamped with a different run id; leave a file stamped with THIS run (or
    //    unstamped — possibly worker-authored, not provably foreign) alone.
    const specPath = join(workspace, SPEC_FILE_REL);
    try {
      mkdirSync(join(workspace, ".beckett"), { recursive: true });
      const legacyPath = join(workspace, "spec.md");
      if (!existsSync(specPath) && existsSync(legacyPath)) {
        const legacyText = readFileSync(legacyPath, "utf8");
        const legacyOwner = specRunId(legacyText);
        if (legacyOwner === run.id) {
          renameSync(legacyPath, specPath);
          this.logger.info("migrated the run spec into .beckett/", { run: run.id });
        }
      }
      const existing = existsSync(specPath) ? readFileSync(specPath, "utf8") : undefined;
      const owner = existing === undefined ? undefined : specRunId(existing);
      const foreign = existing === undefined || (owner !== undefined && owner !== run.id);
      if (foreign) {
        if (owner !== undefined) {
          this.logger.warn("worktree spec.md belonged to another run — rescaffolding", {
            run: run.id,
            foundRun: owner,
          });
        }
        writeFileSync(specPath, renderSpecScaffold(run), "utf8");
      }
    } catch (err) {
      this.logger.warn("spec.md scaffold write failed (worker still starts)", {
        run: run.id,
        error: (err as Error).message,
      });
    }

    // 4. The review diff base: HEAD-before-any-new-work, captured once per run.
    let baseSha = run.baseSha;
    if (stage === "implement" && !baseSha) {
      try {
        baseSha = (await this.git.headSha(workspace)) ?? null;
      } catch (err) {
        this.logger.warn("base-sha capture failed; review will diff HEAD", {
          run: run.id,
          error: (err as Error).message,
        });
      }
    }
    const baseRef = baseSha ?? "HEAD";
    const current =
      (await this.patchRun(run.id, {
        workspace,
        baseSha,
        state: stage === "implement" ? "implementing" : "reviewing",
      })) ?? { ...run, workspace, baseSha };

    // 5. Cast + preflight. A dead harness produces ONE clear substitution, never a wedged run.
    let spec = await this.castFor(current, stage);
    spec = await this.pickHealthyHarness(current, stage, spec);

    // Crash recovery: a restart-interrupted same-stage worker left a persisted session — resume
    // it rather than re-paying the whole run's exploration. Consumed here (one attempt).
    const hint = this.resumables.get(run.id);
    let resumeSessionId: string | undefined;
    if (hint && hint.stage === stage) {
      this.resumables.delete(run.id);
      resumeSessionId = hint.sessionId;
      if (hint.harness !== spec.harness) {
        // A model-less substitution would fall through to the harness config default (opus on
        // some installs), reopening the exact hole applySonnetFirst closed — stamp the default.
        spec = {
          harness: hint.harness,
          effort: spec.effort,
          ...(stage === "implement" ? { model: DEFAULT_IMPLEMENT_MODEL } : {}),
        };
      }
    }
    const interrupted = this.restartInterrupted.get(run.id);
    if (interrupted === stage && !resumeSessionId) {
      this.restartInterrupted.delete(run.id);
      await this.park(
        current,
        `a ${stage} worker was mid-run when the daemon restarted and no harness session survived to ` +
          "resume from — parked rather than silently restarting the in-flight work from scratch",
      );
      return;
    }

    // 6. Review economics: hand the reviewer the diff instead of making it rediscover it.
    let reviewDiff: string | undefined;
    if (stage === "review") {
      try {
        reviewDiff = await this.git.readDiff(workspace, baseRef);
      } catch (err) {
        this.logger.warn("review diff pre-read failed (reviewer will diff itself)", {
          run: run.id,
          error: (err as Error).message,
        });
      }
      // 6b. Review DEPTH (issue #234): that same pre-read diff is the only carrier of "what
      //     surface changed" at cast time — its `diff --git` headers ARE the changed-file list —
      //     so classify it here and journal the choice. The review prompt re-derives the identical
      //     classification from the identical diff (`dispatch/stages.ts`), keeping the supervisor
      //     pure: the link check the content tier orders is an instruction to the review worker,
      //     never a fetch from the daemon.
      const surface = classifyDiffSurface(reviewDiff);
      const depthLine = reviewDepthLine(surface);
      if (depthLine) {
        this.logger.info("review depth chosen", { run: run.id, depth: surface.depth, files: surface.files.length });
        this.trace(current, "review:depth", "info", depthLine);
      }
    }

    const steering = this.takeSteers(run.id);
    const item = runAsWorkItem(current, this.readSpec({ ...current, workspace }));
    const specGatePath = join(import.meta.dir, "../hooks/spec-gate.ts");

    let handle: WorkerHandle;
    try {
      handle = await spawnWorker({
        item,
        stage,
        harness: spec,
        config: this.config,
        repoRoot,
        workspace,
        branch: current.branch,
        baseRef,
        ...(resumeSessionId ? { resumeSessionId } : {}),
        steering,
        ...(reviewDiff ? { reviewDiff } : {}),
        stages: this.stages,
        sessionName: current.sessionName,
        settingsExtra: this.settingsExtraFor(current, stage),
        // The spec gate is an IMPLEMENT-stage contract: a reviewer authors no checklist and must
        // never be blocked by the implementer's.
        ...(stage === "implement" ? { extraHooks: [specGateSpec(specGatePath, workspace)] } : {}),
        onProgress: (ev: WorkerEvent, ctx: { stage: string; workerId: string }) => {
          this.progress?.event(current.id, ev, ctx);
          this.noteActivity(current.id, ev, ctx);
        },
        logger: this.logger,
      });
    } catch (err) {
      // The steering was CONSUMED above (taken and persisted-as-removed) for a worker that never
      // existed. Put it back before anything else: on a rework spawn those notes ARE the reviewer's
      // findings, and the watchdog's re-staff would otherwise re-run implement with no idea why.
      this.returnSteers(run.id, steering);
      this.trace(run, stage, "failed", "worker could not start", (err as Error).message);
      await this.noteSpawnFailure(current, `the ${stage} worker could not start: ${(err as Error).message}`);
      return;
    }
    this.restartInterrupted.delete(run.id);

    // A cancel/park that landed while we were provisioning has already dropped the reservation.
    // Do not register a worker for a run nobody wants any more.
    const fresh = this.store.get(run.id);
    if (this.staffing.get(run.id) !== reservation || !fresh || RUN_TERMINAL.has(fresh.state)) {
      this.logger.info("run no longer staffed mid-spawn — discarding worker", {
        run: run.id,
        stage,
        workerId: handle.id,
      });
      // Same contract as the spawn-failure path: a discarded worker never read these notes, so a
      // still-live run must get them back. A terminal run keeps none (nothing will ever read them).
      if (fresh && !RUN_TERMINAL.has(fresh.state)) this.returnSteers(run.id, steering);
      await handle.abort("run no longer active");
      await handle.reap();
      return;
    }

    this.workers.set(run.id, handle);
    // `sessionIds` is a Run-contract field only this lane writes: the crash-resume ledger is
    // in-process state cleared on recovery, so without this a sibling reader sees `{}` forever.
    if (handle.sessionId) {
      await this.patchRun(run.id, { sessionIds: { ...fresh.sessionIds, [stage]: handle.sessionId } });
    }
    this.liveLedger.set(run.id, {
      stage,
      workerId: handle.id,
      sessionId: handle.sessionId ?? "",
      pid: handle.pid ?? 0,
      workspace,
      harness: spec.harness,
      spawnedAt: Date.now(),
    });
    this.persistRuntimeState();
    const spendMeta: SpendStageMeta = {
      harness: spec.harness,
      model: spec.model || this.defaultModelFor(spec),
      effort: spec.effort ?? defaultEffortFor(spec.harness, this.config),
      startedAt: stageStartedAt,
    };
    this.spendMetaByWorker.set(handle.id, spendMeta);
    handle.onDone((status, summary) => {
      void this.onWorkerDone(run.id, stage, handle, status, summary, spendMeta);
    });
    this.trace(current, stage, "started", `worker ${handle.id} on ${spec.harness}`);
    this.logger.info("worker spawned for run", { run: run.id, stage, workerId: handle.id, harness: spec.harness });
  }

  /** Allocate (or reuse) the run's worktree on its own branch. */
  private async prepareWorktree(run: Run, repoRoot: string): Promise<string> {
    const firstTouch = !run.workspace;
    const workspace = run.workspace ?? join(repoRoot, ".beckett", "worktrees", run.id);
    this.trace(run, "worktree", "started", firstTouch ? "creating isolated worktree" : "reusing isolated worktree");
    if (firstTouch) await this.git.fetchRemote(repoRoot);
    await this.git.createWorktree({
      repoRoot,
      workspace,
      branch: run.branch,
      baseRef: "origin/main",
      reuseIfExists: true,
    });
    this.trace(run, "worktree", "passed", workspace);
    return workspace;
  }

  /**
   * Substitute a healthy harness when the cast one cannot start (issue #17's posture, minus the
   * dispatcher's ticket comments). No preflight wired → the cast is used as-is.
   */
  private async pickHealthyHarness(run: Run, stage: RunStage, spec: HarnessSpec): Promise<HarnessSpec> {
    if (!this.preflight) return spec;
    try {
      const verdict = await this.preflight(spec.harness as Harness);
      if (verdict.ok) return spec;
      if (spec.harness === "claude") return spec; // nothing healthier to fall back to
      this.logger.warn("cast harness failed preflight — substituting claude", {
        run: run.id,
        stage,
        harness: spec.harness,
        problems: verdict.problems,
      });
      this.trace(run, `${stage}:cast`, "info", `${spec.harness} failed preflight — substituting claude`);
      // Sonnet-first (issue #249): this substitution runs AFTER `castFor`'s sonnet-first pass, so
      // a model-less claude fallback here would re-open the exact fallthrough that pass exists to
      // close — `config.harness.claude.default_model` at the driver, un-reasoned and un-logged.
      // Stamp the same enforced default on the implement stage; review keeps its own default path.
      return {
        harness: "claude",
        ...(stage === "implement" ? { model: DEFAULT_IMPLEMENT_MODEL } : {}),
        ...(spec.effort ? { effort: spec.effort } : {}),
      };
    } catch {
      return spec; // a probe fault must never block dispatch
    }
  }

  // ── finish handling ───────────────────────────────────────────────────────────────────

  private async onWorkerDone(
    runId: string,
    stage: RunStage,
    handle: WorkerHandle,
    status: "success" | "error",
    summary: string,
    spendMeta: SpendStageMeta,
  ): Promise<void> {
    const run = this.store.get(runId);
    if (!run) return;
    // A run that is already finished-or-killed must not be advanced by a late worker callback.
    // {@link cancel} drops the handle, bills the partial spend, and patches `cancelled` BEFORE it
    // aborts — an abort the driver may answer with its ordinary terminal event, which lands here.
    // Without this guard a cancelled run would still commit, advance to review, spawn a reviewer,
    // publish, and open a PR: precisely the work the owner just stopped. Deliberately narrower
    // than `RUN_TERMINAL`: `parked` is set BY this path, and re-entering a park is not a race.
    if (run.state === "cancelled" || run.state === "done" || run.state === "failed") {
      this.logger.info("ignoring a worker finish on a terminal run", { run: runId, stage, state: run.state });
      this.spendMetaByWorker.delete(handle.id);
      return;
    }
    // A worker the daemon killed on its way down did not FAIL — `interrupted` is the timeline's
    // existing word for exactly that (`../dispatch/events.ts`), and both the digest and the
    // progress card already know not to dress it as a failure. Nothing emitted it in v7 until now.
    const died = status !== "success";
    this.trace(
      run,
      stage,
      !died ? "passed" : this.shuttingDown ? "interrupted" : "failed",
      !died
        ? "worker finished"
        : this.shuttingDown
          ? "worker exited with error (stopped by a daemon restart)"
          : "worker exited with error",
      // The CAUSE, never the summary: on a death `summary` is `spawn.ts`'s fallback scrape of the
      // session's last assistant text, which is what put a reviewer's greeting on the timeline.
      died ? this.workerDeathCause(handle) : undefined,
    );
    this.recordSpend(run, stage, handle, status, spendMeta);
    this.spendMetaByWorker.delete(handle.id);
    // Mark the run mid-finish BEFORE freeing its slot: the commit/publish below can outlive a
    // watchdog grace window, and for its whole duration the run is workerless.
    this.finishing.add(runId);
    if (this.workers.get(runId) === handle) this.workers.delete(runId);
    if (this.liveLedger.delete(runId)) this.persistRuntimeState();
    // The blurb described THIS worker's tool calls; the next stage starts from a clean slate.
    this.forgetActivity(runId);

    // Steering the driver buffered but never applied — carry it into the next stage's brief.
    for (const note of handle.result?.unappliedNudges ?? []) this.bufferSteer(runId, note);

    try {
      if (stage === "implement") await this.finishImplement(run, handle, status, summary);
      else await this.finishReview(run, handle, status, summary);
    } catch (err) {
      this.logger.error("post-finish handling failed", { run: runId, stage, error: (err as Error).message });
    } finally {
      this.finishing.delete(runId);
      await handle.reap();
      this.pump();
    }
  }

  private async finishImplement(
    run: Run,
    handle: WorkerHandle,
    status: "success" | "error",
    summary: string,
  ): Promise<void> {
    if (status !== "success") {
      await this.commitWip(run, handle);
      this.noteOwedResume(run, "implement", handle);
      await this.park(run, this.workerDeathReason("implement", handle));
      return;
    }
    const signal = parseDoneSignal(handle.result?.structured);
    if (signal && (signal.status === "blocked" || signal.status === "partial")) {
      await this.commitWip(run, handle);
      await this.park(run, `the implement worker reported **${signal.status}**.\n\n${summary}`);
      return;
    }
    // Safety net: capture anything the worker left uncommitted so review sees the whole change.
    await this.commitContribution(run, handle);
    // The review GATE (`../run/cast.ts#HarnessSpec.reviewTier`), ported from the dispatcher: a
    // `self` run is one pass by design — the implement worker self-verified inline, so it goes
    // straight to publish and never pays a second adversarial seat.
    if (this.reviewTierFor(run) === "self") {
      this.trace(run, "implement:verdict", "passed", "implementation complete → publish (self review tier)");
      await this.publishRun(run, summary);
      return;
    }
    await this.patchRun(run.id, { state: "reviewing" });
    this.trace(run, "implement:verdict", "passed", "implementation complete → review");
    const next = this.store.get(run.id);
    if (next) this.spawnGuarded(next, "review");
  }

  /**
   * The review gate for a run. An explicit `reviewTier` on the implement cast wins; otherwise it
   * derives from the CAST effort: low/medium → `self` (one pass, the worker self-verifies inline),
   * everything else (high/xhigh/ultracode, or no cast at all) → `fresh` (a separate adversarial
   * reviewer). Deliberately reads the run's OWN cast rather than the resolved worker spec, so an
   * un-cast run keeps the safe default of a full fresh review — the dispatcher's rule verbatim.
   */
  private reviewTierFor(run: Run): "self" | "fresh" {
    const impl = run.cast?.implement;
    if (impl?.reviewTier) return impl.reviewTier;
    return impl?.effort === "low" || impl?.effort === "medium" ? "self" : "fresh";
  }

  private async finishReview(
    run: Run,
    handle: WorkerHandle,
    status: "success" | "error",
    summary: string,
  ): Promise<void> {
    // A reviewer that DIED never delivered a verdict, and its words are not a verdict either —
    // separate that from a reviewer that ran to completion and merely produced unparseable output
    // (#247: those two used to share a branch, and the dead one quoted the session's text).
    if (status !== "success") {
      this.noteOwedResume(run, "review", handle);
      await this.park(run, this.workerDeathReason("review", handle));
      return;
    }
    const signal = parseDoneSignal(handle.result?.structured);
    if (!signal) {
      await this.park(run, `the reviewer finished without a schema-valid structured verdict.\n\n${summary}`);
      return;
    }
    if (signal.status === "complete") {
      this.trace(run, "review:verdict", "passed", "review passed");
      await this.publishRun(run, summary);
      return;
    }

    const cycles = run.reviewCycles + 1;
    const cap = this.config.runs?.review_cycles_max ?? 2;
    await this.patchRun(run.id, { reviewCycles: cycles });
    this.trace(run, "review:verdict", "bounced", `review requested rework (cycle ${cycles}/${cap})`);
    if (cycles >= cap) {
      const parked = this.store.get(run.id) ?? run;
      await this.park(
        parked,
        `review found issues, and this is rework cycle ${cycles}/${cap} — stopping automatic rework ` +
          `and leaving it for a human.\n\n${summary}`,
      );
      return;
    }
    // Rework: the reviewer's notes become the next implement worker's steering, so its first
    // model turn provably carries the reasons it is running again.
    this.bufferSteer(run.id, `Review found issues (cycle ${cycles}/${cap}):\n${summary}`);
    await this.patchRun(run.id, { state: "implementing" });
    const next = this.store.get(run.id);
    if (next) this.spawnGuarded(next, "implement");
  }

  // ── publishing ────────────────────────────────────────────────────────────────────────

  /**
   * GitHub owner for a slug — the dispatcher's resolver verbatim, so the self-project's per-repo
   * override (`beckett` lives under `kowo-co`, #114) applies to runs too. Getting this wrong on a
   * `repo: null` run would clone nothing and `git init` an empty checkout, which is exactly the
   * failure {@link runProjectSlug} exists to prevent.
   */
  private projectOwner(slug: string): string {
    return resolveProjectOwner(slug, this.config);
  }

  /**
   * Publish, THEN mark done — publish success gates the `done` state, which is the OPS-30
   * false-done fix carried into v7. A failure appends a durable outbox row that owns the
   * worktree until it publishes or a human takes it.
   */
  private async publishRun(run: Run, summary: string): Promise<void> {
    await this.patchRun(run.id, { state: "publishing" });
    const publishing = this.store.get(run.id) ?? run;
    this.trace(publishing, "publish", "started", "git push/publish starting");
    const outcome = await this.publishOnce(publishing, summary);
    if (outcome.status === "failed") {
      if (this.publishOutbox) {
        // Attempt 1 is decided by the SAME ladder every later retry uses (planPublishRetry) — a
        // permanent classification or an exhausted ladder park identically on attempt 1 as on
        // attempt 4 (#227: no more special-cased "first attempt" logic).
        const plan = planPublishRetry(1, outcome.error);
        const op: PublishOperation = {
          id: randomUUID(),
          item: runAsWorkItem(publishing),
          slug: runProjectSlug(publishing),
          repoRoot: publishing.workspace ?? this.resolveRepoRoot(publishing),
          messagePrefix: "Review passed → **done**.",
          summary,
          purpose: "done",
          attempt: 1,
          nextAttemptAt: plan.nextAttemptAt,
          createdAt: new Date().toISOString(),
        };
        this.publishOutbox.append(op, plan);
        this.trace(publishing, "publish", "held", plan.message, plan.error);
        await this.recordPublishFailure(publishing, plan, 1);
        return;
      }
      // No durable outbox wired (a bare/embedded supervisor): there is no retry ladder to hand it
      // to, so park immediately — with the same actionable text a laddered failure gets, including
      // the branch-aware hand-off advice (BUG 2).
      const hint = publishFixHint(outcome.error);
      const advice = await this.publishHandoffAdvice(publishing);
      await this.park(
        publishing,
        `the work is complete but could not be published: ${outcome.error.trim().replace(/[.\s]+$/, "")}` +
          `${hint ? ` — ${hint}` : "."} ${advice}`,
      );
      return;
    }
    this.publishStallClock.delete(run.id);
    const prUrl = outcome.status === "published" ? outcome.prUrl ?? outcome.url ?? null : null;
    await this.patchRun(run.id, {
      state: "done",
      prUrl,
      error: null,
      published: { via: "outbox", prUrl },
    });
    // The deploy receipt's closing line: the shipped PR/push URL when there is one, the review
    // summary otherwise (a local-only completion with no publishRepo wired).
    const shipped = outcome.status === "published" ? outcome.prUrl ?? outcome.url : "";
    this.trace(publishing, "done", "passed", shipped || summary);
    this.logger.info("run done", { run: run.id });
  }

  /**
   * Write a failed publish attempt onto the RUN, where an operator (and `beckett status`) actually
   * looks. Before this, a run whose publish failed sat in `publishing` with `error: null` — the
   * durable row carried the reason and nothing surfaced it, so a wedged run was indistinguishable
   * from one still working (2026-08-14, `babble`: 30+ minutes of `publishing`, `error: null`, and
   * no channel message at all).
   *
   * A plan that PARKS moves the run to `parked` as well: the row it leaves behind is scheduled at
   * `Number.MAX_SAFE_INTEGER` and will never run again, so leaving the run `publishing` was a state
   * that claimed work was in progress when nothing was. `parked` is the held-for-a-human state the
   * rest of the supervisor already understands — it still shows on the board, `beckett task courier`
   * still accepts it, and {@link park} emits the `held` event that reaches the run's channel.
   */
  private async recordPublishFailure(run: Run, plan: PublishRetryPlan, attempt: number): Promise<void> {
    if (plan.action === "park") {
      // Only when the run is actually giving up do we pay for the branch-vs-main comparison — and it
      // is what makes the hand-off advice correct instead of the blanket "just push it" that would
      // have duplicated or reverted shipped work on every 2026-08-14 stall (BUG 2).
      const advice = await this.publishHandoffAdvice(run);
      await this.park(run, publishFailureReason(plan, attempt, advice));
      return;
    }
    await this.patchRun(run.id, { error: publishFailureReason(plan, attempt) });
  }

  /**
   * The copy-pasteable instruction a parking publish leaves for a human, computed from the run's
   * branch measured against `origin/main` (BUG 2): (a) genuinely-ahead ⇒ push it, (b) already-landed
   * ⇒ courier closed against the PR that carried it, (c) behind ⇒ courier closed, do not revert. A
   * comparison failure falls back to the generic push advice — never blocks the park.
   */
  private async publishHandoffAdvice(run: Run): Promise<string> {
    const workspace = run.workspace ?? this.resolveRepoRoot(run);
    let state = classifyBranchLanding({ compared: false, ahead: 0, behind: 0, aheadUnlanded: 0 });
    try {
      state = classifyBranchLanding(await this.git.readBranchVsMain(workspace));
    } catch (err) {
      this.logger.warn("branch-vs-main check threw — using generic publish hand-off advice", {
        run: run.id,
        error: (err as Error).message,
      });
    }
    if (state.kind !== "ahead" && state.kind !== "unknown") {
      this.logger.info("publish hand-off: branch already reconciled with main", {
        run: run.id,
        branch: run.branch,
        state: state.kind,
      });
    }
    return publishParkAdvice(state, { runId: run.id, branch: run.branch });
  }

  /** One publish attempt; never throws. */
  private async publishOnce(run: Run, summary: string): Promise<PublishOutcome> {
    if (!this.publishRepo) {
      this.trace(run, "publish", "passed", "publishing unavailable; local-only completion");
      return { status: "skipped" };
    }
    // Restart the stall clock: an attempt that is actually running is progress, and one that never
    // returns is measured from HERE rather than from whenever the run entered `publishing`.
    this.publishStallClock.set(run.id, Date.now());
    try {
      // #246: the squashed publish commit is the ONLY place the review summary/mechanism writeup can
      // land once a direct push carries no PR body — so its message must carry both the run's title
      // (the subject a `git log`/commit-URL reader sees first) and the review summary (the body). No
      // invented commitMessage when there's no summary (e.g. a crash-recovery re-attempt whose
      // reviewer summary didn't survive) — `description: run.title` already covers the squash
      // fallback title downstream (`GitHubCli.ensurePublished`'s `p.commitMessage ?? title`).
      const result = await this.publishRepo({
        slug: runProjectSlug(run),
        repoRoot: run.workspace ?? this.resolveRepoRoot(run),
        description: run.title,
        ticket: run.id,
        ...(run.baseSha ? { baseSha: run.baseSha } : {}),
        ...(summary.trim() ? { commitMessage: `${run.title}\n\n${summary.trim()}` } : {}),
      });
      return await this.recordPublication(run, result);
    } catch (err) {
      this.trace(run, "publish", "failed", "push/publish failed", (err as Error).message);
      return { status: "failed", error: (err as Error).message };
    }
  }

  private async recordPublication(
    run: Run,
    publication: { url: string; kind: "pushed" | "pr"; prUrl?: string },
  ): Promise<PublishOutcome> {
    this.trace(run, publication.kind === "pr" ? "pr" : "git-push", "passed", publication.prUrl ?? publication.url);
    if (this.onPublished) {
      try {
        await this.onPublished({ ...publication, run });
      } catch (err) {
        this.logger.warn("onPublished hook failed (publish still succeeded)", { run: run.id, error: String(err) });
      }
    }
    // Only PRs are watchable. The poller is keyed by the RUN id, so its relays land on the run.
    if (publication.kind === "pr" && publication.prUrl && this.onPrOpened) {
      try {
        await this.onPrOpened({ prUrl: publication.prUrl, run });
      } catch (err) {
        this.logger.warn("onPrOpened hook failed (publish still succeeded)", { run: run.id, error: String(err) });
      }
    }
    return { status: "published", ...publication };
  }

  /** Drain due publish retry rows. Idempotent — `publishRepo` is safe to re-run. */
  async replayPublishes(): Promise<number> {
    if (!this.publishOutbox) return 0;
    return this.publishOutbox.drain(async (op) => {
      const run = this.store.get(op.item.id);
      if (!run || RUN_TERMINAL.has(run.state)) return { action: "remove" };
      const pub = await this.publishOnce(run, op.summary);
      if (pub.status === "failed") {
        const attempt = op.attempt + 1;
        const plan = planPublishRetry(attempt, pub.error);
        // Every retry logs VERBATIM, same as attempt 1 (#227 — this path previously logged
        // nothing at all on a failed retry; only a crash inside `apply` itself ever reached a log
        // line, and that line carried no error either).
        this.logger.warn(plan.message, {
          id: op.id, item: op.item.identifier, attempt, nextAttemptAt: plan.nextAttemptAt,
          reason: plan.reason, error: plan.error,
        });
        this.trace(run, "publish-retry", "held", plan.message, plan.error);
        await this.recordPublishFailure(run, plan, attempt);
        return {
          action: "keep",
          operation: { ...op, attempt, nextAttemptAt: plan.nextAttemptAt },
        };
      }
      this.publishStallClock.delete(run.id);
      const prUrl = pub.status === "published" ? pub.prUrl ?? pub.url ?? null : null;
      await this.patchRun(run.id, {
        state: "done",
        prUrl,
        error: null,
        published: { via: "outbox", prUrl },
      });
      const shipped = pub.status === "published" ? pub.prUrl ?? pub.url : "";
      this.trace(run, "done", "passed", shipped || "durable publish retry succeeded");
      return { action: "remove" };
    });
  }

  /**
   * The publishing-stall guard: no run may sit in `publishing` indefinitely with nothing scheduled
   * to move it. Three shapes reach here, and all three used to be permanent silent wedges because
   * `stageFor()` returns null for `publishing` (so the staffing watchdog skips it):
   *
   *   1. a durable row whose ladder is exhausted (`nextAttemptAt: MAX_SAFE_INTEGER`) — it holds the
   *      run and will never run again. New failures park at that moment
   *      ({@link recordPublishFailure}); this catches rows written by older code;
   *   2. an attempt that never returned — a `git push`/`gh` call hung, so no failure was ever
   *      classified and no row was ever written;
   *   3. a run whose row was removed out from under it without a terminal state.
   *
   * A row with a REAL `nextAttemptAt` is exempt: the ladder owns it, and the whole point of the
   * durable outbox is that a scheduled retry is progress. Everything else is parked with a specific
   * `error` naming the step, the elapsed time, and how to finish it by hand.
   */
  async reconcilePublishing(nowMs: number = Date.now()): Promise<string[]> {
    const parked: string[] = [];
    for (const run of this.store.live()) {
      if (run.state !== "publishing") continue;
      const row = this.publishOutbox?.get(run.id);
      if (row && row.nextAttemptAt < Number.MAX_SAFE_INTEGER) {
        this.publishStallClock.delete(run.id);
        continue; // a real retry is scheduled — that IS progress
      }
      let since = this.publishStallClock.get(run.id);
      if (since === undefined) {
        const entered = Date.parse(run.updatedAt);
        since = Number.isFinite(entered) ? entered : nowMs;
        this.publishStallClock.set(run.id, since);
      }
      const stalledMs = nowMs - since;
      if (stalledMs < PUBLISH_STALL_MS) continue;
      this.publishStallClock.delete(run.id);
      const minutes = Math.max(1, Math.round(stalledMs / 60_000));
      const last = run.error
        ? `Last recorded publish error: ${run.error}`
        : row
          ? `The durable publish row gave up after attempt ${row.attempt} and was never going to retry`
          : "No publish error was ever recorded, so the attempt never returned at all";
      const advice = await this.publishHandoffAdvice(run);
      await this.park(
        run,
        `the publish step never completed: this run sat in \`publishing\` for ${minutes} minute(s) with no ` +
          `attempt scheduled to move it. ${last}. ${advice}`,
      );
      parked.push(run.id);
    }
    return parked;
  }

  /**
   * Boot repair for the one window the outbox cannot cover: the daemon died BETWEEN
   * `state = "publishing"` and the failed attempt that would have written the durable row. Such a
   * run has no outbox row, staffs nothing ({@link stageFor} returns null for `publishing`), and is
   * skipped by the watchdog — a silent permanent wedge. Re-attempting is safe: `publishRepo` is
   * idempotent by contract (a re-push of the same branch returns the same PR), and a second failure
   * lands the run in the outbox where the normal drain owns it.
   */
  async resumeInterruptedPublishes(): Promise<number> {
    let resumed = 0;
    for (const run of this.store.live()) {
      if (run.state !== "publishing") continue;
      if (this.publishOutbox?.has(run.id)) continue; // the row already owns it
      resumed++;
      this.logger.warn("run was mid-publish when the daemon stopped — re-attempting", { run: run.id });
      this.trace(run, "publish", "info", "daemon restarted mid-publish — re-attempting (idempotent)");
      // No summary: the reviewer's words did not survive the restart, and inventing a commit
      // message here would put fiction in the history. The publish path handles the empty case.
      await this.publishRun(run, "");
    }
    return resumed;
  }

  // ── steering ──────────────────────────────────────────────────────────────────────────

  /**
   * Deliver a note to a run. A live worker gets it as a nudge; otherwise it is buffered in the
   * runtime state so the NEXT stage's brief carries it (the words provably reach a model turn).
   */
  async steer(runId: string, note: string): Promise<"delivered" | "buffered"> {
    const handle = this.workers.get(runId);
    if (handle) {
      try {
        const accepted = await handle.nudge(note);
        if (accepted !== "dropped") return "delivered";
      } catch (err) {
        this.logger.warn("nudge failed — buffering steer", { run: runId, error: String(err) });
      }
    }
    this.bufferSteer(runId, note);
    return "buffered";
  }

  // ── cancellation ──────────────────────────────────────────────────────────────────────

  /**
   * STOP a run. The lever behind the task card's Cancel button (`concierge.cancelFromComponent`)
   * and `beckett task cancel`; ported from the dispatcher's `onCancelled`, which was the only thing
   * that could ever stop a live worker.
   *
   * Order matters and is the dispatcher's verbatim:
   *   1. drop the mid-spawn reservation FIRST, so a `doSpawn` racing us discards its own worker at
   *      its post-spawn reservation check instead of registering one nobody wants;
   *   2. cancel the durable publish row (a queued retry must not resurrect unwanted work) and the
   *      queued spawn, and drop buffered steering — cancelled work does not get corrected;
   *   3. abort + reap the live worker, billing its partial spend as `cancelled`;
   *   4. only then patch the state, so the `cancelled` event the concierge sees is emitted with
   *      nothing still running behind it.
   *
   * Returns what actually happened so a caller can say so honestly. `parked` runs ARE cancellable
   * (a park is held-for-a-human, not finished); `done`/`failed`/`cancelled` are not.
   */
  async cancel(runId: string, reason = "cancelled"): Promise<"cancelled" | "unknown" | "already-terminal"> {
    const run = this.store.get(runId);
    if (!run) {
      this.logger.warn("run.cancel for an unknown run", { runId });
      return "unknown";
    }
    if (run.state === "done" || run.state === "failed" || run.state === "cancelled") return "already-terminal";

    this.trace(run, "cancel", "cancelled", reason);
    this.staffing.delete(runId); // mid-spawn reservation → doSpawn discards its worker
    this.publishOutbox?.cancel(runId);
    this.dropPending(runId);
    this.unstaffedSince.delete(runId);
    this.publishStallClock.delete(runId);
    this.watchdogRestaffed.delete(runId);
    this.budgetBlocked.delete(runId);
    this.restartInterrupted.delete(runId);
    this.resumables.delete(runId);
    // Cancelled = the work is not wanted; held steering dies with it (the dispatcher's issue #22
    // posture, kept verbatim).
    let persist = this.pendingSteers.delete(runId);
    persist = this.liveLedger.delete(runId) || persist;
    if (persist) this.persistRuntimeState();
    this.forgetActivity(runId);

    const handle = this.workers.get(runId);
    if (handle) {
      this.workers.delete(runId);
      const meta = this.spendMetaByWorker.get(handle.id);
      this.spendMetaByWorker.delete(handle.id);
      if (meta) this.recordSpend(run, handle.stage as RunStage, handle, "error", meta, "cancelled");
      this.logger.warn("run cancelled — aborting worker", { run: runId, workerId: handle.id });
      try {
        await handle.abort(reason);
      } catch (err) {
        this.logger.warn("worker abort failed during cancel", { run: runId, error: String(err) });
      }
      try {
        await handle.reap();
      } catch (err) {
        this.logger.warn("worker reap failed during cancel", { run: runId, error: String(err) });
      }
    }
    // Re-read RIGHT before the terminal write: the entry check above ran on a stale snapshot, and
    // the awaits in between are wide enough for an in-flight publish to finish. A run that reached
    // its own real terminal while we were reaping keeps that outcome — a late cancel must never
    // rewrite a shipped run to "cancelled" (the runs.json half of #228: the spatial-3d run
    // deployed, passed review 14/14, and was still recorded cancelled).
    const fresh = this.store.get(runId);
    if (fresh && (fresh.state === "done" || fresh.state === "failed")) {
      this.logger.warn("cancel arrived after the run reached its own terminal — keeping it", {
        run: runId,
        state: fresh.state,
      });
      this.pump();
      return "already-terminal";
    }
    await this.patchRun(runId, { state: "cancelled", error: reason });
    this.pump();
    return "cancelled";
  }

  /**
   * A human took publishing over by hand (git push / PR opened themselves) after the durable
   * outbox row for this run stopped being the thing driving it. Its OWN terminal shape — never
   * {@link cancel}'s bookkeeping (#228: reusing `cancel()` here is exactly why a run that shipped
   * — 14/14 done, review PASS, landed on main as a real PR — used to end
   * `state: "cancelled", error: "cancelled", prUrl: null`, throwing its own outcome away).
   *
   * Ends the run `done` with `published: {via: "courier", prUrl: null}` and NO error — the daemon
   * never drove this publish, so there is no PR URL to record synchronously; a human/future caller
   * backfills it with `RunStore.backfillCourierPrUrl` once one is known. `error` stays `null`
   * because nothing failed: this is a successful publish, just not one the outbox did itself.
   *
   * Eligible only from `publishing` (the outbox still nominally owns it) or `parked` (it already
   * gave up and asked for a human) — a run still mid-implement/review has nothing for a courier to
   * have published, so `beckett task courier` on one of those is a caller mistake, not a state
   * transition.
   */
  async courier(runId: string): Promise<"done" | "unknown" | "already-terminal" | "not-eligible"> {
    const run = this.store.get(runId);
    if (!run) {
      this.logger.warn("run.courier for an unknown run", { runId });
      return "unknown";
    }
    if (run.state === "done" || run.state === "failed" || run.state === "cancelled") return "already-terminal";
    if (run.state !== "publishing" && run.state !== "parked") return "not-eligible";

    // The row's exclusive publish ownership ends here — a human owns it now, and a stale retry
    // must never race their hand-push. Reuses the exact bookkeeping `cancel()` already relies on
    // for the identical reason (`PublishOutbox.cancel`'s own doc comment: "never race them with a
    // stale retry").
    this.publishOutbox?.cancel(runId);
    this.staffing.delete(runId);
    this.dropPending(runId);
    this.unstaffedSince.delete(runId);
    this.publishStallClock.delete(runId);
    this.watchdogRestaffed.delete(runId);
    this.budgetBlocked.delete(runId);
    this.restartInterrupted.delete(runId);
    this.resumables.delete(runId);
    let persist = this.pendingSteers.delete(runId);
    persist = this.liveLedger.delete(runId) || persist;
    if (persist) this.persistRuntimeState();
    this.forgetActivity(runId);

    const updated = await this.patchRun(runId, {
      state: "done",
      error: null,
      published: { via: "courier", prUrl: null },
    });
    this.trace(updated ?? run, "done:courier", "passed", "shipped by human courier");
    this.logger.info("run handed to a human courier — marked done, not cancelled", { run: runId });
    this.pump();
    return "done";
  }

  /**
   * The backfill half of {@link courier}: a courier-handed-off run ships `prUrl: null` because the
   * daemon never drove that publish, and there is deliberately no PR-watching machinery to learn
   * one on its own (#228). This is the plain, explicit seam for a human/future caller who DOES know
   * the URL to record it — `RunStore.backfillCourierPrUrl` does the actual (idempotent, narrowly
   * scoped) write; re-tracing here just lets a still-open progress card pick the URL up.
   */
  async backfillCourierPrUrl(runId: string, prUrl: string): Promise<Run | null> {
    const run = await this.store.backfillCourierPrUrl(runId, prUrl);
    if (run.published?.via === "courier" && run.published.prUrl === prUrl) {
      this.trace(run, "done:courier", "passed", prUrl);
    }
    return run;
  }

  /** Drop a run's queued (over-cap) spawn, if it has one. */
  private dropPending(runId: string): void {
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      if (this.pending[i]!.runId === runId) this.pending.splice(i, 1);
    }
  }

  private bufferSteer(runId: string, note: string): void {
    const list = this.pendingSteers.get(runId) ?? [];
    list.push(note);
    this.pendingSteers.set(runId, list);
    this.persistRuntimeState();
  }

  /**
   * Give back steering that was consumed for a brief no model ever read. Notes go BACK IN FRONT of
   * anything buffered since, so the run's next worker sees them in the order they were written.
   */
  private returnSteers(runId: string, notes: string[]): void {
    if (notes.length === 0) return;
    this.pendingSteers.set(runId, [...notes, ...(this.pendingSteers.get(runId) ?? [])]);
    this.persistRuntimeState();
  }

  private takeSteers(runId: string): string[] {
    const list = this.pendingSteers.get(runId) ?? [];
    if (list.length === 0) return [];
    this.pendingSteers.delete(runId);
    this.persistRuntimeState();
    return list;
  }

  // ── watchdog + checkpointing ──────────────────────────────────────────────────────────

  startStaffingWatchdog(): void {
    if (this.watchdogTimer) return;
    const graceS = this.config.supervise?.staffing_watchdog_s ?? DEFAULT_WATCHDOG_GRACE_S;
    if (!graceS || graceS <= 0) return;
    const intervalMs = Math.max(WATCHDOG_MIN_INTERVAL_MS, Math.round((graceS * 1000) / 2));
    this.watchdogTimer = setInterval(() => {
      void this.reconcileStaffing().catch((err) =>
        this.logger.warn("run staffing reconciliation failed", { error: (err as Error).message }),
      );
    }, intervalMs);
    this.watchdogTimer.unref?.();
  }

  /**
   * The publish outbox's own heartbeat. {@link reconcileStaffing} already drains on every watchdog
   * tick, but that tick is configurable to nothing (`[supervise] staffing_watchdog_s = 0`) and a
   * durable retry schedule that an unrelated knob can switch off is not durable. Both callers are
   * safe together: `PublishOutbox.drain` is single-flight in-process, so an overlapping tick is a
   * no-op rather than a double publish.
   */
  startPublishDrainLoop(): void {
    if (this.publishDrainTimer || !this.publishOutbox) return;
    this.publishDrainTimer = setInterval(() => {
      void this.replayPublishes().catch((err) =>
        this.logger.warn("publish outbox drain failed", { error: (err as Error).message }),
      );
    }, PUBLISH_DRAIN_INTERVAL_MS);
    this.publishDrainTimer.unref?.();
  }

  startCheckpointLoop(): void {
    if (this.checkpointTimer) return;
    const seconds = this.config.supervise?.worker_checkpoint_s ?? 0;
    if (!seconds || seconds <= 0) return;
    this.checkpointTimer = setInterval(() => {
      void this.checkpointLiveRuns().catch((err) =>
        this.logger.warn("run checkpoint pass failed", { error: (err as Error).message }),
      );
    }, seconds * 1000);
    this.checkpointTimer.unref?.();
  }

  /**
   * One staffing reconciliation pass. Every live run that is NOT being handled — no worker, no
   * mid-spawn reservation, not queued, not finishing, no publish row — has its workerless clock
   * ticked. Past the grace it is re-staffed ONCE; if it is still workerless a grace later it is
   * parked with a message. This is the catch-all that guarantees a wedged run never sits silent.
   */
  async reconcileStaffing(nowMs: number = Date.now()): Promise<{ restaffed: string[]; parked: string[] }> {
    if (this.watchdogInFlight) return { restaffed: [], parked: [] };
    this.watchdogInFlight = true;
    const restaffed: string[] = [];
    const parked: string[] = [];
    try {
      // Drain the durable publish outbox FIRST. The ticket dispatcher got this for free — it drained
      // on every poll tick — but the run engine has no poller, so without this the 1m/5m/30m retry
      // schedule would only ever run at daemon boot and a transiently-failed publish would sit in
      // `publishing` (skipped below via `publishOutbox.has`) until the next restart. An outbox fault
      // must never block staffing recovery, hence the local catch.
      try {
        await this.replayPublishes();
      } catch (err) {
        this.logger.warn("publish outbox drain failed (staffing pass continues)", { error: String(err) });
      }
      // …then end any `publishing` run nothing is going to move. The loop below CANNOT do it:
      // `stageFor()` returns null for `publishing`, so a run wedged there is invisible to the
      // staffing watchdog by design — which is exactly how one sat there silently for half an hour.
      try {
        parked.push(...(await this.reconcilePublishing(nowMs)));
      } catch (err) {
        this.logger.warn("publishing-stall guard failed (staffing pass continues)", { error: String(err) });
      }
      const graceMs = (this.config.supervise?.staffing_watchdog_s ?? DEFAULT_WATCHDOG_GRACE_S) * 1000;
      const wedged = new Set<string>();
      for (const run of this.store.live()) {
        const stage = this.stageFor(run);
        if (
          !stage ||
          this.isStaffed(run.id) ||
          this.isPending(run.id) ||
          this.finishing.has(run.id) ||
          (this.publishOutbox?.has(run.id) ?? false) ||
          this.budgetCeiling(run).over
        ) {
          this.forgetWedgeClock(run.id);
          continue;
        }
        wedged.add(run.id);
        const since = this.unstaffedSince.get(run.id);
        if (since === undefined) {
          this.unstaffedSince.set(run.id, nowMs);
          continue; // first sighting — give normal staffing a full grace window
        }
        if (nowMs - since < graceMs) continue;
        if (!this.watchdogRestaffed.has(run.id)) {
          this.watchdogRestaffed.add(run.id);
          this.unstaffedSince.set(run.id, nowMs);
          this.trace(run, "watchdog", "started", `no live worker for ${Math.round((nowMs - since) / 1000)}s — re-staffing`);
          this.logger.warn("run staffable with no live worker — re-staffing", { run: run.id, stage });
          this.spawnGuarded(run, stage);
          restaffed.push(run.id);
        } else {
          this.trace(run, "watchdog", "held", "re-staff did not take — parked for a human");
          this.forgetWedgeClock(run.id);
          await this.park(
            run,
            "a worker for this run was never established, and an automatic re-staff did not take.",
          );
          parked.push(run.id);
        }
      }
      for (const id of [...this.unstaffedSince.keys()]) if (!wedged.has(id)) this.forgetWedgeClock(id);
      this.lastTickAt = nowMs;
    } finally {
      this.watchdogInFlight = false;
    }
    return { restaffed, parked };
  }

  private forgetWedgeClock(runId: string): void {
    this.unstaffedSince.delete(runId);
    this.watchdogRestaffed.delete(runId);
  }

  /**
   * Commit every live run's worktree as a WIP checkpoint, so a HARD crash (SIGKILL/OOM) loses at
   * most one window of on-disk work. Best-effort per run: one failure never blocks the others.
   */
  async checkpointLiveRuns(): Promise<number> {
    if (this.checkpointInFlight) return 0;
    this.checkpointInFlight = true;
    let checkpointed = 0;
    try {
      for (const [runId, handle] of [...this.workers.entries()]) {
        if (handle.result) continue; // finishing — its onDone path owns the commit
        const ledger = this.liveLedger.get(runId);
        try {
          const commit = await this.git.commitWorktree(
            handle.workspace,
            `beckett: ${runId} checkpoint (${handle.workerId})`,
          );
          if (!commit.committed) continue;
          checkpointed++;
          if (ledger) {
            ledger.lastCheckpointAt = Date.now();
            if (commit.sha) ledger.lastCheckpointSha = commit.sha;
          }
        } catch (err) {
          this.logger.warn("run checkpoint failed (skipping)", { run: runId, error: (err as Error).message });
        }
      }
      if (checkpointed > 0) this.persistRuntimeState();
    } finally {
      this.checkpointInFlight = false;
    }
    return checkpointed;
  }

  // ── crash recovery ────────────────────────────────────────────────────────────────────

  /**
   * For every worker the previous daemon left in the ledger: sweep its orphaned process group,
   * commit whatever ghost WIP it left, and record a resume hint so the re-staffed same-stage
   * worker continues its session instead of re-running the run from scratch. A run whose worker
   * left no session is flagged interrupted — its next spawn parks rather than silently
   * restarting in-flight work.
   */
  async recoverFromCrash(): Promise<void> {
    const recovered = this.recoveredWorkers;
    this.recoveredWorkers = null;
    if (!recovered) return;
    const entries = Object.entries(recovered);
    if (entries.length === 0) return;
    for (const [runId, worker] of entries) {
      if (worker.pid > 0) {
        try {
          this.sweepOrphan(worker.pid, this.harnessBin(worker.harness));
        } catch (err) {
          this.logger.warn("orphan sweep failed", { pid: worker.pid, error: (err as Error).message });
        }
      }
      try {
        await this.git.commitWorktree(worker.workspace, `beckett: ${runId} restart WIP (${worker.workerId})`);
      } catch (err) {
        this.logger.warn("restart WIP commit failed", { run: runId, error: (err as Error).message });
      }
      if (worker.sessionId) {
        this.resumables.set(runId, {
          stage: worker.stage,
          sessionId: worker.sessionId,
          harness: worker.harness,
        });
      }
      this.restartInterrupted.set(runId, worker.stage);
    }
    this.liveLedger.clear();
    this.persistRuntimeState();
    this.logger.info("run crash recovery complete", { interrupted: entries.length, resumable: this.resumables.size });
  }

  // ── worker death + owed stages (#247 / #244) ──────────────────────────────────────────

  /**
   * The LIFECYCLE cause of a worker that died instead of finishing (#247).
   *
   * Deliberately assembled from facts the daemon and the driver OWN — the shutdown flag, the
   * driver's terminal `error` message (which now names `signal SIGTERM` / `code N`, see
   * `../drivers/base.ts#processExitMessage`), the wall-clock verdict, the failure class. It never
   * reads {@link WorkerResult.summary}: on a death that field is `spawn.ts`'s fallback scrape of
   * the last assistant text, which is how "I'll start by inspecting the actual diff and repo
   * state." — a reviewer's OPENING SENTENCE — became the recorded error on 2026-08-12.
   */
  private workerDeathCause(handle: WorkerHandle): string {
    const result = handle.result;
    const clauses: string[] = [];
    // The one-line check the issue asks for: `stop()` raised this before the drain began, so a
    // worker that died after it died BECAUSE the daemon is going down.
    if (this.shuttingDown) clauses.push("killed during daemon shutdown");
    // A worker WE stopped on the clock is a complete explanation on its own — say so and stop,
    // rather than appending a `failure class` clause that reads like the harness broke.
    else if (result?.timedOut) return this.wallClockCapCause(handle);
    const named = result?.errorMessage?.trim();
    if (named) clauses.push(named);
    else if (result?.errorClass) clauses.push(`failure class \`${result.errorClass}\``);
    if (clauses.length === 0) clauses.push(`the ${handle.harness} worker ended without naming a cause`);
    return clauses.join(" — ");
  }

  /**
   * The cause for a worker the wall-clock backstop stopped — deliberately self-contained, and
   * deliberately NOT the word "crash".
   *
   * The message this replaces ("failure class `crash`") sent two people hunting for a segfault on
   * 2026-08-14 for a worker Beckett itself had killed, mid-edit, for running 3601s. So this names
   * the three things a reader needs and none of the ones they don't: that the CAP fired, how long
   * it allowed, and the exact knob that changes it.
   */
  private wallClockCapCause(handle: WorkerHandle): string {
    const capS = hardCapSeconds(this.config);
    const hours = (capS / 3600).toFixed(1).replace(/\.0$/, "");
    // Only `finishImplement` commits WIP before it parks — a dead reviewer wrote nothing to save,
    // so promising a WIP commit there would be a claim this code does not actually honour.
    const wip =
      handle.stage === "implement"
        ? " Whatever it had written to disk was committed as WIP on the branch before this park."
        : "";
    return (
      `hit the wall-clock backstop after ${hours}h — Beckett stopped the harness, it did NOT crash. ` +
      `That backstop is \`supervise.worker_hard_cap_s\` (currently ${capS}s) in ~/.beckett/config.toml; ` +
      `raise it if this work legitimately needs longer.${wip}`
    );
  }

  /** The park reason for a dead worker: the cause and nothing the model happened to be saying. */
  private workerDeathReason(stage: RunStage, handle: WorkerHandle): string {
    // "died" is the wrong word for a worker Beckett deliberately stopped, and the wrong word is
    // exactly what made this misread as a harness fault.
    const verb = handle.result?.timedOut && !this.shuttingDown ? "was stopped" : "died";
    return `the ${stage} worker ${verb} before it reported a verdict: ${this.workerDeathCause(handle)}`;
  }

  /**
   * Record that this daemon OWES `run` a re-dispatch of `stage` (#244). Written at the instant of
   * the death — the one moment both the stage and the cause are in hand — and durable, because the
   * publish outbox survives a restart and workers had nothing equivalent.
   */
  private noteOwedResume(run: Run, stage: RunStage, handle: WorkerHandle): void {
    this.owedResumes.set(run.id, { stage, cause: this.workerDeathCause(handle), at: this.now() });
    this.persistRuntimeState();
  }

  /**
   * Boot: re-dispatch every stage this daemon's predecessor owed (#244), following the publish
   * outbox's pattern — a durable row, drained once at start, consumed whether or not it lands.
   *
   * IDEMPOTENCY is the run ledger's job, not a guess: an owed row is written ONLY on the park path,
   * and a run that is no longer `parked` finished that stage (or a human moved it on) before the
   * kill. Re-dispatching that would double-run a completed stage, so it is dropped with a log line
   * instead. The entries are cleared BEFORE the loop, so a requeue that itself dies is never
   * replayed twice.
   */
  async requeueOwedStages(): Promise<string[]> {
    if (this.owedResumes.size === 0) return [];
    const owed = [...this.owedResumes.entries()];
    this.owedResumes.clear();
    this.persistRuntimeState();
    const requeued: string[] = [];
    for (const [runId, entry] of owed) {
      const run = this.store.get(runId);
      if (!run) continue;
      if (run.state !== "parked") {
        this.logger.info("owed stage dropped — the run moved on without it", {
          run: runId,
          stage: entry.stage,
          state: run.state,
        });
        continue;
      }
      const owedForS = Math.max(0, Math.round((this.now() - entry.at) / 1_000));
      // `restart-restaff` is the digest's existing vocabulary for recovery work (`../dispatch/
      // digest.ts`): one "the daemon restarted — resuming interrupted work" sentence, not a fresh
      // alarm for something the daemon is already fixing.
      this.trace(
        run,
        "restart-restaff",
        "started",
        `re-dispatching the ${entry.stage} stage owed for ${owedForS}s (${entry.cause})`,
      );
      const updated = await this.patchRun(runId, {
        state: entry.stage === "implement" ? "implementing" : "reviewing",
        // The park reason described a worker that is gone; the run is live again and the timeline
        // above keeps the cause. Leaving it would make the next park unreadable.
        error: null,
      });
      if (!updated) continue;
      requeued.push(runId);
      this.logger.warn("re-dispatching a stage owed by the previous daemon", {
        run: runId,
        stage: entry.stage,
        cause: entry.cause,
        owedForS,
      });
    }
    return requeued;
  }

  private harnessBin(harness: string): string {
    const h = this.config.harness as unknown as Record<string, { bin?: string } | undefined>;
    return h?.[harness]?.bin || harness;
  }

  private defaultModelFor(spec: HarnessSpec): string {
    const cfg = this.config.harness as unknown as Record<string, { default_model?: string } | undefined>;
    return cfg?.[spec.harness]?.default_model ?? "";
  }

  // ── shared helpers ────────────────────────────────────────────────────────────────────

  /**
   * `RunStore.update` for a run that may have been cancelled/removed out from under us. The store
   * THROWS on an unknown id (its fail-loud contract for a caller that should know better), but a
   * supervisor patch is always racing a concurrent cancel — losing a state write on a run that no
   * longer exists is correct, while letting it escape would abort a live worker's completion path.
   * Returns the updated run, or null when there was nothing to update.
   */
  private async patchRun(
    runId: string,
    patch: Partial<Omit<Run, "id" | "slug" | "branch" | "sessionName" | "createdAt">>,
  ): Promise<Run | null> {
    try {
      const before = this.store.get(runId)?.state;
      const updated = await this.store.update(runId, patch);
      if (this.onStateChange && patch.state !== undefined && patch.state !== before) {
        try {
          this.onStateChange({ kind: "state_changed", run: updated, from: before ?? null, to: patch.state });
        } catch (err) {
          this.logger.warn("run state-change listener threw (ignored)", { run: runId, error: String(err) });
        }
      }
      return updated;
    } catch (err) {
      this.logger.warn("run state patch skipped — the run is no longer in the ledger", {
        run: runId,
        error: (err as Error).message,
      });
      return null;
    }
  }

  /**
   * A spawn that could not even start. Deliberately NOT a park: the run stays live with the
   * reason recorded, and the staffing watchdog owns recovery — it re-staffs once (giving a
   * transient cause, a network blip or box load, a full grace window to clear) and parks only if
   * that second attempt also leaves the run workerless. One recovery ladder instead of two.
   */
  private async noteSpawnFailure(run: Run, reason: string): Promise<void> {
    await this.patchRun(run.id, { error: reason });
    this.logger.warn("run spawn failed — leaving it to the staffing watchdog", { run: run.id, reason });
  }

  /** Park a run for a human: terminal-ish state, the reason recorded, one `held` event emitted. */
  private async park(run: Run, reason: string): Promise<void> {
    await this.patchRun(run.id, { state: "parked", error: reason });
    this.trace(run, "park", "held", reason);
    this.logger.warn("run parked for a human", { run: run.id, reason });
  }

  private async commitWip(run: Run, handle: WorkerHandle): Promise<string | null> {
    try {
      const commit = await this.git.commitWorktree(handle.workspace, `beckett: ${run.id} WIP (${handle.workerId})`);
      return commit.sha ?? null;
    } catch (err) {
      this.logger.warn("WIP commit failed", { run: run.id, error: (err as Error).message });
      return null;
    }
  }

  private async commitContribution(run: Run, handle: WorkerHandle): Promise<boolean> {
    try {
      const commit = await this.git.commitWorktree(
        handle.workspace,
        `beckett: ${run.id} implement (${handle.workerId})`,
      );
      return commit.committed;
    } catch (err) {
      this.logger.warn("commit of implementation failed", { run: run.id, error: (err as Error).message });
      return false;
    }
  }

  /**
   * Persist a stage's telemetry. Keyed by RUN id — `spendForTicket` is generic over id strings.
   * `forcedOutcome` is the cancel path's override: an aborted worker's partial burn is billed as
   * `cancelled`, not misreported as a failure it never got to have.
   */
  private recordSpend(
    run: Run,
    stage: RunStage,
    handle: WorkerHandle,
    status: "success" | "error",
    meta: SpendStageMeta,
    forcedOutcome?: SpendOutcome,
  ): void {
    if (typeof handle.telemetry !== "function") return;
    try {
      const t = handle.telemetry();
      const signal = status === "success" ? parseDoneSignal(handle.result?.structured) : null;
      const tokens = t.tokens.input + t.tokens.cacheRead + t.tokens.cacheCreate + t.tokens.output;
      const outcome: SpendOutcome =
        forcedOutcome ??
        (status !== "success"
          ? t.toolCalls === 0 && tokens === 0
            ? "launch_failed"
            : "failed"
          : stage === "review" && signal?.status !== "complete"
            ? "rework"
            : stage === "implement" && (signal?.status === "blocked" || signal?.status === "partial")
              ? "rework"
              : "done");
      appendSpendRecord(this.spendLedgerPath, {
        ticketId: run.id,
        project: run.repo ?? null,
        stage,
        harness: meta.harness,
        model: meta.model,
        effort: meta.effort,
        turns: t.turns,
        toolCalls: t.toolCalls,
        tokensIn: t.tokens.input + t.tokens.cacheRead + t.tokens.cacheCreate,
        tokensOut: t.tokens.output,
        costUsd: t.usdEstimate ?? null,
        durationMs: Math.max(0, Date.now() - meta.startedAt),
        outcome,
        // The REAL gate this run ran under (self ⇒ no separate reviewer), so the ledger's
        // per-tier cost analysis isn't reading a hardcoded lie.
        reviewTier: this.reviewTierFor(run),
        ts: new Date().toISOString(),
        ...(handle.result?.errorClass ? { errorClass: handle.result.errorClass } : {}),
        ...(handle.sessionId ? { sessionId: handle.sessionId } : {}),
      });
    } catch (err) {
      this.logger.warn("spend ledger append failed", { run: run.id, stage, error: String(err) });
    }
  }

  // ── the live activity blurb (./activity.ts) ───────────────────────────────────────────
  //
  // "▸ **run-…** · editing index.html · 17m". The supervisor is the only place that sees a
  // worker's event firehose AND owns the card's event bus, so this lane lives here. Three
  // properties are load-bearing, in order:
  //
  //   1. It cannot disturb the run. The whole deterministic path is synchronous and pure —
  //      a regex over a dozen strings — and every entry point is try/catch-wrapped.
  //   2. It cannot cost anything. No model, no fs, no network on this path; the OPTIONAL polish
  //      is off by default, capped at one in-flight call per run, and never awaited.
  //   3. It cannot pollute anything durable. Journal lines are mirrored into a bounded in-memory
  //      ring (never re-read off disk), and the refresh is published with `emitEphemeral`, which
  //      notifies the card sink without appending to `dispatch.jsonl`.

  /** Republish an UNCHANGED phrase no more often than this — enough to keep the card fresh. */
  private static readonly ACTIVITY_REPUBLISH_MS = 60_000;

  /**
   * Mirror one worker event into the run's blurb window, then maybe refresh. Called alongside the
   * journal sink with the SAME event and the SAME formatter, so what the blurb is derived from is
   * exactly what `beckett journal <run>` shows — no second format to drift.
   */
  private noteActivity(runId: string, ev: WorkerEvent, ctx: { stage: string; workerId: string }): void {
    try {
      const activity = this.config.runs?.activity;
      if (activity?.enabled === false) return;
      // Only a live worker stage has a "doing right now" to report.
      if (ctx.stage !== "implement" && ctx.stage !== "review") return;
      const run = this.store.get(runId);
      if (!run || RUN_TERMINAL.has(run.state)) return;

      const line = formatEvent(ev, ctx);
      if (line === null) return; // noise the journal drops too
      const lines = this.activityLines.get(runId) ?? [];
      lines.push(`${new Date(this.now()).toISOString()} ${line}`);
      // Bounded: only the tail is ever read, and nothing else reads this at all.
      if (lines.length > ACTIVITY_CONTEXT_LINES) lines.splice(0, lines.length - ACTIVITY_CONTEXT_LINES);
      this.activityLines.set(runId, lines);

      const throttle = this.activityThrottles.get(runId) ?? newActivityThrottle();
      this.activityThrottles.set(runId, throttle);
      const throttleMs = clampThrottleSecs(activity?.throttle_secs) * 1000;
      if (!shouldRefreshActivity(throttle, this.now(), throttleMs)) return;

      const phrase = deriveActivity(lines);
      // A line the rules have nothing to say about (every run opens with `▸ … worker started`)
      // must not SPEND the refresh — least of all the first-refresh-never-waits allowance, which
      // exists precisely so the run's first real tool call reaches the card immediately.
      if (!phrase) return;
      throttle.lastRefreshAt = this.now();
      this.publishActivity(runId, phrase);
      // The polish only ever RE-writes a phrase that is already on the card, so a slow or broken
      // model costs the run nothing but a phrase that is merely accurate instead of pretty.
      const provider = activity?.provider ?? "off";
      if (provider !== "off" && !throttle.polishInFlight) this.polishActivity(runId, throttle, [...lines], provider);
    } catch (err) {
      // A status decoration may never reach the worker's event handler.
      this.logger.debug("activity blurb bookkeeping failed", { run: runId, error: String(err) });
    }
  }

  /** Fire-and-forget the flag-gated model polish (`[runs.activity] provider`). Never rejects. */
  private polishActivity(
    runId: string,
    throttle: ActivityThrottleState,
    lines: string[],
    provider: "cerebras" | "claude",
  ): void {
    throttle.polishInFlight = true;
    void (async () => {
      try {
        const phrase = await this.summarizeActivity(lines, {
          provider,
          logger: this.logger.child("run.activity"),
        });
        // Seconds passed while the model thought, and the worker whose lines these are may have
        // finished in them — `forgetActivity` drops the window on every worker exit, so a throttle
        // that is no longer the run's CURRENT one means this phrase describes a stage that is over.
        // Publishing it then would stamp an implement-era blurb onto a post-implement card.
        if (phrase && this.activityThrottles.get(runId) === throttle) this.publishActivity(runId, phrase);
      } catch (err) {
        this.logger.debug("activity blurb polish failed", { run: runId, error: String(err) });
      } finally {
        throttle.polishInFlight = false;
      }
    })();
  }

  /**
   * Stamp the phrase onto the run's card. Goes out as an EPHEMERAL dispatch row — the same event
   * shape the card renderer already folds in, so nothing new had to be wired into the sink — but
   * unappended, so the forensic ledger stays a record of transitions rather than of repaints.
   * An unchanged phrase is republished only often enough to stay inside the card's freshness
   * window; a worker that spends ten minutes in one file does not buy forty identical edits.
   */
  private publishActivity(runId: string, phrase: string): void {
    const run = this.store.get(runId);
    if (!run || RUN_TERMINAL.has(run.state)) return; // finished mid-refresh
    const last = this.activityPublished.get(runId);
    const now = this.now();
    if (last && last.phrase === phrase && now - last.at < RunSupervisor.ACTIVITY_REPUBLISH_MS) return;
    this.activityPublished.set(runId, { phrase, at: now });
    this.events.emitEphemeral({
      runId: run.id,
      runRef: run.id,
      branchRef: run.branch,
      ...(run.channelId ? { channel: run.channelId } : {}),
      stage: ACTIVITY_STAGE,
      outcome: "info",
      message: phrase,
    });
  }

  /** Drop a run's blurb window — its worker is gone, so its tool calls describe nothing live. */
  private forgetActivity(runId: string): void {
    this.activityLines.delete(runId);
    this.activityThrottles.delete(runId);
    this.activityPublished.delete(runId);
  }

  /**
   * One persisted-before-live dispatch row. Emitted with `runId`/`runRef` = the run id, so digests, progress cards, dream assembly, and telemetry harvest
   * keep working with no change at all.
   */
  private trace(run: Run, stage: string, outcome: DispatchOutcome, message?: string, error?: string): void {
    this.events.emit({
      runId: run.id,
      runRef: run.id,
      branchRef: run.branch,
      ...(run.channelId ? { channel: run.channelId } : {}),
      stage,
      outcome,
      ...(message ? { message } : {}),
      ...(error ? { error } : {}),
    });
  }

  // ── runtime state ─────────────────────────────────────────────────────────────────────

  private loadRuntimeState(): void {
    if (!this.runtimeStatePath || !existsSync(this.runtimeStatePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.runtimeStatePath, "utf8")) as Partial<RunRuntimeState>;
      if (raw.version !== 1) return;
      const ledger: Record<string, LedgeredRunWorker> = {};
      for (const [runId, value] of Object.entries(raw.liveLedger ?? {})) {
        const w = value as Partial<LedgeredRunWorker>;
        if (w.stage !== "implement" && w.stage !== "review") continue;
        if (typeof w.workspace !== "string") continue;
        ledger[runId] = {
          stage: w.stage,
          workerId: typeof w.workerId === "string" ? w.workerId : "",
          sessionId: typeof w.sessionId === "string" ? w.sessionId : "",
          pid: Number.isInteger(w.pid) ? (w.pid as number) : 0,
          workspace: w.workspace,
          harness: typeof w.harness === "string" ? w.harness : "claude",
          spawnedAt: typeof w.spawnedAt === "number" ? w.spawnedAt : 0,
          ...(typeof w.lastCheckpointAt === "number" ? { lastCheckpointAt: w.lastCheckpointAt } : {}),
          ...(typeof w.lastCheckpointSha === "string" ? { lastCheckpointSha: w.lastCheckpointSha } : {}),
        };
      }
      this.recoveredWorkers = ledger;
      for (const [runId, steers] of Object.entries(raw.pendingSteers ?? {})) {
        const list = (steers as unknown[]).filter((s): s is string => typeof s === "string" && s.trim().length > 0);
        if (list.length) this.pendingSteers.set(runId, list);
      }
      // Stages owed a boot re-dispatch (#244). Absent on a pre-#244 state file, which is exactly a
      // daemon that owed nothing, so the missing key needs no migration.
      for (const [runId, value] of Object.entries(raw.owedResumes ?? {})) {
        const owed = value as Partial<OwedResume>;
        if (owed.stage !== "implement" && owed.stage !== "review") continue;
        this.owedResumes.set(runId, {
          stage: owed.stage,
          cause: typeof owed.cause === "string" ? owed.cause : "cause not recorded",
          at: typeof owed.at === "number" ? owed.at : 0,
        });
      }
    } catch (err) {
      // A malformed ledger is best-effort recovery data, never a boot blocker.
      this.logger.warn("run runtime state unreadable — starting with none", { error: String(err) });
    }
  }

  private persistRuntimeState(): void {
    if (!this.runtimeStatePath) return;
    const state: RunRuntimeState = {
      version: 1,
      liveLedger: Object.fromEntries(this.liveLedger),
      pendingSteers: Object.fromEntries(this.pendingSteers),
      owedResumes: Object.fromEntries(this.owedResumes),
    };
    try {
      mkdirSync(dirname(this.runtimeStatePath), { recursive: true });
      const tmp = `${this.runtimeStatePath}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, this.runtimeStatePath);
    } catch (err) {
      this.logger.warn("run runtime state persist failed", { error: String(err) });
    }
  }
}

/** Factory mirroring `createDispatcher` — the shape `shell/main.ts` wires. */
export function createRunSupervisor(deps: RunSupervisorDeps): RunSupervisor {
  return new RunSupervisor(deps);
}
