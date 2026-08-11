/**
 * W2A — the Concierge session's own argv gains cross-session addressing (Claude Code ≥2.1.224):
 * a `--name beckett-concierge-<scope>` and a `--settings <path>` rendering `{"crossSessionInbound":
 * "accept"}` (no hooks — the concierge stays MCP-free/hook-free by design, OPS-43), so a live
 * worker's SendMessage for a status question actually lands instead of being held/dropped.
 *
 * W2B narrowed the NAME: W2A launched every pool scope as the same fixed `beckett-concierge`,
 * which is an address collision as soon as two pooled sessions are live (the pool runs up to 6
 * plus SYSTEM_SCOPE). The name now carries the scope's last 6 characters.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../config.ts";
import { primeNameFlagSupport } from "../drivers/claude.ts";
import { ConciergeSession, conciergeSessionName } from "./index.ts";

// These tests pin the SHAPE of the argv; whether the host machine's claude binary advertises
// --name (CI runners have none) must not decide the outcome.
primeNameFlagSupport("claude", true);

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

test("buildArgs names the session beckett-concierge-<scope> and passes --settings", () => {
  const s = new ConciergeSession({ config: config(), logger: quietLog }) as unknown as {
    buildArgs(isResume: boolean): string[];
  };
  const args = s.buildArgs(false);

  const nameIdx = args.indexOf("--name");
  expect(nameIdx).toBeGreaterThanOrEqual(0);
  expect(args[nameIdx + 1]).toBe("beckett-concierge-global");

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
  expect(args[args.indexOf("--name") + 1]).toBe("beckett-concierge-global");
  expect(args).toContain("--settings");
});

// W2B: the collision fix. Concurrent pool sessions must not all register the same address.
test("each pool scope launches under its OWN cross-session address", () => {
  const cfg = config();
  const named = (scope: string) => {
    const s = new ConciergeSession({ config: cfg, logger: quietLog, scope }) as unknown as {
      buildArgs(isResume: boolean): string[];
    };
    const args = s.buildArgs(false);
    return args[args.indexOf("--name") + 1];
  };
  expect(named("system")).toBe("beckett-concierge-system");
  expect(named("1187482913482913")).toBe("beckett-concierge-482913");
  expect(named("1187482913111222")).toBe("beckett-concierge-111222");
  expect(named("1187482913482913")).not.toBe(named("1187482913111222"));
});

test("conciergeSessionName: short scopes keep their word, junk never leaks into argv", () => {
  expect(conciergeSessionName("system")).toBe("beckett-concierge-system");
  expect(conciergeSessionName("")).toBe("beckett-concierge-global");
  expect(conciergeSessionName("   ")).toBe("beckett-concierge-global");
  expect(conciergeSessionName("dm")).toBe("beckett-concierge-dm");
  // Anything that could need quoting is stripped before the last-6 slice.
  expect(conciergeSessionName("a b/c*d?e")).toBe("beckett-concierge-abcde");
  expect(conciergeSessionName("!!!!")).toBe("beckett-concierge-global");
});
