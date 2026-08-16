#!/usr/bin/env bun
/**
 * dead-exports: a regex + specifier-resolution census of exported symbols in non-test `src/`.
 *
 * For every module-level `export` in non-test `src/**\/*.ts`, this walks `src/**`, `scripts/**`,
 * `tests/**`, `bench/**`, `deploy/*.ts` looking for an importer. A symbol with zero importers at
 * all is "dead"; a symbol imported only from `*.test.ts` files is "test-only" (a seam, not debt).
 * Everything else is "live" and does not appear in the report.
 *
 * This is deliberately NOT the TypeScript compiler API — it is regex + string resolution so the
 * whole census runs in well under a second and can gate the fast test lane in-process.
 *
 * What it understands:
 *   - Declared exports: `export (async )?function|const|let|class|interface|type|enum <name>`,
 *     `export { a, b as c }` / `export type { a, b as c }` (including `export { a } from "..."`
 *     and `export type { a } from "..."` re-exports), and `export * from "..."` (treated as a
 *     namespace re-export of the target — every export of the target counts as used, because the
 *     re-exporting file is itself a potential importer path we do not fully resolve transitively).
 *   - Importers: `import { a, b as c } from "..."`, `import type { ... } from "..."`,
 *     `import * as ns from "..."` (marks every export of the target used), and the two dynamic
 *     forms this repo actually uses: `(await import("./x.ts")).runFoo` (member access) and
 *     `const { Y } = await import("./x.ts")` (destructure). Only relative specifiers (`./`, `../`)
 *     are resolved; bare package specifiers are skipped. A file importing itself does not count.
 *   - An ignore file, `scripts/ops/dead-exports.ignore.txt`, one `path::symbol  # reason` per
 *     line — entries there are suppressed from the dead/test-only report entirely.
 *
 * What it deliberately does NOT understand: string-built import paths, `Bun.$` shell-outs, or
 * systemd ExecStart entrypoints. Those are why the deletion sweep this tool justifies is grep-
 * verified by hand, not auto-applied.
 */

import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { execSync } from "node:child_process";

export interface DeadExport {
  file: string; // repo-relative, e.g. "src/worker/worktree.ts"
  symbol: string;
  kind: "value" | "type";
  status: "dead" | "test-only";
}

export interface CensusResult {
  scanned: number; // exported symbols in non-test src/
  live: number;
  testOnly: number;
  dead: number;
  entries: DeadExport[]; // dead + test-only, sorted by file then symbol
}

interface ExportDecl {
  absFile: string;
  symbol: string;
  kind: "value" | "type";
}

const EXPORT_ROOTS = ["src"];
const IMPORTER_ROOTS = ["src", "scripts", "tests", "bench"];
// deploy/ only scans its own top-level *.ts files (deploy/dev/**, deploy/systemd/** etc. are not
// TypeScript source we track importers through).
const DEPLOY_ROOT = "deploy";

const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "__snapshots__"]);

function isTestFile(relPath: string): boolean {
  return relPath.endsWith(".test.ts") || relPath.endsWith(".test.tsx");
}

function walkTsFiles(absRoot: string, out: string[]): void {
  if (!existsSync(absRoot)) return;
  const entries = readdirSync(absRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const abs = join(absRoot, entry.name);
    if (entry.isDirectory()) {
      walkTsFiles(abs, out);
    } else if (entry.isFile() && (abs.endsWith(".ts") || abs.endsWith(".tsx"))) {
      out.push(abs);
    }
  }
}

function collectFiles(repoRoot: string, roots: string[]): string[] {
  const out: string[] = [];
  for (const root of roots) {
    walkTsFiles(join(repoRoot, root), out);
  }
  return out;
}

function collectDeployTopLevelFiles(repoRoot: string): string[] {
  const abs = join(repoRoot, DEPLOY_ROOT);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(join(abs, entry.name));
    }
  }
  return out;
}

// export (async)? function|const|let|class NAME
const RE_EXPORT_VALUE = /^export\s+(?:async\s+)?(?:function\s*\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/;
// export interface|type NAME (type alias declaration, not `export type { ... }`)
const RE_EXPORT_TYPE = /^export\s+(?:interface|type)\s+([A-Za-z_$][\w$]*)/;
// export enum NAME (runtime value)
const RE_EXPORT_ENUM = /^export\s+(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/;
// export { a, b as c }  — declared local export, NOT a re-export (no trailing `from`). Runs across
// lines since `[^}]` matches newlines too; the brace-list forms below use whole-source matching
// rather than per-line so a multi-line `export {\n  a,\n  b,\n}` block still resolves.
const RE_EXPORT_LIST_LOCAL = /^export\s+(type\s+)?\{([^}]*)\}\s*;?\s*$/gm;
// export { a } from "..."  /  export type { a } from "..."  (re-export)
const RE_REEXPORT_NAMED = /^export\s+(type\s+)?\{([^}]*)\}\s*from\s+["']([^"']+)["']/gm;
// export * from "..."
const RE_EXPORT_STAR = /^export\s+\*\s+from\s+["']([^"']+)["']/gm;

