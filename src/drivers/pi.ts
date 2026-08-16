/**
 * Beckett — PiDriver (`src/drivers/pi.ts`)
 * =======================================================================================
 * The concrete {@link HarnessDriver} for `pi` (pi.dev / earendil-works) run as a one-shot
 * worker. Pi is Beckett's malleable, provider-agnostic coding agent and the REPLACEMENT for
 * codex as the non-claude worker: same {@link HarnessDriver} surface, so the dispatcher casts
 * `harness:"pi"` interchangeably with `claude`. Unlike codex it has NO network sandbox to
 * fight — its containment here is the same as every worker's: it runs inside the ticket's own
 * project repo (`~/Projects/<slug>`), which is the only thing it should touch.
 *
 * All process lifecycle (spawn scaffold, watchdog, exit handling, pumps, buffered-nudge
 * steering) lives in {@link OneShotDriver} / {@link BaseDriver} (issue #19); this file is ONLY
 * the pi-specific surface: preflight, argv construction, and `--mode json` NDJSON parsing.
 *
 * Mechanism (verified against `pi` 0.80.x, `--mode json` NDJSON stream):
 *
 *   # first launch — caller-mint the session id so Beckett's ledger knows it before handshake:
 *   pi -p --mode json --provider <p> --model <m> --thinking <lvl> \
 *      --session-id <uuid> --append-system-prompt <systemAppend> "<prompt>"
 *   # resume — pin the captured id so pi reloads the persisted transcript in the same cwd:
 *   pi -p --mode json --provider <p> --model <m> --thinking <lvl> --session <id> "<prompt>"
 *
 * The `<m>` model runs through codex (0.144) on the ChatGPT-account OAuth (`openai-codex`
 * provider). The default is `gpt-5.6-terra` (config.harness.pi.default_model); a cast may pin an
 * explicit model — `gpt-5.6-luna` is the cheap/mechanical lane. SOL and bare `gpt-5.6` are NOT
 * usable on this tier ("not supported with a ChatGPT account"), so don't cast them.
 *
 * - cwd = the project repo (pi is rooted to the process cwd — there is no `-C`), set on spawn.
 * - `--mode json` emits a JSON Lines stream. The events we normalize (Spec 02 §7):
 *     `session`               → the session id (first line)   → session_started + resolves spawn
 *     `turn_start`            → a model turn began            → turn_started
 *     `tool_execution_start`  → a tool is running (name+args) → tool_call
 *     `tool_execution_end`    → tool finished (isError)       → tool_result (+ file_change for edits)
 *     `message_end`(assistant)→ a completed assistant message → assistant_text (final answer capture)
 *     `turn_end`              → turn done (carries usage+cost)→ turn_completed
 *     `agent_end`             → the run is complete           → finished (success)
 *   The parser is tolerant by contract: an unknown `type`, unknown tool, or malformed line
 *   becomes `kind:'unknown'` and NEVER throws.
 * - `pi -p` is STRICTLY ONE-SHOT: prompt in → run → exit. Steering buffers and applies via a
 *   relaunch-with-`--session` after the current run (see {@link OneShotDriver}).
 * - session id = Beckett mints the id and passes `--session-id` on the first launch. The preflight
 *   requires that flag and pi >=0.78 so a stale 0.72.x install fails loudly before dispatch instead
 *   of dying after spawn with `Error: Unknown option: --session-id` (OPS-56 / issue #12).
 * - Done-signal: pi has no `--output-schema`, so the structured done-signal is parsed leniently
 *   from the final assistant message (raw JSON, a ```json fence, or a trailing object).
 *
 * Auth (Spec 00 §4): subscription/OAuth only — the child env strips API keys (src/env.ts) so pi
 * uses the `~/.pi/agent/auth.json` login (the ChatGPT/Codex OAuth via the `openai-codex`
 * provider). The child PATH is prefixed with `~/.local/bin` + `~/.bun/bin` so `pi` resolves AND
 * runs under the modern node there (the current Pi package needs node >=22.19.0).
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { Config, HarnessDriver, Logger, SpawnResult, SpawnSpec, TokenUsage } from "../types.ts";
import { childEnv } from "../env.ts";
import { OneShotDriver } from "./base.ts";
import { classifyHarnessFailure } from "./failure.ts";
import { probeCommand } from "./preflight-probe.ts";

/** pi tool names that mutate files → we synthesize a file_change from their args.path. */
const EDIT_TOOL_NAMES = new Set(["write", "edit", "multiedit", "multi_edit", "apply_patch"]);

