/**
 * Beckett — `beckett task deploy` (`src/cli/task-deploy.ts`)
 * =======================================================================================
 * v7's ONE call that replaces ticket ceremony: the concierge (or a human) hands this a prompt,
 * it files a Run (state "queued") in the run ledger and pings the bus once — no tracker, no
 * poller. `RunSupervisor` (daemon-side, a separate lane) picks the ping up and does the rest
 * (worktree, spec.md, worker spawn).
 *
 * Testability mirrors `finish.ts`'s split: `parseTaskDeployArgs`/`deployRun` are pure(ish) and
 * throw `TaskDeployUsageError` on a bad invocation; `runTaskDeploy` is the thin `out()`/`fail()`
 * wrapper the CLI dispatch actually calls, so tests exercise the decision logic directly instead
 * of spawning a subprocess or fighting `process.exit`.
 *
 * INTEGRATION NOTE (W1A owns the real store): this module is written against a minimal local
 * `RunStoreLike` typed to the `Run` contract in `../run/types.ts`. It assumes `store.create()`
 * takes a FULLY-FORMED `Run` (this module mints id/slug/branch/sessionName itself, so `--dry`
 * can build and print the exact same object without touching the store) and just persists +
 * returns it — see `runId()`/`buildRun()` below. If W1A's real `RunStore.create()` instead wants
 * a partial input and mints its own id, the integrator only has to adjust the one `store.create`
 * call site in {@link deployRun}, not this file's argv/validation/output contract.
 */
import { readFileSync } from "node:fs";
import type { Casting } from "../tracker/types.ts";
import { parseCastJson, validateCasting } from "../tracker/cast.ts";
import type { Run, RunStage } from "../run/types.ts";
import { fail, out, parse } from "./io.ts";

const RUN_STAGES: ReadonlySet<RunStage> = new Set(["implement", "review"]);
const SLUG_MAX = 40;
const TITLE_WORD_COUNT = 8;

export const TASK_DEPLOY_USAGE =
  'usage: beckett task deploy --prompt <text>|--prompt-file <path> [--title <t>] [--channel <id>] ' +
  '[--requester <id>] [--ultracode] [--cast <json>] [--repo <slug>] [--task <#N.x>] [--dry]';

/** A usage problem, raised so {@link runTaskDeploy} owns the single `fail()` (helpers stay testable). */
export class TaskDeployUsageError extends Error {}

function usage(msg: string): never {
  throw new TaskDeployUsageError(`${msg}\n${TASK_DEPLOY_USAGE}`);
}

/** The minimal slice of the real `RunStore` (W1A, `../run/store.ts`) this CLI needs. */
export interface RunStoreLike {
  create(run: Run): Promise<Run>;
}

export interface TaskDeployDeps {
  store: RunStoreLike;
  /** Same bus-notify helper `task start` uses (`core.ts`'s `notifyBus`), injected for testing. */
  notifyBus: (cmd: string, args: Record<string, unknown>) => Promise<void>;
  /** Injectable clock so tests get deterministic ids/timestamps. */
  now?: () => Date;
}

export interface TaskDeployOutput {
  runId: string;
  sessionName: string;
  branch: string;
  specPath: null;
  state: "queued";
}

interface TaskDeployInput {
  prompt: string;
  title: string;
  slug: string;
  channelId: string | null;
  requesterId: string | null;
  ultracode: boolean;
  cast: Casting | null;
  repo: string | null;
  taskRef: string | null;
  dry: boolean;
}

/** kebab-case a title into a run slug: lowercase, `[a-z0-9-]` only, ≤40 chars, no dangling dash. */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
  return slug || "run";
}

/** Default title when `--title` is omitted: the first ~8 words of the prompt. */
function defaultTitle(prompt: string): string {
  const words = prompt.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, TITLE_WORD_COUNT).join(" ");
}

/** Cast validation reuses the existing zod-backed `Casting` path (`tracker/cast.ts`) and layers
 * on ONE more rule specific to runs: a run only ever casts `implement`/`review`, so an
 * otherwise-valid ticket-style cast naming e.g. `design` is refused, not silently dropped. */
