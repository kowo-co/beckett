/**
 * Beckett — CodexDriver (`src/drivers/codex.ts`)
 * =======================================================================================
 * The concrete {@link HarnessDriver} for `codex exec` run as a one-shot worker (Spec 02 §5,
 * my-docs/codex-exec.md). One instance drives exactly one codex process inside one git
 * worktree, exposing the SAME interface as {@link ClaudeDriver} so the dispatcher can use
 * them interchangeably.
 *
 * All process lifecycle (spawn scaffold, watchdog, exit handling, pumps, buffered-nudge
 * steering) lives in {@link OneShotDriver} / {@link BaseDriver} (issue #19); this file is ONLY
 * the codex-specific surface: preflight, the price table, argv construction, and `--json`
 * thread/item event parsing.
 *
 * Mechanism (verified against the installed `codex` CLI; my-docs/codex-exec.md §1–§2):
 *
 *   codex exec --json --skip-git-repo-check \
 *     -s <sandbox_mode> -C <worktree> -m <model> \
 *     [-c approval_policy=<policy>] [-c sandbox_workspace_write.network_access=true] \
 *     [--output-schema <done-schema>] "<prompt>"
 *
 * - cwd = the worktree (codex is rooted to its scope there); `-C` is also passed for the
 *   versions that honor it on the exec surface.
 * - With `--json`, stdout is a JSON Lines stream of *thread events* (`thread.started`,
 *   `turn.started/completed/failed`) and *item events* (`item.started/updated/completed`
 *   wrapping `command_execution` / `file_change` / `agent_message` / `reasoning` /
 *   `mcp_tool_call` / `web_search` / `todo_list` / item-level `error`). The parser is tolerant
 *   by contract (Spec 02 §7.2): unknown `type`s and unknown `item.type`s route to
 *   `kind:'unknown'`; a malformed line never throws.
 * - `codex exec` is STRICTLY ONE-SHOT (my-docs/codex-exec.md §2): prompt in → one turn →
 *   process exits. Steering buffers and applies via a relaunch
 *   (`codex exec resume <thread_id> "<instruction>"`) after the current run — see
 *   {@link OneShotDriver}.
 * - session id = the `thread_id` from `thread.started` (codex does not accept a caller-minted
 *   id on exec — it is captured, not supplied). Surfaced as {@link SpawnResult} and a
 *   `session_started` event so the manager can persist it for `--resume`.
 *
 * Economics (Spec 00 §4): codex's JSONL carries token counts but NO dollar cost field, so
 * `usdEstimate` in telemetry is derived from a static $/Mtok price table keyed by the launch
 * model ({@link estimateUsd}); `null` when the model isn't priced (or was deferred to codex's
 * own config). Auth (Spec 00 §4): subscription only — the child env strips API keys/endpoint
 * overrides (src/env.ts) so `codex` always uses the `~/.codex` ChatGPT login.
 */

import type { Config, HarnessDriver, Logger, SpawnResult, SpawnSpec, TokenUsage } from "../types.ts";
import { join } from "node:path";
import { OneShotDriver } from "./base.ts";
import { classifyHarnessFailure } from "./failure.ts";
import { childEnv } from "../env.ts";
import { probeCommand } from "./preflight-probe.ts";

/** codex item `type`s that represent a tool invocation (counted once per item id). */
const TOOL_ITEM_TYPES = new Set(["command_execution", "mcp_tool_call", "web_search"]);

/**
 * Static $/Mtok price table (codex's JSONL has no cost field — my-docs/codex-exec.md §1.5 says
 * "a harness must apply its own price table"). Longest-prefix match on the LAUNCH model id (the
 * driver is the source of truth for codex models — Spec 02 §2). Published OpenAI API prices,
 * checked 2026-07; cached input is billed at the `cacheRead` rate. Unknown/blank model → null
 * (an honest "don't know", never a made-up number).
 */
const USD_PER_MTOK: [prefix: string, price: { input: number; cacheRead: number; output: number }][] = [
  ["gpt-5.5-codex", { input: 1.25, cacheRead: 0.125, output: 10 }],
  ["gpt-5.5", { input: 1.25, cacheRead: 0.125, output: 10 }],
  ["gpt-5-codex", { input: 1.25, cacheRead: 0.125, output: 10 }],
  ["gpt-5-mini", { input: 0.25, cacheRead: 0.025, output: 2 }],
  ["gpt-5-nano", { input: 0.05, cacheRead: 0.005, output: 0.4 }],
  ["gpt-5", { input: 1.25, cacheRead: 0.125, output: 10 }],
];

