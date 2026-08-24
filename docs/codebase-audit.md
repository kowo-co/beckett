# Codebase audit — what's slop, what's not standard, what a factory would need

Written for ro, who asked to "clean the codebase, get rid of the slop and make it more
streamlined for Agent Factories," and who wants to be able to open this repo and fix things
himself.

Every claim below carries a file and a line. Where something looks dead but couldn't be proven
dead, it's listed as unproven rather than asserted. Read from the code, not from the docs — the
docs turned out to be one of the findings.

The size of the thing: **91,167 lines** of source in `src/` plus **70,912 lines** of tests, in
535 TypeScript files. That is not the problem by itself. The problems are below.

---

## The top ten, ranked by how much clunk they cause against how cheap they are to fix

| # | What's wrong | Where | The fix |
|---|---|---|---|
| 1 | A run is marked **done while its pull request is still open and unmerged**. The proof rules check that the PR resolves and that CI is green — they never ask whether it merged. | `src/run/proof.ts:65-80` | Add a `merged` fact to `ProofFacts` and require it for the `pr` landing mode. Half a day. |
| 2 | 23 source files name **`docs/v6-architecture.md`** as the contract they implement. That file does not exist. | e.g. `src/ext/contract.ts:9`, `src/capability/modules/github.ts:5` | Write the one-page version of it, or delete the 23 citations. Either beats a phantom. |
| 3 | **Two live plug-in systems**, and the migration between them stopped half-way. The daemon registers 8 v6 "extensions"; the CLI builds 8 v5 "capabilities" from a separate table; six modules carry both shapes, with a shim in between. | `src/capability/index.ts` vs `src/ext/contract.ts`; shims at `src/capability/modules/github.ts:770`, `mail.ts:336`, `secret.ts:324`, `image.ts:148`, `memory.ts:639`, `cloudflare.ts:363` | Finish it: make the CLI read the extension registry, delete the `asCapability` shims and the `FACTORIES` table. |
| 4 | **Four hand-written copies of the same thing**: "one Discord message that a loop keeps editing." Each has its own copy of the anchor file, the deleted-message repost, the never-throw cycle. Three of them say in their own header that they copy one of the others. | `src/status/service.ts:82`, `src/task/card.ts:10`, `src/progress/training-card.ts:7`, `src/dispatch/digest-feed.ts:10` | Extract one `SelfEditingCard` helper and have all four use it. A day, mechanical. |
| 5 | **125 `catch` blocks throw the error away entirely** — no log, no re-raise, nothing. When background work goes quiet, this is why. | Worst: `src/browser/runtime.ts` (13), `src/concierge/index.ts` (11), `src/agency/imagegen.ts` (9) | Not all are wrong, but each should say why. Start with the three files above. |
| 6 | **`src/concierge/index.ts` is 9,088 lines** and 34% of it is comment prose explaining past decisions. It is the file that decides everything a person sees in Discord, and it is the least openable file in the repo. | `src/concierge/index.ts` | Split along the seams that already exist as sibling files (`ambient.ts`, `triage.ts`, `output.ts`, …). |
| 7 | **Four different things are called "deploy"** and none of them means the same as the others. | `beckett deploy` = a tunnel (`src/shell/deploy.ts`); `beckett site deploy` = the apex site; `deploy/deploy-prod.sh` = restart the daemon; `src/preview/index.ts` = a branch preview | Rename three of them. Pure naming, no behavior. |
| 8 | **545 exported symbols that nothing imports.** The public surface of most modules is roughly three times what is actually used, which makes "who calls this?" answer wrongly. | `bun run dead-exports` | Mostly `export` keywords to delete, not code. Mechanical; can be done a directory at a time. |
| 9 | Live code cites **`specs/_legacy/`, `_legacy-v2/`, `_legacy-v3/`** as its contract, while `specs/README.md` says those files are archived history and explicitly "not to be used as an implementation contract." | `src/drivers/index.ts:74`, `src/dispatch/spawn.ts:144`, `src/run/types.ts:4` | Move the three rules those comments actually depend on into the code, drop the citations. |
| 10 | **`src/run/supervisor.ts` keeps roughly 40 private `Map`/`Set` fields** of in-memory run state next to the durable `RunStore`. A restart loses all of it, and no single place says what a run's state is. | `src/run/supervisor.ts:335-436` | Not cheap, but it is the reason "what's happening with that run" is hard to answer honestly. |

Fixed in this pull request (the deletion half of the ticket) is described at the end.

