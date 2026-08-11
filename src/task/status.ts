/** Assemble user-facing task/branch status without exposing tracker ticket identifiers or patches. */
import { existsSync } from "node:fs";
import type { GitHubBranchCardReader, BranchCardCheckSummary, PrLifecycle } from "../github/types.ts";
import { readLocalBranchStats, type LocalBranchStats } from "../git/branch-stats.ts";
import { gitBranchForWork } from "../git/branch-name.ts";
import type { TaskBranch, TaskBranchStatus, TaskStatus, TaskStore, WorkTask } from "./store.ts";

export interface BranchCardSnapshot {
  ref: string;
  title: string;
  taskNumber: number;
  taskTitle: string;
  status: TaskBranchStatus;
  source: "local" | "published" | "pull_request";
  gitRef?: string;
  repo?: string;
  changes?: { additions: number; deletions: number; files: number; commits: number };
  pullRequest?: { number: number; url: string; state: PrLifecycle; draft: boolean };
  publication?: { url: string; kind: "pushed" | "pr" };
  checks?: BranchCardCheckSummary;
  review?: { decision: string; count: number };
  discussion?: { comments: number };
  updatedAt: string;
}

/**
 * One branch as the task card shows it (#104): its public ref, title, lifecycle state, and — once
 * work has produced one — its artifact link and live preview. Built purely from the durable task
 * registry (no GitHub call), because a card that re-renders on every lifecycle change must be cheap
 * and must never expose a tracker ticket identifier.
 */
export interface TaskCardBranchSnapshot {
  ref: string;
  title: string;
  status: TaskBranchStatus;
  /** The shipped/published thing, when it exists: an open/merged PR or a pushed branch. */
  artifact?: { url: string; kind: "pull_request" | "published" };
  /** A live, externally-reachable preview surfaced while the branch is in review. */
  preview?: { url: string };
  /** The open pull request's number, when one exists. */
  pullRequestNumber?: number;
  /** The PR's live state, when known. Absent means still-open (pre-#104 rows carry no state). */
  pullRequestState?: "OPEN" | "CLOSED" | "MERGED";
  /** Hosted screenshots of the built branch, rendered as the card's media gallery. */
  images?: { url: string; description?: string }[];
}

/** The whole task as its one self-editing card shows it: title, aggregate state, and every branch. */
export interface TaskCardSnapshot {
  number: number;
  title: string;
  status: TaskStatus;
  branches: TaskCardBranchSnapshot[];
  updatedAt: string;
}

/** Project the durable task registry row onto the card snapshot. Pure and synchronous by design. */
export function taskCardSnapshot(task: WorkTask): TaskCardSnapshot {
  return {
    number: task.number,
    title: task.title,
    status: task.status,
    branches: task.branches.map(branchCardEntry),
    updatedAt: task.updatedAt,
  };
}

function branchCardEntry(branch: TaskBranch): TaskCardBranchSnapshot {
  const artifact = branch.pullRequest
    ? { url: branch.pullRequest.url, kind: "pull_request" as const }
    : branch.publication
      ? { url: branch.publication.url, kind: "published" as const }
      : undefined;
  return {
    ref: branch.ref,
    title: branch.title,
    status: branch.status,
    ...(artifact ? { artifact } : {}),
    ...(branch.preview ? { preview: { url: branch.preview.url } } : {}),
    ...(branch.pullRequest ? { pullRequestNumber: branch.pullRequest.number } : {}),
    ...(branch.pullRequest?.state ? { pullRequestState: branch.pullRequest.state } : {}),
    ...(branch.images?.length
      ? { images: branch.images.map(({ url, description }) => ({ url, ...(description ? { description } : {}) })) }
      : {}),
  };
}

export interface BranchStatusServiceOptions {
  store: TaskStore;
  github?: GitHubBranchCardReader;
  githubOwner?: string;
  localStats?: (workspace: string, baseRef: string) => Promise<LocalBranchStats>;
}

export class BranchStatusService {
  private readonly localStats: (workspace: string, baseRef: string) => Promise<LocalBranchStats>;

  constructor(private readonly opts: BranchStatusServiceOptions) {
    this.localStats = opts.localStats ?? readLocalBranchStats;
  }

  async read(ref: string): Promise<BranchCardSnapshot> {
    const found = this.opts.store.getBranch(ref);
    if (!found) throw new Error(`no such task branch: #${ref.replace(/^#/, "")}`);
    const { task, branch } = found;
    const gitRef = branch.git?.gitRef ?? (branch.run
      ? gitBranchForWork({ identifier: branch.run.runId, branchRef: branch.ref })
      : undefined);

    if (branch.pullRequest) {
      if (!this.opts.github) throw new Error(`GitHub status is unavailable for published branch #${branch.ref}`);
      const card = await this.opts.github.branchCard(branch.pullRequest.repo, branch.pullRequest.number);
      return {
        ref: branch.ref,
        title: branch.title,
        taskNumber: task.number,
        taskTitle: task.title,
        status: branch.status,
        source: "pull_request",
        gitRef: card.headRefName || gitRef,
        repo: card.repo,
        changes: {
          additions: card.additions,
          deletions: card.deletions,
          files: card.changedFiles,
          commits: card.commits,
        },
        pullRequest: { number: card.number, url: card.url, state: card.state, draft: card.isDraft },
        checks: card.checks,
        review: { decision: card.reviewDecision, count: card.reviewCount },
        discussion: { comments: card.commentCount },
        updatedAt: card.updatedAt || branch.updatedAt,
      };
    }

    let changes = branch.diff
      ? {
          additions: branch.diff.additions,
          deletions: branch.diff.deletions,
          files: branch.diff.files,
          commits: branch.diff.commits,
        }
      : undefined;
    // `branch.diff` is captured immediately before publication can rebase this checkout onto a
    // newer main. Once present it is authoritative; recomputing from the still-live, post-rebase
    // worktree would count parallel branches that landed first.
    if (!changes && branch.git?.workspace && branch.git.baseSha && existsSync(branch.git.workspace)) {
      const stats = await this.localStats(branch.git.workspace, branch.git.baseSha);
      changes = {
        additions: stats.additions,
        deletions: stats.deletions,
        files: stats.changedFiles,
        commits: stats.commits,
      };
    }
    const project = branch.git?.project ?? task.project;
    return {
      ref: branch.ref,
      title: branch.title,
      taskNumber: task.number,
      taskTitle: task.title,
      status: branch.status,
      source: branch.publication ? "published" : "local",
      ...(gitRef ? { gitRef } : {}),
      ...(branch.publication
        ? { repo: branch.publication.repo, publication: { url: branch.publication.url, kind: branch.publication.kind } }
        : project && this.opts.githubOwner
          ? { repo: `${this.opts.githubOwner}/${project}` }
          : {}),
      ...(changes ? { changes } : {}),
      updatedAt: branch.updatedAt,
    };
  }
}

export function createBranchStatusService(opts: BranchStatusServiceOptions): BranchStatusService {
  return new BranchStatusService(opts);
}
