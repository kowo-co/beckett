/**
 * Beckett — bench harness runner (`bench/harness/run.ts`)
 * =======================================================================================
 * Measures what a change to BECKETT'S OWN HARNESS does to worker outcomes. Each bench task
 * is a tiny self-contained repo plus a prompt plus a `check.sh` that decides, objectively,
 * whether the worker solved it. The runner drives the real production {@link ClaudeDriver} —
 * not a `claude -p` shell-out — so what it measures is the contract the dispatcher actually
 * ships against.
 *
 *   bun bench/harness/run.ts                         # run the default suite
 *   bun bench/harness/run.ts --task fix-bug          # one task
 *   bun bench/harness/run.ts --compare abc123 def456 # diff two runs
 *
 * Deliberately NOT wired up:
 * - no `systemAppend`, no scope-guard `--settings`, no `--mcp-config` — the point is the bare
 *   driver contract. A harness experiment edits production code and re-runs; it never
 *   configures the bench.
 * - no dispatcher imports. The runner carries its own copy of the done-schema rather than
 *   reaching into `src/dispatch/`.
 *
 * Two lifecycle facts the driver imposes on this file, both load-bearing:
 * - `abort()` marks the worker terminal BEFORE killing the child, and the exit handler only
 *   synthesizes a `finished` event when the worker is NOT terminal. An aborted run therefore
 *   never emits `finished` — the per-task timeout MUST be a race, never a bare await.
 * - `BaseDriver` arms a watchdog interval cleared only on a terminal state, so every task
 *   ends in `abort()` (idempotent, safe after a natural finish) or this process never exits.
 */

import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { defaultConfig } from "../../src/config.ts";
import { ClaudeDriver } from "../../src/drivers/claude.ts";
import type { Config, Effort, SpawnSpec, WorkerEvent, WorkerSpend } from "../../src/types.ts";
import {
  parseResultsJsonl,
  renderCompareTable,
  renderRunTable,
  type TaskResult,
} from "./format.ts";

const HARNESS_DIR = import.meta.dir;
const REPO_ROOT = resolve(HARNESS_DIR, "..", "..");
const RESULTS_DIR = join(HARNESS_DIR, "results");
const DEFAULT_SUITE = join(HARNESS_DIR, "suites", "default");
const CHECK_TIMEOUT_MS = 120_000;
const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh"];

/** Same shape as the (unexported) DONE_SCHEMA in src/dispatch/spawn.ts — do not import dispatcher code. */
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

const USAGE = `beckett bench harness — measure harness changes against fixed tasks

  bun bench/harness/run.ts [options]
  bun bench/harness/run.ts --compare <runA> <runB>

Options:
  --run-id <id>     name this run (default: git short sha, +"-dirty", +"-2" on collision).
                    An explicit id is used verbatim; an existing results file is APPENDED to.
  --suite <name>    suite name under bench/harness/suites, or a path (default: default)
  --task <id>       run only this task; repeatable
  --parallel <n>    concurrent tasks (default 1 — see README on shared rate limits)
  --work-dir <dir>  stage workspaces here instead of a temp dir
  --keep-work       do not delete each task's workspace after it runs
  --compare         compare two results files (two positionals: run ids or paths)
  --help            print this

Results append to bench/harness/results/<runId>.jsonl (git-ignored).
Exit code: 0 when every executed task solved, 1 otherwise.`;

/** One bench task: a fixture repo + a prompt + the objective check that grades it. */
export interface BenchTask {
  id: string;
  prompt: string;
  model: string;
  effort: Effort;
  timeoutS: number;
  dir: string;
}

