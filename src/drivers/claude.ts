/**
 * Beckett — ClaudeDriver (`src/drivers/claude.ts`)
 * =======================================================================================
 * The concrete {@link HarnessDriver} for `claude -p` run as a long-lived, *steerable*
 * worker (Spec 02 §4). One instance drives exactly one harness process inside one git
 * worktree.
 *
 * All process lifecycle (spawn scaffold, watchdog, exit handling, pumps) lives in
 * {@link BaseDriver} (issue #19); this file is ONLY the claude-specific surface: preflight,
 * argv construction, stream-json NDJSON parsing, and the LIVE stdin steering channel (claude
 * is the one harness that can take a nudge mid-run, so it does NOT use {@link OneShotDriver}'s
 * buffered-relaunch machinery).
 *
 * Mechanism (Spec 02 §4.1, verified on `claude 2.1.195` — the "Risk-A" verification
 * pass):
 *
 *   claude -p \
 *     --input-format stream-json --output-format stream-json --verbose \
 *     --replay-user-messages --permission-mode bypassPermissions \
 *     --model <model> --effort <effort> \
 *     --session-id <uuid> | --resume <session_id> \
 *     [--append-system-prompt <sys>] [--mcp-config <cfg>] [--json-schema <done>] \
 *     [<config extra_flags>]
 *
 * - cwd = the worktree (that is how Claude is rooted to its scope, Spec 02 §4.1).
 * - stdin is an open NDJSON pipe: the initial task and every later nudge are written as
 *   `{"type":"user",...}` lines (Spec 02 §4.4). Nudges land at the *next turn boundary*,
 *   never mid-tool; `--replay-user-messages` echoes them back on stdout = the delivery ack.
 * - stdout is consumed line-by-line and normalized into the {@link WorkerEvent} union.
 *   CONTRACT (Spec 02 §7.2 + Risk-A): the parser tolerates unknown `type`s AND unknown
 *   `system` subtypes — it switches on what it knows and routes the rest to `kind:'unknown'`;
 *   it never throws on a surprising line.
 * - session_id is captured the instant `system/init` carries it (durability — Spec 02 §2):
 *   surfaced as {@link SpawnResult} and a `session_started` event so the manager can persist
 *   it for `--resume`.
 * - abort() = SIGTERM→SIGKILL the process, retain the session id (Spec 02 §4.5). resume()
 *   relaunches the same invocation with `--resume <session_id>` from the same cwd, replaying
 *   any nudge buffered across the kill as the first user turn.
 *
 * Economics (Spec 00 §4): tokens / `total_cost_usd` are telemetry only — never a budget gate.
 * Auth (Spec 00 §4): subscription only — the child env strips API keys/endpoint overrides
 * (src/env.ts) so `claude` always uses the `~/.claude` login.
 */

import type {
  Config,
  HarnessDriver,
  Logger,
  NudgeReceipt,
  SpawnResult,
  SpawnSpec,
  TokenUsage,
} from "../types.ts";
import { childEnv } from "../env.ts";
import { BaseDriver, type Child } from "./base.ts";
import { classifyHarnessFailure } from "./failure.ts";
import { probeCommand } from "./preflight-probe.ts";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Default worker permission mode (Spec 02 §4.1; Spec 12 §1.7): bounded by the worktree + the
 * PreToolUse scope hook, so the worker runs autonomously. Used only when the config does not
 * set `harness.claude.permission_mode`. The config key is honored (S3) — see
 * {@link ClaudeDriver.resolvedPermissionMode}; we never weaken this default.
 */
const DEFAULT_PERMISSION_MODE = "bypassPermissions";

/** How long sendNudge waits for the `--replay-user-messages` echo before reporting `queued`. */
const ACK_TIMEOUT_MS = 30_000;

/** Tool names whose calls imply a worktree write (Spec 02 §7.1 — file_change is derived). */
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