---

## a) Where the slop is

**The provably dead code is mostly gone, and it was less than you'd fear.** The repo already
has a census tool (`bun run dead-exports`) that walks every export against every importer. Run
against the tree before this PR it found 582 exports with no importer. Of those, only 42 were
unused even inside their own file — the rest are over-exporting, not dead logic. This PR
deleted the 42 (plus a whole dead subsystem, below); the count is now 545 and the remaining
entries are `export` keywords on things the module uses internally.

**The one genuinely dead subsystem was the old permission gate.** `src/agency/index.ts`
carried the Spec 07 "action class" machinery — `classifyAction(type, ctx)`, the merge and
email handshake strings, `GateRefused`, and six supporting types in `src/types.ts`
(`ActionType`, `ActionContext`, `PendingAction`, `PendingActionClass`, `HandshakeSpec`,
`GateActionResult`). Its own header called it "the security invariant." Nothing had called it
in a long time — not one caller in `src/`, `scripts/`, `tests/`, `bench/`, or `deploy/`, not
even inside its own file. What actually gates actions today is a completely different
mechanism: each capability module declares a static `actionClass` field which
`src/ext/contract.ts::effectiveActionClass` reads. Two designs for the same job, one of them
switched off years of commits ago and still describing itself as load-bearing. Deleted in this
PR: 282 lines removed across `src/agency/index.ts`, `src/types.ts`, and the id minter that fed
it (`src/ids.ts`, `pendingActionId`).

**Barrels that pretend to be the front door.** `src/agent/index.ts` announced itself as the
"public surface for the daemon, the CLI, and tests" and had exactly one importer, which used
two types out of the eleven it re-exported; everything else in the repo reached past it to the
concrete file. Deleted. Three more barrels had the same problem in weaker form and had their
dead re-export lines removed: `src/capability/modules/index.ts` (14 lines), `src/ext/index.ts`
(3), `src/drivers/index.ts` (7). This matters more than it sounds: while those re-export lines
existed, the census reported ~30 genuinely dead symbols in `src/routine/` and `src/agent/` as
"live," because being re-exported counted as being used. The barrel was hiding the debt.

**Config knobs are clean.** Checked all 58 leaf keys in the config schema
(`src/capability/builtins.ts`) for a reader elsewhere in the tree. Every one has at least one.
Whatever else is wrong here, nobody is carrying dead configuration.

**Leftover files at the repo root.** `shot94.mjs`, `pricing-94.png` (5.4 MB), and
`full_test_output.txt` were checked-in scratch from run #94 — the screenshot script even has
an absolute path to a worktree that no longer exists (`shot94.mjs:20`). Deleted.

