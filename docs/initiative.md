# Initiative

Every path in the rest of this set is reactive: a human types, the Wire catches it, a Seat decides,
a Job runs. That is a complete description of a very good contractor and an incomplete description
of a colleague. A colleague notices that main has been red since lunch. This doc is the design for
the noticing — what wakes Beckett when nobody typed, what it may start on its own, what stops it
starting the same thing forty times, and how a human sees the decision and kills it.

It is deliberately the most conservative document in the set, because unprompted work is the only
thing Beckett does with nobody watching. See [orchestration.md](orchestration.md) for the Job/Event
model this files into — where this doc and that one disagree, that one wins — and
[discord.md](discord.md) for the surface an unprompted start appears on.

## The gap, and why it is v0's gap too

v0 had proactivity three times over, in three mechanisms that knew nothing about each other or
about the board:

| v0 machinery | LOC | What it could do | What it could not |
|---|---:|---|---|
| `src/routine/` + its capability module | 3,573 | Wall-clock cadence with humanized fire times, a `watch` action that polled a feed, a hard 1/hour + 3/24h post cap, per-routine enable read live each tick | File work. A routine posted; it never dispatched a ticket. Its schedule, seen-set, and rate limit lived in three files the dispatcher never read |
| `src/dream/` | 1,663 | A nightly budgeted replay that could propose memories and run exactly one overnight spike in a throwaway worktree, branch-only, never merged | Land anything, by construction and on purpose. Its budget, its ledger, and its spike walls were bespoke — a fourth accounting system |
| ambient interjection (`concierge/ambient.ts` + `playbooks/ambient-turns.md`) | — | Speak unprompted into a conversation it was already reading, gated by a classifier and burst caps | *Act.* The playbook's own rule is "offer, don't commit — no task on an ambient turn" |

So v0 could talk unprompted, dream unprompted, and post unprompted, and could not **work**
unprompted — and the three mechanisms had three clocks, three stores, and three budgets. The v1
design as written before this doc had none of the three: grep the set and "ambient" appears only in
[discord.md](discord.md), where it means interjecting into a conversation Beckett is already
reading. [market-research.md](market-research.md) files OpenClaw's "heartbeat/cron proactivity as
the emotional core" under what to steal and then nothing steals it. This doc is the theft, with the
part OpenClaw does not have: a store that can refuse.

## What initiative is, and what it is not

Two different products get called proactivity and only one of them is here.

| | Ambient interjection (exists, [discord.md](discord.md)) | Initiative (this doc) |
|---|---|---|
| Trigger | A human message Beckett happened to read | The clock, a store predicate, or a local signal |
| Output | One sentence in channel | A Job — a branch, a worktree, a spend row |
| Gate | A classifier, then burst caps as a backstop | Rows in the store; no model in the decision |
| Cost of a quiet day | One classifier turn per candidate burst | **Zero tokens.** A predicate that is false costs one indexed query |
| Off switch | the per-channel ambient posture (`off \| suggest \| auto`, carried from v0) | `beckett initiative off` — global, and latched |

They compose in exactly one direction: an ambient turn may **offer** ("want me to look at that?")
and the offer's acceptance is an ordinary human turn that files ordinary work. An ambient turn still
may not file. Initiative is the only door through which work starts without a human turn, and there
is exactly one of it.

That last claim is structural, not a rule anyone has to follow. [token-efficiency.md](token-efficiency.md)'s
first lever — *model turns happen only when a human speaks* — means there is no seat turn in which a
model could invent work. The mind cannot file unprompted work because the mind is not running. Any
future change that gives a Seat a standing loop reopens this door, and reviewers should treat such a
change as a change to this document.

## Trigger: the eighth concept

[orchestration.md](orchestration.md) §0 said seven concepts and nothing else is durable. This doc
is why it now says eight, and an addition to that list should be argued rather than assumed:

**A trigger is a standing rule that files Jobs.** It is durable, it has a lifecycle no existing
concept models (armed → cooling down → fired-and-recorded → vetoed), and it fires many times while a
Job completes once. The alternatives were each worse:

- **A `kv` blob.** `kv` is for small maps. A trigger has a cast, a budget, a cooldown, a cap, and a
  veto count — putting that in a JSON value is *serialization pretending to be a data model*, the
  exact sin [architecture.md](architecture.md) forbids two paragraphs after it defines `kv`.
- **A Job row with `runner='timer'`.** A Job is a unit of work that reaches `done`. A trigger never
  does. A never-`done` Job breaks the ready-rule, the subtree budget rollup, the card, and the boot
  resume pass all at once, to save one table.
- **A systemd timer per trigger.** This is what [architecture.md](architecture.md) previously
  implied, and it is wrong now for one reason: the fire time, the cooldown, and the dedupe key would
  live outside the one store — a tenth sidecar, written in unit files. systemd owns **liveness**;
  the Supervisor owns **scheduling**. That line is unchanged from the rest of the design; only its
  application to initiative is new.

The eighth concept costs two tables and one job column, and adds **zero job states** and **zero
runner kinds** — the five still never grow.

## Trigger sources: three kinds, and the ones v1 refuses

| Kind | Fires on | Evaluated by | v1 example |
|---|---|---|---|
| `schedule` | A wall-clock cadence with a humanized fuzz window — 08:07, never 08:00 (v0's issue-#62 timing doctrine, carried) | The Supervisor's 60s tick, against the period's rolled fire time | "every weekday morning, summarize what's open and what's stuck" |
| `watch` | A predicate over the store going true | One indexed SQL query over `job`/`event`, **or** one registered shell probe with a 10s timeout (non-zero exit means false) | "a running job has emitted no event in 6 hours"; "CI is red on the default branch" |
| `signal` | A local producer calling `beckett signal <name>` | Nothing — the write *is* the event | A `systemd` unit's `OnFailure=`, the deploy script's failure path, the browser lane on an expired login |

**A standing instruction a human gave once is not a fourth kind.** "Tell me every morning what's
red" is a `schedule` trigger; "if a deploy fails, fix it" is a `signal` trigger. The instruction is
how a trigger gets *armed* (below), not a separate mechanism — otherwise the standing instruction
lives in a prompt, and a prompt has no cooldown.

The predicate registry ships seven entries, all in the tree, all code:

| Predicate | Shape | True when |
|---|---|---|
| `job_stuck(h)` | SQL | a `running` job's newest event is older than `h` hours |
| `job_failed_twice` | SQL | one job has two `substantive_failure` events |
| `gate_cold(d)` | SQL | a `runner='human'` gate has been open more than `d` days past its one nudge |
| `budget_burn(pct)` | SQL | a subtree's spend has passed `pct` of its `budget_usd` while still `running` |
| `ci_red` | probe | `gh run list` on the default branch reports a failing newest run |
| `pr_stale(d)` | probe | an open PR authored by Beckett has had no review for `d` days |
| `disk_low(pct)` | probe | the filesystem holding `~/.beckett` is above `pct` |

Adding an eighth is a code change and a PR, deliberately: a predicate is the one place in this
design where a typo becomes a standing commitment.

**What v1 refuses, and why:**

| Refused | Why | The path back, if we're wrong |
|---|---|---|
| A model that decides when to wake up ("idle reflection", a heartbeat that thinks) | It is a standing bill for a usually-empty result, and its decisions are unreplayable — you cannot diff why it fired on Tuesday and not Wednesday | A `runner='agent'` evaluator job on a haiku cast, capped at one fire/day, with its own ledger line. Never the default lane |
| Model-authored predicates (an LLM writing the SQL) | The store is the only thing that can refuse initiative; a model that writes the refusal criteria is not a gate | Nothing. This one does not come back |
| Inbound webhooks | An inbound HTTP port on the owner's desktop is new attack surface for a capability `signal` already covers from every local producer ([omarchy.md](omarchy.md)'s posture on listeners) | HMAC-verified `POST /signal/<name>` behind the Cloudflare tunnel that already exists. Deferred, not rejected — a bet that local producers are enough |
| A job arming a trigger | The runaway case. One trigger that files a job that arms two triggers is a fork bomb with a spend rate | Nothing. Enforced by absence: `trigger.*` verbs are not in an initiative job's toolset |
| `src/dream/`-style overnight generative work | Its walls were right and its output was evidence, not work; reviving it is a separate decision with a separate budget, not a trigger kind | One `schedule` trigger filing one ordinary job, on the ordinary ledger, if it is ever worth it |

