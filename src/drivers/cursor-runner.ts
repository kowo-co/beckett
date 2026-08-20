#!/usr/bin/env bun
/**
 * Beckett — the Cursor local-mode shim (`src/drivers/cursor-runner.ts`)
 * =======================================================================================
 * A STANDALONE script {@link CursorDriver} spawns as a child, and the ONLY file in the tree that
 * imports `@cursor/sdk`.
 *
 * ## Why a shim exists at all
 *
 * Every other driver wraps an external CLI binary: `Bun.spawn(["claude", …])`, parse its NDJSON
 * stdout, done. Cursor's local mode is a LIBRARY — `Agent.create({ local: { cwd } })` runs the
 * agent loop inside your own Node/Bun process and edits the literal filesystem at `cwd`. There is
 * no binary to shell out to.
 *
 * Rather than teach `BaseDriver` a second, in-process execution model (and put a heavyweight SDK,
 * its native platform package, and an agent loop inside the daemon), this script IS the binary.
 * It re-emits the SDK's stream as NDJSON in the shared frame vocabulary (`./cursor-protocol.ts`),
 * so process isolation, group kills, the wall-clock backstop, and one-child-per-run all keep
 * working unchanged, and the driver's parser is the same small `type` switch every other driver
 * has.
 *
 * ## Why LOCAL mode and not the Cloud Agent API
 *
 * `.beckett/` — spec.md, worker-settings, this run's whole contract — is git-excluded and never
 * committed (`../run/spec-file.ts`). A cloud agent only ever sees what is reachable through a
 * pushed branch, so it would never see the checklist it is supposed to fill in and tick. Local
 * mode reads the worktree off disk exactly the way claude does.
 *
 * ## What this script is responsible for beyond transport
 *
 *  1. **The rolling handoff.** `.beckett/cursor-handoff.md` is rewritten after every tool call, so
 *     a quota wall needs zero last-second cleanup — the briefing for the next seat is already on
 *     disk and current (`./cursor-handoff.ts`).
 *  2. **Never losing an edit.** On quota exhaustion, whatever is on disk is COMMITTED (never
 *     stashed — a stash risks never being popped; never discarded — that is the "work lost" this
 *     seat exists to prevent) before the process exits.
 *  3. **Not lying about progress.** A `[x]` this run ticked has no verification behind it that the
 *     incoming Claude worker can see, so it is reset and named in the handoff for re-verification.
 *  4. **Spec-gate parity.** `../hooks/spec-gate.ts` is a Claude-CLI Stop hook and Cursor has no
 *     equivalent protocol, so this script evaluates the SAME pure decision function and, when it
 *     blocks, sends the block reason back as a follow-up turn — which is exactly what the Stop
 *     hook does to Claude. Same rule, same 3-strike escape hatch, different transport.
 *
 * ## Credential
 *
 * `CURSOR_API_KEY` arrives by env inheritance only (`../env.ts` → `CursorDriver.buildChildEnv`).
 * It never touches argv, stdout, a log line, or the handoff file. The one place it is read is
 * {@link readApiKey}, and nothing downstream of that ever formats it.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";

import { Agent, Cursor, type SDKAgent, type SDKMessage } from "@cursor/sdk";

import {
  CURSOR_EDIT_TOOLS,
  classifyCursorError,
  encodeFrame,
  isRetryableKind,
  pathFromToolArgs,
  type CursorFailureKind,
  type CursorFrame,
} from "./cursor-protocol.ts";
import {
  CURSOR_HANDOFF_REL,
  HANDOFF_ACTIVITY_MAX,
  HANDOFF_NOTES_MAX,
  renderCursorHandoff,
  type CursorHandoffState,
} from "./cursor-handoff.ts";
import { git, performQuotaExit } from "./cursor-checkpoint.ts";
import { assertNotCostOptimized, resolveCursorSelection, type CursorCatalogueItem } from "./cursor-model.ts";
import { evaluateSpecGate, MAX_STRIKES } from "../hooks/spec-gate.ts";
import { SPEC_FILE_REL, specRunId, tickedItemTexts } from "../run/spec-file.ts";

// =======================================================================================
// Retry policy
// =======================================================================================

/**
 * Attempts (including the first) for one Cursor API call. Two retries is the bounded transient
 * policy; a THIRD identical failure is escalated to `quota` rather than retried forever.
 *
 * That escalation is the deliberate fail-safe from the design: Cursor documents no way to tell a
 * spent monthly allowance from a persistent 5xx, and the two mistakes cost wildly different
 * amounts. Mistaking exhaustion for a blip wedges the run against a wall that will not move;
 * mistaking a blip for exhaustion costs one handoff to a seat that also works (and Cursor does not
 * bill a rejected call). Every escalation records the raw status/code/message in the handoff file,
 * so the first real occurrence in production is what tightens this rule.
 */