**Documentation that points at nothing.** Nineteen distinct `docs/…md` paths are cited from
code or from other docs and do not exist. The important one is `docs/v6-architecture.md`
(finding #2). Others: `specs/README.md` sends readers to `docs/ARCHITECTURE.md`, but the file
is `docs/architecture.md` — on Linux that link is simply broken. Going the other way, three
docs are cited by nothing at all: `docs/mail.md`, `docs/voice-calibration.md`, and
`docs/dead-code-audit.md` (the last is the previous pass of this same audit; its findings are
carried forward here and it is deleted in this PR so there is one audit, not two).

### Suspected dead, unproven — left in place deliberately

- **Five CLI verbs** (`concierge persona`, `observed`, `preset`, `chilltext-log`, `remind`) are
  correctly wired in `src/cli/spine.ts` and back real modules, but no script, systemd unit,
  playbook, or doc names them. That is "no automation calls it," not "nothing reaches it" — a
  human typing it at a terminal is invisible to any tool here. Someone who knows whether they
  are still typed can settle this; static analysis can't.
- **`src/browser/**`** was left alone past dead-code removal per the ticket's scope. It carries
  13 of the 125 error-swallowing catches and the fourth-largest file in the repo
  (`runtime.ts`, 2,094 lines); worth its own pass.
- **`src/test/fake-harness.ts` and `src/test/scenarios.ts`** (1,116 lines) look dead to every
  import-graph tool because `tests/resume.e2e.test.ts` launches the harness as a subprocess by
  absolute path. They are live. Not slop.

---

## b) Where the process is not standardized

**Reporting a run's status is done six ways.** A single run writes to: the dispatch event log
(`src/dispatch/events.ts`), the ticket journal (`src/progress/journal.ts`), the run store
(`src/run/store.ts`), the task registry (`src/task/store.ts`), the spend ledger
(`src/spend.ts`), and the ops-log Discord mirror (`src/ops-log/index.ts`). Six durable places,
each with its own format and its own idea of what a "stage" is. Nothing reconciles them. When
a person asks "what happened with that run," which one answers depends on which code path you
came in through — and they can disagree, because the supervisor also holds ~40 in-memory
`Map`s that none of the six see (`src/run/supervisor.ts:335-436`).

**Showing a run's status in Discord is done four ways.** Four modules independently implement
"post one message, then keep editing it": the status dashboard, the task card, the training
card, and the dispatch digest feed (finding #4). Three of the four say in their own header
comment that they are modelled on one of the others — which is exactly how you know it should
have been one helper. Each re-implements the durable anchor file with its own
`writeFileSync`/`renameSync` pair (`src/status/service.ts:121`,
`src/progress/training-card.ts:217`) and its own deleted-message repost branch.

**Getting to Discord at all is standardized, and it works.** Credit where due: essentially
every outbound message goes through `DiscordGateway.post` / `.editMessage`
(`src/discord/gateway.ts:573,626`). There is one door. The four card loops above are four
users of that one door, not four doors.

**Deploying is four unrelated jobs sharing a word** (finding #7). `beckett deploy <name>`
creates a Cloudflare tunnel ingress and a DNS record. `beckett site deploy` publishes the apex
website. `deploy/deploy-prod.sh` fast-forwards the production checkout and restarts the
daemon. `src/preview/index.ts` serves a branch build for review. Four different risk profiles,
four different failure modes, one verb. That is a direct cause of "which deploy did you mean"
confusion.

**Errors are surfaced or swallowed with no rule.** Of 688 catch blocks in non-test source,
177 log, 386 do something (retry, fall back, convert to a typed error), and **125 discard the
error with an empty body**. Some of those are correct — a best-effort convenience log should
not take down the daemon. But there is no convention that distinguishes "deliberately
ignored, here's why" from "nobody thought about it," so from the outside they are
indistinguishable, and background work that fails silently is exactly the clunk being
complained about.

**Creating a run, by contrast, is properly standardized.** Every path — the CLI, the proposal
queue, the concierge — goes through `deployRun` in `src/cli/task-deploy.ts:353`. One function,
three callers (`src/cli/core.ts:969`, `src/cli/proposal-cli.ts:125`,
`src/proposal/decide.ts:116`). This is the shape everything else should look like.

---

## c) What "streamlined for agent factories" would take

### The pipeline as it exists today, read from the code

1. **A message arrives.** `DiscordGateway` (`src/discord/gateway.ts`) hands it to the
   concierge, which decides in `src/concierge/index.ts` — 9,088 lines — whether this is chat,
   an errand, or work.
2. **Work becomes a run.** `deployRun` (`src/cli/task-deploy.ts:353`) creates a `Run` in the
   run store, state `queued`.
3. **The supervisor staffs it.** `src/run/supervisor.ts` picks a harness per stage from the
   driver registry (`src/drivers/index.ts`), allocates a git worktree
   (`src/worker/worktree.ts`), and spawns a worker (`src/dispatch/spawn.ts`).
4. **Two stages run**: `implement`, then `review` (`src/run/types.ts:20`). The run's state
   walks `queued → implementing → reviewing → publishing`
   (`src/run/types.ts:32-42`).
5. **Publishing** pushes the branch and opens a PR through `src/agency/index.ts`, retrying
   through a durable outbox (`src/dispatch/publish-outbox.ts`) and parking for a human when it
   runs out of attempts.
6. **Proof decides done.** `src/run/proof.ts` assembles a verdict from the landing mode, the
   PR URL, whether the PR resolves, CI, and whether UI work has a screenshot. `verified` →
   state `done`; otherwise `unverified`.
7. **A person hears about it** through some subset of: the dispatch digest feed, the task card,
   the ops-log, the status dashboard, and whatever the concierge says in its own voice.

Stages 2 through 5 are genuinely one pipeline with named states, and they are better than the
complaint suggests. The accretion is at both ends: step 1 is one enormous file, and step 7 is
five parallel narrators. Step 6 is where it silently lies.

### The smallest set of changes that makes it one coherent thing

**One.** Make `done` mean merged (finding #1). `Proof` already has the right shape — it takes
facts and returns a verdict with gaps. It is missing one fact. Adding `merged: boolean | null`
to `ProofFacts` and requiring it for the `pr` landing mode turns "done" back into something
that matches what a person means by done. This is the single highest-value change in this
document and it is confined to one 121-line pure module plus its callers.

**Two.** One narrator, not five. Extract the self-editing-card helper (finding #4), then have
exactly one of the four surfaces own "the status of a run," and let the others link to it.
The concierge should speak about outcomes; machine state belongs on the card. This kills the
"Beckett narrating its own machinery" feeling directly, because there is one place machine
state lives and it is not the conversation.

**Three.** One plug-in system (finding #3). The v6 extension contract is the better design and
is already live in the daemon. Finishing it means making the CLI read the same registry and
deleting the `asCapability` shim layer — seven shim functions across six files, plus one table.
Only `codemap` is a genuine capability with no extension behind it. Until that happens,
adding a capability means understanding two mechanisms and a projection between them, which is
the opposite of a factory.

**Four.** Write down the pipeline, once, and let the code cite that instead of dead specs
(findings #2 and #9). Three paragraphs and a state diagram in one file that exists.

**Five.** A rule for swallowed errors (finding #5): an empty `catch` must carry a one-line
reason. Enforce it with a lint rule or a test over the source, so it stays true.

None of those five is a rewrite. Together they turn a pipeline that is 70% standardized into
one that is legible from either end.

---

## What this pull request actually deleted

Deletion only; no behavior changed, no directories moved, no CLI verbs renamed. Every symbol
was checked with a repo-wide grep for its name before removal, not just the census's word.

| Where | What |
|---|---|
| repo root | `shot94.mjs`, `pricing-94.png`, `full_test_output.txt` — checked-in scratch from run #94 |
| `src/agency/index.ts` | the Spec 07 action-class gate: `classifyAction`, `isSharedBranch`, `SHARED_BRANCH`, `mergeHandshakeSpec`, `mergeHandshakePrompt`, `MERGE_HANDSHAKE_SHORT`, `SEND_EMAIL_HANDSHAKE`, `GateRefused`, `pendingClassFor`, `DEFAULT_HANDSHAKE_MS`, plus the header prose describing it as live |
| `src/types.ts` | the types only that gate used — `ActionType`, `ActionContext`, `PendingActionClass`, `PendingAction`, `HandshakeSpec`, `GateActionResult` — plus `Checkpoint` and `StatusReport`, declared and referenced nowhere |
| `src/ids.ts` | `pendingActionId` — minted ids for the deleted gate |
| `src/agent/index.ts` | whole file: a barrel with one importer that used two of its eleven re-exports |
| `src/capability/modules/index.ts` | 14 dead re-export lines |
| `src/ext/index.ts`, `src/drivers/index.ts` | 3 and 7 dead re-export lines |
| `src/log.ts` | `appendWorkerLog` and the two imports it was the only user of |
| `src/preview/index.ts` | `fetchProbe` |
| `src/hooks/scope-guard.ts` | `scopeGuardEnv` |
| `src/ops/proactive-sweep.ts` | `FINDING_KINDS` |
| `src/agent/types.ts` | `AgentHarness`, `AgentEffort`, `AgentModel` type aliases |
| `src/task/store.ts`, `src/routine/watch-store.ts`, `src/freetime/run.ts` | `TaskCard`, `TaskPreviewLink`, `WatchSeenItem`, a dead type re-export |
| `docs/dead-code-audit.md` | superseded by this file; its findings are carried forward above |

The census baseline moved from 582 dead / 432 test-only to 545 / 439. Test-only went **up**
because the deleted barrels had been masking symbols that only tests import — the number got
more honest, not worse.

### Verification

- `bun run test`: 3,862 pass, 2 skip, 3 fail. **All three failures are pre-existing on the
  base commit** (`468b5d0`) and unrelated to this change — the same three appear in a run of
  the untouched tree: the betterwright-binary cwd test (`src/dispatch/spawn.test.ts`), the
  cursor credential preflight (`src/drivers/cursor.test.ts`), and a timing-sensitive watch
  rate-limit test (`src/routine/watch.test.ts`) that passes on some runs and not others.
- `bun x tsc --noEmit`: four errors, **all four pre-existing on the base commit**, all in
  `src/drivers/cursor-runner.ts` — a missing `@cursor/sdk` type declaration plus three
  narrowings that depend on it. Nothing this PR touched typechecks any differently.

Main is red on both counts before this branch exists. That is stated here rather than papered
over, and fixing it is not this PR's job.