interface PendingNudge {
  text: string;
  resolve: (r: NudgeReceipt) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Escalating preflight budgets (ms): a first try that survives machine load, then a roomier retry
 * if it is KILLED. The old flat 10s could time out under heavy concurrent workers, and — because
 * `Bun.spawnSync` reports a timeout kill as `exitCode: null` — that starvation read as a broken
 * claude rather than a slow box (issue #54). A wedged `--version` still can't stall forever.
 */
const PREFLIGHT_BUDGETS_MS = [30_000, 60_000] as const;

/** Escalating budgets for the (much cheaper) `--help` flag-support probe below. */
const HELP_PROBE_BUDGETS_MS = [10_000, 20_000] as const;

/**
 * Cached "does this installed claude binary advertise `--name`?" probe, keyed by bin path
 * (Claude Code ≥2.1.224). Computed once per bin — like the version preflight — since a binary's
 * flag surface can't change between spawns of the same install. Falls open: an unreadable/timed-
 * out/erroring probe reads as unsupported for THAT call, so a stale install never fails a spawn
 * over a missing flag; the warn is logged on every call that falls open, not just the first.
 *
 * IMPORTANT: only a DEFINITIVE probe result (neither timed out nor a spawn error) is ever written
 * here — see {@link supportsNameFlag}. A probe killed by the HELP_PROBE_BUDGETS_MS budgets under
 * heavy concurrent load is a starvation read, not proof the flag is missing (issue #54's KILL-vs-
 * FAIL distinction, the same one `probeCommand`/`claudePreflight` exist to preserve); caching that
 * as permanent `false` would silently kill cross-session addressing for the daemon's lifetime.
 */
const nameFlagSupportCache = new Map<string, boolean>();

/**
 * Probe (and, once definitive, cache) whether `bin` advertises `--name` in `claude --help`.
 * Shared by {@link ClaudeDriver} and the Concierge session so both fail open/closed the same
 * way on the same binary. A starved probe (timed out) or an unrunnable binary (spawnError) is
 * NOT cached — it falls open for this call only and is re-probed next time, since the box being
 * loaded right now says nothing about whether the flag exists.
 */
/**
 * Pin the probe result for a binary without running it. Test seam: the argv-shape tests assert
 * `--name` is present, which must not depend on whether the machine running the suite (a CI
 * runner has no claude at all) happens to carry a modern binary.
 */
export function primeNameFlagSupport(bin: string, supported: boolean): void {
  nameFlagSupportCache.set(bin, supported);
}

export function supportsNameFlag(bin: string, logger?: Pick<Logger, "warn">): boolean {
  const cached = nameFlagSupportCache.get(bin);
  if (cached !== undefined) return cached;

  const r = probeCommand([bin, "--help"], childEnv(), { budgets: HELP_PROBE_BUDGETS_MS });
  const supported = r.ok && /--name\b/.test(r.stdout);
  if (!r.timedOut && !r.spawnError) {
    nameFlagSupportCache.set(bin, supported);
  }
  if (!supported) {
    logger?.warn(
      "claude binary does not advertise --name in --help — omitting session name (cross-session addressing unavailable)",
      { bin, timedOut: r.timedOut, spawnError: r.spawnError ? String(r.spawnError.message) : undefined, exitCode: r.exitCode },
    );
  }
  return supported;
}

/**
 * Static "is claude usable right now?" check (issue #17): binary resolves and reports a version
 * (catches PATH/node drift), and the subscription login artifact exists. Linux keeps credentials
 * at `~/.claude/.credentials.json`; macOS uses the Keychain, so the file check is skipped there.
 * Consulted (cached) by the dispatcher before casting and by `beckett doctor`.
 */
export async function claudePreflight(config: Config): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  const bin = config.harness.claude.bin;

  // Explicit env: Bun resolves the executable against the CHILD env's PATH when one is passed,
  // but against the process's STARTUP PATH when it isn't — which made this preflight blind to
  // `beckett doctor`'s daemon-PATH override (issue #30) while pi's (which passes env) saw it.
  // probeCommand separates a KILLED probe (timed out under load — retried, then reported as a
  // timeout) from a real non-zero exit, so a slow box never masquerades as a broken claude (#54).
  const v = probeCommand([bin, "--version"], childEnv(), { budgets: PREFLIGHT_BUDGETS_MS });
  if (v.spawnError) {
    problems.push(
      `claude binary "${bin}" is not runnable on PATH (${v.spawnError.message}). ` +
        `Install claude or fix config.harness.claude.bin.`,
    );
  } else if (v.timedOut) {
    problems.push(
      `\`${bin} --version\` TIMED OUT — killed by ${v.signalCode ?? "signal"} after ${v.attempts} ` +
        `attempt(s), the last with a ${v.budgetMs / 1000}s budget. claude was NOT confirmed broken; ` +
        `the probe was starved (likely heavy concurrent load). Retry when the box is quieter.`,
    );
  } else if (!v.ok) {
    problems.push(`\`${bin} --version\` exited ${v.exitCode}: ${v.stderr.trim() || "(no output)"}`);
  }

  if (process.platform === "linux") {
    const credsPath = join(process.env.HOME ?? "", ".claude/.credentials.json");
    try {
      const f = Bun.file(credsPath);
      if (!(await f.exists()) || f.size === 0) {
        problems.push(`no claude login at ${credsPath} — run \`claude\` once to sign in (subscription).`);
      }
    } catch (err) {
      problems.push(`could not read claude login at ${credsPath} (${(err as Error).message}).`);
    }
  }

  return { ok: problems.length === 0, problems };
}

export class ClaudeDriver extends BaseDriver implements HarnessDriver {
  readonly kind = "claude-cli-stream" as const;

