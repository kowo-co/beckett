/**
 * `src/cli/spine.ts` — targeted characterization for the two-word verb resolution the
 * proactive-sweep / spend-report routine bodies depend on (overhaul B "surface-fixes",
 * finding 20).
 *
 * Before the fix, `resolveVerb(["routine", "proactive-sweep", ...])` fell through to the bare
 * `"routine"` verb (usage cascade) because only `routine deps-update` was registered next to it
 * — the scheduler's detached `beckett routine proactive-sweep …` / `beckett routine
 * spend-report …` subprocesses could never be routed to their bodies, so the scheduled sweep and
 * the spend report silently no-op'd forever (their own `stderr: "ignore"` swallowed the usage
 * error). This pins that both two-word routine bodies now win the longest-match resolve.
 */

import { expect, test } from "bun:test";
import { composeCliHelp, resolveVerb } from "./spine.ts";

test("routine proactive-sweep resolves to its own body, not the bare routine usage cascade", () => {
  const resolved = resolveVerb(["routine", "proactive-sweep", "--repos", "foo/bar"]);
  expect(resolved).not.toBeNull();
  expect(resolved!.rest).toEqual(["--repos", "foo/bar"]);
});

test("routine spend-report resolves to its own body, not the bare routine usage cascade", () => {
  const resolved = resolveVerb(["routine", "spend-report", "--since", "7d"]);
  expect(resolved).not.toBeNull();
  expect(resolved!.rest).toEqual(["--since", "7d"]);
});

test("routine deps-update still resolves (regression guard alongside the new two-word verbs)", () => {
  const resolved = resolveVerb(["routine", "deps-update", "--base", "main"]);
  expect(resolved).not.toBeNull();
  expect(resolved!.rest).toEqual(["--base", "main"]);
});

test("the bare routine verb still resolves for single-word invocations (list/inspect/add/…)", () => {
  const resolved = resolveVerb(["routine", "list"]);
  expect(resolved).not.toBeNull();
  expect(resolved!.rest).toEqual(["list"]);
});

test("the routine bodies carry no help token — the composed help string is unchanged", () => {
  expect(composeCliHelp()).toContain("routine list|inspect|add|remove|fire");
  expect(composeCliHelp()).not.toContain("proactive-sweep");
  expect(composeCliHelp()).not.toContain("spend-report");
});

test("the composed help advertises the full task verb list (finding 23)", () => {
  expect(composeCliHelp()).toContain(
    "task create|branch|start|deploy|ask|steer|resume|cancel|courier|show|list|trace",
  );
});
