# Architecture

One long-lived Bun process — the **Supervisor** — runs under `systemd --user` as the dedicated
`beckett` account on the owner's Omarchy desktop (see [omarchy.md](omarchy.md)). It owns the one
durable store (`~/.beckett/beckett.db`), the scheduler, the preflight health cache, and every
`@anthropic-ai/claude-agent-sdk` session. The **Wire** is the Discord adapter: gateway in,
replies and self-editing cards out — card edits are code, never model turns. Two **Seats** front
conversation: a Haiku front desk that reads, banters, and routes, and a Sonnet mind that decides,
files, and steers. Work is a **Job** — one row with a `runner` column (`agent | human | shell`);
everything that happens to it is an **Event** — one append-only row. **Doctrine** is the in-repo
Claude Code plugin (agents, skills, hooks, one small in-process MCP server) that tells the model
side how to behave. A **Trigger** is a standing rule a human armed — the one thing that files a
Job with nobody typing ([initiative.md](initiative.md)). There is no external tracker, no outbox,
no sidecar JSON, and no poller in the dispatch path: a write to the `job` table fires an in-process
emitter, and the scheduler is a function called on that emit and on boot. The design declares
exactly one tick — the trigger evaluator's 60-second pass, which schedules nothing but
initiative. The whole repo is ~12.2k lines, down
from ~125k (≈75k code + 50k test). The full mechanics live in
[orchestration.md](orchestration.md); this doc is the shape and the map.

> **v7 (2026-08) status:** the running system no longer has tickets. `bored`, the poller and the
> dispatcher are gone; work is a **Run** (`beckett task deploy`) executed by the RunSupervisor.
> Where this doc maps "ticket" into a Job, read that as history, not as something still live.

## The eight concepts

Everything durable is built from exactly these. Nothing else has a name; when a source or an old
doc uses another term (ticket, task, stage, dispatcher, concierge), it maps here.

| Concept | What it is |
|---|---|
| **Job** | One row in SQLite: `parent`, `deps[]`, a runner, a cast, a budget, a state. Absorbs ticket, task `#42.1`, stage, DAG node, review cycle, design gate, basm arm, branch name, Discord card key. |
| **Event** | One append-only row `(job_id, kind, payload, cost_usd, tokens, ts)`. Absorbs the spend/dispatch journals, both outboxes, comment cursors, poll snapshots, and the pending-steer store. |
| **Runner** | The *kind* of executor: `agent \| human \| shell`. A column, not a class hierarchy. A human gate is a row the Supervisor has no code path to spawn. |
| **Supervisor** | The one Bun process. Owns the DB, the scheduler, preflight, the trigger evaluator, and the SDK sessions. |
| **Wire** | The Discord adapter. Gateway in; replies, `-# filed jN` lines, and card edits out. |
| **Seats** | Haiku front desk + Sonnet mind, sharing one `persona.md`. The only things that speak. |
| **Trigger** | One row (`t3`): a standing rule a human armed — `schedule \| watch \| signal` — that files a Job when its condition goes true. Absorbs the routine scheduler, its store, its rate limiter, and the dream pass's bespoke budget. The only path to a Job with no human turn. |
| **Doctrine** | The in-repo Claude Code plugin: `agents/`, `skills/`, hooks, one in-process MCP server. |

**One identity rail.** A Job's id is a short opaque ref — `j7`, `j7.1`, `j7.1.2` (child = dotted
suffix of parent). That same string is the git branch, the worktree directory, the session name,
the Discord card key, and what a human types. v0 kept two public rails (`OPS-42` and `#42.1`) and
spent ~1,147 lines (`src/task/`) hiding one from humans; with one rail there is nothing to hide.

**Five job states, and they will never grow:** `open · running · done · failed · cancelled`.
"Ready" is derived. Everything finer — parked, in-review, design gate, launch-refused, crashed —
is a job, a `hold` string, or an event kind. v0's lesson: adding one gate stage cost a global enum
migration; here it costs one row with `runner='human'`. Initiative — a whole new way for work to
begin — cost two tables, one job column, and six event kinds; it added **zero** states and zero
runner kinds, which is the rule doing its job.

