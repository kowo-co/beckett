/**
 * Beckett — the task registry ↔ run engine bridge (`src/task/run-sync.ts`)
 * =======================================================================================
 * `beckett task start '#12.1'` links a branch to the run executing it, and from that moment the
 * user-facing board reads ONLY the task registry: `beckett task list`, the #104 self-editing task
 * card, the branch card, the Merge button, the boot PR re-watch loop, and the concierge's
 * `stampPrState` all read `tasks.json`, never `runs.json`.
 *
 * The run engine writes none of it. Without this bridge a started branch sits at `ready` forever
 * while its run implements, reviews, opens a PR and finishes — no status movement, no artifact
 * link, no Merge button — which is exactly what the ticket system's poller (`syncTicket`) and
 * dispatcher hooks (`onPublished`/`onPrOpened`/`onBranchWorkspace`) used to prevent. This is that
 * wiring, re-keyed onto run events and nothing else.
 *
 * CONTRACT: every method is BEST-EFFORT and never throws. The run ledger is the source of truth
 * and the registry is a view of it; a locked/corrupt registry must cost a card refresh, never a
 * run transition (the supervisor's hooks are fire-and-forget by design, and a throwing listener
 * would be swallowed there anyway — losing the error message with it).
 *
 * Runs deployed straight from a prompt (`beckett task deploy`, no `--task`) have no branch, so
 * every method is a silent no-op for them.
 *
 * Import style (whole repo, bun-native): explicit `.ts` extensions.
 */

import type { Logger } from "../types.ts";
import type { Run, RunStateChange } from "../run/types.ts";
import type { TaskBranch, TaskGitLink, TaskPublicationLink, TaskPullRequestLink, TaskRunLink } from "./store.ts";
import type { RunState } from "../run/types.ts";

/** The narrow slice of `TaskStore` this bridge writes through (so tests can hand in a fake). */
export interface RunSyncTaskStore {
  linkRun(branchRef: string, link: TaskRunLink, state: RunState, project?: string): Promise<TaskBranch>;
  setGit(branchRef: string, git: TaskGitLink): Promise<TaskBranch>;
  setPullRequest(branchRef: string, pullRequest: TaskPullRequestLink): Promise<TaskBranch>;
  setPublication(branchRef: string, publication: TaskPublicationLink): Promise<TaskBranch>;
}

export interface RunTaskSyncDeps {
  tasks: RunSyncTaskStore;
  /** The project slug a run's work actually lives under (`runProjectSlug`). */
  projectSlugOf: (run: Run) => string;
  /** GitHub account/org the publication link is qualified with (`owner/slug`). */
  githubOwner: string;
  logger: Logger;
}

export interface RunTaskSync {
  /** Project a run transition onto its branch: status, run link, and the live worktree. */
  onStateChange(event: RunStateChange): Promise<void>;
  /** Record the PR a run just opened (the card's artifact link + Merge button). */
  onPrOpened(run: Run, pr: { repo: string; number: number; url: string }): Promise<void>;
  /** Record a successful publication (push or PR). */
  onPublished(run: Run, publication: { url: string; kind: "pushed" | "pr"; prUrl?: string }): Promise<void>;
}

/**
 * The public branch ref a run is executing (`"#12.1"` → `"12.1"`), or null when the run has no
 * task branch. A bare task ref (`"#12"`, no dot) is deliberately null: the registry's branch
 * lookups are `N.x`-keyed, and a task-level "link" has no branch to move.
 */
export function branchRefOfRun(run: Pick<Run, "taskRef">): string | null {
  const ref = (run.taskRef ?? "").trim().replace(/^#/, "");
  return ref.includes(".") ? ref : null;
}

export function createRunTaskSync(deps: RunTaskSyncDeps): RunTaskSync {
  const { tasks, projectSlugOf, githubOwner, logger } = deps;

  /** Run one registry write, swallowing (but reporting) whatever it throws. */
  const attempt = async (what: string, branchRef: string, runId: string, write: () => Promise<unknown>) => {
    try {
      await write();
    } catch (err) {
      logger.warn(`task branch ${what} sync failed`, { branch: branchRef, run: runId, error: String(err) });
    }
  };

  return {
    async onStateChange(event) {
      const branchRef = branchRefOfRun(event.run);
      if (!branchRef) return;
      // linkRun is idempotent for the SAME run and projects the run's state onto the branch
      // status — the repeat call is what actually unfreezes the board as work progresses.
      await attempt("state", branchRef, event.run.id, () =>
        tasks.linkRun(branchRef, { runId: event.run.id }, event.to, event.run.repo ?? undefined),
      );
      // The worktree the run is really executing in, recorded as soon as it exists. Without it the
      // branch card has to GUESS a git ref, and a run executes on `beckett/run-<slug>` — not the
      // `beckett/task-N-x` a task-backed branch would otherwise imply.
      const workspace = event.run.workspace;
      if (!workspace) return;
      await attempt("git", branchRef, event.run.id, () =>
        tasks.setGit(branchRef, {
          project: projectSlugOf(event.run),
          workspace,
          gitRef: event.run.branch,
          ...(event.run.baseSha ? { baseSha: event.run.baseSha } : {}),
        }),
      );
    },

    async onPrOpened(run, pr) {
      const branchRef = branchRefOfRun(run);
      if (!branchRef) return;
      // Stamped OPEN explicitly: `setPullRequestState` later flips it to MERGED/CLOSED, and a
      // missing state is only meant to mean "written before #104", not "state unknown".
      await attempt("PR", branchRef, run.id, () =>
        tasks.setPullRequest(branchRef, { repo: pr.repo, number: pr.number, url: pr.url, state: "OPEN" }),
      );
    },

    async onPublished(run, publication) {
      const branchRef = branchRefOfRun(run);
      if (!branchRef) return;
      await attempt("publication", branchRef, run.id, () =>
        tasks.setPublication(branchRef, {
          repo: `${githubOwner}/${projectSlugOf(run)}`,
          url: publication.prUrl ?? publication.url,
          kind: publication.kind,
        }),
      );
    },
  };
}
