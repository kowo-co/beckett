# Changelog

## Unreleased

## v7.0.6 (2026-08-12)

### One voice: the chilltext gate's prompt is derived from persona.md

Beckett's voice lived in two places — `~/.beckett/persona.md` (what the Concierge's own system
prompt appends, what Beckett rewrites when asked to change its vibe) and a hand-written
`[concierge.chilltext] system` string in config.toml (what the rewrite gate actually asked for).
Tune one and the other drifts.

- The gate's system prompt is now composed at call time from the persona file
  (`src/chill-system.ts`), wrapped in a short framing preamble that states the gate's job —
  rewrite text that is already Beckett's, preserve meaning, facts, numbers, links and code
  exactly, leave the bubble count to the request. The persona goes in as a labelled voice
  reference, not as instructions, so the model restyles the message instead of trying to be
  Beckett and answer it. Read fresh per call: edit `persona.md`, `beckett reload`, done.
- chilltext caps `system` at 2000 chars (`413 system too long`, which would mean nothing gets
  chilled at all), and the live persona is ~8k. A persona that fits is sent whole; one that does
  not is carved to whole `##` sections from the END of the file, because a persona opens with
  identity and job — the material that makes a rewrite gate try to BE the person — and closes with
  how they type. A persona can override that guess by wrapping the part that IS the voice in
  `<!-- chill:start -->` / `<!-- chill:end -->`; the seeded default now ships with those markers.
  No section name is hardcoded anywhere in the daemon.
- `[concierge.chilltext] system` is retired. A config.toml that still carries it is stripped with
  one loud deprecation line instead of blocking the boot. The replacement, `system_override`, is
  an explicit escape hatch: empty by default, and a non-empty value replaces the persona voice for
  every message.
- Fail safe: a missing or unreadable persona file just omits the `system` field (chilltext falls
  back to its own default voice) and logs once. Nobody's message is lost to a missing file.

  Operator note for an existing install: `~/.beckett/persona.md` predates the markers, so the gate
  carves its tail (the sample lines) until you wrap a slice — putting `<!-- chill:start -->` above
  `## how beckett types` and `<!-- chill:end -->` below it is the one-line upgrade, and measurably
  more on-voice than the tail guess.

## v7.0.3 (2026-08-12)

### Trust gate: the verify/ship loop stops lying to itself

Four fixes from the v7 day-one transcript review, each closing a way Beckett's own
verify/ship loop could mislead it (or us):

- **spec.md can no longer time-travel between runs.** A worktree cut from a base that carried a
  committed `spec.md` was born holding the *previous* run's spec, and the supervisor's bare
  `existsSync` guard never replaced it — which is how two 2026-08-12 review stages were handed
  another run's acceptance criteria. The scaffold now replaces any spec stamped with a different
  run id, `readSpec` refuses to feed a foreign-stamped spec into briefs, the checklist parser
  takes the *last* `## Checklist` section (an appended own list beats an inherited stale one),
  and `/spec.md` is untracked + gitignored so the chain cannot re-form.
- **A late cancel keeps a shipped run's outcome.** `cancel()` checked terminal state on a stale
  read and then unconditionally wrote `cancelled` several awaits later — the runs.json half of
  #228, which is how the spatial-3d run (deployed, review 14/14) was recorded `cancelled`. It now
  re-reads right before the terminal write and yields to a real `done`/`failed`.
- **Casts are validated against the rate table.** `validateCasting` refuses a model id that
  `config/model-rates.json` doesn't price — a typo'd or unpriced id used to deploy silently and
  only surface as a telemetry mystery. A new model becomes castable by getting a rate row first.
- **`beckett finish` is honest about already-landed work.** Re-running it on a branch whose
  commits are all on the target exits clean ("nothing to land") instead of dying inside the
  landing engine, and brand-new project repos keep a plain `origin` remote after publish so
  `finish` can resolve them without `--repo`.

Also: the `extensions.test.ts` GitHub preflight test strips the *whole* credential chain
(App creds included), so it no longer makes a live star API call — and no longer fails — on
hosts where the GitHub App is configured.

### Faster validation, PR-less releases

- **Fast test lane.** `bun run test` skips the three browser e2e files (`runtime`, `isolated`,
  `agent` — real-Chromium suites that were 98s of the 132s total) and lands ~35s;
  `bun run test:browser` runs just them, `bun run test:all` runs everything. CI provisions
  playwright/betterwright and runs the browser lane only when browser-adjacent paths change.
- **Releases push straight to main.** `main`'s protection is now a repository ruleset — PR + CI
  required for humans, the 0x-beck App a bypass actor — so `deploy-prod.sh` lands the version
  bump with a direct App-token push instead of a release PR plus a ~4-minute CI wait. The
  prod-host gate now runs the fast test lane before the restart (previously the release PR's CI
  was the only test run in the deploy path).

## v7.0.0-rc.1

### Tickets are gone; work is a run

Real work used to cost four moves: allocate a task, start a branch, translate it into a ticket on
an external tracker, and wait up to five seconds for a poller to notice. v7 deletes that whole
apparatus. The concierge makes **one call**:

```
beckett task deploy --prompt "<the ask, faithfully, with every constraint>" --channel <id> [--repo <slug>] [--ultracode]
```

That writes a **Run** to `~/.beckett/runs.json` and pings the daemon. The **RunSupervisor** does
the rest — provisions the project repo, cuts a worktree and a branch, writes a `spec.md` scaffold,
and spawns the implement worker. The worker's first act is turning the prompt into a checklist in
that `spec.md`; a **spec-gate Stop hook** refuses to let it finish with items unchecked or the
placeholder still in place. That checklist is what the fresh reviewer then grinds the diff
against, and rework is a bounded loop before the run parks for a human.

- **The prompt is the brief.** Nothing else reaches the worker, so the concierge's doctrine now
  turns on carrying the person's actual words and constraints instead of a summary of them.
