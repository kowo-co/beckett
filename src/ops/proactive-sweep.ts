/**
 * Beckett — the proactive rot sweep (`src/ops/proactive-sweep.ts`)
 * =======================================================================================
 * The body of the `proactive-sweep` routine action (issue #79). ro's ask: "let me open PRs on rot
 * in repos without being asked." On a schedule, unattended, look at a HANDFUL of opted-in repos for
 * three kinds of decay and, for each one found, open ONE small PR that names the rot and the fix —
 * labelled `proactive` so ro can see it was my call and shoot it down.
 *
 * The four rules that matter more than the feature, and where each is enforced:
 *
 *   1. **Opt-in per repo, never all repos.** The sweep ONLY ever iterates {@link ProactiveSweepRequest.repos}
 *      — an EXPLICIT list. There is no discovery step, no "all my repos" default: an empty list sweeps
 *      nothing ({@link runProactiveSweep} returns `no-repos` before touching GitHub). A repo not on the
 *      list is never read, never branched, never PR'd — it is structurally unreachable.
 *   2. **At most one PR per finding.** Before opening anything for a (repo, finding) pair the sweep
 *      checks the repo's OPEN PRs for a branch under `beckett/proactive/<kind>-*` ({@link hasOpenFindingPr})
 *      and skips if one is already there. A finding ro is still looking at is never re-filed, and a
 *      finding ro already shot down THIS PERIOD is not resurrected (the day-stamped branch collides).
 *   3. **Never merge, never force-push.** This module opens PRs and nothing else. There is no code path
 *      from here to a merge, and every branch is FRESH and day-stamped ({@link findingBranch}) so a push
 *      is always a create — a force-push is not just avoided, it is never expressible. The PR is a
 *      proposal a human takes or leaves.
 *   4. **A finding is a claim, not a guess.** Each detector reports only what it can stand behind: a CI
 *      run GitHub itself calls failed, an advisory an advisory database returns, a link a probe could
 *      not reach. Anything it cannot resolve (a private package, an unreachable range, a link it could
 *      not classify) is dropped, never guessed — an unattended PR that cries wolf is worse than a quiet
 *      one.
 *
 * The PR's diff is deliberately tiny and OUTSIDE the repo's real source: a single report file under
 * `.beckett/proactive/<kind>.md` that describes the rot and the recommended fix. The sweep never edits
 * a repo's actual code — the smallest possible blast radius while still being a real PR a human can
 * merge (acknowledge) or close (shoot down). The prose fix lives in the report and the PR body; a
 * human applies it.
 *
 * Everything I/O-shaped is injected ({@link ProactiveSweepDeps}) so the whole sweep — opt-in gating,
 * one-PR idempotency, the never-merge shape — is testable without a network, GitHub, or an advisory
 * database. See `./proactive-sweep.test.ts`.
 */

import type { Logger } from "../types.ts";

// =======================================================================================
// Findings
// =======================================================================================

/** The three kinds of rot the sweep looks for. Each maps to one branch prefix and one PR. */
export type FindingKind = "ci" | "dependencies" | "readme-links";

/** A CI check GitHub reports as not-green on the default branch's tip. */
export interface FailingCheck {
  name: string;
  /** GitHub's own conclusion/state string, lower-cased (e.g. "failure", "timed_out", "error"). */
  conclusion: string;
  url: string | null;
}

/** A dependency an advisory database flags at the range's floor version. */
export interface DependencyAdvisory {
  name: string;
  /** The version queried — the range's floor (e.g. "1.1.3" from "^1.1.3"). */
  version: string;
  /** Advisory id (e.g. "GHSA-…", "CVE-…"). */
  id: string;
  summary: string;
  /** First version the advisory says is fixed, or null when the database doesn't say. */
  fixed: string | null;
  url: string | null;
  /** Advisory severity, lower-cased, when the database provides it. */
  severity: string | null;
}

/** A dependency pinned so far behind its latest published version it reads as abandoned. */
export interface DeadDependency {
  name: string;
  /** The range as written in package.json (e.g. "^1.2.3", "1.1.3"). */
  range: string;
  /** The newest published version. */
  latest: string;
  /** How many MAJOR versions the range's floor sits behind `latest`. */
  majorsBehind: number;
}

/** A README link a probe could not reach, or that has permanently moved. */
export interface BrokenLink {
  url: string;
  /** `dead` — a hard failure (>=400 / DNS / timeout); `moved` — a permanent redirect. */
  reason: "dead" | "moved";
  /** HTTP status when there was one, else null (a transport error). */
  status: number | null;
  /** For `moved`, the Location the redirect points at. */
  movedTo: string | null;
  /** A short human note (e.g. "404 Not Found", "getaddrinfo ENOTFOUND"). */
  detail: string;
}

// =======================================================================================
// Detector 1 — red CI on the default branch
// =======================================================================================

/** A GitHub check run (from `commits/{ref}/check-runs`), narrowed to what the detector reads. */
export interface CheckRun {
  name?: string;
  status?: string;
  conclusion?: string | null;
  html_url?: string | null;
  details_url?: string | null;
}

