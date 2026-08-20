/**
 * Static-parse file-level codemap: header-doc purposes, export-name fallback, hard budget,
 * determinism, and no invented prose.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCodemap } from "./generate.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "codemap-"));
  tmpDirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body, "utf8");
  }
  return dir;
}

const TREE = { sha: "abc123deadbeef", branch: "main" };

test("generateCodemap uses header purposes where they exist and export names otherwise", () => {
  const root = fixture({
    "src/with-doc.ts": `/**
 * Beckett v5 — the capability spine (\`src/capability/index.ts\`)
 * =======================================================================================
 * Phase 0 of the extensibility refactor.
 */
export function remember() {}
`,
    "src/no-doc.ts": `export function load() {}\nexport const STORE = 1;\n`,
    "src/with-doc.test.ts": `/** A test — must not appear. */\nexport const t = 1;\n`,
    "src/__tests__/hidden.ts": `export const hidden = 1;\n`,
    "src/test/scenarios.ts": `/** Fake-harness scenarios. */\nexport const step = 1;\n`,
  });
  const map = generateCodemap(root, { tree: TREE });
  expect(map).toContain("Generated from abc123deadbeef on main");
  expect(map).toContain("not ground truth");
  expect(map).toContain("src/with-doc.ts — Beckett v5 — the capability spine (`src/capability/index.ts`)");
  expect(map).toContain("src/no-doc.ts — exports: STORE, load");
  expect(map).toContain("src/test/scenarios.ts — Fake-harness scenarios.");
  expect(map).not.toContain("with-doc.test.ts");
  expect(map).not.toContain("hidden.ts");
  expect(map).not.toContain("A test — must not appear");
  const noDocLine = map.split("\n").find((l) => l.startsWith("src/no-doc.ts"))!;
  expect(noDocLine).not.toMatch(/\b(handles|manages|implements|responsible)\b/i);
  expect(noDocLine).toContain("exports:");
});

test("a repo with no header comments anywhere still produces a usable export map", () => {
  const root = fixture({
    "src/a.ts": `export const A = 1;\n`,
    "src/b.ts": `export function run() {}\n`,
  });
  const map = generateCodemap(root, { tree: TREE });
  expect(map).toContain("src/a.ts — exports: A");
  expect(map).toContain("src/b.ts — exports: run");
  expect(map.split("\n").find((l) => l.startsWith("src/a.ts"))).toMatch(/exports:/);
});

test("the same tree produces the same map", () => {
  const root = fixture({
    "src/z.ts": `export const Z = 1;\n`,
    "src/a.ts": `/** Alpha helper. */\nexport const A = 1;\n`,
  });
  const first = generateCodemap(root, { tree: TREE });
  const second = generateCodemap(root, { tree: TREE });
  expect(first).toBe(second);
});

test("truncation is deterministic, declared, and keeps the map under the budget", () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 40; i++) {
    const n = String(i).padStart(2, "0");
    files[`src/f${n}.ts`] = `export const V${n} = ${i};\n`;
  }
  const root = fixture(files);
  const map = generateCodemap(root, { tree: TREE, charBudget: 800 });
  expect(map).toContain("TRUNCATED:");
  expect(map.length).toBeLessThanOrEqual(800);
});

test("this repo's map stays under the hard token cap and sources real header lines", () => {
  const root = join(import.meta.dir, "..", "..");
  const map = generateCodemap(root);
  expect(Math.ceil(map.length / 4)).toBeLessThanOrEqual(8_000);
  expect(map).toContain("src/capability/index.ts — Beckett v5 — the capability spine");
  expect(map).toContain("Entry points:");
  expect(map).toContain("src/cli/beckett.ts");
  expect(map).toContain("Tests live:");
  expect(map).toMatch(/Generated from [0-9a-f]{7,}/);
  expect(map).not.toContain("TRUNCATED:");
});