const CURSOR_MAX_ATTEMPTS = 3;

/** Backoff before retry N (ms). Short: a worker slot is held open for the whole wait. */
const RETRY_BACKOFF_MS = [1_000, 4_000];

// =======================================================================================
// Frame emission
// =======================================================================================

function emit(frame: CursorFrame): void {
  process.stdout.write(encodeFrame(frame));
}

function logLine(level: "info" | "warn" | "error", message: string): void {
  emit({ type: "log", level, message });
}

// =======================================================================================
// argv
// =======================================================================================

interface RunnerArgs {
  workspace: string;
  agentId: string;
  /** The Beckett-side cast model (`cursor-auto` by default) — see `./cursor-model.ts`. */
  model: string;
  /** Resume an existing agent instead of creating one (crash recovery / steer relaunch). */
  resume: boolean;
  /** Cursor conversation mode. Always `agent` for this seat — `plan` writes nothing. */
  mode: "agent" | "plan";
}

/**
 * Parse the shim's argv. Pure, so a test can pin the contract without spawning.
 *
 * Deliberately minimal: the run id and branch are NOT passed here, because both are already
 * knowable from the workspace itself (spec.md's `> run:` stamp and `git rev-parse`). Fewer argv
 * fields means fewer ways for the driver and the shim to disagree about what run this is.
 */
export function parseRunnerArgs(argv: readonly string[]): RunnerArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const workspace = get("--workspace");
  const agentId = get("--agent-id");
  if (!workspace) throw new Error("cursor-runner: --workspace is required");
  if (!agentId) throw new Error("cursor-runner: --agent-id is required");
  return {
    workspace,
    agentId,
    model: get("--model") ?? "",
    resume: argv.includes("--resume"),
    mode: get("--mode") === "plan" ? "plan" : "agent",
  };
}

// =======================================================================================
// The run's mutable bookkeeping
// =======================================================================================

class RunnerState {
  readonly activity: CursorHandoffState["activity"] = [];
  readonly notes: string[] = [];
  /** Checklist items already ticked when this seat took over — NOT ours to reset. */
  readonly ticksAtStart: ReadonlySet<string>;
  /** Tool call id → name, so a `tool_end` can name the tool the SDK only labelled at start. */
  readonly toolNames = new Map<string, string>();
  readonly toolPaths = new Map<string, string>();
  model = "Auto";
  status = "working — the cursor seat holds this run";

  readonly runId: string;
  readonly branch: string;

  constructor(
    readonly args: RunnerArgs,
    readonly specPath: string,
    readonly handoffPath: string,
  ) {
    const specText = readTextOr(specPath, "");
    this.ticksAtStart = new Set(tickedItemTexts(specText));
    // Both derived, not passed: spec.md already stamps the run id it belongs to, and git already
    // knows the branch. Reading them here means the handoff can never name a different run than
    // the checklist sitting beside it.
    this.runId = specRunId(specText) ?? "(unstamped run)";
    this.branch = git(["rev-parse", "--abbrev-ref", "HEAD"], args.workspace).stdout || "(detached)";
  }

  /**
   * Workspace-relative form of a path the SDK reported. Local mode reports ABSOLUTE paths, and a
   * worktree path is ~90 characters before the interesting part starts — a handoff full of them is
   * unreadable, which defeats the point of writing one.
   */
  rel(path: string): string {
    if (!path) return "";
    if (!isAbsolute(path)) return path;
    const r = relative(this.args.workspace, path);
    return r && !r.startsWith("..") ? r : path;
  }

  note(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    // The final done-signal is already the `result` frame's payload; repeating it verbatim in the
    // briefing is noise, and a JSON blob is the least useful thing a human reader can be handed.
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        JSON.parse(trimmed);
        return;
      } catch {
        /* not JSON — it really is prose worth keeping */
      }
    }
    this.notes.push(trimmed);
    if (this.notes.length > HANDOFF_NOTES_MAX * 2) this.notes.splice(0, this.notes.length - HANDOFF_NOTES_MAX);
  }

  record(tool: string, detail: string): void {
    this.activity.push({ tool, detail });
    if (this.activity.length > HANDOFF_ACTIVITY_MAX * 2) {
      this.activity.splice(0, this.activity.length - HANDOFF_ACTIVITY_MAX);
    }
  }

  /** Rewrite the handoff file. Cheap (a local write of a few KB) and always current by design. */
  writeHandoff(extra: Partial<CursorHandoffState> = {}): void {
    try {
      writeFileSync(
        this.handoffPath,
        renderCursorHandoff({
          runId: this.runId,
          branch: this.branch,
          agentId: this.args.agentId,
          model: this.model,
          updatedAt: new Date().toISOString(),
          status: this.status,
          activity: this.activity,
          unverifiedTicks: [],
          notes: this.notes,
          ...extra,
        }),
      );
    } catch (err) {
      logLine("warn", `could not write the handoff file: ${(err as Error).message}`);
    }
  }
}

