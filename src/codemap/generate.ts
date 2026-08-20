/**
 * Beckett — static-parse file-level codemap (`src/codemap/generate.ts`)
 * =======================================================================================
 * The generator behind the first-slice `codemap` capability (docs/plans/codemap-context-plugin.md
 * §2, §7). Walks non-test TS/JS source, one line per file: a header-doc purpose when the file
 * itself has one, otherwise the exported names. No LLM, no network, no LSP. A hard char/token
 * budget is enforced by truncation, never by hoping the output lands near a target.
 *
 * Fabricating a purpose sentence is a worse failure than a missing one — if the file does not
 * source a header comment, the line is path + export names, nothing invented.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

const CHARS_PER_TOKEN = 4;
/** Hard cap. §2 measured ~5k tokens of path+purpose; preamble + grouping sits a bit above that. Far below a 43k-token symbol dump. */
const TOKEN_BUDGET = 8_000;
const CHAR_BUDGET = TOKEN_BUDGET * CHARS_PER_TOKEN;

/** Written into the worktree at cut time; git-excluded with the rest of `.beckett/`. */
const CODEMAP_REL = join(".beckett", "codemap.txt");

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;
const DECL_EXT = /\.d\.(?:ts|mts|cts)$/;
const SKIP_DIR_NAMES = new Set([
  ".git",
  ".beckett",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "vendor",
  "__snapshots__",
  ".next",
  "out",
]);

const RE_EXPORT_VALUE =
  /^export\s+(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/;
const RE_EXPORT_TYPE = /^export\s+(?:interface|type)\s+([A-Za-z_$][\w$]*)/;
const RE_EXPORT_ENUM = /^export\s+(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/;
const RE_EXPORT_DEFAULT_NAMED =
  /^export\s+default\s+(?:async\s+)?(?:function\s*\*?|class)\s+([A-Za-z_$][\w$]*)/;
const RE_EXPORT_LIST = /^export\s+(?:type\s+)?\{([^}]*)\}/gm;

const MAX_EXPORTS_ON_LINE = 12;
const MAX_PURPOSE_CHARS = 140;

interface TreeIdentity {
  sha: string | null;
  branch: string | null;
}

interface GenerateCodemapOptions {
  /** Override git identity (tests). */
  tree?: TreeIdentity;
  /** Override the hard char budget (tests). */
  charBudget?: number;
}

/** Repo-relative path of the generated map file. */
export function codemapPath(workspace: string): string {
  return join(workspace, CODEMAP_REL);
}

/** Generate and write the map into a worktree (cut-time + resume-if-missing). */
export function writeCodemap(workspace: string, opts: GenerateCodemapOptions = {}): string {
  const map = generateCodemap(workspace, opts);
  const path = codemapPath(workspace);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, map, "utf8");
  return path;
}

/** Read a previously written map, or null if this worktree has none yet. */
export function readCodemap(workspace: string): string | null {
  const path = codemapPath(workspace);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Build the file-level map for `root`. Deterministic: same tree bytes + same git identity →
 * identical string. Truncates from the end of the sorted file list when the budget would break.
 */
export function generateCodemap(root: string, opts: GenerateCodemapOptions = {}): string {
  const tree = opts.tree ?? readTreeIdentity(root);
  const budget = opts.charBudget ?? CHAR_BUDGET;
  const sourceRoot = existsSync(join(root, "src")) ? join(root, "src") : root;
  const files = listSourceFiles(sourceRoot)
    .map((abs) => relative(root, abs).split(sep).join("/"))
    .filter((rel) => !isTestFile(rel))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const entries: Array<{ path: string; line: string; dir: string }> = [];
  for (const rel of files) {
    const abs = join(root, ...rel.split("/"));
    let source = "";
    try {
      source = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const purpose = headerPurpose(source);
    const exports = purpose ? null : exportedNames(source);
    const detail = purpose ?? (exports && exports.length > 0 ? `exports: ${exports.join(", ")}` : "exports: (none)");
    const line = `${rel} — ${detail}`;
    const slash = rel.lastIndexOf("/");
    const dir = slash === -1 ? "(root)" : rel.slice(0, slash);
    entries.push({ path: rel, line, dir });
  }

  const header = renderHeader(tree);
  const entryBlock = renderEntryPoints(root);
  const testBlock = renderTests(root);
  const preamble = [header, entryBlock, testBlock].filter(Boolean).join("\n\n") + "\n";

  const grouped = groupLines(entries);
  const body = assembleBody(grouped, preamble, budget);
  return body.endsWith("\n") ? body : `${body}\n`;
}

function renderHeader(tree: TreeIdentity): string {
  const sha = tree.sha ?? "(unknown commit)";
  const branch = tree.branch ? ` on ${tree.branch}` : "";
  return [
    "CODEMAP — file-level hint of this tree, not ground truth.",
    `Generated from ${sha}${branch}. Your own uncommitted edits after this point are invisible to it.`,
    "Purpose lines are sourced from each file's header doc-comment, or from exported names when there is no header.",
  ].join("\n");
}

function renderEntryPoints(root: string): string {
  const hits: string[] = [];
  const seen = new Set<string>();
  const add = (rel: string) => {
    const norm = rel.replace(/^\.\//, "").split(sep).join("/");
    if (!norm || seen.has(norm)) return;
    if (!existsSync(join(root, ...norm.split("/")))) return;
    seen.add(norm);
    hits.push(norm);
  };

  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        module?: unknown;
        main?: unknown;
        bin?: unknown;
      };
      if (typeof pkg.module === "string") add(pkg.module);
      if (typeof pkg.main === "string") add(pkg.main);
      if (typeof pkg.bin === "string") add(pkg.bin);
      else if (pkg.bin && typeof pkg.bin === "object") {
        for (const value of Object.values(pkg.bin as Record<string, unknown>)) {
          if (typeof value === "string") add(value);
        }
      }
    } catch {
      /* ignore malformed package.json — still a usable map */
    }
  }
  for (const cand of [
    "src/cli/beckett.ts",
    "src/shell/main.ts",
    "src/index.ts",
    "src/main.ts",
    "index.ts",
    "index.js",
    "main.ts",
    "main.js",
  ]) {
    add(cand);
  }
  hits.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (hits.length === 0) return "Entry points: (none detected from package.json / conventional names)";
  return `Entry points:\n${hits.map((h) => `- ${h}`).join("\n")}`;
}

