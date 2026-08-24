/**
 * `beckett dream run --dry` — hermetic CLI-level coverage.
 * =======================================================================================
 * `out()` (`src/cli/io.ts`) prints and calls `process.exit(0)` — it is `never`, so a handler
 * that calls it twice on one path never reaches the second call. `dream-cli.ts` used to do
 * exactly that: print the "## prompt" block, then exit before the JSON summary line ever ran.
 * These tests exercise the REAL subprocess (same hermetic-sandbox pattern as
 * `characterization.test.ts`) so the fix is pinned at the level the bug actually lived: what
 * `beckett dream run --dry` prints to stdout, not just what `runDreamPass` returns in-process.
 *
 * A quiet night (no `~/.beckett/channels/*` data in a fresh sandbox) short-circuits before any
 * model call — the pass reviews nothing and never spawns `claude -p` — so this suite never needs
 * a real or faked harness binary.
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");
const cliPath = join(repoRoot, "src", "cli", "beckett.ts");

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface CliResult {
  exit: number;
  stdout: string;
  stderr: string;
}

async function beckett(argv: string[], env: Record<string, string> = {}): Promise<CliResult> {
  const sandbox = mkdtempSync(join(tmpdir(), "beckett-dream-cli-"));
  tmpDirs.push(sandbox);
  const home = join(sandbox, "home");
  const beckettDir = join(sandbox, ".beckett");
  mkdirSync(home, { recursive: true });
  mkdirSync(beckettDir, { recursive: true });
  const proc = Bun.spawn(["bun", cliPath, ...argv], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH ?? "", HOME: home, BECKETT_HOME: home, BECKETT_DIR: beckettDir, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exit, stdout, stderr };
}

test("dream run --dry on a quiet night prints the prompt block AND the JSON summary in one go", async () => {
  const { exit, stdout } = await beckett(["dream", "run", "--dry"]);
  expect(exit).toBe(0);

  // The human-readable dry-run report — this is the half that used to never print.
  expect(stdout).toContain("# dream — dry run");
  expect(stdout).toContain("## prompt");
  expect(stdout).toContain("## would commit");
  expect(stdout).toContain("(nothing would be committed)");

  // The JSON summary — this is the half that used to print ALONE, with nothing above it.
  expect(stdout).toContain("## summary");
  const jsonBlock = stdout.slice(stdout.indexOf("## summary") + "## summary".length).trim();
  const summary = JSON.parse(jsonBlock) as Record<string, unknown>;
  expect(summary.quiet).toBe(true);
  expect(summary.wrote).toBe(false);
  expect(summary.dry).toBe(true);
  expect(summary.memories).toEqual([]);
  expect(summary.memoriesPlanned).toEqual([]);
});

test("dream run --dry never writes a journal entry or touches the memory graph", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "beckett-dream-cli-nowrite-"));
  tmpDirs.push(sandbox);
  const home = join(sandbox, "home");
  const beckettDir = join(sandbox, ".beckett");
  mkdirSync(home, { recursive: true });
  mkdirSync(beckettDir, { recursive: true });

  const { exit } = await runIn(beckettDir, home, ["dream", "run", "--dry"]);
  expect(exit).toBe(0);

  expect(existsSync(join(beckettDir, "dreams"))).toBe(false);
  expect(existsSync(join(beckettDir, "memory", "dreams"))).toBe(false);
});

test("dream run refuses when [dream] enabled=false, before assembling anything", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "beckett-dream-cli-disabled-"));
  tmpDirs.push(sandbox);
  const home = join(sandbox, "home");
  const beckettDir = join(sandbox, ".beckett");
  mkdirSync(home, { recursive: true });
  mkdirSync(beckettDir, { recursive: true });
  await Bun.write(join(beckettDir, "config.toml"), "[dream]\nenabled = false\n");

  const { exit, stderr } = await runIn(beckettDir, home, ["dream", "run", "--dry"]);
  expect(exit).toBe(1);
  expect(stderr).toContain("dream pass is disabled");

  // Nothing assembled either — no journal entry from a run that never should have started.
  expect(existsSync(join(beckettDir, "dreams"))).toBe(false);
});

/** Run against a caller-controlled sandbox (so a prior write, like a hand-authored config.toml,
 *  is visible to the CLI process instead of being sealed inside a fresh one). */
async function runIn(beckettDir: string, home: string, argv: string[]): Promise<CliResult> {
  const proc = Bun.spawn(["bun", cliPath, ...argv], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH ?? "", HOME: home, BECKETT_HOME: home, BECKETT_DIR: beckettDir },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exit, stdout, stderr };
}
