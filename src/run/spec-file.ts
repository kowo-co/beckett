/**
 * Beckett — spec.md codec (`src/run/spec-file.ts`)
 * =======================================================================================
 * `<workspace>/.beckett/spec.md` ({@link SPEC_FILE_REL}) is the enforced worker contract for a run
 * (architecture.md "v7 architecture: ticketless runs"): a checklist the worker fills in as its
 * FIRST action and ticks off as it goes, gated on Stop by `../hooks/spec-gate.ts`. This module is
 * the pure codec — render the scaffold a fresh worktree starts with, and parse the `## Checklist`
 * section back out of whatever the worker leaves behind. No I/O here; the hook/CLI/supervisor own
 * reading and writing the file itself.
 */

import type { Run } from "./types.ts";

/**
 * Where a run's spec lives, relative to the workspace root. Harness state, never the customer's
 * tree: `.beckett/` is already `info/exclude`d and stripped from the index by the pre-commit
 * scaffolding guard (`installScaffoldingGuardHook`, `../worker/worktree.ts`), so a spec written
 * here is structurally uncommittable — unlike the legacy `<workspace>/spec.md`, which was tracked,
 * committed, and pushed to trunk (the #1 conflicting path). MUST stay `.beckett/spec.md`; pinned
 * by a test in `spec-file.test.ts`.
 */
export const SPEC_FILE_REL = ".beckett/spec.md";

/** The literal placeholder line seeded into a fresh spec.md's Checklist section. */
export const SPEC_CHECKLIST_PLACEHOLDER = "(worker fills this in as its FIRST action: concrete, verifiable items)";

/** One `- [ ]` / `- [x]` line under `## Checklist`. */
export interface SpecChecklistItem {
  text: string;
  done: boolean;
}

export interface ParsedSpecChecklist {
  items: SpecChecklistItem[];
  total: number;
  done: number;
  /** True when the seeded placeholder line is still present, checked or not. */
  hasPlaceholder: boolean;
}

/**
 * Render the spec.md scaffold a fresh run's worktree starts with. Exact format (architecture.md):
 *
 * ```md
 * # <title>
 * > run: <id> · branch: <branch> · created: <createdAt>
 *
 * ## Goal
 * <prompt verbatim>
 *
 * ## Checklist
 * - [ ] (worker fills this in as its FIRST action: concrete, verifiable items)
 *
 * ## Notes
 * (worker scratch: decisions, blockers, handoff notes)
 * ```
 */
export function renderSpecScaffold(run: Pick<Run, "id" | "title" | "branch" | "createdAt" | "prompt">): string {
  return (
    `# ${run.title}\n` +
    `> run: ${run.id} · branch: ${run.branch} · created: ${run.createdAt}\n` +
    `\n` +
    `## Goal\n` +
    `${run.prompt}\n` +
    `\n` +
    `## Checklist\n` +
    `- [ ] ${SPEC_CHECKLIST_PLACEHOLDER}\n` +
    `\n` +
    `## Notes\n` +
    `(worker scratch: decisions, blockers, handoff notes)\n`
  );
}

/** Matches the scaffold's `> run: <id> · …` stamp line. */
const RUN_STAMP_RE = /^>\s*run:\s*(\S+)/m;

/**
 * Which run a spec.md belongs to, from the scaffold's `> run: <id>` stamp. `undefined` when the
 * file carries no stamp (hand-written spec, or a worker that rewrote the header) — callers must
 * treat unstamped as "not provably foreign", never as a match.
 */
export function specRunId(text: string): string | undefined {
  return RUN_STAMP_RE.exec(text)?.[1];
}

/** Matches `- [ ] text` / `* [x] text` (any leading indent — nested bullets count too). */
const CHECKLIST_ITEM_RE = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/;
const CHECKLIST_HEADING_RE = /^##\s+checklist\s*$/i;
/** Any `## ` heading — marks the end of the Checklist section. */
const SECTION_HEADING_RE = /^##\s+/;

/**
 * Pull the `## Checklist` section's `- [ ]` / `- [x]` bullets out of a spec.md body. Only bullets
 * under that heading count — a checkbox-shaped line elsewhere in the file (Goal, Notes, or the
 * worker's own scratch) is not a checklist item. Case-insensitive `x`; indentation/nesting under
 * the heading is tolerated and every nested box is counted. No `## Checklist` heading at all
 * yields an empty, non-placeholder result (`total: 0, done: 0, hasPlaceholder: false`).
 *
 * When the file holds SEVERAL `## Checklist` headings, the LAST one wins: a worker that appends
 * its own checklist below an inherited/stale one must have its own parsed, not the leftover —
 * the stale-first read is how a previous run's criteria once reached a review brief.
 */
export function parseSpecChecklist(text: string): ParsedSpecChecklist {
  const lines = text.split(/\r?\n/);
  let headingIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (CHECKLIST_HEADING_RE.test((lines[i] ?? "").trim())) headingIndex = i;
  }
  const items: SpecChecklistItem[] = [];

  if (headingIndex !== -1) {
    for (let i = headingIndex + 1; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (SECTION_HEADING_RE.test(line.trim())) break; // next section — Checklist ends here
      const match = CHECKLIST_ITEM_RE.exec(line);
      if (match) items.push({ text: match[2]!.trim(), done: match[1]!.toLowerCase() === "x" });
    }
  }

  const done = items.filter((item) => item.done).length;
  const hasPlaceholder = items.some((item) => item.text === SPEC_CHECKLIST_PLACEHOLDER);
  return { items, total: items.length, done, hasPlaceholder };
}

/** e.g. "3/7 checked" — for cards/status surfaces. */
export function specProgressLine(parsed: Pick<ParsedSpecChecklist, "done" | "total">): string {
  return `${parsed.done}/${parsed.total} checked`;
}