/**
 * Escalating budgets (ms) for a `pi --version` probe: a first try that survives ordinary machine
 * load, then a roomier retry if that one is KILLED. The old flat 10s died under two heavy workers
 * (`pi --version` runs in ~0.9s idle) and — because `Bun.spawnSync` reports a timeout kill as
 * `exitCode: null` — that transient starvation was misread as a broken pi and silently downgraded
 * the cast to another harness (issue #54). 30s clears the load spike; the 60s retry is the backstop.
 */
const PREFLIGHT_BUDGETS_MS = [30_000, 60_000] as const;
/** Single-shot budget for the secondary probes (`node --version`, `pi --help`) — no retry needed. */
const PREFLIGHT_TIMEOUT_MS = 30_000;
/** Minimum pi CLI version with the `--session-id` create-if-missing contract. */
const MIN_PI_VERSION = "0.78.0";
/** CLI flags the driver's invocation depends on — their absence signals version/protocol drift. */
const REQUIRED_PI_FLAGS = [
  "--mode",
  "--session",
  "--session-id",
  "--print",
  "--no-extensions",
  "--no-skills",
  "--no-themes",
] as const;

/**
 * The PATH a pi child runs under: prefix `~/.local/bin` & `~/.bun/bin` so `pi` both RESOLVES and
 * RUNS under the modern node there (the current Pi package needs node >=22.19.0). Shared by the
 * live child env and the {@link piPreflight} probe so preflight tests the SAME binary a spawn would.
 */
function piChildPath(base = process.env.PATH): string {
  const home = process.env.HOME ?? "";
  const extra = [join(home, ".local/bin"), join(home, ".bun/bin")].join(":");
  return base ? `${extra}:${base}` : extra;
}

/** The verdict of a {@link piPreflight} run: is the pi harness usable, and if not, why. */
export interface PiPreflight {
  ok: boolean;
  bin: string;
  nodeVersion: string | null;
  version: string | null;
  problems: string[];
}

/**
 * Fast, offline health check for the pi harness — run at dispatch so a broken pi surfaces LOUDLY
 * and immediately instead of silently killing whatever ticket happened to be cast to it (OPS-56).
 * Three cheap local probes, no network:
 *   1. the binary resolves and runs (`pi --version`);
 *   2. the CLI still advertises the flags the driver invokes (`--mode`, `--session`, `--print`) —
 *      catches the exact version/protocol drift that took pi down (the `--session-id` removal);
 *   3. a pi login exists (`~/.pi/agent/auth.json`, non-empty) — subscription/OAuth auth is present.
 */
