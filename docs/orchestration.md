# Orchestration

This is the core v1 design contract — the document v1 is implemented from. It replaces the
bored-backed ticket queue, the 4,174-line dispatcher, the 585-line poller, and the nine sidecar
stores with a single Supervisor process, one SQLite file, and a Job tree executed as Claude
Agent SDK sessions. Process-level and module-level detail lives in [architecture.md](architecture.md);
the order of operations for getting from v0 to here is [migration.md](migration.md); the cost
rationale behind the casting and seat choices is [token-efficiency.md](token-efficiency.md); the
one path by which a Job is created without a human turn is [initiative.md](initiative.md).

## 0. The whole design in eight concepts

Everything below is built from exactly these. Nothing else is durable, nothing else has a name.

| Concept | What it is | What it absorbs (merged away) |
|---|---|---|
| **Job** | One row in one SQLite table: a node with `parent`, `deps[]`, a runner, a cast, a budget, a state. | ticket · task `#42.1` · stage · DAG node · review cycle · design gate · basm arm · workflow node · branch name · Discord card key |
| **Event** | One row in one append-only table `(job_id, kind, payload, cost_usd, tokens, ts)`. | spend.jsonl · dispatch.jsonl · journal · advance-outbox · publish-outbox · comment-cursors · poll-snapshot · dispatcher-state · pending-steer store |
| **Runner** | The *kind* of thing that executes a Job: `agent` \| `human` \| `shell`. A column, not a class hierarchy. | INT design-review park · parkForHuman · publish outbox · preflight probes |
| **Supervisor** | One long-lived Bun process under systemd as user `beckett`. Owns the DB, the scheduler, the preflight health cache, the trigger evaluator, and the Agent SDK sessions. | dispatcher (4,174 lines) · poller (585) · WorkerManager · staffing watchdog · shell/main wiring |
| **Wire** | The Discord adapter: gateway in, replies/cards out. Card edits are code, never model turns. | `src/discord/*` + concierge relay (mostly kept verbatim) |
| **Seats** | Two concierge seats sharing one `persona.md`: a **Haiku front desk** (reads, banters, routes) and a **Sonnet mind** (decides, files, steers). | concierge/index.ts (7,656 lines) · ambient triage on the expensive seat |
| **Trigger** | One row: a standing rule a human armed, which files a Job when its condition goes true. Three kinds — `schedule` · `watch` · `signal`. Full design in [initiative.md](initiative.md). | routine scheduler + its store, rate limiter, and humanized clock (`src/routine/`, 3,573) · the dream pass's bespoke budget (`src/dream/`, 1,663) |
| **Doctrine** | One Claude Code plugin in-repo: `agents/`, `skills/`, `hooks/`, one small in-process MCP server. | stages.ts prompt builders · casting presets · scope guard · persona |

Four ground rules follow from the concepts:

- **One durable store: `~/.beckett/beckett.db`** (SQLite, WAL, one writer). Tables: `job`,
  `event`, `kv` (thread-attach map, alias map), `health` (preflight cache), plus `trigger` and
  `trigger_fire` for initiative (§3.14). Nine sidecar stores become one file with real
  transactional and fsync discipline.
- **One identity rail.** A Job's id is a short opaque ref — `j7`, `j7.1`, `j7.1.2` (child =
  dotted suffix of parent). That same string is the git branch, the worktree dir, the session
  name, the Discord card key, and what a human types. No second public ref, no hidden `OPS-N`.
  The ~1,147 lines of `src/task/` that existed to hide the tracker from humans have nothing left
  to hide.
- **No serialization pretending to be a data model.** No fenced blocks, no regex over ticket
  descriptions. Work is created via a typed MCP tool (`job.create`, zod-validated, rejects on a
  bad cast instead of silently degrading to `{}`). Briefs are *rendered from* rows; never parsed
  back.
- **No compensators.** No poller means no `poke()`, no `observe()`, no `onAdvance`. Writes to
  `job` fire an in-process emitter; the scheduler is a function called on that emit and on boot.
  Dispatch latency is a function call, not a poll interval. **One deliberate exception, outside
  the dispatch path:** the trigger evaluator's 60-second tick, for conditions that are true
  *because* nothing was written (§3.14). It is one `setInterval` and one indexed query, it gates
  nothing but initiative, and it is named here rather than hidden.

## 1. Chosen shape — and the shapes we refused

v1 is **a single Bun Supervisor on `@anthropic-ai/claude-agent-sdk`, one SQLite store, all agent
work executed as SDK `query()` sessions in worktrees, fronted by the two-seat concierge.**

We deliberately reject the pure native-primitive shapes:

- **TaskList/TaskCreate as the board**: it is a *second* board with a *second* identity rail and
  session-scoped persistence under a session-derived path — exactly the duplication v0 died of.