function resolveCast(raw: string | boolean | undefined): Casting | null {
  if (raw === undefined) return null;
  const casting = parseCastJson(String(raw));
  const errors = [...validateCasting(casting)];
  for (const stage of Object.keys(casting)) {
    if (!RUN_STAGES.has(stage as RunStage)) {
      errors.push(`${stage}: unknown stage — a run only casts implement|review`);
    }
  }
  if (errors.length > 0) {
    usage(`refusing to deploy a broken cast:\n  - ${errors.join("\n  - ")}`);
  }
  return Object.keys(casting).length > 0 ? casting : null;
}

function resolvePrompt(flags: Record<string, string | boolean>): string {
  if (typeof flags.prompt === "string" && flags.prompt.trim()) return flags.prompt.trim();
  if (typeof flags["prompt-file"] === "string") {
    let text: string;
    try {
      text = readFileSync(flags["prompt-file"], "utf8");
    } catch (err) {
      usage(`--prompt-file ${flags["prompt-file"]}: ${(err as Error).message}`);
    }
    if (!text.trim()) usage(`--prompt-file ${flags["prompt-file"]} is empty`);
    return text.trim();
  }
  usage("--prompt <text> or --prompt-file <path> is required");
}

/** Parse + validate `beckett task deploy`'s argv. Pure aside from an optional `--prompt-file` read. */
export function parseTaskDeployArgs(argv: string[]): TaskDeployInput {
  const { flags } = parse(argv);
  const prompt = resolvePrompt(flags);
  const title = typeof flags.title === "string" && flags.title.trim() ? flags.title.trim() : defaultTitle(prompt);
  if (!title) usage("could not derive a title from the prompt — pass --title explicitly");
  const taskRefRaw = flags.task !== undefined ? String(flags.task).trim() : "";
  return {
    prompt,
    title,
    slug: slugify(title),
    channelId: flags.channel !== undefined ? String(flags.channel) : null,
    requesterId: flags.requester !== undefined ? String(flags.requester) : null,
    ultracode: Boolean(flags.ultracode),
    cast: resolveCast(flags.cast),
    repo: flags.repo !== undefined ? String(flags.repo) : null,
    taskRef: taskRefRaw ? (taskRefRaw.startsWith("#") ? taskRefRaw : `#${taskRefRaw}`) : null,
    dry: Boolean(flags.dry),
  };
}

/** `run-YYYYMMDD-<slug>` — date + slug, per the Run contract (`../run/types.ts`). */
function runId(slug: string, now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `run-${y}${m}${d}-${slug}`;
}

function buildRun(input: TaskDeployInput, now: Date): Run {
  const iso = now.toISOString();
  return {
    id: runId(input.slug, now),
    slug: input.slug,
    title: input.title,
    prompt: input.prompt,
    channelId: input.channelId,
    requesterId: input.requesterId,
    taskRef: input.taskRef,
    ultracode: input.ultracode,
    cast: input.cast,
    repo: input.repo,
    state: "queued",
    createdAt: iso,
    updatedAt: iso,
    workspace: null,
    branch: `beckett/run-${input.slug}`,
    baseSha: null,
    sessionIds: {},
    sessionName: `beckett-run-${input.slug}`,
    reviewCycles: 0,
    prUrl: null,
    error: null,
  };
}

function outputOf(run: Run): TaskDeployOutput {
  return { runId: run.id, sessionName: run.sessionName, branch: run.branch, specPath: null, state: "queued" };
}

/**
 * The decision logic behind `beckett task deploy`, minus the `out()`/`process.exit` — parse argv,
 * mint the Run, and (unless `--dry`) persist it + ping the bus, exactly once. Throws
 * {@link TaskDeployUsageError} on a bad invocation; the caller ({@link runTaskDeploy}) is the only
 * one that turns that into `fail()`.
 */
export async function deployRun(argv: string[], deps: TaskDeployDeps): Promise<TaskDeployOutput> {
  const input = parseTaskDeployArgs(argv);
  const now = deps.now ? deps.now() : new Date();
  const run = buildRun(input, now);
  if (input.dry) return outputOf(run);
  const created = await deps.store.create(run);
  await deps.notifyBus("run.deploy", { runId: created.id, channelId: created.channelId });
  return outputOf(created);
}

/** The verb: JSON on stdout, `error: …` on stderr — same contract as every other CLI verb. */
export async function runTaskDeploy(argv: string[], deps: TaskDeployDeps): Promise<void> {
  try {
    const result = await deployRun(argv, deps);
    out(result);
  } catch (err) {
    if (err instanceof TaskDeployUsageError) fail(err.message);
    throw err;
  }
}
