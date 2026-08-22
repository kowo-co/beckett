# Dead-code audit — what's actually running vs. what isn't

Prompted by ro: *"That codebase is a massive dumpster fire … idk what code is running because
half of it is like duplicated and custom tools not even used anymore."* This is the honest map,
plus a first, deliberately conservative deletion pass over the tier that's provably dead.

## Method

1. **`scripts/ops/dead-exports.ts`** (pre-existing) is the primary tool: a regex + specifier-
   resolution census of every module-level export in non-test `src/**`, walked against every
   importer in `src/`, `scripts/`, `tests/`, `bench/`, `deploy/*.ts`. A symbol with zero importers
   is `dead`; one imported only from `*.test.ts` is `test-only`. It understands static named/
   namespace imports, `export * from`, and the two dynamic-import shapes this repo actually uses.
   Full current output: `bun run dead-exports` (or `--json` for the complete list — 582 dead +
   432 test-only entries as of this sweep; see `scripts/ops/dead-exports.baseline.json`).

2. **A file-level orphan check** (this audit, not committed as tooling): for every `.ts`/`.tsx`
   file anywhere in the repo, does *any* other file reference it via a resolvable relative
   specifier — named import, namespace import, `export … from`, or a dynamic `import()`? This
   catches whole dead *modules*, which the export-level census can't (a barrel file can have every
   individual export flagged, or none, without the census ever telling you the barrel itself is
   unimported). Only **4 files** in `src/` had zero such references: `src/cli/beckett.ts`,
   `src/shell/main.ts`, `src/test/fake-harness.ts`, `src/routine/index.ts`. The first three are
   entry points executed by path, not import (see the "keep" section); the fourth is genuinely
   dead and is deleted below.