- **`claude --bg` as the execution substrate**: its state files are undocumented and `--bg`
  sessions have no stdin, which makes them the weakest steering tier of any candidate design.
  It survives only as an attach-for-humans convenience, never in the correctness path.
- **The Workflow tool as orchestrator**: its runs die with the session, replay caching is
  within-session only (so "re-fired workflows skip completed phases" is false across a reboot),
  and it cannot hold a mid-run human gate. Job trees give the same shapes durably.

Everything load-bearing is GA: `query()`, streaming input, `resume`, `maxBudgetUsd`, in-process
hooks, `canUseTool`, worktrees, skills. **Zero preview-feature bets.** The ~90% code cut is
achieved by *deleting concepts*, not by outsourcing them to preview features.

## 2. The Job model

```sql
CREATE TABLE job (
  id           TEXT PRIMARY KEY,       -- 'j7', 'j7.1'  — THE identity rail
  parent       TEXT REFERENCES job(id),
  title        TEXT NOT NULL,
  intent       TEXT NOT NULL,          -- prose brief, verbatim, never parsed
  criteria     TEXT,                   -- JSON string[] (typed at the tool boundary)
  runner       TEXT NOT NULL,          -- agent | human | shell
  cast         TEXT NOT NULL,          -- JSON {harness, model, effort, skills[]}
  deps         TEXT NOT NULL DEFAULT '[]',
  join_policy  TEXT,                   -- null | 'all' | 'quorum:2' | 'first'
  repo         TEXT, target_branch TEXT,
  budget_usd   REAL,                   -- subtree ceiling
  origin       TEXT,                   -- discord channel/message id — where this reports
  origin_trigger TEXT REFERENCES trigger(id),  -- NULL = a human asked; else WHY this exists (§3.14)
  state        TEXT NOT NULL,          -- open | running | done | failed | cancelled
  hold         TEXT,                   -- NULL = schedulable; non-NULL = reason, zero tokens
  session_id   TEXT, worktree TEXT, wip_sha TEXT,
  result       TEXT,                   -- JSON structured output
  created_at INTEGER, updated_at INTEGER
);
```

**Five states, and they will never grow:** `open · running · done · failed · cancelled`.
"Ready" is derived (`open AND hold IS NULL AND deps satisfied per join_policy`). Everything
finer — parked, in_review, design_review, launch_refused, crashed — is a *job*, a `hold`
string, or an *event kind*, never a new enum value. Adding the INT gate to v0 cost a global
enum migration; here it costs one row with `runner='human'`.

**The outcome taxonomy lives in event kinds, distinct by construction.** A preflight refusal
writes `kind='never_ran'` and **no attempt ever exists** — no worktree, no spend row, no
quality data point. A spawn that dies with zero turns writes `kind='launch_failed'`. A process
death mid-run writes `kind='crashed'`. "Never attempted" vs "tried and failed" are different
rows the moment they happen — never a post-hoc `turns<=1` heuristic. This alone would have
removed 92 of v0's 216 pi implement runs (the 43% zero-tool-call provider-refusal class) from
the quality stats that made terra "read as a bad implementer".

**Flow shapes without enum surgery** — all are just rows:

- *sequence*: `j7.2.deps=['j7.1']`
- *fanout*: three children of `j7`, no deps between them
- *quorum/judge*: a judge child with `deps=[arms…]`, `join_policy='quorum:2'`; the scheduler
  marks it ready when satisfied and hands the arms' `result` JSON into the judge's rendered brief
- *human gate*: `runner='human'` — the Wire posts the ask; a Discord reply flips it `done`
- *bounded loop*: a review verdict of `rework` inserts a sibling implement job; the scheduler
  refuses the 4th sibling and sets `hold='rework cap'`
- *budget*: `budget_usd` on any node caps its whole subtree

`beckett plan` files a whole tree in one transaction. `basm` is deleted — its shapes (parallel
arms, quorum joins, bounded loops, budgets, human gates) are the default expressive power of
job rows, not a compiler.

**Durable flow-stage recording is free by construction.** Because each stage is a job row,
"last completed stage" is simply the set of `done` rows. A crash re-enters at the first
non-done job — never from scratch, with no workflow-replay dependency.

## 3. Mechanics

### 3.1 Intake → dispatch

Discord message → Wire → **front desk** (Haiku, warm, per-channel), which does three things and
nothing else: (a) classifies *directed / ambient / secret* — the deterministic
`messagePlausiblyAmends` predicate and the OTP-delete path stay byte-for-byte; (b) answers pure
chat in persona; (c) anything that smells like work or a decision: start the typing indicator,
hand the turn to the **mind** (Sonnet), stay silent. The mind's `job.create` MCP call (typed,
one round trip) → DB write → emitter → scheduler → preflight (<50ms when health-cached) →
`query()` spawn. No poll anywhere; dispatch begins in the same tick as the insert.

