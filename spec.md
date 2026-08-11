# Pin betterwright to 1.7.2 release
> run: run-20260811-pin-betterwright-to-1-7-2-release · branch: beckett/run-pin-betterwright-to-1-7-2-release · created: 2026-08-11T05:54:11.606Z

## Goal
ro (user 1151230208783945818) asked: 'yeah probably just pin it to the official release to keep things clean'. Context: SSH shipped betterwright v1.7.2 (https://github.com/BetterWright/betterwright/releases/tag/v1.7.2), which is the same code as v1.7.2-beta.0 that this install is currently pinned to and running.

Task: move the betterwright pin in Beckett's own source from 1.7.2-beta.0 to the released 1.7.2, so the manifest no longer references a prerelease. Update package.json (and bun.lock via a real install, not a hand edit). Check for any other place the version is pinned or referenced — grep for 'betterwright' and '1.7.2-beta' across the repo including config/manifest/docs — and update them consistently.

Note: package.json and bun.lock already have uncommitted local modifications on main from the earlier beta bump; fold that into the change rather than reverting it.

Done means: nothing in the repo references 1.7.2-beta.0, the installed betterwright resolves to 1.7.2, and 'bun test' is no better and no worse than the current baseline (2825 pass, 1 pre-existing network-dependent github-token test failure — that one failing is expected, don't chase it). Do not upgrade any other dependency and do not refactor anything else.

## Checklist
- [ ] (worker fills this in as its FIRST action: concrete, verifiable items)

## Notes
(worker scratch: decisions, blockers, handoff notes)
