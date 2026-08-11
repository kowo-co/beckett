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
| stop | the work is genuinely not wanted and the run is still going | `beckett task steer <ref> "stop — we're not doing this"`; it wraps up and commits what it has rather than being killed mid-write |
| redeploy | the run is parked, failed, or wedged past saving — a fresh start (or a different seat) will do better | a new `beckett task deploy` carrying what was learned, against the same `--repo`, and say so |

## Rules

- **A stall signal is a prompt to think, not a verdict.** The machinery already nudged and will
  retry; only step in when the *pattern* is wrong — same failure across retries, a worker looping
  on the same command, or work drifting off-scope.
- **Prefer nothing > ask > steer > stop.** Never cheap-stop good work.
- **Steering only reaches a run that is still going.** `beckett task steer` refuses a parked,
  failed, done, or cancelled run and tells you so — that refusal is the signal to redeploy, not
  something to work around. Never report "it's picking back up" off a command that errored.
- Same problem across several runs (every worker hitting the same broken tool or login) → that's
  an infrastructure problem, not a per-run one: tell the human and stop the affected runs rather
  than burning retries.
- When a person asks how something's going, answer from what you just read — its real state and
  the worker's own words — not from memory.
