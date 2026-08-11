/**
 * W2A — the Concierge session's own argv gains cross-session addressing (Claude Code ≥2.1.224):
 * a fixed `--name beckett-concierge` and a `--settings <path>` rendering `{"crossSessionInbound":
 * "accept"}` (no hooks — the concierge stays MCP-free/hook-free by design, OPS-43), so a live
 * worker's SendMessage for a status question actually lands instead of being held/dropped.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../config.ts";
import { ConciergeSession } from "./index.ts";

const dirs: string[] = [];
const priorDir = process.env.BECKETT_DIR;
afterEach(() => {
  if (priorDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = priorDir;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const quietLog = (() => {
  const q = { info() {}, warn() {}, debug() {}, error() {}, child() { return q; } };
  return q as never;
})();

function config() {
  const dir = mkdtempSync(join(tmpdir(), "beckett-concierge-args-"));
  dirs.push(dir);
  process.env.BECKETT_DIR = dir;
  // composeSystemPrompt()'s doctrine block resolves the GitHub owner — give it a config value so
  // buildArgs doesn't need GITHUB_ACCOUNT set in the test env.
  return validateConfig({ identity: { github_user: "octocat" } });
}

test("buildArgs names the session beckett-concierge and passes --settings", () => {
  const s = new ConciergeSession({ config: config(), logger: quietLog }) as unknown as {
    buildArgs(isResume: boolean): string[];
  };
  const args = s.buildArgs(false);

  const nameIdx = args.indexOf("--name");
  expect(nameIdx).toBeGreaterThanOrEqual(0);
  expect(args[nameIdx + 1]).toBe("beckett-concierge");

  const settingsIdx = args.indexOf("--settings");
  expect(settingsIdx).toBeGreaterThanOrEqual(0);
  const settingsPath = args[settingsIdx + 1]!;
  expect(existsSync(settingsPath)).toBe(true);

  // Stays MCP-free by design (OPS-43).
  expect(args).not.toContain("--mcp-config");
});

test("the rendered settings file carries crossSessionInbound: accept with no hooks", () => {
  const s = new ConciergeSession({ config: config(), logger: quietLog }) as unknown as {
    buildArgs(isResume: boolean): string[];
  };
  const args = s.buildArgs(false);
  const settingsPath = args[args.indexOf("--settings") + 1]!;
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  expect(settings).toEqual({ crossSessionInbound: "accept", hooks: {} });
});

test("--name/--settings ride a resume launch too", () => {
  const s = new ConciergeSession({ config: config(), logger: quietLog }) as unknown as {
    buildArgs(isResume: boolean): string[];
  };
  const args = s.buildArgs(true);
  expect(args).toContain("--resume");
  expect(args[args.indexOf("--name") + 1]).toBe("beckett-concierge");
  expect(args).toContain("--settings");
});
