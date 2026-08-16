/**
 * `src/run/proof.ts` — one case per verdict rule, named for the rule.
 */
import { describe, expect, test } from "bun:test";
import { assembleProof, proofVerdict, type ProofInput } from "./proof.ts";

const NOW = () => new Date("2026-08-16T00:00:00.000Z");

function input(over: Partial<ProofInput> = {}): ProofInput {
  return {
    landingMode: "pr",
    prUrl: null,
    pushUrl: null,
    prResolves: null,
    ci: "unknown",
    uiWork: false,
    screenshotPath: null,
    attempts: 0,
    ...over,
  };
}

describe("assembleProof", () => {
  test("a direct push with a URL is proof enough", () => {
    const proof = assembleProof(input({ landingMode: "direct-push", pushUrl: "https://github.com/o/r" }), NOW);
    expect(proof.verified).toBe(true);
    expect(proof.gaps).toEqual([]);
  });

  test("a direct push with no push URL recorded is unverified", () => {
    const proof = assembleProof(input({ landingMode: "direct-push", pushUrl: null }), NOW);
    expect(proof.verified).toBe(false);
    expect(proof.gaps).toEqual(["no push URL recorded"]);
  });

  test("a PR whose CI is red is unverified, not done", () => {
    const proof = assembleProof(
      input({ landingMode: "pr", prUrl: "https://github.com/o/r/pull/1", prResolves: true, ci: "failed" }),
      NOW,
    );
    expect(proof.verified).toBe(false);
    expect(proof.gaps).toEqual(["CI is failed, not green"]);
  });

  test("a pending CI is pending, not a failure", () => {
    const proof = assembleProof(
      input({ landingMode: "pr", prUrl: "https://github.com/o/r/pull/1", prResolves: true, ci: "pending" }),
      NOW,
    );
    expect(proof.verified).toBe(false);
    expect(proofVerdict(proof)).toBe("pending");
    expect(proof.gaps).toEqual(["CI is still running"]);
  });

  test("a resolved PR with green CI is verified with no gaps", () => {
    const proof = assembleProof(
      input({ landingMode: "pr", prUrl: "https://github.com/o/r/pull/1", prResolves: true, ci: "success" }),
      NOW,
    );
    expect(proof.verified).toBe(true);
    expect(proof.gaps).toEqual([]);
  });

  test("a resolved PR with no checks at all (ci: none) is verified", () => {
    const proof = assembleProof(
      input({ landingMode: "pr", prUrl: "https://github.com/o/r/pull/1", prResolves: true, ci: "none" }),
      NOW,
    );
    expect(proof.verified).toBe(true);
  });

  test("a PR that no longer resolves is unverified", () => {
    const proof = assembleProof(
      input({ landingMode: "pr", prUrl: "https://github.com/o/r/pull/1", prResolves: false, ci: "success" }),
      NOW,
    );
    expect(proof.verified).toBe(false);
    expect(proof.gaps).toEqual(["the PR no longer resolves"]);
  });

  test("a PR with no reader wired is verified, not asserted — never a false unverified", () => {
    const proof = assembleProof(
      input({ landingMode: "pr", prUrl: "https://github.com/o/r/pull/1", prResolves: null, ci: "unknown" }),
      NOW,
    );
    expect(proof.verified).toBe(true);
    expect(proof.gaps).toEqual(["no PR reader wired — prResolves not asserted"]);
  });

  test("UI work with no screenshot is unverified even with a green PR", () => {
    const proof = assembleProof(
      input({
        landingMode: "pr",
        prUrl: "https://github.com/o/r/pull/1",
        prResolves: true,
        ci: "success",
        uiWork: true,
        screenshotPath: null,
      }),
      NOW,
    );
    expect(proof.verified).toBe(false);
    expect(proofVerdict(proof)).toBe("unverified"); // never "pending" — a screenshot never just arrives
    expect(proof.gaps).toContain("UI work with no screenshot");
  });

  test("UI work with a screenshot on a green PR is fully verified", () => {
    const proof = assembleProof(
      input({
        landingMode: "pr",
        prUrl: "https://github.com/o/r/pull/1",
        prResolves: true,
        ci: "success",
        uiWork: true,
        screenshotPath: "/tmp/shot.png",
      }),
      NOW,
    );
    expect(proof.verified).toBe(true);
    expect(proof.gaps).toEqual([]);
  });

  test("a courier landing with no PR URL is unverified", () => {
    const proof = assembleProof(input({ landingMode: "courier", prUrl: null }), NOW);
    expect(proof.verified).toBe(false);
    expect(proof.gaps).toEqual(["a human published this; no PR URL recorded"]);
  });

  test("a courier landing with a backfilled PR URL is verified", () => {
    const proof = assembleProof(input({ landingMode: "courier", prUrl: "https://github.com/o/r/pull/9" }), NOW);
    expect(proof.verified).toBe(true);
    expect(proof.gaps).toEqual([]);
  });

  test("a local-only install is verified with a gap", () => {
    const proof = assembleProof(input({ landingMode: "local" }), NOW);
    expect(proof.verified).toBe(true);
    expect(proof.gaps).toEqual(["local-only, nothing published"]);
  });

  test("attempts and checkedAt pass through/stamp as given", () => {
    const proof = assembleProof(input({ landingMode: "local", attempts: 3 }), NOW);
    expect(proof.attempts).toBe(3);
    expect(proof.checkedAt).toBe("2026-08-16T00:00:00.000Z");
  });
});
