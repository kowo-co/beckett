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
 * STORE CONTRACT: `RunStore.create()` (W1A, `../run/store.ts`) takes a PARTIAL
 * {@link CreateRunInput} and mints the run's identity itself — `id` (`run-YYYYMMDD-<slug>`),
 * `slug` (deduped `-2`/`-3`… against every run ever filed), `branch`, `sessionName`, timestamps.
 * This module therefore hands the store the resolved argv fields and reports back whatever the
 * store minted. `--dry` writes nothing, so it renders a local PREVIEW of the same shape
 * ({@link previewRun}); a preview's slug can differ from the eventually-minted one if the same
 * slug is taken by then — that is the store's dedupe doing its job, not a contract mismatch.
 */
import { readFileSync } from "node:fs";
import type { Casting } from "../tracker/types.ts";
import { validateCasting } from "../tracker/cast.ts";
import type { CreateRunInput } from "../run/store.ts";
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
  create(input: CreateRunInput): Promise<Run>;
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
 * otherwise-valid ticket-style cast naming e.g. `design` is refused, not silently dropped.
 *
 * Unlike `parseCastJson` (the ticket-hydration reader, deliberately tolerant so a corrupted
 * ticket body never crashes a poller), `--cast` is a fresh, human-typed invocation: bad JSON, a
 * typo'd harness, or an invalid effort must be REJECTED, not silently degraded to `{}` and
 * deployed on defaults. So this parses the raw string itself and runs `validateCasting` directly
 * on the parsed value — it already returns per-path zod shape errors — instead of routing through
 * the tolerant reader first. */
function resolveCast(raw: string | boolean | undefined): Casting | null {
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch (err) {
    usage(`--cast is not valid JSON: ${(err as Error).message}`);
  }
  const errors = [...validateCasting(parsed)];
  const isPlainObject = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  if (isPlainObject) {
    for (const stage of Object.keys(parsed as Record<string, unknown>)) {
      if (!RUN_STAGES.has(stage as RunStage)) {
        errors.push(`${stage}: unknown stage — a run only casts implement|review`);
      }
    }
  }
  if (errors.length > 0) {
    usage(`refusing to deploy a broken cast:\n  - ${errors.join("\n  - ")}`);
  }
  const casting = parsed as Casting;
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

/** The resolved argv fields the store needs; it mints everything else. */
function createInputOf(input: TaskDeployInput): CreateRunInput {
  return {
    title: input.title,
    prompt: input.prompt,
    slug: input.slug,
    channelId: input.channelId,
    requesterId: input.requesterId,
    taskRef: input.taskRef,
    ultracode: input.ultracode,
    cast: input.cast,
    repo: input.repo,
  };
}

/**
 * The Run `--dry` prints: what the store WOULD mint from this argv, built locally so a dry deploy
 * never touches the ledger. Mirrors `RunStore.create()`'s minting rules; only the slug-collision
 * dedupe (`-2`, `-3`, …) can't be previewed without reading the ledger.
 */
export function previewRun(input: TaskDeployInput, now: Date): Run {
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
 *
 * `--dry` returns the FULL {@link Run} object — per spec ("print the Run JSON, write nothing")
 * that's the whole operational point of `--dry`: previewing the resolved title/slug/prompt/cast/
 * taskRef before anything is persisted, not the same 5-field summary a wet deploy prints. A wet
 * deploy still returns the narrow {@link TaskDeployOutput} the concierge parses.
 */
export async function deployRun(argv: string[], deps: TaskDeployDeps): Promise<Run | TaskDeployOutput> {
  const input = parseTaskDeployArgs(argv);
  const now = deps.now ? deps.now() : new Date();
  if (input.dry) return previewRun(input, now);
  const created = await deps.store.create(createInputOf(input));
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
