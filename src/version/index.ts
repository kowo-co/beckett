/**
 * Beckett — version source-of-truth + deploy-time bump orchestration (`src/version/index.ts`)
 * =======================================================================================
 * `package.json`'s `version` is the ONE canonical home for Beckett's own semver (OPS-188). This
 * module is the only place that reads/writes it, plus the git glue that (a) finds the highest known
 * release version across `package.json` and `vX.Y.Z` tags, and (b) lists commits since the newest
 * tag when one exists. On top of that sits {@link computeBumpSuggestion}: base +
 * commits → a MINOR/PATCH suggestion (see {@link classifyBump}) that the deploy step surfaces for
 * confirm/override before it's written and committed. MAJOR is owner-only and never auto-suggested.
 *
 * Everything here is best-effort around git (a missing tag / non-repo degrades, never throws) but
 * strict around the version string itself (a malformed `package.json` version is a real error).
 */

import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { applyBump, classifyBump, compareSemver, formatSemver, parseSemver, type BumpLevel, type BumpSuggestion } from "./semver.ts";

export * from "./semver.ts";

/** The repo root (two levels up from `src/version/`). The default source-of-truth location. */
export function defaultRepoRoot(): string {
  return join(import.meta.dir, "..", "..");
}

function packageJsonPath(repoRoot: string): string {
  return join(repoRoot, "package.json");
}

/** The changelog cut alongside the version bump (OPS/issue #147). */
export function changelogPath(repoRoot: string): string {
  return join(repoRoot, "CHANGELOG.md");
}

/**
 * Read Beckett's current version from the source of truth (`package.json`). Throws if the file is
 * missing or its `version` isn't a MAJOR.MINOR.PATCH string — the version is load-bearing, so a
 * silent "" would be worse than a loud failure.
 */
export function readVersion(repoRoot: string = defaultRepoRoot()): string {
  const raw = readFileSync(packageJsonPath(repoRoot), "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string") throw new Error("package.json has no string version field");
  parseSemver(parsed.version); // validate shape (throws on garbage)
  return parsed.version;
}

/**
 * Write a new version into `package.json`, preserving the file's exact formatting by replacing only
 * the `"version": "…"` token (never a full re-serialize, which would reorder/reflow the file). The
 * new value is validated first and must be strictly greater than the current source-of-truth
 * version. A release writer must never turn an untagged/manual version bump into a downgrade.
 * Returns the version written.
 */
export function writeVersion(newVersion: string, repoRoot: string = defaultRepoRoot()): string {
  const next = formatSemver(parseSemver(newVersion)); // normalize + validate
  const current = readVersion(repoRoot);
  if (compareSemver(next, current) <= 0) {
    throw new Error(`refusing to write v${next}: package.json is already v${current}`);
  }
  const path = packageJsonPath(repoRoot);
  const raw = readFileSync(path, "utf8");
  // Match the full version token — MAJOR.MINOR.PATCH plus any pre-release / build metadata tail —
  // so a prerelease value like "7.0.0-rc.1" is replaced in full rather than left dangling.
  const versionField = /("version"\s*:\s*")(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(")/;
  if (!versionField.test(raw)) {
    throw new Error('could not find a "version" field with a valid semver value in package.json');
  }
  const replaced = raw.replace(versionField, `$1${next}$3`);
  writeFileSync(path, replaced);
  return next;
}

/**
 * Local calendar date as `YYYY-MM-DD` — the dated-heading stamp for a changelog cut. Kept local
 * (not UTC) so the section date matches the operator's day when they run the deploy.
 */
function todayISODate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** The result of a changelog cut. `changed` is false when there was nothing to release. */
export interface ChangelogCut {
  /** Whether CHANGELOG.md was rewritten (false = no Unreleased entries, or no changelog file). */
  changed: boolean;
  /** The version the Unreleased block was moved under (bare `X.Y.Z`). */
  version: string;
  /** The dated stamp applied to the new heading. */
  date: string;
  /** The changelog path considered. */
  path: string;
}

const UNRELEASED_HEADING_RE = /^## Unreleased[^\n]*$/m;

/**
 * Fold the CHANGELOG's `## Unreleased` block under a dated `## vX.Y.Z (date)` heading and leave a
 * fresh empty `## Unreleased` stub in its place (issue #147). This is what keeps CHANGELOG and
 * `package.json` from drifting: the deploy-time bump moves the notes at the exact moment it writes
 * the version, so a release can never ship an uncut changelog.
 *
 * A missing CHANGELOG.md or an empty Unreleased section is a clean no-op (`changed: false`) — a
 * patch release with no notes shouldn't manufacture an empty dated section or fail the deploy. A
 * changelog that exists but has no `## Unreleased` heading at all IS an error: the contract is that
 * new work accumulates there, so its absence means the file diverged and must be fixed by hand.
 */