/** A legacy commit-status context (from `commits/{ref}/status`), narrowed likewise. */
export interface StatusContext {
  context?: string;
  state?: string;
  target_url?: string | null;
}

/** The conclusions/states that mean a check FAILED — not merely "still running" or "skipped". */
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure", "action_required", "stale"]);
const FAILED_STATUS_STATES = new Set(["failure", "error"]);

/**
 * The default branch's failing checks, from the modern check-runs API and the legacy commit-status
 * API together. A check counts as failing only when GitHub itself concluded it failed: a check still
 * `in_progress`, `queued`, `neutral`, or `skipped` is NOT rot. A pending status (`state === "pending"`)
 * is likewise ignored — the branch may simply be mid-build. Returns [] when everything is green or
 * still running, so the caller only files a finding on a check GitHub calls red.
 */
export function failingChecks(checkRuns: CheckRun[], statuses: StatusContext[]): FailingCheck[] {
  const out: FailingCheck[] = [];
  for (const run of checkRuns) {
    // Only COMPLETED runs have a meaningful conclusion; an unfinished run is not a failure.
    if ((run.status ?? "").toLowerCase() !== "completed") continue;
    const conclusion = (run.conclusion ?? "").toLowerCase();
    if (!FAILED_CONCLUSIONS.has(conclusion)) continue;
    out.push({
      name: run.name?.trim() || "(unnamed check)",
      conclusion,
      url: run.html_url ?? run.details_url ?? null,
    });
  }
  for (const s of statuses) {
    const state = (s.state ?? "").toLowerCase();
    if (!FAILED_STATUS_STATES.has(state)) continue;
    out.push({
      name: s.context?.trim() || "(unnamed status)",
      conclusion: state,
      url: s.target_url ?? null,
    });
  }
  // De-dupe by name — the same job can surface as both a check run and a legacy status.
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
}

// =======================================================================================
// Detector 2 — dependency advisories and long-dead versions
// =======================================================================================

/** How many MAJOR versions behind `latest` a pinned floor must be to read as "long-dead". */
export const DEAD_MAJORS_BEHIND = 2;