function readTextOr(path: string, fallback: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : fallback;
  } catch {
    return fallback;
  }
}

// =======================================================================================
// The quota exit
// =======================================================================================

/**
 * Hand the run over. The durable work — commit, reset unverified ticks, write the briefing —
 * lives in `./cursor-checkpoint.ts` so it is testable without the SDK; this is the reporting
 * half. By the time the `quota` frame goes out, everything is already on disk.
 */
function handOver(state: RunnerState, detail: { reason: string; status?: number; code?: string }): void {
  const exit = performQuotaExit(
    {
      workspace: state.args.workspace,
      agentId: state.args.agentId,
      model: state.model,
      ticksAtStart: state.ticksAtStart,
      activity: state.activity,
      notes: state.notes,
    },
    detail,
  );
  if (exit.unverifiedTicks.length > 0) {
    logLine(
      "info",
      `reset ${exit.unverifiedTicks.length} unverified checklist tick(s) for the next seat to re-verify`,
    );
  }
  emit({
    type: "quota",
    reason: detail.reason,
    ...(detail.status === undefined ? {} : { status: detail.status }),
    ...(detail.code ? { code: detail.code } : {}),
    ...(exit.checkpoint ? { checkpoint: exit.checkpoint } : {}),
  });
}

// =======================================================================================
// Error shaping
// =======================================================================================

interface ShapedError {
  kind: CursorFailureKind;
  message: string;
  status?: number;
  code?: string;
}

function shape(err: unknown): ShapedError {
  const e = (err ?? {}) as { message?: string; status?: number; code?: string; isRetryable?: boolean };
  const message = typeof e.message === "string" && e.message.trim() ? e.message.trim() : String(err);
  return {
    kind: classifyCursorError({ ...e, message }),
    message,
    ...(typeof e.status === "number" ? { status: e.status } : {}),
    ...(typeof e.code === "string" ? { code: e.code } : {}),
  };
}

/**
 * Run one Cursor API call with the bounded transient retry. A non-retryable failure throws
 * immediately; a retryable one that survives {@link CURSOR_MAX_ATTEMPTS} is re-thrown AS a quota
 * failure (see that constant's note for the cost asymmetry behind that choice).
 */
async function withRetry<T>(label: string, fn: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
  let last: ShapedError | null = null;
  for (let attempt = 1; attempt <= CURSOR_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      last = shape(err);
      if (!isRetryableKind(last.kind)) throw Object.assign(new Error(last.message), last);
      if (attempt === CURSOR_MAX_ATTEMPTS) break;
      const wait = RETRY_BACKOFF_MS[attempt - 1] ?? 4_000;
      logLine("warn", `${label} failed (${last.kind}), retry ${attempt}/${CURSOR_MAX_ATTEMPTS - 1} in ${wait}ms`);
      await sleep(wait);
    }
  }
  const escalated: ShapedError = {
    ...last!,
    kind: "quota",
    message:
      `${label} failed ${CURSOR_MAX_ATTEMPTS} times with the same error and is being treated as ` +
      `quota exhaustion (Cursor does not distinguish the two): ${last!.message}`,
  };
  throw Object.assign(new Error(escalated.message), escalated);
}

// =======================================================================================
// Stream → frames
// =======================================================================================

