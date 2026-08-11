/**
 * Coverage for the pure semver core + the deploy-time MINOR/PATCH classifier (OPS-188). The
 * classifier is the load-bearing "smart bump" heuristic, so its rules (feature → minor, everything
 * else → patch, NEVER major) and its explainability are pinned here.
 */

import { test, expect, describe } from "bun:test";
import { parseSemver, formatSemver, applyBump, classifyBump, compareSemver } from "./semver.ts";

describe("parseSemver / formatSemver", () => {
  test("round-trips a clean triple", () => {
    expect(formatSemver(parseSemver("4.2.0"))).toBe("4.2.0");
  });
  test("tolerates a leading v", () => {
    expect(parseSemver("v10.0.3")).toEqual({ major: 10, minor: 0, patch: 3 });
  });
  test("round-trips a pre-release (v7 RC branding)", () => {
    expect(formatSemver(parseSemver("7.0.0-rc.1"))).toBe("7.0.0-rc.1");
    expect(parseSemver("v7.0.0-rc.1")).toEqual({ major: 7, minor: 0, patch: 0, pre: "rc.1" });
  });
  test("rejects garbage", () => {
    expect(() => parseSemver("4.2")).toThrow();
    expect(() => parseSemver("nope")).toThrow();
    expect(() => parseSemver("1.2.3-")).toThrow();
    expect(() => parseSemver("1.2.3-rc..1")).toThrow();
  });
});

describe("compareSemver (pre-release ordering, semver §11)", () => {
  test("a pre-release sorts below its release", () => {
    expect(compareSemver("7.0.0-rc.1", "7.0.0")).toBeLessThan(0);
    expect(compareSemver("7.0.0", "7.0.0-rc.1")).toBeGreaterThan(0);
  });
  test("a pre-release still sorts above every earlier release", () => {
    expect(compareSemver("7.0.0-rc.1", "6.28.0")).toBeGreaterThan(0);
  });
  test("rc.2 beats rc.1 numerically, not lexically", () => {
    expect(compareSemver("7.0.0-rc.2", "7.0.0-rc.1")).toBeGreaterThan(0);
    expect(compareSemver("7.0.0-rc.10", "7.0.0-rc.9")).toBeGreaterThan(0);
  });
  test("numeric identifiers sort below alphanumeric; shorter prefix sorts first", () => {
    expect(compareSemver("7.0.0-1", "7.0.0-rc")).toBeLessThan(0);
    expect(compareSemver("7.0.0-rc", "7.0.0-rc.1")).toBeLessThan(0);
  });
  test("equal versions compare equal, pre or not", () => {
    expect(compareSemver("7.0.0-rc.1", "7.0.0-rc.1")).toBe(0);
    expect(compareSemver("7.0.0", "7.0.0")).toBe(0);
  });
});

describe("applyBump (semver carry)", () => {
  test("patch increments the last part only", () => {
    expect(applyBump("4.1.2", "patch")).toBe("4.1.3");
  });
  test("minor increments minor and zeros patch", () => {
    expect(applyBump("4.1.2", "minor")).toBe("4.2.0");
  });
  test("major increments major and zeros minor+patch", () => {
    expect(applyBump("4.1.2", "major")).toBe("5.0.0");
  });
  test("patch bump of a pre-release releases it (drops the tail, npm behavior)", () => {
    expect(applyBump("7.0.0-rc.1", "patch")).toBe("7.0.0");
  });
  test("minor/major bumps of a pre-release carry normally and drop the tail", () => {
    expect(applyBump("7.0.0-rc.1", "minor")).toBe("7.1.0");
    expect(applyBump("7.0.0-rc.1", "major")).toBe("8.0.0");
  });
});

describe("classifyBump", () => {
  test("a feature commit makes it a MINOR and names the driver", () => {
    const r = classifyBump(["fix: null guard", "feat: add federation peers command"]);
    expect(r.level).toBe("minor");
    expect(r.minorCommits).toEqual(["feat: add federation peers command"]);
    expect(r.reasons.join("\n")).toContain("add federation peers command");
    expect(r.reasons.join(" ").toLowerCase()).toContain("minor");
  });

  test('"implement" reads as a new capability (minor)', () => {
    const r = classifyBump(["beckett: OPS-186 implement (wk_88b40d1d)"]);
    expect(r.level).toBe("minor");
  });

  test("a pure refactor is a PATCH (V5 refactor is minor-at-most → we call it patch)", () => {
    const r = classifyBump([
      "V5 Daemon: extensibility refactor (all 7 phases) (#114)",
      "chore: tidy imports",
      "docs: update readme",
    ]);
    expect(r.level).toBe("patch");
    expect(r.reasons.join(" ").toLowerCase()).toContain("patch");
  });

  test("NEVER returns major even when a commit screams breaking", () => {
    const r = classifyBump(["feat!: breaking rewrite of the whole daemon API major bump"]);
    expect(r.level).not.toBe("major");
    expect(["minor", "patch"]).toContain(r.level);
  });

  test("word-boundary matching: 'address' does not trip 'add'", () => {
    const r = classifyBump(["fix: correct the peer address parsing"]);
    expect(r.level).toBe("patch");
  });

  test("no commits → PATCH with an explaining reason (no crash)", () => {
    const r = classifyBump([]);
    expect(r.level).toBe("patch");
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  test("caps the driver list in the reasons but reports the true count", () => {
    const many = Array.from({ length: 8 }, (_, i) => `feat: add capability number ${i}`);
    const r = classifyBump(many);
    expect(r.level).toBe("minor");
    expect(r.minorCommits.length).toBe(8);
    expect(r.reasons.join("\n")).toContain("and 3 more");
  });
});