export async function piPreflight(config: Config): Promise<PiPreflight> {
  const bin = config.harness.pi.bin;
  const problems: string[] = [];
  const env = childEnv({ PATH: piChildPath() });

  let nodeVersion: string | null = null;
  try {
    const n = Bun.spawnSync({ cmd: ["node", "--version"], env, stdout: "pipe", stderr: "pipe", timeout: PREFLIGHT_TIMEOUT_MS });
    const raw = `${n.stdout.toString()}\n${n.stderr.toString()}`.trim();
    nodeVersion = raw.split("\n").map((l) => l.trim()).find(Boolean) ?? null;
    if (!n.success || !nodeVersion || !semverGte(nodeVersion, "22.19.0")) {
      problems.push(
        `daemon PATH resolves node ${nodeVersion ?? "unknown"}; pi needs node >=22.19.0. ` +
          `Put a modern node before /usr/bin in the daemon PATH.`,
      );
    }
  } catch (err) {
    problems.push(`could not run node from the daemon PATH (${(err as Error).message}).`);
  }

  // 1 — binary resolves + reports a version. probeCommand draws the KILL vs FAIL line the old code
  // erased: a timed-out probe (exitCode null) retries at a longer budget and, if it still can't
  // answer, surfaces as an explicit TIMEOUT — never as a bare "exited null" that reads like a broken
  // pi and silently downgrades the cast (issue #54).
  let version: string | null = null;
  const probe = probeCommand([bin, "--version"], env, { budgets: PREFLIGHT_BUDGETS_MS });
  if (probe.spawnError) {
    problems.push(
      `pi binary "${bin}" is not runnable on PATH (${probe.spawnError.message}). ` +
        `Install pi or fix config.harness.pi.bin.`,
    );
  } else if (probe.ok) {
    // pi prints its version to stderr; fall back across both streams.
    const raw = `${probe.stdout}\n${probe.stderr}`.trim();
    version = raw.split("\n").map((l) => l.trim()).find(Boolean) || null;
    if (!semverGte(version, MIN_PI_VERSION)) {
      problems.push(`installed pi ${version} is too old; need >=${MIN_PI_VERSION} for --session-id.`);
    }
  } else if (probe.timedOut) {
    // KILLED, not failed: the probe never got to answer. Say TIMED OUT explicitly so the dispatcher's
    // substitution comment blames machine load, not a broken/unauthenticated pi — and so this stops
    // poisoning the "pi is genuinely down" diagnosis it used to mimic.
    problems.push(
      `\`${bin} --version\` TIMED OUT — killed by ${probe.signalCode ?? "signal"} after ${probe.attempts} ` +
        `attempt(s), the last with a ${probe.budgetMs / 1000}s budget. pi was NOT confirmed broken; ` +
        `the probe was starved (likely heavy concurrent load). Retry when the box is quieter or raise the budget.`,
    );
  } else {
    // A real, self-chosen non-zero exit: pi ran and rejected the invocation. This one IS a fault.
    problems.push(`\`${bin} --version\` exited ${probe.exitCode}: ${probe.stderr.trim() || "(no output)"}`);
  }

  // 2 — CLI/protocol drift: confirm the flags the driver emits still exist. A KILLED --help probe
  // (timeout under load) is silently tolerated — the same load already surfaced on the --version
  // probe in (1), and a flag-drift verdict can't be trusted off a probe that never printed.
  const h = probeCommand([bin, "--help"], env, { budgets: PREFLIGHT_BUDGETS_MS });
  const help = `${h.stdout}\n${h.stderr}`;
  if (h.spawnError || h.timedOut) {
    /* a --help spawn failure / timeout is already implied by the --version probe in (1) */
  } else if (!h.ok) {
    problems.push(`\`${bin} --help\` exited ${h.exitCode}: ${h.stderr.trim() || "(no output)"}`);
  } else if (help.trim()) {
    const missing = REQUIRED_PI_FLAGS.filter((f) => !help.includes(f));
    if (missing.length) {
      problems.push(
        `installed pi (${version ?? "unknown version"}) no longer advertises ${missing.join(", ")} — ` +
          `CLI/protocol drift; the PiDriver invocation needs updating.`,
      );
    }
  }

  // 3 — pi login present AND structurally usable (subscription/OAuth; the child strips API keys
  // and relies on this). The old check was a substring test for the provider name over the whole
  // file, which passes for a provider entry that exists but carries no usable credential — the
  // exact state behind the `No API key for provider: openai-codex` no-op runs (#159): preflight
  // said healthy, the child launched, and turn one died with 0 tokens and 0 tool calls.
  const authPath = join(process.env.HOME ?? "", ".pi/agent/auth.json");
  try {
    const f = Bun.file(authPath);
    if (!(await f.exists()) || f.size === 0) {
      problems.push(`no pi login at ${authPath} — run \`pi\` once to sign in (subscription/OAuth).`);
    } else {
      problems.push(...authProblems(await f.text(), config.harness.pi.default_provider, authPath));
    }
  } catch (err) {
    problems.push(`could not read pi login at ${authPath} (${(err as Error).message}).`);
  }

  return { ok: problems.length === 0, bin, nodeVersion, version, problems };
}