## Arming: a human, every time

**A trigger is armed by a human and by nothing else.** This falls out of the doctrine rather than
adding to it: `concierge.md`'s Volition section licenses announce-and-do for what is *reversible*,
and a standing rule is by definition not a one-shot reversible act — it is a commitment with an
unbounded tail, and every future fire it authorizes is spending. Arming therefore fails the same
reversibility test that already puts money and admin behind a direct go; it is those items applied,
not a fifth one added.

Mechanically it reuses the human gate, unchanged. A human says "check every morning whether main is
red"; the mind calls `trigger.propose` (typed MCP, zod-validated, same boundary as `job.create`),
which writes the trigger row with `armed=0` and files a `runner='human'` job holding the proposal.
The Wire posts the ask with the whole rule rendered in one message — cadence, predicate, cast,
per-fire budget, daily cap, channel. A 👍 or a prose yes flips the gate `done` and sets `armed=1`
in the same transaction. Zero tokens are spent between the proposal and the answer, and the gate is
restart-inert, because it is an ordinary `runner='human'` row ([orchestration.md](orchestration.md)
§3.9).

`beckett initiative arm` does the same thing from the CLI without the gate — the owner at a terminal
*is* the direct go. There is no third path.

**`max_armed_triggers` defaults to 8.** The failure mode of standing rules is accretion, not
runaway: nobody notices the tenth one. Past the cap, arming refuses and names the coldest trigger
by last-fired date so the reply is "disarm t2 first," not "no."

## The act-or-ask gate: rows, not judgment

The ticket behind this doc asked whether the gate is something a model evaluates each time or
something the store enforces. **It is the store.** A gate a model evaluates is a gate that fails
differently every time it fails, and the one thing this design cannot afford is a permission check
whose behavior is a function of context length.

Each trigger carries a `posture` — `act` or `ask` — and that is a **ceiling**, not a decision. The
Supervisor computes the effective posture at fire time from rows only:

| Checked at fire time (SQL, no model) | Effect |
|---|---|
| `kv['initiative.latch']` is off | refuse; nothing is filed, nothing is posted |
| `armed = 0` | refuse, `outcome='refused:disarmed'` |
| a `trigger_fire` row with this `fire_key` exists | refuse — this is the UNIQUE constraint firing, not a check (§Idempotency) |
| `last_fired_at` within `cooldown_secs`, or `max_per_day` fires in the last 24h | refuse, `outcome='refused:rate'` |
| initiative spend in the last 24h ≥ `initiative_daily_usd` | refuse, `outcome='refused:budget'` |
| any job the predicate names carries a human-set `hold` | refuse, `outcome='refused:hold'` |
| the cast is on the confirm-before-cast list (fable, correctness-critical) | **downgrade** `act` → `ask` |
| the target repo is not in `owned_repos` | **downgrade** `act` → `ask` |
| this fire's `budget_usd` > `act_without_asking_usd` (default `$1.00`) | **downgrade** `act` → `ask` |
| the rendered brief targets a path in `deny_paths` | **downgrade** `act` → `ask` |
| otherwise | `act` |

Downgrades only ever go one way. There is no rule anywhere that turns an `ask` into an `act`.

The two allowlists default to the narrowest thing that is still useful: **`owned_repos` defaults to
this repo and nothing else**, and **`deny_paths` defaults to `~/.beckett/persona.md`,
`~/.beckett/config.toml`, and the doctrine plugin directory** — the three files that decide who
Beckett is and what it may do. Widening either is a config edit an owner makes deliberately; both
are empty-means-narrowest, never empty-means-anything, because an unset allowlist that permits
everything is the failure mode allowlists exist to prevent.