| Path | v0 | v1 | Mechanism |
|---|---|---|---|
| message → first visible token (chat) | 1–3s | **0.6–1.2s** | warm Haiku front desk |
| work request → ack sentence | 2–5s | **2–4s** | mind turn; the ack is a sentence, not a receipt |
| filed → dispatch decision | ≤5s poll | **same tick** | emitter → scheduler function call |
| filed → first worker token | ~10s | **1–3s** | preflight cache + worktree alloc + spawn |
| steer → in the worker's context | ~5s round trip | **next tool boundary** | SDK streaming stdin |
| worker milestone → card updated | one concierge turn | **<1s, zero tokens** | DB → Wire card edit as code |
| crash → work resumed | manual | **boot reconcile pass** | loss bounded to the 120s WIP window |

### 3.2 Mid-run steering

`job.say(id, text)` **writes the Event row first**, so "dropped" is unrepresentable by
construction. If the job is `running`, the Supervisor pushes a user turn into the live SDK
streaming input and confirms delivery via the echoed user-message frame within a bounded 30s
window — the `--replay-user-messages` ack pattern from today's proven driver, kept because
"delivered" must be mechanized, not asserted. Receipts collapse from v0's four-state taxonomy
to **two values**: `delivered` (echo confirmed) or `queued` (row exists; folded into the next
resumed brief). Undelivered steers are just Events with `delivered_at IS NULL` — they survive
restarts in the same file. A steer landing on `done` work gets an explicit too-late reply that
states what already happened: *"too late — it already pushed that commit. Revert or fix
forward?"* Never a bare "ok, updated."

### 3.3 Review / QA