/**
 * Estimate cumulative spend for `model` from token counters; null when the model isn't priced.
 * `tokens.cacheRead` (codex `cached_input_tokens`) is a PORTION of `tokens.input` (§1.5), so the
 * cached share is billed at the cache rate and only the remainder at the full input rate.
 */
export function estimateUsd(model: string, tokens: TokenUsage): number | null {
  const m = model.trim().toLowerCase();
  if (!m) return null;
  const entry = USD_PER_MTOK.find(([prefix]) => m.startsWith(prefix));
  if (!entry) return null;
  const p = entry[1];
  const uncachedInput = Math.max(0, tokens.input - tokens.cacheRead);
  return (uncachedInput * p.input + tokens.cacheRead * p.cacheRead + tokens.output * p.output) / 1_000_000;
}

/**
 * Escalating preflight budgets (ms): a first try that survives machine load, then a roomier retry
 * if it is KILLED. The old flat 10s could time out under heavy concurrent workers, and — because
 * `Bun.spawnSync` reports a timeout kill as `exitCode: null` — that starvation read as a broken
 * codex rather than a slow box (issue #54). A wedged `--version` still can't stall forever.
 */
const PREFLIGHT_BUDGETS_MS = [30_000, 60_000] as const;

/**
 * Static "is codex usable right now?" check (issue #17): binary resolves and reports a version,
 * and the ChatGPT subscription login exists at `~/.codex/auth.json` (the child env strips API
 * keys, so that login is the only auth path). Consulted (cached) by the dispatcher before
 * casting and by `beckett doctor`.
 */
export async function codexPreflight(config: Config): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  const bin = config.harness.codex.bin;

  // Explicit env so Bun resolves the executable against the LIVE process PATH (issue #30 —
  // without it, spawnSync uses the startup PATH and `beckett doctor`'s override is invisible).
  // probeCommand separates a KILLED probe (timed out under load — retried, then reported as a
  // timeout) from a real non-zero exit, so a slow box never masquerades as a broken codex (#54).
  const v = probeCommand([bin, "--version"], childEnv(), { budgets: PREFLIGHT_BUDGETS_MS });
  if (v.spawnError) {
    problems.push(
      `codex binary "${bin}" is not runnable on PATH (${v.spawnError.message}). ` +
        `Install codex or fix config.harness.codex.bin.`,
    );
  } else if (v.timedOut) {
    problems.push(
      `\`${bin} --version\` TIMED OUT — killed by ${v.signalCode ?? "signal"} after ${v.attempts} ` +
        `attempt(s), the last with a ${v.budgetMs / 1000}s budget. codex was NOT confirmed broken; ` +
        `the probe was starved (likely heavy concurrent load). Retry when the box is quieter.`,
    );
  } else if (!v.ok) {
    problems.push(`\`${bin} --version\` exited ${v.exitCode}: ${v.stderr.trim() || "(no output)"}`);
  }

  const authPath = join(process.env.HOME ?? "", ".codex/auth.json");
  try {
    const f = Bun.file(authPath);
    if (!(await f.exists()) || f.size === 0) {
      problems.push(`no codex login at ${authPath} — run \`codex login\` (ChatGPT subscription).`);
    }
  } catch (err) {
    problems.push(`could not read codex login at ${authPath} (${(err as Error).message}).`);
  }

  return { ok: problems.length === 0, problems };
}

export class CodexDriver extends OneShotDriver implements HarnessDriver {
  readonly kind = "codex-exec-oneshot" as const;

  // ── codex-specific parse state ──────────────────────────────────────────────
  /** Item ids already counted as a tool call (dedup started/updated/completed). */
  private readonly seenToolIds = new Set<string>();
  /** The text of the most recent `agent_message` — the candidate structured done-signal. */
  private lastAgentMessage = "";

  constructor(config: Config, logger?: Logger) {
    super(config, logger, "driver.codex");
  }

  // ===========================================================================
  // BaseDriver hooks
  // ===========================================================================

  protected harnessName(): string {
    return "codex";
  }

  protected binName(): string {
    return this.config.harness.codex.bin;
  }

