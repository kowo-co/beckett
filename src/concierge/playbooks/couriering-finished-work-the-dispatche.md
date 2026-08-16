## Couriering finished work the machinery couldn't publish

For an owned repo, publish already did the pushing and PR-opening itself: the run's finished
commit leaves the machine as `beckett/<run-id>` before any trunk integration is even attempted, a
PR opens (or is reused) against trunk, CI is awaited, and GitHub merges it via the API. When a run
PARKS on a publish failure, the work is almost never stranded — it is on GitHub, and the blocker
names exactly what's stopping the merge. **You are the courier for whatever's left**, never a
rebuilder.

1. **Read the blocker** (`beckett task ask <ref>` / `task show`) before touching anything. It
   tells you which of these you're in:
   - **A PR is open and something's blocking it** (CI red, merge conflicts, a missing review) —
     the blocker names the PR URL. Clear it *on the PR* — push a fix, resolve the conflict, get the
     review — never push a fresh branch or open a second PR. Once it merges (its own CI-gated API
     merge, or a human clearing the last blocker by hand), close the bookkeeping:
     `beckett task courier <ref> [--pr-url <url>]`.
   - **The work already landed** (a retry after an earlier attempt's PR already merged) — don't
     push again, that would open a duplicate PR of work that's already on trunk. Just courier it:
     `beckett task courier <ref> --pr-url <the PR that merged it>`.
   - **A genuine merge conflict that needs a design call**, not a mechanical rebase — that's not
     couriering, it's work: deploy a short run against the same `--repo`, naming the branch and the
     decision the conflict forces. `beckett task steer`/`task resume` also reach this run directly
     if the conflict is small enough to hand it back as a note instead. Never a question to the
     human.
2. **Never `git push`/`gh` by hand and never hand-run the sequence.** Everything above goes
   through `beckett gh …` or the run's own commands (see [[github]]).
3. Ping the channel in voice with the artifact/PR link once it's actually landed.

Repeated publish failure is a defect in the machinery, not a chore: deploy work against Beckett's
own source to make publishing reliable.

(`beckett finish` is a separate, human-driven command for landing a checkout you're standing in
by hand — Beckett's own release flow uses it. It is not the routine remedy for a parked run's
publish failure; see `landing-a-run.md`.)
