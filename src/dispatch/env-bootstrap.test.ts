/**
 * Environment-bootstrap tests (`src/dispatch/env-bootstrap.ts`).
 * Pins the three contracts spawn.ts leans on: manifest/lockfile-driven toolchain detection,
 * the exact `<environment>` block shape (including the omit-everything → `""` case that keeps
 * a bootstrap-less prompt byte-identical), and the never-throws/hard-capped gather.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectToolchain,
  formatEnvBootstrap,
  gatherEnvBootstrap,
  ENV_BOOTSTRAP_MAX_CHARS,
  STATUS_MAX_CHARS,
} from "./env-bootstrap.ts";

const dirs: string[] = [];

function fixture(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "beckett-envboot-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const PKG = JSON.stringify({ name: "acme", scripts: { build: "x", test: "bun test" } });

describe("detectToolchain", () => {
  test("package.json + bun lockfile → named node fragment, script list, bun runner", () => {
    const info = detectToolchain(fixture({ "package.json": PKG, "bun.lock": "" }));
    expect(info.toolchain).toContain('node — package.json "acme"');
    expect(info.toolchain).toContain("scripts: build, test");
    expect(info.testCommand).toBe("bun run test");
  });

  test("the lockfile picks the runner", () => {
    expect(detectToolchain(fixture({ "package.json": PKG, "package-lock.json": "{}" })).testCommand).toBe("npm test");
    expect(detectToolchain(fixture({ "package.json": PKG, "yarn.lock": "" })).testCommand).toBe("yarn test");
    expect(detectToolchain(fixture({ "package.json": PKG, "pnpm-lock.yaml": "" })).testCommand).toBe("pnpm test");
  });

  test("no test script → no test command, toolchain still reported", () => {
    const info = detectToolchain(fixture({ "package.json": JSON.stringify({ name: "acme", scripts: { build: "x" } }) }));
    expect(info.testCommand).toBeUndefined();
    expect(info.toolchain).toContain('node — package.json "acme"');
  });

  test("malformed package.json degrades instead of throwing", () => {
    const info = detectToolchain(fixture({ "package.json": "{nope" }));
    expect(info.toolchain).toContain("(unparsable)");
    expect(info.testCommand).toBeUndefined();
  });

  test("Cargo.toml → rust + cargo test", () => {
    const info = detectToolchain(fixture({ "Cargo.toml": '[package]\nname = "mycrate"\n' }));
    expect(info.toolchain).toContain('rust — Cargo.toml "mycrate"');
    expect(info.testCommand).toBe("cargo test");
  });

  test("pyproject.toml → python + pytest", () => {
    const info = detectToolchain(fixture({ "pyproject.toml": '[project]\nname = "pyproj"\n' }));
    expect(info.toolchain).toContain("python");
    expect(info.testCommand).toBe("pytest");
  });

  test("go.mod → go + go test", () => {
    const info = detectToolchain(fixture({ "go.mod": "module example.com/m\n\ngo 1.22\n" }));
    expect(info.toolchain).toContain("go — go.mod (example.com/m)");
    expect(info.testCommand).toBe("go test ./...");
  });

  test("every manifest contributes a fragment; the first by precedence owns the test command", () => {
    const info = detectToolchain(fixture({ "package.json": PKG, "Cargo.toml": '[package]\nname = "mycrate"\n' }));
    expect(info.toolchain).toBe('node — package.json "acme"; scripts: build, test; rust — Cargo.toml "mycrate"');
    expect(info.testCommand).toBe("npm test");
  });

  test("no manifest → nothing detected", () => {
    expect(detectToolchain(fixture())).toEqual({});
  });
});

describe("formatEnvBootstrap", () => {
  test("renders every section in order", () => {
    const out = formatEnvBootstrap({
      status: " M src/a.ts\n",
      log: "abc1234 did a thing\n",
      branch: "b",
      baseRef: "origin/main",
      toolchain: "node — package.json",
      testCommand: "bun test",
    });
    expect(out.startsWith("<environment>")).toBe(true);
    expect(out.endsWith("</environment>")).toBe(true);
    const order = [
      "Branch: b (diff base: origin/main)",
      "$ git status --short",
      "$ git log --oneline -10",
      "Toolchain:",
      "Likely test command:",
    ].map((needle) => out.indexOf(needle));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test("nothing to report → empty string (prompt stays byte-identical)", () => {
    expect(formatEnvBootstrap({})).toBe("");
  });

  test("a clean tree is content, not absence", () => {
    expect(formatEnvBootstrap({ status: "" })).toContain("(clean)");
  });

  test("a HEAD base ref is not worth printing", () => {
    expect(formatEnvBootstrap({ branch: "b", baseRef: "HEAD" })).not.toContain("diff base");
  });

  test("oversized sections truncate and the block stays under the hard cap", () => {
    const status = Array.from({ length: 200 }, (_, i) => `?? some/long/path/to/a/file-${i}.ts`).join("\n");
    const log = Array.from({ length: 100 }, (_, i) => `abc12${i} a reasonably wordy commit subject here`).join("\n");
    expect(status.length).toBeGreaterThan(5000);
    expect(log.length).toBeGreaterThan(3000);
    const out = formatEnvBootstrap({ status, log, branch: "b", baseRef: "origin/main", toolchain: "node", testCommand: "bun test" });
    expect(out).toContain("…(truncated)");
    const body = out.slice(out.indexOf("$ git status --short"), out.indexOf("$ git log --oneline -10"));
    expect(body.length).toBeLessThanOrEqual(STATUS_MAX_CHARS + "\n…(truncated)".length + "$ git status --short\n\n".length);
    expect(out.length).toBeLessThanOrEqual(ENV_BOOTSTRAP_MAX_CHARS);
  });
});

describe("gatherEnvBootstrap", () => {
  test("a non-git directory still reports its toolchain", async () => {
    const out = await gatherEnvBootstrap(fixture({ "package.json": PKG, "bun.lock": "" }));
    expect(out).toContain("Toolchain:");
    expect(out).not.toContain("$ git status");
  });

  test("a real repo reports status, log, and branch", async () => {
    const dir = fixture();
    Bun.spawnSync(["git", "init", "-b", "main"], { cwd: dir });
    Bun.spawnSync(
      ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "first"],
      { cwd: dir },
    );
    writeFileSync(join(dir, "scratch.txt"), "hi");

    const out = await gatherEnvBootstrap(dir);
    expect(out).toContain("$ git status --short");
    expect(out).toContain("scratch.txt");
    expect(out).toContain("first");
    expect(out).toContain("Branch: main");
  });

  test("caller-supplied branch and base ref win", async () => {
    const dir = fixture();
    Bun.spawnSync(["git", "init", "-b", "main"], { cwd: dir });
    Bun.spawnSync(
      ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "first"],
      { cwd: dir },
    );

    const out = await gatherEnvBootstrap(dir, { branch: "beckett/ops-1", baseRef: "origin/main" });
    expect(out).toContain("Branch: beckett/ops-1 (diff base: origin/main)");
  });

  test("a path that does not exist resolves to nothing", async () => {
    expect(await gatherEnvBootstrap(join(tmpdir(), "does-not-exist-xyz"))).toBe("");
  });
});