export function loadSuite(suiteDir: string): BenchTask[] {
  if (!existsSync(suiteDir)) throw new Error(`bench: suite dir ${suiteDir} does not exist`);
  const entries = readdirSync(suiteDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  return entries.map((name) => {
    const dir = join(suiteDir, name);
    for (const required of ["task.json", "check.sh", "fixture"]) {
      if (!existsSync(join(dir, required))) {
        throw new Error(`bench: task dir ${dir} is missing ${required}`);
      }
    }

    const file = join(dir, "task.json");
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`bench: ${file} is not valid JSON: ${(e as Error).message}`);
    }

    const id = raw.id;
    if (typeof id !== "string" || id === "") throw new Error(`bench: ${file} field "id" must be a non-empty string`);
    if (id !== name) throw new Error(`bench: ${file} field "id" is "${id}" but the dir is "${name}"`);

    const prompt = raw.prompt;
    if (typeof prompt !== "string" || prompt === "") {
      throw new Error(`bench: ${file} field "prompt" must be a non-empty string`);
    }

    const model = raw.model;
    if (typeof model !== "string") throw new Error(`bench: ${file} field "model" must be a string`);

    const effort = raw.effort;
    if (typeof effort !== "string" || !EFFORTS.includes(effort as Effort)) {
      throw new Error(`bench: ${file} field "effort" must be one of ${EFFORTS.join("|")}`);
    }

    const timeoutS = raw.timeout_s;
    if (typeof timeoutS !== "number" || !Number.isFinite(timeoutS) || timeoutS < 30) {
      throw new Error(`bench: ${file} field "timeout_s" must be a number >= 30`);
    }

    return { id, prompt, model, effort: effort as Effort, timeoutS, dir };
  });
}

function git(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    ok: p.exitCode === 0,
    stdout: p.stdout.toString(),
    stderr: p.stderr.toString(),
  };
}

export function deriveRunId(): string {
  const head = git(["rev-parse", "--short", "HEAD"], REPO_ROOT);
  let base = head.ok ? head.stdout.trim() : "norepo";
  if (base === "") base = "norepo";

  const status = git(["status", "--porcelain"], REPO_ROOT);
  if (status.ok && status.stdout.trim() !== "") base += "-dirty";

  let runId = base;
  let n = 1;
  while (existsSync(join(RESULTS_DIR, `${runId}.jsonl`))) {
    n += 1;
    runId = `${base}-${n}`;
  }
  return runId;
}

/**
 * Stage a fresh workspace for one task: fixture copy, `.tmpl` suffixes stripped (fixture test
 * files can't be named `*.test.ts` on disk or the repo's own `bun test` would collect a suite
 * that fails BY DESIGN), a real git repo (the worker expects one, and `getTelemetry` shells
 * `git diff` there), and the done-schema scaffold under a git-excluded `.beckett/`.
 */
export function stageWorkspace(task: BenchTask, workRoot: string): string {
  const ws = join(workRoot, task.id);
  rmSync(ws, { recursive: true, force: true });
  cpSync(join(task.dir, "fixture"), ws, { recursive: true });

  for (const entry of readdirSync(ws, { recursive: true })) {
    if (typeof entry !== "string" || !entry.endsWith(".tmpl")) continue;
    const p = join(ws, entry);
    renameSync(p, p.slice(0, -".tmpl".length));
  }

  const steps: string[][] = [
    ["init", "-q"],
    ["config", "user.email", "bench@beckett.local"],
    ["config", "user.name", "beckett-bench"],
  ];
  for (const step of steps) {
    const r = git(step, ws);
    if (!r.ok) throw new Error(`bench: git ${step.join(" ")} failed in ${ws}: ${r.stderr.trim()}`);
  }

  writeFileSync(join(ws, ".git", "info", "exclude"), ".beckett/\n");

  for (const step of [["add", "-A"], ["commit", "-q", "-m", `bench fixture: ${task.id}`]]) {
    const r = git(step, ws);
    if (!r.ok) throw new Error(`bench: git ${step.join(" ")} failed in ${ws}: ${r.stderr.trim()}`);
  }

  mkdirSync(join(ws, ".beckett"), { recursive: true });
  writeFileSync(join(ws, ".beckett", "done-schema.json"), JSON.stringify(DONE_SCHEMA, null, 2));

  return ws;
}