## Process model

Everything below the model layer is **one process**:

- `beckett.service`, a `systemd --user` unit under the `beckett` account, `Restart=always`.
  systemd owns liveness — not cloud Routines, not session-scoped cron, not a watchdog agent — and
  it owns *only* liveness: trigger scheduling stays inside the Supervisor, so a fire time, its
  cooldown, and its dedupe key live in the one store instead of in unit files
  ([initiative.md](initiative.md)).
- Inside it: the Wire (discord.js gateway), both Seat drivers, the store, the emitter + scheduler,
  the trigger evaluator, the preflight cache, the in-process MCP server, and in-process hooks. No
  control socket, no bus: modules call each other.
- Agent work runs as **SDK `query()` sessions** — children owned by the Supervisor, each pinned to
  a worktree (`cwd` persisted on the job row, because resume is cwd-sensitive), each with
  `maxBudgetUsd` and `--max-turns` as spawn-time rails. Steering is SDK streaming stdin with an
  echo-ack; mid-run human words are Events first, so "dropped" is unrepresentable.
- Concurrency is one semaphore (`max_workers`, default 3) plus per-repo serialization.
- On boot the Supervisor ps-verifies every `running` row and resumes it
  (`query({resume: session_id, cwd: worktree})`); WIP checkpoint commits every 120s bound crash
  loss to one window. The boot-resume path is exercised by every deploy, so it cannot rot.

Everything load-bearing is GA SDK surface: `query()`, streaming input, `resume`, `maxBudgetUsd`,
in-process hooks, `canUseTool`, worktrees, skills. **Zero preview-feature bets** — TaskList, the
Workflow tool, `--bg` fleets, and agent teams were each evaluated and rejected (session-scoped
persistence, runs dying with sessions, no stdin); `claude --resume` survives only as the
`beckett attach jN` human-observation convenience, never in the correctness path.

## System diagram

Two inbound paths, not one. The human turn is the left column; **initiative** is the right, and
it reaches the Supervisor the same way — by writing a row ([initiative.md](initiative.md)).

```
              Discord                               clock · store predicate · local signal
              │ messages, replies, 👍                                  │
   ┌──────────▼─────────────────┐                ┌────────────────────▼─────────────────────┐
   │            Wire            │                │                 Triggers                 │
   │ cards / -# filed jN edits  │◀───────────┐   │ t3: armed · posture · spec · budget_usd  │
   └──────────┬──────────────▲──┘            │   │ cooldown · max_per_day · fire_key        │
   human turns│              │seat replies   │   │ evaluated in code, never by a model: one │
   ┌──────────▼─────────┐    │               │   │ indexed query over these same rows, or   │
   │        Seats       │────┘               │   │ one probe. nothing true = zero tokens.   │
   │  front desk (Haiku)│                    │   └────────────────────┬─────────────────────┘
   │  mind (Sonnet)     │                    │    act ─▶ files a job  │  one txn writes the
   └──────────┬─────────┘                    │    ask ─▶ a human gate │  fire row and the
              │ job.create / job.say         │             first      │  job row together;
              │ (typed MCP, zod)             │                        │  a dup fire_key
   ┌──────────▼──────────────────────────────┴────────────────────────▼─────────────────────┐
   │                              Supervisor (one Bun process,                              │
   │                             systemd --user, user `beckett`)                            │
   │                                                                                        │
   │   ~/.beckett/beckett.db ─emit─▶ scheduler ─▶ admission ─▶ preflight ─▶ spawn           │
   │   job · event · kv · health     ready-rule   initiative   health cache                 │
   │   trigger · trigger_fire        policy table cap + ledger MRCR guard                   │
   └──────┬──────────────────────┬─────────────────────────┬────────────────────────────────┘
          │ runner='agent'       │ runner='shell'          │ runner='human'
   ┌──────▼───────────┐   ┌──────▼──────────┐       ┌──────▼──────────┐
   │ SDK query()      │   │ verify jobs:    │       │ never spawned;  │
   │ session in a     │   │ fetch the PR,   │       │ Wire posts the  │
   │ worktree named jN│   │ require a 200   │       │ ask; a reply    │
   │ (claude or terra │   │ before done     │       │ flips the row   │
   │  behind one      │   └─────────────────┘       └─────────────────┘
   │  Runner iface)   │──▶ Events (beats, spend, outcomes) ──▶ card edits
   └──────────────────┘
```