- **`--ultracode`** puts a multifaceted build (several subsystems, a migration, "audit
  everything") on the deepest seat with `workflowSizeGuideline: large`, so a big ask stays one
  branch, one review, one PR instead of being split into four runs that nobody sequences.
- **Status is a conversation, not a log read.** Workers spawn with `--name beckett-run-<slug>`
  and accept cross-session messages, so "how's that going?" becomes `beckett task ask <ref>` plus
  a direct message to the live worker, relayed in Beckett's own voice. No transcript ever reaches
  a channel.
- **Steering binds, or it errors.** `beckett task steer <run-id|slug> "<note>"` hands the note to
  the supervisor and reports which happened — `delivered` (the live worker was nudged) or
  `buffered` (it rides the next stage's brief). A run that has parked, failed, or finished is
  refused by name, because nothing re-staffs one: the answer there is a fresh deploy carrying what
  was learned, on a branch that kept every commit. A steer that never reached the daemon exits
  non-zero rather than letting the concierge tell a channel it landed.
- **The receipt is the run card**, posted by the machinery and edited in place as the work moves.
  The `-# filed ticket N` grey line is gone, and so is every instruction to print a reference.
- **Removed:** the `bored` tracker and its HTTP client, the poller, the 4,174-line dispatcher,
  ticket CLI verbs, `beckett plan`'s DAG filing, the INT design board, and the `basm`/`plan`
  skills. The quick lane, browser lane, task registry (`#N` / `#N.x`), spend ledger, journals, and
  free-time all survive, re-keyed onto run ids.

Doctrine, playbooks and skills were rewritten for the ticketless world in the same release:
`how-to-start-a-task.md` → `how-to-deploy-work.md`, `finishing-a-ticket.md` → `landing-a-run.md`,
`splitting-work.md` retired into "one run, not five", and `progress-questions.md` rebuilt around
asking the worker directly.

## v6.24.3 (2026-08-05)

### The browser lane stops lying to pages about storage (#7)

A WebGPU space that streams 5.31 GB of model weights never loaded in the sandboxed browser lane:
`navigator.storage.estimate()` reported `quota=622287713` (593 MiB), `persist()` returned `true`
and changed nothing, and the shards that did start died at ~15s with `transferSize 0`. The host had
429 GB free. Two independent causes, both named rather than papered over:

- **The quota was a fingerprint, not a filesystem.** CloakBrowser — the managed browser BetterWright
  drives — treats `navigator.storage.estimate()` as a fingerprint surface like any other. Its
  patched Chromium carries a `--fingerprint-storage-quota` switch (`strings chrome | grep
  '^fingerprint-'`), and with no value supplied it fabricates a consumer-plausible figure from the
  per-profile seed in `.betterwright-fingerprint-seed`. `622287713` was that fabrication. Measured
  directly: with the switch suppressed, two fresh profiles on the same filesystem at the same moment
  reported `552891516` and `596334088` — a free-space reading would have returned the same number
  twice. It had no relation to bwrap, to `--tmpfs /tmp`, or to the real disk, which is why
  `persist()` could not move it and why hunting for a filesystem reporting ~1 GB would never have
  found one.
- **A 128 MiB `RLIMIT_FSIZE` killed the download.** The lane launched Chromium under
  `prlimit --fsize=134217728`, a *per-file* ceiling. The space writes its weights as 26 OPFS files
  of 206,588,416 bytes each, so Chromium took SIGXFSZ partway through the first shard and the fetch
  died with nothing transferred — the "network error" the page reported.

The quota manager is left switched on and unmodified; `--unlimited-storage` is not used. The lane
computes what it can actually afford and tells pages that instead:

- **One number, three enforcement points** (`src/browser/storage-quota.ts`). Free space on the
  filesystem backing the profile, less an 8 GiB host reserve, clamped to a 32 GiB lane ceiling and a
  512 MiB floor. That number is what pages are told, the lane's `RLIMIT_FSIZE`, and the profile's
  on-disk ceiling. An unprobeable filesystem falls back to the floor, never the ceiling.
- **The switch reaches Chromium through a wrapper shim** (`src/browser/cloak-storage-quota.mjs`).
  BetterWright reserves the whole `--fingerprint*` namespace from `chromiumArgs` and rejects it
  outright — correctly, since those switches decide the browser's presented identity. It does
  support substituting the CloakBrowser wrapper module (`BETTERWRIGHT_CLOAKBROWSER_PATH`), so the
  shim re-exports the real wrapper's two entry points with one switch appended and nothing else
  touched.
- **The sandbox is unchanged.** The shim is bound `--ro-bind`, beside the host bundle. No new
  writable bind, no `--share-net`, no capability change; `--unshare-all` and `--cap-drop ALL` stand.
  The only loosened limit is the per-file `RLIMIT_FSIZE`, deliberately: it was capping a single
  cached asset. Saved downloads do not gain from it — BetterWright writes them to
  `<profile>/betterwright/artifacts/downloads`, which is not site storage, so they still count
  against the 512 MB profile-state ceiling and are bounded well below the old per-file number.
- **The profile budget is two ceilings, split by who put the bytes there**
  (`src/browser/betterwright.ts`, `src/browser/profile-cache.ts`). Beckett's own profile state —
  cookies, logins, history — keeps the 512 MiB ceiling and the 100 MB per-lease growth allowance.
  Storage a page filled under the quota it was granted (Cache Storage, the HTTP cache, IndexedDB,
  and OPFS, which is where the weights actually land) is measured against the advertised quota
  instead. The lane enforces the exact figure it advertised, read back from the same environment
  variable the shim used, because CloakBrowser's switch only changes what a page is *told* —
  Chromium keeps accepting writes past it, so this check is what protects the host's free space.
- **Weights survive the run and the next acquire.** `pruneChromeProfileCaches` still deletes only
  disposable caches between leases; OPFS and the other quota-managed stores now go only under an
  explicit escalation, taken when a profile is over its whole-footprint ceiling with nothing else
  left to reclaim. Cookies and logins survive either way, and nothing is deleted mid-lease.
- **Proven against the real space**, not a fixture: `bun scripts/ops/browser-smoke.ts` now asserts
  the quota a live page reads tracks the lane's measured budget.

Measured in the lane, against `https://procreations-maple-webgpu.static.hf.space/`:

| | before | after |
| --- | --- | --- |
| `navigator.storage.estimate().quota` | `622287713` (593 MiB) | `34359738368` (32 GiB) |
| shard fetches | died at ~15s, `transferSize 0`, 3/3 | completed, 0 errors, 0 failed requests |
| weights staged | 0 B | `5308191948` B (5.31 GB) in 265 s, ~19 MiB/s |
| page state | "network error", back to landing | `READY · SUBGROUPS` |

The download half is fixed and reproduced three times end to end, on three fresh profiles
(266.3 s, 263.3 s and 274.7 s, all clean, all reaching `READY · SUBGROUPS` with
`usage = 5308191948`). The 32 GiB quota was also read back from a second origin
(a local `http://127.0.0.1` page) to confirm it is the lane's budget rather than
anything specific to the Hugging Face origin.

**No TTFT or tokens/sec number is reported here, because any number this lane produced would be
meaningless — and the reason is worth recording.** The generation is not running on a GPU. The
lane has no GPU at all:

- `adapter.info` inside the lane reports `vendor: "nvidia"`, `subgroupMinSize/MaxSize: 32`, and a
  feature set including `subgroups`, `shader-f16` and `texture-compression-bc`. The page believes
  it completely — its own RUNTIME INFO panel reads `DEVICE nvidia · <arch>` and `RUNTIME Custom
  WebGPU · subgroup fast path`, so it selects the hardware kernel path and prints
  `READY · SUBGROUPS`.
- **The architecture is not even stable across profiles**, which is the tell: one profile reported
  `architecture: "lovelace"`, a second fresh profile on the same machine minutes later reported
  `"ampere"`. Real silicon does not change generation between runs. It is seed-derived, exactly
  like the `622287713` quota was.
- The host has no NVIDIA hardware. `/dev/nvidia*` does not exist, `nvidia-smi` is not installed,
  and the only VGA device is `Intel Corporation Xeon E3-1200 v3/4th Gen Core Processor Integrated
  Graphics Controller` on `i915`. Neither a Lovelace nor an Ampere part is present on this machine.
- Measured rather than inferred: a naive fp32 WGSL matmul in the lane runs at **0.5–0.6 GFLOPS**
  (512³, 4 dispatches, 2.0 s; and 1024³, 8 dispatches, 27.7 s). An Ampere or Lovelace part is four
  orders of magnitude above that; even the host's Haswell iGPU would be ~two. That is a CPU
  rasterizer — Dawn's SwiftShader fallback.
- Structurally it could not be anything else: the bwrap sandbox mounts `--dev /dev`, a fresh
  minimal devtmpfs, and binds no `/dev/dri` node. There is no path from inside the sandbox to the
  i915 device, so Chromium has nothing to fall back *from*.

So `adapter.info` is fabricated by exactly the mechanism this ticket is about. CloakBrowser
normalises the WebGPU adapter as a fingerprint surface the same way it normalised
`navigator.storage.estimate()`, and both numbers were fiction from the same source. The quota
fiction broke the download and is fixed; the adapter fiction is cosmetic to Beckett but makes any
throughput figure off this lane a measurement of SwiftShader wearing an RTX badge — worse, of
SwiftShader running the *subgroup fast path* it was told it could use.

What a bounded generation attempt actually did, for the record: the space reloaded and reached
`READY` in 155 s, one short prompt ("Say hello in one short sentence.") was submitted, and **no
first token appeared within a 180 s bound**. An earlier unbounded attempt streamed for ~22 minutes
without settling. A 20B model on a software rasterizer is not a benchmark, it is a hang, and
reporting tok/s from it would have been reporting a made-up number with extra steps.

What this change is therefore claiming, and nothing more: **the storage bug is fixed and the 5.31 GB
model loads.** Making the lane's WebGPU real is a separate piece of work — it needs `/dev/dri`
bound into the sandbox and CloakBrowser's adapter spoofing addressed — and is deliberately not in
this diff, which is scoped to storage.

## v6.24.1 (2026-08-04)

### The pipeline feed speaks English (#4)

The dispatch event feed posted one raw trace row per transition — `✗ 04:56:31 · #2.1 · implement ·
FAILED · 22m 4s 🚨 ALERT — I'll start by getting oriented in the repo…`, which is a worker's
harmless opening narration wrapped in failure dressing because a deploy killed it. Alongside that:
no-op `in_review → in_review` transitions, the same staff/repo/worktree batch replayed twice after
every restart, UTC seconds, and worker ids. The channel now gets a digest instead.

- **One self-editing message per ticket episode** (`src/dispatch/digest.ts`,
  `src/dispatch/digest-feed.ts`): each event becomes at most one plain-English sentence stamped
  with a local time, appended to a message that is edited in place. A 26-row run is 3 messages.
- **A restart is reported as a restart.** `drainForShutdown` marks the dispatcher draining, so every
  worker that dies from then on is traced with the new `interrupted` outcome instead of `failed` —
  never an alert, never quoting the worker's last narration as an error.
- **Noise is dropped**: no-op `X → X` transitions, worktree/repo plumbing (unless it fails), and any
  sentence repeated inside the replay window (the restart batch).
- **Genuine failures still land promptly**, marked, carrying the real error text, in a message of
  their own so an edit can't bury them.
- **The forensic rows are unchanged** and still available via `beckett ticket trace "<ref>"`; every
  digest names that command. `bun scripts/ops/dispatch-digest-sample.ts` prints the before/after.

### The deploy can ship again: both of its pushes ride the GitHub App token (#5)

`deploy/deploy-prod.sh` could not complete a deploy on the daemon host. Its two `git push` calls had
no credential (the script re-execs into a `systemd --user --scope`, which inherits none) and died
with `fatal: could not read Username for 'https://github.com'` — even when the push had nothing to
push, which is what wedged every re-run. Adding a credential only moved the wall: `main` is
branch-protected, so the bump was refused with `GH006: Protected branch update failed`. The last
three releases were hand-couriered through PRs; v6.24.0's deploy stopped mid-run.

- **The release bump lands through its own PR.** The bump commit moves to `release-bump-vX.Y.Z` and
  goes up via the new `beckett gh land` — push branch → open (or reuse) PR → wait for CI → merge —
  then main is fast-forwarded and the branch deleted. Branch protection is satisfied, not weakened,
  and no `release-bump-*` graveyard is left behind.
- **One landing engine, two callers.** `beckett finish` and `beckett gh land` share
  `src/cli/land.ts`; the merge gate and every named blocker live there once, and each caller names
  its OWN re-run command in the message an operator reads.
- **The release tag pushes through `beckett gh push --tag`** (`GitHubCli.pushTag`), the same App
  installation token as everything else, replacing the bare `git push origin refs/tags/…`.
- **A missing credential fails fast, named.** New `beckett gh preflight [--repo <owner/name>]` mints
  the installation token (a real check, not a config read) and the deploy runs it before it commits
  anything — `no GitHub credentials in ~/.beckett/.env …`, not git's username prompt, and nothing
  committed, pushed, or restarted.
- **Re-runs are clean.** The bump step compares trees, not shas: `"level": "none"` and a bump that
  already landed under the squash merge's sha are both no-ops that proceed to the gates, and a
  re-run after a blocked landing reuses the same PR (the machine-owned bump branch is force-updated,
  which is the only place `pushBranch`'s new `force` option is reachable from).

## v6.24.0 (2026-08-04)

### `beckett finish` — PR, merge and redeploy behind one command (#2)

The end-of-ticket motion used to be five-plus hand-run CLI calls (check status → push → open PR →
poll CI → merge → find the right deploy script → run it) with a lot of back-and-forth in chat, and
a redeploy that quietly got skipped whenever the thread was lost. It is now one command run from
the ticket's checkout:

```bash
beckett finish -m "what this ticket shipped"
```

- **The whole motion, in order**: commit a dirty tree with that message, push the branch, open **or
  reuse** its PR, wait for CI, merge into `main`, then run THE guarded redeploy
  (`deploy/deploy-prod.sh` — dirty-tree refusal, typecheck gate, browser drain, health read-back,
  release tag). PR and merge go through `GitHubCli`, the one credential boundary; the deploy is the
  existing script, spawned. No second way to ship.
- **Every stop is named.** A wrapper that reports "merge failed" is worse than the sequence it
  replaces, because the caller can no longer see which step it was on. Failed checks, conflicts,
  drafts, branch protection, a base that moved, an unset git identity on the host, a dirty deploy
  checkout, an unreachable box — each produces a specific line with the PR, the cause, and the
  command that clears it. CI waiting is bounded (`--ci-timeout`, default 15 min), never an
  open-ended poll, and a timeout says explicitly that nothing merged and nothing deployed.
- **The redeploy runs in the repo's PRIMARY checkout**, not the branch's. Ticket work happens in a
  linked worktree, and a linked worktree cannot run the deploy's `git checkout main` while the main
  checkout holds that branch (`fatal: 'main' is already used by worktree at …`) — which would have
  failed every self-hosted finish on the far side of the merge. `finish` resolves that checkout
  itself and preflights it (dirty tree, git identity) BEFORE anything is pushed or merged.
- **Re-running is safe**: it reuses the open PR, skips a merge that already landed, and goes
  straight to the deploy — so "fix the blocker, re-run" is always the instruction.
- Every invocation posts one line to the ops channel before it touches anything, so the runs that
  FAILED show up in the ledger too.
- New `GitHubCli.prMergeability` reads GitHub's own merge verdict (`mergeable`,
  `mergeStateStatus`, the check rollup) in one round-trip — `isGreen` collapses "still running" and
  "failed" into one `false` and says nothing about conflicts.
- Concierge doctrine now routes the finish workflow here
  (`src/concierge/playbooks/finishing-a-ticket.md`, plus the couriering, task-filing and
  self-improve playbooks) instead of describing the manual PR/merge/deploy steps.

## v6.20.0 (2026-08-04)

### Beckett's GitHub identity is a kowo-co GitHub App, not a machine account (#114)

The `0xbeckett` machine account is permanently lost (2FA unrecoverable). Rather than mint another
human-shaped login, Beckett is now a **GitHub App owned by `kowo-co`**, acting as `beckett[bot]`.
This is the better shape for what Beckett actually is: anyone can **install** it on their own repos
with a link and a repo picker — nobody has to add a bot user as a collaborator — and the credential
stops being a long-lived PAT sitting in a dotfile.

- **Real installation-token minting** (`src/github/app.ts`): app JWT (RS256, `iat` backdated 60s
  against clock skew, 9-minute `exp`) → installation lookup → `POST
  /app/installations/{id}/access_tokens`. Tokens are cached per installation and re-minted five
  minutes before expiry. `GitHubCli` resolves the installation from the **target repo/owner** of
  each call (repo → owner → pinned `GITHUB_APP_INSTALLATION_ID` → the sole installation) and
  refuses to guess when none of those cover it — the error carries the real installation list and
  the install link. `git` over HTTPS authenticates as `x-access-token`; `gh` gets `GH_TOKEN`. Both
  ride the environment, never argv, exactly as the PAT did.
- **Access triage as a first-class surface**: `beckett gh app status | installations | repos |
  diagnose | install-url`. `diagnose` separates the three causes a bare `404` conflates —
  not-installed, installed-but-repo-unselected, and no-such-owner — and is explicit about the one
  case GitHub genuinely cannot disambiguate (a private repo that is either unselected or
  nonexistent). The `troubleshooting` skill leads with it.
- **Registration is automated up to the one click GitHub requires**:
  `deploy/github-app-manifest.json` is the checked-in app definition (least privilege — contents
  RW, pull_requests RW, issues RW, metadata R, checks R; no webhooks), and
  `bun scripts/ops/github-app-register.ts` POSTs it, catches the redirect, exchanges the temporary
  code, and writes the private key out at mode 0600. Runbook: `deploy/github-app.md`.
- **Failure is loud, never silent.** A half-configured app (id without a key, an unreadable key
  path, a file that isn't a PEM) throws at identity load rather than degrading to "GitHub isn't set
  up here" — which is what a missing credential and a broken one used to look like to each other.
  `beckett doctor` gained `identity: github app` and `identity: github token` rows that sign a real
  JWT and mint a real token.
- The legacy `GITHUB_PAT` path still works for a self-hosted install without its own app, but it is
  documented as legacy; `GH_TOKEN` and `GITHUB_USER` are dead and marked for deletion from the box
  `.env`.

## v6.18.0 (2026-07-30)

### The turn deadline measures silence, not elapsed time (#150)

The v6.16.1 reaper (#139) timed a turn from its start, so a concierge turn running a typecheck, a
test suite and a few git fetches hit six minutes and was killed mid-flight — four times in one hour
— while it was demonstrably working. Six minutes also sits below the floor for a deploy turn, so
deploys could never finish inline. The clock now restarts on every streamed assistant / tool_use /
tool_result event, so it measures how long the child has been SILENT (4 min quiet, then 2 more
before the reap — the old schedule, applied to silence). A wedged child emitting nothing at all
still dies on exactly that schedule, and a new 30-minute absolute ceiling, never reset by liveness,
backstops a runaway that keeps emitting events forever. A deadline-reaped turn now says it timed
out, plus the last thing it was seen doing, instead of "ask again" — which only replayed the same
slow work into the same deadline.

## v6.11.1 (2026-07-28)

### The documented install actually works on a clean machine (#72)

The README pitches Beckett as forkable — "rename it, point it at your own Discord, and you have
your own Beckett" — but the `curl | bash` install had never been run end-to-end off loom-desk.
Ran it from zero in a fresh Ubuntu 24.04 + systemd container (`scripts/check-public-install.sh`,
the committed reproducible check) and fixed every break so a stranger reaches a daemon that starts
in `healthy-pending-configuration` with the required config documented:

- **`deploy/config.toml.example` had loom-desk's Cerebras defaults baked in.** It was regenerated
  on a box with `CEREBRAS_API_KEY` set, so the committed example pinned `triage_provider =
  "cerebras"` / `triage_model = "gemma-4-31b"` — the *keyed* defaults, not the keyless ones the
  drift test asserts. Regenerated it keyless; `bun test` is green again.
- **The installer seeded `.env` keys that weren't in the inventory.** `install.sh` writes
  `BECKETT_MAIL_ADDRESS` and `OPENROUTER_REFERER` into a fresh `~/.beckett/.env`, but neither was
  documented in `.env.example` — so a brand-new box's very first `beckett doctor` warned about
  undocumented keys the installer itself wrote. Documented both, and added a regression test
  (`tests/install.test.ts`) asserting every installer-seeded key stays in the inventory.

The complete clean-host break record is retained here rather than relying on loom-desk state:

- **The piped README command died under `set -u`.** stdin-fed Bash has no `BASH_SOURCE[0]`; the
  entry guard now safely falls back to `$0`, so `curl | bash` and a downloaded script have the same
  behavior.
- **Pi was silently skipped.** `runuser`'s missing-command diagnostic was treated as a version
  string, so `sort -V` claimed a nonexistent Pi was current. Version detection now ignores stderr.
- **Bored's own installer aborted at `loginctl enable-linger`.** The public installer had already
  enabled lingering as root, but bored redundantly retried it as the unprivileged service user,
  where stock polkit correctly says access denied. A transient, invocation-only `loginctl` shim
  acknowledges that redundant subcommand while passing every other call through.
- **The mandatory browser smoke stopped otherwise-valid fresh hosts.** Chromium and its Linux
  dependencies are still provisioned, while the live sandbox smoke is explicitly opt-in with
  `BECKETT_INSTALL_BROWSER_SMOKE=1`; this leaves a status-only daemon available until host policy
  is complete.
- **A secretless install staged units but had no health endpoint.** The service now provides a
  status-only `healthy-pending-configuration` control socket, and `deploy/install.sh` waits for
  that real response instead of declaring readiness from a process state alone.

## v6.9.0 (2026-07-27)

### The overnight spike: two loops, one branch-only prototype (#38)

The generative half of the dream engine. When the nightly synthesis notices that two open
loops (or a loop and a recurring error) are secretly one problem, it may pair them — with an
explicit written rationale for why the combination is worth more than either alone — into at
most ONE tiny overnight spike. Most nights it doesn't, and that costs one journal line: not
spiking is the common case, and the bar is real because saying "no pairing tonight" is cheap.

A spike is a question asked in code, not a contribution. The walls are structural:

- it runs in its own throwaway git worktree on a `dream/spike/<date>-<slug>` branch, behind
  the SAME PreToolUse scope guard every worker runs behind (rooted at the spike worktree, so
  a write anywhere else is denied — tested against the real hook script), plus explicit deny
  rules for `git push` / `gh` / `beckett deploy`;
- the branch is never merged, never pushed, never deployed, and never enters the tracker —
  neither `src/dream/spike.ts` nor anything downstream has a verb that could, the same
  no-door-to-open design as the proposal store;
- it runs on a sub-budget (`[dream] spike_output_token_budget`, default 60k) carved OUT of
  the nightly ceiling, never in addition to it; blowing it abandons the spike with a note —
  the journal entry is never the thing sacrificed;
- every spike leaves a lookable artifact regardless of outcome — a durable `finding.md`
  (plus `diff.patch`) under `~/.beckett/dreams/spikes/<id>/`, outside the worktree,
  referenced by path from that night's dream journal entry;
- the morning surface is the #37 proposal queue: a finished spike files an inert
  `ticket`-kind proposal carrying the artifact path, so acting on it is a decision made
  awake, through the queue's normal accept/reject doors;
- garbage collection keeps the learning and drops the branches: spikes past 30 days with no
  accepted proposal lose their worktree and branch on the next pass's way-in sweep, findings
  kept.

`beckett dream spikes ls|show` reads records and findings back — read-only by design.

### The dream engine: a nightly, budgeted replay of my own day (#36)

A new `dream` routine kind rides the self lane once a night, at a random minute inside
03:00–05:00 America/Los_Angeles (the engine's per-period idempotency is the once-per-night
guard). It forks exactly where `self`/`deps-update` do — before every browser dependency —
but instead of framing a concierge turn it spawns a contained `beckett dream run` process,
so the pass can never hold a shell, a credential, or the browser.

The pass assembles the last 24h read-only — worker journals, ticket state transitions
(`events/dispatch.jsonl`), the open-loop ledger, calibration/veto records (gracefully absent
where that ticket hasn't landed), and stored **guild** channel windows. DM windows are never
read: the gate is in code (null/missing `guildId` skips the channel before its window is even
loaded), with a spy test proving it. One tool-less reflection call (plus per-section condense
calls on heavy days) runs under a hard output-token ceiling from config
(`[dream] output_token_budget`, default 150k — a ceiling, not a target: a quiet day
short-circuits to a thin entry with zero model calls). Tripping the ceiling stops cleanly and
writes a partial entry marked `truncated: true`.

Outputs are INFERENCES, never facts, enforced structurally rather than by prompt:

- exactly one dated journal entry per night at `~/.beckett/dreams/YYYY-MM-DD.md` (what
  happened / what I'd do differently / worth remembering / worth forgetting / loops that
  might combine), assembled in memory and written once — no per-step churn;
- memories land only through the new create-only `MemoryStore.rememberDream`, which forces
  `type: dream` + `inference: true` + a provenance list, namespace-locks names to
  `dream-YYYY-MM-DD-<slug>`, refuses any existing node (no update, no dedup merge, no
  backlink rewrite of other files), and drops any proposed memory whose provenance names a
  source that wasn't actually assembled that night;
- every recall surface (CLI/bus text + JSON, related/index lines, MEMORY.md, agent-recall
  candidates) visibly marks dream-derived hits as inference, with their sources;
- nothing here can touch doctrine or persona — there is no write path to either, and the
  containment tests try to violate all of the above and fail.

`beckett dream ls` / `beckett dream show <date>` read the journal back. The proposal queue
(#24.2) and the overnight spike (#24.3) build on this namespace.

### The proposal queue: a dream proposes, and can never edit (#37)

The gate that makes dreaming safe. #36 gave an unsupervised nightly process opinions about my
own doctrine; this is the only thing standing between "it has opinions" and "it rewrites
itself while nobody is awake". The containment is the feature; everything else is plumbing
around it.

A dream now emits **proposals as records**, in their own directory (`~/.beckett/proposals/`)
— separate from real memories and from dream-inference memories, so a proposal can never be
recalled as either. Each carries a kind (`doctrine-change` / `persona-change` / `ticket` /
`memory-correction`), a one-line claim, the rationale, and the provenance it was derived
from, validated against the same night's assembled sources as memories are. Records are
parsed field-by-field on read, so an invented `apply` / `target` / `patch` key in a
hand-planted record is dropped on the floor rather than obeyed.

`beckett dream propose | proposals ls | show <id> | accept <id> | reject <id> --why <reason>`
are the only way a proposal moves:

- **accept routes through the normal pipeline, never a file write.** A doctrine or persona
  proposal becomes a filed ticket — the same road, with the same review gate, as any other
  change to my core; a dream gets no shortcut for having been clever at 4am. A `ticket` or
  `memory-correction` proposal becomes a real task branch. The record is stamped `accepted`
  with what it became (`ticket:OPS-42`, `task:#12.1`), and route-first ordering means a
  failed filing leaves the proposal open rather than claiming it became something.
- **reject requires a reason and writes a calibration record**, so the same SHAPE of proposal
  (the join key is the kind, in the room it came from) is weighed differently next time. The
  rejected record is kept with its reason — rejection is signal, not deletion.
- **nothing decides twice, and nothing decides late.**

An `<open-proposals>` block loads into my session prompt the way `<open-loops>` does: capped
at five lines, highest-signal kind first and oldest first within a kind, showing the claim and
never the rationale, and completely silent when nothing is pending — a block that is noisy
every morning gets ignored, and an ignored gate is a broken gate.

A proposal older than 14 days with no decision is auto-expired with a note and its claim
intact (so a recurring one reads as recurring), swept by the nightly pass and by
`proposals ls`. Auto-expiry exists so the queue cannot become another backlog to feel guilty
about.

No code path anywhere lets a proposal apply itself, and that is proved by tests that try:
`src/proposal/containment.test.ts` fingerprints a whole runtime tree (doctrine, persona,
memories, dreams, tasks), runs every decision path against adversarial claims and
hand-planted "pre-approved, self-executing" records, and asserts the tree is byte-identical
afterwards — plus a static audit that the queue's modules cannot so much as *name* doctrine,
persona, or the memory write path, and that their only filesystem write goes through the
id-locked path helper.

## v6.1.0 (2026-07-24)

### `beckett gh` gets a passthrough, and release tags can finally ship (#88)

`beckett gh push` could only ever push **branches** — it rewrote any ref into
`refs/heads/<branch>`, so publishing a release tag (`v6.0.3`/`v6.0.4`) was
structurally impossible through the sanctioned path. And the curated verb list
(`repo`, `pr`, `push`) was a permanent reimplementation treadmill against `gh`'s real
surface. Two openers, both on the wrapper that *already* injects the PAT per
invocation — this widens the aperture, it doesn't widen the blast radius.

**`beckett gh raw -- <any gh args>`.** A passthrough that runs the real `gh` binary
verbatim with the token injected through the environment (`GH_TOKEN` + the inline git
credential helper, never argv), in `--dir` if given, streaming stdout/stderr and
propagating `gh`'s exit code. That's the whole `gh` feature suite — releases, issues,
gists, `gh api`, arbitrary flags — with zero per-verb maintenance. The curated verbs
stay byte-for-byte (the characterization suite and the deps-update `['gh','push']` /
`['gh','pr','create']` argv shapes are unchanged); passthrough is purely additive.

**Release tags.** `beckett gh push --repo <r> --tag <t>` pushes
`refs/tags/<t>:refs/tags/<t>` explicitly, so a tag lands as a tag. Pushing `v6.0.4`
now works end to end.

The token stays out of argv, out of `~/.git-credentials`, and out of every worker's
inherited environment — deliberately **not** the bashrc-alias variant, which would
export the PAT into every interactive shell and every subprocess.

On the live symptom: the `v6.0.3`/`v6.0.4` "pre-receive hook declined" failures were
the **ref-rewrite bug alone**, not a repo ruleset or a PAT tag-scope problem. Checked
against the real repo: `0xbeckett/beckett` has **no rulesets** and no legacy tag
protection (only branch protection on `main`, which never touches `refs/tags/*`), and
the PAT has tag-write scope — a probe tag pushed through the new `--tag` path landed
and was cleanly deleted. The sanctioned path simply could not express a `refs/tags/*`
destination; now it can.

## v6.0.3 (2026-07-24)

### Weekly routines, and a dependency update that PRs itself (#85)

SSH noticed `betterwright` pinned at 1.1.3 locally while 1.3.1 was published. ro's
call: stop hand-bumping deps forever. Two pieces.

**The `weekly` cadence.** `CadenceSchema` always advertised itself as "the seam for
weekly / interval to slot in without touching the rest of the engine" — this took
it. A weekly routine carries a weekday and keys its period to the tz-local **ISO
week** (`2026-W30`), so the once-per-period idempotency guard in `scheduler.ts`
works exactly as daily's does: a restart mid-week neither double-fires nor re-rolls
the minute already chosen inside that week's window. ISO weeks run Monday→Sunday
and belong to the year holding their Thursday, so a Sunday routine fires on day 7
of the week it is keyed to, and a New Year that splits a week (2026-12-28 through
2027-01-03 are all `2026-W53`) still gets exactly one fire. The fuzz-window
humanization is unchanged — a random minute inside the window, persisted per
period. `beckett routine add --weekly sunday` creates one; `routine ls` shows
`weekly (sunday)` and spells the weekday out in the next fire time.

`nextFireAt` now actually reads `lastFiredPeriodKey` (it always took the argument
and never used it): a period that already fired points at the *next* one, so a
fired Sunday stops reading as "next fire" for the six days after it.

**The `deps-update` action.** A new routine action, and the first that does **not**
go through the privileged browser lane — it is a local maintenance chore with no
use for a web session, so it gets its own dispatch lane and the dispatcher forks on
that lane *before* it resolves the browser agent at all. It runs as its own
`beckett routine deps-update` subprocess, because a clone plus install plus a full
test suite has no business inside a scheduler tick.

One run: clone the source read-only (`--no-hardlinks`; the live checkout is only
ever a clone *source*), detect package managers from the lockfiles actually present
(npm/bun/pnpm — all supported, only the ones in use ever run; Beckett's own repo is
bun-only), apply **in-range** updates only (the bare `update` verb, never
`--latest`), then prove it with typecheck and the test suite. If either goes red the
run stops there — no push, no PR, and the summary names the failed check. On green
it opens a PR against `main` via `beckett gh` and posts exactly one terse line with
the link. Anything the ranges refuse — a major jump, or an outgrown exact pin like
`betterwright` — is reported as *available, not applied*.

Seeded as `weekly-deps-update`, Sunday mornings 08:00–10:00 PT.

Verified by running it for real against a clone
(`scripts/ops/deps-update-rehearsal.ts`, which stubs only the GitHub calls). That
caught two things review would not have: `git add -A` ran *after* the checks, so
anything the suite left in the tree would have landed in the PR (staging is now
limited to the paths the update itself changed); and a `BECKETT_DIR` sandbox added
for the check phase turned out to override the `paths.beckett_dir` that 34
browser/config tests set for themselves, reddening the suite it was meant to guard
— reverted, with the residue documented honestly in `docs/routines.md` instead.

## v6.0.2 (2026-07-24)

### Volition — Beckett finishes the motion instead of asking permission

The babysitting posture is gone from the doctrine and the license table. Root
cause of the "say the word and i'll run the deploy" round-trips: `deploy` was
classified ALWAYS_ASK and the prompts told Beckett to park green PRs and
landed changes until a human said go — while the deploy flow already carried
every safeguard (dirty-tree refusal, ff-only, typecheck gate, health
read-back). Now the safeguards ARE the gate, not a permission prompt:

- **Doctrine** (`concierge.md`): a new top-level *Volition* section — decide,
  act, verify, deliver in one message; the finish line is the product live;
  obstacles (merge conflicts, failed publishes, flaky checks) are Beckett's to
  clear; questions are for forks in WHAT is wanted, never for whether to
  proceed. Direct-go stays only for money, account/repo admin, sending AS the
  person, other people's production, and explicit owner holds — a stated hold
  beats volition, always.
- **Courier flow**: merging green reviewed work — through rebases and
  conflict resolution — is part of couriering, completing exactly the motion
  the dispatcher would have done. A conflict that forces a real design
  decision goes back to a worker via ticket steering, still not a question to
  the human.
- **Ticket-done relays**: a landed `--project beckett` change that only
  matters live is deployed and health-checked BEFORE the done ping, so one
  message says done AND live.
- **License table** (`src/agency`): `deploy` reclassified ALWAYS_ASK → FREE
  (its guarded flow is the safeguard); `gh.pr.merge` with a passed review
  (`ctx.reviewed`) is FREE, unreviewed merges keep the handshake, fail-closed.
- **Skills**: deliver / github / deploy / self-improve rewritten to the same
  posture (finish the motion first, then one delivery message, past tense).
- **Deploy routing fixed**: "deploy" removed from the ticket-work list — a
  worker's scope guard denies every write outside its worktree (correctly), so
  a redeploy filed as a ticket died at the permission gate every time ("same
  wall as this morning"). Doctrine now routes Beckett-self deploys to the
  concierge's own seat, always.
- **Denial-is-a-lead doctrine**: a gate refusal must be diagnosed (name the
  gate; wrong seat → re-route, buggy wall → file the ticket, right wall → say
  specifically why), never relayed as a bare "denied, need permission".
- **`--confirm-beckett` is routing, not rank**: an explicitly self-targeted
  request ("update yourself to X") files WITH the flag on the first try — the
  request is the confirmation, the review pipeline is the safety. The CLI
  guard message now says so at the moment of refusal (3 characterization
  snapshots regenerated deliberately). Confirm-with-the-user survives only
  for genuinely ambiguous routing; suspicion requires investigation before
  refusal.

## v6.0.0 (2026-07-24)

### v6 — the plug n play release (Phases 2–6 complete)

Every organ now lives on the ONE extension contract (docs/v6-architecture.md);
the daemon boots them in staged sweeps, health-checks them, and drains them in
reverse. Built wave by wave, each implemented by one model and adversarially
reviewed by another; the reviewers refused two waves outright and killed four
real security holes before merge (unauthenticated credentialed-browser
dispatch via ext.invoke; a recall audience escalation via argv injection; a
browser queue lease race; a memory rescope leak that let any origin flip an
owner-scoped node public). Every wave shipped behind byte-identical
characterization suites.

- **Phase 2 — browser** is the first stateful extension (lifecycle re-homes
  the Chromium host + agent), plus the DISPATCH QUEUE: a busy-lease browser
  ask queues durably, survives restarts, auto-starts, is steerable while
  queued; queued credentialed runs hold no secret values. ext.invoke derives
  identity from the issuer token; non-FREE capabilities refuse without an
  authenticated turn. The concierge prompt now renders the live capability
  catalog.
- **Phase 3 — quick + routines**; ExtensionLifecycle gains
  startPhase "early"|"late" (crash recovery before the pollers, schedulers
  after the live system — a flat startAll was a real TDZ boot hazard).
- **Phase 4 — catalog cutover**: github/dns/deploy/mail on the contract with
  shared throwing cores; the CLI is 100% extension-backed with byte-identical
  help; SLASH COMMANDS DELETED (the sanctioned product cut — @mention is the
  interface; /stats retired without successor).
- **Phase 5 — worker stages are a core-kind extension facet**, byte-identical
  (prompts, transitions, reviewTierFor untouched); stage names + entry states
  are collision-guarded global namespaces. The enabler for per-ticket flows.
- **Phase 6 — memory**: the warm store + nightly maintain loop live on the
  contract (late stage); memory.recall/memory.remember are ORIGIN-BOUND —
  audience derived in code from the token-derived origin, caller-supplied
  viewer/role args refused loudly, dm context unreachable via ext.invoke
  (fail-closed), scoping create-only on the invoke path, and no origin can
  write a node it cannot view. Engine code untouched.
- **Multitasking** (concierge core): the in-flight interrupt is a policy —
  own-ask amendments cancel-and-amend while composing; tool-using turns
  finish and independent asks queue as priority turns; a teammate's message
  never cancels yours. Canned progress acks are gone; doctrine bans trailing
  questions and busy-narration. Daemon-authored messages humanized.
- **Drivers**: the triplicated NDJSON frame normalization unified in
  BaseDriver behind golden frame tests proven against the pre-refactor tree.
- Open items, deliberately not silently widened: deploy/github/mail daemon
  registration awaits sanction of their host side effects; the v5 bus
  memory.recall argv audience (pre-existing) flagged for an issuer-role
  gate; the asCapability projection layer retires when its last consumer
  cuts over.

## v5.10.5 (2026-07-24)

### v6 Phase 1 — image + secret on the extension contract (#82 follow-on)

- **The first two organs live on the v6 seam.** `image` and `secret` are now extensions
  (`createImageExtension`/`createSecretExtension`, `src/capability/modules/`): each declares a
  discoverable capability with routing prose + examples (`image.generate`, `secret.request`),
  a zod input schema validated by the registry at the seam, and a single `invoke` that returns
  `ok/error` results instead of process-exiting — daemon-safe from day one, so the concierge
  can dispatch them in-process when its call site cuts over (Phase 2+).
- **The CLI is the one live call site reading from the `ExtensionRegistry`.** The new
  `asCapability` projection (`src/ext/compat.ts`) bridges an extension's carried v5 facets
  into the existing `CapabilityRegistry` slots, so CLI dispatch, help order, and collision
  checks stayed byte-identical — both characterization suites green, untouched. The projection
  (and the v5 factory-table entries, now thin wrappers over the extensions) retire in Phase 4.
- **Contract completion:** `Extension` now carries `cliHelp` + `skillDoc`, the two v5
  capability facets the #82 skeleton had missed — without them a migrated organ would drop out
  of the auto-generated `beckett` command list.
- **Shared throwing cores.** The secret flow's `resolveRequestSpec`/`mintAndDeliver` (and
  `runQuiet`) now throw instead of calling `fail()`; the CLI surfaces identical `error: …`
  output via `main()`'s catch, and the invoke path can never exit the daemon. Env preflight
  (`CLOUDFLARE_*`) stays ahead of any systemd/tunnel side effect.
- **Memory hardening (same push, pre-Phase-6 lane):** `remember` rejects description-less
  creates that previously orphaned unparseable files; warm-graph stamping is race-safe; ttl
  expiry is evaluated at recall time so the warm daemon demotes lapsed facts; maintenance
  plans are deterministic (name-sorted pair scan); plus `src/memory/CLAUDE.md` documenting the
  invariants and extension points for building on memory.

## v5.10.2 (2026-07-23)

### Queue-free conversation UX + stale-memory fix

- **The turn queue is invisible now.** A directed message that lands while the channel's session
  is mid-turn already interrupted it (cancel-and-amend, issue #117); its queue-side converse is
  new: a rapid follow-up from the same speaker **silently supersedes their own still-queued
  earlier turn** (`ConciergeSession.supersedeQueuedTurns`, wired through the SessionPool). The
  dropped turn resolves as a silent pass — its text still reaches the session via the shared
  channel window, so nothing is lost — and other speakers' queued turns are never touched. The
  `FAST_ACK_TEXT` ("…you're next in line") bubble and its per-channel dedupe are **gone**: a
  mention never sits in a line, so nothing narrates one. The typing indicator is the only
  waiting signal; the 25s "Still working on this" progress ack stays (it's what a person would
  say). Doctrine bans schedule-narration and steer-meta-narration outright ("okay, that will be
  steered" → just answer the new message).
- **Threads for multitasking, in doctrine.** Parallel work fans out into task-workspace threads;
  the concierge says it *started* a task, never "queued" it.
- **Reply context reaches back** (`src/concierge/reply-context.ts`). A native reply whose target
  is outside the session's window (the months-old-message case) fetches the target **plus the 5
  messages before and after it** (`shared_context.reply_context_surrounding`, new) from Discord
  and injects them stamped with the target's absolute date and compact age ("7mo ago" —
  `formatMessageAge` now spans months/years and the awareness footer shares it). In-window
  replies get a one-line pointer instead; a deleted/unreachable target degrades to an honest
  "ask what they're pointing at" one-liner. Fetched history is framed as data, never authority,
  with multi-line content nested so it can't forge frame structure.
- **Memory is dated observations (alita-inspired).** Every node is an observation made at a
  point in time — **never deleted for age**, never mistaken for current truth. New
  `src/memory/freshness.ts` is the shared spine: recall scoring gently prefers the *newer*
  observation on ties (×0.92 past 1y untouched, ×0.85 past 2y — ties sink, nothing drops;
  boosts for ≤30d/≤180d unchanged); every render path stamps the observation date — recall CLI
  text (`updated: … (7mo ago — an observation from then)`), recall JSON
  (`updated`/`age_days`/`dated_observation`), the agent-recall candidate block (plus an
  observation rule in its prompt: newer wins on conflict, anchor aged ones "as of …"), and the
  always-loaded MEMORY.md (` · upd YYYY-MM-DD` on 90d+ lines, flowing from `IndexLine.updated`).
  The daily maintenance pass now reports **aged observations** (no-ttl nodes untouched 180d+,
  oldest first) — a report-only *re-observation queue*, never an archive-by-age list; the only
  archive paths remain the explicit ones (ttl, supersede, merge). A `remember` update is a
  fresh observation: verify an aged one against the world, save the outcome, and the graph's
  current truth advances with history intact underneath. The concierge doctrine teaches exactly
  that loop.

## v5.10.1 (2026-07-23)

### Deterministic browser MCP attach (#76)

- **Root cause.** A browser leg spawns `claude -p` with `--mcp-config <run>/mcp.json
  --strict-mcp-config --tools mcp__browser__betterwright_browser`. The `browser` MCP server is a
  stdio process (`src/browser/mcp.ts`) that Bun cold-imports on each leg; under the CPU contention
  of a live browser its boot + handshake intermittently lost the race against claude's default MCP
  startup timeout. With `--strict-mcp-config`, a server that misses the deadline is dropped
  silently — the leg then runs with ONLY the built-in json-schema output tool. The model, unable to
  act, either bailed (`dc8ae3d8`: "the betterwright_browser tool … was not available") or emitted a
  contentless `needs_input` that surfaced as the bogus "requested input without saying what it
  needs" question (`aa97f1d3`). Both are the same no-tool condition; runs with the tool attached
  showed 15–18 `eval` journal entries, tool-less ones showed zero.
- **Fix — make attach deterministic.** The MCP server touches a per-run attach marker the instant
  claude negotiates `initialize`/`tools/list` (proof the tool reached the toolset). The agent
  clears the marker before each leg and, after the leg exits, refuses to interpret the result
  unless the marker is present. A tool-less leg is discarded and re-spawned (bounded,
  `LEG_MAX_ATTEMPTS = 3`, fresh session id per fresh attempt); exhausting the retries finalizes as a
  clear infrastructure error — never a bogus "done" and never a human question. The raised
  `MCP_TIMEOUT` (60s) lets the server win the race in the common case; the marker + retry catch the
  residual failures.
- **Kill the hollow-question path.** A `needs_input` with an empty question is finalized as a fault,
  not parked as a person-answerable ask, closing the `aa97`-style path at its root.
- Regression tests (`src/browser/agent.test.ts`): a leg whose tool never attaches fails fast as
  infra (three legs, `attached:false` journalled, zero questions, never `done`/`waiting`); a
  transient first-attempt miss is retried and then succeeds.

## v5.10.0 (2026-07-22)

### Browser lane v2 — observable, steerable, context-fed

- **Context sharing at dispatch.** `beckett browser "<task>" --context "<background>"` carries
  conversation color (who asked, preferences, what was tried) into the run, framed below the
  task as background rather than instructions, above the secrets preamble.
- **Observability: run journal + `beckett browser watch <run-id>`.** Every browser evaluation
  already crosses the daemon's `browser.eval` boundary; it now journals to
  `browser-agent/<run>/journal.jsonl` (active page URL/title, duration, errors, steers,
  questions, outcomes — keychain values and human answers redacted). `watch` returns the run
  state, journal tail, and a fresh page screenshot while the run holds the lease;
  `browser status` now names each run's task, parked question, and finish time.
- **Steering and cancellation.** `beckett browser steer <run-id> "<guidance>"` delivers
  mid-run guidance into the agent's next tool result as a distinct STEERING block (MCP
  bridge); a run parked on a question is resumed with the note framed as guidance instead.
  `beckett browser stop <run-id> [--reason]` kills the leg, releases the browser, and reports
  a new terminal state `cancelled` through the normal outcome path. Both are same-channel
  gated, matching dispatch.
- **Inline one-off lane.** `beckett browser exec "<betterwright js>"` (bus `browser.exec`)
  lets the Concierge run ONE script against the shared persistent browser in its own turn —
  only while the background agent isn't holding the lease, no credentials, screenshots left
  on disk for Read/attach. Honors OPS-43: still a CLI verb, no MCP in the concierge session.
- Doctrine updates: browser skill + concierge.md teach the new verbs and when to use each
  lane; the agent prompt treats steering as authoritative over the original task text.

## v5.5.0 (2026-07-20)

### Background browser agent with pause/surface/resume (#58)

- **Browser / computer-use work is fully decoupled from intake.** The quick lane's
  `computer-use` agent is replaced by a dedicated background browser agent
  (`src/browser/agent.ts`): the Concierge dispatches with `beckett browser "<task>"
  [--creds <jingle-entry>]` (bus `browser.run`) and its turn returns instantly — the intake
  session can never again wedge on a browser tool call.
- **Pause / surface / resume.** When the agent needs a human (verification code, missing
  credential, disambiguation) it parks the Claude session, posts ONE screenshot-backed
  question to the origin channel through the existing ledgered anchor path, and resumes the
  same session from the person's native reply (which is still deleted before use).
- **Keychain credentials, injected below the transcript.** `--creds <entry>` resolves a
  jingle entry (`src/secret/keychain-read.ts`: values via `jingle exec` env carrier, TOTP
  codes minted fresh per script) and exposes it as a read-only `secrets` object inside every
  `betterwright_browser` script. Values are prefixed onto the script daemon-side at
  `browser.eval` and scrubbed from every result, console line, and error that flows back, so
  they never appear in a transcript, log, or the durable ledger.
- **Outcomes are update turns, backed by a durable ledger.** Completion, failure, and timeout
  report to the Concierge as a `browser-agent outcome` update turn (proof screenshots attach
  via the existing `beckett discord reply --file`). Runs persist in
  `~/.beckett/browser-agent/runs.json`; a daemon crash or shutdown mid-run is detected at
  boot and reported to the origin channel instead of dying silently, and undelivered outcomes
  retry until the Concierge takes them.
- The quick lane is fire-and-report only again (`quick-code`, `repo-explorer`);
  `beckett quick computer-use` now points at `beckett browser`. Browser artifacts moved from
  `~/.beckett/quick/` to `~/.beckett/browser-agent/`.

## v5.3.2 — faster cold ambient interjections (2026-07-18)

### Faster cold ambient interjections (#123, #158)

- Cold ambient bursts now flush after an 8-second quiet period rather than 20 seconds, removing
  12 seconds from the triage/session path while retaining burst assembly. The engaged continuation
  lane remains a 4-second lull, and every candidate still reaches the session turn, which can PASS
  when the moment is no longer timely. When `CEREBRAS_API_KEY` is present, the existing default
  fast Cerebras triage provider remains selected instead of spawning the Claude CLI.

## v5.2.0 — tracker cutover to bored (2026-07-16)

### Tracker cutover: bored is the only ticket queue (OPS-191)

- **Plane is gone.** `src/plane/` (client, poller, presets, cast helpers) is deleted; the shared
  pieces now live in `src/tracker/` (types, cast blocks, presets, poller) and the only backend is
  the loopback [bored](https://github.com/frgmt0/bored) service (`src/bored/`, reached via
  `BECKETT_BORED_URL`, default `http://127.0.0.1:7770`). `createTrackerClient` always constructs
  the bored client; the `BECKETT_TRACKER` selection flag from OPS-190 is removed rather than left
  as a half-flag that could name a backend that no longer exists.
- **Config:** the `[plane]` section is replaced by `[tracker]` (`poll_secs`, `default_board`,
  `boards` as a plain name array — bored keeps its own workflow, so boards carry no per-board
  config). A legacy `[plane]` section in an existing `~/.beckett/config.toml` is still accepted
  and folded into `[tracker]` at load time so a pre-cutover box boots untouched; its Plane-only
  keys (base_url, workspace_slug, project_slug, state_map) are discarded.
- **Secrets:** `PLANE_API_TOKEN` / `PLANE_INTERNAL_URL` (and the whole Plane `.env` block) are no
  longer read or required — bored is credential-free on loopback. `beckett doctor` now probes
  `GET /health` on the bored service instead of a Plane token; the installers no longer prompt
  for Plane URLs/workspaces/tokens and preflight the tracker connection instead of provisioning
  Plane boards. `deploy/plane/` (the self-hosted Plane stack) is deleted.

## v5.0.0 — multiplayer concurrency, computer use, self-host installer (2026-07-16)

### Incoming AgentMail notifications (OPS-173)

- **Chosen delivery: durable polling fallback, not a webhook.** The daemon has no public HTTP
  surface (only its local Unix control socket), so registering an AgentMail webhook would require
  exposing a new public service. When `AGENTMAIL_API_KEY` is available, it instead polls the existing
  `0xbeckett@agentmail.to` inbox every 30 seconds through the same SDK used by `beckett mail`.
  Startup establishes a silent watermark, and `~/.beckett/mail-listener.json` permanently dedupes
  message IDs before redelivery/restart can create another turn. Each new inbound message is a
  queued `SYSTEM (incoming email …)` Concierge turn carrying sender, subject, snippet, and ID;
  outgoing mail and pre-existing mail stay silent. No mail secret is stored in source or state.

### Concurrent conversations — per-channel concierge sessions (OPS-80 §9.3)

- **Beckett is no longer single-threaded across Discord.** The Concierge used to run ONE
  `claude -p` session for the entire surface, so every turn — every user, channel, and DM —
  queued behind a single pump ("On it — you're next in line"). Sessions are now keyed to the
  channel (a DM is its own channel): conversations in different channels run truly concurrently,
  bounded by a shared turn gate (`[concierge] max_concurrent_turns`, default 3). Same-channel
  turns stay strictly ordered, and person mentions still jump queued update turns.
- **Structural DM partition.** A DM's transcript now lives in its own session — guild turns and DM
  turns no longer share one model context, closing the model-side DM↔guild bleed that doctrine
  alone used to hold (multiplayer design §6.1 residual).
- **Process economics.** Live `claude` children are capped (`max_live_sessions`, default 6): the
  least-recently-used idle session's child is recycled and resumes on demand (`--resume`, context
  intact), and an idle timer (`idle_recycle_minutes`, default 30) reclaims quiet ones. Each
  channel's session persists under `~/.beckett/concierge-sessions/` and survives restarts
  independently; rotation, crash-loop alarms, and handoffs are all per-session.
- **Exact issuer correlation.** Every concierge session exports an unforgeable per-session token
  into its child's env (`BECKETT_SESSION_TOKEN`); the CLI echoes it on each control-bus call, so
  reply claims, `proactivity set … auto`'s owner gate, computer-use authorization, and
  `discord decline` resolve to the turn that actually ISSUED the command — a turn in one channel
  can never claim, or be authorized by, a concurrent live turn in another. Tokenless (human CLI)
  calls fall back to unambiguous-only matching and refuse to guess (`discord decline` gained
  `--channel`). Ticket, PR, and quick-agent updates route to their origin channel's session,
  grouped per channel.
- **Kill switch + upgrade shim.** `[concierge] session_scope = "global"` restores the
  single-session behavior exactly. On the first per-channel boot the legacy
  `concierge-session.json` migrates to the home scope, so yesterday's conversation still resumes.
  `beckett status` now reports per-scope session stats plus the turn-gate readout.

### Multiplayer memory — provenance and visibility scoping

- Knowledge-graph memory now records structured provenance (who taught a fact, `--by`/`--by-name`)
  and a `visibility` scope (`public` / `owner` / `dm` with `--dm-with`); recall applies a
  fail-closed audience filter (`--viewer`, `--viewer-role`, `--context`), so a fact learned in a
  DM can no longer leak into guild answers and owner-private facts stay with the owner.

### Autonomous persistent computer use

- **Playwright-shaped, not Playwright-prompted.** Computer-use now receives one compact
  `playwright_eval` tool and a replacement system prompt instead of the stock multi-tool
  Playwright MCP catalog. It writes ordinary Playwright JavaScript, batches related work, uses AI
  ARIA refs, and can drive multiple pages concurrently. The public browser/raw-CDP wrappers reduce
  accidental misuse but are not treated as a boundary: the controller force-disposes every
  non-default browser context, including targetless contexts reached through Playwright internals,
  and counts hidden page/download targets from root CDP.
- **A real browser identity with disposable evaluator processes.** A dedicated persistent Chromium
  profile keeps cookies, local storage, cache, and signed-in state across quick-run and daemon
  boundaries. On Linux, the daemon starts the trusted controller and each tool call's evaluator in
  separate sibling `bubblewrap` sandboxes; both drop all capabilities. A stuck evaluator dies
  without losing tabs, form state, or the question/resume session. This is a filesystem/process
  boundary, not a separate-UID or network boundary, so production remains a dedicated-host design.
  The Bun daemon now launches a Node controller, which manually starts Chromium with one loopback CDP
  port instead of combining Playwright's flaky managed pipe/WebSocket and port paths under Bun. An
  asynchronous adaptive 100 ms-to-2 s allocated-byte watchdog fails leases above 100 MiB of profile
  growth or the 512 MiB absolute ceiling without wiping persistent cookies. A bounded, atomic,
  mode-`0600` controller snapshot also restores session-only cookies after host recycling.
- **Questions that actually wait.** Browser work detaches immediately. A genuine blocker parks the
  Claude session, posts the relevant page screenshot to Discord, consumes a native reply without
  leaking it into shared chat context, then resumes the same session. Password fields and
  agent-created credentials are allowed rather than treated as an automatic dead end. Computer-use
  is available to every user admitted through Beckett's normal owner/access-list gate, and
  follow-ups stay bound to their initiating user. Every exact resumed answer is redacted from later
  questions and summaries. Question
  correlation fails closed by deleting a visible question if its durable ledger cannot be written;
  whitespace is normalized and Discord `singleMessage` keeps prompt, instruction, and a reserved-name
  screenshot together. The suffix-plus-attachment marker recognizes orphan replies even if a crash
  happened before ledger persistence, while uninspectable bot references are consumed with resend
  guidance. Stale anchors are retained until Discord confirms deletion; only then does the seven-day
  tombstone expiry begin. Every recognized answer is deleted from Discord before use, including
  stale and unauthorized replies; deletion failure refuses the answer. The ledger is capped at
  1,000 without dropping unconfirmed anchors.
- **Evidence, not victory prose.** Visible success states are captured by the trusted runtime with
  fail-closed sensitive-page redaction and attached directly to the final result. Chromium stays
  warm for the full task, tool output is bounded, and the browser prompt plus tool/result schemas
  have a tested sub-3,000-token budget. Minimal terminal-result envelopes persist before delivery,
  retry live and after restart, retain proof screenshots after attachment failures, and bypass
  third-party Chilltext processing.

### One-command self-host installer

- **Fresh VPS to staged Beckett in one command.** The new repository-root `install.sh` supports
  Ubuntu/Debian x64 and arm64, creates an unprivileged lingering service account, installs the
  official Node 24 LTS/Bun/Claude/Codex/Pi/GitHub toolchain, clones and typechecks Beckett, prompts
  privately for instance configuration, and is safe to rerun.
- **No credential crash loops.** The lower-level unit installer gained `--no-start`; normal starts
  require the core secrets plus Claude login, provision every Plane board, and wait for a real
  control-socket response. Failed readiness disables both daemon and heartbeat instead of leaving
  either active. Reruns reset start limits and restart onto current code rather than accepting an
  already-running stale process.
- **Portable Bun and current Pi runtime.** Units resolve Bun from their explicit daemon `PATH`
  rather than assuming `/usr/local/bin`. Pi's current package requires Node `>=22.19.0`, so its
  preflight and `beckett doctor` now enforce that floor; disabled optional harnesses are no longer
  reported as broken.
- **No silent root escalation.** The public path does not add passwordless sudo or relax AppArmor.
  Secrets/config are mode `0600`, the state directory is `0700`, root secrets are removed before
  subprocesses and service-user commands cross an `env -i` boundary. User-owned paths are mutated
  only after dropping privileges, and config/env symlinks are refused.
- **Current Plane and portable ownership.** Plane Cloud uses separate app/API origins, API calls use
  the current `/work-items/` routes, and provisioned workflow states include required colors. The
  configured GitHub owner now flows through repo publishing, worker guidance, Concierge doctrine,
  doctor validation, and fallback links instead of silently targeting `0xbeckett`.

### Ambient classifier: natural turn-taking and reliable fast scoring

- **Turn-taking, not keyword relevance.** The triage rubric now judges the latest unresolved turn,
  addressee, conversation state, and marginal value of speaking. Balanced contrasts cover pivots,
  already-answered questions, accepted Beckett offers, natural closers, venting, and prompt-injected
  chat text. The model emits a threshold-independent utility score and candidate kind; runtime code
  derives the final speaking decision from the configured threshold.
- **Better conversation signals.** Native Discord reply targets survive the shared-context store and
  reach both triage and engaged-turn framing. Beckett is mechanically excluded from the human roster,
  and the burst is no longer duplicated in recent context.
- **Faster and more dependable calls.** Static instructions are cached and separated from untrusted
  JSON conversation data. Cerebras uses strict structured output with a smaller completion budget;
  Claude runs in isolated safe mode without tools, skills, Chrome, session persistence, or extended
  thinking. Verdict logs now include provider, model, addressee, and elapsed time.
- **False-positive backstops.** A cold verdict aimed at another human cannot pass the runtime gate.
  The engaged lane now treats recent Beckett activity as a hint and revalidates native replies to
  known humans with the fast classifier before typing or spending a full turn. The session verifies
  the remaining ambiguous continuations. A labeled opt-in eval reports accuracy and latency.

## v4.2.0 — Coworker-as-a-Service threads + better memory (2026-07-10)

### OPS-121 — better memory: sharper recall, global context, routine staleness pruning

- **Sharper recall (still keyword/relevance — deliberately no semantic/embedding layer).**
  Retrieval scoring moved to `src/memory/search.ts`: light stemming ("deploying" finds
  "deploy"), IDF weighting (rare terms outrank ubiquitous ones), full-node scanning (bodies
  and metadata values are searched, not just the one-line description), prefix credit, and
  coverage scaling so multi-word queries rank whole-fact matches first.
- **First-class `beckett recall`.** A top-level, targeted retrieval command:
  `beckett recall "<query>" [--type person,project,...] [--name <node>,...] [--k N] [--hops N]
  [--json]`. `--type`/`--name` are hard filters (an explicitly named node is never ranked
  out), hits print with file paths, and `beckett memory recall` keeps working as the same
  command under its original spelling.
- **Global/cross-session context.** The graph is rebuilt from disk on every call and recall
  now sees a fact wherever it lives in a note, so memories written in one session are reliably
  retrieved in later ones; the always-loaded `MEMORY.md` index rides along with every result.
- **Routine maintenance (`beckett memory maintain`, `src/memory/maintain.ts`).** The daemon
  runs a self-healing pass shortly after boot and daily: nodes whose `ttl` expired past a
  7-day grace are archived, `supersedes` links retire the superseded node, and near-identical
  same-type nodes are merged (canonical keeps both bodies, the duplicate's name becomes an
  alias, inbound wikilinks are rewritten). Borderline pairs are only flagged — auto-merge
  stays conservative. `--dry-run` plans without writing.
- **No data loss, ever.** Nothing is deleted: retired files move to `<memoryDir>/archive/`
  with `archived`/`archived_reason` stamped, excluded from the graph but on disk and
  git-versioned. Existing per-fact markdown files and the `MEMORY.md` index format are
  unchanged; the live store parses as-is (verified read-only against production memory).

### Coworker-as-a-Service threads: user-opened workspaces + a private worker journal

- **People open threads, Beckett moves in.** A thread a USER creates registers as a ticket
  workspace (`src/discord/workspaces.ts`, fed by the gateway's thread-create event). Authorized
  messages there are directed Concierge turns without an @mention, grounded in the Plane tickets
  named in the thread title and any ticket filed from inside the workspace. Routing persists in
  `workspaces.json` across daemon restarts, and the code-level access gate still bounces
  unauthorized users inside a workspace.
- **Beckett stops spawning threads.** The bot-created per-ticket progress/activity threads (and
  the planned `· with Beckett` siblings) are gone, along with the legacy migration that fabricated
  threads for old tickets. `startThread`/`startStandaloneThread` left the gateway contract.
- **The verbose log is kept — privately.** The worker event firehose (tool calls, file edits,
  hook blocks, verdicts) now appends to a private ticket-keyed journal
  (`<beckettDir>/journal/<ticket>.log`, `src/progress/journal.ts`). The Concierge pulls it on
  demand — `beckett journal <ticket> --tail N` — as separate context when someone asks how the
  work is going, and answers with a clean human summary instead of dumping raw output.

### OPS-112 — idempotent Discord CLI replies

- **Root cause:** `beckett discord reply` is a control-bus request, not a direct Discord API call.
  The CLI previously gave its daemon acknowledgement a fixed 30-second budget. That was shorter
  than the optional chilltext formatter's 35-second fallback deadline: when the formatter was slow
  or unavailable, Discord could receive the raw message just after the CLI had printed a hard
  `control bus timeout` error. The control-bus server awaits asynchronous work per socket, so this
  is not an event-loop-blocking startup task; it is an acknowledgement budget that was too short
  for normal reply work (and a reconnect can extend it further). `src/rpc/daemon.ts` is only the
  desktop rich-presence client; the relevant control server is the Concierge's
  `src/shell/control-bus.ts` socket.
- **Safer outcome:** reply acknowledgements now wait 75 seconds by default (override with
  `BECKETT_DISCORD_REPLY_ACK_TIMEOUT_MS`). A timeout exits successfully with an explicit
  `{"status":"unknown","mayHaveSent":true}` result and a do-not-retry warning, rather than
  pretending the post definitely failed.
- **Idempotent retry window:** the Concierge coalesces in-flight and recently successful identical
  `(channel, content, attachments)` reply requests for two minutes, returning the original result
  instead of sending another Discord message. Failed sends are not cached, so genuine failures can
  still be retried. This is the second line of defense if an acknowledgement is lost.

## v4.1.3 — ambient: addressee gate + concierge decline backstop (2026-07-07)

First slice of the OPS-99 addressee gate (OPS-101): interjections that were aimed at another
person ("ro, can you look at the deploy?") shouldn't pull Beckett in. Two coupled layers, both
reading the same addressee signal.

- **Classifier reads the addressee** (`triage.md` / `triage.ts`): the Gemma triage prompt now
  gets a `<participants>` block (who's in the room + who spoke the latest message), a short
  "who Beckett is" grounding (concierge / front-of-house / files tickets), and an explicit
  first-step decision — is the latest message aimed at Beckett, another person, the room, or
  unclear? A message aimed at *another person* is told to score hard toward NOT interjecting.
  The verdict carries a new `addressee` field (`beckett|other|group|unclear`); it defaults to
  `unclear` when omitted so a missing field is a soft downrank, never fail-closed silence that
  would ghost a real beat.
- **Concierge gets the signal + a decline backstop** (`index.ts`): the cold ambient frame now
  surfaces triage's addressee read, and — because the classifier can be wrong — the concierge
  can run `beckett discord decline` BEFORE writing anything to abort the turn and post nothing
  (the hold-and-cancel backstop, OPS-99 §5.3). Cancellation degrades to a synthetic `PASS`: no
  message, no cooldown, engaged window untouched — no partial/half-posted state can exist.
  Decline is *terminal*: a `discord reply` issued after declining is refused, so the abort can
  never leak a partial message out the side door.
- **Directed messages are untouched**: a real @mention/DM never enters the ambient path, and
  the bus hard-rejects `discord.decline` off the mention path — a directed message is answered
  exactly as before, never gated, held, or dropped.

## v4.1.2 — ambient: conversational cadence (2026-07-06)

Live testing of v4.1.1: the conversation flowed, then Beckett "dropped out at the end" and
replies took a minute with no signal it had seen anything. All cadence, not classification.

- **Engaged lull ≠ cold silence** (`engaged_quiet_secs`, default 4): mid-conversation the flush
  now fires on a 4s lull instead of the cold 20s `burst_quiet_secs` — which every new message
  reset, so with three people bantering Beckett literally couldn't get a word in until the room
  went quiet, then looked like it wandered off.
- **Typing indicator on engaged + consent turns**: people talking WITH Beckett see "beckett is
  typing…" the moment the turn starts. Cold candidates stay untelegraphed — no typing over a
  conversation it may still PASS on from eavesdrop distance.
- **Caps are backstops, not rations**: the classifier is the thing that stops reply-to-everything
  — `channel_cooldown_secs` 300 → 60, `max_interjections_per_hour` 10 → 0 (disabled).

## v4.1.1 — ambient: stop ghosting people mid-conversation; Cerebras classifier (2026-07-06)

OPS-86/87 retuned the classifier prompt but Beckett still went silent the moment people engaged
with it. Two structural gates were doing that, both fixed, plus the classifier moves off Haiku.

- **Engaged-conversation lane**: after Beckett speaks in a channel, its chatter for the next
  `engaged_window_secs` (default 180) is a *continuation* — no triage, no cooldown, no hourly
  budget. The turn arrives as `SYSTEM (ambient continuation …)` where the default flips to
  "reply unless it's clearly over" (the session can still PASS a bare "k"). Haiku was scoring
  replies-to-Beckett as "piling on"/"crowding the room" and refusing them.
- **Offers only on cold interjections**: every ambient post used to arm the offer/consent
  machinery, which then swallowed ALL channel messages for 10 minutes with "unrelated → PASS"
  instructions — the other half of the silence. Engaged replies no longer arm offers; the
  consent frame now answers declines and banter like a person; a consent reply only resolves an
  offer when it comes from the person the offer was made to.
- **Cold caps retuned**: `channel_cooldown_secs` 900 → 300, `max_interjections_per_hour` 4 → 10
  (they gated bursts BEFORE triage, so the retuned prompt never got asked); triage.md gains the
  rule that a burst responding to Beckett is never "crowding the room".
- **Cerebras classifier** (`[proactivity] triage_provider = "cerebras"`): the burst scorer can
  now run on Cerebras' OpenAI-compatible API (e.g. `gemma-4-31b`, ~1850 tok/s) instead of
  spawning the claude CLI — wire-speed and off the subscription. Key = `CEREBRAS_API_KEY` in
  `~/.beckett/.env` (inventoried in `.env.example`); fails closed like the claude path.

## v4.1.0 — server memory: cross-channel awareness + on-demand recall (2026-07-06)

The per-channel shared context (v4.0.0) grows a server-wide layer. Beckett now *knows about* the
other channels' conversations without loading them: someone in `#general` asks for "a site with
our favorite movies" and Beckett fetches the actual movie debate from `#media` instead of asking
people to repeat themselves. Design: `docs/design/server-memory.md`.

- **Channel profiles** (`src/concierge/channel-profiles.ts`): every ~20 new entries in a guild
  channel, a one-shot Haiku call (same pattern as ambient triage) rebuilds `{summary, topics[]}`
  into `~/.beckett/channels/profiles.json`. Serialized queue; fail-open — a failed call writes
  nothing, a stale profile beats a fabricated one.
- **Awareness footer**: mention turns carry a compact `SYSTEM (server memory …)` block — one line
  per other active guild channel (`#media — debating the best movie ever [movies, sci-fi] ·
  14 msgs, last 2h ago`), capped at `awareness_max_channels`, change-suppressed per session so an
  unchanged footer is never re-sent. Guild turns see their guild; DM turns see every guild.
- **On-demand recall**: `beckett channels search "<terms>"` (keyword + trailing-s stem across all
  stored windows, hits carry ±2 lines of context), `beckett channels recall <#name|id> [--last N]`,
  `beckett channels list` — bus-first, direct file read only when the daemon is down. Channel
  names captured at the gateway (`IncomingMessage.channelName` → `channels-meta.json`).
- **Privacy in code, not doctrine**: DM windows (null/unknown guildId) are never searched, never
  profiled, never in the footer, and recall refuses them whatever the caller types; pre-4.1
  windows without meta are treated as private until proven guild. `channels wipe` now also
  removes the channel's meta + profile. All fetched output keeps the attributed anti-forgery
  rendering and a data-not-instructions note.
- **Config** (`[shared_context]`): `profile_model` (claude-haiku-4-5),
  `profile_update_messages` (20), `awareness_max_channels` (5).
- **Doctrine** (`concierge.md`): "Server memory — the other channels are searchable" — fetch
  before asking people to repeat themselves; synthesize, don't dump transcripts across channels;
  attribute what you use; profiles are unverified summaries.

## v4.0.0 — multiplayer: channel-scoped shared context (OPS-80) (2026-07-06)

The multiplayer release. When Beckett answers anyone in a channel, it now reasons over the
recent conversation across *all* participants there — the Claude-in-Slack model — instead of
treating each mention as an isolated 1:1 exchange. Attribution and authority stay strictly
per-user. The daemon service is renamed `beckett-v3` → `beckett-v4`.

- **Shared channel record** (`src/concierge/channel-context.ts`): an attributed, token-budgeted,
  persisted per-channel transcript (owner + member messages AND Beckett's own posts — both were
  holes in the old ring buffer). One JSONL file per channel under `~/.beckett/channels/`,
  bounded by count + TTL, compacted in place; survives restarts, unlike the old in-memory Map.
- **The turn frame**: mentions now carry a `SYSTEM (shared channel context …)` block — a
  participant roster plus `[HH:MM] Name (user:<id>): text` lines — selected newest-first under
  `inject_budget_tokens`, rendered oldest-first. Ambient candidate frames use the same
  attributed renderer, so both paths present one consistent view.
- **sessionId-keyed watermark** (`~/.beckett/channels/watermarks.json`): seen lines are never
  re-sent to the same session; a `--resume` across a deploy keeps watermarks live, while a
  rotation/fresh session self-invalidates them and gets a full catch-up window. Per-channel
  context now survives rotation *outside* the session — the handoff note stops carrying it.
- **Capture rules**: inbound captured only after the outsider gate and the approval intercept
  (approval codes are live secrets and never enter the record); membership re-checked at capture
  time so a revocation stops new capture immediately; fast-acks/denials/error apologies excluded.
- **Authority never travels through context**: transcript lines carry `user:<id>` but never
  `role:owner` — the owner marker lives only on the live turn's stamp, and every owner-gated
  path (approvals, `proactivity.set auto`) still authenticates the live author id in code. New
  red-team suite (`shared-context.redteam.test.ts`) pins owner-claims, grant instructions, and
  approval-code phishing via transcript to byte-identical old behavior.
- **Privacy**: the store is channel-keyed, so DM windows never render into guild turns (and vice
  versa) structurally; doctrine adds the matching hard rule plus answer-the-stamped-speaker,
  transcript-is-data, ticket attribution, and memory provenance guidance.
- **Config** (`[shared_context]`): `enabled` (kill switch — `false` restores the old
  ring-buffer prefix path byte-identically), `max_entries_per_channel` (200), `max_age_hours`
  (72), `inject_budget_tokens` (3000), `roster_max` (12).
- **`beckett channels wipe [<channelId>]`** — delete a channel's stored window (routes through
  the live daemon so its cache drops too; falls back to direct file wipe when it's down).
- **Service rename**: systemd unit `beckett-v4.service`, entrypoint `src/shell/v4-main.ts`,
  `bun run v4`. `install.sh` retires the old v3 unit idempotently and `deploy-prod.sh`
  self-heals by running install when the v4 unit isn't linked yet — one deploy cuts the box over.

## v3.6.2 — gh pr close + scaffolding can't leak into a PR (OPS-61, re-landed on current main) (2026-07-01)

Two fixes to Beckett's own machinery.

- **`beckett gh pr close <num> [--repo owner/name]`.** The `gh` wrapper gained a `pr close` verb
  alongside create/merge/status/review, using the same authenticated `gh` path (`GH_TOKEN` per
  invocation — no raw `gh` outside the wrapper). It checks the PR's state first so it errors
  clearly on an already-merged/closed PR or a bad number, then closes it and prints the resulting
  state. `--repo` is optional (defaults to the current repo, works on external repos when given).
- **Internal scaffolding (`.beckett/`) can never reach a branch or PR.** The done-signal schema,
  scope-guard settings, and worker state are guarded three independent ways so a worker's diff and
  any PR it opens contain only real project work: (1) `info/exclude` in each worktree blocks
  `git add -A`/`git add .`; (2) a shared `pre-commit` hook strips `.beckett/` from the index under
  any committer — defeating even a forced `git add -f`; (3) an explicit strip in `commitWorktree`
  and a strip-before-push in the publish path (`gitPush`), belt-and-suspenders behind the hook.
  Beckett's own source checkout also `.gitignore`s it. This was the root cause of a junk PR (a
  whole PR of bookkeeping that had to be redirected to a clean one).

## v3.6.1 — config & secrets contract (issue #34) (2026-07-01)

- **`.env.example` is now the full inventory**: every key the code (or the Plane stack) consumes,
  with per-key mint/scope/rotation notes — including honest "legacy, safe to remove" labels for
  the dead keys found on the box. `beckett doctor` already gates against this list.
- **`deploy/config.toml.example`** — every config key at its default, generated from the live zod
  schema via `beckett config print-default`; a drift test fails CI the moment the schema and the
  example disagree, and a round-trip test proves the example passes the strict validator.
- **Encrypted secrets backup** — `deploy/backup-secrets.sh` pulls the five recovery-critical files
  (.env, config.toml, claude/codex/pi logins) off the box and age-encrypts them to
  `~/.beckett-backups/` on the Mac (private key exists only there). First backup taken and
  decrypt-verified. NOT committed — the repo is public; the issue's in-repo sops file would have
  put encrypted secrets in permanent public history. Restore procedure in `deploy/host-setup.md`:
  a box rebuild is clone + one `age -d | ssh tar -x` + `install.sh`.
- **Discord token rotation** flagged to Jason on Discord with the exact 4-step procedure — the
  dev-portal reset is human-only.

## v3.6.0 — pipeline latency + polling diet (issue #33) (2026-07-01)

- **Polling diet**: each tick now sweeps the board with a slim `fields=id,updated_at` request
  (server-side narrowing, verified honored) and hydrates ONLY tickets whose `updated_at` moved —
  an unchanged 500-ticket board costs the same tick as a 20-ticket one. Comments are fetched
  newest-first (`order_by=-created_at`) with early-stop pagination once the cursor is reached; the
  60s comment backstop runs off the cached ticket, zero hydrations.
- **Instant tick on filing**: `beckett ticket create --channel …` → control-bus ping → `poller.poke()`
  → the dispatcher staffs the fresh ticket in well under a second instead of the 0–5s poll gap.
- **Instant done ping**: dispatcher advances now feed the same PollEvent shape straight into
  `concierge.notify` (and sync the poller snapshot so nothing double-pings) — a finish reaches
  Discord at write time, not ≤5s later.
- **DAG promotion no longer waits for GitHub**: dependents (which build from the local checkout)
  are promoted before the 2–8s publish — and even when publish fails and the ticket parks for a
  courier. The `done` label stays publish-gated (the OPS-30 false-done fix holds).
- **A stuck nudge can't freeze polling**: comment steers are delivered fire-and-forget; the
  receipt narration (issue #22 semantics unchanged) runs async. Pre-fix, one un-echoed nudge
  stalled ALL polling — including cancels — for up to 30s.
- **Per-event isolation**: one throwing poll event no longer takes down the rest of its batch
  (the poller's snapshot had already advanced, so those events were lost forever).

## v3.5.1 — doctrine coherence (issue #32) (2026-07-01)

The loaded doctrine no longer contradicts itself, describes retired machinery, or promises
senses that don't exist:

- **Deleted** `parent-doctrine.md` (100% v2) and the `flows`/`staff`/`review`/`proactive` skills
  (dead `beckett flow`/`worker spawn` commands; reviewer-spawning the doctrine forbids; an
  `[ambient …]` sense v3 never delivers). `grep -r "beckett worker|beckett work |beckett flow"
  .claude/` → zero hits.
- **Rewritten** `intake` (ack-first via CLI for tasks, plain reply for questions — now agrees
  with concierge.md; real v3 stamp format) and `plan` (the actual `beckett plan` JSON DAG, not
  the v2 node schema). `self-improve` now routes repo-owned changes (skills/doctrine/code)
  through a `--project beckett` ticket instead of instructing hand-edits to the deploy checkout.
- **concierge.md**: honest senses section (@mentions + system turns only — no overhearing); the
  walled-off-PR section rewritten around the real trigger (the dispatcher's publish-failure
  "needs a courier" park); new "when the machinery stalls" guidance (retry noise vs todo-return
  vs the rework-cap lever — `in_review → in_progress` respawns an implementer); honest
  "queued it" phrasing for the ≤5s dispatch gap.

## v3.5.0 — ops visibility (issue #30) (2026-07-01)

Before this, the only truth about prod was journalctl. Now:

- **`beckett status`** — a `status` control-bus command + CLI (`--pretty`): version/commit/uptime,
  poller last-poll age + consecutive failures, Plane last HTTP status/error, Discord gateway
  liveness, concierge session (context tokens, rotations, queue, crashes), and a per-worker table
  (ticket, stage, harness, pid, elapsed, last-event age). One ssh command answers "is prod healthy
  and what is it doing right now".
- **`beckett doctor`** — rebuilt for v3, probing under the DAEMON's PATH (the login shell hid the
  node-18 pi crash): binaries + version minimums, forced harness preflights, LIVE token probes
  (Plane/Discord/GitHub/Cloudflare/alert webhook), env completeness against the committed
  `.env.example`, harness process-leak sweep (orphans + off-ledger workers), control.sock probe,
  cloudflared ingress validation, disk space. Regression tests assert each detection the issue
  was opened for. Non-zero exit when anything fails.
- **Crash alerting** — `deploy/alert.sh` posts to a raw Discord webhook (`DISCORD_ALERT_WEBHOOK_URL`),
  deliberately not via the daemon: `ExecStopPost` alerts every unclean death within seconds
  (rate-limited), `OnFailure=beckett-alert@%n` + `StartLimitBurst` fires the terminal
  crash-loop alert. 25 silent daemon restarts in 3.5 days never happens again.
- **Logs + heartbeat** — beckett-rpc now logs to journald (the old `append:` rpc.log grew
  unrotated); a weekly `beckett-heartbeat.timer` posts a doctor report so alert-channel silence
  actually means healthy.

## v3.4.0 — the reliability wave (issues #11–#29) (2026-07-01)

One PR per GitHub issue, merged + deployed in sequence:

- **#11** token-leak sweep (superseded-child sweep before auto-resume relaunch).
- **#31** harness config truthfulness (`enabled` switches that are real, per-harness efforts, `extra_flags` validation).
- **#20** crash recovery: worker ledger, boot orphan sweep, `--resume` session recovery.
- **#17** harness preflight + failure taxonomy (auth/rate-limit/crash/timeout/spawn) + fallback chain.
- **#19** shared `BaseDriver`/`OneShotDriver` lifecycle; centralized child-env strip + numstat.
- **#21** worker supervision: stall ladder (nudge → abort+retry), `beckett ticket restaff`, artifact links on done pings, step-in skills.
- **#22** never drop a steer: held comments fold into the next brief; honest nudge receipts end-to-end.
- **#24** concierge session robustness: deploys resume the conversation, timeout isolation, reply-claim correlation, fast acks, crash-loop alarm.
- **#25** turn economics: ack-first doctrine, one turn per poll batch, noise pre-filter, `concierge.effort` knob, leaner worker briefs.
- **#27** right-sized review: Sonnet default at scaled effort with the diff inlined in the prompt.
- **#28** deleted the retired v2 stack (−13.6k LOC, 76 dead type exports, ~24 dead config keys).
- **#29** one-command versioned deploys: units in `deploy/systemd/`, `deploy/deploy-prod.sh`, one version source (package.json), clone-role contract.

## v3.3.1 — pi harness back from the dead (OPS-56) (2026-07-01)

**Every pi dispatch was dying at launch** with `PiDriver: process exited (code 1) before session
line` — so all backend/systems tickets cast to pi went silent and had to fall back to claude.

- **Root cause: CLI/version drift.** The PiDriver was written against pi 0.78.0's
  `--session-id <uuid>` (creates-if-missing) flag, but the installed pi is **0.72.1**, which has no
  such flag — it rejects it outright (`Error: Unknown option: --session-id`) and exits 1 *before*
  printing its `session` handshake line. Auth, the binary path, and the NDJSON protocol were all
  fine; the single bad flag took the whole harness down.
- **Fix.** pi 0.72.x pins/resumes an *existing* on-disk session via `--session <id>` and cannot be
  handed a caller-minted id for a fresh run. So the driver now passes **no** session flag on the
  first launch — pi mints + persists its own id, which we capture from the `session` line — and
  replays it with `--session <id>` on resume (same cwd → pi reloads the transcript). Verified with a
  real end-to-end pi ticket (spawn → tool call → file write → `finished`/success with parsed
  done-signal).
- **Hardened the failure mode.** A fast, offline **preflight** (`piPreflight`) now runs at every
  spawn and fails *loudly* if the pi harness is unusable — missing/unrunnable binary, CLI flag
  drift (it checks pi still advertises `--mode`/`--session`/`--print`), or a missing pi login
  (`~/.pi/agent/auth.json`). And when a child still dies before its session line, the error now
  folds in the captured **stderr tail** (e.g. the `Unknown option` line) plus the likely causes,
  instead of the opaque bare message. A dead pi harness surfaces immediately at dispatch rather than
  silently killing whichever ticket happened to be cast to it.

## v3.3 — progress threads + pi replaces codex (2026-07-01)

Two features and a sandbox fix.

- **Discord progress threads.** When Beckett files a ticket, the ack it posts now anchors a
  Discord **thread** that streams the granular per-worker play-by-play — tool calls, file edits,
  scope-guard blocks, plan ticks, and the verdict. The main channel stays sparse (one ack line);
  the firehose lives in the collapsible thread underneath it. A `beckett plan` DAG maps all its
  tickets onto the one thread, tagged by identifier; a single ticket's implement→review→rework
  workers all post there, tagged by stage. Rate-safe by construction: lines coalesce into one
  digest post per ~3s, the backlog is bounded (drop-oldest with an elision marker), and terminal
  events flush at once. New `src/discord/progress.ts` hub + `startThread` on the gateway;
  correlation rides a best-effort `ticket.filed` control-bus signal emitted at BOTH the
  `ticket create` and `plan` stamp sites, tied to the ack in the Concierge.
- **pi replaces codex as the coding harness.** New `PiDriver` (`src/drivers/pi.ts`) drives
  `pi -p --mode json` (pi.dev) as a one-shot worker with steer-via-resume — the same
  `HarnessDriver` surface as claude/codex, so the dispatcher casts `harness:"pi"` interchangeably.
  Pi is the malleable, **no-network-sandbox** replacement for codex (which kept stalling on
  sandbox network denials). Concierge doctrine now casts **pi (gpt-5.5, high) for backend/systems
  work**, claude (Opus) for frontend/taste + review. Auth is the ChatGPT/Codex OAuth via pi's
  `openai-codex` provider (`~/.pi/agent/auth.json`). codex is retained only for imagegen.
- **codex sandbox off.** codex's default `workspace-write` sandbox blocked network and stalled
  workers; the default is now `danger-full-access` (real containment is the scope-guard hook +
  each ticket's isolated project repo, not codex's own sandbox).

## v3.1.1 — first-real-tickets bug fixes (2026-06-30)

The first batch of real tickets (the `random` and `gravity-well` sites) surfaced four bugs:

- **Duplicate Discord replies.** On a direct @mention the Concierge answered twice — once via its
  auto-posted turn text, once by *also* running `beckett discord reply` (which it had been over-
  trained to do, since that command is the only path on automated update turns). Fixed: the
  Concierge now tracks the in-flight @mention turn; if it answers via the CLI, that becomes THE
  reply (native, once) and the auto-post is suppressed. Doctrine clarified — `beckett discord reply`
  is ONLY for `SYSTEM (automated ticket update…)` turns; a person's message just gets a normal reply.
- **GitHub repos 404'd.** Workers *did* push the project repos, but `beckett gh repo create` defaults
  to **private**, so `0xbeckett/<slug>` was invisible (404) to anyone not logged in as Beckett — and
  the Concierge handed out URLs that didn't resolve. Publishing is now **deterministic in the
  dispatcher**: on every done it pushes the project repo to `0xbeckett/<slug>` as a **public** repo
  (create-if-missing, else push + self-heal visibility to public), and posts the real URL on the
  ticket so the Concierge stops guessing. The unreliable "push it yourself via the github skill"
  worker instruction is gone.
- **Deploys didn't go public.** Workers improvised their own servers — a foreground `server.mjs`
  that died on session end, bound to localhost, with no systemd unit and (sometimes) no DNS record,
  so `<name>.0xbeckett.me` never resolved. The deploy note is rewritten into one exact recipe
  (durable `systemd --user` unit on a port → `beckett deploy <slug> --port <p>` for tunnel **and**
  DNS), forbids every improvised alternative (foreground/`&`/`nohup`, hand-editing the ingress), and
  requires the worker to `curl https://<slug>.0xbeckett.me` for a 200 before it may call the ticket
  done. Never report a URL you haven't curled.
- **A visual toy ground for 8 minutes.** OPS-19 (a canvas particle toy) was mis-cast to **codex at
  heavy effort** — codex can't see pixels, so it over-engineers visual work slowly. Casting doctrine
  sharpened: anything visual (canvas, game, animation, landing page) is **claude + `effort: low`**
  (fast, one-pass self-review), never codex. codex is for crisp-spec, no-pixel work only.

Also reaped a leaked worker process that had been idle for 7 hours (a gravity-well implement worker
whose OS process outlived its dispatcher bookkeeping), and flipped the existing `random` /
`gravity-well` repos to public.

## v3.1 — "go faster" (2026-06-30)

The v3 ticket loop was slow for a reason: it was fully serial and **every leg booted a cold
agent**. File a ticket → a worker booted fresh in a clean worktree, re-oriented, did the work →
a *separate* fresh reviewer booted and re-read the whole diff → on any nitpick it bounced all the
way back and a worker booted cold *again*. One tiny fix paid a full multi-minute round trip, and
a simple site took ~31 min where plain Claude Code took ~18. v3.1 attacks the per-lap fixed cost.

### Faster + properly decoupled
- **Every ticket builds its OWN repo.** `resolveRepoRoot` was hardcoded to Beckett's own source
  (`~/beckett`), forcing all work — and all the per-stage worktree churn — into the daemon's repo.
  Now a ticket works in **`~/Projects/<slug>`**, its own `git` repo, pushed to **`0xbeckett/<slug>`**
  on GitHub, **fully decoupled from `0xbeckett/beckett`**. The Concierge names the project
  (`--project balloons`); unnamed tickets sandbox under the ticket id. The dispatcher provisions it
  before the first worker (clone `0xbeckett/<slug>` if it already exists — continuing projects, or
  Beckett's own source for a `--project beckett` self-improvement ticket — else `git init`). The
  worker just builds in place and pushes via the github skill. No worktrees, no `wk_*` litter; each
  ticket is its own directory so `concurrency.max_workers` stays **2** and `beckett plan` nodes run
  in parallel. **A worker never touches the running daemon's checkout.**
- **Effort-scaled review (the big one).** A worker now **self-reviews its own diff against the
  acceptance criteria before finishing**, so most tickets skip the separate cold reviewer entirely:
  - cast `effort` `low`/`medium` (or `reviewTier: "self"`) → **one pass**, straight to `done`.
  - cast `effort` `high`/`xhigh` (or omit, or `reviewTier: "fresh"`) → a fresh adversarial reviewer
    runs, as before. Reserved for correctness-critical / hard-to-reverse work.
  The Concierge's doctrine now biases trivial/visual/low-risk work to one pass.
- **Sonnet 5 @ xhigh workers.** The default worker model is `claude-sonnet-5` and its reasoning
  effort is now actually wired to the CLI (`claude --effort`, default `xhigh`). Cheaper, faster
  cold boots without giving up depth. The Concierge stays on Opus (`claude-opus-4-8`) — it writes
  the better prompts.

### More robust
- **Durable deploys.** Every implement worker is told to publish anything that must stay up via
  Beckett's durable Cloudflare tunnel (`beckett deploy`), never a throwaway foreground server
  (`python -m http.server`, `vite`, `bun run dev`) that dies on session end and 404s — the OPS-15
  footgun that burned two review cycles. Workers verify the deployed URL responds before declaring
  done.

### Notes
- `claude --effort` requires claude ≥ 2.1.197 (verified on the loom-desk host).
- Beckett works like a developer: it owns `/home/beckett`, builds each project under `~/Projects/`,
  and pushes to its own GitHub account (`0xbeckett/<project>`). Improving Beckett itself is just a
  `--project beckett` ticket that clones the source into `~/Projects/beckett` — the live daemon is
  only ever updated by a deliberate deploy, never by a worker.
