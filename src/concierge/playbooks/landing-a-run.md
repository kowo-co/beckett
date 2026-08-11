## Landing a run: `beckett finish`

Work is committed on its branch and needs to become real — PR, merge, and (for your own repo) a
redeploy. **That whole motion is one command.** Run it from the checkout the run's BRANCH is in
— the worker's worktree (`~/Projects/<slug>/.beckett/worktrees/<run-id>`) when the work ran there, or
`~/Projects/<slug>` itself when the branch is checked out directly:

```bash
cd <the run's checkout> && beckett finish -m "what this work shipped"
```

It pushes the branch, opens **or reuses** the PR with that message, waits for CI, merges into
`main`, and then runs the guarded redeploy (`deploy/deploy-prod.sh` — refuses dirty trees,
typechecks, drains browser work, health-checks itself, tags the release). It commits a dirty tree
with the same message first, and it announces itself in the ops channel every run.

**Everything that reaches GitHub goes through the GitHub App token — including the deploy's own two
writes.** `main` is branch-protected (PR + the `check` status check), so the deploy does not push to
it: it puts the release-version bump on `release-bump-vX.Y.Z`, lands that through its own PR
(`beckett gh land` — the same push → PR → CI → merge engine `finish` uses), then pushes the
annotated release tag with `beckett gh push --tag`. Two consequences worth knowing:

- **A deploy waits for a second CI run** — the bump PR's. That is why a `finish` can sit for a few
  extra minutes after the merge; `BECKETT_BUMP_CI_TIMEOUT` (seconds, default 1800) bounds it.
- **Nobody hand-couriers a bump PR any more.** If you find yourself opening one by hand, something
  is broken — read the deploy's own FATAL line instead of working around it.

You don't have to pick the deploy's directory: the redeploy always runs in the repo's **primary**
checkout (the one holding `main`), because a linked worktree can't check `main` out while that one
holds it. `finish` resolves it for you, and refuses up front — before anything is pushed or merged
— if that checkout is dirty or has no git identity.

**Do not hand-run the sequence any more.** Separate `beckett gh push` → `gh pr create` → poll
status → `gh pr merge` → hunt for the deploy script is the thing this replaced: five calls, four
places to lose the thread, and a redeploy that quietly got skipped. One command, one report.

Useful flags — defaults are right almost always:

- `--no-deploy` — land it but don't ship (an owner hold on going live).
- `--repo <owner/name>` / `--dir <path>` — only when the checkout's `origin` can't answer.
- `--ci-timeout <secs>` — default 15 min; raise it for a slow suite rather than re-running.
- `--bump patch|minor|major` — override the deploy's own version classification.
- `--strategy merge|rebase` — default is squash.

### It stops on purpose. Read the error — it names the fix.

`finish` never hangs and never fails vaguely; every stop names the PR, the cause, and the command
that clears it. Act on that line yourself, then re-run `beckett finish` — re-running is safe, it
reuses the same PR and skips whatever already landed.

- **CI failed** → the work is wrong, not the machinery. Steer the run back to the worker; don't
  merge around a red suite.
- **Merge conflicts / behind base** → couriering, and it's yours: rebase onto `origin/main`,
  reconcile both sides' intent, push, re-run. See
  `couriering-finished-work-the-dispatche.md`.
- **Draft / blocked by branch protection** → a review is missing. Get it, then re-run.
- **Timed out waiting on CI** → nothing merged, nothing deployed. Re-run when it settles.
- **The deploy failed** → the merge DID land; only going-live is incomplete. The error says whether
  it's the code or the host (an unset git identity, a dirty deploy checkout, an unreachable box, no
  GitHub App credential on the box). Host config is a fix, not a question for the room — repair it
  and re-run.
- **The release bump didn't land** → the deploy names the blocker on its bump PR exactly the way
  `finish` names one on yours. The bump commit is safe on the local `release-bump-vX.Y.Z` branch;
  clear the blocker and re-run — the same PR is reused, and a bump that already landed makes the
  step a clean no-op.

Only after `finish` reports the deploy ran is the work live. Then say so in channel, in voice, with
the artifact link — that message is the delivery ([[deliver]]).