Dispatch latency is a function call, not a poll interval: insert → emit → scheduler → preflight
(<50ms when health-cached) → spawn, in the same tick. v0 needed three compensators (`poke()`,
`observe()`, `onAdvance`) just to claw latency back from a 5s poll; all three are deleted because
the gap they compensated for no longer exists.

## The store

`~/.beckett/beckett.db` — SQLite, WAL, one writer (the Supervisor), nightly `VACUUM INTO`,
`beckett doctor db` on boot. Six tables replace v0's **nine** sidecar stores
(`poll-snapshot.json`, `comment-cursors.json`, `dispatcher-state.json`, `advance-outbox.jsonl`,
`publish-outbox.jsonl`, `events/dispatch.jsonl`, `spend.jsonl`, `tasks.json`, `github-prs.json`)
plus the routine store, the watch seen-set, and the dream ledger:

| Table | Role |
|---|---|
| `job` | The board. Full schema in [orchestration.md](orchestration.md): id/parent, intent (prose, verbatim, never parsed), criteria, runner, cast, `deps[]`, `join_policy`, `budget_usd`, origin channel, state, `hold`, `session_id`/`worktree`/`wip_sha`, result. |
| `event` | Append-only ledger: steers (with `delivered_at`), beats, spend (tokens + `cost_usd` per result frame), and the outcome taxonomy — `never_ran`, `launch_failed`, `crashed` are distinct kinds *the moment they happen*, never a post-hoc heuristic. The job table is reconstructible from it. |
| `kv` | Small maps: thread-attach (`&j7`), the 30-day `OPS-N`/`#N.x` alias map from migration. |
| `health` | The preflight cache, keyed `(harness, provider)`: `healthy \| cooldown_until \| blocked` + reason. Fed by classed failure events and by cheap zero-spawn probes at boot and every 10 min. |
| `trigger` | Standing rules a human armed (`t3`): kind, spec, posture, cast, per-fire budget, cooldown, daily cap, veto count. The only thing that files a Job with no human turn — see [initiative.md](initiative.md). |
| `trigger_fire` | One row per evaluated fire, `PRIMARY KEY (trigger_id, fire_key)`. The idempotency guarantee is that constraint, not a check: the fire row and the job row are one transaction, so a repeat is a failed insert and no second job exists. Refusals are rows too (`job_id IS NULL`), which is what makes "why *didn't* you" a query. |

Two structural rules keep it honest. First: **no serialization pretending to be a data model** —
v0 smuggled casts, deps, projects, and branches as six fenced code blocks regex-parsed out of a
markdown description, where a typo'd cast silently degraded to `{}`; v1 creates work through a
typed `job.create` MCP tool that zod-rejects bad input at the boundary, and briefs are *rendered
from* rows, never parsed back. Second: **append-only where history matters** — the event table is
never updated, so the audit trail, the spend rollup (one SQL sum), and the quality stats all read
the same rows the Supervisor acts on. Nothing is inferred twice. `trigger_fire` is the one table
with a rejecting constraint, and that is exactly why it isn't folded into `event`: a ledger that
can refuse a write is worse than one with duplicates, so the *claim* lives in its own small,
prunable table and `event` keeps recording everything forever.

## Doctrine: the plugin

One Claude Code plugin in-repo. Behavior for the model side is data, not orchestrator code:

