/**
 * Durable user-facing task and branch registry. Runs remain an execution detail.
 *
 * WAVES. Beckett no longer opens a thread per task, so "the batch you just filed" has to be a
 * real thing the store can hand back: the user types `&recent` in a thread they opened and means
 * the set of tasks that went in together, not the single newest row. Every task therefore carries
 * a `waveId` stamped at creation.
 *
 * The grouping is inferred HERE rather than passed in by a caller, because no caller is in a
 * position to pass it: a wave reaches the store as a burst of separate `beckett task create`
 * PROCESSES, one per task, so nothing in memory ever holds the batch. What the tasks of a wave do
 * share is the clock — they are filed moments apart — and the store already sees every filing
 * under one lock, so `createTask()` joins the newest existing task's wave when the two land
 * within WAVE_WINDOW_MS of each other (see `inferWaveId`). An explicitly passed `waveId` still
 * wins, for the caller that genuinely does hold a batch (tests, a future in-process planner).
 *
 * The field is OPTIONAL in the schema on purpose: registries written before waves existed must
 * keep loading. Those rows simply have no wave, and `recentWave()` degrades to "just that task"
 * rather than silently sweeping every wave-less row into one giant batch.
 */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { z } from "zod";
import { prefixedId } from "../ids.ts";
import type { RunState } from "../run/types.ts";
import { log as rootLog } from "../log.ts";

export const TASK_TITLE_MAX = 100;
const LOCK_STALE_MS = 30_000;
const LOCK_ATTEMPTS = 200;
const START_CLAIM_STALE_MS = 5 * 60_000;

/**
 * How close together two filings must land to count as the same wave.
 *
 * WHY a window is the signal: the concierge files a wave as back-to-back `beckett task create`
 * processes, so co-filing is the ONLY thing the tasks of a batch have in common by the time they
 * reach the registry — there is no shared caller, session, or channel to key on.
 *
 * WHY 20s: the real gap between those spawns is well under a second, and a couple of seconds at
 * worst when the box is loaded or the CLI pays a cold start, so 20s is an order of magnitude of
 * headroom — a slow spawn cannot split a wave in half. It is also far under any human filing
 * rhythm: someone who files a task, thinks, and files an unrelated one minutes later gets two
 * waves, which is exactly what `&recent` has to mean for them.
 *
 * WHY measured against the NEWEST task rather than the wave's first: it chains, so a long burst
 * stays one wave as long as each filing lands within 20s of the previous one. The cost is that a
 * sustained trickle of unrelated tasks under 20s apart would chain into one wave — accepted,
 * because nothing files that way, and the alternative (window from the wave's first task) has the
 * worse failure: it splits a legitimately slow burst, which is the case this feature exists for.
 */
const WAVE_WINDOW_MS = 20_000;

export type TaskStatus = "active" | "paused" | "done" | "cancelled";
export type TaskBranchStatus =
  | "ready"
  | "waiting"
  | "designing"
  | "approval"
  | "running"
  | "review"
  | "blocked"
  | "done"
  | "cancelled";

/**
 * What a started branch points at: one run in the run ledger (`<beckettDir>/runs.json`).
 *
 * This replaced a five-field tracker link (`{id, identifier, board, projectId, url}`) — a board id
 * and a deep link into a service that no longer exists. A run id is the whole reference: it is the
 * journal ident, the spend key, the dispatch-event key, and the CLI handle (`beckett task show
 * <runId>`), so one string reaches everything the old five did.
 */
const RunLinkSchema = z.object({ runId: z.string().min(1) });

const GitLinkSchema = z.object({
  project: z.string().min(1),
  workspace: z.string().optional(),
  gitRef: z.string().optional(),
  baseSha: z.string().optional(),
});

const PullRequestLinkSchema = z.object({
  repo: z.string().min(1),
  number: z.number().int().positive(),
  url: z.string().min(1),
  /** Live PR state from GitHub. Absent on rows written before #104 — treated as still-open. */
  state: z.enum(["OPEN", "CLOSED", "MERGED"]).optional(),
});

