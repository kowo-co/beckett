/**
 * Beckett v7 — the spec-gate Stop hook (`src/hooks/spec-gate.ts`)
 * =======================================================================================
 * v7 replaced the ticket's acceptance criteria with a `spec.md` checklist the WORKER
 * authors. A checklist nobody enforces is a suggestion, so this Stop hook stands between
 * the worker and its own done-signal: if `spec.md` still carries the seeded placeholder, or
 * any unchecked item, the turn is blocked with the exact list back — "tick them off or move
 * them to Notes with a reason".
 *
 * Fail-OPEN by construction: a missing/unreadable spec.md, or any internal error, allows the
 * stop. The gate exists to catch a worker skipping its own plan, not to strand a run behind
 * a hook bug. Registered through {@link specGateSpec} into the worker's `--settings` file,
 * exactly like the scope-guard.
 *
 * INTEGRATION NOTE (wave A): this file is lane W1A's, carried here only so the supervisor
 * compiles and its Stop-hook wiring is testable. W1A's gate BEHAVIOR wins at integration —
 * block on a missing spec.md, and a 3-strikes sidecar counter instead of `stop_hook_active`.
 * The supervisor depends on exactly one thing: `specGateSpec(scriptPath, workspaceRoot)`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HookSpec } from "./registry.ts";
import { parseSpecChecklist, uncheckedItems } from "../run/spec-file.ts";

/** The Stop-hook payload claude hands us on stdin (only the fields we read). */
export interface SpecGateInput {
  cwd?: string;
  /** Claude sets this when the stop is itself the result of a hook continuation. */
  stop_hook_active?: boolean;
}

/** The Stop-hook decision shape: `{}` allows, `{decision: "block", reason}` sends it back. */
export interface SpecGateDecision {
  decision?: "block";
  reason?: string;
}

/** Max unchecked items listed back before the reason is truncated (a runaway plan is still readable). */
const MAX_LISTED = 25;

/** Evaluate the gate against a spec.md path. Pure, so the unit tests need no subprocess. */
export function evaluateSpecGate(specPath: string): SpecGateDecision {
  if (!existsSync(specPath)) return {};
  let text: string;
  try {
    text = readFileSync(specPath, "utf8");
  } catch {
    return {}; // fail open — an unreadable spec is not the worker's fault
  }
  const parsed = parseSpecChecklist(text);
  if (parsed.total === 0) return {};
  const unchecked = uncheckedItems(parsed);
  if (unchecked.length === 0) return {};
  const listed = unchecked.slice(0, MAX_LISTED).map((t) => `- ${t}`).join("\n");
  const more = unchecked.length > MAX_LISTED ? `\n…and ${unchecked.length - MAX_LISTED} more.` : "";
  const head = parsed.hasPlaceholder
    ? `Your \`spec.md\` checklist is still the seeded placeholder — write the real, concrete, ` +
      `verifiable items you are working through BEFORE you finish.`
    : `Your \`spec.md\` checklist still has ${unchecked.length} unchecked item${unchecked.length === 1 ? "" : "s"}:`;
  return {
    decision: "block",
    reason:
      `${head}\n${listed}${more}\n\n` +
      `Tick them off (\`- [x]\`) once they genuinely hold, or move them to the Notes section ` +
      `with a reason they are not being done. Then finish.`,
  };
}

/**
 * Register the gate for one worker. The spec path is baked into the command so the hook is
 * self-contained (no env dependency) — same signature and posture as `scopeGuardSpec`, whose
 * second argument is likewise the worker's workspace root.
 */
export function specGateSpec(specGateScriptPath: string, workspace: string): HookSpec {
  const specPath = join(workspace, "spec.md");
  return {
    event: "Stop",
    command: `bun ${JSON.stringify(specGateScriptPath)} --spec ${JSON.stringify(specPath)}`,
  };
}

/** Resolve the spec path from argv/cwd (the hook's own entry point). */
export function resolveSpecPath(argv: string[], cwd?: string): string {
  const index = argv.indexOf("--spec");
  const explicit = index >= 0 ? argv[index + 1] : undefined;
  if (explicit) return explicit;
  return join(cwd && cwd.trim() ? cwd : process.cwd(), "spec.md");
}

if (import.meta.main) {
  let decision: SpecGateDecision = {};
  try {
    const input = (await Bun.stdin.json()) as SpecGateInput;
    // A stop already produced by this hook must not be re-blocked: that is the documented
    // infinite-loop guard, and the worker has been told once.
    if (!input?.stop_hook_active) {
      decision = evaluateSpecGate(resolveSpecPath(Bun.argv.slice(2), input?.cwd));
    }
  } catch {
    decision = {}; // fail open — never wedge a finished worker behind a hook fault
  }
  process.stdout.write(JSON.stringify(decision));
}
