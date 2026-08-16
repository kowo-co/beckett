#!/usr/bin/env bun
/**
 * Beckett — PreToolUse scope guard (`src/hooks/scope-guard.ts`)
 * =======================================================================================
 * Layer-2 of scope enforcement (Spec 02 §8.2): a STANDALONE PreToolUse hook script that
 * `claude` runs as a subprocess. It reads a hook event JSON on stdin and writes an
 * allow/deny decision on stdout. `--permission-mode bypassPermissions` still honors hook
 * denies (Spec 02 §4.2), so this is the hard write boundary inside a worker's worktree.
 *
 * Deny matrix (Spec 02 §8.2):
 *   - Edit / Write / MultiEdit / NotebookEdit → the file_path / notebook_path target.
 *   - Bash → heuristic redirection / `-o` / `--output` / `tee` write targets (the leaky tool,
 *     Spec 02 §8.4) — best-effort, never throws.
 *   Any target that ESCAPES the worktree, or lands inside it but OUTSIDE the worker's owned
 *   globs, is denied. Pure I/O sinks (/dev/null, /dev/std*, /dev/fd/*) are always allowed.
 *
 * The decision logic ({@link evaluateScopeGuard}) is a pure function so it is unit-testable;
 * the `import.meta.main` block is the only stdin→stdout side-effecting shell.
 *
 * Configuration is read from CLI args (preferred — the WorkerManager bakes them into the
 * per-worker settings file) with an env-var fallback (Spec 02 §8.2 wire):
 *   --root <worktree-abs-path>        | env BECKETT_WORKTREE
 *   --owned "glob1:glob2:..."         | env BECKETT_OWNED_GLOBS   (colon-separated)
 * If no root is given, the hook event's own `cwd` is used.
 */

import { resolve, relative, isAbsolute, dirname, basename, join } from "node:path";
import { realpathSync } from "node:fs";

/** Env var carrying the colon-separated owned globs (Spec 02 §8.2). */
export const OWNED_GLOBS_ENV = "BECKETT_OWNED_GLOBS";
/** Env var carrying the absolute worktree root (Spec 02 §8.2). */
export const WORKTREE_ENV = "BECKETT_WORKTREE";
/** Separator for the owned-globs env/arg value. Globs must not contain it. */
export const GLOB_SEP = ":";

/** The PreToolUse event shape we consume (only the fields we need; tolerant of extras). */
export interface HookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
  [k: string]: unknown;
}

/** Resolved guard config. */
export interface ScopeGuardConfig {
  /** Absolute worktree root. */
  root: string;
  /** Owned write globs, relative to root. Empty = whole worktree writable (escape-only deny). */
  owned: string[];
}

/** A PreToolUse hook decision. Empty object = pass through to normal permission flow. */
export type HookDecision =
  | Record<string, never>
  | {
      hookSpecificOutput: {
        hookEventName: "PreToolUse";
        permissionDecision: "deny";
        permissionDecisionReason: string;
      };
    };

/** Write tools whose target paths are checked directly. */
const PATH_WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** I/O sinks that are always allowed even though they live outside the worktree. */
const ALLOWED_SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);
function isAllowedSink(absPath: string): boolean {
  return ALLOWED_SINKS.has(absPath) || absPath.startsWith("/dev/fd/");
}

/**
 * Shell metacharacters that make a redirection target *un-evaluable* lexically (S5): the shell
 * expands them at runtime so a static resolve would be wrong (`> $HOME/x`, `> ~/x`, `> ${OUT}`,
 * `> $(pwd)/../x`, `> \`pwd\`/x`). Any target carrying one of these is denied fail-closed.
 */