export function cutChangelog(
  version: string,
  repoRoot: string = defaultRepoRoot(),
  date: string = todayISODate(),
): ChangelogCut {
  const v = formatSemver(parseSemver(version)); // normalize + validate (strips any leading `v`)
  const path = changelogPath(repoRoot);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { changed: false, version: v, date, path };
  }

  const heading = UNRELEASED_HEADING_RE.exec(raw);
  if (!heading) {
    throw new Error("CHANGELOG.md has no '## Unreleased' section to cut");
  }
  const bodyStart = heading.index + heading[0].length;
  // The Unreleased body runs until the next top-level `## ` heading (the previous release) or EOF.
  const nextHeading = /\n## /.exec(raw.slice(bodyStart));
  const bodyEnd = nextHeading ? bodyStart + nextHeading.index : raw.length;
  const body = raw.slice(bodyStart, bodyEnd);
  if (body.trim() === "") {
    return { changed: false, version: v, date, path }; // nothing accumulated — leave the stub alone
  }

  const trimmedBody = body.replace(/^\n+/, "").replace(/\n+$/, "");
  const rebuilt =
    raw.slice(0, heading.index) +
    "## Unreleased\n\n" +
    `## v${v} (${date})\n\n` +
    trimmedBody +
    "\n" +
    raw.slice(bodyEnd);
  writeFileSync(path, rebuilt);
  return { changed: true, version: v, date, path };
}

/** Run git in `repoRoot`, returning trimmed stdout ("" on any failure). Best-effort, never throws. */
async function runGit(repoRoot: string, args: string[]): Promise<string> {
  try {
    const proc = Bun.spawn({ cmd: ["git", "-C", repoRoot, ...args], stdout: "pipe", stderr: "ignore" });
    const text = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return text;
  } catch {
    return "";
  }
}

/** The newest valid `vX.Y.Z` tag, or `null` when this is a first deploy. */
async function newestTaggedVersion(repoRoot: string): Promise<string | null> {
  const out = await runGit(repoRoot, ["tag", "--list", "v[0-9]*.[0-9]*.[0-9]*", "--sort=-v:refname"]);
  for (const tag of out.split("\n").map((s) => s.trim()).filter(Boolean)) {
    try {
      return formatSemver(parseSemver(tag));
    } catch {
      // The glob is intentionally broad; ignore a malformed lookalike and keep searching.
    }
  }
  return null;
}

/**
 * The bump base: the greater of package.json's source-of-truth version and the newest `vX.Y.Z`
 * tag, as a bare semver string. This deliberately preserves an untagged/manual package version;
 * tags are a release record, never permission to downgrade the source of truth.
 */
export async function lastDeployedVersion(repoRoot: string = defaultRepoRoot()): Promise<string> {
  const packageVersion = readVersion(repoRoot);
  const tagVersion = await newestTaggedVersion(repoRoot);
  return tagVersion && compareSemver(tagVersion, packageVersion) > 0 ? tagVersion : packageVersion;
}

/**
 * Commit subjects merged on HEAD since tagged version `base`, newest first, capped at `max`. With
 * a tag, an EMPTY result is meaningful — it means nothing new since the last deploy — so it's
 * returned as-is (the caller no-ops rather than re-bumping). Only when there is no tag at all (a
 * first-ever deploy) does this degrade to recent history so the classifier has something to look
 * at instead of going blank.
 */
export async function commitsSinceVersion(
  repoRoot: string,
  base: string | null,
  max = 50,
): Promise<string[]> {
  const toList = (out: string): string[] => out.split("\n").map((s) => s.trim()).filter(Boolean);
  if (base) {
    return toList(await runGit(repoRoot, ["log", `v${base}..HEAD`, "--pretty=%s", "-n", String(max)]));
  }
  // No tag (first deploy): everything on HEAD is "new" — take the most recent history.
  return toList(await runGit(repoRoot, ["log", "--pretty=%s", "-n", String(max)]));
}

/**
 * The top-level `src/<area>` directories touched since tagged version `base`, deduped and sorted. Not used to pick
 * the level — the subject classifier does that — but handy colour for the "why" the deploy prints.
 */
export async function areasChangedSince(repoRoot: string, base: string | null): Promise<string[]> {
  if (!base) return [];
  const out = await runGit(repoRoot, ["diff", "--name-only", `v${base}..HEAD`]);
  const areas = new Set<string>();
  for (const line of out.split("\n").map((s) => s.trim()).filter(Boolean)) {
    const m = /^src\/([^/]+)\//.exec(line);
    if (m) areas.add(m[1]!);
    else if (!line.includes("/")) areas.add(line); // a touched root file (e.g. package.json)
  }
  return [...areas].sort();
}

