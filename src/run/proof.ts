/**
 * Beckett — done means proven (`src/run/proof.ts`, overhaul B12)
 * =======================================================================================
 * Before this module, `publishRun` granted `done` the instant `git push`/`gh pr create` returned
 * — `state: "done", prUrl: outcome.prUrl ?? outcome.url ?? null`. That `?? outcome.url` fallback
 * is how a direct push's bare repo URL ended up in `prUrl`, and nothing ever asked whether an
 * opened PR actually resolved or whether its CI was green. `assembleProof` replaces the grant
 * with a VERDICT: `done` is now something a {@link Proof} earns, not a label a publish call
 * hands itself.
 *
 * Pure module — no I/O, no supervisor imports, no network. `./supervisor.ts#publishRun` calls
 * into this with the facts it already has (or `null` for a fact nothing checked); the staffing
 * watchdog's `reconcileProofs` calls it again on every unverified run with fresher facts.
 */

import type { CiVerdict, LandingMode, Proof } from "./types.ts";

/** Everything {@link assembleProof} needs to decide a verdict — no ids, no timestamps. */
export interface ProofFacts {
  landingMode: LandingMode;
  /** ONLY a pull-request URL. A bare repo/compare URL belongs in `pushUrl`. */
  prUrl: string | null;
  pushUrl: string | null;
  /** null = never checked (no `verifyPr` reader wired). */
  prResolves: boolean | null;
  ci: CiVerdict;
  uiWork: boolean;
  screenshotPath: string | null;
}

export interface ProofInput extends ProofFacts {
  /** How many re-check passes this proof has already burned. `assembleProof` does not increment it. */
  attempts: number;
}

/** The tri-state a {@link Proof} actually decides between — `Proof.verified` collapses the last two. */
export type ProofVerdict = "verified" | "pending" | "unverified";

/**
 * The pure verdict rules, shared by {@link assembleProof} (facts not yet a `Proof`) and
 * {@link proofVerdict} (a `Proof` re-inspected, e.g. after a re-check). Order matters: a landing
 * mode's own rule runs first, then the UI-work rule can only ever push the verdict DOWN
 * (verified/pending → unverified), never up — a screenshot does not arrive by waiting, so it is
 * checked last and never produces `pending`.
 */
function verdictOf(facts: ProofFacts): { verdict: ProofVerdict; gaps: string[] } {
  const gaps: string[] = [];
  let verdict: ProofVerdict = "verified";

  switch (facts.landingMode) {
    case "local":
      // An install with no publisher wired must not be permanently unverified — there is nothing
      // more to check, ever, so this is verified-with-a-gap, not a state that waits forever.
      gaps.push("local-only, nothing published");
      break;
    case "courier": {
      // A human published this by hand; the daemon never drove it, so there is no synchronous PR
      // URL to check UNTIL a human backfills one (#228's backfill hole, made visible).
      if (facts.prUrl === null) {
        gaps.push("a human published this; no PR URL recorded");
        verdict = "unverified";
      }
      break;
    }
    case "pr": {
      if (facts.prResolves === null) {
        // No reader wired — "not asserted", never a false unverified.
        gaps.push("no PR reader wired — prResolves not asserted");
      } else if (facts.prResolves === false) {
        gaps.push("the PR no longer resolves");
        verdict = "unverified";
      } else if (facts.ci === "pending") {
        gaps.push("CI is still running");
        verdict = "pending";
      } else if (facts.ci !== "success" && facts.ci !== "none") {
        gaps.push(`CI is ${facts.ci}, not green`);
        verdict = "unverified";
      }
      break;
    }
    case "direct-push": {
      // CI is not consulted for a direct push — there is no PR for it to run against.
      if (facts.pushUrl === null) {
        gaps.push("no push URL recorded");
        verdict = "unverified";
      }
      break;
    }
  }

  if (facts.uiWork && facts.screenshotPath === null) {
    gaps.push("UI work with no screenshot");
    verdict = "unverified"; // never "pending" — a screenshot does not arrive by waiting
  }

  return { verdict, gaps };
}

/** Re-derive the tri-state verdict from an already-assembled {@link Proof} (a re-check pass). */
export function proofVerdict(p: ProofFacts): ProofVerdict {
  return verdictOf(p).verdict;
}

/** Assemble a {@link Proof} from the facts a caller has in hand right now. Pure; never throws. */
export function assembleProof(input: ProofInput, now: () => Date = () => new Date()): Proof {
  const { verdict, gaps } = verdictOf(input);
  return {
    landingMode: input.landingMode,
    prUrl: input.prUrl,
    pushUrl: input.pushUrl,
    prResolves: input.prResolves,
    ci: input.ci,
    uiWork: input.uiWork,
    screenshotPath: input.screenshotPath,
    verified: verdict === "verified",
    gaps,
    checkedAt: now().toISOString(),
    attempts: input.attempts,
  };
}