const SHELL_META = /[$~`]/;

/** Whether a Bash redirection target uses shell expansion → un-evaluable, must DENY (S5). */
function hasShellMeta(target: string): boolean {
  return SHELL_META.test(target);
}

/**
 * Extract candidate write-target paths from a Bash command string (Spec 02 §8.2/§8.4).
 * Best-effort heuristic: output redirections (`>`, `>>`, `>|` clobber, `&>` / `&>>` both-streams),
 * output flags (`-o`, `--output[=]`), and `tee`. Never throws; an unparseable command yields no
 * targets (passes through). Targets using shell expansion are still captured here (verbatim) so
 * the caller can DENY them fail-closed via {@link hasShellMeta} (S5).
 */
function extractBashTargets(cmd: string): string[] {
  const targets: string[] = [];
  // &>> | &> | >> | >| | > | -o file | --output file | --output=file | tee file
  // (longest redirection operators first so `&>>`/`>>`/`>|` win over `&>`/`>`).
  const re = /(?:&>>|&>|>>|>\||>|(?:^|\s)-o\s|--output[=\s]|\btee\b\s+)\s*['"]?([^\s'">|;&)]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    const t = m[1];
    if (t && !t.startsWith("&") && t !== "-") targets.push(t);
  }
  return targets;
}

/** Lexically resolve a tool target to an absolute path relative to the worktree root. */
function toAbs(root: string, target: string): string {
  return isAbsolute(target) ? resolve(target) : resolve(root, target);
}

/**
 * Resolve the REAL absolute path of a target that MAY NOT EXIST yet (S4 — symlink escape).
 * A symlink inside the worktree pointing outside (e.g. `link -> /etc`) makes `link/x` resolve
 * lexically inside root while the real write lands outside; a lexical-only check would allow it.
 * Fix (Spec 02 §8.2 hard write boundary): realpath the nearest EXISTING ancestor (canonicalizing
 * any symlink in the prefix), then re-append the not-yet-existing suffix. Never throws.
 */
function realResolve(absPath: string): string {
  let existing = absPath;
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(existing);
      return suffix.length ? join(real, ...suffix) : real;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return absPath; // hit FS root with nothing existing — lexical
      suffix.unshift(basename(existing));
      existing = parent;
    }
  }
}

/**
 * Defensive owned-glob match (N6): a malformed owned glob must not crash the guard. A glob that
 * throws can't confirm scope, so it's skipped — no match ⇒ DENY (fail-closed), never fail-open.
 */
function matchesOwned(rel: string, owned: string[]): boolean {
  for (const g of owned) {
    try {
      if (new Bun.Glob(g).match(rel)) return true;
    } catch {
      // unusable glob — skip; absence of a match keeps us fail-closed
    }
  }
  return false;
}

/**
 * Classify one lexical absolute write target against the worktree + owned globs. `realRoot` is
 * the canonicalized worktree root. Returns null when allowed, or a human reason when denied.
 * Both the root AND the target are realpath-canonicalized first so a symlink escape is caught
 * (S4 — Spec 02 §8.2).
 */
function denyReasonFor(absPath: string, realRoot: string, cfg: ScopeGuardConfig): string | null {
  if (isAllowedSink(absPath)) return null;

  const realTarget = realResolve(absPath);
  const rel = relative(realRoot, realTarget);
  const escapes = rel === "" || rel.startsWith("..") || isAbsolute(rel);
  if (escapes) {
    return `${absPath} resolves outside your worktree (${realRoot}). You may only write inside your worktree scope.`;
  }
  // Inside the worktree. If no owned globs are configured, the whole worktree is writable.
  if (cfg.owned.length === 0) return null;
  if (!matchesOwned(rel, cfg.owned)) {
    return (
      `${rel} is not within your owned paths (${cfg.owned.join(", ")}). ` +
      `Stay inside your scope, or stop and report that you need it.`
    );
  }
  return null;
}

/** Build a PreToolUse deny decision with a human reason (Spec 02 §8.2). */
function denyDecision(reason: string): HookDecision {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Out of scope: ${reason}`,
    },
  };
}

/** The tools whose writes this guard gates (path-write tools + the leaky Bash, Spec 02 §8.2/§8.4). */
export function isGatedWriteTool(tool: string): boolean {
  return PATH_WRITE_TOOLS.has(tool) || tool === "Bash";
}

/**
 * The pure decision function. Given a hook event and resolved config, returns the allow/deny
 * decision. Unknown tools pass through (empty object). MAY throw only on a programming error;
 * the entry point fail-closes write tools around it (N6).
 */