- **`agents/`** — the stage prompts that were built by `stages.ts`'s 864-line registry: implement,
  review (fresh eyes, `--json-schema` verdict `{verdict, findings[]}`), plan (opus, produces the
  job tree + criteria). A stage is a rendered brief plus a cast row, not a state machine entry.
- **`skills/`** — re-pointed to `job.*` verbs: `intake`, `plan`, `supervise`, `resume`, `quick`.
  Carried near-verbatim in doctrine: `jingle`, `browser`, `github`, `deploy`, `site`, `image`,
  `ui-designer`, `recall`, `remember`, `deliver`, `self-improve`. Deleted: `basm` — fanout,
  quorum joins, budgets, and human gates are the default expressive power of job rows now, so the
  compiler for a DSL the dispatcher never executed has nothing to compile to.
- **hooks (in-process)** — the scope guard as `canUseTool`, the done-gate, the 120s WIP-commit.
  No subprocess hooks: the Supervisor registers them directly on its own sessions. A job with
  `origin_trigger` set gets a narrower toolset by construction: no `trigger.*` verbs (so a
  self-started job can never arm another rule), no send-as-a-person surface, and `gh` admin verbs
  denied — three of the doctrine's four direct-go items as absences rather than as sentences a
  model has to remember; the fourth, an explicit hold, is refused before the job exists
  ([initiative.md](initiative.md)).
- **MCP (in-process)** — the tiny `job.*` / `trigger.propose` / `channel.window` toolset for the
  Seats, plus memory,
  jingle, deploy, image, and the browser handoff for workers. Heavy MCP (jingle/gh/browser) is
  scoped to workers only — never loaded on a Seat, because a fat toolset on the conversational
  seat was a tens-of-thousands-of-tokens standing tax (see
  [token-efficiency.md](token-efficiency.md)).
- **`persona.md`** — one file, loaded by both Seats, owner-editable at `~/.beckett/persona.md`.
  Voice lives here and only here; workers never speak in channel, so personality structurally
  cannot leak.

The doctrine follows the lazy playbook pattern the repo already validated once (the concierge
doctrine was cut 11,453 → ~1,000 words by moving rules into trigger-scoped files): skills load on
their trigger, ~905 tokens of frontmatter resident instead of 4.6k inlined.

## Repo map with line budgets

Targets, not measurements — they are the build's size contract and they sum to the mandate.

| Module | LOC | What it is / replaces |
|---|---:|---|
| `store/` | 500 | schema, typed accessors, migrations, `doctor db` — job · event · kv · health · trigger · trigger_fire |
| `supervisor/` | 950 | scheduler, ready-rule, policy table, boot resume, stall watchdog — replaces the 4,174-line dispatcher + 585-line poller |
| `initiative/` | 300 | trigger evaluator: the predicate registry, humanized fire times, fire-key dedupe, the act-or-ask downgrade rules, the daily ledger — replaces `src/routine/` (3,573 with its module) and the dream pass's bespoke budget |
| `run/` | 600 | SDK driver: spawn, stream, steer + echo-ack, structured output, budget — replaces `src/drivers/` (110KB) |
| `run/terra.ts` | 200 | second driver behind the same Runner interface; opt-in lane, behind preflight |
| `preflight/` | 250 | health cache, zero-spawn probes, MRCR context-budget guard |
| `worktree.ts` | 350 | cut / merge-back / dependency basing / scaffolding guard |
| `wire/` | 2,300 | gateway, relay, cards, filed-line, thread-attach, hold-and-cancel |
| `frontdesk/` | 600 | Haiku seat: amend predicate, ambient debounce + caps, OTP-delete |
| `mind/` | 600 | Sonnet seat: session pool, cancel-and-amend, playbooks |
| `mcp/` | 850 | in-process SDK MCP server: `job.*`, `channel.window`, memory, jingle, deploy, image, browser handoff |
| `hooks/` | 200 | scope guard as `canUseTool`, done-gate, WIP-commit |
| `memory/` | 1,200 | moss recall graph (kept; daemon plumbing trimmed) |
| `browser/` | 1,500 | BetterWright lane (kept; see [betterwright.md](betterwright.md)) |
| `jingle/` + deploy/site/image | 1,200 | credential vault glue and the delivery hands |
| `cli/` | 550 | `beckett job/plan/say/spend/status/attach/doctor/why/initiative/signal` |
| Doctrine plugin | ~600 md | `agents/`, `skills/`, prompts, `persona.md` — data, not code |
| **Total** | **≈12,150 + 600 md** | from ~125k (≈75k code + 50k test) |

