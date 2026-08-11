/**
 * Beckett quick agents - the short-lived specialist lane.
 *
 * Fire-and-report errands only: each run spawns a short-lived `claude -p` harness, blocks up to
 * the sync window for its report, and otherwise detaches and reports back through the Concierge
 * as an update turn. Anything that must pause for a human mid-run does not belong here — browser
 * / computer-use work lives in the dedicated background browser agent (`src/browser/agent.ts`).
 */

import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildPaths } from "../paths.ts";
import { childEnv } from "../env.ts";
import type { Config, Logger } from "../types.ts";

export interface QuickAgentDef {
  name: string;
  description: string;
  promptFile: string;
}

export const QUICK_AGENTS: readonly QuickAgentDef[] = [
  {
    name: "quick-code",
    description:
      "small coding errands in a scratch dir: one-off scripts, file transforms, snippets, conversions - never project repos",
    promptFile: "quick-code.md",
  },
  {
    name: "repo-explorer",
    description:
      "shallow-clones a repo and returns a tight brief answering your question - so you never read a whole codebase yourself",
    promptFile: "repo-explorer.md",
  },
] as const;

export function findAgent(name: string): QuickAgentDef | undefined {
  return QUICK_AGENTS.find((agent) => agent.name === name);
}

export type QuickRunState = "running" | "done" | "error" | "timeout";

export interface QuickRun {
  runId: string;
  agent: string;
  task: string;
  channelId: string | null;
  requesterId: string | null;
  startedAt: number;
  finishedAt: number | null;
  state: QuickRunState;
  result: string | null;
  detached: boolean;
}

export type QuickRunOutcome =
  | { done: true; state: Exclude<QuickRunState, "running">; result: string; runId: string }
  | { detached: true; runId: string };

export interface CreateQuickRunnerDeps {
  config: Config;
  logger: Logger;
  onDetachedResult: (run: QuickRun) => void | Promise<void>;
  spawn?: typeof Bun.spawn;
}

export interface QuickRunner {
  agents(): { name: string; description: string }[];
  run(agentName: string, task: string, channelId: string | null, requesterId?: string | null): Promise<QuickRunOutcome>;
  stats(): { running: number; runs: Pick<QuickRun, "runId" | "agent" | "state" | "startedAt">[] };
  stopAll(): Promise<void>;
}

interface LiveRun {
  run: QuickRun;
  agent: QuickAgentDef;
  runDir: string;
  systemPrompt: string;
  child: ReturnType<typeof Bun.spawn> | null;
  hardTimer: ReturnType<typeof setTimeout> | null;
}

const PROMPTS_DIR = join(import.meta.dir, "agents");
const QUICK_ARTIFACT_RETENTION_MS = 30 * 24 * 60 * 60_000;

