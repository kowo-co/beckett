/**
 * Beckett — spawn-time environment bootstrap (`src/dispatch/env-bootstrap.ts`)
 * =======================================================================================
 * A worker's first turns should not be spent rediscovering what the workspace already is.
 * At spawn, {@link gatherEnvBootstrap} takes a cheap snapshot of the worker's checkout —
 * `git status --short`, `git log --oneline -10`, the branch/diff base, and the project's
 * toolchain + likely test command — and {@link formatEnvBootstrap} renders it as a
 * shell-transcript-styled `<environment>` block appended to the implement/rework task brief
 * (see `./spawn.ts`; the stage opts in via `StageDefinition.wantsEnvBootstrap`).
 *
 * Design notes:
 *  - Per-spawn workspace state, NOT a capability prompt block: capability blocks are static
 *    persona text composed per-stage with no workspace path in hand. This rides the task
 *    brief, exactly like the pre-read review diff.
 *  - Best-effort by contract. Every gather step is individually guarded and each subprocess
 *    carries a kill timer, so a slow/broken/absent git can never fail or delay a spawn; a
 *    total failure returns `""` and the prompt is byte-identical to one without this feature.
 *  - Size is capped BY CONSTRUCTION (per-section caps + fixed scaffolding < the ceiling), never
 *    by slicing the assembled block — a post-hoc slice could cut the closing tag.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Hard ceiling on the assembled block, enforced by construction via the per-section caps below. */
export const ENV_BOOTSTRAP_MAX_CHARS = 3000;
/** Per-section caps (chars). Sum + fixed scaffolding stays under {@link ENV_BOOTSTRAP_MAX_CHARS}. */
export const STATUS_MAX_CHARS = 1200;
/** Per-section cap (chars) on the `git log --oneline -10` body. */
export const LOG_MAX_CHARS = 700;
/** Per-section cap (chars) on the detected-toolchain line. */
export const TOOLCHAIN_MAX_CHARS = 400;
/** Per-git-subprocess kill budget: bootstrap may never delay a spawn. */
export const GIT_TIMEOUT_MS = 3000;

