# Plan: Cursor implementer seat (Auto Balance, quota fallback to Sonnet)

Status: **for ro's sign-off — nothing in this plan is implemented.**

## Why this exists

Not a cost experiment. Ro's own framing: this is load relief for Claude usage limits when
Sonnet is doing implementation work — a second implementer to lean on before a run stalls out
waiting on Claude quota, not a cheaper way to do the same thing.

## TL;DR

- **Variant: Auto Balance**, pinned explicitly everywhere — never bare "Auto." Rejected Auto
  Cost on ro's call ("may select poorer models"). Real open question below: whether an
  individual $20/mo Pro key can even request Balance via the API at all.
- **Routing: Cursor becomes the default implement seat** for the weight classes Sonnet 5
  currently owns by default (trivial/standard), not an opt-in flag. Claude keeps
  judgment-heavy and correctness-critical work, unchanged. Sonnet 5 is the automatic
  in-run fallback when Cursor's quota runs out.
- **Implement only, structurally.** A registry-level capability flag rejects any cast that
  puts `harness: "cursor"` on `review`, at deploy time, with a loud error — not a convention.
- **Fallback loses no work.** Every Cursor edit lands as a real commit before the seat can be
  abandoned; a rolling handoff file captures what git alone can't (why, what's mid-flight,
  what was learned); the resuming Sonnet worker re-verifies rather than trusts a
  Cursor-ticked checklist box.
- **If Claude is also constrained when Cursor falls back:** park the run with the handoff
  intact and say so in channel — never retry into an allowance that's already tight.
- **No dependency added, no driver written, no cast logic touched in this run.** This is the
  plan only.

## 1. What Cursor's API actually gives us

Two docs, two different runtimes, and the choice between them is the first real decision:

- **Cloud Agent REST API** (`cursor.com/docs/cloud-agent/api/overview`): agents run on a
  Cursor-provisioned remote VM. Work lands via `git` — the terminal run object reports a
  pushed branch. That means the remote agent only ever sees whatever is reachable through git.
- **TypeScript SDK, `local` mode** (`cursor.com/docs/api/sdk/typescript`): "Runs the agent
  loop inline in your Node process. Files come from disk." No remote or push required — it
  reads and writes the literal filesystem at whatever `cwd` you hand it, and inference still
  goes through Cursor's hosted models either way.

**This repo makes the choice for us.** `.beckett/` — the worktree's spec.md, worker-settings,
everything — is entirely gitignored (`.gitignore:21`). It is never committed, never pushed,
never visible to anything that only sees git history. A cloud-sandboxed agent operating off a
pushed branch would never see `.beckett/spec.md`. **Local mode is the only one that works here**
— point it at the worktree, it reads spec.md off disk exactly like Claude/codex/pi do today.

**Auto Balance, concretely.** Requested via `model: { id: "auto-smart", params: [{ id:
"optimize_for", value: "balanced" }] }`. Per Cursor's docs, Auto Balance (like Auto
Intelligence) is billed "at Model API rates for the model used, based on actual usage" — unlike
Auto Cost's flat $1.25/$6/$0.25-per-Mtok rate, Balance's per-call cost varies with whichever
model it actually lands on. It's also subject to the $0.25/Mtok "Cursor Token Rate" surcharge
when it routes to a third-party model — but that surcharge is documented specifically for
**Teams and Enterprise plan customers**; nothing says it applies to an individual Pro account.

**The open question that actually matters:** the Cost/Balance/Intelligence three-way split is
Cursor's "Router," and every place it's documented frames it as a Teams/Enterprise feature
("On Teams and Enterprise plans, Cursor Router picks the model for each Auto request"). Nothing
in the docs confirms an individual $20/mo Pro API key can request Balance at all. Separately,
the Cloud Agent overview describes a plainer "Auto": omit the `model` field entirely and the
system "resolves your user default model, then your team default model, then a system
default" — that's likely what the Cursor IDE's own Auto toggle maps to for an individual
account, with no published cost-per-token story of its own.

**How we resolve this without guessing:** the moment `CURSOR_API_KEY` lands in
`~/.beckett/.env`, one raw call — `POST /v1/agents` with the auto-smart/optimize_for=balanced
model block — tells us definitively whether it's honored, silently ignored, or rejected on
this account. If it's rejected, the fallback within this decision is bare Auto (omit `model`)
as the closest available option, with the caveat reported back to ro rather than quietly
treated as equivalent — we don't know its quality/cost profile and shouldn't pretend to.