function renderTests(root: string): string {
  const counts = new Map<string, number>();
  const searchRoot = existsSync(join(root, "src")) ? root : root;
  for (const abs of listSourceFiles(searchRoot)) {
    const rel = relative(root, abs).split(sep).join("/");
    if (!isTestFile(rel)) continue;
    const top = rel.split("/")[0] ?? rel;
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  if (counts.size === 0) {
    return "Tests: none found (looked for `*.test.*` / `*.spec.*` / `__tests__`).";
  }
  const lines = [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([dir, n]) => `- ${dir}/ — ${n} test file${n === 1 ? "" : "s"} (\`*.test.*\` / \`*.spec.*\`)`);
  return `Tests live:\n${lines.join("\n")}`;
}

function groupLines(entries: Array<{ line: string; dir: string }>): Array<{ dir: string; lines: string[] }> {
  const byDir = new Map<string, string[]>();
  for (const entry of entries) {
    const lines = byDir.get(entry.dir);
    if (lines) lines.push(entry.line);
    else byDir.set(entry.dir, [entry.line]);
  }
  return [...byDir.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([dir, lines]) => ({ dir, lines }));
}

function assembleBody(
  groups: Array<{ dir: string; lines: string[] }>,
  preamble: string,
  budget: number,
): string {
  const parts: string[] = [preamble.trimEnd()];
  // Keep room for the truncation footer so the FINAL string, not just the file lines, stays under budget.
  const truncationNoteMax = 220;
  const fileBudget = Math.max(0, budget - truncationNoteMax);
  let used = parts.join("\n").length;
  let omitted = 0;
  let truncatedAt: string | null = null;

  for (const group of groups) {
    const heading = `\n## ${group.dir}`;
    if (used + heading.length + 1 > fileBudget) {
      omitted += group.lines.length;
      truncatedAt ??= group.lines[0] ?? group.dir;
      continue;
    }
    // Tentatively add the heading only if at least one file fits after it.
    let headingAdded = false;
    for (let i = 0; i < group.lines.length; i++) {
      const line = group.lines[i]!;
      const extra = headingAdded ? 1 + line.length : heading.length + 1 + line.length;
      if (used + extra > fileBudget) {
        truncatedAt ??= line;
        omitted += group.lines.length - i;
        break;
      }
      if (!headingAdded) {
        parts.push(heading);
        used += heading.length;
        headingAdded = true;
      }
      parts.push("\n" + line);
      used += 1 + line.length;
    }
  }

  if (omitted > 0) {
    const note =
      `\n\nTRUNCATED: map exceeded the ${TOKEN_BUDGET}-token / ${budget}-char budget; ` +
      `omitted ${omitted} file line${omitted === 1 ? "" : "s"}` +
      (truncatedAt ? ` starting at ${truncatedAt.split(" — ")[0]}` : "") +
      ".";
    parts.push(note);
  }
  return parts.join("");
}

function listSourceFiles(absRoot: string): string[] {
  const out: string[] = [];
  walk(absRoot, out);
  return out;
}

function walk(abs: string, out: string[]): void {
  if (!existsSync(abs)) return;
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  // readdir order is filesystem-dependent; sort so the walk is deterministic.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".") continue;
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const next = join(abs, entry.name);
    if (entry.isDirectory()) walk(next, out);
    else if (entry.isFile() && SOURCE_EXT.test(entry.name) && !DECL_EXT.test(entry.name)) out.push(next);
  }
}