/** Truncate to `max` chars, marking the cut so the worker knows it is reading a prefix. */
function capText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…(truncated)`;
}

/** Run `git <args>` in cwd with a kill timer. Null on any failure/timeout/non-zero exit; never throws. */
async function runGitCapped(args: string[], cwd: string, timeoutMs: number): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      // Never block on a credential/passphrase prompt — a snapshot must fail fast, not hang.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    clearTimeout(timer);
    return code === 0 ? stdout : null;
  } catch {
    return null;
  }
}

// =======================================================================================
// Toolchain detection
// =======================================================================================

/** What the workspace's manifests say the project is, and how its tests most likely run. */
export interface ToolchainInfo {
  /** Human-readable fragments for every manifest found, joined with `"; "`. */
  toolchain?: string;
  /** The test command from the first (by precedence) manifest that implies one. */
  testCommand?: string;
}

/** Read a file as text, or undefined when it is missing/unreadable. */
function readTextOr(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** `name = "..."` out of a Cargo/pyproject manifest, or undefined. */
function manifestName(text: string): string | undefined {
  return /^\s*name\s*=\s*"([^"]+)"/m.exec(text)?.[1];
}

/** The package-manager-specific test invocation implied by the lockfile present in `dir`. */
function npmTestCommand(dir: string): string {
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) return "bun run test";
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm test";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn test";
  return "npm test";
}

/** The package.json fragment + its test command, or undefined when there is no package.json. */
function detectNode(dir: string): { fragment: string; testCommand?: string } | undefined {
  const text = readTextOr(join(dir, "package.json"));
  if (text === undefined) return undefined;
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { fragment: "node — package.json (unparsable)" };
  }
  const name = typeof pkg.name === "string" ? pkg.name : undefined;
  let fragment = name ? `node — package.json "${name}"` : "node — package.json";
  const scripts = pkg.scripts;
  const scriptNames =
    scripts && typeof scripts === "object" && !Array.isArray(scripts) ? Object.keys(scripts) : [];
  if (scriptNames.length > 0) {
    const shown = scriptNames.slice(0, 12).join(", ");
    fragment += `; scripts: ${shown}${scriptNames.length > 12 ? ", …" : ""}`;
  }
  const test = (scripts as Record<string, unknown> | undefined)?.test;
  const testCommand = typeof test === "string" && test.trim() ? npmTestCommand(dir) : undefined;
  return { fragment, testCommand };
}

/**
 * Inspect `dir`'s manifests for what the project is built with and how its tests most likely
 * run. Every manifest present contributes a toolchain fragment; the FIRST one in precedence
 * order (package.json → Cargo.toml → pyproject.toml → go.mod) that implies a test command wins.
 * Never throws — an unreadable or malformed manifest simply contributes less.
 */
export function detectToolchain(dir: string): ToolchainInfo {
  const fragments: string[] = [];
  let testCommand: string | undefined;
  const take = (command: string | undefined): void => {
    if (testCommand === undefined && command) testCommand = command;
  };

  const node = detectNode(dir);
  if (node) {
    fragments.push(node.fragment);
    take(node.testCommand);
  }

  const cargo = readTextOr(join(dir, "Cargo.toml"));
  if (cargo !== undefined) {
    const name = manifestName(cargo);
    fragments.push(name ? `rust — Cargo.toml "${name}"` : "rust — Cargo.toml");
    take("cargo test");
  }

  const pyproject = readTextOr(join(dir, "pyproject.toml"));
  if (pyproject !== undefined) {
    const name = manifestName(pyproject);
    fragments.push(name ? `python — pyproject.toml "${name}"` : "python — pyproject.toml");
    take("pytest");
  }

  const gomod = readTextOr(join(dir, "go.mod"));
  if (gomod !== undefined) {
    const module = /^module\s+(\S+)/m.exec(gomod)?.[1];
    fragments.push(module ? `go — go.mod (${module})` : "go — go.mod");
    take("go test ./...");
  }

  return { toolchain: fragments.length ? fragments.join("; ") : undefined, testCommand };
}

// =======================================================================================
// Rendering
// =======================================================================================

/** The raw snapshot {@link formatEnvBootstrap} renders; every field is independently optional. */
export interface EnvBootstrapInputs {
  /** `git status --short` output; "" means clean; undefined means git failed → omit. */
  status?: string;
  /** `git log --oneline -10` output; undefined/empty → omit. */
  log?: string;
  branch?: string;
  baseRef?: string;
  toolchain?: string;
  testCommand?: string;
}

/**
 * Render the snapshot as the shell-transcript-styled `<environment>` block appended to a task
 * brief. Absent sections are omitted entirely; with nothing to say it returns `""` so the
 * prompt stays byte-identical to one built without bootstrap. The result is guaranteed under
 * {@link ENV_BOOTSTRAP_MAX_CHARS} by the per-section caps.
 */
export function formatEnvBootstrap(inputs: EnvBootstrapInputs): string {
  const lines: string[] = [];

  if (inputs.branch) {
    const base = inputs.baseRef && inputs.baseRef !== "HEAD" ? ` (diff base: ${inputs.baseRef})` : "";
    lines.push(`Branch: ${inputs.branch}${base}`);
  }
  if (inputs.status !== undefined) {
    lines.push("$ git status --short");
    const body = inputs.status.trimEnd();
    lines.push(body.trim() ? capText(body, STATUS_MAX_CHARS) : "(clean)");
  }
  const log = inputs.log?.trimEnd();
  if (log) {
    lines.push("$ git log --oneline -10");
    lines.push(capText(log, LOG_MAX_CHARS));
  }
  if (inputs.toolchain) lines.push(`Toolchain: ${capText(inputs.toolchain, TOOLCHAIN_MAX_CHARS)}`);
  if (inputs.testCommand) lines.push(`Likely test command: ${inputs.testCommand}`);

  if (lines.length === 0) return "";
  const header = "Workspace snapshot (captured at spawn; it may drift as you work):";
  return `<environment>\n${header}\n${lines.join("\n")}\n</environment>`;
}

/**
 * Take the spawn-time snapshot of `workspace` and render it. Never throws and never delays a
 * spawn meaningfully: each git call is killed after `opts.timeoutMs` (default
 * {@link GIT_TIMEOUT_MS}) and any failure just drops its section. Returns `""` when there is
 * nothing to report — a non-git directory with no manifests, or a path that does not exist.
 */
export async function gatherEnvBootstrap(
  workspace: string,
  opts: { branch?: string; baseRef?: string; timeoutMs?: number } = {},
): Promise<string> {
  try {
    const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
    const status = await runGitCapped(["status", "--short"], workspace, timeoutMs);
    const log = await runGitCapped(["log", "--oneline", "-10"], workspace, timeoutMs);
    const branch =
      opts.branch ??
      (await runGitCapped(["rev-parse", "--abbrev-ref", "HEAD"], workspace, timeoutMs))?.trim();
    const { toolchain, testCommand } = detectToolchain(workspace);
    return formatEnvBootstrap({
      status: status ?? undefined,
      log: log ?? undefined,
      branch: branch || undefined,
      baseRef: opts.baseRef,
      toolchain,
      testCommand,
    });
  } catch {
    return "";
  }
}