**Routing pool is named, not documented.** Grok 4.6, Grok 4.5, and Composer 2.5 are named as
the first-party models exempt from the Token Rate. The actual per-request rule for which of
them Auto Balance picks is never published. We cannot target or guarantee a specific model
under Auto Balance. If ro ever wants to force one directly (e.g. always Grok 4.6), that's
`model: { id: "grok-4.6" }` instead of the auto-smart block — a one-line change to the value
the driver sends, not a design change (see §6).

**Usage visibility exists, quota visibility doesn't.** `GET /v1/agents/{id}/usage` returns
per-run and total token counts (`inputTokens`/`outputTokens`/`cacheReadTokens`/
`cacheWriteTokens`/`totalTokens`) — useful for the telemetry footer, useless for predicting
the wall, since nothing reports remaining Pro allowance or a percentage. We find out we're out
by trying, not by watching a gauge.

**Quota-exhaustion error shape: undocumented.** Neither doc gives a status code, error code,
or header that distinguishes "Pro allowance spent this month" from an ordinary rate limit or a
5xx blip. This is the single biggest gap and it drives the detection design in §4.

**No review-role concept.** The API's `mode` field is `"plan"` (explore/draft) vs `"agent"`
(implement directly, the default) — nothing to do with reviewing our work, and no built-in
"reviewer" role to accidentally trigger.

## 2. Where this lands in the code

- **Registry seam:** `src/drivers/index.ts` `REGISTRY` (lines 62–66) is `{claude, codex, pi}`
  today; adding `cursor: {...}` here plus a new `src/drivers/cursor.ts` is, by the codebase's
  own design, the entire "new harness" surface (comment at line 46: "Adding a harness... is
  one REGISTRY row"). `HarnessName` (`src/run/cast.ts:34`) is already an open string type,
  validated against the registry (`isRegisteredHarness`, `cast.ts:80–94`) rather than a
  hardcoded enum — no type changes needed to accept `"harness":"cursor"`.
- **Subprocess model mismatch — the real cost of this axis.** Every existing driver
  (`claude.ts`, `codex.ts`, `pi.ts`) wraps an external CLI binary via `BaseDriver.launch` →
  `Bun.spawn` (`src/drivers/base.ts:236–316`), parsing the CLI's own NDJSON stdout into
  `WorkerEvent`s. Cursor's local-mode SDK (`@cursor/sdk`) is a **library**, not a binary — no
  CLI to shell out to. The fix is a thin shim: `src/drivers/cursor-runner.ts`, a standalone
  script that imports `@cursor/sdk`, calls `Agent.create({ apiKey, model: {...}, local: { cwd:
  workspace } })`, and re-emits the SDK's stream events as the same stdout NDJSON shape the
  other drivers already produce. `CursorDriver.spawn()` then does exactly what the others do —
  `Bun.spawn(["bun","run","cursor-runner.ts",...], { cwd: workspace })` — preserving process
  isolation, kill signals, and the one-child-per-run model. Net result: one new driver file,
  one shim script, one registry row, one dependency. **Zero changes to `claude.ts`, `base.ts`,
  or `spawn.ts`'s core logic.** The existing Claude path is byte-identical because nothing in
  it moves.
- **Prompt delivery is unaffected.** The worker doesn't read spec.md as its prompt today —
  `stages.ts`'s `genericTaskPrompt` (used by `implementStage.buildPrompt`, line 404) builds it
  from the `WorkItem`, delivered over the CLI's stdin (`ClaudeDriver.writeUserLine`,
  `claude.ts:707–736`). The worker is instructed to write/maintain spec.md itself. The shim
  passes the same prompt text to `agent.send()` — same content, different transport.
- **Completion signal needs a workaround.** Claude's completion is a `--json-schema`-
  constrained "done" object read off the terminal frame (`DONE_SCHEMA`, `spawn.ts:242–263`:
  `done`/`summary`/`filesChanged`/`checksRun`/`blocker`) — a hard grammar constraint, not a
  suggestion. Cursor's SDK only gives `result.status` (`"finished"|"error"|"cancelled"`) plus
  free text; there's no schema-constrained equivalent. The shim will need to prompt for the
  same JSON shape in the agent's final message and parse it out — reliability of that is
  untested (open question §8.5).

## 3. The implement-only guard

