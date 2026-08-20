/**
 * Beckett — quota-exit tests (`src/drivers/cursor-checkpoint.test.ts`)
 * =======================================================================================
 * The "no work lost" promise, tested against a REAL git repo and a REAL spec.md rather than
 * asserted in a comment.
 *
 * The two failure points the design calls out are exercised separately because they leave
 * genuinely different state behind:
 *
 *   - **before the first token** — nothing written, nothing ticked, nothing to commit. The exit
 *     must be a clean no-op that still produces a briefing, not a spurious empty commit.
 *   - **mid-run, between checklist items** — uncommitted edits on disk AND boxes this run ticked
 *     with nothing behind them. The exit must commit the edits, reset exactly those boxes (and no
 *     others), and name them for the incoming worker.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CHECKPOINT_COMMIT_MESSAGE, checkpointCommit, git, performQuotaExit } from "./cursor-checkpoint.ts";
import { CURSOR_HANDOFF_REL } from "./cursor-handoff.ts";
import { SPEC_FILE_REL, parseSpecChecklist } from "../run/spec-file.ts";

let repo = "";

/** A real git repo with a real committed baseline — nothing here is faked. */
function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "beckett-cursor-ckpt-"));
  git(["init", "-q", "-b", "beckett/run-thing"], dir);
  git(["config", "user.name", "Beckett Test"], dir);
  git(["config", "user.email", "beckett@example.test"], dir);
  git(["config", "commit.gpgsign", "false"], dir);
  writeFileSync(join(dir, "README.md"), "# base\n");
  git(["add", "-A"], dir);
  git(["commit", "-qm", "base"], dir);
  mkdirSync(join(dir, ".beckett"), { recursive: true });
  return dir;
}

function writeSpec(dir: string, checklist: string): void {
  writeFileSync(
    join(dir, SPEC_FILE_REL),
    `# Thing\n> run: run-20260820-thing · branch: beckett/run-thing\n\n## Goal\ndo it\n\n## Checklist\n${checklist}\n\n## Notes\nscratch\n`,
  );
}

function ctx(over: Partial<Parameters<typeof performQuotaExit>[0]> = {}) {
  return {
    workspace: repo,
    agentId: "agent-abc",
    model: "Auto",
    ticksAtStart: new Set<string>(),
    activity: [],
    notes: [],
    now: () => new Date("2026-08-20T02:00:00.000Z"),
    ...over,
  };
}

function log(dir: string): string[] {
  return git(["log", "--format=%s"], dir).stdout.split("\n").filter(Boolean);
}

