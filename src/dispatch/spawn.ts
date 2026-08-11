/**
 * Beckett v3 — ticket-worker spawn helper (`src/dispatch/spawn.ts`)
 * =======================================================================================
 * The thin v3 spawn glue the {@link Dispatcher} (`./dispatcher.ts`) calls to stand up one
 * worker for a ticket stage (see `specs/_legacy-v3/V3.md` §6). v3.1: each ticket builds its OWN project repo
 * at `~/Projects/<slug>` (pushed to the configured GitHub owner), fully decoupled from Beckett's
 * own source.
 * The worker runs IN that repo — implement, review, and rework share the one checkout and edit in
 * place. Isolation between tickets is just "different project dirs," so `beckett plan` nodes still
 * run in parallel. The dispatcher provisions the repo (clone-or-init) before the first spawn.
 *
 * What it wires:
 *   1. Driver — `createDriver(harness, config, logger)` (claude today; codex once registered).
 *   2. Workspace — `repoRoot` (the provisioned project repo); no per-worker worktree.
 *   3. Scope-guard — written to `<repo>/.beckett/worker-settings.json` and delivered via
 *      `claude --settings` (so the project's own `.claude` is never clobbered), plus the
 *      done-signal schema at `<repo>/.beckett/done-schema.json`; `.beckett/` is git-excluded.
 *   4. Spawn — a {@link SpawnSpec} built from the ticket (title/body/criteria), staged for the
 *      `implement` or `review` role (review diffs `<baseRef>..HEAD` to see the contribution).
 *
 * The returned {@link TicketWorkerHandle} exposes the control surface the dispatcher needs:
 * `nudge` (STEERING), `abort` (CANCEL), `onDone`/`onFinished` (advance the ticket), plus
 * `reap` (unsubscribe — the project repo persists). The handle
 * satisfies BOTH the task spec (`id`, `nudge`, `abort`, `onDone`, `state`) and the `specs/_legacy-v3/V3.md`
 * §6 contract (`workerId`, `ticketId`, `stage`, `onFinished`, `reap`).
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import type {
  Config,
  Logger,
  ErrorClass,
  FileScope,
  NudgeReceipt,
  ResourceEnvelope,
  Effort,
  SpawnSpec,
  WorkerEvent,
  WorkerSpend,
  WorkerState,
  HarnessDriver,
} from "../types.ts";
import type { HarnessSpec, Ticket } from "../tracker/types.ts";
import { createDriver } from "../drivers/index.ts";
import { workerId as mintWorkerId } from "../ids.ts";
import { buildPaths } from "../paths.ts";
import { log } from "../log.ts";
import { excludeFromGit, installScaffoldingGuardHook, SCAFFOLDING_DIR } from "../worker/worktree.ts";
import { scopeGuardSpec } from "../hooks/scope-guard.ts";
import { runtimeAwarenessSpec } from "../hooks/runtime-awareness.ts";
import { renderClaudeSettings } from "../hooks/registry.ts";
import { buildResumeBrief } from "./resume-brief.ts";
import { gatherEnvBootstrap } from "./env-bootstrap.ts";
import { defaultEffortFor, stageRegistry, type StageView } from "./stages.ts";

// =======================================================================================
// Handle contract
// =======================================================================================

/** The terminal outcome of a worker run, captured from its `finished` event. */
export interface TicketWorkerResult {
  status: "success" | "error";
  /** A short human summary (done-signal `summary`, else the last assistant text). */
  summary: string;
  /** The raw structured done-signal (`{ status, summary, filesChanged, ... }`), if any. */
  structured: unknown | null;
  /**
   * True when this run ended because it tripped the generous backstop wall-clock cap (the driver's
   * `error_wall_clock_cap` finish, OPS-50), rather than finishing/erroring on its own. The
   * dispatcher keys on this to handle the timeout gracefully (commit WIP, retry / return to ready).
   */
  timedOut: boolean;
  /** Failure taxonomy off the driver's finished event (issue #17); undefined on success. */
  errorClass?: ErrorClass;
  /**
   * Steering the driver buffered but never delivered to the model (issue #22) — drained at
   * finish so the dispatcher can carry the user's words into the next stage instead of
   * silently dropping them. Empty when everything was applied.
   */
  unappliedNudges: string[];
}