Real and structural, using an existing precedent in this codebase — `validateCasting`
(`src/run/cast.ts:140–166`) already hard-rejects certain casts (`BLOCKED_MODELS`, line 119,
checked at deploy time from `task-deploy.ts:151`, producing a loud CLI error before a run is
ever created). Add a parallel check in the same function, driven by a new field on the driver
registration rather than a hardcoded string: `reviewCapable: boolean` on
`DriverRegistration` (`src/drivers/index.ts`), `true` for `claude`/`codex`/`pi`, `false` for
`cursor`. `validateCasting` rejects any `--cast` where `stage === "review"` and
`REGISTRY[harness].reviewCapable === false`, with a message like "cursor is an implementer-only
seat; cast it under implement, not review." One source of truth, so a second
implementer-only seat someday doesn't need a second hardcoded check.

`reviewStage.resolveCast` (`stages.ts:417–422`) already defaults to `{harness:"claude",...}`
when nothing explicit is given, so that path is already safe — the registry-driven guard is
what actually has teeth against an explicit `--cast '{"review":{"harness":"cursor"}}'`.

Which Claude seat does the reviewing (fable vs. opus vs. sonnet) is untouched by this plan and
stays ro's call — the review-gate sendback data in `docs/token-efficiency.md` (§104–110)
measures how often a reviewer sends work back, not whether the sendback was correct, so it
can't support a per-dollar recommendation and this plan doesn't attempt one.

## 4. The fallback — no work lost

### Detection

Build to a conservative assumption, since the docs don't pin the shape down: wrap every Cursor
call in a short bounded retry (e.g. 2 attempts, brief backoff) as the normal transient-error
policy. If the *same* error persists past those retries, treat it as quota exhaustion and
trigger fallback. Worst case on a wrong assumption: one unnecessary fallback on a real
transient error (cheap — Cursor doesn't charge for a rejected call) — never a hang from
mistaking real exhaustion for "just retry." Every trigger logs the raw status/body into the
handoff file (below), so the first real production occurrence tells us the actual shape and
the rule gets tightened afterward without costing ro any work in the meantime.

### Where the failure can strike

| Point of failure | State left behind | Resulting action |
|---|---|---|
| Before first token | Nothing written, worktree untouched | No handoff needed — retry the stage on Sonnet from scratch, same as an ordinary `launch_failed` |
| Mid-stream, mid-edit | Uncommitted partial edits on disk | Shim commits what's on disk right now (`git add -A && git commit -m "cursor: quota fallback checkpoint"`) before exiting — never left uncommitted, never discarded |
| Between checklist items | spec.md may have items Cursor marked `[x]` | Left as written; see Resumption — a tick with no commit behind it is not trusted |
| Mid long tool call | Same as mid-stream; partial file effects captured by the checkpoint commit | Same checkpoint-commit path |

### Handoff state

Already durable, for free: the worktree, the branch, every commit (git history doesn't care
which harness made it), and spec.md's `## Goal` section (seeded once by the supervisor,
`spec-file.ts renderSpecScaffold`, never touched by a worker).

Not durable without new work: anything only in the Cursor agent's head — why it made the
choices in the diff, what it was mid-way through, anything learned that never made it into a
commit message or spec.md prose.

New artifact: **`.beckett/cursor-handoff.md`** — same gitignored directory as spec.md, so it
needs no commit of its own and is picked up by the next worker straight off disk, the same way
spec.md already is. Written by the shim, not the daemon, rewritten continuously (after every
tool call and checklist tick — cheap, a local write) so a fallback needs zero last-second
cleanup. Contents: rolling free text — files touched and why, what's in progress, anything
learned that isn't obvious from the diff, plus a one-line "why it fell back" note appended at
exit. The resuming Sonnet worker's prompt tells it to read this file and spec.md before
touching anything.

### Resumption semantics

- **Same branch, same worktree, always.** Never a fresh checkout — that's the entire point of
  checkpoint commits over starting over.
- **Uncommitted edits are always committed, never stashed or discarded.** Stashing risks never
  being popped; discarding is exactly the "work lost" ro ruled out.
- **A `[x]` Cursor ticked mid-run is forced back to unchecked by the shim before exit**, unless
  the corresponding work is visibly backed by a real commit. An unbacked tick is definitionally
  unverified. The failure mode to avoid is a takeover that silently believes half-done work is
  finished — so the resuming worker re-verifies the most-recently-ticked item against the diff
  rather than trusting the checkbox at face value.
