/**
 * Beckett — the capability preflight (`src/capability/preflight.ts`, overhaul B10)
 * =======================================================================================
 * A run whose target org has no GitHub App installation used to provision a repo, cut a
 * worktree, spawn a worker, build the whole change, and die at push — the worker's token spent,
 * a human left to notice the failure hours later (`run-20260812-troll-pr-delete-the-codebase`).
 * This module is the "needs you before this can land" inventory a run's admission runs ONCE, up
 * front, so a definitively human-blocking gap parks the run before any worktree or worker exists.
 *
 * Deliberately narrow: only `github-not-installed` / `github-no-such-owner` are blocking — they
 * are the observed mid-run 403 and the daemon cannot clear either one itself. Everything else
 * (an unselected-but-not-yet-created repo, a jingle entry named in prose, a wobbly browser lane)
 * is advisory: traced for a human to see, never enough on its own to park a healthy run. Any
 * check that THROWS is dropped and logged by the caller — fail-open, always, because a preflight
 * bug must never be the reason a run cannot start.
 *
 * Distinct from `RunSupervisorDeps.preflight` (`src/run/supervisor.ts`) — that one is the HARNESS
 * health probe (`preflightFor`, is claude/codex/pi itself reachable). This is a capability
 * INVENTORY over the target's GitHub access, jingle vault, and browser lane. Same word, two very
 * different jobs; the supervisor carries both under different dep names.
 */

import type { AccessDiagnosis } from "../github/app.ts";

/** What kind of gap this is. The `kind` — not the caller — decides {@link CapabilityGap.severity}. */
export type CapabilityGapKind =
  | "github-not-installed"
  | "github-no-such-owner"
  | "github-repo-not-selected"
  | "keychain-entry-missing"
  | "browser-lane-down";

export interface CapabilityGap {
  kind: CapabilityGapKind;
  /** "BetterWright/betterwright", "huggingface", "browser" — what is missing. */
  subject: string;
  /** One line, human voice, no jargon. */
  detail: string;
  /** The exact thing a human does to clear it (install URL, jingle command). */
  fix: string;
  /** blocking → park before staffing; advisory → trace only, never parks a run. */
  severity: "blocking" | "advisory";
}

export interface CapabilityInventory {
  /** Names of every check this pass attempted (whether or not it produced a gap). */
  checked: string[];
  gaps: CapabilityGap[];
}

export interface CapabilityPreflightDeps {
  github?: { diagnoseAccess(t: { owner: string; repo?: string }): Promise<AccessDiagnosis> };
  keychain?: { list(): Promise<string[]> };
  browserLane?: () => { ok: boolean; detail: string };
}

export interface CapabilityTarget {
  /** "owner/name" of the repo the work lands in, or null when there is none. */
  repo: string | null;
  /** The request text, scanned for explicitly named jingle entries and browser intent. */
  prompt: string;
}