A review job is an ordinary child: `runner='agent'`, cast sonnet/medium, dep on the implement
job, `--json-schema` verdict `{verdict: pass|rework, findings[]}`. Tier is a cast choice
(`self` = no review job filed; `fresh` = one filed), not a field with semantics. The diff is
passed in the rendered brief so review never re-reads the repo cold. Rework is bounded at 3 by
the scheduler. Review stays at today's shape and price on purpose — $1.44 median, 27.6% catch
rate — it earns its keep. **Fable never reviews** (1.7× sonnet's cost for half the catch rate).

### 3.4 Dependencies and branch basing

`deps[]` plus the derived-ready rule, with readiness recomputed from the DB (never daemon
memory alone) so the boot pass catches anything that completed while the Supervisor was down.
**Dependency-branch basing is kept as explicit code** (~200 lines in `worktree.ts`): a job with
deps branches from its last completed dep's branch head and merges the rest — never stale
`origin/main`. The OPS-59/61 stale-basing incident had nothing to do with the tracker
underneath it; the fix survives the tracker.

### 3.5 Resume after restart

Three durable facts, written in this order:

1. `session_id`, captured off the SDK `system/init` frame and **fsync'd before any other side
   effect**;
2. `cwd`, pinned to the exact worktree path at spawn and persisted on the row — resume is
   **cwd-sensitive**; resuming from a recomputed path silently starts fresh, a documented trap
   this closes by construction;
3. a WIP checkpoint commit every 120s (plus on the Stop hook); `wip_sha` on the row.

On boot the Supervisor takes every `running` row, ps-verifies it, and calls
`query({resume: session_id, cwd: worktree})` with a two-line resume brief plus any queued
steers. Resume failure → retry with backoff up to a cap, then `hold='unresumable, WIP at
<sha>'` — never a silent restart from scratch. The boot-resume path is exercised by every
deploy, so it cannot rot.

### 3.6 Session continuity

One spawn per task, not per stage. A cast-stable chain keeps **one session**: rework cycles
resume the original implement session by `session_id` — the model that wrote the code fixes
the code, with its context intact — instead of a cold re-brief. A **fresh session is spawned
only where fresh eyes are the point**: review, and any stage whose cast changes. The
cold-spawn tax is paid exactly where it buys catch rate.

### 3.7 Budgets and spend

`maxBudgetUsd` on every `query()` and `--max-turns` on every spawn — **enforced spawn-time
rails**, not post-hoc telemetry (v0's gap). Every result frame writes one Event with tokens
and cost; subtree rollup is one SQL sum. **Overrun is a conversational gate, not a kill**: the
job goes `hold='over budget at $X'` and Beckett asks in the origin channel — *"this is at $8,
past what I'd normally spend on it — keep going?"* A yes raises `budget_usd` and clears the
hold. Budget checks fail-open on ledger-read errors with a warning Event — a stuck budget gate
is its own outage.

### 3.8 Preflight by construction

A `health` table keyed `(harness, provider)`: `{status: healthy|cooldown_until|blocked,
reason}`. Fed two ways: (a) every classed failure event (`rate_limit|overloaded|auth|billing`)
writes a cooldown; (b) a cheap zero-spawn probe (whoami/model-list, not a session) at boot and
every 10 minutes for any harness in the active roster. The scheduler consults the cache
**before** allocating a worktree. Unhealthy with no substitute → the job stays `open` with
`hold='provider blocked: <exact login command>'` and an Event `kind='never_ran'` — zero tokens,
zero worktree, zero quality-stat pollution. This is the structural fix for the 92-run no-op
class: the refusal moves from "discovered after a full spawn cycle" to "known before one
starts."

**MRCR context-budget guard**: preflight estimates step context (repo profile + brief + diff);
past ~512K tokens, haiku/luna casts are **refused** and substituted to terra/sonnet with an
Event noting the substitution — recall is never silently degraded. (Terra's measured median
implement input is 1.46M tokens; it is the long-context cheap lane, haiku the short-context
cheap lane.)

### 3.9 Human gates

`runner='human'` rows are never spawned; they cost zero tokens parked and are restart-inert by
construction — the Supervisor has no code path that starts them. The Wire posts the ask as an
ordinary message in the origin channel ("design's up — good to build?"); a prose reply, a
thumbs-up reaction on the anchor, or a channel-level "yeah go ahead" (resolved against the
single oldest open gate) flips the row. **One nudge at 24h, then silence forever** — parked is
a legitimate resting state and the card just says so. **One exception, in the other direction:**
a gate Beckett raised on its own initiative expires (`cancelled`) at 48h, because the evidence
that justified the ask decays and a stack of week-old "should I?" cards is how a channel learns
to ignore Beckett — §3.14, per-trigger override `gate_ttl_h=0` for evidence that doesn't.

### 3.10 Cancel

`job.cancel(id)` marks the subtree `cancelled`, aborts live sessions, discards buffered steers
**with an explicit note** — and **keeps the branch**: worktrees are kept on cancel and pruned
after 7 days, so the receipt is *"stopped. the branch is still there with what it had — say
the word if you want it back."* The **hold-and-cancel pre-post staleness gate** (a 2–3s
re-check before any queued post lands after a cancel) ships in the Wire — ~60 lines, the
highest feel-per-line item on the floor.

### 3.11 Failure ladders

One policy table in the Supervisor, driven by classified result frames — no ladder code per
stage:

| Class | Ladder |
|---|---|
| stall (no stream frame in N min — event-driven `lastEventAt`, one SQL WHERE, no poll) | one steer → abort + resume-from-WIP → hold |
| identical stall fingerprint ≥2 (normalized tool/file evidence, classified by haiku) | hold for a human |
| rate_limit / overloaded | cooldown + retry ×3 (30s/2m/10m); writes the health cache |
| auth / billing | hold with the exact login command; health cache `blocked` |
| substantive failure ×2 on the same job | stop retrying and **ask** — *"failed the same way twice: the harness can't reach the db. Keep poking, or is this on your side?"* |
| harness substitution | next healthy harness from the fallback order, substitution cap 3 |

### 3.12 Publish gating

"Done means the link resolves" (OPS-30), enforced both ways: (a) a `runner='shell'` **verify
child** fetches the actual PR/URL and requires a 200 before the parent may go `done`; (b) the
crash window between "worktree has the diff" and "GitHub has it" is covered by the shell job's
own bounded retry policy (1m/5m/30m) — the publish-outbox *concept* disappears into the job
model; its courier *semantics* survive. Any live human touch on the job cancels retries into a
conversational hold. Campaign work funnels off `target_branch`, not main (OPS-185).

**Attach convenience**: `beckett attach j7` shells to `claude --resume <session_id>` —
observation for humans, GA-only, never in the correctness path.

### 3.13 Casting

Front-load judgment, execute cheap — the fix for the 31%-bounce / 2.2×-escalation tax:

| Class | Plan | Implement | Review |
|---|---|---|---|
| mechanical (rename, config, docs, dep bump) | — | **haiku** low (short-context only, per MRCR guard) | self |
| normal feature/bugfix | **opus** high, once, produces the job tree + criteria | **terra** (default cheap substantive lane) or sonnet medium | sonnet medium, fresh |
| long-context / large repo (>512K est.) | opus high | **terra** or sonnet (haiku/luna refused by the guard) | sonnet medium |
| correctness-critical (auth, money, migrations — declared, confirm-before-cast) | opus high | **fable** high | opus high |

- **Terra stays**: $1.12 median substantive cost at 14% failure vs opus-4.8's 18% at ~4× the
  price; $5.03 expected all-in vs $9.38. It runs as a second ~200-line driver behind the same
  Runner interface, **behind the preflight health cache** — #159's root cause (credential
  refusals) is fixed by construction, so the "43% no-op" framing that once justified amputating
  it is superseded. Claude is the default lane; terra is cast data, not a parallel subsystem.
- **Escalation happens at most once per job, and only after the plan stage validated the
  plan** — if the plan was wrong, re-plan (a new opus plan job) instead of throwing a bigger
  model at the same brief.
