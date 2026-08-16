---
name: supervise
description: Use when a run reports trouble — a stalled worker, a retry, a repeated failure, or a human asking "what's happening with that build?". Read the run's real state and pick the lightest sufficient intervention.
---

# supervise

Something in flight needs your judgment. The machinery already handles the routine ladder
automatically (a quiet worker gets a status-check nudge, then an abort+retry from its committed
WIP; failed implements retry a bounded number of times; exhausted runs are parked). Your job
starts where the automation stops: deciding whether the *approach* is wrong, telling the person
honestly what's going on, and using your levers when a different path is needed.

## Look first

1. `beckett task ask <run-id|slug>` — the one call: state, `spec.md` checklist progress, journal
   tail, and the worker's session name. If the run is live, ask the worker itself (see the
   `progress-questions` playbook) — it knows things no record does.
2. `beckett task list` — everything in flight at a glance when the question is "what's running?"
3. `beckett status` — the live daemon in one JSON blob: every worker (run, stage, harness, pid,
   elapsed, last-event age), supervisor health, your own session stats. The fastest answer to "is
   anything actually moving?"
4. `beckett journal <run-id> --tail 200` — the private per-run play-by-play if you need finer
   grain. Nothing streams to Discord; summarize it, never paste raw journal lines back.

## Your levers (all real commands)

| Lever | When | How |
|---|---|---|
| do nothing | the automation is mid-ladder (nudge/retry already in progress) and the approach is sound | — |
| ask | you don't actually know what it's doing yet | `beckett task ask <ref>`, then `SendMessage` to its session name |
| steer | the run is still going and the worker is on the wrong thing, or you know something it doesn't | `beckett task steer <ref> "<guidance>"` — prints `delivered` (nudged the live worker) or `buffered` (waiting for its next stage) |
| resume | the run is `parked` and the blocker is cleared, or a parked worker just needs its WIP re-staffed | `beckett task resume <ref> [--note "<steer>"]` — re-staffs the stage it parked from; `beckett task steer <ref> "<note>"` on a parked run does the same thing (steering outranks waiting). A run parked mid-publish refuses both and names `beckett task courier <ref>` instead |
| answer | the run is `awaiting_input` — a worker asked one question and is holding for it | `beckett task resume <ref> --answer "<text>"` — the only way out short of its own timeout |
| stop | the work is genuinely not wanted and the run is still going | `beckett task steer <ref> "stop — we're not doing this"`; it wraps up and commits what it has rather than being killed mid-write |
| redeploy | a `done`, `failed`, or `cancelled` run needs a genuinely different direction | a new `beckett task deploy` carrying what was learned, against the same `--repo`, and say so |

## Reading the state — `run.blocker` and the live-but-held states

A parked run carries a typed `run.blocker` (`{class, actor, reversible, remedy, detail}`), not
free text. `beckett task ask <ref>` gives you its rendered text as `error` ("<what happened>" plus
"To clear this: <remedy>"); `beckett task show <ref>` gives you the typed object itself when you
need `class`/`actor` directly. **Only an `actor: "human"` blocker actually stops a run**; that is
the whole point of the type. States that read like a stall but are not:

- **`awaiting_input`** is LIVE, not parked — a worker asked one question and the supervisor owns
  getting it an answer. Read the question, answer with `beckett task resume <ref> --answer
  "<text>"`; don't treat it as a park, and don't redeploy around it.
- **`unverified`** is LIVE, not failed — the publish landed (PR merged or a courier recorded a
  PR URL) but its proof isn't confirmed yet (CI still finishing, or the PR record not yet
  resolved). The supervisor re-checks it on its own watchdog pass and promotes it to `done` itself
  — nobody re-staffs it, nobody couriers it, and don't relay it as shipped. Relay the gap in
  `error` verbatim if asked.
- **A continuation pass** (a worker that ran out of turn and got handed straight back to the same
  stage) is normal machinery, not a second implement worker gone rogue — don't flag it as a stall.
- **A self-inflicted death** (the wall-clock cap, a drain during a restart) auto-resumes from the
  worker's own committed WIP on its own; don't refile it as a fresh run. You may see a "wrap up"
  steer land first as it nears its cap — also expected.

## Rules

- **A stall signal is a prompt to think, not a verdict.** The machinery already nudged and will
  retry; only step in when the *pattern* is wrong — same failure across retries, a worker looping
  on the same command, or work drifting off-scope.
- **Prefer nothing > ask > steer > resume/answer > stop.** Never cheap-stop good work, and never
  redeploy fresh when `resume` would pick the same WIP back up more cheaply.
- **Steering and resuming reach almost any run that can still move.** `beckett task steer`/`task
  resume` refuse a `done`, `failed`, or `cancelled` run and say so by name — that refusal is the
  signal to redeploy. They also refuse a run parked mid-publish (an `admin-permission` blocker, or
  any run whose publish already left the machine) — that one's remedy is the PR, not a resume; see
  below. Every other `parked` or `awaiting_input` run resumes on steer. Never report "it's picking
  back up" off a command that errored.
- **A publish failure names a PR, not a stranded branch.** The work is already pushed; the remedy
  is clearing the blocker on that PR (CI, conflicts, review), never resume or a hand push. Once a
  human merges it by hand, close the bookkeeping with `beckett task courier <ref> --pr-url <url>` —
  without `--pr-url` the run lands `unverified`, not `done`.
- Same problem across several runs (every worker hitting the same broken tool or login) → that's
  an infrastructure problem, not a per-run one: tell the human and stop the affected runs rather
  than burning retries.
- When a person asks how something's going, answer from what you just read — its real state and
  the worker's own words — not from memory.