  /** Static-price-table estimate off the cumulative counters (codex streams no $ field). */
  protected usdEstimate(): number | null {
    return estimateUsd(this.resolvedModel(), this.tokens);
  }

  protected override launchLogFields(): Record<string, unknown> {
    return { model: this.resolvedModel() || "(codex default)" };
  }

  protected buildResumeArgs(prompt: string): string[] {
    const spec = this.spec!;
    const codex = this.config.harness.codex;
    // `codex exec resume` does not accept `-s`/`-C`: the sandbox is supplied as a config
    // override and the worktree comes from the child's cwd (set in launch()).
    const args: string[] = [
      "exec",
      "resume",
      this.sessionId ?? "--last",
      "--json",
      "--skip-git-repo-check",
      ...this.modelFlag(),
      "-c",
      `sandbox_mode=${codex.sandbox_mode}`,
      ...this.configOverrides(),
    ];
    if (spec.doneSchemaPath) args.push("--output-schema", spec.doneSchemaPath);
    args.push(prompt);
    return args;
  }

  protected resetParseState(): void {
    this.seenToolIds.clear();
    this.lastAgentMessage = "";
  }

  // ===========================================================================
  // spawn
  // ===========================================================================

  /**
   * Launch the codex worker process and resolve once the `thread.started` line yields a
   * thread id (spawning→running). Rejects if the process dies, or never streams a thread,
   * before that point. The brief (`spec.prompt`, prefixed with `spec.systemAppend` since
   * exec has no system-prompt channel) is passed as the trailing CLI argument.
   */
  async spawn(spec: SpawnSpec): Promise<SpawnResult> {
    if (this.child) throw new Error("CodexDriver: already spawned (one driver = one process)");
    this.spec = spec;

    // Crash recovery (issue #20): a caller-persisted THREAD id (captured from a previous run's
    // thread.started) relaunches `codex exec resume <id>`, restoring the prior transcript instead
    // of re-paying the whole ticket's exploration cost.
    const resume = spec.resumeSessionId?.trim();
    if (resume) {
      this.sessionId = resume;
      const args = this.buildResumeArgs(this.composePrompt(spec));
      return this.launch(args, { isResume: true });
    }

    // codex exec does not accept a caller-minted id; it is captured from thread.started.
    this.sessionId = spec.sessionId ?? null;

    const args = this.buildSpawnArgs(this.composePrompt(spec));
    return this.launch(args, { isResume: false });
  }

  // ===========================================================================
  // argv construction
  // ===========================================================================

  private resolvedModel(): string {
    return this.spec?.model || this.config.harness.codex.default_model;
  }

  /**
   * codex exec has no system-prompt channel, so the businesslike `systemAppend` (scope +
   * criteria) is folded into the head of the prompt argument with a separator.
   */
  private composePrompt(spec: SpawnSpec): string {
    const sys = spec.systemAppend?.trim();
    return sys ? `${sys}\n\n---\n\n${spec.prompt}` : spec.prompt;
  }