export function createQuickRunner(deps: CreateQuickRunnerDeps): QuickRunner {
  const { config, logger } = deps;
  const spawn = deps.spawn ?? Bun.spawn;
  const paths = buildPaths(config);
  const quickDir = join(paths.beckettDir, "quick");
  mkdirSync(quickDir, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(quickDir)) {
    const path = join(quickDir, entry);
    try {
      if (Date.now() - lstatSync(path).mtimeMs > QUICK_ARTIFACT_RETENTION_MS) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // A concurrent cleanup or unreadable old artifact should not block boot.
    }
  }
  const live = new Map<string, LiveRun>();
  const recent: QuickRun[] = [];

  async function finalize(entry: LiveRun, state: "done" | "error" | "timeout", result: string): Promise<void> {
    const { run } = entry;
    if (run.state !== "running") return;
    run.state = state;
    run.result = result;
    run.finishedAt = Date.now();
    if (entry.hardTimer) clearTimeout(entry.hardTimer);
    entry.hardTimer = null;
    entry.child = null;
    live.delete(run.runId);
    recent.push(run);
    while (recent.length > 20) recent.shift();
    logger.info("quick run finished", {
      runId: run.runId,
      agent: run.agent,
      state: run.state,
      secs: Math.round((run.finishedAt - run.startedAt) / 1000),
      detached: run.detached,
    });
    if (run.detached) {
      // Delivery owns its own reconnect/outbox behavior. Never let Discord availability hold
      // quick-run cleanup or daemon shutdown open indefinitely.
      void Promise.resolve(deps.onDetachedResult(run)).catch((error) =>
        logger.error("quick detached-result delivery failed", { runId: run.runId, error: String(error) }),
      );
    }
  }

  function baseEnv(): Record<string, string | undefined> {
    const env = childEnv();
    const home = process.env.HOME ?? "";
    const extra = [join(home, ".local/bin"), join(home, ".bun/bin")].join(":");
    env.PATH = env.PATH ? `${extra}:${env.PATH}` : extra;
    return env;
  }

  function spawnRun(entry: LiveRun, input: string): Promise<void> {
    const { run, runDir, systemPrompt } = entry;
    const args = [
      "-p",
      input,
      "--output-format",
      "text",
      "--permission-mode",
      config.harness.claude.permission_mode,
      "--model",
      config.quick.model,
      "--append-system-prompt",
      systemPrompt,
    ];
    if (config.quick.effort) args.push("--effort", config.quick.effort);

    logger.info("quick run starting", { runId: run.runId, agent: run.agent, cwd: runDir });
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = spawn({
        cmd: [config.harness.claude.bin, ...args],
        cwd: runDir,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: baseEnv(),
      });
      entry.child = child;
    } catch (error) {
      return finalize(entry, "error", `quick spawn failed: ${(error as Error).message}`);
    }

    entry.hardTimer = setTimeout(() => {
      if (run.state !== "running" || entry.child !== child) return;
      logger.warn("quick run hit hard timeout - killing", { runId: run.runId, agent: run.agent });
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      void finalize(entry, "timeout", `The run timed out after ${config.quick.hard_timeout_secs}s and was killed.`);
    }, config.quick.hard_timeout_secs * 1000);

    return (async () => {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout as ReadableStream).text().catch(() => ""),
        new Response(child.stderr as ReadableStream).text().catch(() => ""),
        child.exited,
      ]);
      if (entry.child !== child || run.state !== "running") return;
      if (entry.hardTimer) clearTimeout(entry.hardTimer);
      entry.hardTimer = null;
      entry.child = null;
      if (code !== 0) {
        await finalize(
          entry,
          "error",
          `Agent exited with code ${code}${stderr.trim() ? ` - ${truncate(stderr.trim(), 500)}` : ""}`,
        );
        return;
      }
      const report = stdout.trim();
      await finalize(entry, report ? "done" : "error", report || "Agent exited cleanly but produced no report.");
    })().catch((error) => finalize(entry, "error", `Run collapsed: ${String(error)}`));
  }

  return {
    agents() {
      return QUICK_AGENTS.map((agent) => ({ name: agent.name, description: agent.description }));
    },

    async run(agentName, task, channelId, requesterId = null) {
      if (!config.quick.enabled) throw new Error("quick agents are disabled ([quick] enabled=false)");
      const agent = findAgent(agentName);
      if (!agent) {
        if (agentName === "computer-use") {
          throw new Error('computer-use moved to the dedicated browser agent - use `beckett browser "<task>"` instead');
        }
        throw new Error(`unknown quick agent "${agentName}" (use ${QUICK_AGENTS.map((a) => a.name).join("|")})`);
      }
      if (!task.trim()) throw new Error("quick run needs a non-empty task");
      if (live.size >= config.quick.max_concurrent) {
        throw new Error(`quick lane is full (${live.size}/${config.quick.max_concurrent} running) - retry shortly or deploy a run`);
      }

      const runId = randomUUID();
      const runDir = join(quickDir, runId);
      mkdirSync(runDir, { recursive: true, mode: 0o700 });
      const systemPrompt = readFileSync(join(PROMPTS_DIR, agent.promptFile), "utf8");
      const run: QuickRun = {
        runId,
        agent: agent.name,
        task,
        channelId,
        requesterId,
        startedAt: Date.now(),
        finishedAt: null,
        state: "running",
        result: null,
        detached: false,
      };
      const entry: LiveRun = {
        run,
        agent,
        runDir,
        systemPrompt,
        child: null,
        hardTimer: null,
      };
      live.set(runId, entry);
      const settled = spawnRun(entry, task);

      await Promise.race([settled, Bun.sleep(config.quick.sync_wait_secs * 1000)]);
      if (run.state !== "running") {
        return {
          done: true,
          state: run.state as "done" | "error" | "timeout",
          result: run.result ?? "",
          runId,
        };
      }
      run.detached = true;
      logger.info("quick run detached - result will arrive as an update turn", { runId });
      return { detached: true, runId };
    },

    stats() {
      const all = [...[...live.values()].map((entry) => entry.run), ...recent];
      return {
        running: [...live.values()].filter((entry) => entry.run.state === "running").length,
        runs: all.map((run) => ({ runId: run.runId, agent: run.agent, state: run.state, startedAt: run.startedAt })),
      };
    },

    async stopAll() {
      await Promise.all(
        [...live.values()].map(async (entry) => {
          try {
            entry.child?.kill("SIGTERM");
          } catch {
            // best effort
          }
          await finalize(entry, "error", "Daemon shut down before the run finished.");
        }),
      );
    },
  };
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}
