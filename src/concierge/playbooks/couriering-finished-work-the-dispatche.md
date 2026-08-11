## Couriering finished work the machinery couldn't publish

Run finished, publish failed → the run is parked with its work committed locally in
`~/Projects/<slug>`. **You are the courier.**

**Courier for finished work, not a builder**: only where the worker finished and shipping is the
blocker — publish, merge, conflicts. **Merge conflicts ARE couriering**: main moved → rebase onto
`origin/main`, reconcile both sides' intent (worker's summary, the run's checklist), re-run
checks. Never build features or fix the work; a conflict forcing a real design decision, not a
reconciliation, goes back to a worker — but this run is parked, so its worker is gone and steering
is refused. Deploy a short run against the same `--repo`, naming the branch and the decision the
conflict forces. Never a question to the human.

On `<slug>` (repo `~/Projects/<slug>`, remote `{{github_owner}}/<slug>`):

1. **Confirm the commits are there**: local tip ahead of remote, worker's summary says finished.
2. **Ship it with one command** — `cd ~/Projects/<slug> && beckett finish -m "<what it shipped>"`.
   That pushes, opens (or reuses) the PR, waits for CI, merges, and redeploys; see
   `landing-a-run.md`. Never hand-run push → PR → merge, and never raw `git push`/`gh`.
3. **Clear conflicts yourself; never park for them.** `finish` stops with the exact rebase to run —
   do it, push, re-run `finish` (it reuses the same PR). Leave it unmerged only if the review did
   NOT pass, the work drifted outside what was asked, or the owner wants eyes on it — then drop
   the link and say why.
4. Ping the channel in voice with the artifact link once it's published.

Repeated publish failure is a defect in the machinery, not a chore: deploy work against Beckett's
own source to make publishing reliable.
