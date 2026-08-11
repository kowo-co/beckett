#!/usr/bin/env bun
/**
 * Beckett — Stop-hook spec.md gate (`src/hooks/spec-gate.ts`)
 * =======================================================================================
 * A STANDALONE Stop hook script that `claude` runs as a subprocess (v7 run architecture,
 * architecture.md): when a worker session tries to end its turn, this hook reads
 * `<workspace>/spec.md` and blocks the stop if the file is missing, still carries the seeded
 * placeholder checklist item, or has any unchecked `- [ ]` item under `## Checklist`. The block
 * reason lists the unresolved items so the worker can either finish them, tick them off, or move
 * a deliberately-dropped one to `## Notes` with a reason.
 *
 * A wedged worker must not be able to loop forever against this gate: once it has blocked the
 * SAME workspace {@link MAX_STRIKES} times, the next stop is allowed through (with a warning) no
 * matter what spec.md says. The strike count is tracked in a small sidecar file,
 * `<workspace>/.beckett/spec-gate-count`, so it survives across the several Stop events one
 * session can fire. A clean pass resets the count to 0, so exposure earned during one blocked
 * episode (e.g. the implement stage) can't be spent by an unrelated later episode in the same
 * worktree (e.g. a rework cycle after review) — each episode gets its own full 3 strikes.
 *
 * Structural conventions match `./scope-guard.ts`: a pure decision function
 * ({@link evaluateSpecGate}) unit-tested directly, config resolution from argv (preferred, baked
 * in by the spawn/registry path) with an env-var fallback, and an `import.meta.main` block that
 * is the only stdin→stdout (and sidecar-file) side-effecting shell.
 *
 * Fail-open on internal error (unlike the scope-guard's fail-closed write boundary): a Stop hook
 * that can't be evaluated must never trap a worker session that would otherwise end cleanly, so
 * any unexpected error here allows the stop rather than blocking it.
 */

import { resolve, join } from "node:path";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseSpecChecklist, SPEC_CHECKLIST_PLACEHOLDER, type ParsedSpecChecklist } from "../run/spec-file.ts";

/** Env var fallback carrying the worker's workspace root (argv `--root` wins). */
export const SPEC_PATH_ENV = "BECKETT_SPEC_PATH";
/** How many times this hook may block the same workspace before it allows through regardless. */
export const MAX_STRIKES = 3;
/** Sidecar path (relative to workspace) tracking how many times this session has been blocked. */
export const STRIKE_COUNT_REL_PATH = join(".beckett", "spec-gate-count");

/** The Stop event shape we consume (only the fields we need; tolerant of extras). */
export interface SpecGateHookInput {
  cwd?: string;
  [k: string]: unknown;
}

/** Resolved gate config. */
export interface SpecGateConfig {
  /** Absolute workspace root — spec.md and the strike-count sidecar both live directly under it. */
  workspace: string;
}

/** A Stop-hook decision. Empty object = allow the stop. `block` keeps the session going. */
export type SpecGateDecision = Record<string, never> | { decision: "block"; reason: string };

/** What one evaluation produced: the decision, the strike count to persist, and whether the
 *  gate failed but was allowed through anyway (3-strikes case) — for the entry point's warning. */
export interface SpecGateEvaluation {
  decision: SpecGateDecision;
  nextCount: number;
  warned: boolean;
}

/**
 * Resolve gate config from argv + env (argv wins), same precedence pattern as scope-guard's
 * `resolveConfig`. Falls back to the hook event's own `cwd` when neither is given.
 */
export function resolveConfig(
  argv: string[],
  env: Record<string, string | undefined>,
  eventCwd?: string,
): SpecGateConfig {
  let workspace = env[SPEC_PATH_ENV];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && argv[i + 1]) workspace = argv[++i];
  }
  workspace = workspace ?? eventCwd ?? process.cwd();
  return { workspace: resolve(workspace) };
}

/**
 * The unresolved-item texts to list in a block reason: every unchecked checklist item, plus the
 * seeded placeholder text (even if somehow marked checked without being replaced) when it is
 * still present and not already in that list. Callers only reach this for a spec.md that DOES
 * have a non-empty Checklist section — the missing-file and no-checklist-items cases get their
 * own dedicated messages in {@link buildBlockReason} rather than being routed through the
 * "N unchecked item(s)" template, which reads wrong for a synthetic (non-)item.
 */
function unresolvedItems(parsed: ParsedSpecChecklist): string[] {
  const items = parsed.items.filter((item) => !item.done).map((item) => item.text);
  if (parsed.hasPlaceholder && !items.includes(SPEC_CHECKLIST_PLACEHOLDER)) items.push(SPEC_CHECKLIST_PLACEHOLDER);
  return items;
}

