/**
 * Beckett — the RESUME brief (`src/dispatch/resume-brief.ts`)
 * =======================================================================================
 * The continuation instruction handed to a worker RESUMED after a daemon restart (OPS-125, building
 * on issue #20's session-resume machinery). A restart kills the live child process; on boot the
 * dispatcher relaunches the SAME harness session (its transcript restored) and hands it THIS short
 * brief instead of the full ticket prompt the session already carries — re-sending the whole brief
 * would just duplicate context the transcript already holds.
 *
 * The brief names the four things a resumed worker needs to re-anchor (OPS-125 acceptance):
 *   1. the ticket (identifier + title),
 *   2. the stage it was mid-flight on (implement / review / rework / design),
 *   3. the review diff BASE SHA — so it can see its whole contribution, not just the last edit,
 *   4. a pointer to its accumulated work context — the restored transcript (its prior reasoning)
 *      AND the committed checkpoint trail in git (`git log`), which survives even if the harness
 *      transcript resume degrades to a fresh session.
 *
 * Pure string construction, split into its own module so it is unit-testable in isolation — the
 * dispatcher tests `mock.module("./spawn.ts", …)` process-globally, and importing a builder out of
 * a mocked module would hand back the mock. This module is never mocked, so its test sees the real
 * text.
 */

import type { WorkItem } from "../run/work-item.ts";

/**
 * The steering block folded into a prompt when comments arrived while no worker was live
 * (issue #22): the user's words must provably reach the first model turn, not vanish. Shared by the
 * initial brief (`spawn.ts#buildPrompt`) and the resume brief so both render steering identically.
 */
export function steeringBlock(steering: string[] | undefined): string {
  if (!steering || steering.length === 0) return "";
  const notes = steering.map((s) => `- ${s.trim()}`).join("\n");
  return `\n\n<context>\nSteering from the user since this ticket was filed (treat as part of the brief):\n${notes}\n</context>`;
}

/**
 * Build the continuation instruction for a resumed worker (OPS-125). `baseRef` is the ticket's
 * review diff base (the SHA the worktree was first branched from, or `"HEAD"` when none was
 * captured); it is surfaced verbatim so the worker diffs its whole contribution rather than
 * re-deriving where it started. `steering` carries any comments buffered while no worker was live.
 */
export function buildResumeBrief(
  item: WorkItem,
  stage: string,
  baseRef: string,
  steering?: string[],
): string {
  const diffCmd =
    baseRef && baseRef !== "HEAD" ? `\`git diff ${baseRef}..HEAD\`` : "`git diff HEAD`";
  const baseNote =
    baseRef && baseRef !== "HEAD"
      ? `Your review/diff base for this ticket is \`${baseRef}\`. `
      : "";
  return (
    `A daemon restart interrupted your previous session on [${item.identifier}] ` +
    `${item.title}. This session RESUMES that one — your prior reasoning and context are restored ` +
    `above (the accumulated transcript), and any work-in-progress was checkpointed to git as WIP ` +
    `commits. You are mid-**${stage}**. ${baseNote}Re-anchor in git before continuing: ` +
    `\`git log --oneline\` shows your checkpoint trail and ${diffCmd} shows the whole contribution ` +
    `so far. Then continue the ${stage} work to completion and finish with the structured ` +
    `done-signal as originally instructed.${steeringBlock(steering)}`
  );
}