/** A fully-resolved bump suggestion the deploy step can print, confirm, or override. */
export interface DeployBumpSuggestion {
  /** The max(package.json version, newest tag) bump base. */
  base: string;
  /** Whether a tag exists for the selected bump base. */
  fromTag: boolean;
  /**
   * Human-readable provenance of {@link base} for the deploy output — names WHICH source won, so a
   * bump off an untagged package.json (the issue #30 lost-tag case) explains itself instead of
   * looking like an arbitrary number. E.g. `"last deployed tag"` or
   * `"package.json — no tag for v6.8.1 (newest tag v6.8.0)"`.
   */
  baseSource: string;
  /** The commit subjects since the newest tag (or recent history when no tag exists) that were classified. */
  commits: string[];
  /** Top-level source areas touched since `base` (colour for the reason, not the decision). */
  areas: string[];
  /** The auto-classification (MINOR/PATCH only) and its explainable reasons. */
  suggestion: BumpSuggestion;
  /** The version the suggested level would produce. */
  suggested: string;
}

/**
 * Compute the deploy-time bump suggestion: use max(package.json version, newest tag) as the base,
 * classify MINOR vs PATCH from commits since the newest tag, and project the resulting version.
 * Pure data — it neither writes nor commits.
 */
export async function computeBumpSuggestion(
  repoRoot: string = defaultRepoRoot(),
  max = 50,
): Promise<DeployBumpSuggestion> {
  const packageVersion = readVersion(repoRoot);
  const tagBase = await newestTaggedVersion(repoRoot);
  const base = tagBase && compareSemver(tagBase, packageVersion) > 0 ? tagBase : packageVersion;
  const fromTag = tagBase === base;
  // Name where the base came from. When package.json wins over an older (or absent) tag, this is
  // the lost-tag case (issue #30): say so, and name the stale tag, so the bump reads as deliberate.
  const baseSource = fromTag
    ? "last deployed tag"
    : tagBase
      ? `package.json — no tag for v${base} (newest tag v${tagBase})`
      : "package.json — no tags yet";
  const commits = await commitsSinceVersion(repoRoot, tagBase, max);
  const areas = await areasChangedSince(repoRoot, tagBase);
  const suggestion = classifyBump(commits);
  return {
    base,
    fromTag,
    baseSource,
    commits,
    areas,
    suggestion,
    suggested: applyBump(base, suggestion.level),
  };
}

/**
 * Resolve the FINAL version to ship from a suggestion + an owner choice. `override` may be a level
 * (`major`/`minor`/`patch`) or an explicit `X.Y.Z`; when omitted the suggested (auto) level wins.
 * MAJOR only ever happens through an explicit `major` override or an explicit version — never from
 * the auto classifier — which is exactly how "the owner dictates majors" is enforced.
 */
export function resolveVersion(
  base: string,
  suggestion: BumpSuggestion,
  override?: BumpLevel | string,
): { version: string; level: BumpLevel } {
  if (!override) return { version: applyBump(base, suggestion.level), level: suggestion.level };
  if (override === "major" || override === "minor" || override === "patch") {
    return { version: applyBump(base, override), level: override };
  }
  // An explicit target version — derive which part it moved (for reporting) relative to the base.
  const target = formatSemver(parseSemver(override));
  const b = parseSemver(base);
  const t = parseSemver(target);
  const level: BumpLevel = t.major !== b.major ? "major" : t.minor !== b.minor ? "minor" : "patch";
  return { version: target, level };
}

/**
 * Stage `package.json` (plus any `extraPaths`, e.g. a cut `CHANGELOG.md`) and commit the version
 * write on `repoRoot` in ONE commit. Best-effort return of the commit message on success; throws
 * only if the commit itself fails (so the deploy can surface it). The caller owns pushing — this
 * just records the bump locally. Keeping the changelog cut in the same commit is what guarantees
 * the version and its release notes can never land separately (issue #147).
 */
export async function commitVersion(
  repoRoot: string,
  version: string,
  extraPaths: string[] = [],
): Promise<string> {
  const message = `beckett: release v${version}`;
  const files = ["package.json", ...extraPaths];
  await runGit(repoRoot, ["add", ...files]);
  const proc = Bun.spawn({
    cmd: ["git", "-C", repoRoot, "commit", "-m", message, ...files],
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = (await new Response(proc.stderr).text()).trim();
    throw new Error(`git commit failed for v${version}${err ? `: ${err}` : ""}`);
  }
  return message;
}
