/**
 * Beckett — the dream journal (`src/dream/journal.ts`)
 * =======================================================================================
 * The on-disk half of the nightly dream pass (issue #36, revived for the "sessions to
 * long-term memory" ask): one dated markdown entry per night under
 * `<beckettDir>/dreams/YYYY-MM-DD.md`. Notes to self, not a report — `beckett dream ls|show`
 * reads them back for a waking Beckett; the SHORT line that goes to Discord is a different,
 * separate write (see `./run.ts`).
 *
 * Disk-gentle by construction: an entry is assembled fully in memory by the run
 * ({@link ./run.ts}) and written HERE exactly once, atomically (tmp + rename). There is no
 * append path and no per-step churn — this module deliberately exposes no way to update an
 * entry other than replacing it whole (`force`, used only by a manual re-run). Dying mid-run
 * never leaves a half-written entry: either this function ran (whole file, atomic rename) or
 * it didn't.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Entry filenames are the date and nothing else — also the traversal guard for `show <date>`. */
export const DREAM_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The machine-readable header line a truncated (budget-ceiling) entry carries. */
export const DREAM_TRUNCATED_LINE = "truncated: true";

export interface DreamEntryInfo {
  date: string;
  path: string;
  bytes: number;
  /** True when the entry's meta header says the pass hit its output-token ceiling. */
  truncated: boolean;
}

/** The canonical entry path for a date. Throws on anything that isn't a bare YYYY-MM-DD. */
export function dreamEntryPath(dreamsDir: string, date: string): string {
  if (!DREAM_DATE_RE.test(date)) throw new Error(`dream: invalid date '${date}' (expected YYYY-MM-DD)`);
  return join(dreamsDir, `${date}.md`);
}

/** All entries on disk, newest first. Non-`YYYY-MM-DD.md` files are ignored, never touched. */
export function listDreamEntries(dreamsDir: string): DreamEntryInfo[] {
  if (!existsSync(dreamsDir)) return [];
  const entries: DreamEntryInfo[] = [];
  for (const file of readdirSync(dreamsDir)) {
    const m = file.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
    if (!m) continue;
    const path = join(dreamsDir, file);
    let raw = "";
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    entries.push({
      date: m[1]!,
      path,
      bytes: Buffer.byteLength(raw, "utf8"),
      truncated: headerBlock(raw).includes(DREAM_TRUNCATED_LINE),
    });
  }
  return entries.sort((a, b) => b.date.localeCompare(a.date));
}

/** One entry's raw markdown, or null when that night has no entry. */
export function readDreamEntry(dreamsDir: string, date: string): string | null {
  const path = dreamEntryPath(dreamsDir, date);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

/**
 * THE single write of a dream run: atomic (tmp + rename), create-only unless `force`. Refusing
 * an existing entry keeps "exactly one dated entry per night" true even if the scheduler's
 * own once-per-period guard were ever bypassed by hand.
 */
export function writeDreamEntry(
  dreamsDir: string,
  date: string,
  content: string,
  opts: { force?: boolean } = {},
): string {
  const path = dreamEntryPath(dreamsDir, date);
  if (existsSync(path) && !opts.force) {
    throw new Error(`dream: entry for ${date} already exists (${path}); re-run with --force to replace it`);
  }
  mkdirSync(dreamsDir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
  return path;
}

/** The `<!-- dream-meta … -->` header block (or the first 40 lines when a header is absent). */
function headerBlock(raw: string): string {
  const start = raw.indexOf("<!-- dream-meta");
  if (start !== -1) {
    const end = raw.indexOf("-->", start);
    if (end !== -1) return raw.slice(start, end);
  }
  return raw.split("\n").slice(0, 40).join("\n");
}
