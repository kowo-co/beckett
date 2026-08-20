/**
 * Beckett — CursorDriver (`src/drivers/cursor.ts`)
 * =======================================================================================
 * The concrete {@link HarnessDriver} for the Cursor seat: an IMPLEMENTER-ONLY worker that runs
 * Cursor's agent loop in local mode against the run's own worktree.
 *
 * ## Its one job, and the one thing it must never do
 *
 * Cursor implements. It never reviews. That is not a convention here — the registry row carries
 * `reviewCapable: false` and `../run/cast.ts#validateCasting` refuses a `review` cast naming a
 * harness without it, at deploy time, before a run exists. This driver is the implementer half of
 * that arrangement; nothing in it knows how to judge someone else's diff.
 *
 * ## Shape
 *
 * Unlike claude/codex/pi there is no `cursor` binary to wrap — local mode ships as a library. So
 * this driver spawns `bun src/drivers/cursor-runner.ts`, a shim that owns the SDK and re-emits its
 * stream as NDJSON in the shared frame vocabulary (`./cursor-protocol.ts`). Everything else —
 * process-group kill, the wall-clock backstop, stall detection, token accounting — is
 * {@link OneShotDriver} / {@link BaseDriver}, untouched. The parser below is the ordinary
 * ~150-line `type` switch, because the shim did the translating.
 *
 * ## Quota is a normal Tuesday, not an incident
 *
 * The Pro tier is $20/month. Running out is routine control flow, so it gets a first-class exit:
 * the shim commits what's on disk, resets any tick it can't vouch for, writes
 * `.beckett/cursor-handoff.md`, and emits a `quota` frame. This driver turns that into a terminal
 * `finished` carrying `errorClass: "quota"` — deliberately DISTINCT from `rate_limit`, so
 * `../run/supervisor.ts` can tell "the month is spent, change seats" from "the API is busy, back
 * off" and route the two completely differently.
 *
 * ## Auth
 *
 * `CURSOR_API_KEY`, by env inheritance only, and only to this driver's children:
 * {@link buildChildEnv} re-injects it on top of the `CURSOR_`-stripped baseline that every OTHER
 * harness child now gets (`../env.ts`). It never reaches argv, a log line, or a transcript.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Config, HarnessDriver, Logger, SpawnResult, SpawnSpec } from "../types.ts";
import modelRates from "../../config/model-rates.json";
import { childEnv } from "../env.ts";
import { OneShotDriver, type Child } from "./base.ts";
import { classifyHarnessFailure } from "./failure.ts";
import { CURSOR_AUTO_MODEL } from "./cursor-model.ts";
import { CURSOR_HANDOFF_REL } from "./cursor-handoff.ts";

/**
 * The verdict of a {@link cursorPreflight} run. Declared locally rather than imported from
 * `./index.ts` (which imports THIS module) so the two never form an import cycle, matching
 * `./pi.ts`'s `PiPreflight`. Structurally the registry's `PreflightResult`.
 */
interface CursorPreflight {
  ok: boolean;
  problems: string[];
}

/** Absolute path of the shim this driver spawns. Resolved off this module so a move can't drift. */
const CURSOR_RUNNER_PATH = join(import.meta.dir, "cursor-runner.ts");

/** The env var carrying the Cursor credential. Named once; never formatted anywhere. */
export const CURSOR_API_KEY_ENV = "CURSOR_API_KEY";

/**
 * Fast, offline health check for the cursor seat — run at cast time so a missing credential
 * substitutes a healthy harness instead of burning a worker start.
 *
 * Deliberately NO network call, unlike the temptation to probe `/v1/models`: preflight runs on the
 * spawn path (cached ~5 min) and a network round-trip there would make every cast wait on Cursor's
 * availability. The three things checked are the three that actually break: the credential, the
 * shim, and the SDK package. Quota is NOT checkable — Cursor publishes no remaining-allowance
 * endpoint, so we find the wall by hitting it, and `./cooldown.ts` remembers it afterwards.
 */
