/**
 * Beckett — Generic agent invoke-lane (`src/agent/invoke.ts`)
 * =======================================================================================
 * The missing half of the live-agent registry (issue #55): a runner that takes ANY registered
 * {@link AgentDefinition} — prompt + seat (harness/model/effort) + skills/tools — and actually
 * INVOKES it. Nothing here is hardcoded to a particular agent; the runner reads the definition and
 * spawns the seat. Adding a new agent is `beckett agent add` (pure data) — this runner already
 * knows how to run it, no core edit and no redeploy.
 *
 * The design mirrors the quick lane ({@link ../quick/index.ts}): spawn `claude -p` with the agent's
 * system prompt appended and its granted tools scoped, block for the text output, and hand that back
 * to the caller. Unlike quick it does NOT own delivery — the CALLER decides what to do with the
 * output. That seam is what lets the daily-shitpost routine drive the `social-media` agent (which
 * AUTHORS a post) and then hand the authored task to the privileged background browser lane, so a
 * headless routine can post to X without a Discord mention token.
 *
 * No secret ever flows through here — credential injection happens downstream in the browser lane,
 * keyed by an entry NAME the caller carries. This runner only turns a definition into a process.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildPaths } from "../paths.ts";
import { childEnv } from "../env.ts";
import type { Config, Logger } from "../types.ts";
import type { AgentDefinition } from "./types.ts";

/** Default hard cap — authoring/short work is fast; a runaway harness must never wedge a caller. */
export const AGENT_RUN_TIMEOUT_SECS = 240;

export type AgentRunState = "done" | "error" | "timeout";

export interface AgentRunOutcome {
  runId: string;
  agentId: string;
  state: AgentRunState;
  /** The agent's stdout report (trimmed). Empty on error/timeout. */
  output: string;
  /** Populated on a non-`done` state so the caller can log/surface why. */
  error?: string;
}

export interface AgentRunOptions {
  /** Origin channel the invocation is attributed to (exposed to the agent via env). */
  channelId?: string | null;
  /** Authenticated requester the invocation is attributed to (exposed via env). */
  requesterId?: string | null;
  /** Override the hard timeout (seconds). */
  timeoutSecs?: number;
}

export interface CreateAgentRunnerDeps {
  config: Config;
  logger: Logger;
  /** Injectable for tests. */
  spawn?: typeof Bun.spawn;
}

export interface AgentRunner {
  /** Run `def` on `input` and resolve with its output. Never throws for a normal agent failure. */
  run(def: AgentDefinition, input: string, opts?: AgentRunOptions): Promise<AgentRunOutcome>;
}

/**
 * Build the harness argv for an agent seat. Only `claude` can be spawned in this lane today (the
 * backbone harness); `codex`/`pi` are valid seats in the schema but not yet spawnable here — the
 * throw is the clean seam where that support slots in without any caller change.
 *
 * `tools` (when non-empty) NARROWS the harness's tool surface via `--allowedTools`; empty = harness
 * defaults, the schema convention. Skills are globally available to the harness and named by the
 * agent's prompt, so granting a skill is documentation of intent plus (for skills the harness gates)
 * an allow entry — both flow through the same list.
 */
export function buildAgentArgs(
  config: Config,
  def: AgentDefinition,
  input: string,
): { bin: string; args: string[] } {
  if (def.model.harness !== "claude") {
    throw new Error(
      `agent ${def.id}: harness "${def.model.harness}" is not spawnable in the live-agent lane yet (only claude)`,
    );
  }
  const args = [
    "-p",
    input,
    "--output-format",
    "text",
    "--permission-mode",
    config.harness.claude.permission_mode,
    "--model",
    def.model.model || config.harness.claude.default_model,
    "--append-system-prompt",
    def.systemPrompt,
  ];
  if (def.model.effort) args.push("--effort", def.model.effort);
  if (def.tools.length > 0) args.push("--allowedTools", def.tools.join(","));
  return { bin: config.harness.claude.bin, args };
}