**How much of the concierge doctrine survives as design.** Volition's four direct-go items each
become a row or an absence, not a sentence a model has to remember:

| Volition direct-go item | v1 mechanism | Lives in |
|---|---|---|
| spending money | `act_without_asking_usd` downgrade; `maxBudgetUsd` as a spawn-time rail | trigger row + spawn |
| account or repo admin | `owned_repos` downgrade; the scope guard denies `gh` admin verbs | config + `canUseTool` |
| acting **as** the person | an initiative job's toolset has no send-as surface at all — not denied, absent | `canUseTool` |
| anything under an explicit hold | the fire is refused outright before a job exists | evaluator SQL |

What stays prose, correctly: *announce and do* — the posture a job takes **inside** a scope the
store already bounded. Tone is the right thing to write in a prompt. Whether unprompted work starts
is not.

## Idempotency: a fire is a claim, not a decision

The failure mode that kills proactive agents is re-firing on a condition that is still true. The fix
is a constraint, not a check:

**A predicate does not return true or false. It returns a set of `fire_key` strings, possibly
empty.** For each key, the Supervisor opens one transaction and writes the `trigger_fire` row and
the `job` row together. `(trigger_id, fire_key)` is the primary key, so a duplicate insert fails the
transaction and **no job is created** — "acted" and "recorded that I acted" cannot diverge, because
they are the same write.

| Kind | `fire_key` | So a repeat looks like |
|---|---|---|
| `schedule` | the *period*, not the instant — `daily:2026-08-09` | A restart inside the fuzz window cannot double-fire, even though the humanized minute is re-rolled |
| `watch` (SQL) | `<predicate>:<subject>:<bucket>` — `job_stuck:j7:6h` | A job stuck for nine hours fires once at the 6h bucket, again at 12h if that bucket is armed, never once a minute |
| `watch` (probe) | a hash of the probe's identifying output — `ci_red:<commit-sha>` | Red main fires once per bad commit, not once per tick |
| `signal` | the caller's `--key`, defaulting to a hash of the payload | A `systemd` unit that restart-loops sends the same key and fires once |

A seen-set is not a substitute for a cooldown and a cooldown is not a substitute for a seen-set —
v0's `watch` action carried both, and both are carried here. The cooldown bounds a *misbehaving
predicate*; the fire key bounds a *correct predicate on a persistent condition*. Only one of those
is a bug, and only one of them is common.

Refusals are rows too: a refused fire writes `trigger_fire` with `job_id IS NULL` and
`outcome='refused:<reason>'`. This is what makes "why didn't you" answerable, and it is the row that
tells you a predicate has been screaming into a cooldown for a week.

## Budget and rate limits

Unprompted work spends money with nobody watching, so the ceilings are concrete and they live in
rows, not in a prompt.

| Ceiling | Default | Where it lives | What trips |
|---|---|---|---|
| `cooldown_secs` | 3600 | `trigger` row | the fire is refused, `refused:rate` |
| `max_per_day` | 3 | `trigger` row | same — carried straight from v0's watch cap (1/hour, 3/24h), which was right |
| `budget_usd` per fire | 2.00 | `trigger` row → the filed job's `budget_usd` | the ordinary subtree budget hold and conversational overrun ask ([orchestration.md](orchestration.md) §3.7) |
| `act_without_asking_usd` | 1.00 | config | `act` downgrades to `ask` |
| `initiative_daily_usd` | 5.00 | config, summed by one query over events joined to `origin_trigger IS NOT NULL` in 24h | every trigger refuses; one line in the owner's channel, once, never repeated that day |
| `max_initiative_workers` | 1 | config | admission holds the job at zero tokens |
| `max_armed_triggers` | 8 | config | arming refuses and names the coldest trigger |

**Initiative never contends with asked-for work.** The scheduler admits an initiative job only when
the `max_workers` semaphore has a free slot *and* no human-originated job is ready and waiting. It
is strictly the lowest priority in the system and capped at one concurrent job. A held initiative
job costs nothing; a delayed one costs nothing. There is no case where noticing that main is red
slows down the thing someone asked for.

