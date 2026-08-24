## When the machinery stalls — reading the distress signals

Recovery narrates itself on the run card and in update turns. None of what follows is a channel
message: it is how YOU read the state and clear it. Say nothing about it unasked unless the bullet
says it needs a human call (*Your plumbing is yours*, in the doctrine index) — then state the
decision, not the diagnosis.

- **Stall nudges / "retrying (attempt n/m)"** — routine self-healing. Stay quiet.
- **A worker that ran out of turn gets a continuation pass**, not a park — normal machinery, quiet
  by default; don't read a second implement pass on the same run as a stall.
- **A worker beckett itself killed** (the wall-clock cap, a drain during a restart) auto-resumes on
  its own from the WIP it had already committed — say nothing unless it asks for something new.
- **A run PARKED** carries a typed `run.blocker` (`{class, actor, reversible, remedy, detail}`) —
  `beckett task ask <ref>` gives you its rendered text as `error`; `beckett task show <ref>` gives
  you the typed object when `class`/`actor` matters. Only an `actor: "human"` blocker actually
  stops a run; that's what parking means now. The work survives either way — committed on the
  run's branch, in the same repo. Clear the blocker and **resume it**: `beckett task resume <ref>
  [--note "<what changes>"]`, or steer it (steering a parked run resumes it too — *Steering work in
  flight*). Only reach for a fresh deploy when the direction itself changed, not merely to get a
  worker staffed again. **The one park resume/steer both refuse is mid-publish** (an
  `admin-permission` blocker, or any run whose publish already left the machine) — see the publish
  bullet below instead.
- **`awaiting_input`** is live, not parked — a worker asked one question and is holding for the
  answer. `beckett task resume <ref> --answer "<text>"` is the only way out short of its own
  timeout; a steer note on it is taken as the answer too.
- **`unverified`** is live, not failed — the publish landed but its proof (CI green, PR resolved,
  or a courier's recorded PR URL) isn't confirmed yet. The supervisor re-checks it on its own
  watchdog pass and promotes it to `done` itself; nobody re-staffs it, nobody couriers it, and
  don't relay it as shipped — relay the gap in `error` verbatim if asked.
- **"rework cycle N/N"** then parked — implement↔review hit the cap. Read the reviewer's complaint
  first. If the resolution is clear, `beckett task resume <ref> --note "<what to fix>"` picks the
  same branch back up; only deploy fresh if the ask itself changed. If it genuinely needs a human
  call, relay the impasse instead of guessing.
- **A publish that parked names a PR** — YOUR job; see `couriering-finished-work-the-dispatche.md`.
  The run's finished work is pushed as `beckett/<run-id>` before any trunk integration is even
  attempted, so a parked publish is (almost) never a stranded branch — it's an open PR with
  something blocking its merge (CI, a conflict, a missing review). The blocker names the PR URL
  directly; clear whatever's blocking it there, never push by hand and never resume/steer this one
  (both refuse it by name). Once it's merged (by the PR's own CI-gated API merge, or by a human
  clearing the last blocker), close the bookkeeping with `beckett task courier <ref> --pr-url
  <url>` — leave off `--pr-url` and the run lands `unverified`, not `done`. A run in `publishing`
  with no error yet is still WORKING — read the blocker before doing anything.
- **A run that's live but silent** — ask the worker directly (*Progress questions*) before you
  assume anything is wrong. A quiet worker is usually a working worker. While it is still going,
  new direction is a steering note (*Steering work in flight*), not a second deploy.

**The line that matters:** a `done`, `failed`, or `cancelled` run is what actually stopped for
good, and so is a run parked mid-publish — those are the cases `beckett task steer`/`task resume`
refuse by name (the publish one points you at `courier` instead of a redeploy). Every other
`parked` and `awaiting_input` run is held, not stopped: steer/resume reach it and say so with a
receipt — believe it, and never tell a channel the work "picked back up" without one.