/**
 * Inspect `~/.pi/agent/auth.json` for the provider the driver will actually use and report what is
 * structurally wrong with it — the checks that would have caught a dead login BEFORE spawning a
 * child that dies on turn one (#159).
 *
 * Deliberately narrow, because a false positive benches the whole harness:
 *  - the provider entry must exist and carry a non-empty credential (`access` / `key` / `token`);
 *  - an entry whose `expires` has PASSED is only fatal when it has no `refresh` token — pi renews
 *    an expired access token from the refresh token on its own, so expiry alone proves nothing.
 * Anything we can't parse falls back to the historical substring test rather than inventing a
 * problem: an auth.json in a shape we don't recognize is pi's business, not a reason to bench it.
 */
function authProblems(raw: string, provider: string | undefined, authPath: string): string[] {
  if (!provider) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Unparseable (or a future format): keep the old, weaker signal rather than guessing.
    return raw.includes(provider) ? [] : [`pi login at ${authPath} does not include provider ${provider}.`];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [`pi login at ${authPath} is not a credential object — run \`pi\` once to sign in.`];
  }
  const entry = (parsed as Record<string, unknown>)[provider];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return [
      `pi login at ${authPath} has no credential for provider ${provider} — run \`pi\` once to ` +
        `sign in. (A pi run against a missing provider dies on its first turn with ` +
        `"No API key for provider: ${provider}" and no tool calls.)`,
    ];
  }
  const rec = entry as Record<string, unknown>;
  const nonEmpty = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;
  if (!nonEmpty(rec.access) && !nonEmpty(rec.key) && !nonEmpty(rec.token)) {
    return [
      `pi login at ${authPath} has an EMPTY credential for provider ${provider} — run \`pi\` once ` +
        `to sign in.`,
    ];
  }
  if (typeof rec.expires === "number" && Number.isFinite(rec.expires) && rec.expires <= Date.now() && !nonEmpty(rec.refresh)) {
    return [
      `pi's ${provider} token expired at ${new Date(rec.expires).toISOString()} and there is no ` +
        `refresh token to renew it — run \`pi\` once to sign in again.`,
    ];
  }
  return [];
}

function semverGte(raw: string | null, min: string): boolean {
  if (!raw) return false;
  const parse = (v: string): [number, number, number] => {
    const m = v.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  };
  const a = parse(raw);
  const b = parse(min);
  for (let i = 0; i < 3; i++) {
    if (a[i]! > b[i]!) return true;
    if (a[i]! < b[i]!) return false;
  }
  return true;
}

export class PiDriver extends OneShotDriver implements HarnessDriver {
  readonly kind = "pi-cli-stream" as const;

  // ── pi-specific parse state ─────────────────────────────────────────────────
  /** The text of the most recent completed assistant message — the candidate done-signal. */
  private lastAgentMessage = "";
  /**
   * The provider error carried on the LAST assistant message (`stopReason:"error"`), or null if
   * the run's most recent assistant turn completed normally. pi still emits a clean `agent_end`
   * after a dead-on-arrival turn (e.g. "No API key for provider: openai-codex"), so without this
   * an unauthenticated run would finish as an instant empty "success" and the dispatcher would
   * happily advance the ticket on nothing.
   */
  private runError: string | null = null;
  /** tool call ids already counted (dedup) + their names (so an edit tool → file_change). */
  private readonly toolNames = new Map<string, string>();
  /** tool call id → its start `args` (pi carries args only on the start event, not the end). */
  private readonly toolArgs = new Map<string, unknown>();
  /** Accumulated real cost off `turn_end.message.usage.cost.total` (pi reports dollars). */
  private usd: number | null = null;

  constructor(config: Config, logger?: Logger) {
    super(config, logger, "driver.pi");
  }

  // ===========================================================================
  // BaseDriver hooks
  // ===========================================================================

  protected harnessName(): string {
    return "pi";
  }

  protected binName(): string {
    return this.config.harness.pi.bin;
  }

  protected usdEstimate(): number | null {
    return this.usd;
  }

  /** Child env: strip API keys (force OAuth login) + prefix ~/.local/bin & ~/.bun/bin onto PATH. */
  protected override buildChildEnv(): Record<string, string | undefined> {
    const env = childEnv();
    env.PATH = piChildPath(env.PATH);
    return env;
  }

