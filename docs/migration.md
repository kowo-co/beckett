# Migration

This is the executable plan for the cut described in [orchestration.md](orchestration.md),
[architecture.md](architecture.md), and [initiative.md](initiative.md): what deletes, what
survives, in what order, and what "done" means. It is not a narrative — it is the checklist the
cut is run against.

> **v7 (2026-08) already landed the first slice of this cut**: the ticket tracker, the poller and
> the dispatcher are removed from the running system, replaced by runs (`beckett task deploy` → a
> run ledger + supervisor). Rows below that dispose of ticket machinery are done; the Job/SQLite
> model is still ahead.

## The cut in numbers

`src/` on this branch is **125,470 lines** (74,971 code + 50,499 test). v1 lands at **≈12,150
lines of code + ~600 lines of doctrine markdown** — the module list in [architecture.md](architecture.md)’s repo map — a
**~90% cut**, tests included, because the tests that die are the ones whose subjects die with
them.

Those numbers moved while this design sat unbuilt: the first draft of this set measured 117,837
lines (70,851 + 46,986), and v0 has added **~7,600 lines** since — `concierge/index.ts` alone grew
385 and `dispatcher.ts` 16. That is not an embarrassment to bury in a footnote, it is the
argument: the subsystems this plan deletes are the ones still accruing, and every month the cut is
deferred it gets bigger. The percentage is unchanged because the growth is on the *numerator* of
what gets deleted.

The single largest deletions:

- `src/concierge/index.ts` — 7,656 lines, one monolith, replaced by two ~600-line seats
- `src/dispatch/dispatcher.ts` — 4,174 lines, one state machine, replaced by a 950-line Supervisor
- `src/task/` — 1,965 lines (incl. tests), a registry that existed to hide the tracker from
  humans, deleted outright because there is nothing left to hide
- `src/tracker/` — 1,377 lines (incl. tests) of poller, bored bridge, and fenced-block parsing
- ~11,000+ lines of subsystem tests (`src/tracker`, `src/dispatch`, `src/task`, `src/bored`) that
  have no subject left to test

What survives near-verbatim: worktree mechanics, the Discord wire layer, casting presets, memory,
BetterWright, jingle/deploy/site/image. None of those were ever coupled to the ticket tracker —
they were coupled to Discord, git, and the model roster, all of which outlive the cut.

## Disposition table

Path → today's LOC → verdict → where it lands in v1. Non-test LOC unless noted; test LOC called
out separately since it deletes with its subject. Verdicts and destinations are the synthesis
call, not the original per-subsystem inventory — see **Conflicts resolved** below where the two
disagree.

