/**
 * Coverage for the version source-of-truth I/O and the deploy-time bump orchestration (OPS-188),
 * against a throwaway package.json + git repo. Pins: package.json is edited in place (formatting
 * preserved), the bump base is max(package.json, newest vX.Y.Z tag), and MAJOR is override-only
 * (resolveVersion never yields a major without an explicit choice).
 */

import { test, expect, describe, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readVersion,
  writeVersion,
  lastDeployedVersion,
  commitsSinceVersion,
  computeBumpSuggestion,
  resolveVersion,
  cutChangelog,
  commitVersion,
} from "./index.ts";
import { classifyBump, compareSemver } from "./semver.ts";

const git = async (args: string[], cwd: string): Promise<string> => {
  const p = Bun.spawn({ cmd: ["git", "-C", cwd, ...args], stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(p.stdout).text()).trim();
  await p.exited;
  return out;
};

/** Init a throwaway repo with signing disabled (some dev machines force signed/annotated tags). */
const initRepo = async (cwd: string): Promise<void> => {
  await git(["init", "-q", "-b", "main"], cwd);
  await git(["config", "user.email", "t@t.io"], cwd);
  await git(["config", "user.name", "t"], cwd);
  await git(["config", "commit.gpgSign", "false"], cwd);
  await git(["config", "tag.gpgSign", "false"], cwd);
  await git(["config", "tag.forceSignAnnotated", "false"], cwd);
};

/** Annotated tag at HEAD (works regardless of the host's lightweight-tag policy). */
const tag = async (cwd: string, name: string): Promise<void> => {
  await git(["tag", "-a", name, "-m", name], cwd);
};

describe("readVersion / writeVersion (source of truth)", () => {
  test("reads the version and rewrites it in place, preserving formatting", () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-ver-"));
    const original = `{\n  "name": "x",\n  "version": "4.1.2",\n  "type": "module"\n}\n`;
    writeFileSync(join(dir, "package.json"), original);
    expect(readVersion(dir)).toBe("4.1.2");
    writeVersion("4.2.0", dir);
    expect(readVersion(dir)).toBe("4.2.0");
    const after = readFileSync(join(dir, "package.json"), "utf8");
    // Only the version token changed — surrounding shape (keys, indent, trailing newline) intact.
    expect(after).toBe(`{\n  "name": "x",\n  "version": "4.2.0",\n  "type": "module"\n}\n`);
  });

  test("refuses to overwrite the current version or downgrade it", () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-ver-"));
    const original = `{\n  "name": "x",\n  "version": "4.2.0",\n  "type": "module"\n}\n`;
    writeFileSync(join(dir, "package.json"), original);
    expect(() => writeVersion("4.2.0", dir)).toThrow(/refusing to write/);
    expect(() => writeVersion("4.1.9", dir)).toThrow(/refusing to write/);
    // A rejected write is byte-for-byte non-destructive.
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(original);
  });

  test("genuinely missing version field still throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-ver-"));
    writeFileSync(join(dir, "package.json"), `{\n  "name": "x"\n}\n`);
    expect(() => writeVersion("1.0.0", dir)).toThrow(/version field/);
  });

  test("rejects a non-semver version on write", () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-ver-"));
    writeFileSync(join(dir, "package.json"), `{\n  "version": "1.0.0"\n}\n`);
    expect(() => writeVersion("banana", dir)).toThrow();
  });

  test("prerelease current version -> another prerelease succeeds, formatting preserved", () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-ver-"));
    const original = `{\n  "name": "x",\n  "version": "7.0.0-rc.1",\n  "type": "module"\n}\n`;
    writeFileSync(join(dir, "package.json"), original);
    expect(readVersion(dir)).toBe("7.0.0-rc.1");
    expect(writeVersion("7.0.0-rc.2", dir)).toBe("7.0.0-rc.2");
    expect(readVersion(dir)).toBe("7.0.0-rc.2");
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(
      `{\n  "name": "x",\n  "version": "7.0.0-rc.2",\n  "type": "module"\n}\n`,
    );
  });

  test("prerelease current version -> release version succeeds, formatting preserved", () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-ver-"));
    const original = `{\n  "name": "x",\n  "version": "7.0.0-rc.1",\n  "type": "module"\n}\n`;
    writeFileSync(join(dir, "package.json"), original);
    expect(writeVersion("7.0.0", dir)).toBe("7.0.0");
    expect(readVersion(dir)).toBe("7.0.0");
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(
      `{\n  "name": "x",\n  "version": "7.0.0",\n  "type": "module"\n}\n`,
    );
  });

  test("writing an earlier prerelease than the current prerelease is refused as a downgrade", () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-ver-"));
    const original = `{\n  "name": "x",\n  "version": "7.0.0-rc.2",\n  "type": "module"\n}\n`;
    writeFileSync(join(dir, "package.json"), original);
    expect(() => writeVersion("7.0.0-rc.1", dir)).toThrow(/refusing to write/);
    // A rejected write is byte-for-byte non-destructive.
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(original);
  });

  test("release current version -> release version still succeeds (no regression)", () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-ver-"));
    const original = `{\n  "name": "x",\n  "version": "7.0.0",\n  "type": "module"\n}\n`;
    writeFileSync(join(dir, "package.json"), original);
    expect(writeVersion("7.0.1", dir)).toBe("7.0.1");
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(
      `{\n  "name": "x",\n  "version": "7.0.1",\n  "type": "module"\n}\n`,
    );
  });
});