  private stdinBridgePath: string | null = null;
  /** The first user line to write right after the next launch (null on plain resume). */
  private pendingInitialPrompt: string | null = null;

  // ── claude-specific parse state ─────────────────────────────────────────────
  private readonly seenMsgIds = new Set<string>();
  private readonly seenToolIds = new Set<string>();
  private expectTurnStart = true;
  /** True once any streamed per-turn usage was counted (result.usage is then a fallback only). */
  private tokensFromStream = false;
  /** Authoritative cumulative $ from the terminal result line (`total_cost_usd`). */
  private usd: number | null = null;

  // ── steering (live stdin channel; Spec 02 §4.4) ─────────────────────────────
  private readonly pendingNudges: PendingNudge[] = [];
  /** Nudges buffered while paused / between a kill and a resume (Spec 02 §4.5). */
  private readonly bufferedNudges: string[] = [];

  constructor(config: Config, logger?: Logger) {
    super(config, logger, "driver.claude");
  }

  // ===========================================================================
  // BaseDriver hooks
  // ===========================================================================

  protected harnessName(): string {
    return "claude";
  }

  protected binName(): string {
    return this.config.harness.claude.bin;
  }

  protected usdEstimate(): number | null {
    return this.usd;
  }

  /** claude's stdin stays an open NDJSON pipe — the initial task and every nudge ride it. */
  protected override stdinMode(): "pipe" | "ignore" {
    return "pipe";
  }

  protected override buildChildEnv(): Record<string, string | undefined> {
    const env = childEnv();
    if (this.stdinBridgePath) env.BECKETT_STDIN_BRIDGE = this.stdinBridgePath;
    return env;
  }

  /** Write the initial task as the first user line (skipped on plain resume — context restored). */
  protected override afterLaunch(_child: Child, _isResume: boolean): void {
    const prompt = this.pendingInitialPrompt;
    this.pendingInitialPrompt = null;
    if (prompt !== null) this.writeUserLine(prompt);
  }

  protected override launchLogFields(): Record<string, unknown> {
    return { model: this.resolvedModel(), effort: this.resolvedEffort() };
  }

  /** Pending nudges must not hang their callers once the process is gone. */
  protected override onExitCleanup(): void {
    this.failPendingNudges();
  }

  /** Streamed usage is authoritative once seen; remember so result.usage stays a fallback. */
  protected override addTokens(u: TokenUsage): void {
    super.addTokens(u);
    this.tokensFromStream = true;
  }

  // ===========================================================================
  // spawn
  // ===========================================================================