function parseExportList(body: string): string[] {
  const names: string[] = [];
  for (const rawPart of body.split(",")) {
    // Inline `type` modifier on an individual specifier, e.g. `import { type Foo, bar } from ...`
    // or `export { type Foo, bar }` — strip it; it doesn't change which symbol is referenced.
    const part = rawPart.trim().replace(/^type\s+/, "");
    if (!part) continue;
    // "a as c" -> exported name is c; "a" -> exported name is a
    const asMatch = part.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
    if (asMatch) {
      names.push(asMatch[2]!);
    } else {
      const m = part.match(/^([A-Za-z_$][\w$]*)$/);
      if (m) names.push(m[1]!);
    }
  }
  return names;
}

function resolveSpecifier(fromAbsFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null; // bare specifier, skipped
  const base = dirname(fromAbsFile);
  let target = resolve(base, specifier);
  if (!target.endsWith(".ts") && !target.endsWith(".tsx")) target += ".ts";
  return target;
}

function scanExportsInFile(absFile: string, source: string, lines: string[]): ExportDecl[] {
  const decls: ExportDecl[] = [];

  // Simple single-line declarations: export (async)? function|const|let|class|interface|type|enum NAME
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("export")) continue;
    if (/^export\s+\{/.test(trimmed) || /^export\s+\*/.test(trimmed)) continue; // handled below

    const value = trimmed.match(RE_EXPORT_VALUE);
    if (value) {
      decls.push({ absFile, symbol: value[1]!, kind: "value" });
      continue;
    }
    const enumMatch = trimmed.match(RE_EXPORT_ENUM);
    if (enumMatch) {
      decls.push({ absFile, symbol: enumMatch[1]!, kind: "value" });
      continue;
    }
    const typeMatch = trimmed.match(RE_EXPORT_TYPE);
    if (typeMatch) {
      decls.push({ absFile, symbol: typeMatch[1]!, kind: "type" });
      continue;
    }
  }

  // Brace-list forms span multiple lines in this repo, so these run against the whole source.
  for (const m of source.matchAll(RE_EXPORT_LIST_LOCAL)) {
    const isType = Boolean(m[1]);
    for (const name of parseExportList(m[2]!)) {
      decls.push({ absFile, symbol: name, kind: isType ? "type" : "value" });
    }
  }
  for (const m of source.matchAll(RE_REEXPORT_NAMED)) {
    const isType = Boolean(m[1]);
    for (const rawPart of m[2]!.split(",")) {
      // Inline `type` modifier per specifier, e.g. `export { Foo, type Bar } from "./x.ts"`.
      const part = rawPart.trim().replace(/^type\s+/, "");
      const partIsType = isType || rawPart.trim().startsWith("type ");
      if (!part) continue;
      const asMatch = part.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      const exportedName: string = asMatch ? asMatch[2]! : part;
      if (/^[A-Za-z_$][\w$]*$/.test(exportedName)) {
        decls.push({ absFile, symbol: exportedName, kind: partIsType ? "type" : "value" });
      }
    }
  }

  return decls;
}

function scanStarReexports(absFile: string, source: string): string[] {
  const targets: string[] = [];
  for (const m of source.matchAll(RE_EXPORT_STAR)) {
    const target = resolveSpecifier(absFile, m[1]!);
    if (target) targets.push(target);
  }
  return targets;
}