describe("cutChangelog (fold the Unreleased cut into the version bump — issue #147)", () => {
  const CHANGELOG = [
    "# Changelog",
    "",
    "## Unreleased",
    "",
    "### A new capability",
    "",
    "- did a thing",
    "",
    "## v1.0.0 — first (2026-01-01)",
    "",
    "- shipped",
    "",
  ].join("\n");

  test("moves Unreleased under a dated heading and leaves a fresh stub", () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-cl-"));
    writeFileSync(join(dir, "CHANGELOG.md"), CHANGELOG);
    const res = cutChangelog("1.1.0", dir, "2026-07-18");
    expect(res.changed).toBe(true);
    expect(res.version).toBe("1.1.0");
    const after = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
    // Fresh empty Unreleased stub, then the dated cut, then the prior release — in order.
    const headings = after.split("\n").filter((l) => l.startsWith("## "));
    expect(headings).toEqual(["## Unreleased", "## v1.1.0 (2026-07-18)", "## v1.0.0 — first (2026-01-01)"]);
    // The moved notes live under the new dated heading, not under Unreleased.
    expect(after).toContain("## v1.1.0 (2026-07-18)\n\n### A new capability\n\n- did a thing");
    // The Unreleased stub is empty (nothing between it and the dated heading but a blank line).
    expect(after).toContain("## Unreleased\n\n## v1.1.0");
  });

  test("normalizes a leading-v version argument", () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-cl-"));
    writeFileSync(join(dir, "CHANGELOG.md"), CHANGELOG);
    const res = cutChangelog("v2.0.0", dir, "2026-07-18");
    expect(res.changed).toBe(true);
    expect(readFileSync(join(dir, "CHANGELOG.md"), "utf8")).toContain("## v2.0.0 (2026-07-18)");
  });

  test("empty Unreleased section is a clean no-op (no manufactured dated section)", () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-cl-"));
    const empty = "# Changelog\n\n## Unreleased\n\n## v1.0.0 — first (2026-01-01)\n\n- shipped\n";
    writeFileSync(join(dir, "CHANGELOG.md"), empty);
    const res = cutChangelog("1.1.0", dir, "2026-07-18");
    expect(res.changed).toBe(false);
    expect(readFileSync(join(dir, "CHANGELOG.md"), "utf8")).toBe(empty);
  });

  test("a missing CHANGELOG.md is a no-op, not a crash", () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-cl-"));
    expect(cutChangelog("1.1.0", dir, "2026-07-18").changed).toBe(false);
  });

  test("a changelog with no Unreleased heading is a loud error", () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-cl-"));
    writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## v1.0.0 — first (2026-01-01)\n\n- shipped\n");
    expect(() => cutChangelog("1.1.0", dir, "2026-07-18")).toThrow(/no '## Unreleased' section/);
  });

  test("the bump commit carries package.json AND the cut CHANGELOG together", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-cl-"));
    await initRepo(dir);
    writeFileSync(join(dir, "package.json"), `{\n  "version": "1.0.0"\n}\n`);
    writeFileSync(join(dir, "CHANGELOG.md"), CHANGELOG);
    await git(["add", "."], dir);
    await git(["commit", "-qm", "seed"], dir);

    writeVersion("1.1.0", dir);
    const cut = cutChangelog("1.1.0", dir, "2026-07-18");
    expect(cut.changed).toBe(true);
    await commitVersion(dir, "1.1.0", cut.changed ? ["CHANGELOG.md"] : []);

    // One release commit, and it touched exactly package.json + CHANGELOG.md — they can't drift.
    const subject = await git(["log", "-1", "--pretty=%s"], dir);
    expect(subject).toBe("beckett: release v1.1.0");
    const files = (await git(["show", "--name-only", "--pretty=format:", "HEAD"], dir)).split("\n").filter(Boolean).sort();
    expect(files).toEqual(["CHANGELOG.md", "package.json"]);
    // Nothing left staged/dirty afterwards.
    expect(await git(["status", "--porcelain"], dir)).toBe("");
  });

  test("cuts an Unreleased section that has no following release (EOF boundary)", () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-cl-"));
    writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n\n- lone entry\n");
    const res = cutChangelog("1.0.0", dir, "2026-07-18");
    expect(res.changed).toBe(true);
    const after = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
    expect(after).toBe("# Changelog\n\n## Unreleased\n\n## v1.0.0 (2026-07-18)\n\n- lone entry\n");
  });
});