  /**
   * A loud, actionable message for the #1 pi failure: the child dies before its `session`
   * handshake. Folds in the captured stderr tail (e.g. `Error: Unknown option: --session-id`)
   * so the real cause is visible instead of the opaque bare "exited before session line" (OPS-56).
   */
  protected override spawnFailureError(reason: string | number): Error {
    const tail = this.stderrRing.tail();
    const detail = tail ? ` pi stderr: ${JSON.stringify(tail)}.` : " pi printed nothing to stderr.";
    return new Error(
      `PiDriver: pi exited (${reason}) before emitting its session line — the harness never ` +
        `started.${detail} Common causes: a pi CLI/version drift (an unknown flag), a bad ` +
        `harness.pi.bin, or a missing/expired pi login (~/.pi/agent/auth.json). Run the pi preflight.`,
    );
  }

  /** pi reports crash exits as a transient-blocker done-signal so the dispatcher sees a reason. */
  protected override exitFinishStructuredOutput(message: string): unknown {
    return {
      done: false,
      summary: message,
      filesChanged: [],
      checksRun: [],
      blocker: {
        class: "transient",
        detail: message,
        remedy: "retry the run once the harness is healthy",
        defaultAnswer: null,
      },
    };
  }

  protected override launchLogFields(): Record<string, unknown> {
    return {
      provider: this.config.harness.pi.default_provider,
      model: this.resolvedModel() || "(pi default)",
      thinking: this.resolvedThinking(),
    };
  }

  protected buildResumeArgs(prompt: string): string[] {
    return this.buildArgs(prompt, /*isResume*/ true);
  }

  protected resetParseState(): void {
    this.lastAgentMessage = "";
    this.runError = null;
  }

  // ===========================================================================
  // spawn
  // ===========================================================================

  /** Launch the pi worker and resolve once the `session` line yields an id (spawning→running). */
  async spawn(spec: SpawnSpec): Promise<SpawnResult> {
    if (this.child) throw new Error("PiDriver: already spawned (one driver = one process)");
    this.spec = spec;
    // Preflight FIRST: a dead pi harness (missing binary, CLI drift, no login) must surface loudly
    // here — before we launch a child that would otherwise exit 1 before its session line and take
    // the ticket down silently (OPS-56).
    const pf = await piPreflight(this.config);
    if (!pf.ok) {
      this.log.error("pi preflight FAILED — harness unusable", {
        bin: pf.bin,
        nodeVersion: pf.nodeVersion,
        version: pf.version,
        problems: pf.problems,
      });
      throw new Error(`PiDriver preflight failed (pi harness unusable): ${pf.problems.join("; ")}`);
    }
    this.log.info("pi preflight ok", { bin: pf.bin, nodeVersion: pf.nodeVersion, version: pf.version });
    // Crash recovery (issue #20): a caller-persisted session id relaunches `--session <id>` so pi
    // reuses the persisted transcript instead of re-paying the whole ticket's exploration cost.
    const resume = spec.resumeSessionId?.trim();
    this.sessionId = resume || (spec.sessionId ?? randomUUID());
    const args = this.buildArgs(spec.prompt, /*isResume*/ Boolean(resume));
    return this.launch(args, { isResume: Boolean(resume) });
  }

  // ===========================================================================
  // argv construction
  // ===========================================================================

  private buildArgs(prompt: string, isResume: boolean): string[] {
    const pi = this.config.harness.pi;
    // Pin the worker environment: pi auto-discovers extensions/skills/themes from the ticket repo
    // AND the user dirs, so a stray install on the box would change worker behavior invisibly.
    // Context-file discovery (AGENTS.md/CLAUDE.md in the ticket repo) stays ON — that's desirable.
    const args: string[] = [
      "-p",
      "--mode",
      "json",
      "--no-extensions",
      "--no-skills",
      "--no-themes",
      "--provider",
      pi.default_provider,
    ];
    const model = this.resolvedModel();
    if (model) args.push("--model", model);
    args.push("--thinking", this.resolvedThinking());
    // Fresh runs use the modern create-if-missing flag. Resumes use the existing-session selector.
    if (this.sessionId) args.push(isResume ? "--session" : "--session-id", this.sessionId);
    // System prompt (scope + criteria + persona) only on the FIRST launch — the persisted session
    // already carries it on resume, and re-appending would duplicate it.
    if (!isResume && this.spec?.systemAppend?.trim()) {
      args.push("--append-system-prompt", this.spec.systemAppend.trim());
    }
    args.push(prompt);
    return args;
  }