  /**
   * Launch the worker process, write the initial task line, and resolve once the
   * `system/init` line yields a session id (spawning→running). Rejects if the process
   * dies, or never streams init, before that point.
   */
  async spawn(spec: SpawnSpec): Promise<SpawnResult> {
    if (this.child) throw new Error("ClaudeDriver: already spawned (one driver = one process)");
    this.spec = spec;
    // Crash recovery (issue #20): a caller-persisted session id relaunches `--resume <id>` so the
    // worker keeps its transcript instead of re-paying the whole ticket's exploration cost.
    const resume = spec.resumeSessionId?.trim();
    // Own resume identity from t=0: mint a UUID unless the caller supplied one (Spec 02 §4.1).
    this.sessionId = resume || (spec.sessionId ?? crypto.randomUUID());

    const args = this.buildArgs({ kind: resume ? "resume" : "spawn", sessionId: this.sessionId });
    this.prepareStdinBridge(spec);
    this.pendingInitialPrompt = spec.prompt;
    return this.launch(args, { isResume: Boolean(resume) });
  }

  // ===========================================================================
  // sendNudge — live stdin steering (claude-only capability)
  // ===========================================================================

  /**
   * Write one NDJSON `user` line to the child's stdin and flush (Spec 02 §4.4). Resolves
   * `delivered` when the `--replay-user-messages` echo confirms ingestion, or `queued` if
   * the echo never arrives within {@link ACK_TIMEOUT_MS}. When the process is paused, dead,
   * or terminal the nudge is *buffered* and reported `queued` — it is replayed as the first
   * user turn of the next resume (Spec 02 §4.5).
   */
  async sendNudge(msg: string): Promise<NudgeReceipt> {
    // After the terminal finish nothing will ever replay a buffered nudge (v3 never resumes a
    // finished worker) — report `dropped` honestly so the dispatcher re-routes the words
    // instead of trusting a receipt for a delivery that cannot happen (issue #22).
    if (this.finished || this.isTerminal()) {
      this.log.warn("nudge arrived after finish — dropped (nothing will ever replay it)", {
        state: this.workerState,
      });
      return { accepted: "dropped", at: Date.now() };
    }

    const deliverable = this.child !== null && this.workerState !== "paused";
    if (!deliverable) {
      this.bufferedNudges.push(msg);
      this.log.info("nudge buffered (worker not live)", { state: this.workerState });
      return { accepted: "queued", at: Date.now() };
    }

    return new Promise<NudgeReceipt>((resolve) => {
      const timer = setTimeout(() => {
        // No echo in time → it is buffered inside claude but unacked; report honestly.
        const idx = this.pendingNudges.findIndex((p) => p.timer === timer);
        if (idx >= 0) this.pendingNudges.splice(idx, 1);
        if (this.workerState === "nudging") this.setState("running");
        resolve({ accepted: "queued", at: Date.now() });
      }, ACK_TIMEOUT_MS);
      this.pendingNudges.push({ text: msg, resolve, timer });
      try {
        this.writeUserLine(msg);
        this.setState("nudging");
        this.log.info("nudge written to stdin", { len: msg.length });
      } catch (err) {
        const idx = this.pendingNudges.findIndex((p) => p.timer === timer);
        if (idx >= 0) this.pendingNudges.splice(idx, 1);
        clearTimeout(timer);
        this.bufferedNudges.push(msg);
        this.log.warn("nudge write failed; buffered for resume", { error: String(err) });
        resolve({ accepted: "queued", at: Date.now() });
      }
    });
  }

  // ===========================================================================
  // resume
  // ===========================================================================

  /**
   * Re-attach a paused/crashed worker (Spec 02 §4.5). If the process is still alive this
   * just lifts the pause and flushes buffered nudges. If it has exited, the same invocation
   * is relaunched with `--resume <session_id>` from the same cwd, restoring full context.
   */
  async resume(): Promise<void> {
    if (!this.spec) throw new Error("ClaudeDriver: resume before spawn");
    if (!this.sessionId) throw new Error("ClaudeDriver: resume without a session id");

    const alive = this.child !== null && !this.finished;
    if (alive) {
      this.setState("running");
      this.flushBufferedNudges();
      this.log.info("worker resumed (process still alive)");
      return;
    }

    this.log.info("relaunching with --resume", { sessionId: this.sessionId });
    // Reset per-process parse lifecycle (counters/session are cumulative across resumes).
    this.finished = false;
    this.sessionEmitted = false;
    this.expectTurnStart = true;
    this.seenMsgIds.clear();
    this.seenToolIds.clear();

    const args = this.buildArgs({ kind: "resume", sessionId: this.sessionId });
    this.prepareStdinBridge(this.spec);
    await this.launch(args, { isResume: true });
    this.flushBufferedNudges();
  }