export function createAgentRunner(deps: CreateAgentRunnerDeps): AgentRunner {
  const { config, logger } = deps;
  const spawn = deps.spawn ?? Bun.spawn;
  const paths = buildPaths(config);
  const runsDir = join(paths.beckettDir, "agent-runs");
  mkdirSync(runsDir, { recursive: true, mode: 0o700 });

  function baseEnv(opts: AgentRunOptions): Record<string, string | undefined> {
    const env = childEnv();
    const home = process.env.HOME ?? "";
    const extra = [join(home, ".local/bin"), join(home, ".bun/bin")].join(":");
    env.PATH = env.PATH ? `${extra}:${env.PATH}` : extra;
    // Expose the origin so an agent that wants to route a confirmation back knows where to.
    if (opts.channelId) env.BECKETT_ORIGIN_CHANNEL_ID = opts.channelId;
    if (opts.requesterId) env.BECKETT_ORIGIN_REQUESTER_ID = opts.requesterId;
    return env;
  }

  return {
    async run(def, input, opts = {}) {
      const runId = randomUUID();
      const outcome: AgentRunOutcome = { runId, agentId: def.id, state: "error", output: "" };
      if (!input.trim()) {
        outcome.error = "agent run needs a non-empty input";
        return outcome;
      }

      const runDir = join(runsDir, runId);
      mkdirSync(runDir, { recursive: true, mode: 0o700 });

      let bin: string;
      let args: string[];
      try {
        ({ bin, args } = buildAgentArgs(config, def, input));
      } catch (err) {
        outcome.error = (err as Error).message;
        return outcome;
      }

      logger.info("agent run starting", { runId, agent: def.id, model: def.model.model, cwd: runDir });
      let child: ReturnType<typeof Bun.spawn>;
      try {
        child = spawn({
          cmd: [bin, ...args],
          cwd: runDir,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: baseEnv(opts),
        });
      } catch (err) {
        outcome.error = `agent spawn failed: ${(err as Error).message}`;
        return outcome;
      }

      const timeoutSecs = opts.timeoutSecs ?? AGENT_RUN_TIMEOUT_SECS;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, timeoutSecs * 1000);

      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout as ReadableStream).text().catch(() => ""),
        new Response(child.stderr as ReadableStream).text().catch(() => ""),
        child.exited,
      ]);
      clearTimeout(timer);

      if (timedOut) {
        outcome.state = "timeout";
        outcome.error = `agent run timed out after ${timeoutSecs}s and was killed`;
        logger.warn("agent run timed out", { runId, agent: def.id, timeoutSecs });
        return outcome;
      }
      if (code !== 0) {
        outcome.state = "error";
        outcome.error = `agent exited with code ${code}${stderr.trim() ? ` — ${truncate(stderr.trim(), 500)}` : ""}`;
        logger.warn("agent run failed", { runId, agent: def.id, code });
        return outcome;
      }
      const report = stdout.trim();
      if (!report) {
        outcome.state = "error";
        outcome.error = "agent exited cleanly but produced no output";
        return outcome;
      }
      outcome.state = "done";
      outcome.output = report;
      logger.info("agent run finished", { runId, agent: def.id, chars: report.length });
      return outcome;
    },
  };
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

// =======================================================================================
// X-post composition (issue: social-media tune, W4A) — the agent authors ONLY the post text
// (`POST: <text>` per the OUTPUT CONTRACT in src/agent/builtins.ts); CODE builds the actual
// browser task from it, routing the draft through chilltext's tone pass first. Splitting it
// this way is what makes the post text extractable for the chill pass instead of buried inside
// freeform browser-task prose the agent wrote itself.
// =======================================================================================

const POST_PREFIX = /^POST:\s*/i;

/** X's own character cap — the hard ceiling the composed post must clear before it ships. */
export const X_POST_MAX_CHARS = 280;