  private resolvedModel(): string {
    return (this.spec?.model || this.config.harness.pi.default_model || "").trim();
  }

  /** pi `--thinking` reuses the resource envelope's effort (same low|medium|high|xhigh vocabulary). */
  private resolvedThinking(): string {
    return this.spec?.envelope.effort || this.config.harness.pi.thinking;
  }

  // ===========================================================================
  // NDJSON parsing (`--mode json`)
  // ===========================================================================

  /**
   * Parse one raw JSONL line and fan out normalized {@link WorkerEvent}s. Tolerant by contract:
   * a malformed line or unknown `type` becomes `kind:'unknown'` — never a throw.
   */
  // Public (widened from the protected abstract): pi.test.ts drives the parser through
  // `driver.handleLine(...)` directly. The shared parse/try-catch envelope lives in base.
  handleLine(line: string): void {
    this.normalizeLine(line, (obj) => this.dispatchFrame(obj));
  }

  /** Route one parsed `--mode json` frame by `type` (shared envelope in normalizeLine). */
  private dispatchFrame(obj: Record<string, unknown>): void {
    switch (obj.type) {
      case "session":
        this.handleSession(obj);
        break;
      case "turn_start":
        this.turns += 1;
        this.emit({ kind: "turn_started", ts: Date.now() });
        break;
      case "tool_execution_start":
        this.handleToolStart(obj);
        break;
      case "tool_execution_end":
        this.handleToolEnd(obj);
        break;
      case "message_end":
        this.handleMessageEnd(obj);
        break;
      case "turn_end":
        this.handleTurnEnd(obj);
        break;
      case "agent_end":
        this.handleAgentEnd();
        break;
      case "error":
        this.emit({ kind: "error", message: this.str(obj.message) ?? "error", ts: Date.now() });
        break;
      // High-frequency streaming / lifecycle chatter we deliberately DON'T surface: the per-token
      // `message_update` alone fires hundreds of times a turn, so routing these to `unknown` would
      // flood the event bus. Explicitly ignored (not unknown) — only a genuinely unrecognized
      // `type` falls through to `unknown`.
      case "agent_start":
      case "message_start":
      case "message_update":
      case "tool_execution_update":
      case "queue_update":
      case "compaction_start":
      case "compaction_end":
      case "auto_retry_start":
      case "auto_retry_end":
        break;
      default:
        this.emit({ kind: "unknown", raw: obj, ts: Date.now() });
    }
  }

  private handleSession(obj: Record<string, unknown>): void {
    // Shared handshake tail in base: capture id, emit session_started, clear spawn timer, resolve.
    const id = this.str(obj.id) ?? this.sessionId;
    this.emitSessionStarted(id, this.resolvedModel(), Date.now());
  }

  private handleToolStart(obj: Record<string, unknown>): void {
    const ts = Date.now();
    const id = this.str(obj.toolCallId) ?? `${this.toolCalls}`;
    const tool = this.str(obj.toolName) ?? "tool";
    if (!this.toolNames.has(id)) {
      this.toolNames.set(id, tool);
      this.toolCalls += 1;
    }
    this.toolArgs.set(id, obj.args ?? {});
    this.emit({ kind: "tool_call", tool, input: obj.args ?? {}, toolId: id, ts });
  }