/** Entry names the prompt names explicitly — `jingle entry "x"`, `keychain entry x`, `credsEntry: x`. */
const KEYCHAIN_ENTRY_RE =
  /(?:jingle|keychain)\s+entry\s+["'`]?([a-z0-9][\w.-]*)|credsEntry\s*[:=]\s*["'`]?([a-z0-9][\w.-]*)/gi;

/** Browser intent worth probing the lane for — beckett's own repo work mentions "browser" a lot, so this stays narrow. */
const BROWSER_INTENT_RE = /\b(browser|log ?in|sign ?up|screenshot the (site|page))\b/i;

function extractKeychainEntries(prompt: string): string[] {
  const names = new Set<string>();
  for (const m of prompt.matchAll(KEYCHAIN_ENTRY_RE)) {
    const name = m[1] ?? m[2];
    if (name) names.add(name);
  }
  return [...names];
}

/** GitHub `diagnoseAccess` → a gap, or `null` for `"ok"`. Severity is the policy, not the caller's opinion. */
function gapFromDiagnosis(owner: string, diagnosis: AccessDiagnosis): CapabilityGap | null {
  switch (diagnosis.status) {
    case "ok":
      return null;
    case "not-installed":
      return {
        kind: "github-not-installed",
        subject: owner,
        detail: `the GitHub App is not installed on \`${owner}\``,
        fix: diagnosis.installUrl,
        severity: "blocking",
      };
    case "no-such-owner":
      return {
        kind: "github-no-such-owner",
        subject: owner,
        detail: `there is no GitHub account named \`${owner}\``,
        fix: "check the owner name",
        severity: "blocking",
      };
    case "repo-not-selected":
    case "repo-not-selected-or-missing":
      return {
        kind: "github-repo-not-selected",
        subject: diagnosis.repo,
        detail: `\`${diagnosis.repo}\` is not selected in the GitHub App installation on \`${owner}\` (a brand-new repo legitimately looks like this until it is created)`,
        fix: diagnosis.installUrl,
        severity: "advisory",
      };
  }
}

/**
 * Build the preflight function. Every check is independently optional (an absent dep just skips
 * that check) and independently fail-open (a throwing check is dropped, never surfaced as a gap,
 * and never stops the others from running).
 */
export function createCapabilityPreflight(
  deps: CapabilityPreflightDeps,
): (target: CapabilityTarget) => Promise<CapabilityInventory> {
  return async (target) => {
    const checked: string[] = [];
    const gaps: CapabilityGap[] = [];

    if (deps.github && target.repo) {
      checked.push("github");
      try {
        const slash = target.repo.indexOf("/");
        const owner = slash === -1 ? target.repo : target.repo.slice(0, slash);
        const diagnosis = await deps.github.diagnoseAccess({ owner, repo: target.repo });
        const gap = gapFromDiagnosis(owner, diagnosis);
        if (gap) gaps.push(gap);
      } catch {
        // fail open — a GitHub API hiccup at admission must never park a run on its own.
      }
    }

    if (deps.keychain) {
      const entries = extractKeychainEntries(target.prompt);
      if (entries.length > 0) {
        checked.push("keychain");
        try {
          const list = await deps.keychain.list();
          const have = new Set(list);
          for (const name of entries) {
            if (!have.has(name)) {
              gaps.push({
                kind: "keychain-entry-missing",
                subject: name,
                detail: `the jingle entry \`${name}\` this run mentions is not in the vault yet`,
                fix: "add it to jingle (`beckett secret request …` or `jingle add <name>`)",
                severity: "advisory",
              });
            }
          }
        } catch {
          // fail open — a vault listing failure must never park a run on its own.
        }
      }
    }

    if (deps.browserLane && BROWSER_INTENT_RE.test(target.prompt)) {
      checked.push("browser");
      try {
        const health = deps.browserLane();
        if (!health.ok) {
          gaps.push({
            kind: "browser-lane-down",
            subject: "browser",
            detail: `this looks like browser work, but the browser lane is unhealthy: ${health.detail}`,
            fix: "check the browser lane (`beckett status`, or restart the daemon)",
            severity: "advisory",
          });
        }
      } catch {
        // fail open — a lane health probe throwing must never park a run on its own.
      }
    }

    return { checked, gaps };
  };
}

/** "needs you before this can land" — the one list, blocking first. Empty gaps → empty string. */
export function renderCapabilityGaps(gaps: readonly CapabilityGap[]): string {
  if (gaps.length === 0) return "";
  const blocking = gaps.filter((g) => g.severity === "blocking");
  const advisory = gaps.filter((g) => g.severity === "advisory");
  const lines: string[] = [];
  if (blocking.length > 0) {
    lines.push("this run needs you before it can land:");
    for (const g of blocking) lines.push(`- ${g.detail} → ${g.fix}`);
  }
  if (advisory.length > 0) {
    lines.push("also worth clearing (not blocking):");
    for (const g of advisory) lines.push(`- ${g.detail} → ${g.fix}`);
  }
  return lines.join("\n");
}
