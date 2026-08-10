/**
 * Spawn scaffolding — the per-worker betterwright MCP config.
 *
 * The worker's MCP server is a DIRECT exec of Beckett's own pinned
 * `node_modules/.bin/betterwright`, not `npx`: no package-manager resolution ever
 * runs against the worker's project checkout, so a worker's repo can never grow a
 * betterwright install. Test 3 proves that end to end against the real binary.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { workerBrowserProfileName, workerMcpServerConfig, writeWorkerMeta } from "./spawn.ts";

/** betterwright's own profile-name allowlist (node_modules/betterwright/dist/src/profile-name.js). */
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const beckettRoot = join(import.meta.dir, "..", "..");

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("workerMcpServerConfig", () => {
  const config = workerMcpServerConfig({
    beckettRoot: "/opt/beckett",
    sharedHome: "/var/lib/beckett/worker-browser",
    workspace: "/home/beckett/Projects/widget",
  });

  test("directly execs Beckett's pinned binary — no npx, no prefix flags", () => {
    expect(config.command).toBe("/opt/beckett/node_modules/.bin/betterwright");
    expect(config.command.startsWith("/")).toBe(true);
    expect(config.args).toEqual(["mcp"]);
    expect(config.args).not.toContain("--no-install");
    expect(config.args).not.toContain("--prefix");
    expect(config.command).not.toBe("npx");
  });

  test("shares one home and isolates identity with a named profile", () => {
    expect(config.env.BETTERWRIGHT_HOME).toBe("/var/lib/beckett/worker-browser");
    expect(config.env.BETTERWRIGHT_HEADLESS).toBe("1");
    expect(config.env.BETTERWRIGHT_PROFILE).toMatch(/^wk-[0-9a-f]{12}$/);
  });

  test("sets no Obscura env — the unsandboxed server discovers ~/.betterwright/obscura itself", () => {
    expect(Object.keys(config.env).filter((k) => k.startsWith("BETTERWRIGHT_OBSCURA"))).toEqual([]);
  });
});

describe("workerBrowserProfileName", () => {
  test("is stable per workspace and distinct across workspaces", () => {
    expect(workerBrowserProfileName("/home/beckett/Projects/widget")).toBe(
      workerBrowserProfileName("/home/beckett/Projects/widget"),
    );
    expect(workerBrowserProfileName("/home/beckett/Projects/widget")).not.toBe(
      workerBrowserProfileName("/home/beckett/Projects/gadget"),
    );
  });

  test("satisfies betterwright's profile-name rule", () => {
    for (const workspace of ["/home/beckett/Projects/widget", "/tmp/x", "relative/path"]) {
      const name = workerBrowserProfileName(workspace);
      expect(name).toMatch(PROFILE_NAME_PATTERN);
      expect(name.length).toBeLessThanOrEqual(64);
    }
  });
});

describe("direct exec of the installed betterwright binary", () => {
  test("runs from an unrelated cwd and installs nothing there", () => {
    const bin = join(beckettRoot, "node_modules", ".bin", "betterwright");
    expect(existsSync(bin)).toBe(true);

    const cwd = tempDir("bw-exec-test-");
    const result = Bun.spawnSync({ cmd: [bin, "--version"], cwd });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim().startsWith("1.")).toBe(true);

    // Containment: resolution is cwd-independent, so the directory the command ran
    // in never grew a node_modules of its own.
    expect(readdirSync(cwd)).not.toContain("node_modules");
  });
});

describe("writeWorkerMeta", () => {
  test("writes the MCP config and creates the shared browser home", () => {
    const repoRoot = tempDir("bw-meta-repo-");
    const sharedHome = join(tempDir("bw-meta-state-"), "worker-browser");

    const { mcpConfigPath } = writeWorkerMeta(repoRoot, join(repoRoot, "guard.ts"), [], join(repoRoot, "awareness.ts"), 0, sharedHome);

    const written = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
    expect(written.mcpServers.betterwright).toEqual(
      workerMcpServerConfig({ beckettRoot, sharedHome, workspace: repoRoot }),
    );
    expect(existsSync(sharedHome)).toBe(true);
  });
});