export async function cursorPreflight(config: Config): Promise<CursorPreflight> {
  const problems: string[] = [];

  if (!process.env[CURSOR_API_KEY_ENV]?.trim()) {
    problems.push(
      `no ${CURSOR_API_KEY_ENV} in the daemon environment — add it to ~/.beckett/.env ` +
        `(the cursor seat is unusable without it; runs fall back to claude).`,
    );
  }

  const runner = cursorRunnerPath(config);
  if (!existsSync(runner)) {
    problems.push(`the cursor shim is missing at ${runner} — this build cannot run the cursor seat.`);
  }

  // The SDK is a normal dependency, but it carries a per-platform optional package; a partial
  // install resolves the JS and dies at first use. Resolving here turns that into one clear
  // preflight problem instead of a mid-run crash.
  try {
    await import.meta.resolve("@cursor/sdk");
  } catch (err) {
    problems.push(`@cursor/sdk is not resolvable (${(err as Error).message}) — run \`bun install\`.`);
  }

  return { ok: problems.length === 0, problems };
}

/** The shim path, honouring a config override so a packaged install can relocate it. */
function cursorRunnerPath(config: Config): string {
  const configured = (config.harness as { cursor?: { runner?: string } }).cursor?.runner?.trim();
  return configured || CURSOR_RUNNER_PATH;
}

/** The `[harness.cursor]` block, read defensively — an older config file simply has none. */
function cursorConfig(config: Config): {
  bin: string;
  default_model: string;
  default_effort: string;
  runner?: string;
} {
  const block = (config.harness as { cursor?: Record<string, unknown> }).cursor ?? {};
  return {
    bin: typeof block.bin === "string" && block.bin.trim() ? block.bin : "bun",
    default_model:
      typeof block.default_model === "string" && block.default_model.trim()
        ? block.default_model
        : CURSOR_AUTO_MODEL,
    default_effort: typeof block.default_effort === "string" ? block.default_effort : "high",
    ...(typeof block.runner === "string" ? { runner: block.runner } : {}),
  };
}

/** Per-million-token rates for a Beckett model label, or null when the table doesn't price it. */
function rateFor(model: string): { input: number; output: number; cache_read: number; cache_write: number } | null {
  const table = modelRates.models as Record<string, { input: number; output: number; cache_read: number; cache_write: number }>;
  return table[model] ?? null;
}

export class CursorDriver extends OneShotDriver implements HarnessDriver {
  readonly kind = "cursor-sdk-local" as const;

  // ── cursor-specific parse state ─────────────────────────────────────────────
  /** The final (non-partial) assistant message — the candidate done-signal. */
  private lastAgentMessage = "";
  /** The prompt payload the next `afterLaunch` writes to the child's stdin. */
  private pendingPrompt: { prompt: string; systemAppend: string } | null = null;
  /** Tool call id → name, so a `tool_end` for an edit can be matched to a file_change. */
  private readonly toolNames = new Map<string, string>();
  /** Set when a `quota` frame arrived — the shim already committed and wrote the handoff. */
  private quota: { reason: string; status?: number; code?: string; checkpoint?: string } | null = null;
  /** The model label the shim actually resolved (`Auto Balance` / `Auto`), for logs and telemetry. */
  private resolvedLabel = "";

  constructor(config: Config, logger?: Logger) {
    super(config, logger, "driver.cursor");
  }

  // ===========================================================================
  // BaseDriver hooks
  // ===========================================================================

  protected harnessName(): string {
    return "cursor";
  }

  /** The shim runs under bun; `harness.cursor.bin` exists so an install can point at another one. */
  protected binName(): string {
    return cursorConfig(this.config).bin;
  }

  /** The shim takes its prompt on stdin, so it never appears in argv or `ps`. */
  protected override stdinMode(): "pipe" | "ignore" {
    return "pipe";
  }

  /**
   * The ONLY child in this tree that sees `CURSOR_API_KEY`. `../env.ts` strips the whole `CURSOR_`
   * prefix from every harness child now, so a claude/codex/pi worker cannot read a credential it
   * has no business holding; this re-injects it for the one process that needs it.
   */
  protected override buildChildEnv(): Record<string, string | undefined> {
    const env = childEnv();
    const key = process.env[CURSOR_API_KEY_ENV];
    if (key) env[CURSOR_API_KEY_ENV] = key;
    return env;
  }

  protected override afterLaunch(_child: Child, _isResume: boolean): void {
    const payload = this.pendingPrompt;
    this.pendingPrompt = null;
    if (payload) this.writePromptPayload(payload);
  }

  protected override launchLogFields(): Record<string, unknown> {
    return { model: this.resolvedModel() };
  }