const PublicationLinkSchema = z.object({
  repo: z.string().min(1),
  url: z.string().min(1),
  kind: z.enum(["pushed", "pr"]),
});

const PreviewLinkSchema = z.object({
  /** The externally-reachable preview URL (https://<slug>-preview.<apex>). */
  url: z.string().min(1),
  /** The bare hostname, for teardown. */
  host: z.string().min(1),
  updatedAt: z.string(),
});

const DiffSummarySchema = z.object({
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  commits: z.number().int().nonnegative(),
  updatedAt: z.string(),
});

/** One hosted screenshot on a branch's card gallery reel. CDN URLs are evergreen; no teardown. */
const CardImageSchema = z.object({
  url: z.string().min(1),
  description: z.string().optional(),
  updatedAt: z.string(),
});

const TaskBranchSchema = z.object({
  id: z.string().min(1),
  ref: z.string().regex(/^\d+(?:\.\d+)+$/),
  path: z.array(z.number().int().positive()).min(1),
  title: z.string().min(1),
  status: z.enum(["ready", "waiting", "designing", "approval", "running", "review", "blocked", "done", "cancelled"]),
  parentRef: z.string().optional(),
  needs: z.array(z.string()).default([]),
  run: RunLinkSchema.optional(),
  git: GitLinkSchema.optional(),
  pullRequest: PullRequestLinkSchema.optional(),
  publication: PublicationLinkSchema.optional(),
  diff: DiffSummarySchema.optional(),
  /** A live, externally-reachable preview of this branch's frontend while it is in review. */
  preview: PreviewLinkSchema.optional(),
  /** Hosted screenshots of the branch's built frontend, rendered as the task card's gallery. */
  images: z.array(CardImageSchema).optional(),
  /**
   * Discord user ids (resolved once, at `task start`) to ping on every automated update this
   * branch's work reports into its channel (issue #10). Overrides the task-level default below —
   * absent means "inherit the task's pings", `[]` means "explicitly no pings for this branch".
   */
  pings: z.array(z.string()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * The one self-editing Discord card for this task (#104): its message id and the channel it lives
 * in, persisted so an edit survives a daemon restart. Optional — pre-card registries still parse,
 * and a task filed with no channel to report into never gets one.
 */
const TaskCardSchema = z.object({
  channelId: z.string().min(1),
  messageId: z.string().min(1),
  /**
   * The card RENDERER version that posted this message. Discord's Components V2 flag is immutable
   * per message, so a card posted by an older renderer can never be edited into the new shape —
   * the service reposts instead. Absent means a pre-versioning (legacy embed) card.
   */
  v: z.number().int().positive().optional(),
  updatedAt: z.string(),
});

const TaskSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string().min(1),
  status: z.enum(["active", "paused", "done", "cancelled"]),
  originChannelId: z.string().optional(),
  threadId: z.string().optional(),
  project: z.string().optional(),
  // Optional so pre-wave registries still parse; stamped on every task created from here on.
  waveId: z.string().optional(),
  card: TaskCardSchema.optional(),
  /** Discord user ids resolved from `--ping` at `task create` (issue #10) — the task-level default
   *  every branch's automated updates ping unless a branch sets its own (see TaskBranch.pings). */
  pings: z.array(z.string()).optional(),
  branches: z.array(TaskBranchSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const RegistrySchema = z.object({
  version: z.literal(1),
  nextTaskNumber: z.number().int().positive(),
  tasks: z.array(TaskSchema),
  startClaims: z.record(z.string(), z.object({ token: z.string().min(1), createdAt: z.string() })).default({}),
});

export type TaskCard = z.infer<typeof TaskCardSchema>;
export type TaskRunLink = z.infer<typeof RunLinkSchema>;
export type TaskGitLink = z.infer<typeof GitLinkSchema>;
export type TaskPullRequestLink = z.infer<typeof PullRequestLinkSchema>;
export type TaskPublicationLink = z.infer<typeof PublicationLinkSchema>;
export type TaskPreviewLink = z.infer<typeof PreviewLinkSchema>;
export type TaskDiffSummary = z.infer<typeof DiffSummarySchema>;
export type TaskBranch = z.infer<typeof TaskBranchSchema>;
export type WorkTask = z.infer<typeof TaskSchema>;
type TaskRegistry = z.infer<typeof RegistrySchema>;

export interface TaskStoreOptions {
  now?: () => Date;
  id?: () => string;
  sleep?: (ms: number) => Promise<void>;
}

export function normalizeTaskTitle(raw: string): string {
  const title = raw.replace(/\s+/g, " ").trim();
  if (!title) throw new Error("task title cannot be empty");
  return title.slice(0, TASK_TITLE_MAX);
}

export function normalizeTaskNumber(raw: string | number): number {
  const text = String(raw).trim().replace(/^#/, "");
  if (!/^\d+$/.test(text) || Number(text) < 1) throw new Error(`invalid task reference "${raw}"`);
  return Number(text);
}

export function normalizeBranchRef(raw: string): string {
  const ref = raw.trim().replace(/^#/, "");
  if (!/^\d+(?:\.\d+)+$/.test(ref)) throw new Error(`invalid branch reference "${raw}"`);
  return ref;
}

export function displayTaskName(task: Pick<WorkTask, "number" | "title">): string {
  return `#${task.number} - ${task.title}`;
}

/**
 * The ping list that actually applies to one branch's automated updates (issue #10): the branch's
 * own list when it has one (even `[]`, an explicit opt-out), else the task's default.
 */
export function effectivePings(task: Pick<WorkTask, "pings">, branch: Pick<TaskBranch, "pings">): string[] {
  return branch.pings ?? task.pings ?? [];
}

/**
 * How a run's lifecycle shows up on its task branch. `failed`/`parked` both land on `blocked`: from
 * the board's point of view they are the same fact — the work stopped and a human has to look.
 */
export function branchStatusForRun(state: RunState): TaskBranchStatus {
  switch (state) {
    case "queued": return "ready";
    case "implementing": return "running";
    case "reviewing":
    case "publishing": return "review";
    case "done": return "done";
    case "cancelled": return "cancelled";
    case "failed":
    case "parked":
    case "awaiting_input": return "blocked";
  }
}

export class TaskStore {
  private readonly lockPath: string;
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(readonly path: string, opts: TaskStoreOptions = {}) {
    this.lockPath = `${path}.lock`;
    this.now = opts.now ?? (() => new Date());
    this.id = opts.id ?? randomUUID;
    this.sleep = opts.sleep ?? ((ms) => Bun.sleep(ms));
  }

  list(): WorkTask[] {
    return structuredClone(this.read().tasks).sort((a, b) => a.number - b.number);
  }

  getTask(ref: string | number): WorkTask | null {
    const number = normalizeTaskNumber(ref);
    return structuredClone(this.read().tasks.find((task) => task.number === number) ?? null);
  }

  getBranch(ref: string): { task: WorkTask; branch: TaskBranch } | null {
    const normalized = normalizeBranchRef(ref);
    const taskNumber = Number(normalized.split(".")[0]);
    const task = this.read().tasks.find((candidate) => candidate.number === taskNumber);
    const branch = task?.branches.find((candidate) => candidate.ref === normalized);
    return task && branch ? structuredClone({ task, branch }) : null;
  }

  /**
   * The batch behind `&recent`: every task sharing the waveId of the most recently CREATED task.
   *
   * Deliberately status-blind. A wave that already finished is still the most recent wave, and a
   * user who opens a thread and asks for it wants the finished work reported there — filtering to
   * `active` would hand back an empty set exactly when the batch just landed. Recency is by
   * createdAt (the filing moment), NOT updatedAt, so a late status flip on an old task cannot
   * hijack `&recent`; ties (a batch filed inside one clock tick) break on number descending.
   */
  recentWave(): WorkTask[] {
    const tasks = this.read().tasks;
    const head = newestTask(tasks);
    if (!head) return [];
    // A pre-wave row has no id to group by; it is its own wave rather than a bucket that would
    // collect every other legacy row.
    if (!head.waveId) return structuredClone([head]);
    const wave = tasks.filter((task) => task.waveId === head.waveId);
    return structuredClone(wave.sort((a, b) => a.number - b.number));
  }

  /**
   * Resolve a user-typed reference — `#12`, `12`, `#12.1`, `12.1` — to the task and, for dotted
   * refs, the branch. Returns null rather than throwing: the input comes from a Discord message
   * (`&<taskRef>`), where "that isn't a task" is an ordinary answer, not an exception.
   */
  resolveTaskRef(ref: string): { task: WorkTask; branch?: TaskBranch } | null {
    const text = ref.trim();
    if (text.includes(".")) {
      let normalized: string;
      try {
        normalized = normalizeBranchRef(text);
      } catch {
        return null;
      }
      // getBranch() is null for a well-formed ref naming a branch that does not exist (#12.9 on a
      // task with one branch); do NOT fall back to the task, or the caller would attach work to a
      // batch the user did not name.
      return this.getBranch(normalized);
    }
    let number: number;
    try {
      number = normalizeTaskNumber(text);
    } catch {
      return null;
    }
    const task = this.read().tasks.find((candidate) => candidate.number === number);
    return task ? structuredClone({ task }) : null;
  }

  /** The task branch a run is executing, if any. Keyed by run id — the run's only reference. */
  findByRun(runId: string): { task: WorkTask; branch: TaskBranch } | null {
    for (const task of this.read().tasks) {
      const branch = task.branches.find((candidate) => candidate.run?.runId === runId);
      if (branch) return structuredClone({ task, branch });
    }
    return null;
  }

  /**
   * File a task. Grouping into a wave is normally INFERRED (see `inferWaveId`) — the usual caller
   * is one `beckett task create` process out of a burst and has no batch id to offer. `waveId` is
   * for the rare caller that genuinely holds the whole batch in memory: pass the SAME id for every
   * task of one filing and it overrides the inferred grouping outright, so a caller that knows the
   * batch is never second-guessed by the clock.
   */
  async createTask(input: {
    title: string;
    originChannelId?: string;
    project?: string;
    initialBranchTitle?: string;
    waveId?: string;
    /** Task-level default `--ping` list (issue #10); every branch inherits it unless overridden. */
    pings?: string[];
  }): Promise<{ task: WorkTask; branch: TaskBranch }> {
    return this.mutate((registry) => {
      const now = this.now().toISOString();
      const number = registry.nextTaskNumber++;
      const title = normalizeTaskTitle(input.title);
      const branch: TaskBranch = {
        id: this.id(),
        ref: `${number}.1`,
        path: [1],
        title: normalizeTaskTitle(input.initialBranchTitle ?? title),
        status: "ready",
        needs: [],
        createdAt: now,
        updatedAt: now,
      };
      const task: WorkTask = {
        id: this.id(),
        number,
        title,
        status: "active",
        ...(input.originChannelId ? { originChannelId: input.originChannelId } : {}),
        ...(input.project ? { project: input.project } : {}),
        // Inferred inside the lock that allocates `number`, off the registry as just read, so two
        // concurrent creators cannot land in different halves of the same burst.
        waveId: input.waveId ?? inferWaveId(registry.tasks, now, input.originChannelId),
        ...(input.pings && input.pings.length > 0 ? { pings: input.pings } : {}),
        branches: [branch],
        createdAt: now,
        updatedAt: now,
      };
      registry.tasks.push(task);
      return structuredClone({ task, branch });
    });
  }

  async createBranch(input: {
    task: string | number;
    title: string;
    parentRef?: string;
    needs?: string[];
    project?: string;
  }): Promise<TaskBranch> {
    return this.mutate((registry) => {
      const taskNumber = normalizeTaskNumber(input.task);
      const task = registry.tasks.find((candidate) => candidate.number === taskNumber);
      if (!task) throw new Error(`no such task: #${taskNumber}`);
      const parentRef = input.parentRef ? normalizeBranchRef(input.parentRef) : undefined;
      const parent = parentRef ? task.branches.find((candidate) => candidate.ref === parentRef) : undefined;
      if (parentRef && !parent) throw new Error(`no such parent branch: #${parentRef}`);
      const prefix = parent ? parent.path : [];
      const siblings = task.branches.filter((branch) =>
        branch.path.length === prefix.length + 1 && prefix.every((part, index) => branch.path[index] === part)
      );
      const next = Math.max(0, ...siblings.map((branch) => branch.path.at(-1) ?? 0)) + 1;
      const path = [...prefix, next];
      const ref = `${task.number}.${path.join(".")}`;
      const needs = [...new Set((input.needs ?? []).map(normalizeBranchRef))];
      for (const need of needs) {
        if (!task.branches.some((candidate) => candidate.ref === need)) throw new Error(`no such dependency branch: #${need}`);
        if (need === ref) throw new Error(`branch #${ref} cannot depend on itself`);
      }
      const now = this.now().toISOString();
      const branch: TaskBranch = {
        id: this.id(),
        ref,
        path,
        title: normalizeTaskTitle(input.title),
        status: needs.length ? "waiting" : "ready",
        ...(parent ? { parentRef: parent.ref } : {}),
        needs,
        ...(input.project ? { git: { project: input.project } } : {}),
        createdAt: now,
        updatedAt: now,
      };
      task.branches.push(branch);
      task.status = "active";
      task.updatedAt = now;
      return structuredClone(branch);
    });
  }

  async setThread(taskRef: string | number, threadId: string, parentChannelId?: string): Promise<WorkTask> {
    return this.updateTask(taskRef, (task) => {
      task.threadId = threadId;
      if (parentChannelId) task.originChannelId = parentChannelId;
    });
  }

  /**
   * Record (or replace) the id + channel of this task's one self-editing card (#104). Replacing is
   * the deleted-card repost path: the old id is gone from Discord, so the fresh one overwrites it.
   */
  async setCard(taskRef: string | number, card: { channelId: string; messageId: string; v?: number }): Promise<WorkTask> {
    return this.updateTask(taskRef, (task) => {
      task.card = { ...card, updatedAt: this.now().toISOString() };
    });
  }

  /**
   * Add a hosted screenshot to a branch's card gallery reel. Dedupes by URL (a retried capture
   * of the same upload never doubles the entry) and caps the reel at ten — Discord's own media
   * gallery limit — keeping the most recent.
   */
  async addBranchImage(branchRef: string, image: { url: string; description?: string }): Promise<TaskBranch> {
    return this.updateBranch(branchRef, (branch) => {
      const existing = (branch.images ?? []).filter((entry) => entry.url !== image.url);
      existing.push({ ...image, updatedAt: this.now().toISOString() });
      branch.images = existing.slice(-10);
    });
  }

  /**
   * Bind a branch to the run executing it, and project that run's state onto the branch status.
   * Re-linking the SAME run is idempotent, which is load-bearing: `beckett task start` calls it
   * once at deploy time, and the daemon's run-engine bridge (`shell/main.ts`, the supervisor's
   * `onStateChange` hook) calls it again on EVERY transition — that repeat is what keeps the
   * board, the task card, and the branch card moving as the run works. A DIFFERENT run throws,
   * because a branch with two runs is two workers on one ref.
   */
  async linkRun(
    branchRef: string,
    link: TaskRunLink,
    state: RunState,
    project?: string,
  ): Promise<TaskBranch> {
    return this.updateBranch(branchRef, (branch) => {
      if (branch.run && branch.run.runId !== link.runId) {
        throw new Error(`branch #${branch.ref} is already linked to run ${branch.run.runId}`);
      }
      branch.run = link;
      branch.status = branchStatusForRun(state);
      // A durable diff is the prior publish attempt's final contribution. Once implementation is
      // deliberately resumed it becomes stale; clear it so live cards follow the active worktree
      // until the next pre-publication snapshot replaces it.
      if (state === "implementing") delete branch.diff;
      if (project) branch.git = { ...(branch.git ?? { project }), project };
    });
  }

  async setGit(branchRef: string, git: TaskGitLink): Promise<TaskBranch> {
    return this.updateBranch(branchRef, (branch) => {
      branch.git = { ...(branch.git ?? {}), ...git };
    });
  }

  async setPullRequest(branchRef: string, pullRequest: TaskPullRequestLink): Promise<TaskBranch> {
    return this.updateBranch(branchRef, (branch) => {
      branch.pullRequest = pullRequest;
    });
  }

  /**
   * Stamp the PR's live state onto the branch (#104). A no-op when the branch has no PR recorded,
   * so a late merge/close event on a branch we never linked cannot invent one. The task card reads
   * this to retire the Merge button once the PR is MERGED/CLOSED.
   */
  async setPullRequestState(branchRef: string, state: "OPEN" | "CLOSED" | "MERGED"): Promise<TaskBranch> {
    return this.updateBranch(branchRef, (branch) => {
      if (branch.pullRequest) branch.pullRequest.state = state;
    });
  }

  async setPublication(branchRef: string, publication: TaskPublicationLink): Promise<TaskBranch> {
    return this.updateBranch(branchRef, (branch) => {
      branch.publication = publication;
    });
  }

  /** Record a branch's live preview URL (surfaced while it is in review). */
  async setPreview(branchRef: string, preview: { url: string; host: string }): Promise<TaskBranch> {
    return this.updateBranch(branchRef, (branch) => {
      branch.preview = { ...preview, updatedAt: this.now().toISOString() };
    });
  }

  /** Drop a branch's preview record — the preview was torn down on land/cancel. Idempotent. */
  async clearPreview(branchRef: string): Promise<TaskBranch> {
    return this.updateBranch(branchRef, (branch) => {
      delete branch.preview;
    });
  }

  /** Claim the remote-create gap so concurrent/retried `task start` calls cannot file duplicates. */
  async reserveStart(branchRef: string): Promise<string> {
    return this.mutate((registry) => {
      const ref = normalizeBranchRef(branchRef);
      const task = registry.tasks.find((candidate) => candidate.number === Number(ref.split(".")[0]));
      const branch = task?.branches.find((candidate) => candidate.ref === ref);
      if (!branch) throw new Error(`no such branch: #${ref}`);
      if (branch.run) throw new Error(`branch #${ref} is already started as ${branch.run.runId}`);
      const existing = registry.startClaims[ref];
      const createdAt = existing ? Date.parse(existing.createdAt) : Number.NaN;
      if (existing && Number.isFinite(createdAt) && this.now().getTime() - createdAt < START_CLAIM_STALE_MS) {
        throw new Error(`branch #${ref} is already being started; wait for that request to finish`);
      }
      const token = this.id();
      registry.startClaims[ref] = { token, createdAt: this.now().toISOString() };
      return token;
    });
  }

  async releaseStart(branchRef: string, token: string): Promise<void> {
    await this.mutate((registry) => {
      const ref = normalizeBranchRef(branchRef);
      if (registry.startClaims[ref]?.token === token) delete registry.startClaims[ref];
    });
  }

  async clearStartClaim(branchRef: string): Promise<void> {
    await this.mutate((registry) => {
      delete registry.startClaims[normalizeBranchRef(branchRef)];
    });
  }

  async setDiff(branchRef: string, diff: Omit<TaskDiffSummary, "updatedAt">): Promise<TaskBranch> {
    return this.updateBranch(branchRef, (branch) => {
      branch.diff = { ...diff, updatedAt: this.now().toISOString() };
    });
  }

  /** Explicit local lifecycle update for component controls, ahead of the run's next state change. */
  async setBranchStatus(branchRef: string, status: TaskBranchStatus): Promise<TaskBranch> {
    return this.updateBranch(branchRef, (branch) => {
      branch.status = status;
    });
  }

  /**
   * `task start --ping` (issue #10): set this branch's own ping list, overriding the task-level
   * default for every automated update this branch's work reports from here on.
   */
  async setPings(branchRef: string, userIds: string[]): Promise<TaskBranch> {
    return this.updateBranch(branchRef, (branch) => {
      branch.pings = userIds;
    });
  }

  private async updateTask(ref: string | number, change: (task: WorkTask) => void): Promise<WorkTask> {
    return this.mutate((registry) => {
      const number = normalizeTaskNumber(ref);
      const task = registry.tasks.find((candidate) => candidate.number === number);
      if (!task) throw new Error(`no such task: #${number}`);
      change(task);
      task.updatedAt = this.now().toISOString();
      return structuredClone(task);
    });
  }

  private async updateBranch(ref: string, change: (branch: TaskBranch, task: WorkTask) => void): Promise<TaskBranch> {
    return this.mutate((registry) => {
      const normalized = normalizeBranchRef(ref);
      const task = registry.tasks.find((candidate) => candidate.number === Number(normalized.split(".")[0]));
      const branch = task?.branches.find((candidate) => candidate.ref === normalized);
      if (!task || !branch) throw new Error(`no such branch: #${normalized}`);
      change(branch, task);
      const now = this.now().toISOString();
      branch.updatedAt = now;
      task.updatedAt = now;
      task.status = aggregateTaskStatus(task.branches, task.status);
      return structuredClone(branch);
    });
  }

  private read(): TaskRegistry {
    try {
      const raw = readFileSync(this.path, "utf8");
      return RegistrySchema.parse(dropLegacyTicketLinks(JSON.parse(raw), this.path));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { version: 1, nextTaskNumber: 1, tasks: [], startClaims: {} };
      throw new Error(`task registry ${this.path} is unreadable: ${(err as Error).message}`);
    }
  }

  private async mutate<T>(change: (registry: TaskRegistry) => T): Promise<T> {
    await this.acquireLock();
    try {
      const registry = this.read();
      const result = change(registry);
      this.write(registry);
      return result;
    } finally {
      rmSync(this.lockPath, { recursive: true, force: true });
    }
  }

  private write(registry: TaskRegistry): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.${this.id()}.tmp`;
    writeFileSync(temp, JSON.stringify(registry, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(temp, this.path);
  }

  private async acquireLock(): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
      try {
        mkdirSync(this.lockPath);
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        try {
          if (Date.now() - statSync(this.lockPath).mtimeMs > LOCK_STALE_MS) {
            rmSync(this.lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue;
        }
        await this.sleep(10 + attempt);
      }
    }
    throw new Error(`timed out waiting for task registry lock ${this.lockPath}`);
  }
}

/**
 * Registries written before the ticket rip-out carry a `ticket` link on started branches. There is
 * nothing to migrate it INTO — a run id cannot be derived from a tracker ticket id, and the tracker
 * those rows pointed at is gone — so the key is dropped and the branch keeps its last known status.
 * zod would strip the unknown key silently; this exists so the drop is stated ONCE in the log
 * instead of being a mystery when a pre-v7 branch shows no run.
 */
let warnedLegacyTicketLinks = false;
function dropLegacyTicketLinks(raw: unknown, path: string): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const registry = raw as { tasks?: unknown };
  if (!Array.isArray(registry.tasks)) return raw;
  let dropped = 0;
  for (const task of registry.tasks) {
    const branches = (task as { branches?: unknown }).branches;
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      if (branch && typeof branch === "object" && "ticket" in branch) {
        delete (branch as Record<string, unknown>).ticket;
        dropped++;
      }
    }
  }
  if (dropped > 0 && !warnedLegacyTicketLinks) {
    warnedLegacyTicketLinks = true;
    rootLog.child("task.store").info("dropped pre-v7 tracker links from the task registry", { path, branches: dropped });
  }
  return raw;
}

/**
 * Mint an id for a fresh wave. Follows the repo id scheme (`src/ids.ts`) rather than a bespoke
 * format so wave ids are greppable in the registry and the JSONL log alongside `task_…`/`wk_…`.
 */
export function newWaveId(): string {
  return prefixedId("wave");
}

/**
 * Which wave a brand-new task belongs to: the newest existing task's, when the two were filed
 * within WAVE_WINDOW_MS of each other, otherwise a fresh one.
 *
 * Called from INSIDE the locked `mutate()` that allocates the task number, with the registry as
 * just read from disk. That matters for the concurrent case: two `beckett task create` processes
 * racing to file the same burst take the lock in turn, so the second one sees the first one's task
 * committed and joins its wave instead of minting a rival id.
 *
 * The only input is `createdAt` stamps already durable in the registry — deliberately no in-memory
 * "time of last filing", which a daemon restart or (far more likely) the next short-lived CLI
 * process would lose, splitting a wave down the middle for no reason the user can see.
 */
function inferWaveId(tasks: WorkTask[], nowIso: string, originChannelId?: string): string {
  // A wave is scoped to ONE channel. Co-filing time alone is not enough: two people asking for
  // unrelated things in #media and #dev in the same breath produced one wave, so `&recent` in a
  // #dev thread attached the #media task too — work reporting into a room whose members never
  // asked for it. Same channel is the weakest extra condition that makes the inference honest.
  // A task filed with no channel can only join another channel-less task.
  const previous = newestTask(tasks.filter((t) => t.originChannelId === originChannelId));
  // A pre-wave row has no id to join. Grouping onto `undefined` would leave the new task outside
  // every wave lookup, so it starts a wave of its own and the legacy rows stay as they are.
  if (!previous?.waveId) return newWaveId();
  const previousAt = Date.parse(previous.createdAt);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(previousAt) || !Number.isFinite(now)) return newWaveId();
  const elapsed = now - previousAt;
  // Negative elapsed means the newest row is stamped in the future — a skewed clock or a
  // hand-edited registry. Refuse to guess: an unrelated task swept into a stale wave reports into
  // a thread the user never meant, which is worse than an extra wave.
  if (elapsed < 0 || elapsed > WAVE_WINDOW_MS) return newWaveId();
  return previous.waveId;
}

/** The most recently FILED task, by `compareRecency`. Undefined only for an empty registry. */
function newestTask(tasks: WorkTask[]): WorkTask | undefined {
  let newest: WorkTask | undefined;
  for (const task of tasks) {
    if (!newest || compareRecency(task, newest) > 0) newest = task;
  }
  return newest;
}

/**
 * Filing order: newer createdAt wins, ties (a batch filed within one tick) break on number.
 * Timestamps are parsed rather than string-compared because a hand-edited or imported registry may
 * carry a non-UTC offset, where lexical order lies; an unparseable stamp sorts oldest so it can
 * never claim to be the most recent wave.
 */
function compareRecency(a: WorkTask, b: WorkTask): number {
  const at = Date.parse(a.createdAt);
  const bt = Date.parse(b.createdAt);
  const left = Number.isFinite(at) ? at : -Infinity;
  const right = Number.isFinite(bt) ? bt : -Infinity;
  if (left !== right) return left < right ? -1 : 1;
  return a.number - b.number;
}

function aggregateTaskStatus(branches: TaskBranch[], current: TaskStatus): TaskStatus {
  if (current === "cancelled") return current;
  if (branches.length > 0 && branches.every((branch) => branch.status === "done" || branch.status === "cancelled")) {
    return branches.some((branch) => branch.status === "done") ? "done" : "cancelled";
  }
  if (current === "paused") return current;
  return "active";
}

export function createTaskStore(path: string, opts?: TaskStoreOptions): TaskStore {
  return new TaskStore(path, opts);
}