`beckett why <jN>` is the one verb added purely for legibility: it prints the trigger, the
evidence that was true at fire time, who armed the rule, and what it cost — all from rows, and it
exists because [discord.md](discord.md)'s ninth acceptance conversation stops being answerable by
"you asked me to" the moment initiative ships.

## Old → new: what absorbed each deleted subsystem

| v0 subsystem (non-test LOC) | v1 home |
|---|---|
| bored tracker + HTTP adapter + bridge-flow hack (`src/bored/`, 358) | deleted — the `job` table *is* the board; no external lifecycle to fake with two-gate workflow translations |
| poller (`src/tracker/poll.ts`, 585) + `poke`/`observe`/`onAdvance` | deleted — DB write → in-process emitter → scheduler function call |
| dispatcher (`src/dispatch/dispatcher.ts`, 4,174) | `supervisor/` — a ready-rule and one failure-policy table; roughly a third of the dispatcher was durability bookkeeping the store now gives for free |
| stage registry (`stages.ts`, 864) | Doctrine `agents/` prompts + the deterministic casting table |
| worker spawn (`spawn.ts`, 576) + `src/drivers/` | `run/` on the Agent SDK; terra as a 200-line second driver |
| advance-outbox + publish-outbox (427) | Event rows + the `runner='shell'` verify job's bounded retry (1m/5m/30m) — the courier *concept* deleted, its semantics kept |
| fenced-block metadata (`tracker/cast.ts`, 365) | the typed `job.create` boundary; `validateCasting`'s refusal posture survives as zod |
| task/branch registry (`src/task/`, 1,147) | the identity rail — `j7` is already the branch, worktree, session, and card key |
| nine sidecar stores | six tables in `beckett.db` |
| concierge monolith (`src/concierge/index.ts`, 7,656) | `frontdesk/` + `mind/` (600 each) for the human turns; Wire card edits as code for the ~2,000 daily progress turns that never needed a model |
| capability registry + ext contract (`src/capability/` + `src/ext/`, ~2,007) | the Doctrine plugin — CLI-verb/bus/prompt-block composition was plumbing for problems the SDK-native shape doesn't have |
| basm `.b` DSL + skill | job rows: `deps[]`, `join_policy`, `budget_usd`, `runner='human'` |
| INT board / design gate | an ordinary job tree with a `runner='human'` gate row — zero tokens parked, restart-inert by construction |
| quick runner (`src/quick/` + module, 527) | a direct `run/` spawn; the errand-sizing doctrine survives in the `quick` skill |
| routine scheduler (`src/routine/` + module, 3,573) | `trigger` rows + the ~300-line evaluator in `initiative/` — one clock, one store, one ledger. The humanized-fire-time doctrine and the hard 1/hr·3/24h cap survive as columns (`cooldown_secs`, `max_per_day`); the hand-rolled scheduler, its store, and its separate rate limiter do not. **Not** systemd timers: a fire time whose cooldown and dedupe key live in a unit file is a tenth sidecar ([initiative.md](initiative.md)) |
| staffing watchdog | deleted — with the poller gone, the ready-rule is the only scheduling authority (the trigger evaluator's 60s tick schedules nothing but initiative) |
| dream (`src/dream/`, 1,663) | deferred — not in the v1 map. Its walls were right and its output was deliberately evidence rather than work; if revived it is one `schedule` trigger filing one ordinary job on the ordinary ledger, not custom budget/spike machinery |
| voice transport (`src/discord/voice/`, 909) | stays in-tree, unwired, documented as deferred |
| federation (`src/discord/federation.ts` + caps) | deferred — single-owner desktop install first |
| ~11k+ test lines | die with their subjects; the ported pure modules bring their tests with them |

## What carries near-verbatim, and why

Deleting 90% only works because the 10% that survives is the part that was earned by incidents,
not by architecture. These move mostly byte-for-byte, tests included:

- **Worktree mechanics** (`worktree.ts`). Dependency-branch basing — a job with deps branches from
  its last completed dep's branch head and merges the rest, never stale `origin/main` — plus the
  triple scaffolding guard. Both fix real incidents (OPS-59/61) that had nothing to do with the
  tracker underneath them; the fix survives the tracker.
- **Spend ledger concepts** (`src/spend.ts`'s semantics, now Event rows). Per-run tokens/cost/
  outcome, the attempt-vs-`launch_failed` distinction, budget summing, the weekly bill. The #159
  no-op incident (92 of 216 pi implement runs were zero-token provider refusals ledgered as cast
  failures, corrupting the model-economics read) is why the outcome taxonomy is now distinct by
  construction in event kinds — and why preflight exists at all.
- **Casting presets** (`~/.beckett/presets.json`): user-owned, fresh-read per filing, validated —
  already the right shape.
- **Memory** (`memory/`): the node model, the fail-closed `canView` visibility gate (the *only*
  access-control point — moss ranks, it never gates), the moss-local hybrid retrieval, the daily
  nothing-is-ever-deleted maintain pass. What's trimmed is daemon-warm plumbing, not the model.
- **Jingle**: the injection discipline verbatim — a secret crosses stdin or a child's env, never
  argv, stdout, or a log line; TOTP seeds are written once and codes minted fresh per use.
- **Browser lane** (`browser/`): the persistent Chromium host, run queue/lease, watch/steer/stop,
  and jingle credential injection are genuinely stateful infrastructure the SDK does not provide —
  the rare case where custom code earns its size, trimmed at the Beckett-wiring edges.
- **Wire pure modules**, ported first and unchanged (migration step 2, see
  [migration.md](migration.md)): the `-# filed` line renderer (null-means-post-nothing; refs
  validated `/^j\d+(\.\d+)*$/` as a structural injection guard), the rudely-strict whole-message
  `&j7`/`&recent`/`&clear` thread-attach parser, human-cadence chunking, reply-context reach-back
  with its data-not-instructions framing, the deterministic `messagePlausiblyAmends` predicate,
  the fail-closed OTP/password reply deletion, the self-editing card, the typing indicator as the
  sole in-progress signal. Each is 60–250 lines, pure, individually tested, and tuned against a
  named field incident. They *are* the feel ([discord.md](discord.md)); re-deriving them would
  re-litigate lessons already paid for.

## Conventions carried forward

The style contract is unchanged from v0, because it worked:

- **Dense why-comments.** Match the neighbors: comments explain *why* — the incident, the
  tradeoff, the rejected alternative — not what the next line does.
- **Pure helpers split from I/O.** The Wire modules above are the template: small, side-effect-
  free, individually unit-tested. Integration surface is where v0's cost lived; keep it thin.
- **Strict, fully-defaulted config.** A near-empty `config.toml` boots; an unknown or
  out-of-range key is a loud refuse-to-start. The committed example is generated from the live
  schema (`beckett config print-default`), so it cannot drift. The same posture applies at the
  MCP boundary: reject bad input, never silently degrade.
- **No new enum states, ever.** New semantics are rows, `hold` strings, or event kinds.
- **Gates before commit:** `bun x tsc --noEmit` clean and `bun test` green. The deploy script
  typechecks before restart — prod never restarts onto broken code.
- **Doctrine is lazy.** Trigger-scoped skills, not monolithic prompts; rules are cut by
  inventory-audit (every imperative traced to its new home), never by vibes.
