---
name: self-improve
description: Use when you want to change yourself — your voice/persona, your memory, a skill, your doctrine, or your own code. Persona and memory apply live; repo-owned changes (skills, doctrine, code) go through a run against your own source, then a deploy.
---

# self-improve

You are not frozen. When you notice a recurring friction, get feedback on how you should behave,
or find a better way to work — change yourself. But respect the split between what's *yours to
edit live* and what's *repo-owned*.

## The two paths

| Part of you | Where it lives | How to change it |
|---|---|---|
| **Persona** (voice, vibe, who you are) | `~/.beckett/persona.md` (runtime dir, not the repo) | edit the file → `beckett reload` — live in seconds |
| **Memory** (durable facts) | the memory graph | `beckett memory remember …` — no reload needed |
| **Skills** (playbooks like this one) | `.claude/skills/…` in the beckett repo | `beckett task deploy` with no `--repo` (my own source) |
| **Doctrine** (`concierge.md` — how you work) | the beckett repo | same — a run against my own source |
| **Your own code** (daemon, CLI, drivers) | the beckett repo | same — a run against my own source |

**`beckett reload`** re-spawns your brain with `--resume`, so you keep this whole conversation but
come back with the edited persona in effect. Seconds, seamless. Use it freely for voice changes.

## Why repo-owned changes go through a run

The checkout you run from (`~/beckett`) is the **deploy checkout** — it only ever moves by
fast-forwarding to `origin/main`, and a deploy REFUSES a dirty tree. Editing it by hand doesn't
make the change live (the running daemon loaded its code at boot) — it just wedges every future
deploy. The real path: a run with no `--repo` builds in my own checkout on a branch, then
**one `beckett finish -m "<what it shipped>"` from that checkout** takes it the rest of the
way — PR, CI, merge to main, and the guarded deploy that refuses dirty trees, typechecks, and
health-checks itself. Don't hand-run the PR/merge/deploy steps. A landed self-change that only
matters live is yours to ship, not something to park until someone says "go" (Volition; the one
exception is an explicit hold from the owner). The review gate is what earns that license:
your self-modifications get the same scrutiny as any other code — which is exactly what changes
to your own brain deserve.

## The loop

1. **Make the change small and specific.** One persona tweak, one skill, one doctrine line. Big
   rewrites of yourself are how you get worse without noticing.
2. **Apply** — `beckett reload` for persona; a run against my own source for anything repo-owned,
   then `beckett finish -m "…"` to land and deploy it.
3. **Verify** you actually improved. A persona change that made you worse: edit back and reload
   (the runtime dir isn't versioned, so keep the old wording in the run's prompt or summary if you
   might want it back). A repo change: `git revert` via another run.

## When to do it

- Jason (or anyone) tells you how you should sound → fold it into your persona now, via reload.
- You keep hitting the same friction, or a skill/doctrine line is wrong → deploy the fix against
  my own source so future-you doesn't hit it again.
- You learned a durable fact about a person/project/repo → `remember` it ([[remember]]).

Bias toward evolving your **persona** (cheap, live) and **memory** for facts. Be deliberate with
skills/doctrine/code — they're versioned, reviewed, and deployed for a reason.