**Budget checks fail *closed* here, and that is the inversion.** [orchestration.md](orchestration.md)
§3.7 makes the ordinary budget gate fail-open on a ledger-read error, because a stuck gate that
blocks all work is its own outage. For initiative the reasoning flips exactly: a stuck gate on
unprompted work produces silence, and silence is the safe failure. If the ledger cannot be read, no
trigger fires and one warning Event is written.

**The hard kill.** `beckett initiative off` sets `armed=0` on every trigger, cancels every running
job with `origin_trigger IS NOT NULL` (ordinary subtree cancel — branches survive the 7-day prune
window), and writes a **latch** into `kv`. The latch is checked before anything else in the
evaluator and nothing clears it except a human: not a restart, not a config reload, not a job.
`beckett initiative off <t3>` does the same for one trigger. In Discord, any phrasing of "stop doing
that on your own" routes to the same verb, the way `beckett proactivity off` already does in v0.

## The store delta

Two new tables and one new column, against [orchestration.md](orchestration.md) §2's schema. No new
job states, no new runner kinds.

```sql
CREATE TABLE trigger (
  id            TEXT PRIMARY KEY,      -- 't3' — same identity-rail shape as jN; what a human types
  name          TEXT NOT NULL,         -- 'ci red on main' — what a human reads on a card
  kind          TEXT NOT NULL,         -- schedule | watch | signal
  spec          TEXT NOT NULL,         -- JSON, kind-shaped, zod-validated at the arm boundary
  posture       TEXT NOT NULL,         -- act | ask  — a CEILING; the evaluator may only downgrade
  armed         INTEGER NOT NULL DEFAULT 0,   -- 0 until a human gate flips it; never set by a job
  armed_by      TEXT,                  -- discord user id, or 'cli:<user>'
  armed_job     TEXT REFERENCES job(id),      -- the runner='human' gate row that authorized it
  channel       TEXT NOT NULL,         -- where fires report; same shape as job.origin
  cast          TEXT NOT NULL,         -- JSON {harness, model, effort, skills[]} — fixed at arm time
  intent        TEXT NOT NULL,         -- brief template; rendered with evidence, never parsed back
  budget_usd    REAL NOT NULL,         -- per fire → the filed job's budget_usd
  cooldown_secs INTEGER NOT NULL DEFAULT 3600,
  max_per_day   INTEGER NOT NULL DEFAULT 3,
  gate_ttl_h    INTEGER NOT NULL DEFAULT 48,  -- 0 = never expire; ask-gates only (§Lifecycle)
  veto_count    INTEGER NOT NULL DEFAULT 0,   -- 2 = auto-disarm (§Vetoes)
  probe_errors  INTEGER NOT NULL DEFAULT 0,   -- 3 consecutive = auto-disarm; reset on any clean probe
  last_fired_at INTEGER,
  created_at INTEGER, updated_at INTEGER
);

CREATE TABLE trigger_fire (
  trigger_id  TEXT NOT NULL REFERENCES trigger(id),
  fire_key    TEXT NOT NULL,           -- the dedup identity; see §Idempotency
  job_id      TEXT REFERENCES job(id), -- NULL = evaluated and refused; the refusal is still a row
  outcome     TEXT NOT NULL,           -- filed | asked | refused:rate|budget|hold|latch|disarmed
  evidence    TEXT,                    -- JSON: the predicate's rows or the probe's output, verbatim
  ts          INTEGER NOT NULL,
  PRIMARY KEY (trigger_id, fire_key)   -- THE idempotency guarantee; not an index, a constraint
);

-- The one new job column, shown here as the delta against the pre-initiative schema.
-- orchestration.md §2's job DDL is the canonical one and already carries it.
ALTER TABLE job ADD COLUMN origin_trigger TEXT REFERENCES trigger(id);  -- NULL = a human asked
CREATE INDEX job_by_trigger ON job(origin_trigger) WHERE origin_trigger IS NOT NULL;
```