/** The leading `MAJOR.MINOR.PATCH` of a version string, or null if it isn't one. */
export function versionParts(version: string): [number, number, number] | null {
  const m = version.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** The floor version of a range as a plain `x.y.z` (e.g. "^1.2.3" → "1.2.3"), or null. */
export function rangeFloor(range: string): string | null {
  const m = range.trim().match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  return m ? m[1]! : null;
}

/** Every `name → range` entry across the dependency blocks of a package.json. */
export function dependencyRanges(packageJson: unknown): Record<string, string> {
  const pkg = (packageJson ?? {}) as Record<string, unknown>;
  const ranges: Record<string, string> = {};
  for (const block of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const entries = pkg[block];
    if (!entries || typeof entries !== "object") continue;
    for (const [name, range] of Object.entries(entries as Record<string, unknown>)) {
      if (typeof range === "string") ranges[name] = range;
    }
  }
  return ranges;
}

/** A raw advisory record as an advisory database returns it (OSV-shaped, narrowed). */
export interface RawAdvisory {
  id?: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  references?: Array<{ url?: string }>;
  severity?: Array<{ type?: string; score?: string }>;
  database_specific?: { severity?: string };
  affected?: Array<{
    ranges?: Array<{ events?: Array<{ introduced?: string; fixed?: string }> }>;
  }>;
}

/** The first `fixed` version an advisory names across its affected ranges, or null. */
export function advisoryFixedVersion(adv: RawAdvisory): string | null {
  for (const affected of adv.affected ?? []) {
    for (const range of affected.ranges ?? []) {
      for (const event of range.events ?? []) {
        if (event.fixed) return event.fixed;
      }
    }
  }
  return null;
}

/** The advisory's severity as a short lower-cased word, best-effort across OSV's two shapes. */
export function advisorySeverity(adv: RawAdvisory): string | null {
  const specific = adv.database_specific?.severity?.trim();
  if (specific) return specific.toLowerCase();
  const cvss = adv.severity?.[0]?.score?.trim();
  return cvss ? cvss.toLowerCase() : null;
}

/** A package coordinate an advisory lookup takes. */
export interface PackageQuery {
  name: string;
  version: string;
}

/**
 * The dependency-rot pass: for each dependency, query an advisory database at the range's floor and
 * ask what the newest published version is. A dependency contributes an advisory if the database
 * returns one, and/or a "long-dead" note if its floor is {@link DEAD_MAJORS_BEHIND}+ majors behind
 * latest. Every lookup is best-effort — a failure resolves to nothing, because an advisory report
 * that fails LOUD on a private package or a network hiccup is worse than one that quietly says less.
 */
export async function findDependencyRot(
  ranges: Record<string, string>,
  deps: {
    advisoriesFor(pkg: PackageQuery): Promise<RawAdvisory[]>;
    latestVersion(name: string): Promise<string | null>;
  },
): Promise<{ advisories: DependencyAdvisory[]; dead: DeadDependency[] }> {
  const advisories: DependencyAdvisory[] = [];
  const dead: DeadDependency[] = [];
  for (const [name, range] of Object.entries(ranges)) {
    const floor = rangeFloor(range);
    if (!floor) continue; // "*", "workspace:*", a git URL — nothing to query or compare.

    const raw = await deps.advisoriesFor({ name, version: floor }).catch(() => [] as RawAdvisory[]);
    for (const adv of raw) {
      const id = adv.id?.trim() || adv.aliases?.[0]?.trim();
      if (!id) continue; // an advisory with no id is not something a human can look up — drop it.
      advisories.push({
        name,
        version: floor,
        id,
        summary: (adv.summary ?? adv.details ?? "").split("\n")[0]!.trim().slice(0, 200) || "(no summary provided)",
        fixed: advisoryFixedVersion(adv),
        url: adv.references?.find((r) => r.url)?.url ?? null,
        severity: advisorySeverity(adv),
      });
    }

    const latest = await deps.latestVersion(name).catch(() => null);
    const floorParts = versionParts(floor);
    const latestParts = latest ? versionParts(latest) : null;
    if (floorParts && latestParts) {
      const majorsBehind = latestParts[0] - floorParts[0];
      if (majorsBehind >= DEAD_MAJORS_BEHIND) {
        dead.push({ name, range, latest: latest!, majorsBehind });
      }
    }
  }
  advisories.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  dead.sort((a, b) => b.majorsBehind - a.majorsBehind || a.name.localeCompare(b.name));
  return { advisories, dead };
}

// =======================================================================================
// Detector 3 — broken README links
// =======================================================================================

/** The result of probing one URL. `status` is null on a transport error (DNS, timeout, refused). */
export interface LinkProbe {
  status: number | null;
  /** The `Location` header for a redirect, if any. */
  location: string | null;
  /** A short human note for a transport error, else null. */
  error: string | null;
}

/**
 * The absolute http(s) links in a README, de-duplicated and in first-seen order. Covers the three
 * forms that actually appear: markdown `[text](url)`, autolinks `<url>`, and bare `http(s)://…`. A
 * trailing `)` / `>` / punctuation is trimmed off a bare URL, and a markdown link's optional
 * `"title"` after the URL is dropped. Relative links, anchors, and `mailto:` are skipped — the sweep
 * can only meaningfully probe an absolute web address.
 */
export function extractReadmeLinks(markdown: string): string[] {
  const urls: string[] = [];
  const push = (raw: string) => {
    let url = raw.trim();
    // Drop a markdown-link title: `(https://x "the title")`.
    url = url.replace(/\s+["'].*$/, "");
    // Trim trailing punctuation a prose sentence leaves stuck to a bare URL.
    url = url.replace(/[)>\].,;:!?'"]+$/, "");
    if (/^https?:\/\/\S+$/i.test(url)) urls.push(url);
  };
  // [text](url) and [text](url "title")
  for (const m of markdown.matchAll(/\]\(\s*(https?:\/\/[^)\s]+(?:\s+"[^"]*")?)\s*\)/gi)) push(m[1]!);
  // <url>
  for (const m of markdown.matchAll(/<(https?:\/\/[^>\s]+)>/gi)) push(m[1]!);
  // bare http(s)://… (last, so the tidier markdown/autolink forms win first-seen order)
  for (const m of markdown.matchAll(/(?<![("<])\bhttps?:\/\/[^\s)>\]]+/gi)) push(m[0]!);
  return [...new Set(urls)];
}

/** Classify a probe result into a {@link BrokenLink}, or null when the link is fine. */
export function classifyLink(url: string, probe: LinkProbe): BrokenLink | null {
  if (probe.error) {
    return { url, reason: "dead", status: null, movedTo: probe.location, detail: probe.error.slice(0, 120) };
  }
  const status = probe.status ?? 0;
  // A permanent redirect is not broken, but it IS rot worth a one-line "update this to X".
  if ((status === 301 || status === 308) && probe.location) {
    return { url, reason: "moved", status, movedTo: probe.location, detail: `${status} → ${probe.location}` };
  }
  // 4xx/5xx are dead; a 2xx/3xx-temporary is fine. 429 (rate-limited) is NOT the link's fault — skip.
  if (status >= 400 && status !== 429) {
    return { url, reason: "dead", status, movedTo: null, detail: `${status}` };
  }
  return null;
}

/** How many README links a single sweep will probe. A README with hundreds of links is unusual;
 *  the cap keeps one repo from turning a sweep into a crawler. Dropped links are reported by the
 *  caller so a truncation never reads as "all links checked". */
export const MAX_LINKS_PROBED = 50;

/**
 * Probe up to {@link MAX_LINKS_PROBED} of a README's links and return the broken/moved ones. Probes
 * run with bounded concurrency so a repo with many links neither hammers hosts nor serializes into a
 * slow crawl. `dead` links (a real 4xx/5xx/transport failure) are what make this a finding; `moved`
 * links ride along as softer suggestions.
 */
export async function findBrokenLinks(
  markdown: string,
  probe: (url: string) => Promise<LinkProbe>,
  opts: { concurrency?: number } = {},
): Promise<{ broken: BrokenLink[]; probed: number; skipped: number }> {
  const links = extractReadmeLinks(markdown);
  const probeList = links.slice(0, MAX_LINKS_PROBED);
  const skipped = links.length - probeList.length;
  const broken: BrokenLink[] = [];
  const concurrency = Math.max(1, opts.concurrency ?? 6);

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < probeList.length) {
      const url = probeList[cursor++]!;
      const result = await probe(url).catch(
        (err): LinkProbe => ({ status: null, location: null, error: String((err as Error).message ?? err) }),
      );
      const classified = classifyLink(url, result);
      if (classified) broken.push(classified);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, probeList.length) }, worker));
  // Deterministic order regardless of which worker finished first — dead before moved, then by url.
  broken.sort((a, b) => (a.reason === b.reason ? a.url.localeCompare(b.url) : a.reason === "dead" ? -1 : 1));
  return { broken, probed: probeList.length, skipped };
}

// =======================================================================================
// The sweep
// =======================================================================================

/** The stable branch PREFIX every proactive PR for `kind` lives under (day-stamped by the caller). */
export function findingBranchPrefix(kind: FindingKind): string {
  return `beckett/proactive/${kind}-`;
}

/** The day-stamped head branch for one finding — fresh each day, so a push is always a create. */
export function findingBranch(kind: FindingKind, dateStamp: string): string {
  return `${findingBranchPrefix(kind)}${dateStamp}`;
}

/** The report file a finding's PR adds — outside the repo's real source, one file per kind. */
export function reportPath(kind: FindingKind): string {
  return `.beckett/proactive/${kind}.md`;
}

/** True when the repo already has an OPEN proactive PR for `kind` (so we must not open a second). */
export function hasOpenFindingPr(openPrHeads: string[], kind: FindingKind): boolean {
  const prefix = findingBranchPrefix(kind);
  return openPrHeads.some((head) => head === prefix.slice(0, -1) || head.startsWith(prefix));
}

/** The label every proactive PR carries, so ro can see the sweep filed it — and filter on it. */
export const PROACTIVE_LABEL = "proactive";

export interface OpenPrParams {
  base: string;
  head: string;
  title: string;
  body: string;
  labels: string[];
}

/** Everything the sweep touches outside itself, injected so the whole run is testable. */
export interface ProactiveSweepDeps {
  /** The repo's default branch (e.g. "main"), or null when the repo can't be read. */
  defaultBranch(repo: string): Promise<string | null>;
  /** The commit sha at the tip of `branch`, or null. */
  branchSha(repo: string, branch: string): Promise<string | null>;
  /** The default branch's check runs + legacy statuses at its tip. */
  branchChecks(repo: string, branch: string): Promise<{ checkRuns: CheckRun[]; statuses: StatusContext[] }>;
  /** Decoded text of a file at `ref`, or null when it doesn't exist there. */
  fileAt(repo: string, ref: string, path: string): Promise<string | null>;
  /** Head-branch names of the repo's OPEN pull requests (for the one-PR-per-finding gate). */
  openPrHeads(repo: string): Promise<string[]>;
  /** Create a NEW branch ref at `fromSha`. Rejects if it already exists — never force-moves a ref. */
  createBranch(repo: string, branch: string, fromSha: string): Promise<void>;
  /** Create-or-update a file on `branch` (the report). Never touches the default branch. */
  putFile(repo: string, branch: string, path: string, content: string, message: string): Promise<void>;
  /** Open a PR (labelled). The ONLY GitHub write that publishes a proposal — never a merge. */
  openPr(repo: string, p: OpenPrParams): Promise<{ number: number; url: string }>;
  /** Advisory database lookup for one package at one version. */
  advisoriesFor(pkg: PackageQuery): Promise<RawAdvisory[]>;
  /** Newest published version of a package, or null. */
  latestVersion(name: string): Promise<string | null>;
  /** Probe one URL (HEAD/GET), following nothing — the caller classifies the status/redirect. */
  probeLink(url: string): Promise<LinkProbe>;
  logger: Logger;
}

export interface ProactiveSweepRequest {
  /** The EXPLICIT opt-in list. This is the whole allow-list: nothing off it is ever touched. */
  repos: string[];
  /** Author identity for the report commit (Beckett's git identity). */
  author: { name: string; email: string };
  /** `YYYY-MM-DD` stamp for the day's branches. Passed in so a run is reproducible from its logs. */
  dateStamp: string;
}

/** What happened to one finding on one repo. */
export interface FindingOutcome {
  kind: FindingKind;
  status: "opened" | "already-open" | "clean" | "error";
  prUrl: string | null;
  /** One-line human detail (what was found, or why nothing was filed). */
  detail: string;
}

/** What happened across all findings on one repo. */
export interface RepoOutcome {
  repo: string;
  /** Set when the repo itself could not be read at all — no findings were attempted. */
  error: string | null;
  findings: FindingOutcome[];
}

export type ProactiveSweepStatus = "no-repos" | "opened" | "clean" | "partial" | "error";

export interface ProactiveSweepResult {
  status: ProactiveSweepStatus;
  /** The ONE terse line posted to Discord. Guaranteed single-line. */
  summary: string;
  /** How many PRs the sweep opened this run. */
  opened: number;
  repos: RepoOutcome[];
}

/** Collapse to one line — the routine reports unattended and must not be chatty. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// ── report + PR bodies ──────────────────────────────────────────────────────────────────────

/** The shared footer every report/PR body carries — what this is and how to make it stop. */
const PROVENANCE =
  "Opened by Beckett's `proactive-sweep` routine — a scheduled rot check on an opt-in list of repos. " +
  "It never merges its own PRs and never force-pushes. If this isn't worth it, close the PR (and drop " +
  "the repo from the sweep's list to stop the check).";

function ciReport(repo: string, branch: string, failing: FailingCheck[]): string {
  const rows = failing
    .map((c) => `- **${c.name}** — \`${c.conclusion}\`${c.url ? ` ([run](${c.url}))` : ""}`)
    .join("\n");
  return [
    `# CI is red on \`${branch}\``,
    "",
    `The default branch of \`${repo}\` has failing checks at its tip:`,
    "",
    rows,
    "",
    "## The fix",
    "Open the failing run(s) above, reproduce locally, and land the fix on the default branch. A red " +
      "default branch means every new PR starts from a broken baseline, so this is worth clearing first.",
    "",
    "---",
    PROVENANCE,
  ].join("\n");
}

function dependenciesReport(
  repo: string,
  advisories: DependencyAdvisory[],
  dead: DeadDependency[],
): string {
  const advRows = advisories.length
    ? advisories
        .map(
          (a) =>
            `- \`${a.name}@${a.version}\` — **${a.id}**${a.severity ? ` (${a.severity})` : ""}: ${a.summary}` +
            `${a.fixed ? ` — fixed in \`${a.fixed}\`` : ""}${a.url ? ` ([advisory](${a.url}))` : ""}`,
        )
        .join("\n")
    : "- none";
  const deadRows = dead.length
    ? dead.map((d) => `- \`${d.name}\` \`${d.range}\` → latest \`${d.latest}\` (${d.majorsBehind} majors behind)`).join("\n")
    : "- none";
  return [
    `# Dependency rot in \`${repo}\``,
    "",
    "## Known advisories",
    advRows,
    "",
    "## Long-dead versions",
    deadRows,
    "",
    "## The fix",
    "For each advisory, bump the dependency to the fixed version (or a later one) and re-run the suite. " +
      "For the long-dead pins, plan the major upgrade — these are out of the automatic in-range update's " +
      "reach, so they need a human to decide. This PR only surfaces them; it does not change any manifest.",
    "",
    "---",
    PROVENANCE,
  ].join("\n");
}

function readmeLinksReport(repo: string, broken: BrokenLink[]): string {
  const dead = broken.filter((b) => b.reason === "dead");
  const moved = broken.filter((b) => b.reason === "moved");
  const deadRows = dead.length ? dead.map((b) => `- ${b.url} — ${b.detail}`).join("\n") : "- none";
  const movedRows = moved.length
    ? moved.map((b) => `- ${b.url} → ${b.movedTo} (${b.status})`).join("\n")
    : "- none";
  return [
    `# Broken README links in \`${repo}\``,
    "",
    "## Dead links",
    deadRows,
    "",
    "## Permanently moved (update these)",
    movedRows,
    "",
    "## The fix",
    "Repoint or remove the dead links; swap the moved links for their new destinations. Update `README.md` " +
      "and this PR closes itself out. This PR only records the findings — it does not edit the README prose.",
    "",
    "---",
    PROVENANCE,
  ].join("\n");
}

// ── the per-finding open-a-PR step ────────────────────────────────────────────────────────────

/**
 * Turn ONE detected finding into ONE PR, or skip it. Returns the outcome either way (never throws for
 * an expected condition) so one bad finding never sinks the rest of the sweep. The order — gate on an
 * existing open PR FIRST, only then branch/commit/PR — is what makes "at most one PR per finding"
 * true: a finding already in front of a human is never re-filed.
 */
async function fileFinding(
  repo: string,
  kind: FindingKind,
  content: { title: string; report: string; prBody: string },
  ctx: { defaultBranch: string; openPrHeads: string[]; req: ProactiveSweepRequest; deps: ProactiveSweepDeps },
): Promise<FindingOutcome> {
  const { deps, req } = ctx;
  if (hasOpenFindingPr(ctx.openPrHeads, kind)) {
    return { kind, status: "already-open", prUrl: null, detail: `a proactive ${kind} PR is already open on ${repo}` };
  }
  try {
    const sha = await deps.branchSha(repo, ctx.defaultBranch);
    if (!sha) return { kind, status: "error", prUrl: null, detail: `could not resolve ${ctx.defaultBranch} tip on ${repo}` };
    const branch = findingBranch(kind, req.dateStamp);
    await deps.createBranch(repo, branch, sha);
    await deps.putFile(
      repo,
      branch,
      reportPath(kind),
      content.report,
      `proactive(${kind}): record rot in ${repo}`,
    );
    const pr = await deps.openPr(repo, {
      base: ctx.defaultBranch,
      head: branch,
      title: content.title,
      body: content.prBody,
      labels: [PROACTIVE_LABEL],
    });
    deps.logger.info("proactive PR opened", { repo, kind, url: pr.url });
    return { kind, status: "opened", prUrl: pr.url, detail: content.title };
  } catch (err) {
    return { kind, status: "error", prUrl: null, detail: oneLine(String((err as Error).message ?? err)).slice(0, 200) };
  }
}

/** The candidate files a repo's README lives in, in probe order. */
const README_CANDIDATES = ["README.md", "readme.md", "README.markdown", "README.rst", "README.txt", "README"];

/** Sweep ONE opted-in repo: run all three detectors, open at most one PR per positive finding. */
async function sweepRepo(repo: string, req: ProactiveSweepRequest, deps: ProactiveSweepDeps): Promise<RepoOutcome> {
  const defaultBranch = await deps.defaultBranch(repo).catch(() => null);
  if (!defaultBranch) {
    return { repo, error: `could not read ${repo} (no default branch — missing repo or no access)`, findings: [] };
  }
  // One read of the open-PR list serves all three gates; a finding filed earlier THIS run doesn't
  // need to be visible to a later one because the three kinds use distinct branch prefixes.
  const openPrHeads = await deps.openPrHeads(repo).catch(() => [] as string[]);
  const findings: FindingOutcome[] = [];
  const ctx = { defaultBranch, openPrHeads, req, deps };

  // Detector 1 — red CI.
  try {
    const { checkRuns, statuses } = await deps.branchChecks(repo, defaultBranch);
    const failing = failingChecks(checkRuns, statuses);
    if (failing.length === 0) {
      findings.push({ kind: "ci", status: "clean", prUrl: null, detail: `CI green on ${defaultBranch}` });
    } else {
      findings.push(
        await fileFinding(repo, "ci", {
          title: `proactive: CI is red on \`${defaultBranch}\``,
          report: ciReport(repo, defaultBranch, failing),
          prBody: ciReport(repo, defaultBranch, failing),
        }, ctx),
      );
    }
  } catch (err) {
    findings.push({ kind: "ci", status: "error", prUrl: null, detail: oneLine(String((err as Error).message)).slice(0, 160) });
  }

  // Detector 2 — dependency advisories / long-dead versions.
  try {
    const pkgText = await deps.fileAt(repo, defaultBranch, "package.json");
    if (!pkgText) {
      findings.push({ kind: "dependencies", status: "clean", prUrl: null, detail: "no package.json to check" });
    } else {
      const ranges = dependencyRanges(JSON.parse(pkgText));
      const { advisories, dead } = await findDependencyRot(ranges, deps);
      if (advisories.length === 0 && dead.length === 0) {
        findings.push({ kind: "dependencies", status: "clean", prUrl: null, detail: "no advisories or dead deps" });
      } else {
        const report = dependenciesReport(repo, advisories, dead);
        findings.push(
          await fileFinding(repo, "dependencies", {
            title: `proactive: ${advisories.length} advisor${advisories.length === 1 ? "y" : "ies"}, ${dead.length} long-dead dep${dead.length === 1 ? "" : "s"}`,
            report,
            prBody: report,
          }, ctx),
        );
      }
    }
  } catch (err) {
    findings.push({ kind: "dependencies", status: "error", prUrl: null, detail: oneLine(String((err as Error).message)).slice(0, 160) });
  }

  // Detector 3 — broken README links.
  try {
    let readme: string | null = null;
    for (const candidate of README_CANDIDATES) {
      readme = await deps.fileAt(repo, defaultBranch, candidate);
      if (readme) break;
    }
    if (!readme) {
      findings.push({ kind: "readme-links", status: "clean", prUrl: null, detail: "no README to check" });
    } else {
      const { broken } = await findBrokenLinks(readme, deps.probeLink);
      const dead = broken.filter((b) => b.reason === "dead");
      if (dead.length === 0) {
        // A README with only permanent-redirect "moved" links is not rot worth a PR on its own.
        findings.push({ kind: "readme-links", status: "clean", prUrl: null, detail: "no broken links" });
      } else {
        const report = readmeLinksReport(repo, broken);
        findings.push(
          await fileFinding(repo, "readme-links", {
            title: `proactive: ${dead.length} broken README link${dead.length === 1 ? "" : "s"}`,
            report,
            prBody: report,
          }, ctx),
        );
      }
    }
  } catch (err) {
    findings.push({ kind: "readme-links", status: "error", prUrl: null, detail: oneLine(String((err as Error).message)).slice(0, 160) });
  }

  return { repo, error: null, findings };
}

/**
 * Run the whole sweep. Returns a {@link ProactiveSweepResult} for EVERY outcome (including the empty
 * one) rather than throwing, because the caller posts exactly one line either way — an unattended
 * routine that dies silently is the same as one that never ran.
 *
 * The FIRST thing it does is the most important one: if `repos` is empty it returns immediately, so
 * an un-configured sweep touches no GitHub API at all. Every repo it then reads comes from that list
 * and nowhere else.
 */
export async function runProactiveSweep(
  req: ProactiveSweepRequest,
  deps: ProactiveSweepDeps,
): Promise<ProactiveSweepResult> {
  // Opt-in gate. No list → no sweep. This is the "never all repos by default" guarantee, in code.
  const repos = [...new Set(req.repos.map((r) => r.trim()).filter(Boolean))];
  if (repos.length === 0) {
    return {
      status: "no-repos",
      summary: "proactive sweep: no repos opted in — nothing swept. Add repos to the routine's list to enable it.",
      opened: 0,
      repos: [],
    };
  }

  deps.logger.info("proactive sweep starting", { repos, dateStamp: req.dateStamp });
  const outcomes: RepoOutcome[] = [];
  for (const repo of repos) {
    outcomes.push(await sweepRepo(repo, req, deps));
  }

  const opened = outcomes.flatMap((r) => r.findings).filter((f) => f.status === "opened").length;
  const errored = outcomes.some((r) => r.error) || outcomes.flatMap((r) => r.findings).some((f) => f.status === "error");
  const status: ProactiveSweepStatus = opened > 0 ? (errored ? "partial" : "opened") : errored ? "error" : "clean";

  const prUrls = outcomes
    .flatMap((r) => r.findings)
    .filter((f) => f.status === "opened" && f.prUrl)
    .map((f) => f.prUrl!);
  const summary =
    opened > 0
      ? oneLine(
          `proactive sweep: opened ${opened} PR${opened === 1 ? "" : "s"} across ${repos.length} repo${repos.length === 1 ? "" : "s"} — ` +
            `${prUrls.slice(0, 3).join(", ")}${prUrls.length > 3 ? `, +${prUrls.length - 3} more` : ""}.`,
        )
      : status === "error"
        ? oneLine(`proactive sweep: swept ${repos.length} repo${repos.length === 1 ? "" : "s"}, hit errors, opened no PRs.`)
        : oneLine(`proactive sweep: swept ${repos.length} repo${repos.length === 1 ? "" : "s"}, all clean — no PRs.`);

  deps.logger.info("proactive sweep finished", { status, opened });
  return { status, summary, opened, repos: outcomes };
}

// =======================================================================================
// Default (real) dependencies
// =======================================================================================

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command, capturing output, with a hard timeout so nothing can hang the sweep. */
async function spawnCapture(cmd: string[], opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
  const proc = Bun.spawn(cmd, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
  });
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 60_000);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/** Parse the last well-formed JSON value in a string (gh prints exactly one; be forgiving). */
function parseJson<T>(stdout: string): T | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
}

/** The npm registry's `latest` dist-tag. Best-effort: any failure resolves to null. */
async function registryLatest(name: string): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
      signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  }
}

/** OSV.dev advisories for one npm package at one version. Best-effort: failure → no advisories. */
async function osvAdvisories(pkg: PackageQuery): Promise<RawAdvisory[]> {
  try {
    const res = await fetch("https://api.osv.dev/v1/query", {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ version: pkg.version, package: { name: pkg.name, ecosystem: "npm" } }),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { vulns?: RawAdvisory[] };
    return Array.isArray(body.vulns) ? body.vulns : [];
  } catch {
    return [];
  }
}

/**
 * Probe one URL WITHOUT following redirects, so a permanent redirect is visible as rot. Tries HEAD
 * first (cheap); a server that rejects HEAD (405/501) is re-probed with GET. A transport failure
 * (DNS, timeout, refused) comes back as `error`, never as a throw.
 */
async function probeUrl(url: string): Promise<LinkProbe> {
  async function once(method: "HEAD" | "GET"): Promise<LinkProbe> {
    const res = await fetch(url, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(12_000),
      headers: { "user-agent": "beckett-proactive-sweep (+https://github.com/kowo-co/beckett)" },
    });
    return { status: res.status, location: res.headers.get("location"), error: null };
  }
  try {
    const head = await once("HEAD");
    if (head.status === 405 || head.status === 501) return await once("GET");
    return head;
  } catch (err) {
    try {
      return await once("GET");
    } catch {
      return { status: null, location: null, error: String((err as Error).message ?? err) };
    }
  }
}