- **The spec-gate Stop-hook doesn't cover Cursor.** `src/hooks/spec-gate.ts` is Claude-CLI-
  specific plumbing — it depends on Claude Code's native Stop-hook JSON protocol, which
  Cursor's SDK has no equivalent of. While Cursor is the active seat there's no automatic
  "can't stop with boxes unchecked" enforcement; discipline comes from the shim's continuous
  handoff writes and the resuming worker's re-verification instead. Real gap versus the
  Claude-only path — flagged in §8.

### Both seats constrained

This is the scenario the whole plan exists to relieve, so it has to be handled explicitly, not
assumed away: if the Sonnet worker that picks up a Cursor handoff then itself hits a Claude
usage-limit signal, it must **not** get new retry logic layered on top of an already-tight
allowance. It falls into the existing park path this system already has for Claude-side
trouble (`verdictFor`'s "parked for a human" state, `src/progress/cards.ts:158,176`) —
spec.md and `cursor-handoff.md` are already durable on disk, so whenever a human or a quota
reset unparks the run, full context is still there. No silent burn-through, ever.

### Idempotency and loops

Fallback is a one-way door per run: once a run falls back cursor→sonnet, that's recorded on the
run so it never routes back to cursor for the rest of that run, even if the routing default
would otherwise pick it again — no ping-pong. "Paying twice for the same work" is avoided
structurally, not by new bookkeeping: fallback only ever happens at a checkpoint-commit
boundary, so the resuming worker's first move (diff against the last commit, read the handoff
file) already tells it what's done — the same discipline any resumed Claude-only run already
needs.

### What the channel sees

Not silent. Add a distinct status to the existing vocabulary in `verdictFor`
(`src/progress/cards.ts:111–216`, which already has "retrying" for watchdog re-staff) — e.g.
**"cursor quota hit — resumed on sonnet"** — rendered through the same one-line
`renderProgressCard` format (`▸ **<ref>** · <phase> · <elapsed>`, lines 233–247) so it reads
like every other status line, not a special case.

### Cost accounting

`BaseDriver.usdEstimate()` (`base.ts:137`) is already per-driver and harness-agnostic in shape.
For Auto Balance specifically, this is harder than it would be for flat-rate Auto Cost: Balance
bills at the underlying model's own rate, and the documented `GET /v1/agents/{id}/usage`
response gives token counts only — no dollar figure, and no confirmation it reports *which*
model actually handled a given call. If it doesn't, `CursorDriver.usdEstimate()` can only
report raw token counts, not an accurate `$`, until that's confirmed (flagged in §8).
`RunSupervisor.recordSpend` (`supervisor.ts:3136–3184`) → `appendSpendRecord`
(`spend.ts:84–96`) already writes one row per stage-attempt with `harness`/`model`/`costUsd` —
a run that spent time on both seats just produces two rows, and `summarizeSpend`
(`spend.ts:153–260`) already sums across rows regardless of harness, so the footer stays
honest with no aggregation-logic change. The one real gap: `config/model-rates.json` needs a
cursor/auto-balance row (mirroring the existing table, `token-efficiency.md:27–34`) so
`KNOWN_MODELS` (`cast.ts:128–130`) and the offline `telemetry/harvest.ts` reconciliation know
about it — a config addition, not code.

## 5. Routing

Grounded in `how-to-deploy-work.md`'s existing ladder (lines 176–182): weight-1 (trivial) and
weight-2 (standard) default to Sonnet today; weight-3 (judgment-heavy) defaults to Sonnet with
human-driven escalation; weight-4 (correctness-critical) defaults to fable+opus-review,
confirm-first. Doctrine currently states flatly "harness is always claude" and "No OpenAI
models. Ever." (lines 120, 167) — this plan is explicitly asking ro to amend both, for cursor
only.

**Cursor becomes the zero-cast default for weight-1/2 implement work**, replacing Sonnet as
whatever the no-explicit-cast path picks — concretely, the same seam that already does this:
`RunSupervisor.castFor`'s `applySonnetFirst` (`src/run/cast.ts:213–227`), invoked only for
`stage === "implement"` with no explicit cast (`supervisor.ts:819–845`, guard at line 830).
That logic becomes cursor-first instead of sonnet-first, with the automatic in-run fallback to
Sonnet on quota exhaustion from §4. **Weight-3/4 defaults are untouched** — still Sonnet at
weight-3, still human-escalated to fable/opus at weight-4 — because any explicit `--cast`
naming a heavier seat is honored verbatim exactly as today, bypassing cursor entirely. This
means judgment-heavy and correctness-critical work never sees cursor by construction, without
needing a second guard beyond the one in §3 — nobody names cursor for that class of work in
the first place, and if they did, it's still capped at implement (never review).