| Path | LOC | Verdict | Lands in v1 |
|---|---:|---|---|
| `src/bored/` | 358 (+102 test) | **DELETE** | — bored is gone; nothing replaces the adapter |
| `src/tracker/poll.ts` | 585 | **DELETE** | `supervisor/` — emitter-driven scheduler, no poll loop |
| `src/tracker/client.ts` | 41 | **DELETE** | — |
| `src/tracker/types.ts` | 244 | **REWRITE** | `store/` — the `job` table DDL + typed accessors |
| `src/tracker/cast.ts` | 365 | **DELETE**, ~50 lines survive | `mcp/` (`job.create` zod schema) + `supervisor/` (casting table) |
| `src/tracker/presets.ts` | 142 | **KEEP**, near-verbatim | `supervisor/` — `presets.json`, read fresh at file time |
| `src/dispatch/dispatcher.ts` | 4,174 | **DELETE**, ~10-15% survives as policy | `supervisor/` — scheduler, ready-rule, policy table, boot resume, watchdog |
| `src/dispatch/stages.ts` | 864 | **REWRITE** smaller | Doctrine `agents/` (prompt builders → subagent defs) + `supervisor/` (casting table) |
| `src/dispatch/spawn.ts` | 576 | **DELETE** | `run/` — Agent SDK driver: spawn, stream, steer+echo-ack, structured out, budget |
| `src/dispatch/advance-outbox.ts` + `publish-outbox.ts` | 427 | **DELETE**, semantics survive | job model — publish is a `runner='shell'` verify child with its own retry (no standalone outbox) |
| `src/dispatch/events.ts` | 143 | **DELETE** as a file, concept survives | `store/` — the `event` table itself; JSONL becomes SQL rows |
| `src/dispatch/resume-brief.ts` | 64 | **KEEP** the idea | `run/` — renders resume briefs from job rows + queued steers |
| `src/tracker/` + `src/dispatch/` tests | ~5,224 | **DELETE** | die with their subjects |
| `src/task/` | 1,147 (+818 test) | **DELETE outright** | `wire/` absorbs the one surviving piece — the self-editing card, now driven off `job`/`event` rows directly |
| `src/worker/worktree.ts` | 647 (+388 test) | **KEEP**, trimmed | `worktree.ts` — cut/merge-back/dep-basing/scaffolding guard, dep-basing kept explicit |
| `src/shell/main.ts` | 1,098 | **REWRITE** much smaller | folds into `supervisor/`'s boot path + a thin entrypoint — no 15-callback wiring layer |
| `src/spend.ts` | 242 | **DELETE** as a file, ledger becomes rows | `store/` (event rows carry `cost_usd`/`tokens`) + `supervisor/` (budget hold/ask policy) |
| `src/progress/journal.ts` | 240 | **DELETE**, folds into event stream | `store/` — event rows are the journal; Wire renders beats off them |
| `src/concierge/index.ts` | 7,656 | **DELETE** | `frontdesk/` (600, Haiku seat) + `mind/` (600, Sonnet seat) |
| `src/routine/` | 2,281 (+1,398 test) + `capability/modules/routines.ts` 1,292 | **DELETE**, doctrine survives | `initiative/` (300) + `trigger`/`trigger_fire` rows — humanized fire times and the 1/hr·3/24h cap become columns, the scheduler/store/rate-limiter do not survive as code ([initiative.md](initiative.md)) |
| `src/dream/` | deleted in the v7 debt sweep (overhaul P16) | — | not in the v1 map; if revived it is one `schedule` trigger filing one ordinary job, on the ordinary ledger |
| `src/discord/*` | 5,331 (+4,793 test) | **KEEP**, mostly verbatim | `wire/` — gateway, relay, cards, filed-line, thread-attach, hold-and-cancel |
| `src/drivers/claude.ts` + `base.ts`/`proc.ts` | portion of 3,351 | **DELETE**, replaced natively | `run/` — Agent SDK `query()` sessions replace `claude -p` subprocess driving |
| `src/drivers/codex.ts`, `src/drivers/pi.ts` + cooldown/failure/preflight-probe | portion of 3,351 (+test) | **DELETE outright** | — casting narrows to claude-family + `run/terra.ts` (200 LOC, opt-in, behind preflight) |
| CLI ticket/task/plan verbs (`cli/core.ts` ~600 of 1,862, `task-start.ts` 138) | ~740 | **REWRITE** smaller | `cli/` — `beckett job/plan/say/spend/status/attach/doctor` |
| Skills: `intake`, `plan`, `supervise`, `resume`, `quick` | — | **KEEP**, re-pointed | Doctrine plugin — same skills, verbs retarget to `job.*` |
| Skill: `basm` | — | **DELETE** | job trees are the default expressive power (fanout/quorum/gate/loop/budget are all row shapes) |
| `src/memory/` | — | **KEEP** unchanged | `memory/` (1,200 LOC) |
| `src/browser/` (BetterWright lane) | — | **KEEP** unchanged | `browser/` (1,500 LOC) |
| jingle + deploy/site/image | — | **KEEP** unchanged | `jingle/`+deploy/site/image (1,200 LOC) |
| Legacy docs (`int-flow`, `cast-presets`, `no-op-runs-159`, `v6.md`) | — | **KEEP** as rationale | referenced by orchestration.md, not shipped as runtime doctrine |

**Conflicts resolved** (where the original subsystem inventory and the orchestration synthesis
disagreed, synthesis wins):