  protected override spawnFailureError(reason: string | number): Error {
    const tail = this.stderrRing.tail();
    const detail = tail ? ` shim stderr: ${JSON.stringify(tail)}.` : " the shim printed nothing to stderr.";
    return new Error(
      `CursorDriver: the cursor shim exited (${reason}) before emitting its session frame — the ` +
        `seat never started.${detail} Usual causes: a missing ${CURSOR_API_KEY_ENV}, an incomplete ` +
        `@cursor/sdk install (its per-platform optional package), or a bun that cannot run ` +
        `${cursorRunnerPath(this.config)}.`,
    );
  }

  /** A crashed cursor child reports a transient blocker so the supervisor sees a reason, not a void. */
  protected override exitFinishStructuredOutput(message: string): unknown {
    return {
      done: false,
      summary: message,
      filesChanged: [],
      checksRun: [],
      blocker: {
        class: "transient",
        detail: message,
        remedy: "retry the run once the cursor seat is healthy",
        defaultAnswer: null,
      },
    };
  }

  /**
   * Marginal dollars, priced from `config/model-rates.json`.
   *
   * Honest caveat, recorded here because the number is otherwise easy to over-trust: Cursor Pro is
   * a flat $20/month subscription, and this account's `GET /v1/agents/{id}/usage` answers
   * `feature_unavailable`, so there is no server-reported cost to reconcile against. What this
   * returns is an API-EQUIVALENT comparison figure (the rate row is flagged `estimate: true`),
   * computed the same way every other harness's row is, so a run that spent time on both seats
   * still sums to something meaningful. It is not money billed.
   */
  protected usdEstimate(): number | null {
    const rate = rateFor(this.resolvedModel());
    if (!rate) return null;
    const perM = (tokens: number, usd: number): number => (tokens / 1_000_000) * usd;
    return (
      perM(this.tokens.input, rate.input) +
      perM(this.tokens.output, rate.output) +
      perM(this.tokens.cacheRead, rate.cache_read) +
      perM(this.tokens.cacheCreate, rate.cache_write)
    );
  }

  protected buildResumeArgs(prompt: string): string[] {
    this.pendingPrompt = { prompt, systemAppend: "" };
    return this.buildArgs(/*isResume*/ true);
  }

  protected resetParseState(): void {
    this.lastAgentMessage = "";
    this.quota = null;
    this.toolNames.clear();
  }

  // ===========================================================================
  // spawn
  // ===========================================================================

  async spawn(spec: SpawnSpec): Promise<SpawnResult> {
    if (this.child) throw new Error("CursorDriver: already spawned (one driver = one process)");
    this.spec = spec;
    const pf = await cursorPreflight(this.config);
    if (!pf.ok) {
      this.log.error("cursor preflight FAILED — seat unusable", { problems: pf.problems });
      throw new Error(`CursorDriver preflight failed (cursor seat unusable): ${pf.problems.join("; ")}`);
    }
    // Beckett OWNS the agent id, minted before the child exists (`../dispatch/spawn.ts`), exactly
    // as it does for claude and pi. That is what makes crash recovery possible AND what lets the
    // shim emit its handshake before `Agent.create` can fail: a quota wall hit before the first
    // token then arrives as a terminal frame the supervisor can hand off from, not as a spawn
    // failure that parks the run without ever considering a seat change.
    const resume = spec.resumeSessionId?.trim();
    this.sessionId = resume || spec.sessionId || `agent-${crypto.randomUUID()}`;
    this.pendingPrompt = { prompt: spec.prompt, systemAppend: spec.systemAppend ?? "" };
    return this.launch(this.buildArgs(Boolean(resume)), { isResume: Boolean(resume) });
  }

  private buildArgs(isResume: boolean): string[] {
    const args = [
      cursorRunnerPath(this.config),
      "--workspace",
      this.spec!.workspace,
      "--agent-id",
      this.sessionId!,
      "--model",
      this.resolvedModel(),
    ];
    if (isResume) args.push("--resume");
    return args;
  }

  private resolvedModel(): string {
    return (this.spec?.model || cursorConfig(this.config).default_model).trim();
  }

  /** One NDJSON line on the child's stdin, then EOF — the shim reads exactly one payload. */
  private writePromptPayload(payload: { prompt: string; systemAppend: string }): void {
    const sink = this.child?.stdin as
      | { write: (s: string) => void; flush?: () => void; end?: () => void }
      | undefined;
    if (!sink || typeof sink.write !== "function") return;
    try {
      sink.write(`${JSON.stringify(payload)}\n`);
      sink.flush?.();
      // EOF matters: the shim reads stdin to completion before it sends the first turn.
      sink.end?.();
    } catch (err) {
      this.log.error("could not write the prompt to the cursor shim", { err: String(err) });
    }
  }