/**
 * Pull the post text out of an agent's `POST: <text>` output contract. Only the FIRST line is
 * honored (the contract forbids a second line); returns null if the output doesn't follow the
 * contract at all, so a caller can fall back to treating `agentOutput` as a legacy self-authored
 * browser task instead (back-compat for any agent that hasn't adopted the new contract).
 */
export function extractPostText(agentOutput: string): string | null {
  const firstLine = agentOutput.trim().split("\n", 1)[0] ?? "";
  if (!POST_PREFIX.test(firstLine)) return null;
  const text = firstLine.replace(POST_PREFIX, "").trim();
  return text.length > 0 ? text : null;
}

/** Truncate `text` to at most `maxChars`, cutting at the last word boundary rather than mid-word. */
export function truncateAtWordBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trimEnd();
}

/**
 * The self-contained browser instruction, built by CODE from the exact post text — never by the
 * agent. The safety lines (already-authenticated, don't touch credentials, verbatim text,
 * confirm + report the URL, stop-and-report on a block) carry the same facts the agent used to
 * be trusted to restate itself.
 */
export function buildXPostBrowserTask(account: string, text: string): string {
  return [
    `Go to https://x.com and post a new tweet from the logged-in account ${account}. The session is`,
    "already authenticated — do not log in or touch any credential field.",
    "",
    "Post this exact text, verbatim, and nothing else:",
    text,
    "",
    "Open the compose box, type that text, publish, then confirm it went live and report the URL of",
    "the published post.",
    "",
    "If anything blocks posting (a checkpoint, a rate limit, a changed UI), stop and report what you",
    "saw instead of guessing.",
  ].join("\n");
}

export interface ChillPassDeps {
  /** Never throws in practice (chilltext.ts's `chillTransform` already fails open), but a
   *  rejecting fake is still tolerated below — this pass must never surface a chilltext error. */
  chillTransform: (req: {
    agentOutput: string;
    input?: string;
    system?: string;
    /** Forces exactly one bubble — an X post is one message, never a thread. */
    single?: boolean;
  }) => Promise<{ messages: string[] } | null>;
}

/** chilltext's personality request for a social post: brief, in-voice, facts intact. */
export const X_POST_CHILL_SYSTEM = "snarky, extremely online, keep it under 280 chars, keep facts";

/**
 * Route `draft` through chilltext's tone pass (when `chillEnabled`) and enforce X's char cap.
 * FAIL OPEN at every step: a null/erroring transform, or a transformed result that blows the cap,
 * falls back to the original draft; a draft that itself blows the cap is truncated at a word
 * boundary rather than sent broken. Never throws.
 */
export async function applyChillPass(draft: string, chillEnabled: boolean, deps: ChillPassDeps): Promise<string> {
  let candidate = draft;
  if (chillEnabled) {
    const result = await deps
      .chillTransform({
        agentOutput: draft,
        system: X_POST_CHILL_SYSTEM,
        single: true,
      })
      .catch(() => null);
    const chilled = result?.messages[0]?.trim();
    if (chilled) candidate = chilled;
  }
  if (candidate.length <= X_POST_MAX_CHARS) return candidate;
  // The chilled candidate (or an unexpectedly long draft) blew the cap — fall back to the draft.
  if (draft.length <= X_POST_MAX_CHARS) return draft;
  // The draft itself is over cap — truncate rather than ship a clipped sentence mid-word.
  return truncateAtWordBoundary(draft, X_POST_MAX_CHARS);
}

/** Compose the final browser task for a `POST:`-authored draft: chill pass + cap, then template. */
export async function composeXPostBrowserTask(
  postText: string,
  account: string,
  chillEnabled: boolean,
  deps: ChillPassDeps,
): Promise<string> {
  const finalText = await applyChillPass(postText, chillEnabled, deps);
  return buildXPostBrowserTask(account, finalText);
}