beforeEach(() => {
  repo = initRepo();
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

// =======================================================================================
// checkpointCommit
// =======================================================================================

describe("checkpointCommit", () => {
  test("uncommitted work becomes a real commit — never a stash, never a discard", () => {
    writeFileSync(join(repo, "src.ts"), "export const x = 1;\n");
    const sha = checkpointCommit(repo);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(log(repo)[0]).toBe(CHECKPOINT_COMMIT_MESSAGE);
    // The file is IN the commit, not merely off the working tree.
    expect(git(["show", "--name-only", "--format=", "HEAD"], repo).stdout).toContain("src.ts");
    expect(git(["status", "--porcelain"], repo).stdout).toBe("");
    // Nothing was stashed away where it could be forgotten.
    expect(git(["stash", "list"], repo).stdout).toBe("");
  });

  test("a clean tree produces NO commit — an empty checkpoint would be noise in the history", () => {
    expect(checkpointCommit(repo)).toBeNull();
    expect(log(repo)).toEqual(["base"]);
  });

  test("the scaffolding never rides into the commit, even when forced into the index", () => {
    writeFileSync(join(repo, "src.ts"), "1\n");
    writeFileSync(join(repo, SPEC_FILE_REL), "# spec\n");
    git(["add", "-f", ".beckett"], repo);
    checkpointCommit(repo);
    const files = git(["show", "--name-only", "--format=", "HEAD"], repo).stdout;
    expect(files).toContain("src.ts");
    expect(files).not.toContain(".beckett");
  });

  test("a non-repo path degrades to null instead of throwing", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "beckett-not-a-repo-"));
    try {
      expect(checkpointCommit(notARepo)).toBeNull();
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});

// =======================================================================================
// Failure point 1 — before the first token
// =======================================================================================

describe("quota exit BEFORE the first token", () => {
  test("nothing is committed, nothing is un-ticked, and a briefing still exists", () => {
    writeSpec(repo, "- [ ] one\n- [ ] two");
    const result = performQuotaExit(ctx(), { reason: "usage limit reached", status: 429 });

    expect(result.checkpoint).toBeNull();
    expect(result.unverifiedTicks).toEqual([]);
    expect(log(repo)).toEqual(["base"]);

    const handoff = readFileSync(join(repo, CURSOR_HANDOFF_REL), "utf8");
    expect(handoff).toContain("the seat was abandoned before it touched the tree");
    expect(handoff).toContain("Nothing was uncommitted at that moment");
    // The run id and branch come off the workspace itself, so the briefing can never name a
    // different run than the checklist sitting beside it.
    expect(handoff).toContain("run-20260820-thing");
    expect(handoff).toContain("beckett/run-thing");
    // The checklist is untouched — the incoming worker starts from the same board.
    expect(parseSpecChecklist(readFileSync(join(repo, SPEC_FILE_REL), "utf8")).total).toBe(2);
  });

  test("a workspace with no spec.md yet does not crash the exit", () => {
    const result = performQuotaExit(ctx(), { reason: "spent" });
    expect(result.unverifiedTicks).toEqual([]);
    expect(readFileSync(join(repo, CURSOR_HANDOFF_REL), "utf8")).toContain("Why the seat was handed over");
  });
});

// =======================================================================================
// Failure point 2 — mid-run, between checklist items
// =======================================================================================

describe("quota exit MID-RUN, between checklist items", () => {
  test("edits are committed, this run's ticks are reset, and inherited ticks are left alone", () => {
    // The seat inherited one already-ticked item and ticked two more of its own before the wall.
    writeSpec(repo, "- [x] inherited from an earlier pass\n- [x] wrote the driver\n- [x] wired the registry\n- [ ] tests");
    writeFileSync(join(repo, "driver.ts"), "export const driver = 1;\n");
    writeFileSync(join(repo, "registry.ts"), "export const registry = 1;\n");

    const result = performQuotaExit(
      ctx({
        ticksAtStart: new Set(["inherited from an earlier pass"]),
        activity: [
          { tool: "edit", detail: "driver.ts" },
          { tool: "edit", detail: "registry.ts" },
        ],
        notes: ["chose a shim over an in-process loop so kills still work"],
      }),
      { reason: "You have hit your usage limit", status: 429, code: "usage_limit" },
    );

    // 1 — the work is committed, on the same branch, nothing lost.
    expect(result.checkpoint).toMatch(/^[0-9a-f]{40}$/);
    expect(log(repo)[0]).toBe(CHECKPOINT_COMMIT_MESSAGE);
    const committed = git(["show", "--name-only", "--format=", "HEAD"], repo).stdout;
    expect(committed).toContain("driver.ts");
    expect(committed).toContain("registry.ts");
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], repo).stdout).toBe("beckett/run-thing");

    // 2 — exactly this run's ticks were reset. The inherited one was NOT ours to touch.
    expect(result.unverifiedTicks.sort()).toEqual(["wired the registry", "wrote the driver"]);
    const spec = parseSpecChecklist(readFileSync(join(repo, SPEC_FILE_REL), "utf8"));
    expect(spec.total).toBe(4); // every item survives — only the unverified marks cleared
    expect(spec.items.find((i) => i.text === "inherited from an earlier pass")?.done).toBe(true);
    expect(spec.items.find((i) => i.text === "wrote the driver")?.done).toBe(false);
    expect(spec.items.find((i) => i.text === "wired the registry")?.done).toBe(false);
    expect(spec.items.find((i) => i.text === "tests")?.done).toBe(false);

    // 3 — the briefing names all of it, including the raw error shape.
    const handoff = readFileSync(join(repo, CURSOR_HANDOFF_REL), "utf8");
    expect(handoff).toContain("- edit: driver.ts");
    expect(handoff).toContain("chose a shim over an in-process loop");
    expect(handoff).toContain("- wrote the driver");
    expect(handoff).toContain("- wired the registry");
    expect(handoff).not.toContain("- inherited from an earlier pass");
    expect(handoff).toContain("HTTP 429");
    expect(handoff).toContain("code `usage_limit`");
    expect(handoff).toContain(result.checkpoint!);
  });

  test("a run that ticked nothing of its own resets nothing", () => {
    writeSpec(repo, "- [x] done before this seat\n- [ ] not yet");
    writeFileSync(join(repo, "a.ts"), "1\n");
    const result = performQuotaExit(ctx({ ticksAtStart: new Set(["done before this seat"]) }), { reason: "spent" });
    expect(result.unverifiedTicks).toEqual([]);
    expect(parseSpecChecklist(readFileSync(join(repo, SPEC_FILE_REL), "utf8")).done).toBe(1);
    // …but the edit still got committed. The two concerns are independent.
    expect(result.checkpoint).not.toBeNull();
  });

  test("the handoff is git-excluded scaffolding, so it never lands in the run's diff", () => {
    writeSpec(repo, "- [x] a");
    writeFileSync(join(repo, "code.ts"), "1\n");
    performQuotaExit(ctx(), { reason: "spent" });
    // Committed by the exit itself…
    expect(git(["show", "--name-only", "--format=", "HEAD"], repo).stdout).not.toContain("cursor-handoff.md");
    // …and still untracked afterwards, so a later `git add -A` cannot sweep it in either.
    checkpointCommit(repo);
    expect(git(["ls-files", ".beckett"], repo).stdout).toBe("");
  });

  test("the credential can never reach the handoff — it is not an input to this module at all", () => {
    // Structural, not incidental: `QuotaExitContext` has no field that could carry a key, and the
    // rendered file is built only from that context plus git/spec state.
    writeSpec(repo, "- [x] a");
    performQuotaExit(ctx({ notes: ["nothing secret here"] }), { reason: "spent" });
    const handoff = readFileSync(join(repo, CURSOR_HANDOFF_REL), "utf8");
    expect(handoff).not.toContain("CURSOR_API_KEY");
    expect(handoff.toLowerCase()).not.toContain("bearer ");
  });
});
