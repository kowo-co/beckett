# Vision

Beckett is the best AI coworker: a colleague who lives in your Discord, has its own machine,
its own memory, and its own hands, and does the work instead of routing it. Not a ticket
window you file requests into and wait on. Not a bot you command. A teammate who reads the
room, decides how much effort a request deserves, and either answers in a sentence or goes and
builds the thing — in your voice, on your infrastructure, in your channel.

> **v7 (2026-08): tickets are already gone.** The `bored` tracker, the poller and the ticket
> dispatcher were removed from the running system and replaced by runs — one `beckett task deploy`
> call, one `spec.md` checklist, one supervisor. See the repo README for the shipped shape; the v0
> critique below is the history that motivated it.

v1 exists because v0 built the wrong half of that sentence. It got the Discord feel right and
the engineering wrong: a rigid ticket tracker (`bored`) and a 4,174-line dispatcher stood
between every request and the work, smuggling structure through markdown, polling every 5
seconds for state it could have known instantly, and burning a full spawn cycle on 43% of pi
implement runs that were never going to do anything. `bored` dies in v1. Orchestration moves
onto Claude Code / Agent SDK primitives that are GA today — `query()`, streaming input,
worktrees, hooks, skills — because the market has now built and hardened the exact machinery
Beckett v0 hand-rolled badly. See [orchestration.md](orchestration.md) for the replacement and
[migration.md](migration.md) for how we get from here to there.

## The six commitments

These are not values to feel good about. Each one is a testable product principle: a claim
that should be falsifiable by looking at spend Events, latency logs, or a Discord transcript.
Each has a sharp v0 failure it is a direct answer to.

### 1. Token efficiency

**v0 counter-example:** the Concierge's standing cost ran ~$2,090/mo median — the same order
of magnitude as *all* worker spend combined (~$3,861/mo run rate), and the single largest
line item in the system — because 78% of its tokens were cache re-reads of a
~160k-token warm context, and every worker milestone became a full model turn just to narrate
progress nobody asked about.

**v1 stance:** turn volume, context size, and model tier are three separate levers and we
attack all three, in that order of leverage. Progress never passes through a model — job and
event changes become a Discord card edit as code, zero tokens. Two seats split the remaining
human-driven turns so a warm Haiku front desk absorbs banter and routing while a Sonnet mind
only spends on decisions. Casting is a deterministic table consulted at file time, not a
judgment call the expensive seat makes on every turn. Target: $250–400/mo, measured
side-by-side against v0 before cutover, not assumed. Full mechanics in
[token-efficiency.md](token-efficiency.md).

### 2. Speed

**v0 counter-example:** a filed ticket wasn't guaranteed to enter dispatch for up to 5 seconds
(poll interval), work resumption after a crash was a manual operator step, and every stage
transition paid a cold full-process spawn with a full re-briefing — review re-read the repo
from scratch every time.

**v1 stance:** dispatch is a function call, not a poll interval — a write to the job table
fires an in-process emitter the same tick it lands. Steering reaches a live worker's context at
the next tool boundary over SDK streaming stdin, not a comment→nudge round trip. Session
continuity means a rework cycle resumes the same session instead of cold-starting: the model
that wrote the code fixes the code with its context intact, and a fresh spawn is paid only
where fresh eyes are the point (review, or a cast change). See
[orchestration.md](orchestration.md) §3 for the latency table this claim is checked against.

### 3. Accuracy

**v0 counter-example:** 43% of pi implement runs (92 of 216) were zero-work provider refusals
that still burned a full spawn cycle and silently corrupted per-model quality stats — a
"never attempted" run counted as a "tried and failed" one, and nobody could tell the difference
after the fact. Escalation was reactive too: 31% of cheap-model tickets bounced to a heavy
model at 2.2× cost, and 26.6% of tickets used more than one implement model, because judgment
was applied *after* the cheap model had already failed instead of before it was cast.

**v1 stance:** preflight makes "never ran" a distinct, structural event kind — a health check
before spawn refuses unhealthy providers with zero tokens, zero worktree, and zero quality-stat
pollution, so the 92-run class disappears by construction rather than by heuristic. Casting
front-loads judgment: a strong seat plans once, execution runs cheap, and escalation happens at
most once per job and only after the plan validated — if the plan was wrong, the fix is a
re-plan, not a bigger model thrown at the same brief. Review stays a real gate ($1.44 median,
27.6% catch rate) because the numbers say it earns its keep, not because gates are free.

### 4. Robustness