export async function runTask(
  task: BenchTask,
  ws: string,
  config: Config,
): Promise<Omit<TaskResult, "runId" | "suite">> {
  const driver = new ClaudeDriver(config);

  // Subscribe BEFORE spawning: spawn resolves at the system/init handshake, and events that
  // land during it would otherwise be missed.
  let finishedEvt: Extract<WorkerEvent, { kind: "finished" }> | null = null;
  let resolveFinished!: () => void;
  const finishedP = new Promise<void>((r) => (resolveFinished = r));
  driver.onEvent((e) => {
    if (e.kind === "finished" && !finishedEvt) {
      finishedEvt = e;
      resolveFinished();
    }
  });

  const spec: SpawnSpec = {
    workerId: `bench-${task.id}`,
    prompt: task.prompt,
    systemAppend: "", // measure the bare harness; buildArgs skips the flag when blank
    workspace: ws,
    scope: { ownedGlobs: [], readGlobs: null, description: `bench task ${task.id}` },
    envelope: { effort: task.effort, turnCap: 100, wallClockS: task.timeoutS, network: true },
    model: task.model, // "" falls through to config.harness.claude.default_model
    doneSchemaPath: join(ws, ".beckett", "done-schema.json"),
  };

  const startedAt = new Date();
  const t0 = Date.now();
  let spawnFailed = false;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tel: WorkerSpend;
  let sessionId: string | null = null;

  try {
    try {
      await driver.spawn(spec);
    } catch (e) {
      spawnFailed = true;
      console.error(`  spawn failed: ${(e as Error).message}`);
    }

    if (!spawnFailed) {
      // A bare `await finishedP` would hang forever on an aborted worker (abort() goes terminal
      // before the kill, so no finished event is ever synthesized). Race, always.
      const timeoutP = new Promise<void>((r) => {
        timer = setTimeout(r, task.timeoutS * 1000);
      });
      await Promise.race([finishedP, timeoutP]);
      if (!finishedEvt) timedOut = true;
    }

    clearTimeout(timer);
    tel = driver.getTelemetry();
    sessionId = driver.currentSessionId;
  } finally {
    clearTimeout(timer);
    // Always — this kills any surviving child tree and clears the watchdog interval.
    await driver.abort(timedOut ? "bench: task timeout" : "bench: run complete");
  }

  const wallClockMs = Date.now() - t0;

  const check = Bun.spawnSync(["bash", join(task.dir, "check.sh")], {
    cwd: ws,
    stdout: "pipe",
    stderr: "pipe",
    timeout: CHECK_TIMEOUT_MS,
  });
  const solved = check.exitCode === 0;
  if (!solved) {
    const output = (check.stdout.toString() + check.stderr.toString()).trimEnd();
    for (const line of output.split("\n")) console.log(`  check: ${line}`);
  }

  const evt: Extract<WorkerEvent, { kind: "finished" }> | null = finishedEvt;
  return {
    taskId: task.id,
    model: task.model || config.harness.claude.default_model,
    effort: task.effort,
    solved,
    timedOut,
    spawnFailed,
    finishedStatus: evt?.status ?? null,
    finishedSubtype: evt?.subtype ?? null,
    errorClass: evt?.errorClass ?? null,
    turns: tel.turns,
    toolCalls: tel.toolCalls,
    tokens: tel.tokens,
    usd: tel.usdEstimate,
    wallClockMs,
    sessionId,
    startedAt: startedAt.toISOString(),
  };
}

function resolveSuiteDir(name: string | undefined): string {
  if (!name) return DEFAULT_SUITE;
  const named = join(HARNESS_DIR, "suites", name);
  return existsSync(named) ? named : resolve(name);
}

function resolveResultsPath(idOrPath: string): string {
  const named = join(RESULTS_DIR, `${idOrPath}.jsonl`);
  return existsSync(named) ? named : resolve(idOrPath);
}