describe("resolveVersion (MAJOR is override-only)", () => {
  const patchSuggestion = classifyBump(["fix: a thing"]);

  test("no override → uses the auto-suggested level", () => {
    expect(resolveVersion("4.1.2", patchSuggestion)).toEqual({ version: "4.1.3", level: "patch" });
  });
  test("explicit --minor override", () => {
    expect(resolveVersion("4.1.2", patchSuggestion, "minor")).toEqual({ version: "4.2.0", level: "minor" });
  });
  test("MAJOR only via an explicit override, never from the suggestion", () => {
    // The suggestion here is patch; the ONLY way to reach a major is the explicit choice.
    expect(resolveVersion("4.1.2", patchSuggestion, "major")).toEqual({ version: "5.0.0", level: "major" });
    // Auto path can never be major regardless of the base.
    expect(resolveVersion("4.1.2", patchSuggestion).level).not.toBe("major");
  });
  test("an explicit target version infers the level it moved", () => {
    expect(resolveVersion("4.1.2", patchSuggestion, "6.0.0")).toEqual({ version: "6.0.0", level: "major" });
    expect(resolveVersion("4.1.2", patchSuggestion, "4.3.0")).toEqual({ version: "4.3.0", level: "minor" });
  });
});

describe("git-backed base + commits + suggestion", () => {
  let repo: string;

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "beckett-verrepo-"));
    mkdirSync(repo, { recursive: true });
    await initRepo(repo);
    // v4.1.2 is the "last deployed" tag.
    writeFileSync(join(repo, "package.json"), `{\n  "version": "4.1.2"\n}\n`);
    await git(["add", "-A"], repo);
    await git(["commit", "-q", "-m", "release v4.1.2"], repo);
    await tag(repo, "v4.1.2");
    // An older tag, to prove sort picks the newest.
    await tag(repo, "v3.6.1");
    // Two feature commits merged since.
    writeFileSync(join(repo, "a"), "1");
    await git(["add", "-A"], repo);
    await git(["commit", "-q", "-m", "fix: tidy a wart"], repo);
    writeFileSync(join(repo, "b"), "2");
    await git(["add", "-A"], repo);
    await git(["commit", "-q", "-m", "feat: add a shiny new capability"], repo);
  });

  test("lastDeployedVersion picks the newest vX.Y.Z tag", async () => {
    expect(await lastDeployedVersion(repo)).toBe("4.1.2");
  });

  test("commitsSinceVersion lists what merged since the tag, newest first", async () => {
    expect(await commitsSinceVersion(repo, "4.1.2")).toEqual([
      "feat: add a shiny new capability",
      "fix: tidy a wart",
    ]);
  });

  test("no new commits since the tag → empty list (a redeploy must not re-bump)", async () => {
    const redeploy = mkdtempSync(join(tmpdir(), "beckett-verrepo3-"));
    mkdirSync(redeploy, { recursive: true });
    await initRepo(redeploy);
    writeFileSync(join(redeploy, "package.json"), `{\n  "version": "4.2.0"\n}\n`);
    await git(["add", "-A"], redeploy);
    await git(["commit", "-q", "-m", "release v4.2.0"], redeploy);
    await tag(redeploy, "v4.2.0"); // HEAD === the tag: nothing merged since
    expect(await commitsSinceVersion(redeploy, "4.2.0")).toEqual([]);
  });

  test("computeBumpSuggestion → MINOR from the feature commit, base = the tag", async () => {
    const s = await computeBumpSuggestion(repo);
    expect(s.base).toBe("4.1.2");
    expect(s.fromTag).toBe(true);
    expect(s.baseSource).toBe("last deployed tag");
    expect(s.suggestion.level).toBe("minor");
    expect(s.suggested).toBe("4.2.0");
    expect(s.commits).toContain("feat: add a shiny new capability");
  });

  test("untagged package.json ahead of newest tag is the bump base (never downgrades)", async () => {
    const untagged = mkdtempSync(join(tmpdir(), "beckett-verrepo-untagged-"));
    await initRepo(untagged);
    writeFileSync(join(untagged, "package.json"), `{\n  "version": "4.1.2"\n}\n`);
    await git(["add", "package.json"], untagged);
    await git(["commit", "-q", "-m", "release v4.1.2"], untagged);
    await tag(untagged, "v4.1.2");

    // Simulate the incident: a manual v5.0.0 release reached package.json but was never tagged.
    writeFileSync(join(untagged, "package.json"), `{\n  "version": "5.0.0"\n}\n`);
    await git(["add", "package.json"], untagged);
    await git(["commit", "-q", "-m", "release v5.0.0"], untagged);
    writeFileSync(join(untagged, "feature"), "1");
    await git(["add", "feature"], untagged);
    await git(["commit", "-q", "-m", "feat: add the next capability"], untagged);

    expect(await lastDeployedVersion(untagged)).toBe("5.0.0");
    const s = await computeBumpSuggestion(untagged);
    expect(s.base).toBe("5.0.0");
    expect(s.fromTag).toBe(false);
    expect(s.baseSource).toBe("package.json — no tag for v5.0.0 (newest tag v4.1.2)");
    expect(s.suggested).toBe("5.1.0");
    expect(s.suggested.startsWith("4.")).toBe(false);
  });

  // The exact issue #30 incident: v6.8.1 reached package.json but only v6.8.0 got tagged (the
  // deploy died before the tag step). The OLD code based the bump on the newest tag (6.8.0),
  // suggested a PATCH → 6.8.1, then writeVersion's guard hit `refusing to write v6.8.1:
  // package.json is already v6.8.1` and wedged every future patch release. This proves the base is
  // now max(tag, package.json), so a patch increments PAST package.json and the guard is unreachable
  // via a merely-missing tag.
  test("tag behind package.json (issue #30 lost-tag wedge) → patch increments past package.json", async () => {
    const wedge = mkdtempSync(join(tmpdir(), "beckett-verrepo-wedge-"));
    await initRepo(wedge);
    writeFileSync(join(wedge, "package.json"), `{\n  "version": "6.8.0"\n}\n`);
    await git(["add", "package.json"], wedge);
    await git(["commit", "-q", "-m", "beckett: release v6.8.0"], wedge);
    await tag(wedge, "v6.8.0");
    // v6.8.1 shipped to package.json but was never tagged (the deploy died before `git tag -a`).
    writeFileSync(join(wedge, "package.json"), `{\n  "version": "6.8.1"\n}\n`);
    await git(["add", "package.json"], wedge);
    await git(["commit", "-q", "-m", "beckett: release v6.8.1"], wedge);
    // One ordinary fix merged since, so the classifier lands on PATCH — the level that used to wedge.
    writeFileSync(join(wedge, "fix"), "1");
    await git(["add", "fix"], wedge);
    await git(["commit", "-q", "-m", "fix: tidy something small"], wedge);

    const s = await computeBumpSuggestion(wedge);
    expect(s.base).toBe("6.8.1"); // max(6.8.0 tag, 6.8.1 package.json) — NOT the stale 6.8.0 tag
    expect(s.fromTag).toBe(false);
    expect(s.baseSource).toBe("package.json — no tag for v6.8.1 (newest tag v6.8.0)");
    expect(s.suggestion.level).toBe("patch");

    // Resolve the patch and prove it clears writeVersion's `refusing to write` guard: it must be
    // strictly greater than the current package.json version, so the deploy is no longer wedged.
    const { version } = resolveVersion(s.base, s.suggestion, undefined);
    expect(version).toBe("6.8.2");
    expect(compareSemver(version, readVersion(wedge))).toBeGreaterThan(0);
    expect(() => writeVersion(version, wedge)).not.toThrow();
  });

  test("no tags → package.json is the bump base, never throws", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "beckett-verrepo2-"));
    mkdirSync(fresh, { recursive: true });
    await initRepo(fresh);
    writeFileSync(join(fresh, "package.json"), `{\n  "version": "0.1.0"\n}\n`);
    await git(["add", "-A"], fresh);
    await git(["commit", "-q", "-m", "fix: initial"], fresh);
    expect(await lastDeployedVersion(fresh)).toBe("0.1.0");
    const s = await computeBumpSuggestion(fresh);
    expect(s.base).toBe("0.1.0");
    expect(s.fromTag).toBe(false);
    expect(s.baseSource).toBe("package.json — no tags yet");
  });
});