/** Callback fired exactly once when a worker reaches a terminal `finished` event. */
export type DoneCallback = (status: "success" | "error", summary: string) => void;

/** Callback fired on each driver stall signal (issue #21) with idle time + consecutive strikes. */
export type StallCallback = (idleMs: number, strikes: number) => void;

/**
 * The live worker handle the dispatcher tracks per ticket. Superset of the task spec and the
 * `specs/_legacy-v3/V3.md` §6 contract so either caller's expectations hold.
 */
export interface TicketWorkerHandle {
  /** Beckett worker id (e.g. "wk_7f3a"). Alias: {@link workerId}. */
  readonly id: string;
  readonly workerId: string;
  readonly ticketId: string;
  /** "implement" | "review" | future stage names. */
  readonly stage: string;
  /** The harness this worker actually ran on (post-substitution) — failure-policy input. */
  readonly harness: string;
  /** Absolute path to this worker's git worktree (its cwd). */
  readonly workspace: string;
  /** The worktree branch carrying this worker's contribution. */
  readonly branch: string;
  /** The harness session/thread id (crash-recovery ledger, issue #20). "" until captured. */
  readonly sessionId: string;
  /** The harness child pid (crash-recovery ledger orphan sweep). 0 until captured. */
  readonly pid: number;
  /** Current lifecycle state (spawning→running→review/failed/aborted). */
  readonly state: WorkerState;
  /** The terminal result once finished; null while still live. */
  readonly result: TicketWorkerResult | null;

  /** Live spend counters off the driver (turns/tools/tokens/$) — for finish-comment telemetry. */
  telemetry(): WorkerSpend;
  /**
   * Most recent tool/file activity, normalized from the same events written to the private
   * journal. Null means there is not enough evidence to compare a silent run safely.
   */
  stallFingerprint(): string | null;
  /**
   * STEERING: inject a mid-flight nudge. Returns the driver's honest receipt (issue #22):
   * `delivered` (acked live), `queued` (inside the harness, unacked), `will-restart` (one-shot —
   * applies when the current run ends), or `dropped` (arrived after the terminal finish; the
   * dispatcher must re-route it, not trust it).
   */
  nudge(text: string): Promise<NudgeReceipt["accepted"]>;
  /** CANCEL: hard-stop the harness process, retaining its session id. */
  abort(reason?: string): Promise<void>;
  /** Register a finish callback (task-spec name). Fired once with the terminal status. */
  onDone(cb: DoneCallback): void;
  /** Register a finish callback (specs/_legacy-v3/V3.md §6 name). Same semantics as {@link onDone}. */
  onFinished(cb: DoneCallback): void;
  /**
   * Register a stall callback (issue #21): fired on each driver `stalled` signal with the idle
   * time and the CONSECUTIVE strike count (resets when the worker shows real progress). The
   * dispatcher's ladder: strike 1 → status-check nudge; strike 2 → abort + retry.
   */
  onStalled(cb: StallCallback): void;
  /** Tear down: unsubscribe from the driver stream and remove the git worktree. Idempotent. */
  reap(): Promise<void>;
}

