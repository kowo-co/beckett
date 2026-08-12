# Token efficiency

Beckett v0 tracked spend meticulously and still overspent, because measurement isn't the same
thing as design. `~/.beckett/spend.jsonl` could tell you a ticket cost $12.38 after the fact; it
couldn't stop the Concierge from idling at $70/day, couldn't tell a doomed `pi` launch from a real
one before burning the spawn, and couldn't stop a ticket from bouncing to a heavy model because
nobody planned before executing. v1 treats economics as a structural constraint, not a dashboard:
every waste source below is closed **by construction** — a property of the [Job/Event
model](architecture.md) and the [Supervisor](orchestration.md), not a policy someone has to
remember to enforce. This doc is the numbers: the measured v0 baseline, the ranked waste, the
casting ladder that replaces it, and the concrete v1 targets.

All dollar figures below are as measured or as stated in source; nothing here is invented. Where a
number is an estimate (a rate table entry, a config-driven default), it's marked as such.

## The v0 baseline, measured

> **v7 (2026-08):** the per-unit numbers below were measured on v0's tickets; one ticket then is
> one **run** now (`beckett task deploy`), so the ratios carry over unchanged and the concierge's
> casting doctrine cites them per run.

**Sample:** 773 runs, 207 tickets, 2026-07-11 → 2026-07-31 (20 days), **$2,574** total spend from
`~/.beckett/spend.jsonl`. 599 runs on the `beckett` project itself.

### Model rates (live, 2026-07-30, post price cut)

| Model | Harness | Input $/Mtok | Output $/Mtok | Cache read | Cache write |
|---|---|---:|---:|---:|---:|
| gpt-5.6-luna | `pi` | $0.20 | $1.20 | $0.02 | $0.25 |
| gpt-5.6-terra | `pi` | $2.00 | $12.00 | $0.20 | $2.50 |
| gpt-5.6-sol | `pi` (blocked on account tier) | $5.00 | $30.00 | $0.50 | $6.25 |
| claude-sonnet-5 | `claude` | $3.00 ($2.00 intro, expires 2026-08-31) | $15.00 ($10.00 intro) | $0.30 | $6.00 ($4.00 intro) |
| claude-opus-5 | `claude` | $5.00 | $25.00 | $0.50 | $10.00 |
| claude-fable-5 | `claude` | $10.00 | $50.00 | $1.00 | $20.00 |

Cache reads price at 0.1× input; cache writes at **2× input** for every Claude model. That is the
1-hour-TTL rate, and it is the one that applies: Claude Code writes 1-hour caches, so no Claude
traffic Beckett generates bills at the 5-minute 1.25× rate. `config/model-rates.json` carried 1.25×
until 2026-08-12 and therefore under-counted every Claude cost figure the daemon reported; a
least-squares fit of `ccusage`'s own per-day, per-model costs against the table recovers exactly
2.000× for every Claude model in the archive (haiku 4.5 $1→$2, opus 4.8 $5→$10, opus 5 $5→$10,
sonnet 5 at its intro $2→$4), reconciling the archive total to **0.24%** — against **−11%** at
1.25×. The table is now 2×, [pinned by a test](../src/telemetry/model-rates.test.ts).

Only the telemetry harvest prices from this table; `beckett spend` sums the `total_cost_usd` each
harness reports for itself, so the ledger was never wrong. The committed `data/telemetry-runs.json`
snapshot is stamped with the rate table it was priced under (`2026-07-16`) and still carries the
old numbers — `bun run telemetry:refresh` re-harvests and reprices it against the current table.
Re-pricing that same archive at 2× moves its total from **$1,101 to $1,694**.

`config/model-rates.json` is still dated 2026-07-16, predates this price cut, and marks every
Claude row plus the generic `gpt-5.6` SKU as `estimate: true`; only terra and luna have confirmed
operational rates. It also prices `claude-sonnet-5` at the $3/$15 list rate while `ccusage` (and
the bill) still apply the $2/$10 intro rate through 2026-08-31, so sonnet lines read ~50% high
until that intro expires. A rate table that silently miscounts isn't a rounding error, it's a blind
spot; v1's [telemetry](#the-event-ledger--single-source-of-spend-and-telemetry) has to close it
before it can be trusted to gate anything.