- **Haiku runs every non-code job**: classification, summarization, card text, publish-link
  checks, stall-fingerprint classification, and the entire front-desk seat.
- Casting is a small deterministic table plus presets consulted at file time — removed from
  the concierge's judgment entirely, which is what makes the Sonnet mind safe (next section).

### 3.14 Initiative — the one path to a Job with no human turn

Everything above starts with a human message. This is the exception, and it is the only one.
[initiative.md](initiative.md) is the full design; the orchestration-level contract is here,
and where the two disagree this section wins.

A **Trigger** (`t3` — the same identity-rail shape as `j7`) is a durable row: a kind
(`schedule` | `watch` | `signal`), a spec, a fixed cast, a per-fire budget, a cooldown, a daily
cap, a reporting channel, and a `posture` of `act` or `ask`. Two tables and one job column carry
it — no new job states, no new runner kind:

```sql
CREATE TABLE trigger      (id, name, kind, spec, posture, armed, armed_by, armed_job,
                           channel, cast, intent, budget_usd, cooldown_secs, max_per_day,
                           gate_ttl_h, veto_count, probe_errors, last_fired_at,
                           created_at, updated_at);
CREATE TABLE trigger_fire (trigger_id, fire_key, job_id, outcome, evidence, ts,
                           PRIMARY KEY (trigger_id, fire_key));   -- the idempotency guarantee
-- job.origin_trigger is the one new job column; it is already in §2's schema above.
```

**Who creates the job: the Supervisor, never a model.** A `watch` predicate is one indexed SQL
query over `job`/`event` or one registered shell probe (10s timeout, non-zero exit means false),
drawn from a fixed in-tree registry. A model neither writes predicates nor evaluates them, so a
tick on which nothing is true costs zero tokens and every firing is replayable from rows.

**Arming is a human gate, always.** The mind may *propose* a trigger (`trigger.propose`, typed
MCP, same zod boundary as `job.create`), which writes the row `armed=0` and files an ordinary
`runner='human'` job holding the proposal — zero tokens parked, restart-inert (§3.9). A 👍 or a
prose yes flips the gate and sets `armed=1` in the same transaction. `beckett initiative arm` is
the CLI equivalent; the owner at a terminal is the direct go. **A job may never arm a trigger** —
the `trigger.*` verbs are absent from an initiative job's toolset, which is what keeps a runaway
from being expressible.

**What state it starts in.** On a fire, one transaction writes the `trigger_fire` row and the
`job` row together — `state='open'`, `hold=NULL`, `origin_trigger='t3'`, `origin` = the trigger's
channel, cast and `budget_usd` copied off the trigger, `intent` rendered from the trigger template
plus the evidence. Because `(trigger_id, fire_key)` is a primary key, a duplicate fire fails the
transaction and **no job is created**: acting and recording that it acted are one write. With
`posture='ask'` the same transaction files a `runner='human'` gate as the parent and the work job
as a child with `deps=[gate]`, so nothing spawns until a human answers.

**Effective posture is computed from rows, never judged by a model.** `posture` is a ceiling; the
evaluator may only downgrade `act` → `ask` (confirm-before-cast cast, repo outside `owned_repos`,
fire budget over `act_without_asking_usd`, brief targeting a `deny_paths` entry) or refuse the
fire outright (latch off, not armed, cooldown or daily cap, initiative ledger exhausted, or any
job the predicate names sitting under a human-set `hold`). Refusals are rows too — `job_id IS
NULL`, `outcome='refused:<reason>'` — so "why didn't you" is a query.

**Admission, before preflight.** The scheduler admits an initiative job only when the
`max_workers` semaphore has a free slot *and* no human-originated job is ready and waiting;
`max_initiative_workers` defaults to 1. A blocked initiative job takes `hold='initiative:
<reason>'` at zero tokens rather than spawning and refunding. Unprompted work is strictly the
lowest priority in the system.

**Ceilings.** `cooldown_secs` (3600) and `max_per_day` (3) on the trigger row; `budget_usd` per
fire (2.00) becomes the job's subtree ceiling and rides the ordinary `maxBudgetUsd` spawn rail;
`initiative_daily_usd` (5.00) is one SQL sum over events joined to `origin_trigger IS NOT NULL`
in the last 24h. **The initiative budget check fails closed** — the deliberate inversion of
§3.7's fail-open rule, because a stuck gate on asked-for work is an outage and a stuck gate on
unprompted work is silence.

**How it reports.** An `act` fire posts one line in the trigger's channel naming the trigger and
the evidence — *"nobody asked — main's been red since 13:40, i'm on it"* — and opens the ordinary
self-editing card with an `unprompted · t3` marker. Everything after that is an ordinary job:
beats, review child, failure ladder, WIP checkpoints, boot resume, publish gating. Spend carries
`origin_trigger`, so `beckett spend --initiative` is a `WHERE` clause and unprompted cost can
never hide inside asked-for cost.