  private handleToolEnd(obj: Record<string, unknown>): void {
    const ts = Date.now();
    const id = this.str(obj.toolCallId) ?? "";
    const isError = obj.isError === true;
    this.emit({ kind: "tool_result", toolId: id, isError, ts });
    // pi has no dedicated file_change event — synthesize one from a successful edit/write tool.
    // pi carries the tool args on the START event, so read them from what we stashed there.
    const tool = (this.str(obj.toolName) ?? this.toolNames.get(id) ?? "").toLowerCase();
    if (!isError && EDIT_TOOL_NAMES.has(tool)) {
      const args = this.toolArgs.get(id) as Record<string, unknown> | undefined;
      const path = this.str(args?.path) ?? this.str(args?.file_path);
      if (path) this.emit({ kind: "file_change", paths: [{ path, kind: "update" }], ts });
    }
    this.toolArgs.delete(id);
  }

  private handleMessageEnd(obj: Record<string, unknown>): void {
    const message = obj.message as Record<string, unknown> | undefined;
    if (!message || message.role !== "assistant") return;
    // Track the run's error state off the LATEST assistant message: a turn that ends with
    // `stopReason:"error"` (auth missing, provider down) arms it; any later successful turn
    // clears it, so a transient mid-run error that pi recovered from doesn't fail the run.
    if (message.stopReason === "error") {
      this.runError = this.str(message.errorMessage) ?? "pi provider error";
      this.emit({ kind: "error", message: this.runError, ts: Date.now() });
    } else {
      this.runError = null;
    }
    const text = this.textOf(message.content);
    if (text) {
      this.lastAgentMessage = text;
      this.emit({ kind: "assistant_text", text, partial: false, ts: Date.now() });
    }
  }

  private handleTurnEnd(obj: Record<string, unknown>): void {
    const message = obj.message as Record<string, unknown> | undefined;
    const usage = this.mapUsage(message?.usage);
    if (usage) {
      this.addTokens(usage);
      this.emit({ kind: "turn_completed", usage, ts: Date.now() });
    }
    // pi reports a REAL per-turn dollar cost (`usage.cost.total`) — accumulate it so
    // getTelemetry() surfaces actual spend instead of discarding it.
    const cost = (message?.usage as Record<string, unknown> | undefined)?.cost as
      | Record<string, unknown>
      | undefined;
    if (cost && typeof cost.total === "number" && Number.isFinite(cost.total)) {
      this.usd = (this.usd ?? 0) + cost.total;
    }
  }

