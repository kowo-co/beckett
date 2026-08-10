/**
 * Beckett's dedicated background browser agent (issue #58).
 *
 * Browser / computer-use work never runs inline in an intake turn: the concierge dispatches a
 * self-contained task here and returns immediately. The agent drives the persistent BetterWright
 * browser through multi-leg `claude -p` sessions; when only a human can unblock it (a
 * verification code, a missing credential, a genuine disambiguation) it parks the session,
 * surfaces ONE question to the originating channel, and later resumes the same session with the
 * answer. Every terminal state — completion, failure, timeout, daemon death — reports back to
 * the concierge as an update turn, backed by a durable run ledger so a crash can never strand
 * the person in silence. Credentials come from the jingle keychain and are injected below the
 * model's transcript as a `secrets` object (see {@link BrowserAgent.evalSecrets}).
 */

import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { buildPaths } from "../paths.ts";
import { childEnv } from "../env.ts";
import type { Config, Logger } from "../types.ts";
import { MAX_BROWSER_EVAL_CALL_TIMEOUT_MS } from "./runtime.ts";
import type { BrowserRuntime } from "./runtime.ts";
import type { KeychainEntrySecrets, KeychainReader } from "../secret/keychain-read.ts";

export type BrowserAgentState = "queued" | "running" | "waiting" | "done" | "error" | "timeout" | "cancelled";

export interface BrowserAgentRun {
  runId: string;
  task: string;
  channelId: string;
  requesterId: string;
  /** Jingle entry backing this run's `secrets` object; the name only — values stay in memory. */
  credsEntry: string | null;
  /** Dispatch-time conversation background, retained in the durable ledger for the run record. */
  context: string | null;
  startedAt: number;
  finishedAt: number | null;
  state: BrowserAgentState;
  result: string | null;
  sessionId: string;
  proofFiles: string[];
  question: string | null;
  questionMessageId: string | null;
  /** Outcome reached the concierge as an update turn; undelivered runs re-report after a restart. */
  outcomeDelivered: boolean;
  /** This run was killed by daemon shutdown and must be surfaced as a concise cancellation. */
  restartCancelled?: boolean;
}

export interface BrowserAgentQuestion {
  text: string;
  screenshot: string;
}

export interface CreateBrowserAgentDeps {
  config: Config;
  logger: Logger;
  browser: BrowserRuntime;
  keychain?: KeychainReader;
  /** Surface one blocking question to the origin channel; resolves to the Discord anchor id. */
  onQuestion: (run: BrowserAgentRun, question: BrowserAgentQuestion) => Promise<string>;
  /** Report a terminal run to the concierge (update turn). Throwing keeps the run undelivered. */
  onOutcome: (run: BrowserAgentRun) => void | Promise<void>;
  spawn?: typeof Bun.spawn;
}

export interface BrowserAgentStats {
  running: number;
  waiting: number;
  queued: number;
  runs: (Pick<BrowserAgentRun, "runId" | "state" | "startedAt" | "finishedAt" | "credsEntry" | "question"> & {
    task: string;
  })[];
}

/** One redacted line of a run's activity journal (journal.jsonl in the run directory). */
export interface BrowserJournalEvent {
  ts: number;
  kind: "dispatched" | "queued" | "leg" | "eval" | "steer" | "question" | "finished";
  [key: string]: unknown;
}

export interface BrowserEvalRecord {
  ok: boolean;
  ms: number;
  url?: string;
  title?: string;
  pages?: number;
  screenshots?: number;
  error?: string;
}

export interface BrowserRunInspection {
  run: Pick<BrowserAgentRun, "runId" | "state" | "task" | "channelId" | "startedAt" | "finishedAt" | "question" | "result" | "proofFiles">;
  journal: BrowserJournalEvent[];
  /** Fresh screenshot of the live page, when the run still holds the browser lease. */
  screenshot: string | null;
  /**
   * Live-view capability URL while the run is live and live view is enabled; null otherwise.
   * Optional so existing BrowserAgent fakes stay structurally valid; inspect always sets it.
   */
  liveViewUrl?: string | null;
}

export interface BrowserAgent {
  /**
   * Dispatch a background run. Always succeeds once the inputs validate: it starts immediately
   * in its own browser session while a lane is available, otherwise queues durably. `queued`
   * carries the 1-based position beyond the runtime's concurrency cap; queued work starts
   * automatically when any session frees — the caller must never re-dispatch.
   */
  run(
    task: string,
    opts: { channelId: string; requesterId: string; credsEntry?: string | null; context?: string | null },
  ): Promise<{ runId: string; queued?: number }>;
  resume(runId: string, answer: string): Promise<void>;
  /**
   * Mid-run guidance from the dispatcher. A running run gets the note appended to its next
   * browser tool result ("queued"); a run parked on a question is resumed with the note framed
   * as steering rather than an answer ("resumed"); a still-queued run folds the note into its
   * launch input ("queued").
   */
  steer(runId: string, note: string): Promise<"queued" | "resumed">;
  /**
   * Cancel a run: a live one gets its active leg killed and the browser released; a queued one
   * is removed from the queue without touching the lease. Both report state "cancelled".
   */
  stop(runId: string, reason?: string): Promise<void>;
  /** Pop queued steering notes for delivery in the current eval's tool result. */
  drainSteers(runId: string): string[];
  /** Journal one browser evaluation (called by the daemon's browser.eval boundary). */
  recordEval(runId: string, record: BrowserEvalRecord): void;
  /** A run's state, redacted journal tail, and (live) a fresh screenshot — for `browser watch`. */
  inspect(runId: string, opts?: { tail?: number; screenshot?: boolean }): Promise<BrowserRunInspection | null>;
  /**
   * Resolve the `secrets` values for one evaluation of a live run: the entry's static fields
   * plus a freshly minted `totp` code when the entry stores a seed. Returns null when the run
   * has no keychain entry. Values are for injection + redaction only — never log or persist.
   */
  evalSecrets(runId: string): Promise<Record<string, string> | null>;
  /**
   * Report every run a dead daemon stranded as cancelled; never replay work after a restart.
   * Call once at boot, after the concierge can take turns.
   */
  recover(): Promise<void>;
  stats(): BrowserAgentStats;
  stopAll(): Promise<void>;
}

export const BROWSER_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "question", "proofApplicable"],
  properties: {
    status: { type: "string", enum: ["completed", "needs_input", "failed"] },
    summary: { type: "string", description: "Concise user-facing outcome or progress." },
    question: {
      type: ["string", "null"],
      description: "One blocking question when status is needs_input; otherwise null.",
    },
    proofApplicable: { type: "boolean", description: "Whether the result has a visible browser state worth proving." },
  },
} as const;