  // ===========================================================================
  // Frame parsing (`./cursor-protocol.ts`)
  // ===========================================================================

  /** Public (widened from the protected abstract): `cursor.test.ts` drives the parser directly. */
  handleLine(line: string): void {
    this.normalizeLine(line, (obj) => this.dispatchFrame(obj));
  }

  private dispatchFrame(obj: Record<string, unknown>): void {
    switch (obj.type) {
      case "session":
        this.resolvedLabel = this.str(obj.model) ?? "";
        this.emitSessionStarted(this.str(obj.agentId) ?? this.sessionId, this.resolvedModel(), Date.now());
        break;
      case "turn_start":
        this.turns += 1;
        this.emit({ kind: "turn_started", ts: Date.now() });
        break;
      case "assistant":
        this.handleAssistant(obj);
        break;
      case "tool_start":
        this.handleToolStart(obj);
        break;
      case "tool_end":
        this.handleToolEnd(obj);
        break;
      case "usage":
        this.handleUsage(obj);
        break;
      case "result":
        this.handleResult(obj);
        break;
      case "quota":
        this.handleQuota(obj);
        break;
      case "error":
        this.emit({ kind: "error", message: this.str(obj.message) ?? "cursor error", ts: Date.now() });
        break;
      case "log":
        this.log.info(`cursor shim: ${this.str(obj.message) ?? ""}`, { level: this.str(obj.level) ?? "info" });
        break;
      default:
        this.emit({ kind: "unknown", raw: obj, ts: Date.now() });
    }
  }

  private handleAssistant(obj: Record<string, unknown>): void {
    const text = this.str(obj.text) ?? "";
    if (!text) return;
    const partial = obj.partial === true;
    if (!partial) this.lastAgentMessage = text;
    this.emit({ kind: "assistant_text", text, partial, ts: Date.now() });
  }

  private handleToolStart(obj: Record<string, unknown>): void {
    const id = this.str(obj.id) ?? `${this.toolCalls}`;
    const tool = this.str(obj.name) ?? "tool";
    if (!this.toolNames.has(id)) {
      this.toolNames.set(id, tool);
      this.toolCalls += 1;
    }
    this.emit({ kind: "tool_call", tool, input: obj.args ?? {}, toolId: id, ts: Date.now() });
  }

  private handleToolEnd(obj: Record<string, unknown>): void {
    const id = this.str(obj.id) ?? "";
    const isError = obj.isError === true;
    this.emit({ kind: "tool_result", toolId: id, isError, ts: Date.now() });
    // The shim already resolved which tools touch disk and which argument named the file, so a
    // `path` here IS a file change — no second guess about tool vocabulary on this side.
    const path = this.str(obj.path);
    if (path && !isError) this.emit({ kind: "file_change", paths: [{ path, kind: "update" }], ts: Date.now() });
    this.toolNames.delete(id);
  }

  private handleUsage(obj: Record<string, unknown>): void {
    const usage = this.mapTokenUsage(obj.usage, {
      input: "input",
      output: "output",
      cacheRead: "cacheRead",
      cacheCreate: "cacheWrite",
    });
    if (!usage) return;
    this.addTokens(usage);
    this.emit({ kind: "turn_completed", usage, ts: Date.now() });
  }