Three notes on the shape, because each was a real choice:

- **`origin` and `origin_trigger` are different questions.** `origin` is *where this reports*;
  `origin_trigger` is *why this exists*. A job filed by `t3` has both.
- **`origin_trigger` is inherited at file time, not walked.** Every child of an initiative job
  copies it. That is denormalization on purpose: the concurrency cap and the daily ledger are each
  one indexed `WHERE`, never a recursive CTE up the parent chain, and both run on every fire.
- **A fire is not just an Event, and Event is still the only ledger.** The idempotency guarantee
  needs a UNIQUE constraint, and the `event` table must never be able to refuse a write — a ledger
  that rejects rows is worse than one with duplicates. So `trigger_fire` is the *claim* table
  (small, prunable at 90 days) and `event` records everything forever, as it already does.

New event kinds — kinds, never states: `trigger_armed`, `trigger_fired`, `trigger_refused`,
`trigger_disarmed`, `trigger_vetoed`, `initiative_budget_exhausted`.

## The evaluator, and the one tick

The Supervisor evaluates triggers on three occasions:

1. **On the same emitter that already drives the scheduler** — a write to `job` or `event`
   re-evaluates only the `watch` predicates whose subject that write touched. Same tick, no poll.
2. **On boot**, once, after the resume pass, so a condition that became true while the process was
   down is seen exactly once (the fire key makes "exactly once" true rather than aspirational).
3. **On a 60-second tick** — the one clock in the design, and it does two things: it fires any
   `schedule` trigger whose rolled fire time for the current period has passed, and it re-evaluates
   the `watch` predicates that are true *because of* the clock. `job_stuck` becomes true precisely
   when nothing is being written, so there is no emitter to hang it off. (v0's watch loop ticked at
   the same 60s for the same reason; a trigger polling less often than the tick is its own business,
   never more often.)

That third one is a poll, and this design has spent nine paragraphs elsewhere deleting polls, so it
gets named rather than hidden. The defense: v0's 585-line poller sat in the **dispatch** path, where
5 seconds of latency was a product defect and three compensators (`poke`/`observe`/`onAdvance`) grew
to claw it back. This tick gates nothing but initiative, whose latency budget is minutes; it is one
`setInterval`, one indexed query, and a `SELECT` that returns nothing costs no tokens and no
worktree. It is the single exception to *no compensators*, and it exists because there is no such
thing as an event that fires when something stops happening.

## Lifecycle of an initiative-originated job, end to end

**`act`** — the trigger fires. One transaction writes the `trigger_fire` row and one `job` row:
`state='open'`, `hold=NULL`, `origin_trigger='t3'`, `origin=<trigger.channel>`, cast and
`budget_usd` copied from the trigger, `intent` rendered from the trigger's template plus the
evidence JSON. The emitter fires; the scheduler applies the initiative admission rules *before*
preflight — latch, concurrency cap, daily ledger — and any failure sets `hold='initiative: <reason>'`
at zero tokens rather than spawning and refunding. Past admission it is an ordinary job in every
respect: preflight, worktree, `maxBudgetUsd`, review child, failure ladder, WIP checkpoints, boot
resume. The Wire posts **one line** in the trigger's channel naming the trigger and the evidence —
*"nobody asked — main's been red since 13:40, i'm on it"* — and opens the ordinary card with an
`unprompted · t3` marker in its header.

**`ask`** — the same transaction files two rows instead of one: a `runner='human'` gate job as the
parent, and the work job as its child with `deps=[gate]`. Nothing spawns. The Wire posts the ask
with the evidence in it, because an ask without the evidence is just a chore. A 👍 or a prose yes
flips the gate and the child becomes ready on the same tick.