  // ===========================================================================
  // argv construction
  // ===========================================================================

  private resolvedModel(): string {
    return this.spec?.model || this.config.harness.claude.default_model;
  }

  /**
   * The reasoning effort passed to `--effort` (claude 2.1.197: low|medium|high|xhigh|max). The
   * per-stage cast effort (carried on the envelope) wins; otherwise the configured worker default.
   */
  private resolvedEffort(): string {
    return this.spec?.envelope.effort || this.config.harness.claude.default_effort;
  }

  /**
   * The permission mode passed to `--permission-mode`, honoring the config key (S3 — the key
   * was dead before this). Falls back to {@link DEFAULT_PERMISSION_MODE} when unset/blank so
   * the default is never weakened (Spec 02 §4.1; Spec 12 §1.7).
   */
  private resolvedPermissionMode(): string {
    const mode = this.config.harness.claude.permission_mode;
    return mode && mode.trim().length > 0 ? mode : DEFAULT_PERMISSION_MODE;
  }

  /**
   * Probe (and cache, once definitive) whether the configured claude binary supports `--name` —
   * checked lazily, only when a caller actually asked for one (`spec.sessionName` set), so a
   * fleet that never uses cross-session addressing pays zero extra subprocess cost. Delegates to
   * the module-level {@link supportsNameFlag} shared with the Concierge session.
   */
  private nameFlagSupported(): boolean {
    return supportsNameFlag(this.binName(), this.log);
  }

  private buildArgs(mode: { kind: "spawn" | "resume"; sessionId: string }): string[] {
    const spec = this.spec!;
    const args: string[] = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--replay-user-messages",
      "--permission-mode",
      this.resolvedPermissionMode(),
      "--model",
      this.resolvedModel(),
      "--effort",
      this.resolvedEffort(),
      // No --max-turns: envelopes are ESTIMATES, not caps (Spec 02 §7 / canon). turnCap drives the
      // supervisor's drift look, never a hard kill — capping here truncates legitimate long work.
    ];

    if (mode.kind === "spawn") args.push("--session-id", mode.sessionId);
    else args.push("--resume", mode.sessionId);

    // Cross-session address (Claude Code ≥2.1.224): lets the concierge/other live sessions
    // ListAgents/SendMessage this worker by name. Verified against the installed binary's own
    // --help (cached) so an older claude on PATH never sees an unsupported flag and dies at spawn.
    if (spec.sessionName && spec.sessionName.trim().length > 0 && this.nameFlagSupported()) {
      args.push("--name", spec.sessionName);
    }

    if (spec.systemAppend && spec.systemAppend.trim().length > 0) {
      args.push("--append-system-prompt", spec.systemAppend);
    }
    if (spec.mcpConfigPath) args.push("--mcp-config", spec.mcpConfigPath);
    // v3.1: the scope-guard hook rides here (NOT the worktree's .claude/settings.json) so a
    // checkout's own settings are never clobbered — claude layers --settings on top of them.
    if (spec.settingsPath) args.push("--settings", spec.settingsPath);
    // claude's --json-schema takes the schema JSON INLINE, not a file path (verified on 2.1.195;
    // a path makes claude exit 1 before init). Read the done-schema file and pass its contents.
    if (spec.doneSchemaPath) {
      try {
        args.push("--json-schema", readFileSync(spec.doneSchemaPath, "utf8"));
      } catch {
        /* if the schema file is unreadable, skip it rather than crash the worker spawn */
      }
    }

    // Append configured extra flags (e.g. --include-hook-events) without duplicating ours.
    for (const f of this.config.harness.claude.extra_flags) {
      if (!args.includes(f)) args.push(f);
    }
    return args;
  }

  // ===========================================================================
  // NDJSON parsing (stream-json)
  // ===========================================================================

  /**
   * Parse one raw NDJSON line and fan out normalized {@link WorkerEvent}s. Tolerant by
   * contract (Spec 02 §7.2): a malformed line, an unknown `type`, or an unknown `system`
   * subtype becomes a `kind:'unknown'` event — never a throw.
   */
  protected handleLine(line: string): void {
    this.normalizeLine(line, (obj) => this.dispatchFrame(obj));
  }

