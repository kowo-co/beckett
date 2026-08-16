---
name: resume
description: Use when someone asks to continue / pick up / check on earlier work ("can we keep going on X?", "what happened to that thing?"), or after a restart. Check what's actually in flight BEFORE deploying anything new.
---

# resume

Work lives in the run ledger and in each run's own project repo (`~/Projects/<slug>`), so it
survives restarts. When someone refers to *prior* work — "can we continue the X thing?", "did that
ever finish?", "pick up where we left off" — don't immediately deploy something fresh. First look
at what's already there.

## The reflex

1. **`beckett task list`** — everything in flight and everything recent. Match what they're asking
   about by title, repo, or recency.
2. **`beckett task ask <run-id|slug>`** — the run's state, its checklist progress, its journal
   tail, and (if it's live) the address to ask the worker directly.

Then reason about what you found:

- **Live (implementing / reviewing)** — it's actively staffed, and a restart resumes interrupted
  sessions automatically. Ask the worker where it's at and relay that; steer it with
  `beckett task steer <ref> "…"` if the person has new direction.
- **`awaiting_input`** — also live, not stopped: a worker asked one question and is holding for
  it. Answer with `beckett task resume <ref> --answer "<text>"` rather than treating it as dead
  work or redeploying around it.
- **Parked** — held with a typed `run.blocker`. `beckett task ask <ref>` gives you its rendered
  text as `error`; `beckett task show <ref>` gives you the typed object (`class`/`actor`) when
  that matters. Most parks aren't gone for good: `beckett task resume <ref> [--note "<steer>"]`
  clears the blocker and re-staffs the stage it parked from, and `beckett task steer <ref> "…"` on
  a parked run does the same (steering outranks waiting). The work itself is safe — committed on
  the run's branch in the same repo. Only reach for a fresh `deploy` when the direction genuinely
  changed, not just to get a worker back on it. **A run parked mid-publish is the exception** — an
  `admin-permission` blocker, or any run whose publish already left the machine — resume and steer
  both refuse it by name; the fix is clearing whatever's blocking its PR, then
  `beckett task courier <ref> [--pr-url <url>]`, never a redeploy or a hand push.
- **`unverified`** — also live, not failed: the publish landed but its proof (CI green, PR
  resolved, or a courier's recorded PR URL) hasn't confirmed yet. The supervisor re-checks it on
  its own and promotes it to `done`; don't re-staff it, don't courier it, don't relay it as
  shipped.
- **Done** — point them at the artifact link. If they want changes, that's NEW work: deploy
  against the same `--repo` slug so it builds in the same repo. Note that courier without a PR URL
  lands a run `unverified`, not `done` — a "done" run really did get its proof confirmed.
- **Nothing relevant** — genuinely new work; deploy it normally ([[intake]]).

## If beckett itself is on hold

`beckett status` shows a `paused:` line when someone has taken the chat-only hold. If it's there,
say so honestly in one line — you're paused, the reason if one was given — and don't deploy
anything until it lifts. Only the person it's appropriate to trust runs `beckett resume`; don't
lift someone else's hold on a whim.

## Why this matters

The honest answer to "can we continue X?" is almost never "sure!" followed by starting over. It's
"let me check" → find the actual run and repo → continue *that*. Work in the same repo shares one
checkout, so committed progress is never lost — reuse it instead of duplicating it. When in doubt,
look before you deploy.