**Initiative gates expire; human-originated gates do not.** [discord.md](discord.md)'s rule — one
nudge at 24h, then silence forever, parked is a legitimate resting state — is right for a gate a
human is waiting on. It is wrong here: the evidence that justified the ask decays, and a stack of
week-old "should I?" cards is how a channel learns to ignore Beckett. An initiative gate is
`cancelled` at `gate_ttl_h` (48h by default) — an ordinary subtree cancel, plus a
`trigger_refused` event noting the expiry — and no further message. Per-trigger override for
evidence that genuinely doesn't decay (`pr_stale` is still true next week): `gate_ttl_h = 0` means
never expire, and the gate parks like any other.

**Reporting** is the ordinary card, plus two differences: the header carries the trigger ref, and
spend is tagged, so `beckett spend --initiative` is a real column and unprompted cost can never hide
inside asked-for cost on the weekly bill.

**Killing it** is two verbs, because there are two things to kill:

| What | Verb | Effect |
|---|---|---|
| this job | `beckett job cancel j12`, or *"stop"* in channel, or the card's **stop** button | Ordinary subtree cancel: sessions abort, buffered steers are discarded with a note, the branch survives 7 days |
| the rule that spawned it | `beckett initiative off t3` | `armed=0`, `trigger_disarmed` event; the row stays so the history is still readable |
| all of it | `beckett initiative off` | Latched: every trigger disarmed, every initiative job cancelled, nothing re-arms without a human |

## Audit: "why did you do that"

[discord.md](discord.md)'s ninth acceptance conversation already requires answering from Event rows
rather than a plausible reconstruction. Initiative raises the stakes, because the answer to "why did
you do that" is no longer "you asked me to." `beckett why j12` — and the same question in channel,
answered by the mind off the same rows — prints:

| Field | Read from |
|---|---|
| the trigger, by ref and name | `job.origin_trigger` → `trigger` |
| the rule, rendered in the words it was armed with | `trigger.spec` + `trigger.intent` |
| who armed it, when, and the message that did | `trigger.armed_by`, `armed_job` → that gate job's `origin` |
| what was actually true at fire time | `trigger_fire.evidence` — the predicate's rows or the probe's stdout, verbatim |
| the effective posture and any downgrade applied | `trigger_fire.outcome` + the `trigger_fired` event payload |
| what it has cost, this fire and today | `event` sum over the subtree; the 24h initiative ledger |
| every time it *didn't* fire, and why | `trigger_fire` rows with `job_id IS NULL` |

That last row is the one that earns the table. A proactive agent's worst failure is not acting
wrongly; it is acting wrongly in a way that leaves no record of the alternative. Refusals being rows
means "it's been trying to fire every hour for a week and the cooldown has been eating it" is a
query, not a hunch.

## Vetoes move the bar, mechanically

`concierge.md`'s calibration doctrine says a veto is data and being wrong the same way twice is a
defect. In v0 that was prose asking a model to remember. Here it is a column: **cancelling two of a
trigger's jobs auto-disarms it** (`veto_count`, incremented on a human cancel of an initiative job,
never on a failure or a budget hold), with one line in the channel naming the trigger and inviting
the correction. A `trigger_vetoed` event carries the cancelled job so the reason is recoverable.

The inverse is recorded too, because a ledger of nothing but vetoes trains timidity: a fire whose
job reaches `done` and gets merged decrements nothing but writes the same event kind with the
outcome flipped, and `beckett initiative list` shows both counts per trigger. A trigger with 9 hits
and 0 vetoes is one to widen; a trigger at 1-and-1 is one to talk about.

## Every mechanic, its failure mode, its off switch

| Mechanic | Failure mode it has | Off switch |
|---|---|---|
| `schedule` trigger | fires into a channel nobody reads | `beckett initiative off t3` |
| `watch` SQL predicate | a wrong predicate fires forever on a permanent condition | the `fire_key` bucket bounds it; `cooldown_secs` bounds the bug; disarm |
| `watch` probe | a hung `gh` call stalls the tick | 10s timeout, non-zero exit means false; three consecutive probe errors disarm with an event |
| `signal` | a restart-looping unit spams the same signal | the caller's idempotency key collapses it to one fire; `cooldown_secs` catches the rest |
| act-or-ask evaluator | a downgrade rule is missing for a new capability | `posture='ask'` on the trigger; and the evaluator is not the only wall — admin and send-as-a-person are toolset absences in `canUseTool`, and money is a spawn-time `maxBudgetUsd` rail |
| per-fire budget | one fire runs away | `maxBudgetUsd` spawn rail, then the conversational overrun hold |
| daily ledger | many small fires add up | `initiative_daily_usd`, fail-closed |
| concurrency | initiative starves asked-for work | `max_initiative_workers=1` and strictly lowest priority |
| accretion | ten armed triggers nobody remembers | `max_armed_triggers=8`; `beckett initiative list` shows last-fired and hit/veto counts |
| the whole idea | it is annoying in a way no single knob fixes | `beckett initiative off` — latched, human-only to clear |

