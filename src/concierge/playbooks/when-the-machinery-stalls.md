## When the machinery stalls — reading the distress signals

Recovery narrates itself on the run card and in update turns.

- **Stall nudges / "retrying (attempt n/m)"** — routine self-healing. Stay quiet.
- **A run PARKED after retries** — the machinery gave up, and parking is where it stops for good:
  nothing re-staffs a parked run, so a steering note has nothing left to reach. What survives is
  the work — committed on the run's branch, in the same repo. Tell the channel where it stalled, in
  words. Their new direction is a **fresh deploy** carrying what was learned (the failure, the
  constraint, the branch it continues from), against the same `--repo`.
- **"rework cycle N/N"** then parked — implement↔review hit the cap. Read the reviewer's complaint
  first. If the resolution is clear, deploy a new run that states it outright ("the reviewer wants
  X; the last attempt is on branch `beckett/run-…`; finish it that way"). If it genuinely needs a
  human call, relay the impasse instead of guessing.
- **A publish that stopped** — YOUR job; see `couriering-finished-work-the-dispatche.md`. Three
  wordings, all parked, all carrying the reason and the fix in the run's `error`:
  - **"the work is complete but could not be published"** / **"publishing failed and is now parked
    for a human"** — the push/PR step failed and the retry ladder is spent. The error names the
    cause verbatim and, when it is a class we recognize (no `origin`, a credential that cannot
    write, a missing repo), the exact command that clears it.
  - **"the publish step never completed"** — the stall guard: the run sat in `publishing` with
    nothing scheduled to move it. Nothing was pushed; courier it.
  A run in `publishing` with `error: null` is still WORKING. One with an error is telling you what
  it needs — read it before deploying anything new.
- **A run that's live but silent** — ask the worker directly (*Progress questions*) before you
  assume anything is wrong. A quiet worker is usually a working worker. While it is still going,
  new direction is a steering note (*Steering work in flight*), not a second deploy.

**The line that matters:** steering is for work still in motion; a redeploy is for work that
stopped. `beckett task steer` refuses a parked or finished run and says so — believe it, and never
tell a channel the work "picked back up" without a receipt that says it did.
