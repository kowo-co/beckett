/**
 * Beckett — shared harness-driver lifecycle (`src/drivers/base.ts`)
 * =======================================================================================
 * The ONE copy of the child-process plumbing that used to be hand-copied across
 * `claude.ts` / `codex.ts` / `pi.ts` (issue #19 — ~800 triplicated lines whose divergences
 * were exactly where the lifecycle bugs lived: a missing gen guard here, a missing
 * spawn-timeout kill there, a watchdog that outlived its worker).
 *
 * {@link BaseDriver} owns everything harness-agnostic:
 *   - launch scaffold: setsid process group, session-ready promise, spawn-timeout KILL,
 *     stdout pump → `handleLine`, stderr pump → ring buffer, exit watcher with childGen guard
 *   - the generous wall-clock backstop watchdog (`supervise.worker_hard_cap_s`) + graceful
 *     `error_wall_clock_cap` finish
 *   - unified `onProcessExit`: superseded-child sweep, launch-failure rejection with the
 *     stderr tail folded in, synthesized error finish with the issue-#17 failure taxonomy
 *   - state machine (`setState`/`isTerminal`), event fan-out, token accounting, diff sizing,
 *     telemetry snapshot, pause/abort
 *
 * Subclasses provide ONLY the format-specific surface: argv construction, line parsing, and
 * how the harness handshakes its session id. {@link OneShotDriver} adds the buffered-nudge /
 * relaunch-to-steer machinery shared by the one-shot harnesses (codex `exec`, pi `-p`).
 * Adding harness #4 should be ~150 lines of parsing, not another ~900-line hand-copy.
 */

import type {
  Config,
  Logger,
  NudgeReceipt,
  SpawnResult,
  SpawnSpec,
  TokenUsage,
  WorkerEvent,
  WorkerSpend,
  WorkerState,
} from "../types.ts";
import { makeLogger } from "../log.ts";
import { diffStatSync } from "../git/diff.ts";
import { childEnv } from "../env.ts";
import { hardCapSeconds, killGroup, killProcessTree, wrapProcessGroup } from "./proc.ts";
import { classifyHarnessFailure, StderrRing } from "./failure.ts";

/** The bun subprocess handle type (avoids a hard import of the `bun` module symbol). */
export type Child = ReturnType<typeof Bun.spawn>;

/** How long spawn() waits for the harness's session handshake before failing the launch. */
export const SPAWN_TIMEOUT_MS = 60_000;

/** How long after SIGTERM we escalate to SIGKILL on abort (Spec 02 §4.5). */
export const SIGKILL_GRACE_MS = 4_000;

/** Watchdog poll interval (Spec 02 §9.3). */
const WATCHDOG_INTERVAL_MS = 5_000;

/** Fallback instruction when a one-shot resume() has no buffered nudge to replay. */
export const DEFAULT_RESUME_PROMPT = "Please continue from where you left off.";

export abstract class BaseDriver {
  protected readonly config: Config;
  protected readonly log: Logger;

  protected child: Child | null = null;
  /** True when the child was launched as its own process-group leader (setsid) — enables tree-kill. */
  protected groupKill = false;
  protected spec: SpawnSpec | null = null;

  /** Resume identity (claude session id / codex thread id / pi session id). */
  protected sessionId: string | null = null;
  protected pid: number | null = null;

  protected workerState: WorkerState = "spawning";
  protected finished = false;
  /**
   * Set the instant {@link tickWatchdog} trips the wall-clock backstop — BEFORE the kill goes out,
   * and never cleared. Once the cap has ruled, {@link emit} lets NOTHING but the cap's own
   * `error_wall_clock_cap` finish close this worker (see the guard there for why).
   */
  protected capTripped = false;
  protected spawnedAt = 0;
  protected lastActivityTs = 0;
  /**
   * Epoch ms of the last REAL-progress event (turns/tools/text/files — not echoes or our own
   * stall signals). The stall clock (issue #21) keys on this so a nudge ack can't mask a wedge.
   */
  protected lastProgressTs = 0;
  /** When the last `stalled` signal was emitted — at most one per silent window. */
  protected lastStallEmitTs = 0;
  /**
   * `toolId`s of tool calls seen without a matching `tool_result` (issue #83). A single long
   * foreground tool call (docker build, dep install, a test suite) emits `tool_call` up front then
   * nothing until `tool_result` minutes later — that is a demonstrably-alive worker, not a wedge,
   * so {@link tickStall} stays silent while this is non-empty. The wall-clock hard cap still backs
   * a tool call that never returns.
   */
  protected readonly inFlightTools = new Set<string>();
  /** Incremented per child process; an exit whose gen != current is a superseded child (ignored). */
  protected childGen = 0;