/** Fan one SDK stream message out as Beckett frames, updating the handoff as it goes. */
function onMessage(state: RunnerState, msg: SDKMessage, sink: { text: string }): void {
  switch (msg.type) {
    case "system":
      // Local mode does not reliably emit this (verified 2026-08-19: a clean run emitted none),
      // so the handshake is synthesized before the agent is even created. Nothing to do here.
      break;
    case "assistant": {
      const text = msg.message.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
      if (!text) break;
      sink.text += text;
      emit({ type: "assistant", text, partial: true });
      break;
    }
    case "thinking":
      break;
    case "tool_call": {
      const name = msg.name || "tool";
      if (msg.status === "running") {
        if (!state.toolNames.has(msg.call_id)) {
          state.toolNames.set(msg.call_id, name);
          const path = pathFromToolArgs(msg.args);
          if (path) state.toolPaths.set(msg.call_id, path);
          emit({ type: "tool_start", id: msg.call_id, name, args: msg.args ?? {} });
        }
        break;
      }
      // completed | error
      const path = pathFromToolArgs(msg.args) ?? state.toolPaths.get(msg.call_id);
      const isError = msg.status === "error";
      const rel = path ? state.rel(path) : "";
      emit({
        type: "tool_end",
        id: msg.call_id,
        name,
        isError,
        ...(rel && !isError && CURSOR_EDIT_TOOLS.has(name) ? { path: rel } : {}),
      });
      state.record(name, rel);
      state.toolPaths.delete(msg.call_id);
      // Rewritten after EVERY tool call: the whole point is that the briefing on disk is already
      // current when the wall hits, not composed at the moment the API stops answering.
      state.writeHandoff();
      break;
    }
    case "usage":
      emit({
        type: "usage",
        usage: {
          input: msg.usage.inputTokens,
          output: msg.usage.outputTokens,
          cacheRead: msg.usage.cacheReadTokens,
          cacheWrite: msg.usage.cacheWriteTokens,
        },
      });
      break;
    case "status":
      if (msg.status === "ERROR" && msg.message) emit({ type: "error", message: msg.message });
      break;
    default:
      break;
  }
}

// =======================================================================================
// Entry point
// =======================================================================================

/** Read the credential. The ONLY place this value is touched; nothing downstream formats it. */
function readApiKey(): string {
  const key = process.env.CURSOR_API_KEY?.trim();
  if (!key) {
    throw Object.assign(new Error("CURSOR_API_KEY is not set in the worker environment"), {
      kind: "auth" as const,
    });
  }
  return key;
}

/** Read the first line of stdin as the worker's prompt payload (mirrors `ClaudeDriver`'s stdin). */
async function readPromptPayload(): Promise<{ prompt: string; systemAppend: string }> {
  const raw = await new Response(Bun.stdin.stream()).text();
  const line = raw.split("\n").find((l) => l.trim()) ?? "";
  try {
    const parsed = JSON.parse(line) as { prompt?: unknown; systemAppend?: unknown };
    return {
      prompt: typeof parsed.prompt === "string" ? parsed.prompt : "",
      systemAppend: typeof parsed.systemAppend === "string" ? parsed.systemAppend : "",
    };
  } catch {
    return { prompt: line, systemAppend: "" };
  }
}

/**
 * Cursor's SDK has no system-prompt parameter — `AgentOptions` carries model, tools, and MCP
 * config, and nothing else. Claude gets the persona via `--append-system-prompt`; here it is
 * folded into the head of the first user turn instead. Same content, different transport, and the
 * only behavioural difference is that a Cursor follow-up turn doesn't re-carry it (it doesn't need
 * to: the conversation retains it).
 */
function composeFirstTurn(systemAppend: string, prompt: string): string {
  const persona = systemAppend.trim();
  return persona ? `${persona}\n\n---\n\n${prompt}` : prompt;
}

/**
 * Seams the shim's entry point takes by injection so `./cursor-runner.test.ts` can drive the WHOLE
 * path — retry escalation, the spec-gate loop, both quota failure points — against a real git repo
 * and a real spec.md without a network call or a five-second backoff wait. Production passes none
 * of them and gets the real implementations.
 */