  /**
   * The seat ran out. By the time this frame arrives the shim has ALREADY committed whatever was
   * on disk, reset every tick it could not vouch for, and written the handoff file — so this path
   * only has to report, never to clean up.
   *
   * `errorClass: "quota"` is the whole point: `rate_limit` means "back off", `quota` means "the
   * month is spent, change seats", and the supervisor's fallback keys on the difference.
   */
  private handleQuota(obj: Record<string, unknown>): void {
    const ts = Date.now();
    this.quota = {
      reason: this.str(obj.reason) ?? "cursor quota exhausted",
      ...(typeof obj.status === "number" ? { status: obj.status } : {}),
      ...(this.str(obj.code) ? { code: this.str(obj.code)! } : {}),
      ...(this.str(obj.checkpoint) ? { checkpoint: this.str(obj.checkpoint)! } : {}),
    };
    const shape = [
      this.quota.status === undefined ? null : `HTTP ${this.quota.status}`,
      this.quota.code ? `code ${this.quota.code}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    const message =
      `the cursor seat is out of quota — ${this.quota.reason}` +
      `${shape ? ` (${shape})` : ""}. Everything on disk was committed` +
      `${this.quota.checkpoint ? ` as ${this.quota.checkpoint}` : ""} and the handoff for the next ` +
      `seat is at ${CURSOR_HANDOFF_REL}.`;
    this.log.warn("cursor quota exhausted — handing this run over", {
      status: this.quota.status ?? null,
      code: this.quota.code ?? null,
      checkpoint: this.quota.checkpoint ?? null,
    });
    this.emit({ kind: "error", message, ts });
    this.emit({
      kind: "finished",
      status: "error",
      subtype: "error_quota",
      structuredOutput: this.exitFinishStructuredOutput(message),
      usage: { ...this.tokens },
      errorClass: "quota",
      ts,
    });
    this.finishTerminal();
  }

  private handleResult(obj: Record<string, unknown>): void {
    const ts = Date.now();
    const status = this.str(obj.status) ?? "error";
    const text = this.str(obj.text) ?? "";
    if (text && !this.lastAgentMessage) this.lastAgentMessage = text;

    // Steering that arrived during this one-shot run couldn't interrupt it; apply it now by
    // resuming with the buffered instruction rather than finishing (mirrors pi/codex).
    if (status === "finished" && this.bufferedNudges.length > 0 && this.workerState !== "aborted") {
      this.log.info("cursor run ended with buffered steering — auto-resuming to apply it", {
        pending: this.bufferedNudges.length,
      });
      this.latch("turn-boundary");
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
        this.finishTerminal();
      });
      return;
    }

    if (status !== "finished") {
      this.emit({
        kind: "finished",
        status: "error",
        subtype: status === "cancelled" ? "error_cancelled" : "error_run",
        structuredOutput: this.exitFinishStructuredOutput(text || `cursor run ended: ${status}`),
        usage: { ...this.tokens },
        errorClass: classifyHarnessFailure(text) ?? "crash",
        ts,
      });
      this.finishTerminal();
      return;
    }

    // The no-op backstop, same posture as `./pi.ts`: a seat that reached the end having spent no
    // tokens, called no tool and said nothing did NOT work, whatever it reported. Failing it here
    // is what makes the supervisor commit WIP and re-staff instead of advancing on nothing.
    const spent = this.tokens.input + this.tokens.output + this.tokens.cacheRead + this.tokens.cacheCreate;
    if (this.toolCalls === 0 && spent === 0 && !this.lastAgentMessage.trim()) {
      const tail = this.stderrRing.tail();
      const message =
        `the cursor seat finished without doing anything: ${this.turns} turn(s), 0 tool calls, ` +
        `0 tokens, no assistant output. The shim launched but never worked — this is a LAUNCH ` +
        `FAILURE, not a completed run.${tail ? ` shim stderr: ${JSON.stringify(tail)}.` : ""}`;
      this.log.error("cursor run did no work — failing it as a launch failure", { turns: this.turns });
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
      this.finishTerminal();
      return;
    }

    this.emit({
      kind: "finished",
      status: "success",
      subtype: "success",
      structuredOutput: this.parseStructuredOutput(),
      usage: { ...this.tokens },
      ts,
    });
    this.latch("terminal-event");
    this.stopWatchdog();
    if (!this.isTerminal()) this.setState("review");
    void this.killChild();
  }

  /** The shared tail of every terminal FAILURE path: latch, disarm, mark failed, reap the child. */
  private finishTerminal(): void {
    this.latch("terminal-event");
    this.stopWatchdog();
    if (!this.isTerminal()) this.setState("failed");
    void this.killChild();
  }

  /**
   * Lenient parse of the final assistant message as the structured done-signal. Cursor's SDK has
   * no `--json-schema` equivalent (claude's is a hard grammar constraint), so the shim asks for
   * the shape in prose and this reads it back the way `./pi.ts` does: raw JSON, a ```json fence,
   * or a trailing object. Verified 2026-08-19 against a live local-mode run — the model returned a
   * clean, unfenced object — but "usually clean" is not "constrained", so all three shapes are
   * tried and `null` (the dispatcher falls back to summary text) is a legitimate outcome.
   */
  private parseStructuredOutput(): unknown | null {
    const text = this.lastAgentMessage.trim();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      /* fall through */
    }
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence?.[1]) {
      try {
        return JSON.parse(fence[1].trim());
      } catch {
        /* fall through */
      }
    }
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
}