function compareMode(positionals: string[]): void {
  if (positionals.length !== 2) {
    throw new Error(`--compare needs exactly two results files (got ${positionals.length})`);
  }
  const [pa, pb] = positionals.map(resolveResultsPath) as [string, string];
  const a = parseResultsJsonl(readFileSync(pa, "utf8"));
  const b = parseResultsJsonl(readFileSync(pb, "utf8"));
  const label = (p: string): string => basename(p).replace(/\.jsonl$/, "");
  console.log(renderCompareTable(a, b, { a: label(pa), b: label(pb) }));
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: Bun.argv.slice(2),
      options: {
        "run-id": { type: "string" },
        suite: { type: "string" },
        task: { type: "string", multiple: true },
        parallel: { type: "string" },
        compare: { type: "boolean" },
        "work-dir": { type: "string" },
        "keep-work": { type: "boolean" },
        help: { type: "boolean" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    console.error(`bench: ${(e as Error).message}\n\n${USAGE}`);
    process.exit(1);
  }
  const args = parsed.values;

  if (args.help) {
    console.log(USAGE);
    return;
  }

  if (args.compare) {
    compareMode(parsed.positionals);
    return;
  }

  const parallel = args.parallel === undefined ? 1 : Number.parseInt(args.parallel, 10);
  if (!Number.isInteger(parallel) || parallel < 1) {
    throw new Error(`--parallel must be an integer >= 1 (got "${args.parallel}")`);
  }

  const config = defaultConfig();
  const suiteDir = resolveSuiteDir(args.suite);
  let tasks = loadSuite(suiteDir);
  if (args.task && args.task.length > 0) {
    const valid = tasks.map((t) => t.id);
    for (const want of args.task) {
      if (!valid.includes(want)) {
        throw new Error(`unknown task "${want}" — suite ${suiteDir} has: ${valid.join(", ")}`);
      }
    }
    tasks = tasks.filter((t) => args.task!.includes(t.id));
  }

  const runId = args["run-id"] ?? deriveRunId();
  const workRoot = args["work-dir"]
    ? (mkdirSync(args["work-dir"], { recursive: true }), resolve(args["work-dir"]))
    : mkdtempSync(join(tmpdir(), "beckett-bench-"));
  const suite = basename(suiteDir);
  const resultsPath = join(RESULTS_DIR, `${runId}.jsonl`);

  console.log(
    [
      `bench run ${runId}`,
      `  suite:     ${suiteDir}`,
      `  model:     ${config.harness.claude.default_model} (suite default)`,
      `  tasks:     ${tasks.length} (${tasks.map((t) => t.id).join(", ")})`,
      `  parallel:  ${parallel}`,
      `  work dir:  ${workRoot}`,
      "",
    ].join("\n"),
  );

  const results: TaskResult[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      const task = tasks[i];
      if (!task) return;
      console.log(`→ ${task.id} (effort ${task.effort}, timeout ${task.timeoutS}s)`);
      const ws = stageWorkspace(task, workRoot);
      try {
        const partial = await runTask(task, ws, config);
        const result: TaskResult = { runId, suite, ...partial };
        results.push(result);
        // Append per task so a crashed run keeps the results it already paid for.
        mkdirSync(RESULTS_DIR, { recursive: true });
        appendFileSync(resultsPath, JSON.stringify(result) + "\n");
        console.log(`← ${task.id}: ${result.solved ? "solved" : "not solved"}`);
      } finally {
        if (!args["keep-work"]) rmSync(ws, { recursive: true, force: true });
      }
    }
  };
  await Promise.all(Array.from({ length: parallel }, () => worker()));

  console.log(`\n${renderRunTable(results)}\n\nresults: ${resultsPath}`);
  process.exit(results.every((r) => r.solved) ? 0 : 1);
}

// `import.meta.main` matters: loadSuite/stageWorkspace are exported so they can be exercised
// without spending a token, and a bare top-level call would run the whole suite on import.
if (import.meta.main) {
  try {
    await main();
  } catch (e) {
    console.error(`bench: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