- **`src/task/` is a full delete, not a rewrite.** The inventory's first pass kept a rewritten
  third of it for public `#N.x` refs and card rendering. Synthesis collapses the identity rail to
  the job id itself (`j7`) — the ref you see is the ref that exists — so the mirroring registry
  has nothing left to mirror. Card rendering moves into `wire/` directly off `job`/`event` rows.
- **Stage destinations are not Workflow-tool DAG nodes.** The inventory's v1 mapping hints assumed
  a native Workflow-tool orchestrator; orchestration.md rejects that shape outright (runs die with
  the session, no mid-run human gate). Stage prompts land in Doctrine `agents/` and job trees,
  not workflow definitions.
- **`spend.ts` doesn't survive as a file.** The inventory kept the JSONL ledger verbatim; the
  `event` table absorbs it — cost and tokens are columns on the same row the scheduler already
  writes, and budget rollup is a SQL sum instead of a separate ledger read.
- **`journal.ts` doesn't survive as a file.** Its job — a private per-ticket play-by-play — is
  now just the `event` table queried by `beckett status`; there is no separate `beckett journal`
  verb in the v1 CLI list.
- **The routine scheduler does not become systemd timers.** An earlier pass of this set mapped
  `src/routine/` onto `systemd --user` timers plus skill invocations. That puts the fire time, the
  cooldown, and the dedupe key outside `beckett.db` — a tenth sidecar written in unit files, in a
  design whose whole thesis is one store. The Supervisor is already a long-lived process; it owns
  trigger scheduling and systemd owns liveness only ([initiative.md](initiative.md)).
- **codex and pi drivers delete outright**, not conditionally. The inventory kept them "if
  multi-harness casting is kept." Synthesis's casting table (orchestration.md §3.13) names exactly
  two driver lanes — claude-family via the Agent SDK, and terra — so the old general-purpose
  codex/pi drivers have no cast that reaches them. Terra's pi/codex access is rebuilt as the
  ~200-line `run/terra.ts` behind preflight, not carried over from `src/drivers/`.

## Build order

Ten steps, in dependency order. Each says what must exist first, whether it runs alongside v0 or
requires it, and what rolling back looks like at that point.

1. **Land the store.** `beckett.db` (`job`/`event`/`kv`/`health`) + typed accessors beside v0, no
   behavior change; backfill open OPS tickets as read-only rows.
   Nothing downstream can exist without a place to write to. Touches nothing live — v0's
   dispatcher has no idea the table exists — so this carries zero regression risk and runs fully
   parallel with v0.

2. **Port the pure Discord modules verbatim, with tests** (filed-line, thread-attach, chunk,
   reply-context, scope guard). These are the feel; they move first, unchanged.
   Nothing here depends on the store or the scheduler, and every later step inherits a Wire that
   already works and is already tested — moving it early means it's never the thing under test
   later when everything else changes around it.

3. **Land `run/`** on the Agent SDK; prove it on `beckett quick` (no-ticket lane): spawn, stream,
   steer + echo-ack, structured output, `maxBudgetUsd`, resume. Add `run/terra.ts` behind the
   same interface, behind preflight.
   `quick` is the lowest-stakes lane in the product — no ticket, no board entry, no dependent
   work. Proving the hardest new mechanics (streaming steer, budget rails, session resume) there
   validates them against real traffic before a single job depends on them.

4. **Land the Supervisor behind a flag** — new work files to `job`, old work drains through the
   dispatcher. **Dual-write for one week**, quantitative acceptance bar: outcome rates against the
   measured baselines (terra-high 14% failure, opus-4.8-high 18%), spend and latency Events
   compared side by side.
   This is the load-bearing parallel-run step: v0 and v1 are both live, v0 owns nothing new, v1
   owns nothing old. **This is also the rollback boundary.** As long as step 5 hasn't run, killing
   the flag returns to pure v0 with zero code deleted — the bar is quantitative specifically so
   "roll back" is a clear decision, not a vibe.

5. **Cut the ticket rails.** Delete `src/bored/`, tracker poll/cast/client, dispatcher, outboxes,
   `src/task/`, and their tests; rewrite `src/shell/main.ts` to boot Supervisor + Wire.
   **This is the cutover** — the only step that deletes code with no live counterpart to fall back
   to, and it only happens after step 4's bar clears. Past this point, rollback is a `git revert`
   to the last pre-cut tag and a redeploy, not a flag flip — there is no dual-write to fall back
   into once bored and the dispatcher are gone.