interface BrowserLegResult {
  status: "completed" | "needs_input" | "failed";
  summary: string;
  question: string | null;
  proofApplicable: boolean;
}

interface LiveRun {
  run: BrowserAgentRun;
  runDir: string;
  systemPrompt: string;
  child: ReturnType<typeof Bun.spawn> | null;
  hardTimer: ReturnType<typeof setTimeout> | null;
  questionTimer: ReturnType<typeof setTimeout> | null;
  sensitiveInputs: string[];
  secrets: KeychainEntrySecrets | null;
  /** Dispatcher guidance waiting for the next browser eval to carry it into the transcript. */
  pendingSteers: string[];
}

/** A dispatch accepted while the lease is held: everything needed to start the run later. */
interface PendingDispatch {
  run: BrowserAgentRun;
  /** Resolved at dispatch time (fail-fast); null after a restart — re-read at start. */
  secrets: KeychainEntrySecrets | null;
  /** Steering notes accepted while queued; folded into the launch input at start. */
  pendingSteers: string[];
}

const PROMPT_PATH = join(import.meta.dir, "agent.md");
const BROWSER_MCP_PATH = join(import.meta.dir, "mcp.ts");
const ARTIFACT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const LEDGER_FINISHED_CAP = 50;
const OUTCOME_RETRY_MS = 30_000;
/** How soon a queued start retries after a transient runtime admission race. */
const QUEUE_START_RETRY_MS = 1_000;
/** Filename (inside the run dir) the browser MCP server touches once claude has registered its tool. */
const ATTACH_MARKER_NAME = "mcp-attached";
/** How many times a leg re-spawns claude when the browser tool fails to attach before giving up. */
const LEG_MAX_ATTEMPTS = 3;
/**
 * Milliseconds claude waits for the `browser` stdio MCP server to finish its cold bun boot +
 * handshake before starting the model turn. The default is short enough that, under the CPU
 * contention of a live browser, the tool intermittently isn't registered by the first turn and
 * silently drops under `--strict-mcp-config` — the root cause of the missing-tool runs. Raising it
 * lets the server win the race; the attach marker + retry below catch the residual failures.
 */
const MCP_STARTUP_TIMEOUT_MS = 60_000;
const ATTACH_FAILURE_DIAGNOSTIC =
  "The browser control tool (mcp__browser__betterwright_browser) failed to attach to the agent " +
  `session across ${LEG_MAX_ATTEMPTS} attempts, so no browser actions were possible. This is an ` +
  "infrastructure fault — the browser MCP server did not register its tool in time — not a task " +
  "failure or a genuine question. Dispatch the task again.";

/** One completed run of the claude leg subprocess, before the attach check decides how to read it. */
type LegOutcome =
  | { kind: "result"; stdout: string }
  | { kind: "exit-nonzero"; code: number | null; stderr: string }
  | { kind: "spawn-error"; message: string }
  /** The child was killed or replaced (hard timeout, stop, shutdown) — already finalized elsewhere. */
  | { kind: "superseded" };

function browserMcpConfig(
  runId: string,
  controlToken: string,
  socket: string,
  timeoutMs: number,
  maxOutputChars: number,
  attachMarker: string,
): string {
  return JSON.stringify({
    mcpServers: {
      browser: {
        command: process.execPath,
        args: [BROWSER_MCP_PATH],
        env: {
          BECKETT_CONTROL_SOCKET: socket,
          BECKETT_BROWSER_RUN_ID: runId,
          BECKETT_BROWSER_CONTROL_TOKEN: controlToken,
          BECKETT_BROWSER_EVAL_TIMEOUT_MS: String(timeoutMs + 30_000),
          BECKETT_BROWSER_MAX_OUTPUT_CHARS: String(maxOutputChars),
          BECKETT_BROWSER_ATTACH_MARKER: attachMarker,
        },
      },
    },
  });
}

/** Frame dispatch-time conversation background so it informs the run without competing with the task. */
export function contextPreamble(context: string): string {
  return (
    `Background from the requesting conversation (context to inform your choices — the task ` +
    `above is what you must actually do):\n${context}`
  );
}

/** The one line the first leg gets about its credentials: field NAMES only, never values. */
export function secretsPreamble(secrets: KeychainEntrySecrets): string {
  const fields = secrets.fields.filter((field) => field !== "totp").map((field) => `secrets.${field}`);
  if (secrets.hasTotp) fields.push("secrets.totp (a fresh one-time code each script)");
  return (
    `Credentials for this task are pre-loaded from the keychain entry "${secrets.entry}" as a ` +
    `read-only \`secrets\` object inside every betterwright_browser script: ${fields.join(", ")}. ` +
    `Use them directly in browser code; their values are injected outside your view — never ask ` +
    `for them, and never return, log, or screenshot them.`
  );
}

/**
 * The line a run gets when it has NO credentials loaded. Without it a task that plainly needs a
 * login (the dispatcher wrote "log into X with the x-account credentials" but forgot `credsEntry`)
 * leaves the agent to improvise: it reaches for BetterWright's own credential store, asks it for an
 * entry named after whatever the prose mentioned, and reports "no stored credential named jingle"
 * — a confusing dead end that reads like a browser-engine limitation rather than a missing
 * parameter. Say plainly that nothing is loaded and that asking is the only correct move.
 */
export const NO_SECRETS_PREAMBLE =
  `No credentials are loaded for this run: there is no \`secrets\` object in your scripts. If this ` +
  `task needs a login, do NOT try the browser's built-in credential store, do not guess an entry ` +
  `name, and do not type a placeholder — ask the operator for the keychain entry name, and they ` +
  `will re-dispatch this task with the credentials attached.`;

/** Signals that a dispatched task cannot be completed without a credential. */
const CREDENTIAL_INTENT_RE = /\b(log ?in|logs? into|logged in|sign ?in|sign ?up|password|credential|creds|keychain|jingle)\b/i;

export interface CredsResolution {
  entry: string | null;
  /** Set when the entry was recovered from the task prose rather than passed as a parameter. */
  recoveredFrom?: string;
  /** Set when the task clearly needs credentials but no entry could be resolved. */
  error?: string;
}