  private buildSpawnArgs(prompt: string): string[] {
    const spec = this.spec!;
    const codex = this.config.harness.codex;
    const args: string[] = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-s",
      codex.sandbox_mode,
      "-C",
      spec.workspace,
      // `-m` only when a model is explicitly cast; otherwise defer to codex's own config
      // (`~/.codex/config.toml`), which is authed for the account's supported models.
      ...this.modelFlag(),
      ...this.configOverrides(),
    ];
    if (spec.doneSchemaPath) args.push("--output-schema", spec.doneSchemaPath);
    args.push(prompt);
    return args;
  }

  /** `["-m", model]` only when a model was explicitly cast; else `[]` (use codex's default). */
  private modelFlag(): string[] {
    const m = this.resolvedModel().trim();
    return m ? ["-m", m] : [];
  }

  /** Config-override (`-c key=value`) flags shared by spawn + resume (approvals + network). */
  private configOverrides(): string[] {
    const codex = this.config.harness.codex;
    const effort = this.spec?.envelope.effort ?? codex.default_effort;
    const ov: string[] = [
      "-c",
      `approval_policy=${codex.approval_policy}`,
      "-c",
      `model_reasoning_effort="${effort}"`,
    ];
    const network = (this.spec?.envelope.network ?? false) || codex.network_default;
    if (network) ov.push("-c", "sandbox_workspace_write.network_access=true");
    return ov;
  }

  // ===========================================================================
  // JSONL parsing (`--json` thread/item events)
  // ===========================================================================

  /**
   * Parse one raw JSONL line and fan out normalized {@link WorkerEvent}s. Tolerant by
   * contract (Spec 02 §7.2; my-docs/codex-exec.md §1.6): a malformed line, an unknown `type`,
   * or an unknown `item.type` becomes a `kind:'unknown'` event — never a throw.
   */
  protected handleLine(line: string): void {
    this.normalizeLine(line, (obj) => this.dispatchFrame(obj));
  }

  /** Route one parsed `--json` thread/item frame by `type` (shared envelope in normalizeLine). */
  private dispatchFrame(obj: Record<string, unknown>): void {
    switch (obj.type) {
      case "thread.started":
        this.handleThreadStarted(obj);
        break;
      case "turn.started":
        this.turns += 1;
        this.emit({ kind: "turn_started", ts: Date.now() });
        break;
      case "turn.completed":
        this.handleTurnCompleted(obj);
        break;
      case "turn.failed":
        this.handleTurnFailed(obj);
        break;
      case "item.started":
        this.handleItem("started", obj.item);
        break;
      case "item.updated":
        this.handleItem("updated", obj.item);
        break;
      case "item.completed":
        this.handleItem("completed", obj.item);
        break;
      case "error":
        this.emit({ kind: "error", message: this.str(obj.message) ?? "error", ts: Date.now() });
        break;
      default:
        this.emit({ kind: "unknown", raw: obj, ts: Date.now() });
    }
  }

  private handleThreadStarted(obj: Record<string, unknown>): void {
    // The launch is confirmed running once the thread starts (shared handshake tail in base).
    const tid = this.str(obj.thread_id) ?? this.sessionId;
    this.emitSessionStarted(tid, this.resolvedModel(), Date.now());
  }

  private handleTurnCompleted(obj: Record<string, unknown>): void {
    const ts = Date.now();
    const usage = this.mapUsage(obj.usage);
    if (usage) {
      this.addTokens(usage);
      this.emit({ kind: "turn_completed", usage, ts });
    }

    // Steering that arrived during this one-shot turn couldn't interrupt it; apply it now by
    // resuming with the buffered instruction(s) rather than finishing. The child-gen guard keeps
    // this turn's imminent process exit from firing a spurious error-finish.
    if (this.bufferedNudges.length > 0 && this.workerState !== "aborted") {
      this.log.info("turn completed with buffered steering — auto-resuming to apply it", {
        pending: this.bufferedNudges.length,
      });
      this.latch("turn-boundary"); // this turn's process is done; resume() will relaunch
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
        this.latch("terminal-event");
        this.stopWatchdog();
        if (!this.isTerminal()) this.setState("failed");
      });
      return;
    }

    // exec is one-shot: a completed turn (with no pending steering) IS success (Spec 02 §5).
    this.emit({
      kind: "finished",
      status: "success",
      subtype: "success",
      structuredOutput: this.parseStructuredOutput(),
      usage: { ...this.tokens },
      ts,
    });
    this.latch("terminal-event");
    this.stopWatchdog(); // success sets the non-terminal "review" state, so clear the timer here
    if (!this.isTerminal()) this.setState("review"); // success → handed to GATE (Spec 11)
  }

  private handleTurnFailed(obj: Record<string, unknown>): void {
    const ts = Date.now();
    const error = obj.error as Record<string, unknown> | undefined;
    const message = this.str(error?.message) ?? "turn failed";
    this.emit({ kind: "error", message, ts });
    this.emit({
      kind: "finished",
      status: "error",
      subtype: "error_turn_failed",
      structuredOutput: null,
      usage: { ...this.tokens },
      errorClass: classifyHarnessFailure(`${message}\n${this.stderrRing.tail()}`) ?? "crash",
      ts,
    });
    this.latch("terminal-event");
    if (!this.isTerminal()) this.setState("failed");
  }

  /**
   * Normalize one `item.*` event. Items wrap a discrete unit of work; the same item id is seen
   * across started→updated→completed, so tool calls are counted once per id.
   */
  private handleItem(phase: "started" | "updated" | "completed", rawItem: unknown): void {
    const ts = Date.now();
    if (!rawItem || typeof rawItem !== "object") {
      this.emit({ kind: "unknown", raw: rawItem, ts });
      return;
    }
    const item = rawItem as Record<string, unknown>;
    const itemType = this.str(item.type) ?? "unknown";
    const id = this.str(item.id) ?? "";

    switch (itemType) {
      case "agent_message": {
        const text = this.str(item.text) ?? "";
        if (text) this.lastAgentMessage = text;
        // codex emits the final message as item.completed; partial only on a non-completed phase.
        this.emit({ kind: "assistant_text", text, partial: phase !== "completed", ts });
        return;
      }
      case "command_execution":
      case "mcp_tool_call":
      case "web_search": {
        this.handleToolItem(phase, itemType, id, item, ts);
        return;
      }
      case "file_change": {
        if (phase === "completed") this.emitFileChange(item, ts);
        return;
      }
      case "todo_list": {
        this.emitPlanUpdate(item, ts);
        return;
      }
      case "error": {
        this.emit({ kind: "error", message: this.str(item.message) ?? "item error", ts });
        return;
      }
      // reasoning + any future item type: tolerated, surfaced as unknown (Spec 02 §7.2).
      default:
        this.emit({ kind: "unknown", raw: item, ts });
    }
  }

  private handleToolItem(
    phase: "started" | "updated" | "completed",
    itemType: string,
    id: string,
    item: Record<string, unknown>,
    ts: number,
  ): void {
    // Count + emit the tool_call exactly once per item id (first sighting).
    if (!TOOL_ITEM_TYPES.has(itemType)) return;
    const key = id || `${itemType}:${this.toolCalls}`;
    if (!this.seenToolIds.has(key)) {
      this.seenToolIds.add(key);
      this.toolCalls += 1;
      this.emit({ kind: "tool_call", tool: this.toolName(itemType, item), input: item, toolId: id, ts });
    }
    if (phase === "completed") {
      this.emit({ kind: "tool_result", toolId: id, isError: this.toolItemErrored(itemType, item), ts });
    }
  }

  private toolName(itemType: string, item: Record<string, unknown>): string {
    if (itemType === "mcp_tool_call") {
      const server = this.str(item.server) ?? "mcp";
      const tool = this.str(item.tool) ?? "tool";
      return `${server}.${tool}`;
    }
    if (itemType === "web_search") return "web_search";
    // command_execution
    return this.str(item.command) ?? "shell";
  }

  private toolItemErrored(itemType: string, item: Record<string, unknown>): boolean {
    if (this.str(item.status) === "failed") return true;
    if (itemType === "command_execution") {
      return typeof item.exit_code === "number" && item.exit_code !== 0;
    }
    if (itemType === "mcp_tool_call") {
      return item.error != null;
    }
    return false;
  }

  private emitFileChange(item: Record<string, unknown>, ts: number): void {
    const raw = Array.isArray(item.changes) ? item.changes : [];
    const paths: { path: string; kind: "add" | "update" | "delete" }[] = [];
    for (const c of raw) {
      const change = c as Record<string, unknown>;
      const path = this.str(change.path);
      if (!path) continue;
      const k = this.str(change.kind);
      const kind = k === "add" || k === "delete" ? k : "update";
      paths.push({ path, kind });
    }
    if (paths.length > 0) this.emit({ kind: "file_change", paths, ts });
  }

  private emitPlanUpdate(item: Record<string, unknown>, ts: number): void {
    const raw = Array.isArray(item.items) ? item.items : [];
    const items = raw.map((t) => {
      const entry = t as Record<string, unknown>;
      return { text: this.str(entry.text) ?? "", done: entry.completed === true };
    });
    this.emit({ kind: "plan_update", items, ts });
  }

  /** Best-effort parse of the final agent_message as the structured done-signal JSON. */
  private parseStructuredOutput(): unknown | null {
    const text = this.lastAgentMessage.trim();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /**
   * Map codex `turn.completed.usage` → the shared {@link TokenUsage} shape (Spec 02 §7.3). codex
   * has no cache-creation token field (my-docs/codex-exec.md §1.5) — cacheCreate is omitted → 0.
   */
  private mapUsage(raw: unknown): TokenUsage | null {
    return this.mapTokenUsage(raw, {
      input: "input_tokens",
      output: "output_tokens",
      cacheRead: "cached_input_tokens",
    });
  }
}