export function evaluateScopeGuard(input: HookInput, cfg: ScopeGuardConfig): HookDecision {
  const tool = typeof input.tool_name === "string" ? input.tool_name : "";
  const ti = (input.tool_input ?? {}) as Record<string, unknown>;

  let targets: string[] = [];
  if (PATH_WRITE_TOOLS.has(tool)) {
    const fp = ti.file_path ?? ti.notebook_path;
    if (typeof fp === "string" && fp) targets = [fp];
  } else if (tool === "Bash") {
    const cmd = typeof ti.command === "string" ? ti.command : "";
    targets = extractBashTargets(cmd);
    // S5: a redirection target using shell expansion ($ ~ `) can't be resolved lexically — the
    // shell expands it at runtime, so a static resolve would wrongly land it inside root. Fail
    // closed: DENY rather than guess (Spec 02 §8.4 — Bash is the leaky tool).
    for (const t of targets) {
      if (hasShellMeta(t)) {
        return denyDecision(
          `Bash write target "${t}" uses shell expansion ($/~/\`) that can't be safely checked. ` +
            `Redirect to an explicit literal path inside your scope, or stop and report.`,
        );
      }
    }
  } else {
    return {}; // not a write tool we gate
  }

  // Canonicalize the worktree root once (S4): defeats a symlinked-prefix escape.
  const realRoot = realResolve(cfg.root);
  for (const t of targets) {
    const reason = denyReasonFor(toAbs(cfg.root, t), realRoot, cfg);
    if (reason !== null) return denyDecision(reason);
  }
  return {};
}

/**
 * Resolve guard config from argv + env (argv wins). Falls back to the event `cwd` for root.
 * Exported so the manager and tests construct config identically.
 */
export function resolveConfig(
  argv: string[],
  env: Record<string, string | undefined>,
  eventCwd?: string,
): ScopeGuardConfig {
  let root = env[WORKTREE_ENV];
  let ownedRaw = env[OWNED_GLOBS_ENV];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && argv[i + 1]) root = argv[++i];
    else if (argv[i] === "--owned" && argv[i + 1] !== undefined) ownedRaw = argv[++i];
  }
  root = root ?? eventCwd ?? process.cwd();
  const owned = (ownedRaw ?? "").split(GLOB_SEP).map((s) => s.trim()).filter(Boolean);
  return { root: resolve(root), owned };
}

// =======================================================================================
// Settings/env producers — the wire from manager → claude spawn (Spec 02 §8.2)
// =======================================================================================

/** The env vars a driver may set on the claude process (env-var fallback path). */
export function scopeGuardEnv(workspace: string, owned: string[]): Record<string, string> {
  return {
    [WORKTREE_ENV]: workspace,
    [OWNED_GLOBS_ENV]: owned.join(GLOB_SEP),
  };
}

/**
 * Return the {@link HookSpec} that registers this hook for a worker. Bakes the root +
 * owned globs into the command args so the hook is self-contained (no env dependency).
 * Pass to {@link renderClaudeSettings} in manager.ts to produce the settings JSON.
 */
export function scopeGuardSpec(
  scopeGuardScriptPath: string,
  workspace: string,
  owned: string[],
): import("./registry.ts").HookSpec {
  const command =
    `bun ${JSON.stringify(scopeGuardScriptPath)} ` +
    `--root ${JSON.stringify(workspace)} ` +
    `--owned ${JSON.stringify(owned.join(GLOB_SEP))}`;
  return {
    event: "PreToolUse",
    matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash",
    command,
  };
}

// =======================================================================================
// Entry point — pure stdin → stdout (the only side effect)
// =======================================================================================

if (import.meta.main) {
  // Never throw out of the hook: a crash would block the tool. But N6 — for a WRITE tool we must
  // bias to DENY (fail-closed) on any internal error, never silently ALLOW under
  // bypassPermissions. Non-write tools (or input we can't even parse to a tool name) pass through.
  let decision: HookDecision = {};
  let input: HookInput | null = null;
  try {
    input = (await Bun.stdin.json()) as HookInput;
    const cfg = resolveConfig(Bun.argv.slice(2), process.env, input.cwd);
    decision = evaluateScopeGuard(input, cfg);
  } catch (err) {
    const tool = typeof input?.tool_name === "string" ? input.tool_name : "";
    decision = isGatedWriteTool(tool)
      ? denyDecision(
          `scope guard could not evaluate this write safely (${
            (err as Error)?.message ?? "internal error"
          }) — denying to stay inside scope (fail-closed).`,
        )
      : {};
  }
  process.stdout.write(JSON.stringify(decision));
}