// import { a, b as c } from "..."  /  import type { a } from "..."  (spans multiple lines here)
const RE_IMPORT_NAMED = /^import\s+(type\s+)?\{([^}]*)\}\s*from\s+["']([^"']+)["']/gm;
// import * as ns from "..."
const RE_IMPORT_NAMESPACE = /^import\s+\*\s+as\s+[A-Za-z_$][\w$]*\s+from\s+["']([^"']+)["']/gm;
// (await import("./x.ts")).symbol
const RE_DYNAMIC_MEMBER = /\(await\s+import\(\s*["']([^"']+)["']\s*\)\)\s*\.\s*([A-Za-z_$][\w$]*)/g;
// const { a, b as c } = await import("./x.ts")
const RE_DYNAMIC_DESTRUCTURE = /(?:const|let)\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*["']([^"']+)["']\s*\)/g;
// `src/cli/spine.ts`'s own idiom: `core((m) => m.runFoo)` lazy-loads a verb body out of
// `./core.ts` via a closure param, never a literal `(await import(...)).x` — the general dynamic
// forms above do not see it. Hardcoded to "./core.ts" because that is the one module `core()`
// wraps (see `core()`'s definition in spine.ts); harmless elsewhere since it just won't match.
const RE_CORE_PICK = /\bcore\(\s*\(?\s*[A-Za-z_$]\w*\s*\)?\s*=>\s*[A-Za-z_$]\w*\.([A-Za-z_$][\w$]*)/g;

interface ImportRef {
  targetAbsFile: string;
  symbol: string | null; // null = whole-namespace use (marks every export of target used)
}

function scanImportersInFile(absFile: string, source: string): ImportRef[] {
  const refs: ImportRef[] = [];

  for (const m of source.matchAll(RE_IMPORT_NAMESPACE)) {
    const target = resolveSpecifier(absFile, m[1]!);
    if (target && target !== absFile) refs.push({ targetAbsFile: target, symbol: null });
  }
  for (const m of source.matchAll(RE_IMPORT_NAMED)) {
    const target = resolveSpecifier(absFile, m[3]!);
    if (target && target !== absFile) {
      for (const name of parseExportList(m[2]!)) {
        refs.push({ targetAbsFile: target, symbol: name });
      }
    }
  }
  // export { a } from "..."  (re-export; also declared as an export of THIS file elsewhere, but
  // it is ALSO an importer reference against the target — it uses the target's symbol).
  for (const m of source.matchAll(RE_REEXPORT_NAMED)) {
    const target = resolveSpecifier(absFile, m[3]!);
    if (target && target !== absFile) {
      for (const rawPart of m[2]!.split(",")) {
        // Inline `type` modifier per specifier, e.g. `export { Foo, type Bar } from "./x.ts"`.
        const part = rawPart.trim().replace(/^type\s+/, "");
        if (!part) continue;
        // "a as c" imports "a" from target, re-exports as "c"; we want the SOURCE name.
        const asMatch = part.match(/^([A-Za-z_$][\w$]*)\s+as\s+[A-Za-z_$][\w$]*$/);
        const srcName: string = asMatch ? asMatch[1]! : part;
        if (/^[A-Za-z_$][\w$]*$/.test(srcName)) refs.push({ targetAbsFile: target, symbol: srcName });
      }
    }
  }

  // Dynamic forms scan the whole file body (they are expressions, not necessarily line-anchored).
  for (const m of source.matchAll(RE_DYNAMIC_MEMBER)) {
    const target = resolveSpecifier(absFile, m[1]!);
    if (target && target !== absFile) refs.push({ targetAbsFile: target, symbol: m[2]! });
  }
  for (const m of source.matchAll(RE_DYNAMIC_DESTRUCTURE)) {
    const target = resolveSpecifier(absFile, m[2]!);
    if (target && target !== absFile) {
      for (const name of parseExportList(m[1]!)) {
        refs.push({ targetAbsFile: target, symbol: name });
      }
    }
  }
  for (const m of source.matchAll(RE_CORE_PICK)) {
    const target = resolveSpecifier(absFile, "./core.ts");
    if (target && target !== absFile) refs.push({ targetAbsFile: target, symbol: m[1]! });
  }

  return refs;
}

function loadIgnoreSet(repoRoot: string): Set<string> {
  const path = join(repoRoot, "scripts/ops/dead-exports.ignore.txt");
  const set = new Set<string>();
  if (!existsSync(path)) return set;
  const content = readFileSync(path, "utf8");
  for (const rawLine of content.split("\n")) {
    const line = (rawLine.split("#")[0] ?? "").trim();
    if (!line) continue;
    set.add(line);
  }
  return set;
}

export function census(repoRoot: string): CensusResult {
  const exportFiles = collectFiles(repoRoot, EXPORT_ROOTS).filter(
    (f) => !isTestFile(relative(repoRoot, f)),
  );
  const importerFiles = [
    ...collectFiles(repoRoot, IMPORTER_ROOTS),
    ...collectDeployTopLevelFiles(repoRoot),
  ];

  const declByFile = new Map<string, ExportDecl[]>();
  const starTargets = new Map<string, string[]>(); // absFile -> target files it `export *`s from

  for (const absFile of exportFiles) {
    const source = readFileSync(absFile, "utf8");
    const lines = source.split("\n");
    declByFile.set(absFile, scanExportsInFile(absFile, source, lines));
    const stars = scanStarReexports(absFile, source);
    if (stars.length) starTargets.set(absFile, stars);
  }

  // key = `${absFile}::${symbol}` -> usage kind
  const usedByAny = new Set<string>();
  const usedByNonTest = new Set<string>();
  const namespaceUsedFiles = new Set<string>(); // absFile whose every export counts as used
  const namespaceUsedFilesNonTest = new Set<string>();

  for (const absFile of importerFiles) {
    const relPath = relative(repoRoot, absFile);
    const isTest = isTestFile(relPath);
    const source = readFileSync(absFile, "utf8");
    const refs = scanImportersInFile(absFile, source);
    for (const ref of refs) {
      if (ref.symbol === null) {
        namespaceUsedFiles.add(ref.targetAbsFile);
        if (!isTest) namespaceUsedFilesNonTest.add(ref.targetAbsFile);
        continue;
      }
      const key = `${ref.targetAbsFile}::${ref.symbol}`;
      usedByAny.add(key);
      if (!isTest) usedByNonTest.add(key);
    }
  }

  // `export * from` is treated as a namespace use of the target from the re-exporting file.
  // A re-exporting file under src/ (non-test) counts as a non-test use.
  for (const [fromFile, targets] of starTargets) {
    const fromIsTest = isTestFile(relative(repoRoot, fromFile));
    for (const target of targets) {
      namespaceUsedFiles.add(target);
      if (!fromIsTest) namespaceUsedFilesNonTest.add(target);
    }
  }

  const ignore = loadIgnoreSet(repoRoot);
  const entries: DeadExport[] = [];
  let scanned = 0;
  let live = 0;
  let testOnly = 0;
  let dead = 0;

  for (const [absFile, decls] of declByFile) {
    const relPath = relative(repoRoot, absFile);
    for (const decl of decls) {
      scanned++;
      const ignoreKey = `${relPath}::${decl.symbol}`;
      const key = `${absFile}::${decl.symbol}`;

      const wholeFileUsed = namespaceUsedFiles.has(absFile);
      const wholeFileUsedNonTest = namespaceUsedFilesNonTest.has(absFile);

      const hasNonTestUse = usedByNonTest.has(key) || wholeFileUsedNonTest;
      const hasAnyUse = usedByAny.has(key) || wholeFileUsed;

      if (hasNonTestUse) {
        live++;
        continue;
      }
      if (ignore.has(ignoreKey)) continue; // suppressed entirely: not counted, not listed
      if (hasAnyUse) {
        testOnly++;
        entries.push({ file: relPath, symbol: decl.symbol, kind: decl.kind, status: "test-only" });
        continue;
      }
      dead++;
      entries.push({ file: relPath, symbol: decl.symbol, kind: decl.kind, status: "dead" });
    }
  }

  entries.sort((a, b) => (a.file === b.file ? a.symbol.localeCompare(b.symbol) : a.file.localeCompare(b.file)));

  return { scanned, live, testOnly, dead, entries };
}

function gitSha(repoRoot: string): string {
  try {
    return execSync("git rev-parse HEAD", { cwd: repoRoot }).toString().trim();
  } catch {
    return "unknown";
  }
}

function findRepoRoot(): string {
  // scripts/ops/dead-exports.ts -> repo root is two dirs up
  return resolve(import.meta.dir, "..", "..");
}

if (import.meta.main) {
  const repoRoot = findRepoRoot();
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const writeBaseline = args.includes("--write-baseline");

  const result = census(repoRoot);

  if (writeBaseline) {
    const baseline = { dead: result.dead, testOnly: result.testOnly, generatedFrom: gitSha(repoRoot) };
    const path = join(repoRoot, "scripts/ops/dead-exports.baseline.json");
    writeFileSync(path, JSON.stringify(baseline, null, 2) + "\n");
    console.log(`wrote ${path}: ${JSON.stringify(baseline)}`);
  } else if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`scanned: ${result.scanned}  live: ${result.live}  test-only: ${result.testOnly}  dead: ${result.dead}`);
    console.log("");
    for (const e of result.entries) {
      console.log(`${e.status.padEnd(9)} ${e.kind.padEnd(5)} ${e.file}::${e.symbol}`);
    }
  }
}
