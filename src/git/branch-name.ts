/**
 * Git ref naming for a unit of work. Structurally typed (an `identifier`, optionally a public
 * `#N.x` branch ref) rather than tied to a domain object, so the run engine and the task registry
 * can both name a branch without either importing the other's shape.
 */
export interface BranchNameable {
  identifier: string;
  /** Public task-branch reference (`42.2`), when the work is registered under a task. */
  branchRef?: string;
}

/** Keep task-backed Git refs in the public `#N.x` namespace; anything else uses its identifier. */
export function gitBranchForWork(work: BranchNameable): string {
  if (work.branchRef) return `beckett/task-${work.branchRef.replace(/\./g, "-")}`;
  return `beckett/${work.identifier.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`;
}

/**
 * The single filesystem path segment a unit of work's worktree lives at, under
 * `<repoRoot>/.beckett/worktrees/<segment>`. Work ids are public refs like `#131`, and a literal
 * `#` in the worker's cwd breaks npm and Vite-style web builds — `#` is a URL-fragment delimiter and
 * npm's own path resolution mangles it, so `npm test` / `npm run build:web` fail inside the tree for
 * reasons unrelated to the code under review (#134). We scrub every character outside `[a-z0-9._-]`
 * to `-` — the same ref-safe class {@link gitBranchForWork} uses — collapsing runs and trimming
 * leading/trailing separators so the segment is a clean, human-readable directory (a `#131` ticket
 * becomes `131`, `#131.1` becomes `131.1`). Uniqueness within a repo is inherited from the work
 * id, which is already unique; the scrub is applied to that id, so two distinct units keep distinct
 * segments. Falls back to `work` only if a pathological id scrubs to empty.
 */
export function worktreeDirForWork(work: { id: string }): string {
  const scrubbed = work.id
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  return scrubbed || "work";
}