6. **Flip the identity rail** to `jN`; 30-day alias map in `kv`, then drop.
   Waits for step 5 because the alias map exists to bridge `OPS-N`/`#N.x` references humans
   already have open in threads and bookmarks — flipping identity before the old rails are gone
   would mean running two live identity systems at once for no reason.

7. **Re-point doctrine** (`intake`/`plan`/`supervise`/`resume` skills to `job.*` verbs); delete
   `basm`; move stage prompts into `agents/`.
   Skills are prompts, not runtime code — re-pointing them is only safe once the `job.*` MCP
   surface they call is the only surface that exists. Re-pointing earlier means shipping a skill
   that calls a tool the Supervisor doesn't serve yet.

8. **Attack the concierge, in lever order, each measured**: progress-out-of-model first (biggest,
   zero product risk); then the front-desk cutover — **must show ~3× expensive-seat turn
   reduction or it rolls back**; then 60k rotation + cache-stable prefix; then the Sonnet mind
   flip with a week of side-by-side spend Events.
   Ordered by leverage over risk. Moving progress off the model touches zero product behavior —
   cards already render off `job`/`event` rows by step 2 — and buys most of the savings alone.
   Every subsequent lever is measured before the next is taken and rolls back independently; see
   [token-efficiency.md](token-efficiency.md) for the dollar model this bar is checked against.

9. **Feel pass + retire compensators.** Hold-and-cancel gate, beat tuning, gate-nudge-once; run
   the ten-conversations acceptance checklist live; with the poller gone, verify the ready-rule is
   the only scheduling authority in the dispatch path; delete `poke`/`observe`/`onAdvance` and the
   staffing watchdog.
   Last on purpose — it's the step that certifies nothing is quietly still polling. The
   compensator code (§ below, "what v1 done means") only gets deleted after there's live proof
   nothing calls it, not before.

10. **Arm initiative, one trigger at a time.** Land `trigger`/`trigger_fire`, the ~300-line
    evaluator, and `beckett initiative`/`why`/`signal`; delete `src/routine/`
    with its tests (`src/dream/` is already gone, deleted in the v7 debt sweep). Then arm exactly
    one trigger — `job_stuck`, `posture='ask'` — and leave it
    there for a week against [initiative.md](initiative.md)'s three-conversation gate: a quiet
    week shows zero attributable tokens in the ledger, a true condition produces exactly one job,
    and `beckett initiative off` mid-fire kills it and survives a restart with the latch intact.
    **Deliberately after everything else**, including the feel pass. Unprompted work is the worst
    possible first customer for machinery nobody has watched under load, and every ceiling in the
    initiative design (`max_per_day`, the daily ledger, `max_initiative_workers=1`) is only
    meaningful once the spend Events it reads are the ones the live system writes. Rollback is one
    command and is the same command a human uses in anger: `beckett initiative off`.

## Host migration: VPS → Omarchy

v0 runs on an Ubuntu/Debian VPS, root/sudo install, one unprivileged `beckett` systemd-user
account. v1 targets the owner's Omarchy (Arch + Hyprland) desktop under the same account model, a
different box — a target-host swap, not an architecture change. `ensure_beckett_user()`, linger,
and every existing `systemd --user` unit already work unchanged on Arch; `systemd`/user semantics
aren't distro-specific. Full detail in [omarchy.md](omarchy.md); the parts that bear on this plan:

- Package install swaps apt→pacman in `install.sh` (`install_base_packages`,
  `install_github_cli`) — mostly a rename table, and several packages (`github-cli`, `chromium`,
  `ripgrep`, `jq`) ship by default on a stock Omarchy box already.
- Playwright's `install-deps` only drives apt; the Arch port needs a hand-maintained pacman
  dependency list or the AUR `playwright` package — the one real unresolved gap, verified via the
  existing `bun run browser:smoke` opt-in check rather than assumed.