/** Arguments to {@link spawnWorker}. */
export interface SpawnWorkerArgs {
  ticket: Ticket;
  /** "implement" | "review" | future stage names. */
  stage: string;
  /** The casting entry for this stage (which harness/model/effort). */
  harness: HarnessSpec;
  config: Config;
  /** Absolute git repo root the worktree is allocated under (the shared project `.git`). */
  repoRoot: string;
  /**
   * Absolute path to the ticket's own git worktree — the worker's cwd. The dispatcher allocates it
   * (off a fresh `origin/main`) and reuses it across the ticket's implement/review/rework stages,
   * so every stage sees the same in-progress tree. Isolated per ticket, enabling same-repo
   * concurrency without the stale-base stacking that stranded OPS-59/61.
   */
  workspace: string;
  /** The ticket's worktree branch (e.g. `beckett/<ticket>`), carrying its contribution. */
  branch: string;
  /** Base ref the ticket's worktree was first branched from (the REVIEW diff base). */
  baseRef: string;
  /**
   * Crash recovery (issue #20): the persisted session/thread id of this ticket-stage's previous
   * worker, killed by a daemon restart/crash. When set, the driver relaunches IN RESUME MODE
   * against it (keeping the transcript) and the prompt becomes a short "continue" instruction
   * instead of the full ticket brief the session already carries.
   */
  resumeSessionId?: string;
  /**
   * Optional progress sink: every {@link WorkerEvent} off the driver stream is forwarded here so the
   * dispatcher can record the granular play-by-play in the ticket's private journal (see
   * `src/progress/journal.ts`). Best-effort by contract — a throwing sink is swallowed and never
   * disturbs the worker. Omitted in tests / when no sink is wired.
   */
  onProgress?: (ev: WorkerEvent, ctx: { stage: string; workerId: string }) => void;
  /**
   * Steering comments that arrived while no worker was live (issue #22) — folded into the head
   * of the worker's prompt so the user's words provably reach the first model turn.
   */
  steering?: string[];
  /**
   * The ticket's contribution diff, pre-computed by the dispatcher (issue #27): inlined into the
   * review prompt (≤ ~30KB) or summarized as a changed-file list, so the reviewer's first token
   * judges code instead of running git. Absent → the reviewer diffs for itself (old behavior).
   */
  reviewDiff?: string;
  /**
   * Stage lookup the prompt/system-append resolve through (v6 Phase 5): the dispatcher threads
   * its ExtensionRegistry-backed {@link StageView} here so staffing and prompting can never read
   * diverging stage tables. Absent (tests / embedders) → the shared default view.
   */
  stages?: StageView;
  logger?: Logger;
  /**
   * Extra top-level `--settings` keys merged on top of the driver's own (`crossSessionInbound:
   * "accept"` is always added regardless — see {@link writeWorkerMeta}). Absent for every stage
   * today; a future caller (e.g. an ultracode run) can request `workflowSizeGuideline` etc.
   */
  settingsExtra?: Record<string, unknown>;
  /**
   * Cross-session address (claude `--name`, ≥2.1.224): threaded straight through to the built
   * {@link SpawnSpec} so the concierge/other live sessions can SendMessage this worker by name.
   * Unset = the harness's auto-name. No supervisor naming policy lives here — the caller decides.
   */
  sessionName?: string;
}

// =======================================================================================
// Constants reused from the v2 manager (kept local — v3 does not depend on the manager)
// =======================================================================================

/** The structured done-signal JSON schema (Spec 02 §6) written per-worker for the driver. */
// NOTE: codex's `--output-schema` enforces OpenAI strict mode — EVERY property must appear in
// `required`, and "optional" fields are expressed as nullable unions (type: [..., "null"]).
// Claude accepts this form too, so one schema serves both harnesses.
const DONE_SCHEMA = {
  type: "object",
  required: ["status", "summary", "filesChanged", "checksRun", "blockedReason"],
  properties: {
    status: { type: "string", enum: ["complete", "blocked", "partial"] },
    summary: { type: "string" },
    filesChanged: { type: "array", items: { type: "string" } },
    checksRun: { type: ["array", "null"], items: { type: "string" } },
    blockedReason: { type: ["string", "null"] },
  },
  additionalProperties: false,
} as const;

/**
 * Effort → (turnCap, wallClockS) envelope mapping. These are SOFT supervision estimates, never
 * hard kills: no driver enforces them (the only hard limit is `supervise.worker_hard_cap_s`).
 * They ride the envelope so stall/overrun detection can compare a worker's real turn count and
 * wall clock against what its cast effort predicted.
 */