**How a human kills it.** `beckett job cancel j12` / *"stop"* / the card's **stop** button cancels the
job subtree exactly as §3.10 describes (branch kept, 7-day prune). `beckett initiative off t3`
disarms the rule and keeps the row so the history stays readable. `beckett initiative off` is the
hard kill: every trigger disarmed, every initiative job cancelled, and a **latch** in `kv` that
the evaluator checks first and that nothing but a human clears — not a restart, not a config
reload, not a job. Two human cancels of one trigger's jobs auto-disarm it (`veto_count`), because
the calibration doctrine's "wrong the same way twice is a defect" is worth a column rather than a
paragraph in a prompt.

**When it is evaluated.** On the same emitter that drives the scheduler (for `watch` predicates
whose subject a write touched), once on boot after the resume pass, and on a 60-second tick for
conditions that are true because *nothing* was written. That tick is the single named exception
to *no compensators* (§0) and it gates nothing but initiative.

## 4. The concierge cost attack: ~$2,090/mo → $250–400/mo

**Baseline mechanics:** ~$70/day ≈ ~2,150 turns/day on an Opus seat re-reading a ~160k warm
context (78% of tokens are cache reads). The bill is **turn volume × context size × model** —
attacked in that order of leverage. Idle-socket tricks save ~nothing: the seat only spends on
turns.

1. **Progress never passes through a model** — the #1 lever. Every worker milestone in v0
   became a concierge turn. In v1, job/event changes go DB → Wire → Discord card edit **as
   code**. Model turns happen only when a human speaks. Turn volume drops by roughly the
   milestone-to-human-message ratio: ~2,150 → **~250–350 turns/day**.
2. **Two seats** — the #2 lever; composes with #1. Of the remaining human-driven turns, ~70%
   are banter/questions/acks that decide nothing → the **Haiku front desk** (warm, per-channel,
   ≤~12k context: persona + a 40-line doctrine core + a short window). Decision turns route up
   to the **Sonnet mind**. The front desk is forbidden from anything requiring a decision;
   ambiguity routes up — a misroute costs one extra turn, never a wrong action.
3. **The mind carries no channel window.** Mind context = persona + doctrine core + board
   summary; channel history arrives only via a `channel.window(n)` tool when actually needed.
   Rotate at 60k (per-channel tunable, busy channels up to 120k); idle teardown to zero
   resident process — transcript on disk, cold resume pays one cache write, not a standing bill.