/**
 * The real {@link ProactiveSweepDeps}. Every GitHub read and write goes through `beckett gh` — the
 * reads through the `gh raw -- api` passthrough (so the PAT injection stays in the gh module and no
 * raw `gh` is ever issued from here), the PR open through `beckett gh pr create`. `beckettCli` is the
 * argv prefix that runs Beckett's own CLI, passed by the caller so this module never guesses where it
 * lives — and so a test can substitute a fake without touching GitHub or the network.
 */
export function defaultProactiveSweepDeps(opts: { beckettCli: string[]; logger: Logger }): ProactiveSweepDeps {
  const { beckettCli, logger } = opts;
  const ghApi = (args: string[], timeoutMs?: number) =>
    spawnCapture([...beckettCli, "gh", "raw", "--", "api", ...args], { timeoutMs });

  return {
    async defaultBranch(repo) {
      const r = await ghApi([`repos/${repo}`]);
      if (r.code !== 0) return null;
      return parseJson<{ default_branch?: string }>(r.stdout)?.default_branch ?? null;
    },
    async branchSha(repo, branch) {
      const r = await ghApi([`repos/${repo}/commits/${encodeURIComponent(branch)}`]);
      if (r.code !== 0) return null;
      return parseJson<{ sha?: string }>(r.stdout)?.sha ?? null;
    },
    async branchChecks(repo, branch) {
      const ref = encodeURIComponent(branch);
      const runsRes = await ghApi([`repos/${repo}/commits/${ref}/check-runs`]);
      const statusRes = await ghApi([`repos/${repo}/commits/${ref}/status`]);
      const checkRuns = parseJson<{ check_runs?: CheckRun[] }>(runsRes.stdout)?.check_runs ?? [];
      const statuses = parseJson<{ statuses?: StatusContext[] }>(statusRes.stdout)?.statuses ?? [];
      return { checkRuns, statuses };
    },
    async fileAt(repo, ref, path) {
      const r = await ghApi([`repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`]);
      if (r.code !== 0) return null; // 404 (missing file) surfaces as a non-zero exit — treat as absent.
      const body = parseJson<{ content?: string; encoding?: string }>(r.stdout);
      if (!body?.content) return null;
      const encoding = body.encoding ?? "base64";
      return encoding === "base64" ? Buffer.from(body.content, "base64").toString("utf8") : body.content;
    },
    async openPrHeads(repo) {
      const r = await ghApi([`repos/${repo}/pulls?state=open&per_page=100`]);
      if (r.code !== 0) return [];
      const arr = parseJson<Array<{ head?: { ref?: string } }>>(r.stdout) ?? [];
      return arr.map((p) => p.head?.ref).filter((ref): ref is string => Boolean(ref));
    },
    async createBranch(repo, branch, fromSha) {
      const r = await ghApi([
        "--method", "POST", `repos/${repo}/git/refs`,
        "-f", `ref=refs/heads/${branch}`,
        "-f", `sha=${fromSha}`,
      ]);
      if (r.code !== 0) {
        throw new Error(`create branch ${branch} failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
      }
    },
    async putFile(repo, branch, path, content, message) {
      // The report file may already exist on the base (a prior merged proactive PR) — the contents
      // API needs the existing blob sha to UPDATE it, or it 422s. Look it up on the branch first.
      const existing = await ghApi([`repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`]);
      const existingSha =
        existing.code === 0 ? parseJson<{ sha?: string }>(existing.stdout)?.sha ?? null : null;
      const args = [
        "--method", "PUT", `repos/${repo}/contents/${path}`,
        "-f", `message=${message}`,
        "-f", `content=${Buffer.from(content, "utf8").toString("base64")}`,
        "-f", `branch=${branch}`,
      ];
      if (existingSha) args.push("-f", `sha=${existingSha}`);
      const r = await ghApi(args);
      if (r.code !== 0) {
        throw new Error(`put ${path} failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
      }
    },
    async openPr(repo, p) {
      // `gh pr create --label X` FAILS if X doesn't exist on the repo, so ensure each label first.
      // `label create --force` creates-or-updates, so it's idempotent across sweeps and repos.
      for (const label of p.labels) {
        await spawnCapture(
          [
            ...beckettCli, "gh", "raw", "--", "label", "create", label,
            "--repo", repo, "--force",
            "--description", "Opened proactively by Beckett's rot sweep",
            "--color", "5319e7",
          ],
          { timeoutMs: 30_000 },
        ).catch(() => undefined); // best-effort: a labels-disabled repo shouldn't sink the PR create
      }
      const args = [
        ...beckettCli, "gh", "pr", "create",
        "--repo", repo,
        "--base", p.base,
        "--head", p.head,
        "--title", p.title,
        "--body", p.body,
      ];
      if (p.labels.length > 0) args.push("--label", p.labels.join(","));
      const r = await spawnCapture(args, { timeoutMs: 60_000 });
      if (r.code !== 0) {
        throw new Error(`gh pr create failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
      }
      const parsed = parseJson<{ number?: number; url?: string }>(r.stdout);
      const url = parsed?.url ?? r.stdout.match(/https?:\/\/\S+?\/pull\/\d+/)?.[0] ?? "";
      const number = parsed?.number ?? Number(url.match(/\/pull\/(\d+)/)?.[1] ?? 0);
      if (!url) throw new Error(`gh pr create: could not parse PR url from "${r.stdout.trim().slice(0, 120)}"`);
      return { number, url };
    },
    advisoriesFor: osvAdvisories,
    latestVersion: registryLatest,
    probeLink: probeUrl,
    logger,
  };
}