**v0 counter-example:** state was split across nine sidecar JSON stores with no shared
transactional discipline, adding one gate stage (the INT design board) forced a global enum
migration, and the polling architecture spawned three compensators (`poke`/`onAdvance`/
`observe`) whose entire job was papering over the fact that nothing was event-driven. A crash
mid-run had no honest resume story.

**v1 stance:** one durable store — one WAL SQLite file, one writer, an append-only event log —
replaces nine sidecars. Five states that will never grow (`open · running · done · failed ·
cancelled`); anything finer is a job row, a `hold` string, or an event kind, never a new enum
value. Resume after restart is a first-class path exercised by every deploy: session id,
worktree path, and a WIP checkpoint every 120 seconds are durable facts written in that order,
so a crash re-enters at the first non-done job with loss bounded to the checkpoint window —
never a silent restart from scratch. Full design in [architecture.md](architecture.md).

### 5. Coworker feel

**v0 counter-example:** the feel was actually the part v0 got right — cancel-and-amend,
no-thread filing, `&ref` thread attach, honest steering receipts — and it must not be a
casualty of the orchestration rewrite. The risk in v1 is regression: a leaner backend that
forgets why the product felt like a person.
**v1 stance:** the Discord surface is explicitly unchanged in feel, simplified in fact. One ref
per job that's also the branch name, the worktree, and what a human types — no more shadow
identities to hide from people. Workers never speak in channel; every visible sentence comes
from the seats sharing one `persona.md`, so personality structurally cannot leak. A steer
landing on finished work gets an honest answer about what already happened, never a bare "ok,
updated." Beckett interrupts for exactly four things: a gate, a failure it can't resolve,
delivery, and work it started on its own. The acceptance bar is a live ten-conversation
checklist, not a vibe — see [discord.md](discord.md).

### 6. Initiative

**v0 counter-example:** v0 could talk unprompted, dream unprompted, and post unprompted, and
could not *work* unprompted — and it built that limitation three separate times. `src/routine/`
(3,573 lines with its capability module) had a humanized clock, a seen-set, and a hard 1/hour
3/24h post cap, and could only post; `src/dream/` (1,663 lines) had its own budget, its own
ledger, and an overnight spike walled into a branch that could never merge; ambient interjection
had a classifier and burst caps and a playbook rule that says in as many words *offer, don't
commit*. Three clocks, three stores, three budgets, and no answer to "main is red and nobody is
awake."

**v1 stance:** one door. A **Trigger** is a durable row a human armed; when its condition goes
true it files an ordinary Job, and everything downstream — scheduling, budget, review, cancel,
the card, the ledger — is the machinery that already exists. Three trigger kinds (a humanized
clock, a store predicate, a local signal), and the predicate is **SQL or a registered probe,
never a model**, so a quiet day costs zero tokens and every firing is replayable. The act-or-ask
gate is rows the store enforces, not judgment a model re-derives per turn: an `act` posture is a
ceiling the evaluator may only downgrade. Idempotency is a UNIQUE constraint, not a check — the
`trigger_fire` row and the `job` row are the same write. Ceilings are concrete ($5/day across all
initiative, one concurrent self-started job, strictly lowest priority) and the kill is one
latched command. Full design in [initiative.md](initiative.md).

**Why this is a sixth commitment and not a paragraph inside coworker feel.** Folding it into feel
would make it a vibe, and the point of this list is that each entry is falsifiable against rows.
Initiative is the most falsifiable of the six: a quiet week must show zero attributable tokens in
the Event ledger, a true condition must produce exactly one job, and `beckett why j12` must name
the trigger, the evidence, who armed it, and what it cost. It is also the only commitment whose
failure mode is *Beckett doing something nobody wanted*, which is a different class of risk from
the other five and deserves its own heading rather than a clause in someone else's.

## What v1 is not

**Not a SaaS.** There is no tenant model, no per-seat billing, no hosted control plane. Beckett
runs on hardware the owner controls, under credentials the owner minted, and its marginal cost
is the owner's own Claude subscription — not a monthly rate card sized to fund a Series A.

**Not a ticket tracker.** `bored` and everything built to feed it — the poller, the dispatcher,
the nine sidecar stores, the fenced-block markdown parsing — are deleted, not replaced with a
nicer tracker. Work is a row in one table with a prose brief, never a serialization format
pretending to be a data model.

**Not a framework.** v1 is not a general-purpose orchestration engine for other people's agent
fleets, and it is not trying to out-abstract the Agent SDK it sits on. It composes GA primitives
into one opinionated coworker for one Discord server. Generality is not a goal; it is a cost
someone else can choose to pay by forking.