/**
 * Decide which keychain entry backs a dispatch. An explicit `credsEntry` always wins. Otherwise,
 * when the task plainly needs a credential, recover the entry the dispatcher named in prose — the
 * common failure is a model writing "using the x-account credentials from jingle" into the task
 * text instead of the parameter, which silently produces a run with no secrets at all. Recovery is
 * deliberately conservative: an exact, whole-word match on a REAL vault entry name, and only when
 * exactly one matches. Anything ambiguous fails the dispatch loudly with the available names, which
 * is far cheaper than a run that flails for ten minutes and then asks an unanswerable question.
 */
export function resolveCredsEntry(task: string, requested: string | null, vaultEntries: readonly string[]): CredsResolution {
  const explicit = requested?.trim();
  if (explicit) return { entry: explicit };
  if (!CREDENTIAL_INTENT_RE.test(task)) return { entry: null };
  const named = vaultEntries.filter((entry) => new RegExp(`(?<![\\w-])${escapeRegex(entry)}(?![\\w-])`, "i").test(task));
  if (named.length === 1) return { entry: named[0]!, recoveredFrom: "task text" };
  const available = vaultEntries.length > 0 ? vaultEntries.join(", ") : "(the vault is empty)";
  return {
    entry: null,
    error:
      `this task needs credentials but no keychain entry was attached: pass credsEntry with the ` +
      `entry name instead of only mentioning it in the task text. ` +
      (named.length > 1
        ? `The task names more than one vault entry (${named.join(", ")}) — say which one.`
        : `Available entries: ${available}.`),
  };
}