interface RunnerDeps {
  readPrompt?: () => Promise<{ prompt: string; systemAppend: string }>;
  sleep?: (ms: number) => Promise<void>;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  deps: RunnerDeps = {},
): Promise<number> {
  const readPrompt = deps.readPrompt ?? readPromptPayload;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const args = parseRunnerArgs(argv);
  const specPath = join(args.workspace, SPEC_FILE_REL);
  const handoffPath = join(args.workspace, CURSOR_HANDOFF_REL);
  const state = new RunnerState(args, specPath, handoffPath);

  // The handshake goes out BEFORE anything can fail, carrying the agent id the driver pre-minted.
  // That ordering is load-bearing: a quota wall hit at `Agent.create` — the "before first token"
  // case — must arrive as an ordinary terminal frame the supervisor can hand off from, not as a
  // spawn failure that parks the run before a seat change was ever considered.
  emit({ type: "session", agentId: args.agentId, model: args.model || "cursor-auto" });
  state.writeHandoff();

  const apiKey = readApiKey();
  const { prompt, systemAppend } = await readPrompt();

  // The catalogue read is best-effort by design: `resolveCursorSelection` treats an EMPTY
  // catalogue as "Balance could not be confirmed" and degrades to plain Auto with a note, rather
  // than assuming a variant it never saw.
  let catalogue: CursorCatalogueItem[] = [];
  try {
    catalogue = (await Cursor.models.list({ apiKey })) as unknown as CursorCatalogueItem[];
  } catch (err) {
    const shaped = shape(err);
    if (shaped.kind === "quota") {
      handOver(state, { reason: shaped.message, ...pick(shaped) });
      return 0;
    }
    logLine("warn", `could not read the cursor model catalogue: ${shaped.message}`);
  }

  const resolved = resolveCursorSelection(args.model, catalogue);
  assertNotCostOptimized(resolved.selection);
  state.model = resolved.label;
  if (resolved.note) {
    logLine("info", resolved.note);
    state.note(resolved.note);
  }
  state.writeHandoff();

  let agent: SDKAgent;
  try {
    agent = await withRetry(
      "agent create",
      async () =>
      args.resume
        ? await Agent.resume(args.agentId, { apiKey, model: resolved.selection, local: { cwd: args.workspace } })
        : await Agent.create({
            apiKey,
            agentId: args.agentId,
            model: resolved.selection,
            mode: args.mode,
            local: { cwd: args.workspace },
            name: state.runId,
          }),
      sleep,
    );
  } catch (err) {
    const shaped = shape(err);
    if (shaped.kind === "quota") {
      handOver(state, { reason: shaped.message, ...pick(shaped) });
      return 0;
    }
    emit({ type: "error", message: shaped.message });
    emit({ type: "result", status: "error", text: shaped.message });
    return 1;
  }

  try {
    let turn = composeFirstTurn(systemAppend, prompt);
    let strikes = 0;
    let finalText = "";

    // The spec-gate loop. One pass normally; a blocked stop sends the block reason back as the
    // next turn, exactly as `../hooks/spec-gate.ts` does to a Claude session, bounded by the same
    // 3-strike escape hatch so a wedged worker can't loop against the gate forever.
    for (;;) {
      const run = await withRetry("agent send", () => agent.send(turn), sleep);
      emit({ type: "turn_start" });

      const sink = { text: "" };
      for await (const msg of run.stream()) onMessage(state, msg, sink);

      const result = await run.wait();
      finalText = (result.result ?? sink.text).trim();
      if (finalText) {
        emit({ type: "assistant", text: finalText, partial: false });
        state.note(finalText.slice(0, 600));
      }
      state.writeHandoff();

      if (result.status !== "finished") {
        emit({
          type: "result",
          status: result.status,
          text: finalText || (result.error?.message ?? ""),
          ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
        });
        return 0;
      }

      const gate = evaluateSpecGate(existsSync(specPath) ? readFileSync(specPath, "utf8") : null, strikes);
      if (!("decision" in gate.decision) || gate.decision.decision !== "block") {
        if (gate.warned) {
          logLine("warn", `spec gate allowed the stop through after ${MAX_STRIKES} strikes`);
        }
        emit({
          type: "result",
          status: "finished",
          text: finalText,
          ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
        });
        return 0;
      }
      strikes = gate.nextCount;
      logLine("info", `spec gate blocked the stop (strike ${strikes}/${MAX_STRIKES}) — sending it back`);
      turn = gate.decision.reason;
    }
  } catch (err) {
    const shaped = shape(err);
    if (shaped.kind === "quota") {
      handOver(state, { reason: shaped.message, ...pick(shaped) });
      return 0;
    }
    emit({ type: "error", message: shaped.message });
    emit({ type: "result", status: "error", text: shaped.message });
    return 1;
  } finally {
    try {
      agent.close();
    } catch {
      /* closing a finished agent is best-effort */
    }
  }
}

/** The optional diagnostic fields of a shaped error, spread-safe under `exactOptionalPropertyTypes`. */
function pick(shaped: ShapedError): { status?: number; code?: string } {
  return {
    ...(shaped.status === undefined ? {} : { status: shaped.status }),
    ...(shaped.code ? { code: shaped.code } : {}),
  };
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      // Last-resort: something outside the classified paths threw. Report it as a terminal error
      // frame so the driver has a cause rather than an unexplained exit.
      const shaped = shape(err);
      emit({ type: "error", message: shaped.message });
      emit({ type: "result", status: "error", text: shaped.message });
      process.exit(1);
    });
}