const ENVELOPE_BY_EFFORT: Record<Effort, { turnCap: number; wallClockS: number }> = {
  low: { turnCap: 15, wallClockS: 600 },
  medium: { turnCap: 30, wallClockS: 1200 },
  high: { turnCap: 60, wallClockS: 2400 },
  xhigh: { turnCap: 100, wallClockS: 3600 },
  // ultracode plans + runs a workflow per substantive task on top of xhigh reasoning — a wider
  // SOFT estimate than xhigh, still never a hard kill (only worker_hard_cap_s is).
  ultracode: { turnCap: 150, wallClockS: 5400 },
};

/** Max chars of fallback assistant text used as a summary. */
const SUMMARY_MAX = 1200;

// Prompt + system-append builders live in the stage registry (`./stages.ts`, OPS-180): each
// stage plugs in its own task brief and persona there, so spawning needs no stage branching.

/** Resolve the worker's write scope. A ticket worker owns its whole project repo. */
function buildScope(ticket: Ticket): FileScope {
  return { ownedGlobs: [], readGlobs: null, description: `${ticket.identifier}: ${ticket.title}` };
}

/** Build the resource envelope from the casting effort (defaults to the configured harness effort). */
function buildEnvelope(harness: HarnessSpec, config: Config): ResourceEnvelope {
  const effort: Effort = harness.effort ?? defaultEffortFor(harness.harness, config);
  const { turnCap, wallClockS } = ENVELOPE_BY_EFFORT[effort];
  // Ticket workers self-provision tools / run checks → allow network. codex honors its own
  // sandbox/network config; the envelope flag is informational for claude.
  const network = harness.harness === "codex" ? config.harness.codex.network_default : true;
  return { effort, turnCap, wallClockS, network };
}

/**
 * Stable per-workspace betterwright profile name: a separate identity (cookie
 * jar + session daemon) inside the one shared worker browser home. Keyed off the
 * workspace path, not the worker id, so implement/review/rework and resume
 * spawns in the same checkout keep one identity — the same persistence the old
 * per-workspace private home had. "wk-" + 12 hex satisfies betterwright's
 * profile-name rules (letters/digits/.-_, must start with a letter or digit).
 */
export function workerBrowserProfileName(workspace: string): string {
  return `wk-${createHash("sha256").update(resolve(workspace)).digest("hex").slice(0, 12)}`;
}

/**
 * The betterwright MCP server entry for one worker's .beckett/betterwright-mcp.json.
 *
 * `sharedHome` is null unless `supervise.worker_browser_shared_home` is on. Off (the default)
 * every worker gets a COLD private home under its own scaffolding: betterwright's vault is
 * home-scoped, so nothing one worker saves — typed-login capture is on by default upstream —
 * can autofill in another. On, all workers share one home (warm session daemon, shared browser
 * binary cache and artifacts) and isolate identity with a named per-workspace profile instead.
 */
export function workerMcpServerConfig(options: {
  beckettRoot: string;
  /** `<beckettDir>/worker-browser` when the shared home is enabled, else null. */
  sharedHome: string | null;
  /** The worker's own `.beckett/` scaffolding dir — the cold home's parent. */
  scaffoldingDir: string;
  workspace: string;
}): { command: string; args: string[]; env: Record<string, string> } {
  return {
    // Direct exec of Beckett's own pinned install — no npx, no package-manager
    // resolution against the worker's cwd, so the worker's project can never
    // grow a betterwright install (the old --no-install containment, stronger).
    // The .bin shim is node-shebanged; node is present wherever npx was.
    command: join(options.beckettRoot, "node_modules", ".bin", "betterwright"),
    args: ["mcp"],
    env: {
      ...(options.sharedHome
        ? {
            // One shared home: vault, artifacts, and config are shared across workers;
            // identity isolation comes from the named profile below, not a cold home.
            BETTERWRIGHT_HOME: options.sharedHome,
            BETTERWRIGHT_PROFILE: workerBrowserProfileName(options.workspace),
          }
        : {
            // Cold private home: profile AND vault stay under the worker's git-excluded
            // scaffolding, so no credential is reachable from any other worker.
            BETTERWRIGHT_HOME: join(options.scaffoldingDir, "betterwright"),
          }),
      BETTERWRIGHT_HEADLESS: "1",
      // No BETTERWRIGHT_OBSCURA_* here: this server is unsandboxed, so implicit
      // discovery finds ~/.betterwright/obscura when deploy installed it and
      // falls back to Chromium/Cloak silently when it did not.
    },
  };
}

