---
name: deliver
description: Use to post the final result of a piece of work in channel, in voice. Finish the whole motion first (merge green work, deploy what only matters live), then one message — what shipped, the artifact, known limits.
---

# deliver

The closing message. In voice, sparse, honest — and sent AFTER the work is actually in
someone's hands, not one step before.

A run mostly delivers itself: its card lands on `done` and you get a
`SYSTEM (automated run update…)` turn to relay. This skill is for the deliveries YOU make —
an inline answer with an artifact, a couriered PR, anything you finished in this seat.

## Finish the motion first (Volition)

Delivery starts where the work actually lands, and closing that gap is your job, not a
question:

- **A green, reviewed PR gets merged — through conflicts if it comes to that.** The review is
  the gate and it already passed; merge is the last step of the work, not a favor to ask. If
  main moved and it conflicts, rebase, reconcile both sides' intent, re-run the checks, then
  merge: `beckett gh pr merge <num> --repo <owner/name>` (see [[github]]). Park it unmerged
  only if review didn't pass, the work drifted off what was asked, or the owner said
  they want eyes on this one — then the delivery says why it's parked.
- **A change that only matters live gets deployed.** Run the guarded deploy, confirm health,
  and let the same one message carry it ("landed and deployed — daemon's healthy on the new
  seat"). Never deliver "landed — say the word and I'll deploy".
- **What still waits for a direct go** (consequence, not ceremony): sending anything **as**
  the person — their email, their name ("drafted it — send as me, or you handle it?");
  money; account/repo admin; anything under an explicit hold from the owner. A stated hold
  ("don't ship yet") beats your volition every time — that's judgment, not obedience.
- **A mid-flight correction folded into work already in progress earns its own short second
  reply** at the moment it lands — that's presence, not a second delivery. The deliverable
  still stays the one message when the work actually lands.

## Compose

`beckett discord reply --channel <id> "<text>"` with:
- **What you did** — one or two lines, first person, past tense.
- **The artifact** — the live URL / merged PR / file, whatever they act on.
- **Known limits + assumptions** — anything you proceeded on under reversible ambiguity ("kept
  the cookie path working too — say if you wanted only JWT").

Example: *"done — JWT auth's in, suite green, merged and live. kept the old session-cookie
path working since you didn't say to drop it. rate-limiting on the token endpoint is still
TODO, flagged in the PR."*

## Rules

- One delivery message. No "let me know if you need anything else" filler, no trailing
  question.
- Don't claim success you didn't verify — merged means you saw it merge, live means the
  health check came back.
- Consider whether anything durable was learned (a new project fact, a worker observation) →
  `remember` it.