function isTestFile(relPath: string): boolean {
  const norm = relPath.split(sep).join("/");
  if (norm.includes("/__tests__/") || norm.startsWith("__tests__/")) return true;
  const base = norm.slice(norm.lastIndexOf("/") + 1);
  return /\.(?:test|spec)\./.test(base);
}

/**
 * First sourced sentence from a leading file header doc-comment. Returns null when the file
 * has no header — callers must fall back to export names rather than invent prose.
 */
function headerPurpose(source: string): string | null {
  const body = stripPreamble(source);
  const block = body.match(/^\/\*\*([\s\S]*?)\*\//);
  if (block) {
    const lines = block[1]!
      .split("\n")
      .map((line) => line.replace(/^\s*\* ?/, "").trim())
      .filter((line) => line.length > 0 && !/^[=\-─]{8,}$/.test(line));
    return firstSentence(lines[0] ?? null);
  }
  const lineComments: string[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^\/\/\s?(.*)$/);
    if (!m) break;
    const text = m[1]!.trim();
    if (text) lineComments.push(text);
  }
  return firstSentence(lineComments[0] ?? null);
}

function stripPreamble(source: string): string {
  return source
    .replace(/^\uFEFF/, "")
    .replace(/^#!.*\r?\n/, "")
    .replace(/^(?:\/\/\/\s*<reference\b.*\r?\n)+/, "")
    .replace(/^(?:\/\/\s*(?:eslint-|@ts-|prettier-|biome-).*\r?\n)+/, "")
    .replace(/^(?:["']use (?:strict|client|server)["'];?\r?\n)+/, "")
    .replace(/^(?:\s*\r?\n)+/, "");
}

function firstSentence(line: string | null): string | null {
  if (!line) return null;
  const cut = line.match(/^(.+?[.!?])(\s|$)/);
  const sentence = (cut ? cut[1]! : line).replace(/\s+/g, " ").trim();
  if (!sentence) return null;
  return sentence.length <= MAX_PURPOSE_CHARS ? sentence : `${sentence.slice(0, MAX_PURPOSE_CHARS - 1)}…`;
}

/** Exported top-level names, sorted, capped. Empty when the file exports nothing parseable. */
function exportedNames(source: string): string[] {
  const names = new Set<string>();
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const line of stripped.split("\n")) {
    const trimmed = line.trim();
    let m = trimmed.match(RE_EXPORT_DEFAULT_NAMED);
    if (m) {
      names.add(m[1]!);
      continue;
    }
    if (/^export\s+default\b/.test(trimmed)) {
      names.add("default");
      continue;
    }
    m = trimmed.match(RE_EXPORT_VALUE) ?? trimmed.match(RE_EXPORT_TYPE) ?? trimmed.match(RE_EXPORT_ENUM);
    if (m) names.add(m[1]!);
  }
  for (const match of stripped.matchAll(RE_EXPORT_LIST)) {
    if (/\bfrom\b/.test(match[0])) {
      // re-export list: still names this file exports
    }
    for (const rawPart of match[1]!.split(",")) {
      const part = rawPart.trim().replace(/^type\s+/, "");
      if (!part) continue;
      const asMatch = part.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      names.add(asMatch ? asMatch[2]! : part.replace(/\s+as\s+[A-Za-z_$][\w$]*$/, "").trim());
    }
  }
  const sorted = [...names].filter(Boolean).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (sorted.length <= MAX_EXPORTS_ON_LINE) return sorted;
  return [...sorted.slice(0, MAX_EXPORTS_ON_LINE), `+${sorted.length - MAX_EXPORTS_ON_LINE} more`];
}

function readTreeIdentity(root: string): TreeIdentity {
  const sha = git(root, ["rev-parse", "HEAD"]);
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return { sha, branch };
}

function git(cwd: string, args: string[]): string | null {
  try {
    const proc = Bun.spawnSync(["git", ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    if (proc.exitCode !== 0) return null;
    const text = proc.stdout.toString().trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}