Never cursor, regardless of weight: review (§3, structural guard).

## 6. Credential handling

`CURSOR_API_KEY` arrives via `~/.beckett/.env` (secret intake) and is loaded into the daemon's
`process.env` by `loadEnvFile` (`src/config.ts:73–80`), gated only by the
`FORBIDDEN_ENV_PREFIXES` denylist (`src/env.ts:15`: `ANTHROPIC_`/`OPENAI_`/`CLAUDE_CODE_`) —
`CURSOR_API_KEY` isn't on it, so it already flows through `childEnv()` (`env.ts:30–38`) to
every worker subprocess today, no code change required for it to reach the cursor-runner shim.
It never touches argv, stdout, or a transcript by construction — pure env-var inheritance via
`Bun.spawn({ env: this.buildChildEnv() })` (`base.ts:274`), the same mechanism `claude.ts`
already relies on.

Worth doing at implementation time, not required by this plan: since `childEnv()` is a
denylist (everything passes through unless blocked) rather than an allowlist, a
`CursorDriver.buildChildEnv()` override — mirroring the existing pattern in `pi.ts:314–316` /
`claude.ts:233–237` — that explicitly passes only `CURSOR_API_KEY` plus the baseline
environment would scope exposure tighter than today's default-open behavior, closer to
`jingle`'s allowlisted secret injection (`src/secret/keychain-read.ts`) used elsewhere in this
system.

## 7. First build slice

1. **The moment `CURSOR_API_KEY` exists**, one raw `POST /v1/agents` call with the
   auto-smart/optimize_for=balanced model block — resolves §1's open question before any
   driver code is written against an assumption.
2. `src/drivers/cursor.ts` + `src/drivers/cursor-runner.ts` shim + one `REGISTRY` row
   (`reviewCapable: false`) + one `config/model-rates.json` row.
3. The implement-only guard (§3) — **ships in the same PR as the driver**, never a window
   where a cursor seat exists without the guard live.
4. One manually-triggered, explicitly-cast run (`--cast '{"implement":{"harness":"cursor"}}'`)
   on a real weight-1 ticket ro picks by hand, watched live — answers whether the shim's
   prompted done-signal comes back parseable (§2, §8.5).
5. One manually-triggered run with quota exhaustion simulated (e.g. temporarily point
   `CURSOR_API_KEY` at an invalid/exhausted key) to exercise the full fallback path — checkpoint
   commit, handoff file, Sonnet resumption, run-card line — before it's ever load-bearing.
6. **Gate before this touches ordinary work:** both 4 and 5 must succeed cleanly (real diff
   landed; fallback handoff read and acted on correctly) before cursor becomes the weight-1/2
   default from §5. Until then it's available only behind the explicit `--cast` flag.

## 8. Risks and open questions

1. Whether `auto-smart` + `optimize_for:"balanced"` is honored on an individual Pro key at
   all, versus erroring or silently degrading to bare Auto — Cursor Router is documented as a
   Teams/Enterprise feature. Resolved by one real API call (§7.1), not a guess.
2. Quota-exhaustion error shape (status/body/headers) is entirely undocumented. The detection
   rule in §4 is a conservative, fail-safe assumption — tighten it once a real occurrence logs
   its actual shape.
3. Auto's routing pool is named (Grok 4.6, Grok 4.5, Composer 2.5) but the routing rule itself
   isn't published — we can't target or guarantee a specific model under Balance.
4. Whether `GET /v1/agents/{id}/usage` reports which underlying model handled a given call —
   if it doesn't, Auto Balance's real-time `$` cost can't be computed precisely, only raw token
   counts (§4 Cost accounting).
5. Whether a Cursor agent's prompted "done" JSON block is as reliable as Claude's grammar-
   constrained `--json-schema` output — untested; first slice will surface real failure modes.
6. Cursor's local-mode SDK has no Stop-hook equivalent to `spec-gate.ts` — compliance with
   spec.md discipline while Cursor is active rests on the handoff file and Sonnet's
   re-verification, not an enforced gate. Worth watching in early runs, not assumed at parity
   with Claude.
7. No dependency has been added in this run, by design. `@cursor/sdk`'s exact version/API
   surface should be re-verified against its published npm page at implementation time, not
   assumed frozen from this research pass.