  /** Route one parsed stream-json frame by `type` (the shared envelope lives in normalizeLine). */
  private dispatchFrame(obj: Record<string, unknown>): void {
    switch (obj.type) {
      case "system":
        this.handleSystem(obj);
        break;
      case "assistant":
        this.handleAssistant(obj);
        break;
      case "user":
        this.handleUser(obj);
        break;
      case "stream_event":
        this.handleStreamEvent(obj);
        break;
      case "result":
        this.handleResult(obj);
        break;
      case "error":
        this.emit({ kind: "error", message: this.str(obj.message) ?? "error", ts: Date.now() });
        break;
      default:
        this.emit({ kind: "unknown", raw: obj, ts: Date.now() });
    }
  }

  private handleSystem(obj: Record<string, unknown>): void {
    const ts = Date.now();
    if (obj.subtype === "init") {
      // The launch is confirmed running once init streams (shared handshake tail in base).
      const sid = this.str(obj.session_id) ?? this.sessionId;
      const model = this.str(obj.model) ?? this.resolvedModel();
      this.emitSessionStarted(sid, model, ts);
      return;
    }

    // api_retry / overloaded notices hint at a rate limit; surface it in the log (the terminal
    // result carries the authoritative classification via the finished event's errorClass).
    if (typeof obj.subtype === "string" && /rate.?limit|overload|api_retry/i.test(obj.subtype)) {
      this.log.warn("rate-limit hint from system message", { subtype: obj.subtype });
    }

    // Any other system subtype (thinking_tokens, task_started, …) is tolerated as unknown.
    this.emit({ kind: "unknown", raw: obj, ts });
  }

  private handleAssistant(obj: Record<string, unknown>): void {
    const ts = Date.now();
    const message = obj.message as Record<string, unknown> | undefined;
    if (!message) {
      this.emit({ kind: "unknown", raw: obj, ts });
      return;
    }
    const id = this.str(message.id);
    const firstSight = !!id && !this.seenMsgIds.has(id);
    if (id) this.seenMsgIds.add(id);

    // Synthesize a turn_started on the first assistant line of a turn (Spec 02 §7.1).
    if (this.expectTurnStart && firstSight) {
      this.expectTurnStart = false;
      this.turns += 1;
      this.emit({ kind: "turn_started", ts });
    }

    // Token usage: count once per message.id (dedup parallel tool-call lines, §7.3).
    if (firstSight) {
      const usage = this.mapUsage(message.usage);
      if (usage) {
        this.addTokens(usage);
        this.emit({ kind: "turn_completed", usage, ts });
      }
    }

    const content = Array.isArray(message.content) ? message.content : [];
    for (const raw of content) {
      const block = raw as Record<string, unknown>;
      if (block.type === "text" && firstSight) {
        this.emit({ kind: "assistant_text", text: this.str(block.text) ?? "", partial: false, ts });
      } else if (block.type === "tool_use") {
        const toolId = this.str(block.id) ?? "";
        if (toolId && this.seenToolIds.has(toolId)) continue;
        if (toolId) this.seenToolIds.add(toolId);
        const tool = this.str(block.name) ?? "unknown";
        this.toolCalls += 1;
        this.emit({ kind: "tool_call", tool, input: block.input ?? null, toolId, ts });
        this.maybeFileChange(tool, block.input, ts);
      }
    }
  }

  /** Derive a file_change event from a write-tool call (Spec 02 §7.1 — not a claude event). */
  private maybeFileChange(tool: string, input: unknown, ts: number): void {
    if (!WRITE_TOOLS.has(tool)) return;
    const inp = (input ?? {}) as Record<string, unknown>;
    const path = this.str(inp.file_path) ?? this.str(inp.notebook_path);
    if (!path) return;
    const kind = tool === "Write" ? "add" : "update";
    this.emit({ kind: "file_change", paths: [{ path, kind }], ts });
  }