**Self-hosted, one owner, personality-forward.** These three are one property, not three
separate features. Self-hosted because trust has to be structural, not promised — credentials
never leave the box (`jingle`), browser automation runs on hardware you can see
([computer-use.md](computer-use.md), [betterwright.md](betterwright.md)). One owner because a
coworker answers to somebody, and diffusing that into an org chart of "users" and "roles" is how
products stop feeling like anyone in particular. Personality-forward because the character is
not a skin on top of the engineering — `persona.md` is rewritable live, in Discord, by asking,
and that is the whole point of a coworker over a tool.

## Where this sits in the market

The full landscape is in [market-research.md](market-research.md); the short version is a gap,
not a fight. Every well-funded "AI coworker" — Devin, Viktor, Claude Tag, Codex's Slack app —
targets Slack or Teams and runs on someone else's cloud: you ship your repos, your tokens, and
your screen to their VM to get a colleague. The one Discord-native commercial entrant
(coupon.dev's Agent Team) is cloud-hosted too. Nobody combines Devin-class orchestration with an
OpenClaw-class persona and a single continuous identity running on hardware the owner actually
controls. That combination — not a longer feature list — is the position: **your coworker lives
in your house, not in a call center.** Discord is not a limitation to work around; it is
unclaimed ground, home to exactly the indie hackers and small teams the Slack-and-Teams
incumbents aren't building for.

## The core bets, honestly

Four decisions carry the most risk in this design. Naming them here is the point — a vision
doc that doesn't admit what could be wrong isn't one.

**Betting the substrate on Claude Code / Agent SDK.** v1 deletes ~90% of v0's hand-rolled
orchestration because the Agent SDK now provides it as a GA primitive — `query()`, streaming
input, resume, budget rails, worktrees, hooks, skills. The bet is that this substrate keeps
being GA-stable and keeps being the right lane for the workloads Beckett runs. The honest risk:
Beckett is now more exposed to Anthropic's product decisions than v0 ever was, and every
preview-tier feature we were tempted to build on (Discord Channels plugin, `--bg` daemon state,
TaskList, the Workflow tool, agent teams) is explicitly rejected in favor of what's GA today —
see [orchestration.md](orchestration.md) §1 and its risk register for the full accounting of
what we didn't take and why.

**Betting on one store.** One SQLite file — WAL, one writer, one append-only event log —
replaces nine sidecars and a ticket tracker. The bet is that a single-writer embedded database
is enough durability for one owner's workload. The honest risk: it is also a single corruption
point, mitigated by WAL discipline, nightly `VACUUM INTO`, and a boot-time doctor pass rather
than eliminated — see [architecture.md](architecture.md).

**Betting on Omarchy residency.** Beckett runs under a dedicated `beckett` account on the
owner's own Arch/Hyprland desktop, not a rented cloud box. The bet is that a real desktop seat —
files, browser, local services, an actual window manager — is a capability tier hosted agents
structurally cannot match, and that it's worth the operational weight of owning a machine
instead of renting elasticity. The honest risk: no autoscaling, no geographic redundancy, and an
outage is the owner's hardware problem — see [omarchy.md](omarchy.md).

**Betting that initiative belongs in the store, not in a model.** Unprompted work is gated by
rows — an armed trigger, a code predicate, a fire key, a daily ledger — and no model decides
whether to start. The bet is that a fixed registry of seven predicates plus a local `signal` verb
covers enough of what a colleague would actually notice to be worth having. The honest risk: it
is the least *alive*-feeling version of proactivity anyone could ship, and if the predicates never
match what people care about, initiative is dead weight with a config file. The fallback is named
and deliberately unattractive — one haiku evaluator job per day, capped, on its own ledger line —
because the failure we are refusing to risk is a model that wakes itself up. See
[initiative.md](initiative.md).

## How to read the rest of this set

Start here for *why*; the rest is *how*. [orchestration.md](orchestration.md) is the
authoritative design — the job/event model, the mechanics, the migration order — and everything
else hangs off it. [architecture.md](architecture.md) covers the store and process model in
implementation detail. [initiative.md](initiative.md) covers the one path by which work starts
without a human turn. [token-efficiency.md](token-efficiency.md) decomposes the concierge cost
attack. [computer-use.md](computer-use.md) and [betterwright.md](betterwright.md) cover the
hands: desktop and browser respectively. [omarchy.md](omarchy.md) covers the machine Beckett
runs on. [discord.md](discord.md) covers the surface — what the owner actually sees and types.
[market-research.md](market-research.md) is the competitive record this doc's positioning
section summarizes. [migration.md](migration.md) is the concrete cutover plan from today's tree
to this one. Read this doc when you need to know why a decision was made the way it was;
read the others when you need to build or verify it.