/**
 * Build the block reason text. Three shapes:
 *  - spec.md missing entirely → dedicated "not found" message.
 *  - spec.md present but with no `## Checklist` items at all (missing/emptied section) →
 *    dedicated "no checklist items" message. Treating this the same as zero real unchecked
 *    items would let a blocked worker delete the Checklist section instead of doing the work —
 *    cheaper than compliance and exactly the enforcement this hook exists to prevent.
 *  - otherwise → "spec.md gate: N unchecked item(s): … — finish them, …".
 */
export function buildBlockReason(parsed: ParsedSpecChecklist | null): string {
  if (parsed === null) {
    return "spec.md gate: spec.md not found — write it with a ## Checklist section before finishing.";
  }
  if (parsed.total === 0) {
    return "spec.md gate: spec.md has no checklist items — write a ## Checklist with concrete, verifiable items.";
  }
  const items = unresolvedItems(parsed);
  return (
    `spec.md gate: ${items.length} unchecked item(s): ${items.join("; ")} — finish them, tick them off, ` +
    `or move deliberately-dropped items to ## Notes with a reason, then finish.`
  );
}

/**
 * The pure decision function. `specText` is the raw spec.md contents, or `null` when the file
 * doesn't exist. `priorCount` is the strike count already persisted for this workspace. Never
 * touches the filesystem — the entry point owns reading spec.md and the sidecar counter.
 */
export function evaluateSpecGate(
  specText: string | null,
  priorCount: number,
  maxStrikes: number = MAX_STRIKES,
): SpecGateEvaluation {
  const parsed = specText === null ? null : parseSpecChecklist(specText);
  // `total === 0` (no `## Checklist` section, or an emptied one) fails the gate exactly like a
  // placeholder: otherwise a worker blocked once could delete the section instead of doing the
  // work, which is cheaper than compliance and defeats the enforcement this hook exists for.
  const gateFailed = parsed === null || parsed.hasPlaceholder || parsed.total === 0 || parsed.done < parsed.total;

  // A clean pass resets exposure: the 3-strikes counter tracks how many times THIS workspace has
  // been blocked, and a spec.md that now satisfies the gate means the worker is no longer stuck —
  // carrying a stale nonzero count forward would let a later, unrelated rework cycle in the same
  // worktree (e.g. after a failed review sends it back) skate through its first real block for
  // free, on exposure earned by a prior, already-resolved episode.
  if (!gateFailed) return { decision: {}, nextCount: 0, warned: false };

  if (priorCount >= maxStrikes) {
    // Wedged worker escape hatch: this workspace has already been blocked `maxStrikes` times —
    // allow the stop through so it can't loop forever, but say so.
    return { decision: {}, nextCount: priorCount, warned: true };
  }

  return {
    decision: { decision: "block", reason: buildBlockReason(parsed) },
    nextCount: priorCount + 1,
    warned: false,
  };
}

// =======================================================================================
// Sidecar strike-counter I/O (entry point only — evaluateSpecGate stays pure)
// =======================================================================================

/** Read the persisted strike count for a workspace. Missing/unparsable → 0. */
export function readStrikeCount(workspace: string): number {
  try {
    const raw = readFileSync(join(workspace, STRIKE_COUNT_REL_PATH), "utf8").trim();
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

/** Persist the strike count for a workspace (atomic tmp+rename). Best-effort. */
export function writeStrikeCount(workspace: string, count: number): void {
  const dir = join(workspace, ".beckett");
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "spec-gate-count");
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, String(count), "utf8");
    renameSync(temp, path);
  } catch {
    // Best-effort: a lost counter only means the gate stays strict a little longer, never that
    // it blocks forever — the worst case is one extra block before the 3-strikes escape fires.
  }
}

// =======================================================================================
// Entry point — pure stdin → stdout (plus the strike-counter sidecar), fail-open
// =======================================================================================

if (import.meta.main) {
  try {
    let input: SpecGateHookInput = {};
    try {
      input = (await Bun.stdin.json()) as SpecGateHookInput;
    } catch {
      // No/garbled stdin — fall back to argv/env config below.
    }

    const cfg = resolveConfig(Bun.argv.slice(2), process.env, input.cwd);

    let specText: string | null;
    try {
      specText = readFileSync(join(cfg.workspace, "spec.md"), "utf8");
    } catch {
      specText = null;
    }

    const priorCount = readStrikeCount(cfg.workspace);
    const result = evaluateSpecGate(specText, priorCount);
    if (result.nextCount !== priorCount) writeStrikeCount(cfg.workspace, result.nextCount);
    if (result.warned) {
      process.stderr.write(
        `spec-gate: workspace already blocked ${priorCount} time(s) this session — allowing the stop through ` +
          `with a warning so the worker can't loop forever. spec.md still has unresolved items.\n`,
      );
    }
    process.stdout.write(JSON.stringify(result.decision));
  } catch {
    // Fail-open: never trap a worker session behind a hook that couldn't evaluate itself.
    process.stdout.write(JSON.stringify({}));
  }
}