  private handleUser(obj: Record<string, unknown>): void {
    const ts = Date.now();
    const message = obj.message as Record<string, unknown> | undefined;
    const content = message?.content;

    // Replayed nudge as a bare string (Spec 02 §4.4 ack).
    if (typeof content === "string") {
      this.emitUserEcho(content, ts);
      return;
    }
    if (!Array.isArray(content)) {
      this.emit({ kind: "unknown", raw: obj, ts });
      return;
    }

    const toolResults = content.filter(
      (b) => (b as Record<string, unknown>)?.type === "tool_result",
    );
    if (toolResults.length > 0) {
      for (const raw of toolResults) {
        const b = raw as Record<string, unknown>;
        this.emit({
          kind: "tool_result",
          toolId: this.str(b.tool_use_id) ?? "",
          isError: b.is_error === true,
          ts,
        });
      }
      // A tool batch resolved → the next assistant line opens a new turn.
      this.expectTurnStart = true;
      return;
    }

    // Otherwise this is a replayed user input (our nudge) carrying text blocks.
    const text = content
      .map((b) => (b as Record<string, unknown>)?.type === "text" ? this.str((b as Record<string, unknown>).text) ?? "" : "")
      .join("");
    this.emitUserEcho(text, ts);
  }

  private emitUserEcho(text: string, ts: number): void {
    this.emit({ kind: "user_echo", text, ts });
    this.matchNudgeEcho(text);
  }

  private handleStreamEvent(obj: Record<string, unknown>): void {
    const ts = Date.now();
    const event = obj.event as Record<string, unknown> | undefined;
    const delta = event?.delta as Record<string, unknown> | undefined;
    if (delta?.type === "text_delta") {
      this.emit({ kind: "assistant_text", text: this.str(delta.text) ?? "", partial: true, ts });
      return;
    }
    this.emit({ kind: "unknown", raw: obj, ts });
  }

  private handleResult(obj: Record<string, unknown>): void {
    const ts = Date.now();
    const subtype = this.str(obj.subtype) ?? "unknown";
    const isError = obj.is_error === true || subtype !== "success";

    // Authoritative cumulative counters from the result line (Spec 02 §7.3).
    if (typeof obj.num_turns === "number") this.turns = obj.num_turns;
    if (typeof obj.total_cost_usd === "number") this.usd = obj.total_cost_usd;
    const usage = this.mapUsage(obj.usage);
    // Prefer the streamed per-turn sum; fall back to result.usage if we never saw any.
    if (usage && !this.tokensFromStream) this.tokens = usage;

    // Failure taxonomy (issue #17): name WHY this errored so the dispatcher can respond per
    // class instead of blind-retrying an expired login or hammering a rate limit.
    const errors = Array.isArray(obj.errors) ? obj.errors.join(" ") : "";
    const errorClass = !isError
      ? undefined
      : subtype === "error_wall_clock_cap"
        ? ("timeout" as const)
        : this.isRateLimitResult(obj, subtype)
          ? ("rate_limit" as const)
          : (classifyHarnessFailure(`${errors}\n${this.stderrRing.tail()}`) ?? ("crash" as const));

    this.emit({
      kind: "finished",
      status: isError ? "error" : "success",
      subtype,
      structuredOutput: obj.structured_output ?? null,
      usage: { ...this.tokens },
      errorClass,
      ts,
    });
    this.finished = true;
    this.stopWatchdog();
    this.closeChildStdin();

    // success → handed to GATE (review); error subtypes → failed (Spec 02 §7.1 table).
    if (this.isTerminal()) {
      // abort already won the race; keep that terminal state.
    } else if (subtype === "success") {
      this.setState("review");
    } else {
      this.setState("failed");
    }

    this.failPendingNudges();
  }

  private closeChildStdin(): void {
    const child = this.child;
    if (!child) return;
    const sink = child.stdin as { end?: () => void; close?: () => void } | undefined;
    try {
      sink?.end?.();
      sink?.close?.();
    } catch (err) {
      this.log.debug("stdin close after result failed", { err: String(err) });
    }
  }

  /** Rate-limit detection off the result shape — feeds the finished event's errorClass. */
  private isRateLimitResult(obj: Record<string, unknown>, subtype: string): boolean {
    const status = typeof obj.api_error_status === "number" ? obj.api_error_status : undefined;
    const errors = Array.isArray(obj.errors) ? obj.errors.join(" ").toLowerCase() : "";
    return (
      status === 429 ||
      /rate.?limit|too many requests|overloaded|quota/.test(errors) ||
      (subtype === "error_during_execution" && /rate.?limit|overload/.test(errors))
    );
  }

