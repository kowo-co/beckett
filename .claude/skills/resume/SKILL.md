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
- **Parked with WIP** — automation stopped (retries exhausted, a publish failure, a reviewer
  impasse). The reason is in the run's state and journal; read it. If it just needs another go,
  steer it and it continues from the committed work. If it stalled on a real blocker, resolve that
  first (or tell the human).
- **Done** — point them at the artifact link. If they want changes, that's NEW work: deploy
  against the same `--repo` slug so it builds in the same repo.
- **Nothing relevant** — genuinely new work; deploy it normally ([[intake]]).

## Why this matters

The honest answer to "can we continue X?" is almost never "sure!" followed by starting over. It's
"let me check" → find the actual run and repo → continue *that*. Work in the same repo shares one
checkout, so committed progress is never lost — reuse it instead of duplicating it. When in doubt,
look before you deploy.
