/**
 * Beckett — the Cursor→Claude handoff artifact (`src/drivers/cursor-handoff.ts`)
 * =======================================================================================
 * The one thing git can't carry across a seat change.
 *
 * When the Cursor seat runs out of Pro quota mid-run, everything durable is already durable for
 * free: the worktree, the branch, every commit (git does not care which harness authored it), and
 * `.beckett/spec.md`. What is NOT durable is whatever only existed in the Cursor agent's head —
 * WHY the diff looks like that, what was mid-flight when the wall hit, which checklist boxes it
 * ticked without a commit behind them. Without that, the Sonnet worker taking over either redoes
 * finished work or trusts an unverified tick. Both are exactly the "work lost" this seat exists
 * to avoid.
 *
 * So the shim (`./cursor-runner.ts`) rewrites {@link CURSOR_HANDOFF_REL} continuously — after
 * every tool call and every checklist change — rather than trying to compose it at the moment of
 * failure, when the API is already refusing to talk to us. A fallback then needs zero last-second
 * cleanup: the file on disk is always current.
 *
 * It lives beside spec.md under the run's git-excluded `.beckett/` (`../run/spec-file.ts`), so it
 * needs no commit of its own and the next worker reads it straight off disk exactly the way it
 * reads spec.md.
 *
 * This module is the PURE CODEC — render and read back, no I/O, no SDK import. The runner owns
 * writing it; the supervisor reads {@link handoffStatusLine} for the run card; tests drive both
 * ends without spawning anything.
 */

/** Where the handoff artifact lives, relative to the run's workspace root. */
export const CURSOR_HANDOFF_REL = ".beckett/cursor-handoff.md";

/** One thing the Cursor seat did, in the order it did it. */
interface HandoffActivity {
  /** `edit` / `shell` / `read` … — the SDK tool name, as reported. */
  tool: string;
  /** The most identifying argument we have (a path, a command); empty when the tool named none. */
  detail: string;
}

/** Everything the renderer needs. Every field is optional-ish so a half-formed run still writes. */
export interface CursorHandoffState {
  runId: string;
  branch: string;
  /** The Cursor agent id this run is attached to (resume identity). */
  agentId: string;
  /** The model selection actually sent, rendered for a human (e.g. `auto (Auto)`). */
  model: string;
  /** ISO timestamp of this write. */
  updatedAt: string;
  /** `working` while the run is live; anything else is a terminal one-liner. */
  status: string;
  /** Newest-last activity trail, already bounded by the caller. */
  activity: HandoffActivity[];
  /** Checklist items this run newly ticked and then had to un-tick (unverified at handoff). */
  unverifiedTicks: string[];
  /** Free prose the agent emitted — its own account of what it was doing. */
  notes: string[];
  /**
   * Why the seat was abandoned, with the raw error shape folded in. Absent while the run is
   * healthy. This is the field that lets the FIRST real production quota event tell us what
   * Cursor's exhaustion response actually looks like — the docs do not say.
   */
  fallback?: {
    reason: string;
    /** HTTP status, when the SDK surfaced one. */
    status?: number;
    /** Stable SDK/backend error code, when the SDK surfaced one. */
    code?: string;
    /** The sha of the checkpoint commit that captured whatever was on disk, when one was made. */
    checkpoint?: string;
  };
}

/** Cap on the rendered activity trail — the file is a briefing, not a transcript. */
export const HANDOFF_ACTIVITY_MAX = 40;
/** Cap on the rendered notes — same reason. */
export const HANDOFF_NOTES_MAX = 12;
/** Per-line cap, so one pathological tool argument can't make the file unreadable. */
const LINE_MAX = 300;

function clip(text: string, max = LINE_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Render the handoff file. Deterministic (no clock read, no randomness) so a test can assert the
 * exact bytes and the runner can diff-suppress an unchanged write.
 */
export function renderCursorHandoff(state: CursorHandoffState): string {
  const activity = state.activity.slice(-HANDOFF_ACTIVITY_MAX);
  const notes = state.notes.slice(-HANDOFF_NOTES_MAX);
  const lines: string[] = [
    `# Cursor handoff — ${state.runId}`,
    `> status: ${clip(state.status)}`,
    `> agent: ${state.agentId} · model: ${state.model} · branch: ${state.branch} · updated: ${state.updatedAt}`,
    "",
    "READ THIS FIRST, then `.beckett/spec.md`. A Cursor worker held this seat before you. Its",
    "commits are already on this branch — diff against them before you write anything, and do NOT",
    "restart the task from scratch.",
    "",
    "## What the cursor seat did",
  ];
  if (activity.length === 0) {
    lines.push("(nothing yet — the seat was abandoned before it touched the tree)");
  } else {
    for (const a of activity) {
      lines.push(a.detail ? `- ${a.tool}: ${clip(a.detail)}` : `- ${a.tool}`);
    }
  }

  lines.push("", "## Unverified checklist ticks");
  if (state.unverifiedTicks.length === 0) {
    lines.push("(none — no box was ticked by the cursor seat during this run)");
  } else {
    lines.push(
      "The cursor seat ticked these during the run and they were reset to unchecked before it",
      "handed over. A tick with no verification behind it is not evidence. Re-verify each against",
      "the diff, then re-tick it yourself:",
    );
    for (const item of state.unverifiedTicks) lines.push(`- ${clip(item)}`);
  }

  lines.push("", "## Notes from the cursor seat");
  if (notes.length === 0) lines.push("(none)");
  else for (const note of notes) lines.push(`- ${clip(note, 600)}`);

  if (state.fallback) {
    const f = state.fallback;
    const shape = [
      f.status === undefined ? null : `HTTP ${f.status}`,
      f.code ? `code \`${f.code}\`` : null,
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(
      "",
      "## Why the seat was handed over",
      clip(f.reason, 1200),
      "",
      shape ? `Raw error shape: ${shape}.` : "Raw error shape: not reported by the SDK.",
      f.checkpoint
        ? `Everything on disk at that moment was committed as \`${f.checkpoint}\` before exit — ` +
          "nothing was stashed and nothing was discarded."
        : "Nothing was uncommitted at that moment, so no checkpoint commit was needed.",
    );
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * The steering note handed to the Claude worker that inherits a Cursor run. Written here rather
 * than in the supervisor so the artifact and the instruction to read it can never drift apart.
 */
export function handoffResumeNote(reason: string): string {
  return (
    `The cursor seat ran out of quota mid-run and handed this work to you. Nothing was lost: its ` +
    `commits are on this branch and whatever it had uncommitted was committed as a checkpoint ` +
    `before it exited.\n\n` +
    `BEFORE YOU WRITE ANYTHING: read \`${CURSOR_HANDOFF_REL}\` and \`.beckett/spec.md\`, then diff ` +
    `the branch to see what already landed. Continue from there — do NOT restart the task.\n\n` +
    `Any checklist box the cursor seat ticked was reset to unchecked and is listed in the handoff ` +
    `file. Re-verify each one against the diff before you re-tick it; a tick you did not verify is ` +
    `not evidence.\n\n` +
    `Why the seat changed: ${reason}`
  );
}