3. **A bug found and fixed in the census tool itself**: `dead-exports.ts` mis-recorded aliased
   named imports. `import { workerId as mintWorkerId } from "../ids.ts"` was logging usage of
   `mintWorkerId` (the caller's local alias) against `ids.ts`, which never matches any real
   export there — so the census reported the **actually-used** `workerId` as dead. This is a real
   bug, not a one-off: any aliased import of any symbol anywhere in the repo was invisible to the
   tool. Fixed in this PR (`scripts/ops/dead-exports.ts`'s `parseImportList`, distinct from the
   export-list parser, which has the opposite alias semantics) with a regression test. **This
   bug is exactly why deletions below were re-verified with a plain repo-wide `grep` for the
   symbol name before being touched — the census's "dead" verdict was a lead, never the final
   word.**

4. **Real-usage evidence on this box**: `~/.beckett/` is readable. Checked `daemon.log` (tiny —
   just start/stop lines), `events/dispatch.jsonl` (4,033 lines — run/ticket *stage* telemetry
   only, not capability invocations), and `channels/*.jsonl` (message transcripts, no tool-call
   trace). **None of these give a structured per-capability invocation count** — there is no
   "capability X was invoked N times" log on this box. Where that matters below, it's called out
   explicitly rather than asserted.

5. **Systemd units on this box**: `systemctl --user list-unit-files 'beckett*'` lists eight units.
   Five run code from *this repo* (its production checkout at `~/beckett` — a separate clone from
   this worktree, same source): `beckett-v4.service` (`bun src/shell/main.ts`, **currently
   active** — the daemon this whole audit traces from) and `beckett-dev.service` (the identical
   `src/shell/main.ts` entry point, a second instance in a separate `~/beckett-dev` checkout,
   isolated by `BECKETT_DIR`/`BECKETT_HOME`/`BECKETT_PROJECTS_ROOT` env overrides — currently
   inactive, started on demand per its own unit comment, "DEPLOYERS MUST NOT enable it");
   `beckett-heartbeat.service`/`.timer` (`deploy/heartbeat.sh` → `bun src/cli/beckett.ts doctor`,
   weekly — confirmed via `systemctl --user list-timers`: last fired 2026-08-17, next due
   2026-08-24); `beckett-alert@.service` (`deploy/alert.sh`, fired on the daemon's own failure);
   and **`beckett-secret.service`** — `bun src/cli/beckett.ts secret serve --port 8799`,
   **currently active** — a second, independent long-lived process entry point into this codebase
   beyond `shell/main.ts`, traced in § 3 below. The remaining three units are **not this repo**:
   `beckett-redesign.service` (a static file server for the unrelated `beckett-redesign` project's
   build output, currently active) and `beckett-metrics-site.service` (points at a now-deleted
   worktree from a finished, unrelated run — `systemctl` itself reports its load state as `bad`;
   an orphaned unit, not a code path in *this* repo, noted here only because "check systemd"
   surfaced it, not because it's this codebase's dead code). Net finding: the one genuinely new
   entry point systemd surfaced that the import-graph trace above hadn't already covered is
   `secret serve` — folded into the CLI-verb enumeration in § 3.

Every deletion below was independently re-confirmed with a repo-wide `grep -rn '\bSYMBOL\b'`
across `src/`, `scripts/`, `tests/`, `bench/`, `deploy/` (not just the census's word), specifically
looking for aliased imports, before being removed.

---

## 1. Unreferenced modules

### `src/routine/index.ts` — DELETED (provably dead)

A barrel: `export * from "./types.ts"` / `./schedule.ts` / `./plan.ts` / `./builtins.ts` /
`./model-news.ts` / `./rate-limit.ts`, plus named re-exports of `watch-store.ts`, `watch.ts`,
`store.ts`, `scheduler.ts`. Its own header claims it's the "Public surface for the daemon
(`boot()`), the CLI (`beckett routine`), and tests" — but nothing imports it. `shell/main.ts`
imports `createRoutinesExtension` from `../capability/modules/routines.ts`, which in turn imports
`RoutineStore` from `../../routine/store.ts` and the scheduler from `../../routine/scheduler.ts`
**directly**, never through this barrel. Grep for `routine/index` or a bare `"../routine"`/
`"./routine"` specifier: zero hits anywhere in the repo.

**Evidence**: zero entries in the file-level orphan check above; `git grep` for the barrel path
comes back empty; deleting it and re-running `bun run test` + `bun x tsc --noEmit` stayed green.

**Side-effect worth flagging, not chasing further**: this barrel's `export * from` lines were
quietly keeping ~30 exports in `src/routine/{types,schedule,plan,builtins,model-news,rate-limit,
scheduler,store,watch,watch-store}.ts` marked "live" in the census (an `export *` counts as a
namespace-use of every export in the target). With the barrel gone, the census now correctly
shows those as `dead` or `test-only` on their own merits (`scripts/ops/dead-exports.baseline.json`
was updated to the new, more honest counts: dead 608→582, test-only 418→432 — the prior committed
baseline, confirmed via `git show 44be996:scripts/ops/dead-exports.baseline.json`). **This audit does
not delete those newly-exposed entries** — they need their own look (some, like
`RoutineSchedulerDeps`/`WatchLoop`, are plainly test-seam types; others may be genuinely stale) —
they're the visible tip of "the barrel was hiding real dead-ness," not new dead-ness this PR
introduced.

---

## 2. Duplicated implementations

### `worktreeExists()` (`src/worker/worktree.ts`) vs. plain `existsSync()` — DELETED the loser

`worktreeExists(repoRoot, workspace)` ran `git worktree list --porcelain` and did a symlink-
tolerant path comparison — a *more correct* check than a bare filesystem stat (handles a worktree
whose directory was moved/relinked without git being told). But every real call site in the same
file (`createWorktree`'s `reuseIfExists` branch, the legacy-path migration, `removeWorktree`'s
fallback) uses plain `existsSync(workspace)` instead. `worktreeExists` was never called — not
even from within its own file. **Two ways to answer "does this worktree exist," and the codebase
runs on the less-correct one everywhere.** Deleted the unused one (and its private `canon()`
helper, whose only caller it was); did not touch the `existsSync` call sites — swapping working
behavior for "the more correct" one is a judgment call for a human, not a deletion-pass green light.

### `DiffStat` interface duplicated between `src/git/diff.ts` and `src/worker/worktree.ts` — DELETED the vestige

`src/git/diff.ts`'s own header says it's "THE `git diff --numstat` parser (issue #19 — previously
hand-copied in all three drivers and the supervision tailer)" — i.e. it's the already-completed
consolidation of a duplicated diff-stat implementation. `worktree.ts` still had its own leftover
`export interface DiffStat { files; added; removed }` from before that consolidation — declared,
never used as a type anywhere (not a param, not a return type, not re-exported, not imported),
grep confirms one hit in the whole repo: the declaration itself. Deleted. (`git/diff.ts`'s own
`DiffStat` is untouched — it's the real one, used as `diffStatSync`'s return type, just not
imported by name elsewhere, which is normal for a locally-consumed type.)

### `createX()` factory wrappers that nothing calls — DELETED all six

Six modules each define a plain function that does nothing but `return new X(...)`, alongside the
class `X` itself. In every case, every real call site in the repo constructs the class directly
with `new X(...)` — the wrapper function is a dead twin nobody adopted:

| Wrapper (deleted) | Class (kept, used via `new X(...)` at real call sites) |
|---|---|
| `createRunStore` (`src/run/store.ts`) | `RunStore` — `cli/core.ts`, `cli/proposal-cli.ts`, `shell/main.ts` |
| `createTaskStore` (`src/task/store.ts`) | `TaskStore` — `cli/core.ts`, `cli/proposal-cli.ts`, `cli/loops-cli.ts`, `concierge/index.ts`, `shell/main.ts` |
| `createTaskCardService` (`src/task/card.ts`) | `TaskCardService` — `concierge/index.ts` |
| `createCcusageSource` (`src/status/ccusage.ts`) | `CcusageSource` — `status/snapshot.ts` |
| `createSessionPool` (`src/concierge/session-pool.ts`) | `SessionPool` — `concierge/index.ts` |
| `createTurnGate` (`src/concierge/turn-gate.ts`) | `TurnGate` — `concierge/index.ts` |

**Evidence**: repo-wide `grep -rn '\bcreateX\b'` for each, zero hits outside the declaring file's
own `export function createX(...) { return new X(...); }` line. Not test-only either (no test
imports them). All six confirmed unaffected by the aliased-import bug (§ method note 3).

### `classifyAction()` + the merge/email handshake constants (`src/agency/index.ts`) vs. per-capability `ActionClass` — PROBABLY DEAD, NOT DELETED (see § 4 below, flagged not removed)

This is the most consequential duplicate found and deliberately **not touched** — see the
"probably dead" entry in § 4, because it's a security-classification function and warrants a
human call, not an autonomous deletion.

### Four barrels with a live-but-redundant re-export surface — NOT touched (documented only)

`src/agent/index.ts`, `src/capability/modules/index.ts`, and `src/ext/index.ts` are all *live*
barrels (imported by `shell/main.ts` and/or `concierge/index.ts` and/or `dispatch/stages.ts`) —
unlike `routine/index.ts`, these are not orphans. But each also re-exports several
symbols that nothing imports *through the barrel path* — callers reach the concrete module
directly instead (e.g. `capability/modules/routines.ts` imports `RoutineStore` from
`../../routine/store.ts`, not from the `agent`/`capability` barrels). This is the same
duplicated-access-path pattern as the barrel above, just without the barrel itself being fully
dead. Left alone: trimming a live, actively-imported file's export list is an edit to surviving
code, which this pass is scoped to avoid. Listed in § "unclear" for a human to decide whether to
consolidate on one import style.

---

## 3. Custom tools / capabilities / CLI verbs registered but never invoked

Cross-referenced `src/ext/registry.ts` (the v6 registration seam) and `src/capability/modules/
index.ts` (the v5 `FACTORIES` table `dispatch/stages.ts` builds a `CapabilityRegistry` from)
against what `shell/main.ts` actually registers at boot (`extensions.register(...)` calls: stages,
image, secret, browser, quick, routines, reminders, memory — all present and wired) and against
what `capability/modules/index.ts`'s `FACTORIES` table wires (github, dns, deploy, image, mail,
memory, secret, codemap — all present).

**Result: nothing found that's registered in the live table and never dispatched.** Every
capability/extension id in both tables traces to a real registration call in `shell/main.ts` or
`dispatch/stages.ts`. As noted in § method (4), there's no invocation-count log on this box to
independently confirm real *traffic* to each one (only that the wiring exists) — that's the honest
limit of what could be checked here, not a claim that every capability sees regular use.

One clear exception, documented under "keep, but it looks dead" below because it's an intentional
fixture, not an accident: `createPingExtension` (`src/ext/example.ts`) is registered **only**
in `ext/registry.test.ts` and `concierge/ext-bus.test.ts` — never in `shell/main.ts`. It is a
named example/test extension, not a production one; its own header says as much.

### CLI verbs (`src/cli/spine.ts`) — a separate registration seam from the two above

`spine.ts` is the static routing table `cli/beckett.ts` resolves argv against before loading any
verb body: **38 top-level entries**, covering **46 distinct verb-name strings** (some entries
register more than one — e.g. `discord` → `discord reply|ack|react|decline|delete`). A CLI verb
here doesn't require anything to be registered at daemon boot; `cli/beckett.ts` resolves and
lazy-loads it independently of the extension/capability tables above. This is exactly the surface
the first pass of this audit skipped — every entry in `spine.ts` trivially "passes" a check of
"is it wired to run" (`resolveVerb` would dispatch any of them correctly), so the only meaningful
question is whether anything *outside the verb's own implementation and tests* actually invokes it
by name. As with capabilities (§ method note 4), there is no per-verb invocation counter on this
box — what follows is "a real caller exists," not a traffic count.

**Confirmed live — invoked by name from a subprocess spawn, a systemd unit, or a deploy script in
this repo** (code or a unit file names the verb, not just prose):

| Verb | Real caller |
|---|---|
| `status` | `deploy/run-drain-guard.ts` spawns `bun src/cli/beckett.ts status` as a deploy preflight |
| `browser status` | `deploy/browser-drain-guard.ts` spawns it the same way |
| `doctor` | `deploy/heartbeat.sh`, fired weekly by `beckett-heartbeat.timer` (§ method note 5) |
| `version` / `version bump` | `deploy/deploy-prod.sh:91` runs `version bump` every production deploy; `src/ops/doctor.ts`'s own health check execs plain `beckett version` as a daemon-PATH smoke test |
| `routine deps-update` | `src/ops/deps-update.ts` / `scripts/ops/deps-update-rehearsal.ts` spawn the CLI with this verb for the weekly dependency job |
| `secret serve` | `beckett-secret.service` — systemd, **currently active** on this box — runs `bun src/cli/beckett.ts secret serve --port 8799` as a standing process (§ method note 5) |
| `free-time run` | not a deploy-script spawn, but dispatched from *inside* the daemon: `src/routine/{plan,scheduler,builtins}.ts` document and run the weekly `weekly-free-time` routine's SELF-lane body as a contained `beckett free-time run` subprocess (`docs/freetime.md`) |

**Confirmed live — named in the concierge playbooks or README** (`src/concierge/playbooks/*.md`,
`README.md`): these files are loaded into the live concierge's own operating instructions, not
just written documentation — a verb named here is one the running concierge is actually told to
run, which is real usage evidence, not a hypothetical example. Of the 31 spine entries not already
covered by the table above, 27 have at least one such reference: `pause`/`resume`, `concierge`
(`reload` only — `persona`, its sibling verb, is not named anywhere outside its own
implementation, see below), `mail`, `access`, `maintainer`, `federation`, `channels`, `identity`,
`discord`, `proactivity`, `quick`, `agent` (`invoke`), `image`, `eval`, `site`, `task`, `finish`,
`github` (`gh`), `dns`, `deploy`, `memory` (`recall`, `remember`, `maintain`), `loops` (`link`, via
`src/memory/CLAUDE.md`), `calibration` (`veto`), `proposals` (`file`), `spend`, `journal`, `config`
(`print-default`). (`browser`'s remaining subcommands — task/watch/steer/stop/exec, beyond the
`status` one already confirmed above — are playbook-referenced too, but `browser` was already
counted in the first table.)

That leaves **4 entries plus 1 sub-verb with no found caller anywhere outside their own source and
tests** (7 script/systemd-confirmed + 27 playbook-confirmed = 34 of 38 entries accounted for) —
not "provably dead" (a human-operator CLI verb absent from a doc is a different claim than
"nothing reaches it," and `resolveVerb`/`composeCliHelp` prove each is correctly wired and would
run today), but genuinely **unclear**, carried into § 5:

- **`concierge`'s `persona` verb** — `reload` (its sibling in the same spine entry) is confirmed
  live above; `persona` itself has no caller found outside `src/concierge/index.ts`.
- **`observed`** — backed by a real, actively-maintained module (`src/discord/observed.ts` +
  `observed-bots.ts`, a "living file" per its own header), but no playbook, README line, or script
  names `beckett observed` by verb.
- **`preset`** — `src/run/presets.ts`'s own header describes `beckett preset show <name>` as the
  intended read path, but actual cast-preset *consumption* happens in-process (the run supervisor
  reads `~/.beckett/presets.json` directly, not through this CLI verb); no playbook or script
  invokes the verb itself.
- **`chilltext-log`** — a diagnostic tail of the chilltext transform log, backed by a real store
  (`src/concierge/chilltext-log.ts`) and advertised in `cliHelp`, but not named in any doc or
  script found here.
- **`reminders`' `remind` verb** — `src/reminder/*` is a real, tested subsystem; reminders are
  plausibly created some other way (a bus/capability surface, not this CLI verb) — but `beckett
  remind` by name has no found caller.

---

## 4. Keep, but it looks dead

- **`src/shell/main.ts`, `src/cli/beckett.ts`** — the daemon and CLI entry points. Zero files
  import them (confirmed by the orphan check) because nothing needs to — they're run directly
  (`bun src/shell/main.ts`, `bun src/cli/beckett.ts`, per `package.json`'s `v4`/`beckett`
  scripts and `"module": "src/shell/main.ts"`). A static import graph will always flag an entry
  point as "unreferenced"; that's a feature of the census, not evidence of dead code.

- **`src/test/fake-harness.ts`** — same shape, one level deeper: nothing `import`s it either, but
  `tests/resume.e2e.test.ts` spawns it as a real subprocess by absolute path
  (`FAKE_HARNESS = join(REPO_ROOT, "src/test/fake-harness.ts")`, then `bun <path>`), standing in
  for `harness.claude.bin`. Invisible to any import-graph tool by construction.

- **`src/worker/worktree.ts::mergeBranchesIntoWorktree`** — already flagged and pinned in
  `scripts/ops/dead-exports.ignore.txt` ("B9 (runs lane) calls it"); left exactly as-is, and its
  own test (`dead-exports.test.ts`) already asserts the ignore-file line survives. Not re-litigated
  here; noted because it's the existing example of this exact category.

- **`src/ext/example.ts::createPingExtension`** — see § 3: an intentional example/test extension,
  registered only from `ext/registry.test.ts` and `concierge/ext-bus.test.ts`. It exists to
  exercise the registry mechanism (registration, catalog rendering, `ext.invoke` dispatch) without
  a real extension's side effects. Deleting it would just make the registry's own test suite worse
  at testing the registry.

- **`src/cli/finish.ts`'s re-export of `CHECKS_GRACE_MS` and `MergeGate`** (from `./land.ts`) —
  the census flags both as dead-via-this-path (finish.test.ts imports `describeMergeFailure` and
  `gateMerge` from `finish.ts`, but not these two). But the file's own header comment is explicit:
  "The merge gate and its blocker prose live in land.ts … and are re-exported here because they
  ARE `beckett finish`'s contract — the messages an operator reads when it stops — and its test
  suite pins them at this address." That's a deliberate API-surface decision documented in the
  code, not an accident. Left alone even though the *current* test doesn't happen to import those
  two specific names — the comment is a promise to future callers, and second-guessing it isn't
  what this deletion pass is for.

- **`~30 routine/*.ts exports newly exposed by deleting `routine/index.ts`** (§ 1) — flagged
  there as a side-effect to look at separately, explicitly not swept into this pass.

---

## 5. Unclear — left for a human call

- **`src/agency/index.ts::classifyAction`, `mergeHandshakeSpec`, `isSharedBranch`,
  `MERGE_HANDSHAKE_SHORT`, `SEND_EMAIL_HANDSHAKE`** — probably dead, **not deleted**. The file's
  own header describes `classify()` (the function is actually named `classifyAction`) as
  "the security invariant: if it isn't classified FREE or HANDSHAKE_GATED, it cannot happen on the
  autonomous path" (Spec 07 §2.3) — but grep shows `classifyAction` is called nowhere, not even
  within its own file. The action-classification that's actually live today is a different,
  newer mechanism: each capability/extension module declares a static `actionClass: ActionClass
  .FREE|...` field directly (`capability/modules/{cloudflare,github,mail,memory,secret,...}.ts`),
  read by `ext/contract.ts`'s `effectiveActionClass` — no dynamic `classify(type, ctx)` call
  anywhere in that path. This looks exactly like ro's "duplicated, not even used anymore"
  complaint: an old Spec-07-era classification function, superseded by a newer per-capability
  declaration style, left in place. **Not deleted** because (a) the file's header explicitly
  frames it as a security-critical invariant, and a false "dead" verdict here would be far more
  costly than leaving stale code in place, and (b) confirming *no* remaining dynamic/reflective
  call path touches it deserves a human, not a regex census, given what it's guarding. Recorded
  here at "probably dead, needs a human" rather than deleted or ignored.

- **Barrel re-export surfaces on `agent/index.ts`, `capability/modules/index.ts`, `ext/index.ts`**
  (§ 2) — live files, dead-only-via-that-import-path re-exports. A consolidation call (should
  callers standardize on the barrel or the concrete file?), not a deletion.

- **Five `src/cli/spine.ts` CLI verbs with no found caller outside their own source/tests** (§ 3):
  `concierge persona`, `observed`, `preset`, `chilltext-log`, `remind`. All five are correctly
  wired (`resolveVerb` would dispatch each one today) and back real, non-trivial modules — this is
  "no doc or script names it," not "nothing reaches it." A human who knows whether these are still
  used interactively can settle it in a way this pass can't.

- **The ~30 routine/*.ts exports exposed by removing the dead barrel** (§ 1, § 4) — genuinely
  unclear until someone looks at each one; some are plainly test-seam types, others may be stale.

- **The remaining ~550 `dead`/`test-only` census entries not discussed by name above** — the
  large majority of the census is exported types/constants/helpers that are used *within their
  own file* but happen not to be imported by name from anywhere else (e.g. a return-type
  `interface` nobody needs to name, or a helper called only by its neighbor in the same module).
  That's export-surface noise, not dead code — the underlying logic runs. Distinguishing "genuinely
  dead" from "over-exported but load-bearing" for every one of ~550 entries individually was out
  of scope for one pass; the ones investigated here were chosen because they had a concrete
  duplication story or a whole-file signal. The full list is always available via
  `bun run dead-exports` for the next pass.

---

## What was deleted (provably dead — import graph + repo-wide grep + green tests)

| File | What |
|---|---|
| `src/routine/index.ts` | whole file — dead barrel, zero importers anywhere |
| `src/worker/worktree.ts` | `DiffStat` interface (superseded, zero usage), `worktreeExists()` + private `canon()` helper (unused, duplicate of the `existsSync` checks actually in use), unused `realpathSync` import |
| `src/run/store.ts` | `createRunStore()` — dead factory wrapper |
| `src/task/store.ts` | `createTaskStore()` — dead factory wrapper |
| `src/task/card.ts` | `createTaskCardService()` — dead factory wrapper |
| `src/status/ccusage.ts` | `createCcusageSource()` — dead factory wrapper |
| `src/concierge/session-pool.ts` | `createSessionPool()` — dead factory wrapper |
| `src/concierge/turn-gate.ts` | `createTurnGate()` — dead factory wrapper |
| `src/ids.ts` | the entire ULID sub-system (`ulid`, `eventId`, `ulidId`, `CROCKFORD`/`encodeTime`/`randomChars`/`incrementRand` and friends) and the unused prefixed-id wrappers (`taskId`, `nodeId`, `criteriaId`, `gateOutcomeId`, `checkInId`, `nudgeId`, `escalationId`, `outcomeId`, `requestId`) — a Spec-09/10-era id scheme with zero live callers (kept `prefixedId`, `hex`, `pendingActionId`, and `workerId`, all of which are genuinely used — `workerId` only via an aliased import, see § method note 3) |
| `src/system-metrics.ts` | `readSystemMetrics()` — dead one-off convenience wrapper around `createSystemMetricsReader(...).read()` |
| `src/dispatch/publish-outbox.ts` | `MAX_PUBLISH_RETRY_DELAY_MS` — dead constant, never read anywhere |
| `src/concierge/index.ts` | `artifactLinkFrom()`, `isRoutineNoiseComment()` — dead comment-parsing helpers from an old GitHub-comment-based dispatch narration path, superseded by the Discord digest feed (`dispatch/digest.ts`, `dispatch/digest-feed.ts`) |
| `scripts/ops/dead-exports.ts` | **bug fix**, not a deletion: aliased named imports (`import { a as b }`) were recorded under the caller's local alias instead of the source export name, producing false "dead" verdicts for anything imported with a rename (caught `workerId`, restored below) |
| `scripts/ops/dead-exports.test.ts` | added a regression test for the alias bug |
| `scripts/ops/dead-exports.baseline.json` | updated to the post-deletion counts (see below) |

### Counts

- **Files removed**: 1 (`src/routine/index.ts`)
- **Files modified**: 10 other `src/` files + `scripts/ops/dead-exports.ts`/`.test.ts`/
  `.baseline.json` (14 files touched total, plus this doc)
- **Net lines removed**: -156 (209 deletions, 53 insertions — the insertions are almost entirely
  the new regression test + the `parseImportList` bug fix in `dead-exports.ts`, not new product
  code; full diff is authoritative — `git diff --stat 44be996..HEAD`)
- **Confidence tiers**:
  - **Provably dead / deleted this PR**: 1 whole file + 14 individual symbols across 10 files
    (table above), plus one dead barrel's cascading effect on ~30 further `routine/*.ts` exports
    (exposed, not deleted).
  - **Probably dead, left in place**: `agency/index.ts`'s `classifyAction` + merge/email handshake
    cluster (5 symbols); the ~30 newly-exposed `routine/*.ts` exports; the barrel-redundant
    re-exports in `agent/index.ts` / `capability/modules/index.ts` / `ext/index.ts`.
  - **Unclear (needs a human, not further static analysis)**: 5 `cli/spine.ts` CLI verbs with no
    found caller outside their own source/tests (`concierge persona`, `observed`, `preset`,
    `chilltext-log`, `remind` — § 3); the remaining ~550 census entries not individually
    investigated here — see `bun run dead-exports` for the full current list.

## Follow-up: census `testOnly` 432 → 433 on merge with main

Merging this branch with `main` (after #344) made **`src/progress/training-sources.ts::BABBLE_TOKEN_BUDGET`**
test-only: the constant is used only inside that module, plus one assertion in
`training-source.test.ts`. It is not a public seam. Un-exported it (kept module-local); the test
still checks the production config via `defaultFileTailProgressSources(...)[0].tokenBudget`.
Baseline left at `dead: 582` / `testOnly: 432`.

## Verification

- `bun run test`: **green** (3845 pass, 2 skip, 0 fail after the census follow-up).
- Original sweep: `bun run test` **green** (3840 pass, 2 skip, 2 fail — both failures were
  pre-existing on `44be996` before this PR touched anything: `dispatch/spawn.test.ts`'s
  betterwright-binary-cwd test and `drivers/cursor.test.ts`'s credential-preflight test;
  confirmed via `git stash` against the unmodified tree).
- `bun x tsc --noEmit`: **green**, modulo the same pre-existing `src/drivers/cursor-runner.ts`
  errors (missing `@cursor/sdk` type declarations + two unrelated `any`/`unknown` narrowings),
  also confirmed present on `44be996` and untouched by this PR.
- Daemon smoke test (no restart of the live service): dynamically `import()`ed
  `src/shell/main.ts`'s full module graph in a throwaway `bun -e` process — resolved cleanly,
  `BECKETT_VERSION` read back correctly. Did the same for `src/concierge/index.ts` (39 exports,
  resolved cleanly) and `src/cli/beckett.ts` (module graph loaded and ran its own argv dispatch,
  which is why it printed a usage error for the harness's own unrelated flags — that's the CLI
  working correctly, not an import failure).