export function createBrowserAgent(deps: CreateBrowserAgentDeps): BrowserAgent {
  const { config, logger, browser, keychain } = deps;
  const spawn = deps.spawn ?? Bun.spawn;
  const paths = buildPaths(config);
  const agentDir = join(paths.beckettDir, "browser-agent");
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(agentDir)) {
    if (entry === "runs.json") continue;
    const path = join(agentDir, entry);
    try {
      if (Date.now() - lstatSync(path).mtimeMs > ARTIFACT_RETENTION_MS) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // A concurrent cleanup or unreadable old artifact should not block boot.
    }
  }
  const controlSocket = join(paths.beckettDir, "control.sock");
  const ledgerPath = join(agentDir, "runs.json");
  const live = new Map<string, LiveRun>();
  const finished: BrowserAgentRun[] = [];
  /** Dispatches beyond the runtime's concurrent-session cap, oldest first. */
  const queue: PendingDispatch[] = [];
  /** Dispatches between admission and `live`; each remains durable during acquire. */
  const starting = new Map<string, PendingDispatch>();
  /** Runs a dead daemon left on disk; {@link recover} turns them into restart-cancellation outcomes. */
  const orphans: BrowserAgentRun[] = [];
  let outcomeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let queueRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopping = false;

  loadLedger();

  function loadLedger(): void {
    try {
      if (!existsSync(ledgerPath)) return;
      const parsed = JSON.parse(readFileSync(ledgerPath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) return;
      for (const item of parsed) {
        if (!item || typeof item !== "object") continue;
        const value = item as Record<string, unknown>;
        if (typeof value.runId !== "string" || typeof value.channelId !== "string" || typeof value.requesterId !== "string") continue;
        const run: BrowserAgentRun = {
          runId: value.runId,
          task: typeof value.task === "string" ? value.task : "",
          channelId: value.channelId,
          requesterId: value.requesterId,
          credsEntry: typeof value.credsEntry === "string" ? value.credsEntry : null,
          context: typeof value.context === "string" ? value.context : null,
          startedAt: typeof value.startedAt === "number" ? value.startedAt : Date.now(),
          finishedAt: typeof value.finishedAt === "number" ? value.finishedAt : null,
          state: (["queued", "running", "waiting", "done", "error", "timeout", "cancelled"] as const).includes(value.state as BrowserAgentState)
            ? (value.state as BrowserAgentState)
            : "error",
          result: typeof value.result === "string" ? value.result : null,
          sessionId: typeof value.sessionId === "string" ? value.sessionId : "",
          proofFiles: Array.isArray(value.proofFiles)
            ? value.proofFiles.filter((path): path is string => typeof path === "string")
            : [],
          question: typeof value.question === "string" ? value.question : null,
          questionMessageId: typeof value.questionMessageId === "string" ? value.questionMessageId : null,
          outcomeDelivered: value.outcomeDelivered === true,
          restartCancelled: value.restartCancelled === true,
        };
        // Nothing is replayed after a daemon restart. A live session/lease is gone, and even a
        // queued task is deliberately cancelled rather than becoming a surprise later dispatch.
        if (run.state === "queued" || run.state === "running" || run.state === "waiting") orphans.push(run);
        else finished.push(run);
      }
    } catch (error) {
      logger.warn("browser agent ledger read failed", { error: String(error) });
    }
  }

  function persistLedger(): void {
    while (finished.length > LEDGER_FINISHED_CAP) {
      const evictable = finished.findIndex((run) => run.outcomeDelivered);
      finished.splice(evictable >= 0 ? evictable : 0, 1);
    }
    // `starting` is included so a dispatch mid-acquire can never fall out of the durable ledger.
    const records = [
      ...[...live.values()].map((entry) => entry.run),
      ...[...starting.values()].map((dispatch) => dispatch.run),
      ...queue.map((dispatch) => dispatch.run),
      ...finished,
    ];
    const temp = `${ledgerPath}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(ledgerPath), { recursive: true, mode: 0o700 });
      writeFileSync(temp, JSON.stringify(records, null, 2) + "\n", { mode: 0o600 });
      renameSync(temp, ledgerPath);
    } catch (error) {
      try { unlinkSync(temp); } catch { /* absent */ }
      logger.warn("browser agent ledger write failed", { error: String(error) });
    }
  }

  function scheduleOutcomeRetry(): void {
    if (stopping || outcomeRetryTimer) return;
    outcomeRetryTimer = setTimeout(() => {
      outcomeRetryTimer = null;
      for (const run of finished) {
        if (!run.outcomeDelivered) void deliverOutcome(run);
      }
    }, OUTCOME_RETRY_MS);
  }

  async function deliverOutcome(run: BrowserAgentRun): Promise<void> {
    try {
      await deps.onOutcome(run);
      run.outcomeDelivered = true;
      persistLedger();
    } catch (error) {
      logger.warn("browser agent outcome delivery failed; will retry", {
        runId: run.runId,
        error: String(error),
      });
      scheduleOutcomeRetry();
    }
  }

  function clearTimers(entry: LiveRun): void {
    if (entry.hardTimer) clearTimeout(entry.hardTimer);
    if (entry.questionTimer) clearTimeout(entry.questionTimer);
    entry.hardTimer = null;
    entry.questionTimer = null;
  }

  /**
   * Append one redacted event to the run's activity journal. The journal is the observability
   * surface behind `beckett browser watch`: best-effort, never load-bearing for the run itself.
   */
  function journal(runId: string, sensitiveInputs: readonly string[], event: Omit<BrowserJournalEvent, "ts">): void {
    try {
      const line = redactKnownBrowserInputs(JSON.stringify({ ts: Date.now(), ...event }), sensitiveInputs);
      appendFileSync(join(agentDir, runId, "journal.jsonl"), line + "\n", { mode: 0o600 });
    } catch (error) {
      logger.warn("browser journal write failed", { runId, error: String(error) });
    }
  }

  function readJournal(runId: string, tail: number, sensitiveInputs: readonly string[]): BrowserJournalEvent[] {
    try {
      const lines = readFileSync(join(agentDir, runId, "journal.jsonl"), "utf8").trim().split("\n");
      return lines
        .slice(-Math.max(1, tail))
        .map((line) => {
          try {
            return JSON.parse(redactKnownBrowserInputs(line, sensitiveInputs)) as BrowserJournalEvent;
          } catch {
            return null;
          }
        })
        .filter((event): event is BrowserJournalEvent => event !== null);
    } catch {
      return [];
    }
  }

  async function finalize(entry: LiveRun, state: "done" | "error" | "timeout" | "cancelled", result: string, captureProof = false): Promise<void> {
    const { run } = entry;
    if (run.state !== "running" && run.state !== "waiting") return;
    run.state = state;
    run.result = redactKnownBrowserInputs(result, entry.sensitiveInputs);
    run.finishedAt = Date.now();
    clearTimers(entry);
    entry.child = null;
    entry.secrets = null;
    if (browser.hasLease(run.runId)) {
      try {
        run.proofFiles = await browser.release(run.runId, state === "done" && captureProof);
      } catch (error) {
        logger.warn("browser lease release failed", { runId: run.runId, error: String(error) });
      }
    }
    if (state === "done" && captureProof && run.proofFiles.length === 0) {
      run.state = "error";
      run.result = `${run.result}\n\nThe page reported success, but Beckett could not capture completion proof. Treat the outcome as unverified.`;
    }
    live.delete(run.runId);
    finished.push(run);
    persistLedger();
    journal(run.runId, entry.sensitiveInputs, { kind: "finished", state: run.state, result: run.result });
    logger.info("browser agent run finished", {
      runId: run.runId,
      state: run.state,
      secs: Math.round((run.finishedAt - run.startedAt) / 1000),
      proofFiles: run.proofFiles.length,
    });
    // Outcome delivery owns its own retry/ledger durability. Never let Discord or concierge
    // availability hold the browser lease, run cleanup, or daemon shutdown open.
    void deliverOutcome(run);
    // The lease just freed: the oldest queued dispatch starts without anyone re-asking.
    maybeStartNext();
  }

  /** Terminal bookkeeping for a run that never started — no lease, no child, no timers. */
  function settleQueued(run: BrowserAgentRun, state: "error" | "cancelled", result: string): void {
    run.state = state;
    run.result = result;
    run.finishedAt = Date.now();
    finished.push(run);
    persistLedger();
    journal(run.runId, [], { kind: "finished", state: run.state, result: run.result });
    void deliverOutcome(run);
  }

  /** Retry queued admission after a transient race with another runtime client. */
  function scheduleQueueRetry(): void {
    if (stopping || queueRetryTimer) return;
    queueRetryTimer = setTimeout(() => {
      queueRetryTimer = null;
      maybeStartNext();
    }, QUEUE_START_RETRY_MS);
  }

  /** Runtime admission cap; old runtimes deliberately retain their one-lease behaviour. */
  function concurrentRunCap(): number {
    return Math.max(1, browser.stats().maxConcurrentLeases ?? 1);
  }

  /**
   * Fill every free browser-session lane from the FIFO queue. A queued start whose acquire
   * loses an external race is returned to the head rather than dropped; every other start
   * failure becomes its own terminal outcome and the next lane is attempted.
   */
  function maybeStartNext(): void {
    if (stopping) return;
    while (queue.length > 0 && live.size + starting.size < concurrentRunCap()) {
      const next = queue.shift()!;
      void startDispatch(next).catch((error) => {
        const message = (error as Error).message ?? String(error);
        if (/computer-use is busy|lease cap .* reached/.test(message)) {
          queue.unshift(next);
          persistLedger();
          logger.info("browser queue start lost the lease race; will retry", { runId: next.run.runId });
          scheduleQueueRetry();
          return;
        }
        settleQueued(
          next.run,
          "error",
          `The queued browser run could not start: ${message}. Dispatch it again to retry.`,
        );
        maybeStartNext();
      });
    }
  }

  /**
   * Take the exclusive browser lease and launch a dispatch's first leg. Throws (after
   * releasing any half-taken lease) without registering the run as live, so the caller
   * decides whether the failure surfaces as a dispatch rejection (the immediate path) or a
   * terminal outcome (the queue auto-start path).
   */
  async function startDispatch(dispatch: PendingDispatch): Promise<void> {
    const { run } = dispatch;
    starting.set(run.runId, dispatch);
    try {
      // A queued run deliberately holds no secret values; resolve its named entry only at start.
      if (!dispatch.secrets && run.credsEntry) {
        if (!keychain) throw new Error("keychain credentials are unavailable - jingle reader is not wired");
        dispatch.secrets = await keychain.read(run.credsEntry);
      }
      const runDir = join(agentDir, run.runId);
      const artifactsDir = join(runDir, "artifacts");
      const controlToken = randomBytes(32).toString("base64url");
      mkdirSync(runDir, { recursive: true, mode: 0o700 });
      const systemPrompt = readFileSync(PROMPT_PATH, "utf8");
      const entry: LiveRun = {
        run,
        runDir,
        systemPrompt,
        child: null,
        hardTimer: null,
        questionTimer: null,
        sensitiveInputs: dispatch.secrets ? Object.values(dispatch.secrets.values) : [],
        secrets: dispatch.secrets,
        pendingSteers: [],
      };
      try {
        await browser.acquire({ runId: run.runId, channelId: run.channelId, artifactsDir, controlToken });
        writeFileSync(
          join(runDir, "mcp.json"),
          browserMcpConfig(
            run.runId,
            controlToken,
            controlSocket,
            config.quick.browser_eval_timeout_ms,
            config.quick.browser_max_output_chars,
            join(runDir, ATTACH_MARKER_NAME),
          ),
          { mode: 0o600 },
        );
      } catch (error) {
        if (browser.hasLease(run.runId)) await browser.release(run.runId, false).catch(() => undefined);
        throw error;
      }
      run.state = "running";
      live.set(run.runId, entry);
      // Cleared the moment the run is registered live, so a persistLedger fired from
      // spawnLeg below cannot double-count it as both live and starting.
      starting.delete(run.runId);
      let input = run.task;
      if (run.context) input += `\n\n${contextPreamble(run.context)}`;
      input += `\n\n${dispatch.secrets ? secretsPreamble(dispatch.secrets) : NO_SECRETS_PREAMBLE}`;
      // Steering that arrived while queued folds into the launch input — a queued run has no
      // transcript yet for a tool-result delivery.
      if (dispatch.pendingSteers.length > 0) {
        input +=
          `\n\nGuidance from the dispatcher, sent while this task was queued (apply it to the task):` +
          `\n- ${dispatch.pendingSteers.join("\n- ")}`;
      }
      journal(run.runId, entry.sensitiveInputs, { kind: "dispatched", task: run.task, context: run.context !== null });
      void spawnLeg(entry, input, false);
    } finally {
      starting.delete(run.runId);
    }
  }

  async function parkForQuestion(entry: LiveRun, result: BrowserLegResult): Promise<void> {
    const { run } = entry;
    const question = redactKnownBrowserInputs(result.question?.trim() ?? "", entry.sensitiveInputs).trim();
    if (!question) {
      // A needs_input with no actual question is not a person-answerable ask — historically this was
      // the missing-browser-tool condition surfacing (the model, given only the output tool, bails
      // with an empty question). The attach check upstream now catches the no-tool case; anything
      // still reaching here is a malformed leg result and must read as a fault, never a question.
      await finalize(
        entry,
        "error",
        "The browser agent reported it needs input but named no question — a malformed result, not a genuine ask. Dispatch the task again.",
      );
      return;
    }
    try {
      const screenshot = await browser.capture(run.runId, "question");
      run.state = "waiting";
      run.question = question;
      entry.questionTimer = setTimeout(() => {
        void finalize(
          entry,
          "timeout",
          `Timed out waiting ${config.quick.browser_question_wait_secs}s for an answer to: ${question}`,
        );
      }, config.quick.browser_question_wait_secs * 1000);
      persistLedger();
      journal(run.runId, entry.sensitiveInputs, { kind: "question", text: question });
      const messageId = await deps.onQuestion(run, { text: question, screenshot });
      // Shutdown or the wait deadline may have finalized the run while Discord was posting.
      if (run.state !== "waiting" || !browser.hasLease(run.runId)) return;
      run.questionMessageId = messageId;
      persistLedger();
      logger.info("browser agent waiting for user input", {
        runId: run.runId,
        channelId: run.channelId,
        questionMessageId: run.questionMessageId,
      });
    } catch (error) {
      await finalize(entry, "error", `Could not ask the browser question: ${(error as Error).message}`);
    }
  }

  function baseEnv(): Record<string, string | undefined> {
    const env = childEnv();
    const home = process.env.HOME ?? "";
    const extra = [join(home, ".local/bin"), join(home, ".bun/bin")].join(":");
    env.PATH = env.PATH ? `${extra}:${env.PATH}` : extra;
    // Give claude time to boot the stdio browser MCP server before the model turn, so the tool
    // isn't dropped under `--strict-mcp-config` when a busy host slows the cold bun import.
    if (!env.MCP_TIMEOUT) env.MCP_TIMEOUT = String(MCP_STARTUP_TIMEOUT_MS);
    if (!env.MCP_TOOL_TIMEOUT) {
      env.MCP_TOOL_TIMEOUT = String(Math.max(config.quick.browser_eval_timeout_ms, MAX_BROWSER_EVAL_CALL_TIMEOUT_MS) + 60_000);
    }
    return env;
  }

  /** True once the browser MCP server has touched this leg's attach marker (see {@link ATTACH_MARKER_NAME}). */
  function browserToolAttached(entry: LiveRun): boolean {
    return existsSync(join(entry.runDir, ATTACH_MARKER_NAME));
  }

  /**
   * Run one claude leg to completion and hand back its raw outcome. Never interprets the result or
   * finalizes the run except for the hard-timeout path (which kills the child and finalizes itself,
   * reported here as "superseded"). The attach marker is reset up front so its post-run presence
   * reflects only this attempt.
   */
  async function executeLeg(entry: LiveRun, input: string, resume: boolean): Promise<LegOutcome> {
    const { run, runDir, systemPrompt } = entry;
    try {
      unlinkSync(join(runDir, ATTACH_MARKER_NAME));
    } catch {
      // Absent before the first attempt; only a prior attempt leaves one to clear.
    }
    const args = [
      "-p",
      resume
        ? "Continue the browser task using the user's answer supplied on stdin."
        : "Complete the browser task supplied on stdin.",
      "--output-format",
      "json",
      "--permission-mode",
      config.harness.claude.permission_mode,
      "--model",
      config.quick.model,
      "--system-prompt",
      systemPrompt,
      "--json-schema",
      JSON.stringify(BROWSER_RESULT_SCHEMA),
      "--mcp-config",
      join(runDir, "mcp.json"),
      "--strict-mcp-config",
      "--no-chrome",
      "--tools",
      "mcp__browser__betterwright_browser",
    ];
    if (config.quick.effort) args.push("--effort", config.quick.effort);
    args.push(resume ? "--resume" : "--session-id", run.sessionId);

    logger.info("browser agent leg starting", { runId: run.runId, resume, cwd: runDir });
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = spawn({
        cmd: [config.harness.claude.bin, ...args],
        cwd: runDir,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: baseEnv(),
      });
      entry.child = child;
      const inputSink = child.stdin;
      if (!inputSink || typeof inputSink === "number") throw new Error("browser agent stdin pipe was not created");
      inputSink.write(input);
      inputSink.end();
    } catch (error) {
      return { kind: "spawn-error", message: `browser agent spawn failed: ${(error as Error).message}` };
    }

    entry.hardTimer = setTimeout(() => {
      if (run.state !== "running" || entry.child !== child) return;
      logger.warn("browser agent hit active-leg timeout - killing", { runId: run.runId });
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      void finalize(
        entry,
        "timeout",
        `Active browser work timed out after ${config.quick.hard_timeout_secs}s and was killed.`,
      );
    }, config.quick.hard_timeout_secs * 1000);

    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout as ReadableStream).text().catch(() => ""),
      new Response(child.stderr as ReadableStream).text().catch(() => ""),
      child.exited,
    ]);
    if (entry.child !== child || run.state !== "running") return { kind: "superseded" };
    if (entry.hardTimer) clearTimeout(entry.hardTimer);
    entry.hardTimer = null;
    entry.child = null;
    if (code !== 0) return { kind: "exit-nonzero", code, stderr };
    return { kind: "result", stdout };
  }

  /** Interpret a leg outcome whose browser tool was confirmed attached, and finalize/park the run. */
  async function applyLegOutcome(entry: LiveRun, outcome: LegOutcome): Promise<void> {
    if (outcome.kind === "exit-nonzero") {
      await finalize(
        entry,
        "error",
        `The browser agent exited with code ${outcome.code}${outcome.stderr.trim() ? ` - ${truncate(outcome.stderr.trim(), 500)}` : ""}`,
      );
      return;
    }
    if (outcome.kind !== "result") return; // spawn-error/superseded handled by the caller
    let parsed: BrowserLegResult;
    try {
      parsed = parseBrowserResult(outcome.stdout);
    } catch (error) {
      await finalize(entry, "error", `The browser agent returned invalid structured output: ${(error as Error).message}`);
      return;
    }
    if (parsed.status === "needs_input") {
      await parkForQuestion(entry, parsed);
    } else if (parsed.status === "failed") {
      await finalize(entry, "error", parsed.summary);
    } else {
      await finalize(entry, "done", parsed.summary, parsed.proofApplicable);
    }
  }

  /**
   * Drive a leg with a bounded retry that makes browser attach deterministic. After each attempt we
   * check whether the browser MCP server registered its tool (the attach marker). A leg that ran
   * WITHOUT the tool never reaches the model's success/needs_input/failed interpretation — it would
   * otherwise surface as the observed "tool not available" error or a contentless question — so we
   * discard it and re-spawn; a fresh leg gets a fresh session id since a tool-less attempt may have
   * already claimed the old one. Only once the tool is confirmed attached do we honor the outcome;
   * exhausting the retries finalizes as a clear infrastructure error, never a success or a question.
   */
  function spawnLeg(entry: LiveRun, input: string, resume: boolean): Promise<void> {
    const { run } = entry;
    run.state = "running";
    run.question = null;
    run.questionMessageId = null;
    persistLedger();
    return (async () => {
      for (let attempt = 1; attempt <= LEG_MAX_ATTEMPTS; attempt++) {
        if (!resume && attempt > 1) run.sessionId = randomUUID();
        journal(run.runId, entry.sensitiveInputs, { kind: "leg", resume, attempt });
        const outcome = await executeLeg(entry, input, resume);
        if (outcome.kind === "superseded") return;
        if (outcome.kind === "spawn-error") {
          await finalize(entry, "error", outcome.message);
          return;
        }
        if (browserToolAttached(entry)) {
          await applyLegOutcome(entry, outcome);
          return;
        }
        // The tool was absent this attempt: the model saw only the output tool and either bailed or
        // asked a hollow question. Journal it as infra, then retry rather than trust the outcome.
        journal(run.runId, entry.sensitiveInputs, { kind: "leg", resume, attempt, attached: false });
        logger.warn("browser MCP tool did not attach to the leg", { runId: run.runId, attempt });
        if (attempt >= LEG_MAX_ATTEMPTS || run.state !== "running") break;
      }
      await finalize(entry, "error", ATTACH_FAILURE_DIAGNOSTIC);
    })().catch((error) => finalize(entry, "error", `Browser agent run collapsed: ${String(error)}`));
  }

  return {
    async run(task, opts) {
      if (stopping) throw new Error("the browser agent is shutting down");
      if (!task.trim()) throw new Error("the browser agent needs a non-empty task");
      if (!opts.channelId || !opts.requesterId) {
        throw new Error("browser tasks need an origin channel and an authenticated requester");
      }
      // A dispatch that needs credentials but carries no entry name is the single most expensive
      // silent failure this agent has: the run starts, has no `secrets`, and improvises. Resolve
      // (or refuse) here, before anything spawns.
      const resolved = resolveCredsEntry(task, opts.credsEntry ?? null, keychain ? await keychain.list() : []);
      if (resolved.error) throw new Error(resolved.error);
      if (resolved.recoveredFrom) {
        logger.warn("browser dispatch named its keychain entry in prose instead of credsEntry", {
          entry: resolved.entry,
          recoveredFrom: resolved.recoveredFrom,
        });
      }
      const credsEntry = resolved.entry;
      let secrets: KeychainEntrySecrets | null = null;
      if (credsEntry) {
        if (!keychain) throw new Error("keychain credentials are unavailable - jingle reader is not wired");
        // Resolve before anything spawns or queues so a bad entry fails the dispatch instantly
        // instead of surfacing minutes later from inside the run.
        secrets = await keychain.read(credsEntry);
      }

      const runId = randomUUID();
      mkdirSync(join(agentDir, runId), { recursive: true, mode: 0o700 });
      const run: BrowserAgentRun = {
        runId,
        task,
        channelId: opts.channelId,
        requesterId: opts.requesterId,
        credsEntry,
        context: opts.context?.trim() || null,
        startedAt: Date.now(),
        finishedAt: null,
        state: "queued",
        result: null,
        sessionId: randomUUID(),
        proofFiles: [],
        question: null,
        questionMessageId: null,
        outcomeDelivered: false,
        restartCancelled: false,
      };
      const dispatch: PendingDispatch = { run, secrets, pendingSteers: [] };
      // Preserve FIFO once anyone is queued; otherwise admit directly into any free session
      // lane. The runtime's cap is authoritative and the agent's check gives callers an honest
      // queue position instead of discovering saturation only after a failed acquire.
      if (live.size + starting.size >= concurrentRunCap() || queue.length > 0) {
        // The keychain read above stays fail-fast VALIDATION only: secret values must not sit
        // in daemon memory for an unbounded queue wait, so they are dropped here and re-read
        // by startDispatch when the lease frees (credsEntry set + secrets null — the same
        // path a queued dispatch takes when it reaches the lease).
        dispatch.secrets = null;
        queue.push(dispatch);
        persistLedger();
        const position = queue.length;
        journal(runId, [], { kind: "queued", position });
        logger.info("browser agent queued a dispatch", { runId, position });
        return { runId, queued: position };
      }
      // Immediate path: a lane is free. Start the run in the BACKGROUND and ack with its runId the
      // instant the daemon accepts the task — never block the dispatch on the browser-lease acquire
      // + cold Chromium boot, which can outlast the control-bus deadline and made an already-started
      // run read to the caller as a hard CLI failure (the accept-vs-complete bug, issue #137). A
      // start failure now becomes the run's OWN terminal outcome (delivered as an update turn),
      // exactly like the queued auto-start path — never a dispatch rejection the caller already has a
      // runId for. This is the whole contract `beckett browser` documents: "returns immediately with
      // a runId".
      void startDispatch(dispatch).catch((error) => {
        const message = (error as Error).message ?? String(error);
        if (/computer-use is busy|lease cap .* reached/.test(message)) {
          // Lost the lease to a racing client between the free-lane check and the acquire: fall back
          // to the FIFO queue + retry, never a terminal error — the same recovery maybeStartNext
          // gives a queued start (the dispatcher already told the person "never re-dispatch").
          dispatch.secrets = null;
          queue.push(dispatch);
          persistLedger();
          scheduleQueueRetry();
          return;
        }
        settleQueued(run, "error", `The browser run could not start: ${message}. Dispatch it again to retry.`);
      });
      return { runId };
    },

    async resume(runId, answer) {
      const entry = live.get(runId);
      if (!entry || entry.run.state !== "waiting") {
        throw new Error(`browser run ${runId} is not waiting for an answer`);
      }
      if (!answer.trim()) throw new Error("browser answer cannot be empty");
      entry.sensitiveInputs.push(answer.trim());
      if (entry.questionTimer) clearTimeout(entry.questionTimer);
      entry.questionTimer = null;
      void spawnLeg(entry, answer, true);
    },

    async steer(runId, note) {
      const trimmed = note.trim();
      const queuedDispatch = queue.find((dispatch) => dispatch.run.runId === runId);
      if (queuedDispatch) {
        if (!trimmed) throw new Error("a steering note cannot be empty");
        // A queued run has no transcript yet: the note folds into its launch input instead.
        queuedDispatch.pendingSteers.push(trimmed);
        journal(runId, queuedDispatch.secrets ? Object.values(queuedDispatch.secrets.values) : [], {
          kind: "steer",
          note: trimmed,
          delivery: "queued",
        });
        return "queued";
      }
      const entry = live.get(runId);
      if (!entry) throw new Error(`browser run ${runId} is not live`);
      if (!trimmed) throw new Error("a steering note cannot be empty");
      if (entry.run.state === "waiting") {
        // The run is parked on a question. Steering outranks waiting: resume the same session
        // with the note framed as guidance, and let the agent re-ask if it is still blocked.
        if (entry.questionTimer) clearTimeout(entry.questionTimer);
        entry.questionTimer = null;
        journal(runId, entry.sensitiveInputs, { kind: "steer", note: trimmed, delivery: "resumed" });
        void spawnLeg(
          entry,
          `STEERING from the dispatcher (not an answer to your question): ${trimmed}\n\n` +
            `Apply this guidance to the task. If it resolves what you were asking, continue; if you ` +
            `are still blocked on the same fact, finish with needs_input and ask again.`,
          true,
        );
        return "resumed";
      }
      entry.pendingSteers.push(trimmed);
      journal(runId, entry.sensitiveInputs, { kind: "steer", note: trimmed, delivery: "queued" });
      return "queued";
    },

    async stop(runId, reason) {
      const queuedIndex = queue.findIndex((dispatch) => dispatch.run.runId === runId);
      if (queuedIndex >= 0) {
        // A queued run never held the lease: cancelling it is pure bookkeeping.
        const [dispatch] = queue.splice(queuedIndex, 1);
        settleQueued(
          dispatch!.run,
          "cancelled",
          reason?.trim() || "The run was stopped by the dispatcher before it finished.",
        );
        return;
      }
      const entry = live.get(runId);
      if (!entry) throw new Error(`browser run ${runId} is not live`);
      try {
        entry.child?.kill("SIGKILL");
      } catch {
        // already gone
      }
      entry.child = null;
      await finalize(entry, "cancelled", reason?.trim() || "The run was stopped by the dispatcher before it finished.");
    },

    drainSteers(runId) {
      const entry = live.get(runId);
      if (!entry || entry.pendingSteers.length === 0) return [];
      const notes = entry.pendingSteers.splice(0);
      journal(runId, entry.sensitiveInputs, { kind: "steer", delivered: notes.length, delivery: "eval" });
      return notes;
    },

    recordEval(runId, record) {
      const entry = live.get(runId);
      if (!entry) return;
      journal(runId, entry.sensitiveInputs, { kind: "eval", ...record });
    },

    async inspect(runId, opts) {
      const entry = live.get(runId);
      const queuedDispatch = starting.get(runId) ?? queue.find((dispatch) => dispatch.run.runId === runId);
      const run = entry?.run ?? queuedDispatch?.run ?? finished.find((candidate) => candidate.runId === runId);
      if (!run) return null;
      const sensitiveInputs =
        entry?.sensitiveInputs ?? (queuedDispatch?.secrets ? Object.values(queuedDispatch.secrets.values) : []);
      let screenshot: string | null = null;
      // A fresh screenshot needs the lease; a parked or between-legs run can always serve one,
      // and a capture racing the agent's own eval just queues behind it in the worker.
      const liveEligible = opts?.screenshot !== false && Boolean(entry) && browser.hasLease(runId);
      if (liveEligible) {
        try {
          screenshot = await browser.capture(runId, "watch");
        } catch (error) {
          logger.warn("browser watch screenshot failed", { runId, error: String(error) });
        }
      }
      let liveViewUrl: string | null = null;
      if (liveEligible && browser.liveView) {
        try {
          liveViewUrl = (await browser.liveView(runId, "start")).url;
        } catch (error) {
          // Fail-open: live view is a bonus on top of the screenshot flow.
          logger.warn("browser watch live view failed", { runId, error: String(error) });
        }
      }
      return {
        run: {
          runId: run.runId,
          state: run.state,
          task: run.task,
          channelId: run.channelId,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          question: run.question,
          result: run.result,
          proofFiles: run.proofFiles,
        },
        journal: readJournal(runId, opts?.tail ?? 20, sensitiveInputs),
        screenshot,
        liveViewUrl,
      };
    },

    async evalSecrets(runId) {
      const entry = live.get(runId);
      if (!entry?.secrets) return null;
      const values = { ...entry.secrets.values };
      if (entry.secrets.hasTotp && keychain) {
        const code = await keychain.totp(entry.secrets.entry);
        values.totp = code;
        // A minted code is as sensitive as a password until it expires; redact it from any
        // summary or question this run later surfaces.
        if (!entry.sensitiveInputs.includes(code)) entry.sensitiveInputs.push(code);
      }
      return values;
    },

    async recover() {
      for (const run of orphans.splice(0)) {
        run.state = "cancelled";
        run.restartCancelled = true;
        run.finishedAt = run.finishedAt ?? Date.now();
        run.result = run.result ?? "Cancelled because the daemon restarted before this browser task finished.";
        run.outcomeDelivered = false;
        finished.push(run);
        logger.warn("browser agent recovered an orphaned run", { runId: run.runId, channelId: run.channelId });
      }
      persistLedger();
      for (const run of [...finished]) {
        if (!run.outcomeDelivered) await deliverOutcome(run);
      }
      maybeStartNext();
    },

    stats() {
      const all = [
        ...[...live.values()].map((entry) => entry.run),
        ...[...starting.values()].map((dispatch) => dispatch.run),
        ...queue.map((dispatch) => dispatch.run),
        ...finished,
      ];
      return {
        running: [...live.values()].filter((entry) => entry.run.state === "running").length,
        waiting: [...live.values()].filter((entry) => entry.run.state === "waiting").length,
        queued: queue.length,
        runs: all.map((run) => ({
          runId: run.runId,
          state: run.state,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          credsEntry: run.credsEntry,
          question: run.question,
          task: truncate(run.task, 140),
        })),
      };
    },

    async stopAll() {
      stopping = true;
      if (outcomeRetryTimer) clearTimeout(outcomeRetryTimer);
      outcomeRetryTimer = null;
      if (queueRetryTimer) clearTimeout(queueRetryTimer);
      queueRetryTimer = null;
      // Cancel every accepted dispatch now, including work beyond the lane cap. Leaving queued
      // rows for a future boot used to orphan them during deploys with multiple live sessions.
      for (const dispatch of queue.splice(0)) {
        dispatch.run.restartCancelled = true;
        settleQueued(dispatch.run, "cancelled", "Cancelled because the daemon restarted before this browser task finished.");
      }
      await Promise.all(
        [...live.values()].map(async (entry) => {
          try {
            entry.child?.kill("SIGTERM");
          } catch {
            // best effort
          }
          entry.run.restartCancelled = true;
          await finalize(entry, "cancelled", "Cancelled because the daemon restarted before this browser task finished.");
        }),
      );
    },
  };
}

function parseBrowserResult(stdout: string): BrowserLegResult {
  const envelope = JSON.parse(stdout.trim()) as {
    structured_output?: unknown;
    result?: string;
  };
  let value = envelope.structured_output;
  if (value === undefined && envelope.result) value = JSON.parse(envelope.result);
  if (!value || typeof value !== "object") throw new Error("missing structured_output");
  const result = value as Partial<BrowserLegResult>;
  if (!(["completed", "needs_input", "failed"] as unknown[]).includes(result.status)) {
    throw new Error(`unknown status ${String(result.status)}`);
  }
  if (typeof result.summary !== "string" || !result.summary.trim()) throw new Error("missing summary");
  if (result.question !== null && typeof result.question !== "string") throw new Error("invalid question");
  if (typeof result.proofApplicable !== "boolean") throw new Error("missing proofApplicable");
  return result as BrowserLegResult;
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

/**
 * Scrub every human-supplied answer (passwords, OTPs, recovery codes) and keychain value from a
 * model-facing or user-facing string. Exact inputs are always redacted; token extraction also
 * catches a secret quoted inside a longer sentence.
 */
export function redactKnownBrowserInputs(text: string, inputs: readonly string[]): string {
  const candidates = new Set<string>();
  const looksSensitive = (value: string): boolean => {
    if (/^\d{4,12}$/.test(value)) return true;
    if (value.length < 6) return false;
    const hasLetter = /[a-z]/i.test(value);
    const hasDigit = /\d/.test(value);
    const hasSymbol = /[^a-z0-9\s]/i.test(value);
    return value.length >= 12 || (hasLetter && hasDigit) || hasSymbol;
  };
  for (const input of inputs) {
    const trimmed = input.trim();
    if (trimmed) candidates.add(trimmed);
    for (const line of trimmed.split(/\r?\n/)) {
      const candidate = line.trim();
      if (candidate) candidates.add(candidate);
    }
    for (const part of trimmed.split(/\s+/)) {
      const candidate = part.replace(/^[`'"([{]+|[`'"\])},.!?;:]+$/g, "");
      if (candidate.length >= 3) candidates.add(candidate);
    }
    for (const token of trimmed.match(/[a-z0-9][a-z0-9_!@#$%^&*()+={}\[\]:;,.?~/-]{3,}/gi) ?? []) {
      if (looksSensitive(token)) candidates.add(token);
    }
  }
  return [...candidates]
    .sort((a, b) => b.length - a.length)
    .reduce((redacted, secret) => redacted.replace(new RegExp(escapeRegex(secret), "gi"), "[redacted]"), text);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Values too short to redact would mangle unrelated text; nothing the vault holds is this short. */
const MIN_REDACTABLE_SECRET_CHARS = 4;

/** Scrub known secret VALUES from a plain string (error messages, console lines). */
export function redactSecretText(text: string, values: readonly string[]): string {
  let redacted = text;
  for (const value of [...values].filter((value) => value.length >= MIN_REDACTABLE_SECRET_CHARS).sort((a, b) => b.length - a.length)) {
    redacted = redacted.split(value).join("[redacted]");
    // Values also appear JSON-escaped inside stringified eval payloads.
    const encoded = JSON.stringify(value).slice(1, -1);
    if (encoded !== value) redacted = redacted.split(encoded).join("[redacted]");
  }
  return redacted;
}

/**
 * Scrub known secret values from a JSON-serializable payload (a browser eval result) before it
 * reaches the model transcript. The daemon injects `secrets` below the model's view; this is the
 * matching guarantee that an echoed value (console.log, page text, thrown error) never surfaces.
 */
export function redactSecretValues<T>(payload: T, values: readonly string[]): T {
  if (values.every((value) => value.length < MIN_REDACTABLE_SECRET_CHARS)) return payload;
  return JSON.parse(redactSecretText(JSON.stringify(payload), values)) as T;
}