  // ===========================================================================
  // internal — stdin channel + nudge bookkeeping
  // ===========================================================================

  private writeUserLine(content: string): void {
    const line =
      JSON.stringify({
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
      }) + "\n";

    if (this.stdinBridgePath) {
      try {
        appendFileSync(this.stdinBridgePath, line);
      } catch (err) {
        this.log.debug("stdin bridge write failed", { err: String(err) });
      }
    }

    const child = this.child;
    if (!child) return;
    const sink = child.stdin;
    if (!sink || typeof (sink as { write?: unknown }).write !== "function") return;
    const fileSink = sink as { write: (s: string) => void; flush?: () => void };
    try {
      fileSink.write(line);
      fileSink.flush?.();
    } catch (err) {
      this.log.debug("stdin pipe write failed after bridge write (continuing)", {
        err: String(err),
      });
    }
  }

  private prepareStdinBridge(spec: SpawnSpec): void {
    // Bun 1.3.x can fail live subprocess stdin writes in some sandboxes with
    // `EPERM: send`. The fake harness reads this bridge when present, while real
    // claude ignores the env var and continues using the stdin pipe above.
    const bin = this.config.harness.claude.bin;
    const fakeHarness =
      process.env.BECKETT_FAKE_SPEED !== undefined ||
      process.env.BECKETT_FAKE_SCENARIO !== undefined ||
      /fake-(claude|harness)/.test(bin);
    if (!fakeHarness) {
      this.stdinBridgePath = null;
      return;
    }
    const path = join(spec.workspace, ".beckett", `stdin-${this.sessionId ?? "session"}.ndjson`);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "");
      this.stdinBridgePath = path;
    } catch (err) {
      this.stdinBridgePath = null;
      this.log.debug("stdin bridge unavailable", { err: String(err) });
    }
  }

  private flushBufferedNudges(): void {
    if (this.bufferedNudges.length === 0) return;
    const pending = this.bufferedNudges.splice(0, this.bufferedNudges.length);
    for (const msg of pending) this.writeUserLine(msg);
    this.log.info("flushed buffered nudges", { count: pending.length });
  }

  /**
   * Steering buffered while paused/dead that no resume ever replayed (issue #22) — v3 never
   * calls resume() on a finished claude worker, so without this drain those words vanish.
   */
  drainUnappliedNudges(): string[] {
    return this.bufferedNudges.splice(0, this.bufferedNudges.length);
  }

  private matchNudgeEcho(text: string): void {
    if (this.pendingNudges.length === 0) return;
    // S1: an EXACT echo across all pending wins first; a substring/loose match must NOT let a
    // later exact match be acked early (two pending "stop"/"stop now" → "stop now" must ack
    // "stop now", not "stop"). claude replays nudges in FIFO order, so when no pending text is
    // an exact match (e.g. the echo was reformatted) we fall back to the OLDEST pending nudge.
    let idx = this.pendingNudges.findIndex((p) => p.text === text);
    if (idx < 0) idx = 0; // FIFO-oldest fallback
    const p = this.pendingNudges.splice(idx, 1)[0];
    if (!p) return;
    clearTimeout(p.timer);
    p.resolve({ accepted: "delivered", at: Date.now() });
    if (this.pendingNudges.length === 0 && this.workerState === "nudging") {
      this.setState("running");
    }
  }

  private failPendingNudges(): void {
    if (this.pendingNudges.length === 0) return;
    const pending = this.pendingNudges.splice(0, this.pendingNudges.length);
    for (const p of pending) {
      clearTimeout(p.timer);
      p.resolve({ accepted: "queued", at: Date.now() });
    }
  }

  /** Map claude's `usage` block → the shared {@link TokenUsage} shape (field-map in base). */
  private mapUsage(raw: unknown): TokenUsage | null {
    return this.mapTokenUsage(raw, {
      input: "input_tokens",
      output: "output_tokens",
      cacheRead: "cache_read_input_tokens",
      cacheCreate: "cache_creation_input_tokens",
    });
  }
}
