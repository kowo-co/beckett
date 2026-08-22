import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { census } from "./dead-exports.ts";

/** This repo's root — two dirs up from `scripts/ops/`. */
const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** Write a fixture file, creating parent dirs as needed. */
function writeFixtureFile(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(resolve(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

function makeFixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), "dead-exports-test-"));
}

describe("dead-exports census", () => {
  test("the census counts do not exceed the committed baseline", () => {
    const baseline = JSON.parse(
      readFileSync(join(REPO_ROOT, "scripts/ops/dead-exports.baseline.json"), "utf8"),
    ) as { dead: number; testOnly: number; generatedFrom: string };
    const result = census(REPO_ROOT);

    const grew: string[] = [];
    if (result.dead > baseline.dead) grew.push(`dead: ${baseline.dead} -> ${result.dead}`);
    if (result.testOnly > baseline.testOnly) grew.push(`testOnly: ${baseline.testOnly} -> ${result.testOnly}`);

    if (grew.length > 0) {
      const CAP = 25;
      const shown = result.entries.slice(0, CAP).map((e) => `  ${e.status.padEnd(9)} ${e.file}::${e.symbol}`);
      const remainder = result.entries.length - shown.length;
      const dump =
        shown.join("\n") +
        (remainder > 0 ? `\n  ... and ${remainder} more — run \`bun run dead-exports --json\` for the full list` : "");
      throw new Error(
        `dead-exports census grew past the committed baseline (${grew.join(", ")}).\n` +
          `Entries (dead + test-only, capped at ${CAP}):\n${dump}\n\n` +
          "Run `bun run dead-exports`, delete or un-export the symbol, or `--write-baseline` if the growth is deliberate.",
      );
    }

    expect(result.dead).toBeLessThanOrEqual(baseline.dead);
    expect(result.testOnly).toBeLessThanOrEqual(baseline.testOnly);
  });

  test("a symbol imported only by a *.test.ts is test-only, not dead", () => {
    const root = makeFixtureRoot();
    try {
      writeFixtureFile(root, "src/x.ts", `export function onlyTested() { return 1; }\n`);
      writeFixtureFile(root, "src/x.test.ts", `import { onlyTested } from "./x.ts";\nonlyTested();\n`);
      const result = census(root);
      const entry = result.entries.find((e) => e.symbol === "onlyTested");
      expect(entry?.status).toBe("test-only");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a symbol reached through a dynamic import is live", () => {
    const root = makeFixtureRoot();
    try {
      writeFixtureFile(root, "src/x.ts", `export function runFoo() { return 1; }\n`);
      writeFixtureFile(
        root,
        "src/caller.ts",
        `async function go() {\n  return (await import("./x.ts")).runFoo();\n}\n`,
      );
      const result = census(root);
      expect(result.entries.find((e) => e.symbol === "runFoo")).toBeUndefined();
      expect(result.live).toBe(1); // runFoo (go itself is not exported, so it isn't scanned)
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a namespace import marks every export of the target used", () => {
    const root = makeFixtureRoot();
    try {
      writeFixtureFile(
        root,
        "src/x.ts",
        `export function a() { return 1; }\nexport function b() { return 2; }\n`,
      );
      writeFixtureFile(root, "src/caller.ts", `import * as ns from "./x.ts";\nns.a();\n`);
      const result = census(root);
      // Both `a` and `b` are marked used, even though only `a` is actually read off `ns`.
      expect(result.entries.find((e) => e.symbol === "a")).toBeUndefined();
      expect(result.entries.find((e) => e.symbol === "b")).toBeUndefined();
      expect(result.live).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an aliased named import is live under its SOURCE name, not the local alias", () => {
    const root = makeFixtureRoot();
    try {
      // Regression for a real false-dead: `import { workerId as mintWorkerId } from "../ids.ts"`
      // was recording usage of "mintWorkerId" (the local alias) against ids.ts, which never
      // matches any real export there — so the census reported the actually-used `workerId` as
      // dead. The importer reference must use the SOURCE name ("workerId"), not the alias.
      writeFixtureFile(root, "src/x.ts", `export function workerId() { return 1; }\n`);
      writeFixtureFile(
        root,
        "src/caller.ts",
        `import { workerId as mintWorkerId } from "./x.ts";\nmintWorkerId();\n`,
      );
      const result = census(root);
      const entry = result.entries.find((e) => e.symbol === "workerId");
      expect(entry).toBeUndefined();
      expect(result.live).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an in-file-only caller does not count as an importer", () => {
    const root = makeFixtureRoot();
    try {
      // The scope-guard shape: an exported helper called only from within its own file.
      writeFixtureFile(
        root,
        "src/x.ts",
        `export function helper() { return 1; }\nexport function user() { return helper(); }\n`,
      );
      const result = census(root);
      const entry = result.entries.find((e) => e.symbol === "helper");
      expect(entry?.status).toBe("dead");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the ignore file suppresses an entry", () => {
    const root = makeFixtureRoot();
    try {
      writeFixtureFile(root, "src/x.ts", `export function ignoredDead() { return 1; }\n`);
      writeFixtureFile(
        root,
        "scripts/ops/dead-exports.ignore.txt",
        `src/x.ts::ignoredDead  # fixture reason\n`,
      );
      const result = census(root);
      expect(result.entries.find((e) => e.symbol === "ignoredDead")).toBeUndefined();
      // Suppressed entirely: neither listed nor counted in the totals.
      expect(result.dead).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    // The real ignore file still pins the runs lane's B9 dependency — a future sweep must not
    // silently drop this line.
    const realIgnore = readFileSync(join(REPO_ROOT, "scripts/ops/dead-exports.ignore.txt"), "utf8");
    expect(realIgnore).toContain("src/worker/worktree.ts::mergeBranchesIntoWorktree");
  });

  test("a self-import is not an importer", () => {
    const root = makeFixtureRoot();
    try {
      // A file that both declares and (hypothetically) re-imports its own export doesn't count.
      writeFixtureFile(
        root,
        "src/x.ts",
        `export function selfOnly() { return 1; }\nimport { selfOnly as _s } from "./x.ts";\n`,
      );
      const result = census(root);
      const entry = result.entries.find((e) => e.symbol === "selfOnly");
      expect(entry?.status).toBe("dead");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a bare-specifier import is skipped", () => {
    const root = makeFixtureRoot();
    try {
      writeFixtureFile(root, "src/x.ts", `export function untouched() { return 1; }\n`);
      writeFixtureFile(root, "src/caller.ts", `import { readFileSync } from "node:fs";\nreadFileSync;\n`);
      const result = census(root);
      const entry = result.entries.find((e) => e.symbol === "untouched");
      expect(entry?.status).toBe("dead");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("src/worker/worktree.ts::mergeBranchesIntoWorktree stays reachable (worktree.integration.test.ts exercises it)", () => {
  // A sanity pin, not a re-run of the integration suite: the census must not report this symbol
  // as dead, because the ignore file suppresses it and the runs lane depends on it.
  const result = census(REPO_ROOT);
  expect(result.entries.find((e) => e.symbol === "mergeBranchesIntoWorktree")).toBeUndefined();
});