  // ── event fan-out + diagnostics ────────────────────────────────────────────
  protected readonly subscribers = new Set<(e: WorkerEvent) => void>();
  /** Last ~20 stderr lines — the self-diagnosing tail folded into failure messages (issue #17). */
  protected readonly stderrRing = new StderrRing();

  // ── derived counters (Spec 02 §7.3) ────────────────────────────────────────
  protected turns = 0;
  protected toolCalls = 0;
  protected tokens: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };

  // ── launch lifecycle plumbing ──────────────────────────────────────────────
  /** True once the harness's session handshake (init / thread.started / session line) arrived. */
  protected sessionEmitted = false;
  protected resolveSession: ((r: SpawnResult) => void) | null = null;
  protected rejectSession: ((e: Error) => void) | null = null;
  protected spawnTimer: ReturnType<typeof setTimeout> | null = null;
  protected watchdog: ReturnType<typeof setInterval> | null = null;
  protected readLoop: Promise<void> = Promise.resolve();

  constructor(config: Config, logger: Logger | undefined, logComponent: string) {
    this.config = config;
    this.log = (logger ?? makeLogger()).child(logComponent);
  }

  // ===========================================================================
  // subclass surface
  // ===========================================================================

  /** Short harness name ("claude" | "codex" | "pi") for log/error text. */
  protected abstract harnessName(): string;
  /**
   * Parse one raw stdout line and fan out normalized events. MUST tolerate anything. Drivers
   * delegate the shared parse/try-catch envelope to {@link normalizeLine} and keep only their
   * `type` switch — this stays abstract so base.test.ts's no-op TestDriver can override it.
   */
  protected abstract handleLine(line: string): void;
  /** Driver-specific $ estimate for {@link getTelemetry} (stream cost / price table / null). */
  protected abstract usdEstimate(): number | null;

  /** stdin wiring for the child: one-shot harnesses take the prompt as argv → EOF stdin. */
  protected stdinMode(): "pipe" | "ignore" {
    return "ignore";
  }

  /** Child env (API keys stripped — src/env.ts). Override to layer driver-specific vars. */
  protected buildChildEnv(): Record<string, string | undefined> {
    return childEnv();
  }

  /** Hook fired right after a child is spawned and pumps are attached (claude: write prompt). */
  protected afterLaunch(_child: Child, _isResume: boolean): void {}

  /** The structured output attached to a synthesized crash finish (pi reports blocked). */
  protected exitFinishStructuredOutput(_message: string): unknown | null {
    return null;
  }

  /**
   * The Error a failed LAUNCH rejects with (child died / timed out before its handshake).
   * Includes the stderr tail so "exited before init" is self-diagnosing. Overridable for
   * harness-specific hints (pi names its common causes).
   */
  protected spawnFailureError(reason: string | number): Error {
    const tail = this.stderrRing.tail();
    const detail = tail ? ` stderr tail:\n${tail}` : " (nothing on stderr)";
    return new Error(
      `${this.constructor.name}: ${this.harnessName()} exited (${reason}) before its session handshake —` +
        ` the harness never started.${detail}`,
    );
  }

  /** Extra key/values for the "spawning worker" log line. */
  protected launchLogFields(): Record<string, unknown> {
    return {};
  }

  // ===========================================================================
  // HarnessDriver surface (shared)
  // ===========================================================================

  get state(): WorkerState {
    return this.workerState;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  /** Subscribe to the normalized event stream; returns an unsubscribe fn (Spec 02 §3). */
  onEvent(cb: (e: WorkerEvent) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  /**
   * Snapshot of derived counters (Spec 02 §7.3). Cheap: reads in-memory accumulators and
   * shells `git diff --numstat` (+ staged) in the workspace for the ground-truth diff size.
   */
  getTelemetry(): WorkerSpend {
    return {
      turns: this.turns,
      toolCalls: this.toolCalls,
      tokens: { ...this.tokens },
      diffLines: diffStatSync(this.spec?.workspace),
      usdEstimate: this.usdEstimate(),
    };
  }

  /** Epoch ms of the last parsed event (watchdog input, Spec 02 §7.3). */
  getLastActivityTs(): number {
    return this.lastActivityTs;
  }

  /** Checkpoint without killing — the persisted session + workspace git state are the checkpoint. */
  async pause(): Promise<void> {
    if (this.isTerminal()) return;
    this.setState("paused");
    this.log.info("worker paused (session retained)", { sessionId: this.sessionId });
  }

  /** Hard stop: SIGTERM→SIGKILL the whole group after a grace; retain the session id. Idempotent. */
  async abort(reason: string): Promise<void> {
    this.log.warn("aborting worker", { reason, sessionId: this.sessionId });
    this.setState("aborted");
    await this.killChild();
  }

  // ===========================================================================
  // launch scaffold (shared)
  // ===========================================================================

  /**
   * Spawn the harness child and resolve once its session handshake arrives. Owns: process-group
   * wrapping (tree-kill), the spawn-timeout KILL (a hung boot must not survive unsupervised),
   * stdout/stderr pumps, the exit watcher (childGen-guarded), and the wall-clock watchdog.
   */
  protected async launch(
    args: string[],
    opts: { isResume: boolean; initialPrompt?: string | null } = { isResume: false },
  ): Promise<SpawnResult> {
    const spec = this.spec!;
    const bin = this.binName();
    this.setState("spawning");
    this.spawnedAt = this.spawnedAt || Date.now();
    this.lastActivityTs = Date.now();
    this.lastProgressTs = Date.now(); // launch counts as progress — the stall clock starts now
    this.inFlightTools.clear(); // a fresh child has no tools in flight; drop any left by a dead one

    const sessionReady = new Promise<SpawnResult>((resolve, reject) => {
      this.resolveSession = resolve;
      this.rejectSession = reject;
    });

    this.log.info(`spawning ${this.harnessName()} worker`, {
      bin,
      workspace: spec.workspace,
      isResume: opts.isResume,
      sessionId: this.sessionId,
      ...this.launchLogFields(),
    });

    // Launch as a NEW process group (setsid) so abort/timeout can kill the whole tree with one
    // group signal, leaving no orphaned descendant to keep mutating the checkout (OPS-50).
    const { cmd, groupKill } = wrapProcessGroup(bin, args);
    this.groupKill = groupKill;

    let child: Child;
    try {
      child = Bun.spawn({
        cmd,
        cwd: spec.workspace,
        stdin: this.stdinMode(),
        stdout: "pipe",
        stderr: "pipe",
        env: this.buildChildEnv(),
      });
    } catch (err) {
      const e = new Error(
        `${this.constructor.name}: failed to spawn ${bin} — ${(err as Error).message}`,
      );
      this.rejectSession?.(e);
      throw e;
    }

    this.child = child;
    this.pid = child.pid;
    const gen = ++this.childGen;

    // Fail the launch — AND kill the child — if the handshake never arrives. A late-booting
    // harness left alive would run unsupervised and unaccounted (issue #11 leak 5).
    this.spawnTimer = setTimeout(() => {
      const err = this.spawnFailureError(`no session handshake within ${SPAWN_TIMEOUT_MS}ms`);
      this.rejectSession?.(err);
      this.resolveSession = null;
      this.rejectSession = null;
      this.setState("failed");
      void this.killChild();
    }, SPAWN_TIMEOUT_MS);

    this.readLoop = this.consumeStdout(child).catch((err) => {
      this.log.error("stdout read loop crashed", { err: String(err) });
    });
    void this.drainStderr(child);
    // `signalCode` is only populated once the child has actually exited, so it is read INSIDE the
    // continuation — a worker the daemon's restart kills reports `SIGTERM` here and nothing else.
    void child.exited.then((code) =>
      this.onProcessExit(code, gen, child.pid, groupKill, child.signalCode ?? null),
    );

    // Arm the wall-clock watchdog once (survives resumes).
    if (!this.watchdog) {
      this.watchdog = setInterval(() => this.tickWatchdog(), WATCHDOG_INTERVAL_MS);
    }

    this.afterLaunch(child, opts.isResume);
    return sessionReady;
  }

  /** The harness binary from config (subclass points at its `harness.<h>.bin`). */
  protected abstract binName(): string;

  /**
   * Unified exit handling: superseded children are swept and ignored (gen guard); a death
   * before the handshake rejects the launch with the stderr tail; a death without a terminal
   * finish synthesizes an `error_process_exit` finish carrying the issue-#17 failure class;
   * and any descendants the harness left running are group-swept.
   */
  protected async onProcessExit(
    code: number,
    gen: number,
    pid: number,
    groupKill: boolean,
    signal: NodeJS.Signals | null = null,
  ): Promise<void> {
    if (gen !== this.childGen) {
      killGroup(pid, groupKill, this.log);
      return; // superseded child (auto-resume relaunch) — not ours
    }
    this.child = null;
    if (this.spawnTimer) {
      clearTimeout(this.spawnTimer);
      this.spawnTimer = null;
    }
    // Drain any final buffered stdout lines BEFORE deciding — the terminal line (result /
    // turn.completed / agent_end) often flushes immediately before exit.
    await this.readLoop;

    // Launch still pending → the process died before its handshake; fail it loudly.
    if (this.resolveSession && !this.sessionEmitted) {
      this.rejectSession?.(this.spawnFailureError(code));
      this.resolveSession = null;
      this.rejectSession = null;
    }
    // Exited without a terminal finish → synthesize an error finish (crash path).
    if (!this.finished && !this.isTerminal()) {
      const ts = Date.now();
      const message = this.processExitMessage(code, signal);
      this.emit({ kind: "error", message, ts });
      this.emit({
        kind: "finished",
        status: "error",
        subtype: "error_process_exit",
        structuredOutput: this.exitFinishStructuredOutput(message),
        usage: { ...this.tokens },
        errorClass: classifyHarnessFailure(message) ?? "crash",
        ts,
      });
      this.finished = true;
      this.setState("failed");
    }
    this.onExitCleanup();
    // Sweep any descendant the harness left running so a retry worker can't collide with an orphan.
    killGroup(this.pid ?? -1, this.groupKill, this.log);
  }

  /** Hook after exit bookkeeping, before the descendant sweep (claude fails pending nudges). */
  protected onExitCleanup(): void {}

  protected tickWatchdog(): void {
    if (!this.spec || this.finished || this.isTerminal()) return;
    const capS = hardCapSeconds(this.config);
    const totalS = (Date.now() - this.spawnedAt) / 1000;
    if (totalS > capS) {
      // Trip the generous backstop cap. Set both flags up-front so this can't re-enter, so
      // onProcessExit (fired by the kill below) won't also synthesize a finish, and so the
      // harness's own dying words can't outrank the cap's verdict (see {@link emit}).
      this.finished = true;
      this.capTripped = true;
      void this.timeOut(capS, totalS);
      return;
    }
    this.tickStall();
  }

  /**
   * Stall detection (issue #21): no PROGRESS event for `supervise.worker_stall_s` → emit a
   * non-terminal `stalled` signal for the dispatcher's escalation ladder (nudge → abort+retry).
   * Keys on {@link lastProgressTs} — a nudge echo or our own stall signal must not reset the
   * clock, or a wedged-but-echoing worker would be nudged forever. One signal per silent window.
   */
  protected tickStall(): void {
    const stallS = this.config.supervise?.worker_stall_s ?? 0;
    if (!stallS || this.lastProgressTs <= 0 || this.workerState === "paused") return;
    // A tool call in flight means the worker is demonstrably alive, just silent for the length of
    // a long foreground call (issue #83). The wall-clock hard cap still backs a call that hangs.
    if (this.inFlightTools.size > 0) return;
    const now = Date.now();
    const idleMs = now - this.lastProgressTs;
    if (idleMs < stallS * 1000) return;
    if (now - this.lastStallEmitTs < stallS * 1000) return; // already signalled this window
    this.lastStallEmitTs = now;
    this.log.warn("worker stalled — no progress event within the stall window", {
      idleS: Math.round(idleMs / 1000),
      stallS,
    });
    this.emit({ kind: "stalled", idleMs, ts: now });
  }

  /**
   * Handle a hard-cap timeout GRACEFULLY (never a silent death, OPS-50): kill the whole process
   * tree FIRST — so no orphan is still mutating the checkout when the dispatcher reacts — then
   * emit a terminal `finished` (subtype `error_wall_clock_cap`) the dispatcher keys on to commit
   * WIP, comment on the ticket, and retry / return it to a ready state.
   */
  protected async timeOut(capS: number, totalS: number): Promise<void> {
    this.log.warn("hard wall-clock cap hit — timing out worker (backstop, not a work limit)", {
      hardCapS: capS,
      totalS: Math.round(totalS),
    });
    this.setState("aborted");
    // The kill is best-effort; the VERDICT is not. Since `capTripped` now suppresses every other
    // finish (see {@link emit}), a throw between here and the emit below would leave the worker
    // with no terminal event at all — a run wedged open, which is strictly worse than the
    // mislabelled park this whole change exists to fix. So the finish is emitted regardless.
    try {
      await this.killChild();
    } catch (err) {
      this.log.error("wall-clock cap kill failed — reporting the timeout anyway", {
        err: String(err),
      });
    }
    this.emit({
      kind: "finished",
      status: "error",
      subtype: "error_wall_clock_cap",
      structuredOutput: null,
      usage: { ...this.tokens },
      errorClass: "timeout",
      ts: Date.now(),
    });
  }

  protected async killChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    // Kill the whole process group (harness + descendants) so nothing is orphaned (OPS-50).
    await killProcessTree(child, { groupKill: this.groupKill, graceMs: SIGKILL_GRACE_MS, log: this.log });
  }

  // ===========================================================================
  // stdout / stderr pumps (shared)
  // ===========================================================================

  protected async consumeStdout(child: Child): Promise<void> {
    const stream = child.stdout;
    if (!(stream instanceof ReadableStream)) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) this.handleLine(line);
        }
      }
      const tail = buf.trim();
      if (tail) this.handleLine(tail);
    } finally {
      reader.releaseLock();
    }
  }

  protected async drainStderr(child: Child): Promise<void> {
    const stream = child.stderr;
    if (!(stream instanceof ReadableStream)) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true }).trim();
        if (text) {
          this.log.debug(`${this.harnessName()} stderr`, { text });
          this.stderrRing.record(text);
        }
      }
    } catch {
      // best-effort; stderr is diagnostic only
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * "<harness> process exited (code N)" + the stderr tail — self-diagnosing (issue #17).
   *
   * The SIGNAL is named when the OS supplied one (issue #247): a worker killed by the daemon's
   * own restart dies on SIGTERM with no exit code at all, and "code null" is not a cause anyone
   * can diagnose a park from.
   */
  protected processExitMessage(code: number, signal: NodeJS.Signals | null = null): string {
    const how = signal ? `signal ${signal}` : `code ${code}`;
    const tail = this.stderrRing.tail();
    return tail
      ? `${this.harnessName()} process exited (${how}). stderr tail:\n${tail}`
      : `${this.harnessName()} process exited (${how})`;
  }

  // ===========================================================================
  // small shared helpers
  // ===========================================================================

  /** Event kinds that count as REAL worker progress (reset the stall clock, issue #21). */
  private static readonly PROGRESS_KINDS = new Set<WorkerEvent["kind"]>([
    "session_started",
    "turn_started",
    "assistant_text",
    "tool_call",
    "tool_result",
    "file_change",
    "plan_update",
    "turn_completed",
    "finished",
  ]);

  protected emit(e: WorkerEvent): void {
    // ── the cap has already ruled; nothing else may close this worker (2026-08-14) ──
    // {@link timeOut} kills the process tree FIRST and emits its verdict only after the tree is
    // reaped (kill-first, OPS-50). That leaves a whole SIGTERM grace window in between — and a
    // harness spends it flushing its own dying words. `claude` in stream-json mode emits a final
    // `result` line on SIGTERM, which `claude.ts#handleResult` (no `finished` guard, by design —
    // it is the normal terminal path) turns into a `finished` carrying `errorClass: "crash"`.
    //
    // `dispatch/spawn.ts#fireDone` latches the FIRST finish it sees, so that lie won the race and
    // the cap's honest `timeout` finish, ~400ms later, was dropped on the floor. A run we
    // deliberately stopped mid-edit was parked as "failure class `crash`" and cost two people a
    // hunt for a segfault that never happened. Only the cap's own finish may close a capped worker.
    if (e.kind === "finished" && this.capTripped && e.subtype !== "error_wall_clock_cap") {
      this.log.warn("dropping a harness finish that raced the wall-clock cap kill", {
        subtype: e.subtype,
        errorClass: e.errorClass,
      });
      return;
    }
    // Our own stall signal is not activity — counting it would reset the very clock it reports.
    if (e.kind !== "stalled") this.lastActivityTs = e.ts;
    if (BaseDriver.PROGRESS_KINDS.has(e.kind)) this.lastProgressTs = e.ts;
    // Track tool calls in flight so a long foreground call can't look like a wedge (issue #83).
    if (e.kind === "tool_call") this.inFlightTools.add(e.toolId);
    else if (e.kind === "tool_result") this.inFlightTools.delete(e.toolId);
    for (const cb of this.subscribers) {
      try {
        cb(e);
      } catch (err) {
        this.log.warn("event subscriber threw", { err: String(err), kind: e.kind });
      }
    }
  }

  protected setState(state: WorkerState): void {
    this.workerState = state;
    // Tear down the watchdog once the worker reaches a terminal state.
    if (this.isTerminal() && this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  protected isTerminal(): boolean {
    return (
      this.workerState === "done" || this.workerState === "failed" || this.workerState === "aborted"
    );
  }

  protected addTokens(u: TokenUsage): void {
    this.tokens.input += u.input;
    this.tokens.output += u.output;
    this.tokens.cacheRead += u.cacheRead;
    this.tokens.cacheCreate += u.cacheCreate;
  }

  protected stopWatchdog(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  protected str(v: unknown): string | undefined {
    return typeof v === "string" ? v : undefined;
  }

  /**
   * The shared per-line envelope every harness parser wore verbatim (issue #19): parse-guard a raw
   * stdout line — a malformed line emits `unknown` carrying `raw: line` (the STRING) and returns —
   * then run the driver's `dispatch` inside a catch that routes a surprising-but-parseable line to
   * `unknown` carrying `raw: obj` (the PARSED object) with the fixed warn string, so one bad frame
   * never takes down the read loop (Spec 02 §7.2 / Risk-A). Each driver's `handleLine` delegates
   * here; the driver-specific `type` switch stays inside `dispatch` (its own `default:`/ignore set).
   * `handleLine` stays the abstract subclass surface (base.test.ts's TestDriver overrides it).
   */
  protected normalizeLine(line: string, dispatch: (obj: Record<string, unknown>) => void): void {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.emit({ kind: "unknown", raw: line, ts: Date.now() });
      return;
    }
    try {
      dispatch(obj);
    } catch (err) {
      // A surprising-but-parseable line must never take down the loop (Spec 02 §7.2 / Risk-A).
      this.log.warn("event normalization error (routed to unknown)", { err: String(err) });
      this.emit({ kind: "unknown", raw: obj, ts: Date.now() });
    }
  }

  /**
   * Map a harness `usage` block onto the shared {@link TokenUsage} shape (issue #19): the three
   * parsers differed ONLY in field names. `cacheCreate` is optional — a harness with no cache-
   * creation counter (codex) omits it and the field reads 0. Absent/non-numeric fields read 0; an
   * all-zero block returns null (the zero-sum guard — a usage-less line must not count as a turn).
   */
  protected mapTokenUsage(
    raw: unknown,
    map: { input: string; output: string; cacheRead: string; cacheCreate?: string },
  ): TokenUsage | null {
    if (!raw || typeof raw !== "object") return null;
    const u = raw as Record<string, unknown>;
    const n = (v: unknown): number => (typeof v === "number" ? v : 0);
    const usage: TokenUsage = {
      input: n(u[map.input]),
      output: n(u[map.output]),
      cacheRead: n(u[map.cacheRead]),
      cacheCreate: map.cacheCreate ? n(u[map.cacheCreate]) : 0,
    };
    if (usage.input + usage.output + usage.cacheRead + usage.cacheCreate === 0) return null;
    return usage;
  }

  /**
   * The shared session-handshake tail (issue #19): capture the id (when truthy), mark the handshake
   * seen, emit `session_started`, clear the spawn-timeout, go running, and resolve the armed spawn
   * promise. Each driver extracts its own id field (claude `session_id` / codex `thread_id` / pi
   * `id`) and model, then calls this with the handler's own `ts`. Emits `sessionId ?? ""` — claude's
   * old `sessionId!` is equivalent here (it minted the id at spawn, so it is never null by init).
   */
  protected emitSessionStarted(id: string | null, model: string, ts: number): void {
    if (id) this.sessionId = id;
    this.sessionEmitted = true;
    this.emit({ kind: "session_started", sessionId: this.sessionId ?? "", model, ts });
    if (this.spawnTimer) {
      clearTimeout(this.spawnTimer);
      this.spawnTimer = null;
    }
    this.setState("running");
    this.resolveSession?.({ sessionId: this.sessionId ?? "", pid: this.pid ?? -1 });
    this.resolveSession = null;
    this.rejectSession = null;
  }
}

// =======================================================================================
// OneShotDriver — the buffered-nudge / relaunch-to-steer layer (codex exec, pi -p)
// =======================================================================================

/**
 * A one-shot harness runs prompt → one agentic run → process exit; there is no mid-turn steer
 * channel. Steering is therefore ALWAYS buffered and applied by a full relaunch-with-resume
 * after the current run ends — the receipt says so honestly (`will-restart`, issue #19), and a
 * nudge after the terminal finish is reported `dropped` so the dispatcher can tell the human
 * instead of silently eating their words.
 */
export abstract class OneShotDriver extends BaseDriver {
  /** Steering buffered for the next resume (exec is one-shot). */
  protected readonly bufferedNudges: string[] = [];

  /** Rebuild the resume argv for a relaunch continuing this driver's persisted session. */
  protected abstract buildResumeArgs(prompt: string): string[];
  /** Reset per-process parse state before a relaunch (counters/session stay cumulative). */
  protected abstract resetParseState(): void;

  async sendNudge(msg: string): Promise<NudgeReceipt> {
    if (this.finished || this.isTerminal()) {
      this.log.warn("nudge arrived after finish — dropped (nothing will ever replay it)", {
        state: this.workerState,
      });
      return { accepted: "dropped", at: Date.now() };
    }
    this.bufferedNudges.push(msg);
    this.log.info(`nudge buffered for next resume (${this.harnessName()} is one-shot)`, {
      state: this.workerState,
      pending: this.bufferedNudges.length,
    });
    return { accepted: "will-restart", at: Date.now() };
  }

  /** Drain buffered nudges into one resume prompt (falls back to a generic "continue"). */
  protected takeBufferedPrompt(): string {
    const pending = this.bufferedNudges.splice(0, this.bufferedNudges.length);
    return pending.length ? pending.join("\n\n") : DEFAULT_RESUME_PROMPT;
  }

  /** Steering buffered for a resume that never happened (issue #22) — drained at finish. */
  drainUnappliedNudges(): string[] {
    return this.bufferedNudges.splice(0, this.bufferedNudges.length);
  }

  /**
   * Re-attach a paused/finished worker. A still-live process means a run is in flight (one-shot
   * harnesses can't be steered mid-run) so resume just lifts the pause; buffered steering
   * applies after the run ends. If the process exited, relaunch against the persisted session
   * with the buffered instruction as the new prompt.
   */
  async resume(): Promise<void> {
    if (!this.spec) throw new Error(`${this.constructor.name}: resume before spawn`);
    const alive = this.child !== null && !this.finished;
    if (alive) {
      this.setState("running");
      this.log.info("worker resumed (run still in flight; steering applies after it ends)", {
        pending: this.bufferedNudges.length,
      });
      return;
    }
    if (!this.sessionId) {
      throw new Error(`${this.constructor.name}: resume without a captured session id`);
    }

    const prompt = this.takeBufferedPrompt();
    this.log.info(`relaunching ${this.harnessName()} against its persisted session (resume)`, {
      sessionId: this.sessionId,
      promptLen: prompt.length,
    });

    // Sweep the superseded child BEFORE relaunching (issue #11 leak 5): on the auto-resume path
    // the previous process may still be exiting — dropping its handle here would orphan it. A
    // no-op when it already exited; the childGen guard keeps its exit from firing spuriously.
    await this.killChild();

    // Reset per-process parse lifecycle (counters/session are cumulative across resumes).
    this.finished = false;
    this.sessionEmitted = false;
    this.resetParseState();

    const args = this.buildResumeArgs(prompt);
    await this.launch(args, { isResume: true });
  }
}
