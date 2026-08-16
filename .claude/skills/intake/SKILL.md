---
name: intake
description: Use the moment a new @beckett mention arrives, before any work. Classify the request, size the effort (inline answer / quick errand / deploy a run), and for work requests post the fast ack FIRST.
---

# intake

Turn a fresh mention into (1) an effort judgment and (2) the right first move. For work
requests, the first move is an ack — a *receipt, not a promise* — sent before you spend the
turn working.

## Steps

1. **Read the stamp.** Every turn arrives as `[channel:<id>] [user:<id> address:"…" msg:<id>]`.
   The `channel:` id is what you ack to and what you pass as `--channel`; `address:` is what to
   call them; different `user:` ids are different people.
2. **Classify** the message: `task` (do something), `question` (answer something), `chatter`
   (banter), or `fyi` (no action wanted).
3. **Size it** (doctrine: *Dynamic effort*): answer inline · dispatch a QUICK AGENT (the errand
   lane — see the `quick` skill) · deploy a run. A 30-second inline scout (Read the
   obviously-relevant files, `recall` the people/projects named) is fine if it changes the call.
   The quick lane is for errands: a small one-off script (`quick-code`), a repo summarized
   (`repo-explorer`). Anything touching a live website goes to the BACKGROUND browser agent
   (`beckett browser` — see the `browser` skill), which returns instantly and reports back
   later. Real work — reviewable, multi-file, building on a project repo — is a run.
4. **Move:**
   - `question`/`chatter` → just reply; your turn text auto-sends. Do NOT run
     `beckett discord reply` — that double-posts.
   - errand → ack first (same as a work request — quick runs take minutes), then
     `beckett quick <agent> "<task>" --channel <id>`, then relay the report with a second
     `beckett discord reply` (your CLI ack claimed this turn's reply, so plain turn text
     won't post). If it answers "detached", the ack already covers it — end the turn; the
     result comes back to you as an update turn.
   - `task` → **ack FIRST**: `beckett discord reply --channel <id> "<one honest line>"` before any
     recall or deploying, so they hear from you in seconds. Then ONE
     `beckett task deploy --prompt "<their ask, faithfully>" --channel <id> --repo <slug>` and end
     the turn with no further message — the ack was your one reply, and the run card plus the done
     ping carry the rest. If a `[mid-flow: …]` line shows up while you're still working, fold it
     into the prompt (or steer the run if it's already out) and send the wrap-up `discord reply`
     now, not a second deploy — run `task deploy` / `task steer` as separate Bash calls, never
     chained with `&&`/`;`, so a mid-flow correction has a boundary to land on.
   - Honest ack phrasing: deploying queues the work and a worker picks it up within seconds — say
     "on it — queuing the JWT swap now", not "the tests are running", which isn't true yet.
   - **No plumbing in the ack.** Never a run id, a branch name, or a `-#` line — the machinery
     posts the run card and keeps it current. Twelve things deployed is still one ack.
5. If there's **irreversible/consequential ambiguity**, ask the ONE clarify question instead of
   acking a direction you might have wrong. Don't deploy a vague prompt — a bad brief wastes a
   worker.

## On hold

`beckett status` shows a `paused:` line when someone has taken the chat-only hold. A `task`
request that arrives while it's up gets a one-line honest answer — you're paused, the reason if
one was given — and no deploy; `beckett resume` is the only way it lifts, and that's not your
call to make on someone else's behalf.

## Rules

- Receipt, not a promise: don't over-claim scope or timing.
- No filler ("let me think about that"). If it's big, say the read ("this touches auth + the
  client + migrations — sending it as one ultracode build") and deploy it.
- One ack. Further messages only when something changed or you need input.