/**
 * Write the per-worker meta under `<repoRoot>/.beckett/` (git-excluded): the scope-guard hook
 * settings and the done-signal schema. v3.1 runs the worker IN the project checkout, so the
 * scope-guard is delivered via `claude --settings <file>` (NOT `.claude/settings.json`) — claude
 * layers it on top of the project's own settings rather than overwriting them. The scope-guard's
 * boundary is the repo root, so the worker may edit the whole repo but nothing outside it. Also
 * delivers the runtime-awareness PostToolUse hook (when enabled), which notices slow tool calls
 * back into the worker's own context.
 *
 * Every worker also gets `crossSessionInbound: "accept"` (cross-session messaging, Claude Code
 * ≥2.1.224): without it a bypassPermissions `-p` worker HOLDS an inbound SendMessage rather than
 * receiving it, so the concierge could never reach a live worker for a status check. `settingsExtra`
 * (caller-supplied, e.g. a future ultracode run's `workflowSizeGuideline`) merges on top.
 */
export function writeWorkerMeta(
  repoRoot: string,
  scopeGuardPath: string,
  ownedGlobs: string[],
  runtimeAwarenessPath: string,
  slowToolMs: number,
  /** `<beckettDir>/worker-browser` when the shared worker browser home is enabled, else null. */
  sharedBrowserHome: string | null,
  settingsExtra?: Record<string, unknown>,
): { doneSchemaPath: string; settingsPath: string; mcpConfigPath: string } {
  const metaDir = join(repoRoot, SCAFFOLDING_DIR);
  mkdirSync(metaDir, { recursive: true });

  const hookSpecs = [scopeGuardSpec(scopeGuardPath, repoRoot, ownedGlobs)];
  // Runtime awareness (PostToolUse): only registered when enabled — 0 means no hook at all,
  // so a disabled install pays zero subprocess overhead per tool call.
  if (slowToolMs > 0) hookSpecs.push(runtimeAwarenessSpec(runtimeAwarenessPath, slowToolMs));
  const settingsPath = join(metaDir, "worker-settings.json");
  writeFileSync(
    settingsPath,
    JSON.stringify(
      renderClaudeSettings(hookSpecs, { crossSessionInbound: "accept", ...settingsExtra }),
      null,
      2,
    ),
  );

  const doneSchemaPath = join(metaDir, "done-schema.json");
  writeFileSync(doneSchemaPath, JSON.stringify(DONE_SCHEMA, null, 2));

  // Claude Code starts this stdio server for each worker. By default its betterwright home is
  // cold and private to the worker's scaffolding (no shared vault); with the shared home on,
  // one home plus a named profile per workspace — separate cookie jars, shared everything else.
  const mcpConfigPath = join(metaDir, "betterwright-mcp.json");
  if (sharedBrowserHome) mkdirSync(sharedBrowserHome, { recursive: true });
  writeFileSync(
    mcpConfigPath,
    JSON.stringify(
      {
        mcpServers: {
          betterwright: workerMcpServerConfig({
            beckettRoot: join(import.meta.dir, "..", ".."),
            sharedHome: sharedBrowserHome,
            scaffoldingDir: metaDir,
            workspace: repoRoot,
          }),
        },
      },
      null,
      2,
    ),
  );
  return { doneSchemaPath, settingsPath, mcpConfigPath };
}