## Before the first trigger is armed

Initiative lands **after** cutover ([migration.md](migration.md) build order), and its own gate is
three observed conversations, not a demo:

1. **A quiet week costs nothing.** Seven days with triggers armed and no condition true shows zero
   model tokens attributable to initiative in the Event ledger — not "approximately zero."
2. **A true condition fires once.** A job left stuck for a day produces exactly one job, one card,
   one channel line, and a `trigger_fire` row per bucket — verified against the rows, not the
   transcript.
3. **The kill is total and it sticks.** `beckett initiative off` mid-fire cancels the job, keeps the
   branch, and survives a Supervisor restart with the latch intact.

## The bets

| Bet | If it's wrong |
|---|---|
| **Predicates are code, never a model.** The store can refuse; a model asked to refuse itself cannot | Add a `runner='agent'` evaluator job on a haiku cast, capped at one fire/day with its own ledger line — a model that answers one yes/no about the store, never the default lane |
| **The Supervisor owns the clock**, systemd owns only liveness | A `systemd --user` timer calling `beckett initiative tick`. Cheap to switch, because the fire key makes the evaluator idempotent no matter who calls it |
| **Humans arm, always** | A per-channel `self_arm` posture, off by default, that lets the mind arm a trigger at `posture='ask'` only — it could then propose on a schedule but never act |
| **48h expiry on initiative gates** | `gate_ttl_h` is already per-trigger; set it to 0 for evidence that doesn't decay |
| **$5/day and one concurrent job is enough to be useful** | Both are config values read against the same ledger query; raising them changes no code. If the *shape* is wrong — if useful initiative needs a fleet — that is a different document |

## Rejected alternatives

- **A heartbeat that thinks.** A model turn on a timer, deciding what to do. It is a standing bill
  for a usually-empty result and its decisions cannot be diffed; the fired/refused row is the whole
  point.
- **Triggers as job rows** (`runner='timer'`). A Job completes; a trigger doesn't. One never-`done`
  row breaks the ready-rule, budget rollup, the card, and boot resume to save a table.
- **Triggers in `kv`.** Serialization pretending to be a data model, one page after the doc that
  forbids it.
- **systemd timers as the trigger clock.** Fire time, cooldown, and dedupe key outside the one
  store — a tenth sidecar, written in unit files.
- **A model-evaluated act-or-ask gate.** A permission check whose behavior varies with context
  length is not a permission check.
- **Jobs arming triggers.** The fork bomb. Enforced by absence from the toolset, not by a rule.
- **Inbound webhooks in v1.** Deferred with a named path (HMAC behind the existing tunnel), not
  rejected — `signal` covers every producer that already runs on the box.
- **Ambient interjection as the initiative surface.** Speaking and acting are different products
  with different failure modes; conflating them means the classifier that decides whether a joke
  lands also decides whether a branch gets cut.
- **Reviving `src/dream/` as a trigger kind.** Its walls were right and its output was deliberately
  evidence rather than work. If it comes back it is one `schedule` trigger filing one ordinary job
  on the ordinary ledger, not 1,663 lines of bespoke budget and spike machinery.
- **A separate initiative budget pool with its own ledger.** v0 had four accounting systems and
  could not answer what a day cost. `origin_trigger` on the job row makes "what did initiative
  spend" a `WHERE` clause on the ledger that already exists.