4. **Cache discipline bundle**: `--exclude-dynamic-system-prompt-sections`, a byte-stable
   system prefix so the cached prefix actually hits, doctrine as lazy skills (~905 tokens of
   frontmatter, not 4.6k inlined). **No heavy MCP on either seat** — only the tiny in-process
   `job.*`/`channel.window` toolset; jingle/gh/deploy/browser MCP is scoped to workers
   (OPS-43's tens-of-thousands-of-tokens landmine).
5. **Sonnet on the mind seat is safe because casting judgment left the seat**: casting is a
   deterministic table, hard planning is an opus *job*. The named Sonnet-swap risk (one
   fable-tier miscast erases ~11 days of savings) is removed structurally, not accepted.

**Dollar model:** front desk ~250–300 turns/day × ~$0.004 ≈ **$1–2/day**; mind ~80–120
turns/day on a ≤60k rotated context ≈ **$5–8/day**; plan/summarize work bills to the worker
ledger, not the seat. Total **$7–10/day ≈ $210–300/mo**, target band $250–400/mo to absorb
busy weeks. Measured, not assumed: spend Events run side-by-side against v0 for a week before
cutover, and the front-desk step must show the ~3× expensive-seat turn cut or it rolls back.

## 5. Every v0 must-survive behavior, accounted for

The v0 inventory's non-negotiable list, row by row, against where it lives in v1:

| v0 behavior | v1 home |
|---|---|
| Mid-run steering, never lost (#22) | Event-row-first `job.say`, echo-ack, two-value receipts (§Mid-run steering) |
| Progress to Discord, origin-routed | `origin` column + zero-token card edits in the Wire (§Intake, §Discord surface) |
| Review stage with tiers, bounded rework | review as a child job; tier as cast choice; cap 3 (§Review / QA) |
| Dependencies + dependency-branch basing (OPS-59/61) | `deps[]` + derived ready + explicit basing code (§Dependencies) |
| Resume after restart, never silently from scratch (#68, OPS-125) | session_id/cwd/wip_sha triple + boot reconcile (§Resume) |
| Spend caps + telemetry (#77) | `maxBudgetUsd` spawn-time rails + spend Events (§Budgets) |
| Human gates / park at zero tokens | `runner='human'` rows, restart-inert by construction (§Human gates) |
| Cancel/abort | subtree cancel + kept branch + staleness gate (§Cancel) |
| Bounded failure ladders | one policy table (§Failure ladders) |
| Publish gating (OPS-30, OPS-185) | verify shell child + bounded retries + `target_branch` funnel (§Publish gating) |
| Casting economics (#156/#159) | deterministic cast table, preflight, MRCR guard (§Casting, §Preflight) |
| Scheduled/proactive work (routines, humanized fire times, the 1/hr·3/24h post cap) | `trigger` rows, one evaluator, one ledger (§3.14, [initiative.md](initiative.md)) — the cadence and cap doctrine survives, the three separate clocks and stores do not |

## 6. Discord surface

Unchanged in feel — this *is* the product — simplified in fact. The full contract is
[discord.md](discord.md); the orchestration-relevant invariants are: the `-# filed j7` grey
subtext is stamped by code, never by the model, with refs validated `/^j\d+(\.\d+)*$/` and a
null-means-post-nothing contract; one self-editing card per top-level job driven straight
off `job`/`event` rows with no reconciler — the card reads the same rows the Supervisor acts
on, so "what actually happened" is never inferred; workers emit ≤1 beat per meaningful
milestone via an MCP call and **never speak in channel** — every human-visible sentence is
authored by the Seats sharing one `persona.md`; Beckett interrupts for exactly four things —
a gate, a failure it can't resolve, delivery, and work it started on its own (§3.14; an
unprompted start that isn't announced is indistinguishable from a rogue process, which is why
that fourth one is the least negotiable of the four). The only visible change from v0: the ref you see
is the ref that exists (`j7`, no `OPS-42`/`#42.1` shadow pair); a 30-day `kv` alias map keeps
old refs resolving, then drops. The ten-conversations checklist in discord.md is the release
gate for cutover.

## 7. Risk register

Preview-feature bets: **none taken.** Everything load-bearing is GA. Preview surfaces and
their GA paths, one line each:

| Preview/undocumented surface | Position | GA path in v1 |
|---|---|---|
| Discord Channels plugin (research preview, allowlisted) | not used | own `discord.js` gateway — GA, already hardened, already the product |
| `claude --bg` fleet + daemon state files (undocumented) | attach-only convenience | Supervisor-owned SDK sessions; `beckett attach` = `claude --resume <id>` |
| TaskList/TaskCreate board (session-scoped persistence) | not used | the `job` table is the board |
| Workflow tool / dynamic workflows (runs die with the session; no mid-run human input) | not used | job trees express the same shapes durably |
| Agent teams / SendMessage-across-sessions (experimental) | not used | streaming stdin into Supervisor-owned sessions |
| Cloud Routines (beta), session-scoped cron (7-day expiry) | not used, for liveness *or* for scheduled work | systemd `Restart=always` owns liveness; the Supervisor's own trigger evaluator owns cadence, so a fire time and its cooldown stay in the one store (§3.14) |

Operational risks:

| Risk | Mitigation |
|---|---|
| Single SQLite = single corruption point | WAL + one writer + append-only `event` (job table reconstructible) + nightly `VACUUM INTO` + `beckett doctor db` on boot |
| Supervisor is one process | systemd `Restart=always`; boot-resume exercised by every deploy; WIP commits bound loss to ≤120s |
| Two seats drift in voice | one `persona.md` loaded by both; front desk forbidden from decisions; fallback: collapse to one Sonnet seat (costs money, not feel) |
| Front desk misroutes work as chat | route-up default on ambiguity; a misroute costs one extra turn, never a wrong action |
| Sonnet mind degrades voice | voice is persona + skills; A/B one config value; casting judgment already removed from the seat |
| Terra driver = second harness surface | ~200 lines behind one interface, behind preflight; disable = one preset edit; claude is the default lane |
| Steer echo-ack never arrives | bounded 30s window → receipt honestly says `queued`; the row is already durable |
| Concurrency | one semaphore (`max_workers`, default 3) + per-repo serialization — far under native caps, no SDK-side limits to reason about |
| Mind context pressure | no channel window, no repo, no diffs on the seat; 60k rotation; sidecar-free rehydrate from board summary |
| SDK subscription-auth terms | personal use as documented; the API-key path is a config flip |
| A trigger re-fires on a still-true condition | `(trigger_id, fire_key)` PRIMARY KEY — the fire row and the job row are one transaction, so a duplicate is a failed insert, not a second job (§3.14) |
| Initiative spends with nobody watching | per-fire `budget_usd`, `cooldown_secs`, `max_per_day`, and a `$5/day` ledger ceiling that **fails closed**; `beckett spend --initiative` is its own line on the bill |
| Initiative starves asked-for work | admitted only behind every ready human-originated job; `max_initiative_workers=1` |
| Armed triggers accrete until nobody remembers them | `max_armed_triggers=8`; arming past it refuses and names the coldest; `beckett initiative list` shows last-fired plus hit/veto counts |
| A trigger keeps proposing something the owner doesn't want | two human cancels auto-disarm (`veto_count`); the calibration doctrine becomes a column |
| The trigger evaluator's 60s tick becomes the new poller | it gates only initiative, runs one indexed query, and is named in §0 as the single exception; the dispatch path stays emitter-driven and migration step 9 still certifies that |

## 8. Migration

The full order of operations is [migration.md](migration.md). The shape in one paragraph: land
the store beside v0 with no behavior change; port the pure Discord modules verbatim with their
tests (they are the feel and move first); prove `run/` on `beckett quick`; run the Supervisor
behind a flag with a week of dual-write against quantitative acceptance bars (outcome rates vs
the measured baselines, spend and latency Events side-by-side); then cut the ticket rails,
flip the identity rail to `jN` with the 30-day alias map, re-point Doctrine, and attack the
concierge cost in lever order — each lever measured, the front-desk cutover reverting if it
does not show its ~3× expensive-seat turn reduction. Initiative is armed **last**, one trigger
at a time, against its own three-conversation gate ([initiative.md](initiative.md)): unprompted
work on unproven machinery is the worst possible first customer.

## Appendix — rejected alternatives

- **TaskList as the board**: second board, second identity rail, session-scoped persistence
  under a session-derived path — the duplication v0 died of.
- **`--bg` fleet as execution substrate**: undocumented state files, no stdin → weakest
  steering tier; demoted to human-attach convenience.
- **Workflow tool as orchestrator**: runs die with the session, replay cache is within-session
  only, no mid-run human input — job trees do it durably.
- **Channels plugin as ingress**: research preview behind an allowlist flag; our own gateway is
  GA, hardened, and already the product.
- **SendMessage steering into `--bg` sessions**: no such path exists; not adopted in any form.
- **`steer.md` + hook-pair injection**: invented, untested mid-run mechanism; SDK streaming
  stdin is the real thing and v1 runs on it natively.
- **Single-harness amputation**: dropped terra on the superseded 43%-no-op framing; terra is
  the measured best value lane and stays behind preflight.
- **Opus on the mind seat**: casting judgment left the seat, so Sonnet suffices; opus is a
  plan job, not a chair.
- **Haiku on the voice/decision seat**: one fable-tier miscast erases ~11 days of savings;
  haiku fronts, never decides.
- **Killing the review gate**: $1.44 / 27.6% catch earns its keep; kept as-is.
- **Idle/socket-activation as the cost fix**: the seat spends only on turns; the lever is turn
  volume, not wall-clock uptime.
- **Rich Step state enum**: legibility bought with the exact enum-surgery wound v0 documents;
  the taxonomy moved to event kinds and `hold` strings.
- **Per-errand JSON sidecars**: no transactional/fsync discipline; one WAL file.
- **basm `.b` DSL**: its shapes are now the default expressive power of job rows; the compiler
  is deleted.
- **Agent teams / cloud Routines / session-scoped cron as liveness**: experimental, beta, or
  expiring; systemd owns liveness, and the Supervisor owns cadence (§3.14).
- **Slash commands + a button-heavy surface**: chat-only is the feel; two buttons max on a card.
- **`-# started` receipt wording**: technically truer now that dispatch is same-tick, but
  *filed* is the product's word; feel continuity beats semantic pedantry.
- **Separate publish-outbox subsystem**: the concept is absorbed by the verify shell job's
  bounded retry policy.
- **A single global brain session**: makes ingress, cost, and compaction one shared failure
  variable; per-channel Seats plus a Supervisor process bound every blast radius.
- **A heartbeat that thinks** (a model turn on a timer deciding what to do): a standing bill for
  a usually-empty result, and its decisions can't be diffed. Predicates are SQL or a registered
  probe; the fired/refused row is the point.
- **Model-authored predicates**: the store is the only thing that can refuse initiative, and a
  model that writes its own refusal criteria is not a gate.
- **Triggers as job rows** (`runner='timer'`): a Job completes, a trigger doesn't; one never-`done`
  row breaks the ready-rule, budget rollup, the card, and boot resume to save a table.
- **Triggers in `kv`**: serialization pretending to be a data model, one ground rule after the
  rule forbidding it.
- **systemd timers as the trigger clock**: fire time, cooldown, and dedupe key outside the one
  store — a tenth sidecar written in unit files. systemd owns liveness; the Supervisor owns
  scheduling.
- **A model-evaluated act-or-ask gate**: a permission check whose behavior varies with context
  length is not a permission check.
- **Jobs arming triggers**: the runaway case; enforced by absence from the toolset, not by a rule.
- **Inbound webhooks in v1**: deferred with a named path (HMAC behind the existing tunnel), not
  rejected — `signal` already covers every producer running on the box.
- **A separate initiative budget pool**: v0 had four accounting systems and couldn't say what a
  day cost; `origin_trigger` makes it a `WHERE` clause on the ledger that already exists.