  private handleAgentEnd(): void {
    const ts = Date.now();
    // Steering that arrived during this one-shot run couldn't interrupt it; apply it now by
    // resuming with the buffered instruction rather than finishing (mirrors codex).
    if (this.bufferedNudges.length > 0 && this.workerState !== "aborted") {
      this.log.info("agent_end with buffered steering — auto-resuming to apply it", {
        pending: this.bufferedNudges.length,
      });
      this.finished = true; // this process is done; resume() relaunches
      void this.resume().catch((err) => {
        this.log.error("auto-resume after steering failed", { err: String(err) });
        this.emit({
          kind: "finished",
          status: "error",
          subtype: "error_resume",
          structuredOutput: null,
          usage: { ...this.tokens },
          errorClass: classifyHarnessFailure(String(err)) ?? "crash",
          ts: Date.now(),
        });
        this.finished = true;
        this.stopWatchdog();
        if (!this.isTerminal()) this.setState("failed");
      });
      return;
    }

    // pi emits a clean `agent_end` even when the run's last turn DIED on a provider error (no
    // auth, provider down) — the run produced nothing, so surfacing it as success would advance
    // the ticket on an empty result. Fail it with the provider's own message instead.
    if (this.runError) {
      this.emit({
        kind: "finished",
        status: "error",
        subtype: "error_provider",
        structuredOutput: this.exitFinishStructuredOutput(this.runError),
        usage: { ...this.tokens },
        errorClass: classifyHarnessFailure(this.runError) ?? "crash",
        ts,
      });
      this.finished = true;
      this.stopWatchdog();
      if (!this.isTerminal()) this.setState("failed");
      void this.killChild();
      return;
    }

    // The no-op backstop (#159). pi exits 0 and emits a clean `agent_end` even when its provider
    // refused every turn, so "the harness never got to work" is otherwise indistinguishable from
    // "the worker finished". The `runError` guard above catches the shapes that name their error on
    // an assistant `message_end`; this catches the rest by OUTCOME rather than by error shape — a
    // run that reached the end having spent no tokens, called no tool, and said nothing did not
    // work, whatever it did or didn't report. Failing it here is what makes the dispatcher commit
    // WIP, class the failure, and substitute/retry instead of advancing the ticket on nothing.
    // The three conditions are ANDed on purpose: a legitimately terse run still spends tokens and
    // still produces assistant text, so it cannot trip this.
    const spent = this.tokens.input + this.tokens.output + this.tokens.cacheRead + this.tokens.cacheCreate;
    if (this.toolCalls === 0 && spent === 0 && !this.lastAgentMessage.trim()) {
      const tail = this.stderrRing.tail();
      const message =
        `pi finished without doing anything: ${this.turns} turn(s), 0 tool calls, 0 tokens, no ` +
        `assistant output. The harness launched but never worked — this is a LAUNCH FAILURE, not a ` +
        `completed run.${tail ? ` pi stderr: ${JSON.stringify(tail)}.` : " pi printed nothing to stderr."} ` +
        `Usual cause: the provider rejected turn one (quota/usage limit, expired login, model not ` +
        `available on this account).`;
      this.log.error("pi run did no work — failing it as a launch failure", {
        turns: this.turns,
        toolCalls: this.toolCalls,
        stderr: tail || null,
      });
      this.emit({ kind: "error", message, ts });
      this.emit({
        kind: "finished",
        status: "error",
        subtype: "error_noop",
        structuredOutput: this.exitFinishStructuredOutput(message),
        usage: { ...this.tokens },
        errorClass: classifyHarnessFailure(tail) ?? "crash",
        ts,
      });
      this.finished = true;
      this.stopWatchdog();
      if (!this.isTerminal()) this.setState("failed");
      void this.killChild();
      return;
    }

    // A completed run (no pending steering) IS success; the done-signal's own `done` drives the
    // dispatcher's pass/fail verdict downstream.
    this.emit({
      kind: "finished",
      status: "success",
      subtype: "success",
      structuredOutput: this.parseStructuredOutput(),
      usage: { ...this.tokens },
      ts,
    });
    this.finished = true;
    this.stopWatchdog();
    if (!this.isTerminal()) this.setState("review");
    // pi -p can linger after agent_end; free the slot deterministically.
    void this.killChild();
  }

  // ===========================================================================
  // pi-format helpers
  // ===========================================================================

  /** Concatenate the text blocks of a pi message `content` array. */
  private textOf(content: unknown): string {
    if (!Array.isArray(content)) return "";
    const parts: string[] = [];
    for (const raw of content) {
      const block = raw as Record<string, unknown>;
      if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
    }
    return parts.join("").trim();
  }

  /**
   * Lenient parse of the final assistant message as the structured done-signal. pi has no
   * output-schema enforcement, so the worker's JSON may be raw, fenced in ```json, or trail some
   * prose. Try each shape; return null when nothing parses (the dispatcher then falls back to the
   * summary text).
   */
  private parseStructuredOutput(): unknown | null {
    const text = this.lastAgentMessage.trim();
    if (!text) return null;
    // 1. whole message is JSON
    try {
      return JSON.parse(text);
    } catch {
      /* fall through */
    }
    // 2. a ```json … ``` fenced block
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence?.[1]) {
      try {
        return JSON.parse(fence[1].trim());
      } catch {
        /* fall through */
      }
    }
    // 3. the last balanced {...} object in the text
    const lastOpen = text.lastIndexOf("{");
    const lastClose = text.lastIndexOf("}");
    if (lastOpen >= 0 && lastClose > lastOpen) {
      try {
        return JSON.parse(text.slice(lastOpen, lastClose + 1));
      } catch {
        /* give up */
      }
    }
    return null;
  }

  /** Map pi's `usage` block → the shared {@link TokenUsage} shape (field-map in base). */
  private mapUsage(raw: unknown): TokenUsage | null {
    return this.mapTokenUsage(raw, {
      input: "input",
      output: "output",
      cacheRead: "cacheRead",
      cacheCreate: "cacheWrite",
    });
  }
}