### All-in cost per ticket (implement + review + retries), by primary implement model

| Model | Tickets | Median | Mean | p90 | Attempts | Landed |
|---|---:|---:|---:|---:|---:|---:|
| claude-opus-4-8 | 103 | $10.26 | $12.38 | $23.25 | 2.33 | 98% |
| gpt-5.6-terra | 57 | $5.35 | $8.14 | $16.50 | 2.09 | 98% |
| claude-fable-5 | 21 | $18.72 | $18.93 | $36.44 | 1.19 | 100% |
| claude-opus-5 | 18 | $16.30 | $21.12 | $36.23 | 2.06 | 83% |
| claude-sonnet-5 | 8 | $4.69 | $7.11 | $16.40 | 1.62 | 75% |

Pure single-model casts (no escalation) tell a sharper story: terra lands 98% of tickets at
**$3.68 median**, 39% of opus-4.8's $9.38. Excluding no-op runs (below), substantive failure rate
inverts the reputational ranking entirely — terra-high fails 14% of the time at $1.12 median vs
opus-4.8-high's 18% at $4.23, roughly 4× the price for a worse rate.

### The escalation tax

55 of 207 tickets (26.6%) used more than one implement model. Of the 55 that started on terra: 38
finished terra-only, 17 escalated — a **31% escalation rate** — at a median all-in of **$8.02**
vs **$3.68** when terra finishes alone. Expected cost of a terra start: 0.69 × $3.68 + 0.31 ×
$8.02 ≈ **$5.03**, still ~1.9× cheaper than pure opus-4.8 ($9.38) even paying the full bounce tax
— but the tax is real, and it's a full re-run each time, not an incremental cost.

### No-op runs distort every per-model comparison

| Implement cast | Runs | No-op (≤1 turn, 0 tool calls) | % |
|---|---:|---:|---:|
| gpt-5.6-terra medium | 53 | 28 | 53% |
| gpt-5.6-terra high | 159 | 63 | 40% |
| claude-opus-5 high | 34 | 2 | 6% |
| claude-opus-4-8 (all) | 232 | 0 | 0% |
| claude-sonnet-5 (all) | 18 | 0 | 0% |
| claude-fable-5 high | 26 | 0 | 0% |

Whole `claude` harness: 2 no-ops in 315 implement runs (0.6%). Root cause, confirmed 92/92 by
transcript correlation: `pi`'s `openai-codex` provider refuses the very first turn on quota/auth,
and `pi` exits 0 — indistinguishable at the process level from a finished run. Broken down: `Codex
error: The usage limit has been reached` (57), `No API key for provider: openai-codex` (24), `Your
authentication token has been invalidated…` (11). Against the full ledger (1,548 lines, 605
implement runs across both harnesses): **`pi` ran at 43% no-op (92/216); `claude` ran at 0.5%
(2/389)**. Two v0 bugs made this invisible: a preflight check that substring-tested `auth.json`
instead of parsing it (35 of the 92 no-ops should have been refused before spawn), and a spend
ledger that wrote a refused launch as an ordinary `failed` run — indistinguishable from a genuine
model failure, which is what made terra look like a bad implementer in the first pass at this data.

### Review gate economics

Review is 18.8% of all spend ($482.65 of $2,574). Sonnet-5 review: 185 reviews, 27.6% sent back,
**$1.44 median** ($6.54 per catch). Opus-5 review catches more often (44.0%) at $5.48 per catch.
Fable review is the one wasteful reviewer choice: $84.96 across 33 reviews, only 12.1% sent back —
1.7× sonnet's price for less than half the catch rate. **Review earns its keep and isn't a target
for cuts** — the one fix is: fable never reviews.

### The concierge seat — the actual bill

From 1,440 concierge transcripts, 30,148 assistant turns, last 14 days as of 2026-07-30:

| Metric | Value |
|---|---|
| Median daily cost (current Opus 5 rates) | **$69.66/day** |
| Mean daily cost | $97.20/day |
| Implied monthly (median) | **~$2,090/mo** |
| Daily variance | $25.70 – $253.21 |
| Cache reads as share of concierge tokens | **78%** (1.89B of 2.42B tokens) |
| Output tokens as share of daily cost | ~$15 of ~$70 (~21%) |

**The concierge seat is the same order of magnitude as all worker spend combined** ($2,090/mo
concierge vs a $2,574/20-day worker run rate of ~$3,861/mo) — the single largest line item in
the system. A pure Sonnet-5 swap saves only ~40% (list
price: ~$41.80/day → ~$1,254/mo; intro price: ~$27.87/day → ~$836/mo), because 78% of the bill is
cache reads at 0.1× price — the saving tracks the input-price ratio, not the sticker-price gap.
**Turn volume, not model choice, is the primary lever.** See [§ v1 cost targets](#v1-cost-targets-the-2090mo--250400mo-concierge-attack)
for the decomposition.

## Ranked waste, and how v1 removes each by construction

Ranked by measured dollar magnitude. Each entry names the v0 mechanism and the v1 structural fix —
not a policy, a property of the design that makes the waste unrepresentable.

**1. Standing concierge cost (~$2,090/mo median) — the single largest cost in the whole system.**
v0 ran one long-lived Opus process that turned every worker milestone into a model turn. v1 splits
the seat in two — a warm **Haiku front desk** for banter/routing and a **Sonnet mind** for
decisions — and, more importantly, takes progress reporting *out of the model entirely*: a `job`/
`event` row changing state drives a Discord card edit as code, zero tokens, zero turns. A model
turn happens only when a human speaks. See [orchestration.md](orchestration.md) for Seats and
[discord.md](discord.md) for cards-as-code.

**2. `pi`/terra no-op runs — 43% of terra implement runs burned a full launch for zero work.**
v1's `health` table (keyed `harness, provider`) is fed by classified failure events and a
zero-spawn probe (whoami/model-list) at boot and every 10 minutes for any harness in the active
roster. The Supervisor consults the cache **before** allocating a worktree. An unhealthy harness
with no substitute leaves the job `open` with `hold='provider blocked: <exact login command>'` and
writes an Event `kind='never_ran'` — zero tokens, zero worktree, zero pollution of quality stats.
This is distinct from `kind='launch_failed'` (a spawn that starts and dies with zero turns) and
`kind='crashed'` (a process death mid-run) — "never attempted" and "tried and failed" are
different event kinds the moment they happen, never a post-hoc `turns<=1` heuristic run over old
data. This alone would remove 92 of v0's 216 `pi` runs from quality comparisons.

**3. Escalation tax — 31% of terra-started tickets bounce to a heavy model at 2.2× the cost.**
v0 handed terra the raw ticket and hoped. v1 front-loads judgment: an opus **plan** job produces
the job tree and criteria once, then execution runs cheap. **Escalation happens at most once per
job, and only after the plan stage validated the plan** — if the plan itself was wrong, that's a
new opus plan job, not a bigger model thrown at the same brief. See [casting ladder](#the-v1-casting-ladder)
below.

**4. Unused haiku headroom — a 10×-cheaper model with zero production casts.** Terminal-Bench
2.1 places luna within 2.7 points of terra (84.7 vs 87.4) at a fraction of the price, yet v0's
773-run sample contains zero luna rows — it was never cast. v1's casting table routes **every
non-code job** to haiku: classification, summarization, card text, publish-link checks,
stall-fingerprint classification, and the entire front-desk seat. This is the zero-risk half of
the headroom — haiku never writes code or makes a decision, so a miscast costs a re-route, not a
wrong action.

**5. Review-gate overhead is not a waste source — it's explicitly not being cut.** $1.44 median,
27.6% catch rate, against $3.68–$9.38 median tickets — review earns its price. The one wasteful
choice inside it (fable as reviewer, 1.7× sonnet's price for under half the catch rate) is fixed
directly: fable never reviews.

**6. Fixed-prefix / MCP-schema risk — currently negligible, a latent landmine if left alone.**
A plain concierge turn pays ~905 tokens (16 project skills, frontmatter only) to keep skills
"available" — about $0.0014/turn warm (cached), ~16% the size of `concierge.md` doctrine (~4,665
tokens, deliberate). Not a current problem. The real risk: attaching MCP servers directly to the
concierge daemon rather than scoping them to worker drivers can add "tens of thousands of tokens"
of fixed prefix per turn (observed on an interactive reference session with Figma/Gmail/Notion/
Drive/Calendar/PubMed connectors enabled — 100+ tool schemas plus per-server instruction blocks).
v1 makes this boundary structural: **only the tiny in-process `job.*`/`channel.window` toolset
runs on either seat**; jingle/gh/deploy/browser MCP is scoped to worker sessions. See the [cache
discipline bundle](#v1-cost-targets-the-2090mo--250400mo-concierge-attack) below.

**7. Recall/memory latency is solved — no further token or latency investment here for v1.** Post
moss-transplant, real-corpus (44 nodes) warm p50 dropped from 7.62ms to **2.75ms** (~64% cut,
p95 11.37ms → 3.33ms); at 500 synthetic nodes, 24.46ms → 18.76ms (~23% cut). Cold first recall on a
fresh store: 27.44ms. All 16 test queries found their expected node in both paths, zero scope
leaks. This is explicitly the one item on the ranked list to leave alone; see
[architecture.md](architecture.md) for the memory graph.

## The v1 casting ladder

Casting is a small deterministic table consulted at file time — not a judgment call the seats
make per-ticket. That's what makes the escalation tax structural to fix: the plan job produces the
right cast up front instead of the mind guessing and the scheduler bouncing.

| Class | Plan | Implement | Review |
|---|---|---|---|
| mechanical (rename, config, docs, dep bump) | — | **haiku** low (short-context only, per MRCR guard) | self |
| normal feature/bugfix | **opus** high, once — produces the job tree + criteria | **terra** (default cheap lane) or sonnet medium | sonnet medium, fresh |
| long-context / large repo (>512K est. tokens) | opus high | **terra** or sonnet (haiku/luna refused by guard) | sonnet medium |
| correctness-critical (auth, money, migrations — declared, confirm-before-cast) | opus high | **fable** high | opus high |

**Why the MRCR guard exists, in numbers:** luna's long-context recall falls from 72.5% (terra) to
**41.3%** past 512K tokens on MRCR 512K–1M, against a measured **median terra implement run of
1.46M input tokens**. Preflight estimates step context (repo profile + brief + diff); past ~512K,
a haiku/luna cast is refused and substituted to terra/sonnet with an Event noting the
substitution — recall is never silently degraded. Terra is the long-context cheap lane; haiku is
the short-context cheap lane. Neither substitutes for the other.

**Why terra stays as a second driver, not gets amputated:** the 43%-no-op number that would argue
for cutting it is a preflight bug, not a property of the model — terra-high beats opus-4.8-high on
substantive failure (14% vs 18%) at roughly a quarter of the price ($1.12 vs $4.23 median). It runs
as a ~200-line driver behind the same Runner interface, behind the health cache, with claude as the
default lane. See [architecture.md](architecture.md) for the Runner abstraction.

**Why fable is rare:** $18.72–$18.93 median all-in, 5× terra/opus — but 0% failure across 26
correctness-critical runs. Justified only for the one class where a wrong answer is expensive
enough that 5× the tokens is cheap insurance; cast anywhere else, it's pure waste. Fable never
reviews, for the same reason in reverse — its review catch rate (12.1%) doesn't clear its price.

**No production cost data exists yet for haiku or luna** — v0 never cast either. The mechanical-
class row above is the v1 hypothesis this table exists to test: haiku's $1/$5 rate (Haiku 4-5
tier) against near-terra Terminal-Bench (88.0% fable / 84.7% luna / 87.4% terra) should make it the
cheapest substantive lane for anything short-context and code-shaped. Track it the same way terra
was validated — real spend Events, not an assumption.

## Budgets as spawn-time rails

v0's per-task USD caps were telemetry: something read the ledger after the fact and, if a human
noticed, said something. v1 makes the budget a property of the spawn itself: `maxBudgetUsd` on
every `query()` and `--max-turns` on every launch are **enforced spawn-time rails**, not a
post-hoc check. Every result frame writes one Event with tokens and cost; a subtree's total spend
is one SQL sum over its `event` rows — no separate rollup job, no drift between what was spent and
what the ledger says was spent.

Overrun is a **conversational gate, not a kill**: the job goes `hold='over budget at $X'` and
Beckett asks in the origin channel — *"this is at $8, past what I'd normally spend on it — keep
going?"* A yes raises `budget_usd` on the row and clears the hold. This is deliberate: a budget cap
that silently kills work mid-flight is worse than one that costs a sentence to raise, and it keeps
the human in the loop on the one thing they actually care about — is this still worth the money.
Budget checks fail **open** on ledger-read errors, with a warning Event — a stuck budget gate that
blocks all work is its own outage, and a missing check is cheaper to recover from than a false one.

## The Event ledger — single source of spend and telemetry

Nine v0 sidecar stores (`spend.jsonl`, `dispatch.jsonl`, journal, advance-outbox, publish-outbox,
comment-cursors, poll-snapshot, dispatcher-state, pending-steer store) collapse into one table:
`event (job_id, kind, payload, cost_usd, tokens, ts)` in `~/.beckett/beckett.db`. Every spend
number Beckett reports — a card's cost footer, a weekly bill, a per-job rollup, a dashboard —
reads the same rows the Supervisor itself acted on. There is no second accounting system that can
drift from the first; "what actually happened" is never inferred from prose or reconstructed from
a differently-shaped file.

Cost is **always recomputed from the current rate table**, never trusted from a runtime-reported
dollar figure — the same convention v0's `spend.ts` and telemetry harvester already used, and worth
keeping exactly because of the fable/haiku rate-table collision above: a runtime-reported number
would have silently propagated a 10× underestimate for months. Rows with no trustworthy model/
usage/timestamp are skipped with a note, never priced at zero. An `estimate` flag per rate-table
entry (confirmed vs. estimated pricing) travels with every cost figure so a dashboard — or this doc
— can tell the difference between "measured" and "our best guess," the same distinction the
`rate_estimate` field made in v0's telemetry harvester.

A job's cost is never null-by-omission: a job with zero cost-bearing events reports `costUsd: null`
(never a misleading $0); a job with some known and some unknown rows sums only what's known. Refused
launches (`never_ran`) never enter this sum at all — they cost nothing and carry no quality data
point, by construction, not by filtering.

## v1 cost targets: the $2,090/mo → $250–400/mo concierge attack

The baseline mechanics: ~$70/day is roughly 2,150 turns/day on an Opus seat re-reading a ~160k
warm context where 78% of tokens are cache reads. The bill is **turn volume × context size ×
model** — attack in that order; idle-socket tricks save ~nothing, because the seat only spends on
turns, never on wall-clock uptime.

1. **Progress never passes through a model — the single biggest lever.** Every worker milestone in
   v0 became a concierge turn. In v1, job/event changes go DB → Wire → Discord card edit as code.
   Model turns happen only when a human speaks. Turn volume drops from ~2,150/day to an estimated
   **~250–350/day** — roughly the milestone-to-human-message ratio.
2. **Two seats.** Of the remaining human-driven turns, an estimated ~70% are banter, questions, or
   acks that decide nothing — routed to the Haiku front desk (warm, per-channel, ≤~12k context:
   persona + a short doctrine core + a short window). Decision turns route up to the Sonnet mind.
   Front desk is forbidden from anything requiring a decision; a misroute costs one extra turn,
   never a wrong action.
3. **The mind carries no channel window.** Context is persona + doctrine core + board summary;
   channel history arrives only via a `channel.window(n)` tool when actually needed. Rotate at
   60k tokens (tunable per channel, up to 120k for busy ones); idle teardown to zero resident
   process — the transcript stays on disk, and cold resume pays one cache write, not a standing
   bill.
4. **The cache discipline bundle:** byte-stable system prefix so the cached prefix actually hits;
   doctrine loaded as lazy skills (~905 tokens of frontmatter, not the 4,665-token doctrine body
   inlined); no heavy MCP on either seat, only the tiny in-process `job.*`/`channel.window`
   toolset — this is the structural fix for the OPS-43 "tens of thousands of tokens" landmine
   above, made permanent rather than avoided by discipline.
5. **Sonnet on the mind seat is safe because casting judgment left the seat.** The named risk in
   the v0 data — a Sonnet swap's weaker casting judgment, where one bad fable-tier miscast
   ($18.52) erases ~11 days of savings — is removed structurally: casting is a deterministic
   table, hard planning is an opus *job*, and the mind never picks a model.

**The dollar model:** front desk at an estimated ~250–300 turns/day × ~$0.004/turn ≈ **$1–2/day**;
mind at an estimated ~80–120 turns/day on a ≤60k rotated context ≈ **$5–8/day**; plan/summarize
work bills to the worker ledger, not the seat. Total **$7–10/day ≈ $210–300/mo**, with a target
band of **$250–400/mo** to absorb busy weeks — against the $2,090/mo v0 median, roughly a
5–8× cut. These are estimates from the turn model above, not a measured result: [migration.md](migration.md)'s
rollout runs spend Events side-by-side against v0 for a week before cutover, and the front-desk
step specifically must show the ~3× expensive-seat turn cut the model predicts or it rolls back.

**Per-job cost expectations**, carried forward from the v0 data since the mechanism (cast per
job class, not per ticket-as-a-whole) is unchanged: mechanical/haiku jobs are untested but priced
at haiku's $1/$5 tier; normal terra/sonnet implement jobs should track terra's $1.12–$3.68 median
substantive/all-in band; long-context jobs the same, minus the luna/haiku option; correctness-
critical fable jobs stay at $18.72–$18.93 median by design — that cost buys the 0%-failure number,
not a target to shrink. Review stays at $1.44 median on sonnet, unchanged, because it already earns
its keep.

## Initiative: the one spend with nobody watching

Unprompted work ([initiative.md](initiative.md)) is the only cost in the system that accrues while
nobody is at a keyboard, so it gets its own ceiling and its own line on the bill rather than a
share of somebody else's.

The idle case is free by construction, which is what makes it affordable to leave a trigger armed:
a `watch` predicate is one indexed SQL query over `job`/`event` or one registered shell probe with
a 10s timeout — **never a model** — so a tick on which nothing is true costs zero tokens, not
"approximately zero." A heartbeat that *thinks* was rejected for exactly this reason: a model turn
on a timer is a standing bill for a usually-empty result, and it is the cost shape this whole doc
exists to refuse.

When a trigger does fire, the job bills to the worker ledger like any other, under four ceilings:
`budget_usd` per fire (default $2.00, riding the ordinary `maxBudgetUsd` spawn rail),
`cooldown_secs` (3600) and `max_per_day` (3) on the trigger row, and **`initiative_daily_usd`
(default $5.00)** — one SQL sum over events joined to `origin_trigger IS NOT NULL` in the last 24h.
That ceiling **fails closed**, the deliberate inversion of the budget gate above: a stuck check on
asked-for work is an outage, a stuck check on unprompted work is silence.

The seat band ($250–400/mo) is unchanged by any of this — the Seats do not run when a trigger
fires, because the evaluator is code. And because `origin_trigger` is a column on `job`,
"what did initiative spend this week" is a `WHERE` clause on the ledger that already exists rather
than a fourth accounting system: v0 had `spend.jsonl`, the routine store, the watch post history,
and the dream budget, and could not answer that question at all.

Every one of these targets is measured the same way the v0 baseline was: real spend Events, summed
from `~/.beckett/beckett.db`, priced from a rate table that's kept current — not assumed, not
carried forward from a stale config file. See [orchestration.md](orchestration.md) for how Jobs are
scheduled and cast, and [migration.md](migration.md) for the dual-write rollout that validates these
numbers before the old rails are cut.
