/**
 * Beckett — the cursor seat's quota exit (`src/drivers/cursor-checkpoint.ts`)
 * =======================================================================================
 * The three durable things that must happen, in order, when the Cursor seat runs out of quota —
 * split out of the shim (`./cursor-runner.ts`) so they can be exercised against a real git repo
 * and a real spec.md WITHOUT loading `@cursor/sdk` or touching the network.
 *
 * That split is not cosmetic. "No work lost" is the load-bearing promise of this seat, and a
 * promise whose only test is "we spawned the whole harness and it seemed fine" is not tested. The
 * shim decides WHEN this runs; this module is WHAT runs, and it is ordinary code with ordinary
 * inputs.
 *
 * Order matters and is the point:
 *   1. **Commit.** Whatever is on disk right now becomes a real commit on the run's own branch.
 *      Never a stash (a stash risks never being popped) and never a discard (that is exactly the
 *      "work lost" this seat exists to prevent).
 *   2. **Un-tick what we cannot vouch for.** A `[x]` this run put there has no verification behind
 *      it that the incoming Claude worker can see. The items themselves survive untouched; only
 *      the unverified marks are cleared, and every one of them is named in the handoff so nothing
 *      is silently dropped.
 *   3. **Write the briefing.** `.beckett/cursor-handoff.md`, with the raw error shape folded in —
 *      which is how the FIRST real production quota event teaches us what Cursor's exhaustion
 *      response actually looks like, since the docs do not say.
 *
 * Steps 1 and 2 land on disk before step 3 reports them, so a process killed part-way through
 * still leaves the durable half done.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CURSOR_HANDOFF_REL, renderCursorHandoff, type CursorHandoffState } from "./cursor-handoff.ts";
import { SPEC_FILE_REL, specRunId, tickedItemTexts, untickItems } from "./../run/spec-file.ts";

/** The message on the commit a quota wall forces. Greppable in `git log` on purpose. */
export const CHECKPOINT_COMMIT_MESSAGE = "cursor: quota fallback checkpoint";

/** Run one git command in `cwd`. Never throws — a git fault degrades, it does not cascade. */
export function git(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  try {
    const proc = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    return {
      code: proc.exitCode ?? -1,
      stdout: proc.stdout.toString().trim(),
      stderr: proc.stderr.toString().trim(),
    };
  } catch (err) {
    return { code: -1, stdout: "", stderr: (err as Error).message };
  }
}

/**
 * Commit everything on disk RIGHT NOW. Returns the new sha, or null when the tree was already
 * clean (nothing to checkpoint) or git refused.
 *
 * A git failure returns null rather than throwing: reporting the quota wall and changing seats
 * matters more than a perfect checkpoint, and `RunSupervisor#commitWip` commits again on the
 * daemon side as the backstop. Silently swallowing it would be wrong, though — the caller folds
 * the outcome into the handoff either way.
 */
export function checkpointCommit(workspace: string, message = CHECKPOINT_COMMIT_MESSAGE): string | null {
  git(["add", "-A"], workspace);
  // Mirror `../worker/worktree.ts#commitWorktree`: never let Beckett's own scaffolding into the
  // index, even if something forced it past the exclude. The handoff file lives in there.
  git(["rm", "-r", "--cached", "--ignore-unmatch", "--quiet", "--", ".beckett"], workspace);
  if (git(["status", "--porcelain"], workspace).stdout === "") return null;
  if (git(["-c", "commit.gpgsign=false", "commit", "-m", message], workspace).code !== 0) return null;
  return git(["rev-parse", "HEAD"], workspace).stdout || null;
}

/** Why the seat was abandoned, as far as the shim could tell. */
interface QuotaExitDetail {
  reason: string;
  status?: number;
  code?: string;
}

/** Everything the shim knows that git doesn't, handed in rather than re-derived here. */
interface QuotaExitContext {
  workspace: string;
  agentId: string;
  /** The model label actually resolved (`Auto Balance` / `Auto`). */
  model: string;
  /** Checklist items that were ALREADY ticked when this seat took over — not ours to reset. */
  ticksAtStart: ReadonlySet<string>;
  activity: CursorHandoffState["activity"];
  notes: string[];
  /** Injected for determinism in tests; defaults to now. */
  now?: () => Date;
}

/** What the exit actually did — the shim turns this into its `quota` frame. */
interface QuotaExitResult {
  /** The checkpoint commit's sha, or null when the tree was already clean. */
  checkpoint: string | null;
  /** Checklist items reset to unchecked because this run could not vouch for them. */
  unverifiedTicks: string[];
  /** Absolute path of the handoff file written. */
  handoffPath: string;
}

function readTextOr(path: string, fallback: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Perform the quota exit. Safe to call at ANY point in a run — before the first token (nothing on
 * disk, no ticks, no checkpoint: the handoff simply says the seat never touched the tree), or
 * mid-run between checklist items (a real checkpoint commit, real ticks reset, a real briefing).
 * Both are ordinary inputs to the same function, which is why both are testable.
 */
export function performQuotaExit(ctx: QuotaExitContext, detail: QuotaExitDetail): QuotaExitResult {
  const specPath = join(ctx.workspace, SPEC_FILE_REL);
  const handoffPath = join(ctx.workspace, CURSOR_HANDOFF_REL);
  const now = ctx.now ?? (() => new Date());

  // 1 — commit, before anything else can go wrong.
  const checkpoint = checkpointCommit(ctx.workspace);

  // 2 — reset only the ticks THIS run added.
  let unverifiedTicks: string[] = [];
  const specText = readTextOr(specPath, "");
  if (specText) {
    const ours = tickedItemTexts(specText).filter((item) => !ctx.ticksAtStart.has(item));
    if (ours.length > 0) {
      const { text, changed } = untickItems(specText, ours);
      try {
        writeFileSync(specPath, text);
        unverifiedTicks = changed;
      } catch {
        // The file could not be rewritten. Still NAME them in the handoff: a reader who is told
        // "these ticks are unverified" is protected even when the checkbox itself stayed set.
        unverifiedTicks = ours;
      }
    }
  }

  // 3 — the briefing, with the raw error shape folded in.
  const state: CursorHandoffState = {
    runId: specRunId(specText) ?? "(unstamped run)",
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"], ctx.workspace).stdout || "(detached)",
    agentId: ctx.agentId,
    model: ctx.model,
    updatedAt: now().toISOString(),
    status: `handed over — the cursor seat ran out of quota (${detail.reason})`,
    activity: ctx.activity,
    unverifiedTicks,
    notes: ctx.notes,
    fallback: {
      reason: detail.reason,
      ...(detail.status === undefined ? {} : { status: detail.status }),
      ...(detail.code ? { code: detail.code } : {}),
      ...(checkpoint ? { checkpoint } : {}),
    },
  };
  try {
    writeFileSync(handoffPath, renderCursorHandoff(state));
  } catch {
    // A handoff we could not write is a real loss of context, but it is not a reason to leave the
    // run wedged on an exhausted seat — the commit and the reset already landed, and the driver
    // still reports the wall. The shim logs the failure separately.
  }

  return { checkpoint, unverifiedTicks, handoffPath };
}