/** Extract a human summary from a finished event's structured done-signal or fallback text. */
function summaryFrom(structured: unknown | null, lastAssistantText: string): string {
  if (structured && typeof structured === "object") {
    const s = (structured as Record<string, unknown>).summary;
    if (typeof s === "string" && s.trim()) return s.trim();
  }
  const text = lastAssistantText.trim();
  if (text) return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX)}…` : text;
  return "(worker finished without a summary)";
}

// =======================================================================================
// spawnWorker — the single entry point the dispatcher calls
// =======================================================================================

/**
 * Stand up one worker for a ticket stage. v3.1: the worker runs IN the ticket's own project repo
 * (`repoRoot` = `~/Projects/<slug>`, provisioned by the dispatcher) — implement, review, and every
 * rework cycle share that one checkout and the worker edits + commits in place. Isolation between
 * tickets comes from each one having its OWN project repo, not from worktrees; Beckett publishes
 * the worker's commits under the configured GitHub owner. The scope-guard (delivered via
 * `claude --settings`, so
 * it never clobbers the project's own `.claude`) bounds writes to the project repo. Throws if the
 * harness launch fails; the dispatcher surfaces that as a ticket comment.
 *
 * Exported under both names: `spawnWorker` (task spec) and `spawnTicketWorker` (specs/_legacy-v3/V3.md §6).
 */
export async function spawnWorker(args: SpawnWorkerArgs): Promise<TicketWorkerHandle> {
  const {
    ticket,
    stage,
    harness,
    config,
    repoRoot,
    workspace,
    branch,
    baseRef,
    resumeSessionId,
    onProgress,
    steering,
    reviewDiff,
    settingsExtra,
    sessionName,
  } = args;
  // v6 Phase 5: stage resolution rides the SAME registry view that staffed this ticket.
  const stages = args.stages ?? stageRegistry;
  const logger = (args.logger ?? log.child("dispatch.spawn")).child(`ticket.${ticket.identifier}`);

  const id = mintWorkerId();
  // workspace/branch: the ticket's own worktree (dispatcher-allocated off fresh origin/main, reused
  // across stages). repoRoot stays the shared project `.git` the worktree is attached to.
  const scope = buildScope(ticket);
  const envelope = buildEnvelope(harness, config);
  const scopeGuardPath = join(import.meta.dir, "../hooks/scope-guard.ts");
  const runtimeAwarenessPath = join(import.meta.dir, "../hooks/runtime-awareness.ts");

  // claude and modern pi both own their resume identity from t=0 via a pre-minted UUID. PiDriver's
  // preflight requires pi >=0.78 and `--session-id` support so stale 0.72.x installs fail loudly
  // before dispatch instead of dying after spawn.
  const preMintSession =
    harness.harness === "claude" || harness.harness === "pi" ? randomUUID() : undefined;

  const driver: HarnessDriver = createDriver(harness.harness, config, logger);

  // ── live-handle bookkeeping ──────────────────────────────────────────────────────────
  let state: WorkerState = "spawning";
  let result: TicketWorkerResult | null = null;
  let sessionId = ""; // captured from the driver's SpawnResult (crash-recovery ledger, issue #20)
  let pid = 0;
  let lastAssistantText = "";
  // This is deliberately derived from the normalized WorkerEvents, which are also handed to the
  // private journal immediately below. It is a small in-memory index of existing evidence, not a
  // second telemetry stream or a journal read on the stall hot path.
  let lastStallFingerprint: string | null = null;
  let finishedFired = false;
  let reaped = false;
  const doneCbs = new Set<DoneCallback>();
  const stallCbs = new Set<StallCallback>();
  /** Consecutive stall signals with no real progress between them (issue #21 ladder input). */
  let stallStrikes = 0;

  const fireDone = (status: "success" | "error", summary: string): void => {
    if (finishedFired) return;
    finishedFired = true;
    for (const cb of doneCbs) {
      try {
        cb(status, summary);
      } catch (err) {
        logger.warn("done callback threw", { err: String(err) });
      }
    }
  };

  const unsubscribe = driver.onEvent((e: WorkerEvent) => {
    const fingerprint = stallFingerprintFromEvent(e);
    if (fingerprint) lastStallFingerprint = fingerprint;
    // Record the granular event in the ticket's private journal (best-effort — a broken
    // sink must never derail the worker's own lifecycle bookkeeping below).
    if (onProgress) {
      try {
        onProgress(e, { stage, workerId: id });
      } catch (err) {
        logger.warn("progress sink threw (ignored)", { err: String(err) });
      }
    }
    // Real progress clears the stall ladder (the driver's stall clock keys on the same kinds).
    if (e.kind !== "stalled" && e.kind !== "user_echo" && e.kind !== "unknown") stallStrikes = 0;
    switch (e.kind) {
      case "session_started":
        if (state === "spawning") state = "running";
        break;
      case "assistant_text":
        if (!e.partial && e.text.trim()) lastAssistantText = e.text;
        break;
      case "stalled": {
        stallStrikes += 1;
        for (const cb of stallCbs) {
          try {
            cb(e.idleMs, stallStrikes);
          } catch (err) {
            logger.warn("stall callback threw", { err: String(err) });
          }
        }
        break;
      }
      case "finished": {
        const summary = summaryFrom(e.structuredOutput, lastAssistantText);
        result = {
          status: e.status,
          summary,
          structured: e.structuredOutput,
          timedOut: e.subtype === "error_wall_clock_cap",
          errorClass: e.errorClass,
          // Steering the driver buffered but never applied (issue #22) — the dispatcher carries
          // it into the next stage rather than letting it die with this process.
          unappliedNudges: driver.drainUnappliedNudges?.() ?? [],
        };
        state = e.status === "success" ? "review" : "failed";
        logger.info("ticket worker finished", { workerId: id, stage, status: e.status });
        fireDone(e.status, summary);
        break;
      }
      default:
        break;
    }
  });

  // ── wire scope-guard into the project repo (already provisioned by the dispatcher), then launch ──
  try {
    await excludeFromGit(workspace, [`${SCAFFOLDING_DIR}/`]);
    // Universal guard: strip the scaffolding from the index on every commit, whoever runs it — so a
    // worker's own `git add -f .beckett && git commit` can never sweep bookkeeping into the diff (OPS-61).
    await installScaffoldingGuardHook(workspace);
    const { doneSchemaPath, settingsPath, mcpConfigPath } = writeWorkerMeta(
      workspace,
      scopeGuardPath,
      scope.ownedGlobs,
      runtimeAwarenessPath,
      config.supervise.worker_slow_tool_s * 1000,
      config.supervise.worker_browser_shared_home
        ? join(buildPaths(config).beckettDir, "worker-browser")
        : null,
      settingsExtra,
    );

    // Environment bootstrap: a spawn-time workspace snapshot appended to implement/rework (and
    // unknown-stage fallback) briefs so the worker's first turns never rediscover the obvious.
    // Best-effort by contract — gatherEnvBootstrap never throws and each git call is time-capped.
    // Resume spawns skip it: the resumed session already carries the workspace context.
    const stageDef = stages.get(stage);
    const envBootstrap =
      !resumeSessionId && (stageDef === undefined || stageDef.wantsEnvBootstrap === true)
        ? await gatherEnvBootstrap(workspace, { branch, baseRef })
        : undefined;

    const spec: SpawnSpec = {
      workerId: id,
      prompt: resumeSessionId
        ? buildResumeBrief(ticket, stage, baseRef, steering)
        : stages.prompt(stage, { ticket, baseRef, steering, reviewDiff, envBootstrap }),
      systemAppend: stages.systemAppend(stage, { ticket, config, baseRef }),
      workspace,
      scope,
      envelope,
      model: harness.model ?? "",
      sessionId: preMintSession,
      resumeSessionId,
      doneSchemaPath,
      settingsPath,
      mcpConfigPath,
      settingsExtra,
      sessionName,
    };

    const spawnResult = await driver.spawn(spec);
    sessionId = spawnResult.sessionId;
    pid = spawnResult.pid;
    state = "running";
    logger.info("ticket worker dispatched", {
      workerId: id,
      stage,
      harness: harness.harness,
      model: harness.model ?? "(driver default)",
      sessionId: spawnResult.sessionId,
      resumed: Boolean(resumeSessionId),
      branch,
      baseRef,
      workspace,
    });
  } catch (err) {
    state = "failed";
    unsubscribe();
    logger.error("ticket worker spawn failed", { workerId: id, stage, error: (err as Error).message });
    throw err;
  }

  // ── the control handle ─────────────────────────────────────────────────────────────────
  const handle: TicketWorkerHandle = {
    id,
    workerId: id,
    ticketId: ticket.id,
    stage,
    harness: harness.harness,
    workspace,
    branch,
    get sessionId() {
      return sessionId;
    },
    get pid() {
      return pid;
    },
    get state() {
      return state;
    },
    get result() {
      return result;
    },
    telemetry(): WorkerSpend {
      return driver.getTelemetry();
    },
    stallFingerprint(): string | null {
      return lastStallFingerprint;
    },
    async nudge(text: string): Promise<NudgeReceipt["accepted"]> {
      const receipt = await driver.sendNudge(text);
      logger.info("ticket worker nudged", { workerId: id, accepted: receipt.accepted, len: text.length });
      return receipt.accepted; // honest receipt — the dispatcher narrates anything but "delivered"
    },
    async abort(reason = "aborted"): Promise<void> {
      await driver.abort(reason);
      state = "aborted";
    },
    onDone(cb: DoneCallback): void {
      if (finishedFired && result) cb(result.status, result.summary);
      else doneCbs.add(cb);
    },
    onFinished(cb: DoneCallback): void {
      handle.onDone(cb);
    },
    onStalled(cb: StallCallback): void {
      stallCbs.add(cb);
    },
    async reap(): Promise<void> {
      if (reaped) return;
      reaped = true;
      unsubscribe();
      // v3.1: nothing to tear down — the worker ran in the ticket's persistent project repo
      // (`~/Projects/<slug>`), which lives on as a real repo. Its committed work stays there; the
      // git-excluded `.beckett/` meta is harmless and overwritten by the next worker.
      logger.info("ticket worker reaped", { workerId: id, stage });
    },
  };

  return handle;
}

/** specs/_legacy-v3/V3.md §6 alias for {@link spawnWorker}. */
export const spawnTicketWorker = spawnWorker;

/**
 * Canonical, bounded evidence for the repeat-stall guard. Use only fields that all drivers
 * normalize and that the journal already renders (commands, paths, and the tool name), avoiding
 * volatile ids/timestamps embedded in raw driver frames.
 */
export function stallFingerprintFromEvent(event: WorkerEvent): string | null {
  if (event.kind === "file_change") {
    const paths = [...new Set(event.paths.map((p) => cleanFingerprintPart(p.path)).filter(Boolean))].sort();
    return paths.length > 0 ? `files: ${paths.join(", ")}` : null;
  }
  if (event.kind !== "tool_call") return null;

  const tool = cleanFingerprintPart(event.tool) || "tool";
  const input = event.input && typeof event.input === "object"
    ? event.input as Record<string, unknown>
    : {};
  // These are the same compact, cross-harness hints the journal exposes. A command is preferred
  // so `bun test` stays distinguishable from any other use of the shell tool.
  const detail = ["command", "file_path", "path", "pattern", "query", "url"]
    .map((key) => input[key])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return detail ? `${tool}: ${cleanFingerprintPart(detail)}` : `tool: ${tool}`;
}

/** Collapse presentation-only differences and cap untrusted tool input before it reaches state/comments. */
function cleanFingerprintPart(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim().replace(/`/g, "'");
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 499)}…`;
}