- Computer-use moves from BetterWright's sandboxed-Chromium-only lane to a real desktop session: a
  headless Hyprland instance (`WLR_BACKENDS=headless`) under beckett's own `systemd --user` unit,
  `beckett` in the `render` group for GPU-accelerated capture — see
  [computer-use.md](computer-use.md) and omarchy.md.
- Secrets migration is the existing age-encrypted backup/restore path (`deploy/host-setup.md`),
  unchanged — moving hosts doesn't change how `.env`/`config.toml` are protected.

This migration is independent of the orchestration cut — the Supervisor doesn't care which host
runs its `systemd --user` process. Sequence it before, during, or after the build order above;
nothing in that order depends on which host is running it.

## What "v1 done" means

The release gate is the ten-conversations acceptance checklist ([discord.md](discord.md) §Acceptance): banter
silence, question-no-ticket, ≤4s ack, honest "how's it going", steer receipts, cheap stop,
zero-token gates, hours-later resume, "why did you do it that way" recall, truthful post-crash
state. Underneath that product-level gate, every must-survive behavior from the inventory needs a
concrete home before step 5 (the cutover) can run:

- [ ] **Steering is never lost** — `job.say` writes the Event row before anything else happens;
      `delivered`/`queued` receipts replace the four-state honesty machinery (orchestration.md §3.2)
- [ ] **Progress is origin-routed** — every job carries its Discord origin channel; the card is
      driven off `job`/`event` rows with no reconciler (§6)
- [ ] **Review has tiers with bounded rework** — `self`/`fresh` as a cast choice, rework capped at
      3 (§3.3)
- [ ] **Dependencies resolve correctly, including branch basing** — `deps[]` + `join_policy`,
      dependency-branch basing kept as explicit code, not assumed away (§3.4)
- [ ] **Restart never silently restarts from scratch** — `session_id` + `cwd` + WIP checkpoint,
      boot reconcile pass, unresumable → held with the sha, never a silent respawn (§3.5)
- [ ] **Spend caps are enforced, not just logged** — `budget_usd` subtree ceiling, `maxBudgetUsd`
      spawn-time rail, conversational overrun gate (§3.7)
- [ ] **Human gates cost zero tokens while parked** — `runner='human'` rows are never spawned; one
      nudge at 24h, then silence forever for a gate a human is waiting on, and expiry at
      `gate_ttl_h` (48h) for one Beckett raised on its own initiative (§3.9, §3.14)
- [ ] **Cancel is clean and reversible** — subtree cancel, branch kept and pruned after 7 days, the
      hold-and-cancel staleness re-check (§3.10)
- [ ] **Failure ladders are bounded** — one policy table drives stall/rate-limit/auth/substantive
      handling, no per-stage ladder code (§3.11)
- [ ] **Done means the link resolves** — a verify child gates the parent's `done`, both ways
      (§3.12)
- [ ] **Casting economics hold** — terra stays behind preflight, haiku runs every non-code job,
      escalation happens at most once per job (§3.13)
- [ ] **No poll survives in the dispatch path** — the ready-rule is the only scheduling authority;
      `poke`/`observe`/`onAdvance`/the staffing watchdog are deleted, not dormant (build order
      step 9). The trigger evaluator's 60s tick is the one named exception and it schedules
      nothing but initiative (orchestration.md §0, §3.14)
- [ ] **The concierge cost bar is hit** — $250–400/mo, each lever in step 8 measured independently
      against [token-efficiency.md](token-efficiency.md)'s dollar model
- [ ] **Unprompted work is bounded, announced, and killable** — a trigger is armed only through a
      human gate, fires idempotently on `(trigger_id, fire_key)`, is capped by `cooldown_secs` /
      `max_per_day` / `initiative_daily_usd` / `max_initiative_workers`, announces itself in one
      line, and dies to `beckett initiative off` — latched (build order step 10, §3.14)

Every box above is a row or a column on `job`/`event`, not a new subsystem — that's the point of
the cut. When all of them are checked and the ten-conversations checklist passes live, `docs/`
and this repo describe the system actually running, not the one being migrated away from.
