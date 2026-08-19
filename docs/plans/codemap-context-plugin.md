# Plan: codemap context plugin for Beckett workers

Status: **for ro's sign-off — nothing in this plan is implemented.**

## Why this exists

Ro's framing: workers spend time exploring a repo before they can start editing, and an
"intelligent codemap" injected into a worker's context could cut that. He asked for this to
land *before* the [Cursor implementer seat plan](cursor-implementer-seat.md) (PR #314), so the
plugin surface is settled first and Cursor integrates against it. He also flagged his own
premise as a guess: "I think Cursor supports the plugin standard and Claude code as well." It
doesn't hold up — see §1.

## TL;DR

- **Cursor and Claude Code do not share a plugin standard.** Claude Code has a real, documented
  plugin system; Cursor has a separate VS Code-derived extension marketplace. The only thing
  they share is MCP, and MCP is a tool-call protocol (model asks, gets an answer back), not a
  context-injection channel. This kills the "one plugin format for both hosts" framing outright.
- **It mostly doesn't matter, because Beckett doesn't consume either host's plugin system for
  its own workers today.** Every worker's prompt is built and delivered by Beckett itself
  (`genericTaskPrompt` / `workerSystemAppend`, `src/dispatch/stages.ts:302,358`, written over
  the CLI's stdin by `ClaudeDriver.writeUserLine`, `src/drivers/claude.ts:707`). A codemap
  belongs in that pipeline, not in a `.claude-plugin` package — and doing it there means it works
  identically the day a Cursor driver exists, at zero extra cost (§1, §3).
- **A codemap earns its keep only as a compact structural index, not a symbol dump.** This
  repo has 1,928 exported top-level symbols across 237 source files; a flat symbol index with
  locations runs ≈43k tokens — a net loss against the exploration it replaces. A file-level
  structural map (path + one-line purpose) runs ≈5k tokens, in the same ballpark as this repo's
  own hand-written `docs/architecture.md` (≈6.4k tokens). That's the shape worth building (§2).
- **Recommendation: build the codemap directly as a Beckett capability module, not a general
  "context management plugin" seam.** The general seam already exists —
  `src/capability/index.ts`'s `promptBlock` composition — and a new abstraction on top of it
  would just be a second version of the same thing (§3).
- **No baseline metric exists yet for "exploration cost before first edit."** `docs/token-efficiency.md`
  tracks dollars and turns, not this. One real run's journal shows a single `Read` before the
  first `Edit` — cheap because the ticket named its file. That's the whole class of ticket a
  codemap *doesn't* help; the value is concentrated in tickets that don't name a file. Baseline
  has to be measured before committing past the first slice (§4).
- **Smallest first slice:** a static-parse, no-LLM-call generator producing a file-level map,
  wired as one new capability module, regenerated at worktree-cut time (never stale within a
  run by construction), gated by a real before/after measurement (§7).

## 1. What "the plugin standard" actually is

**Claude Code's plugin system is real and specific.** A plugin is a directory containing any
combination of `skills/` (or flat `commands/`), `agents/`, `hooks/hooks.json`, `.mcp.json`,
`.lsp.json`, `monitors/monitors.json`, `bin/`, and `settings.json`, optionally described by a
`.claude-plugin/plugin.json` manifest (`name`, `description`, `version`, `author`). It's
discovered three ways: `--plugin-dir <path>` for local dev, a **marketplace** (a git repo with
a `.claude-plugin/marketplace.json` catalog, installed via `/plugin install`), or a
**skills-directory plugin** — `claude plugin init <name>` scaffolds one straight into
`~/.claude/skills/<name>/`, which auto-loads on the next session with no marketplace or install
step at all. That last path is the cheapest way to ship a plugin that's just "always on for this
user" — worth knowing even though it's not the primary recommendation below.

**The load-bearing question — can a plugin push text into context without the user asking?**
Yes, through hooks, and it's narrower than "any hook can do this." Per Claude Code's hooks
reference, the hooks that can return `additionalContext` (text Claude sees, not just an allow/deny
decision) include `SessionStart` (fires once per session/resume — the natural place to inject a
standing codemap), `UserPromptSubmit` (fires per turn — the natural place to inject a
targeted, retrieval-style slice), `PostToolUse`/`PostToolUseFailure`, and `Stop`/`SubagentStop`.
Hooks like `PreToolUse` only get to allow/deny/explain a denial — no context injection.
`SessionStart` + `additionalContext` is the specific mechanism that matches what ro described:
something that shows up in the model's context automatically, no user action.

**Cursor does not read any of this.** It has no `.claude-plugin` format, no hooks.json, no
skills namespace. Its own extensibility, per its 2026 docs, is a VS Code-derived extension
marketplace (opened to third parties in March 2026) plus MCP server support (up to 40 tools
combined). The Claude Code *VS Code extension* runs inside Cursor because Cursor is
VS-Code-compatible — that's an extension running in a compatible host, not Cursor adopting
Claude Code's plugin standard. Two different systems that happen to both be called "plugins."
Not verified in this pass, flagged as cheap to check later: whether Cursor's `.cursor/rules`
context-file mechanism (the closest Cursor analog to a `SessionStart` injection, if it still
exists under that name) could carry a codemap for a *human's own interactive* Cursor session —
irrelevant to this plan's recommended path (below), but relevant if a future increment ever
wants to reach non-Beckett-driven Cursor use.

**The one real shared surface is MCP, and it solves a different problem.** Both hosts can attach
an MCP server; a codemap could be exposed as an MCP tool (`codemap.get(path)`) that the model
calls. But that's retrieval on the model's initiative, not injection — the model has to decide
to call it, on turn 1, before it has any signal that the tool is worth calling. Push
(`SessionStart`) and pull (MCP tool) are genuinely different mechanisms solving genuinely
different problems; conflating them was the flaw in the original framing.

**Why this mostly doesn't matter for Beckett's own fleet.** Beckett doesn't launch `claude` and
let *it* decide what goes in context — Beckett constructs the entire prompt string itself
(`genericTaskPrompt`, `workerSystemAppend` in `src/dispatch/stages.ts`) and delivers it over the
CLI's stdin. The sibling Cursor plan confirms the same is true there: "the shim passes the same
prompt text to `agent.send()` — same content, different transport." Since Beckett already owns
100% of what every worker sees, on every harness, by construction, neither host's plugin system
is required to get a codemap in front of a Beckett-spawned worker. It's required only for a
human running `claude` interactively outside Beckett's control — a real but secondary case
(§3).

## 2. What a codemap is, concretely, for this repo

**What earns its tokens:** directory/file structure with a one-line purpose per file, entry
points, and where tests live. **What doesn't, up front:** a full exported-symbol index with
locations, an import/call graph, or prose ownership notes — all three are either too large or
too volatile to keep cheaply fresh (see the math below). They're better served as
retrieval-on-demand once the worker has narrowed to a directory.

**The numbers, measured on this repo right now:**

| Quantity | Value |
|---|---:|
| Non-test `.ts` files under `src/` | 237 |
| Test `.ts` files under `src/` | 254 |
| Non-test LOC under `src/` | 85,501 |
| Exported top-level symbols (`function`/`class`/`const`/`interface`/`type`/`enum`) in non-test `src/` | 1,928 |
| Raw chars of those 1,928 bare signatures (no path, no line number) | 105,998 |
| Top-level `src/` subdirectories | 38 |

A **flat symbol index** (`path:line: signature` per export) adds roughly 35 more chars per line
for path+line, so ≈173k chars ≈ **43k tokens** at ~4 chars/token — before a worker has read a
single line of actual code. That's a bigger up-front tax than most tickets' entire exploration
phase costs today, so a whole-repo symbol dump is a **net loss** for a repo this size and this
plan rules it out.

A **file-level map** (just paths + a one-line purpose, no symbols) is far cheaper: the 237 paths
alone are 5,313 chars; with a one-sentence purpose per file it lands around 19–20k chars ≈
**~5k tokens**. For comparison, this repo already carries a hand-written subsystem-level map —
`docs/architecture.md`, 292 lines / ≈6.4k tokens — that nobody auto-injects; a worker only sees
it if it chooses to `Read` it. And `CLAUDE.md` (26 lines / ≈360 tokens) genuinely is auto-loaded
into every Claude Code session today, natively, no plugin required — proof the project already
practices exactly the budget discipline this plan needs, just at a much smaller scope than a
full codemap.

**Break-even is honestly unmeasured.** `docs/token-efficiency.md` tracks dollars, turns, and
model-choice waste in detail but has no metric for "tokens or tool calls spent exploring before
the first edit." One real sample, pulled from `~/.beckett/journal/run-20260819-ci-hangs-6h-on-apt-get.log`:
the worker made exactly one `Read` call (of the file the ticket already named) before its first
`Edit`. That's the class of ticket a codemap **can't** help — the brief already pointed at the
file. A codemap's entire value is concentrated in tickets that *don't* name a file or symbol and
require the worker to figure out which subsystem owns the behavior. Until a sample of those
tickets is measured (§4), the break-even point is a reasonable guess, not a number: a ~5k-token
file map pays for itself if it saves roughly 2–3 rounds of `Glob`/`Grep`/`Read` exploration
(each of which costs a tool-result's worth of file content plus a turn), which matches
intuition but isn't yet backed by data from this repo.

**Whole-map-up-front vs. retrieval — recommendation: both, at different granularity.** Inject
the ~5k-token file-level map unconditionally (cheap enough to always be worth it, small enough
to not compete with the task brief for attention). Do **not** inject the 43k-token symbol index;
instead, let a worker that has narrowed to a directory ask for symbols in *that* directory only
— either a plain `Read` of a per-directory index file the generator also writes, or (later) an
MCP tool. This is deliberately the shape aider's repo map uses: a cheap structural map always
present, ranked/detailed information pulled in only for the files actually in play.

**Generation and freshness.** Static parse, not an LLM summarizing pass, and not LSP. Reasons:
(1) Beckett runs against arbitrary `--repo <slug>` projects it has never seen — a static parse
works cold, with no setup, in any language a lightweight export-scanner or tree-sitter query
covers; an LLM pass needs a first paid, slow run before the map is any good, and degrades by
silently being stale rather than failing closed. (2) It's free — the estimate above (`grep`
across 237 files) ran in under a second on this repo; a summarization pass would cost real
dollars per regeneration. (3) Freshness is solved almost for free by *when* it runs: Beckett
already cuts a fresh worktree per run. Regenerating the map at worktree-cut time means it is
**never stale relative to the tree the worker starts on** — no watcher, no commit hook, no
separate cache-invalidation logic needed. The one residual staleness case is the worker's *own*
edits mid-run, which the map can't see by construction; the map should say plainly what commit/
tree it was built from so the worker treats it as a hint, not ground truth, once it starts
changing things itself.

**Cold repos.** Because generation is a pure static parse with no per-repo setup and no history
requirement, a repo Beckett has never touched gets a usable map on its very first run, at the
same cost as its hundredth. If a file lacks the header doc-comments many files in *this* repo
have (e.g. `src/capability/index.ts`'s block comment), the generator should degrade to "path +
list of exported names," never invent a purpose sentence it can't source from the file itself —
inventing prose here is exactly the "stale map the agent trusts" failure mode this plan is
trying to avoid, just moved from staleness to fabrication.

## 3. Where this lives in Beckett

**Not a `.claude-plugin` package, as the primary form.** Beckett already has a real, working
answer to "one clean way to add a capability" that composes into every worker's prompt:
`src/capability/index.ts`'s `Capability` module, which can register a `promptBlock` — the exact
mechanism that already assembles the `<persona>` block every worker (including the one writing
this plan) runs under, via `workerPromptCapabilities()` → `CapabilityRegistry.composePrompt()`
in `workerSystemAppend` (`src/dispatch/stages.ts:316,367`). Its own doc comment states the
property this plan wants: "Adding a `promptBlock` to any capability module puts its contribution
into every worker persona with NO edit here." A `codemap` module under
`src/capability/modules/`, registered the same way `github.ts`/`cloudflare.ts`/`image.ts`/
`memory.ts`/`mail.ts`/`secret.ts` already are, is the concrete "how do we add a plugin to
Beckett" answer — not a new
manifest format, not `.beckett/worker-settings.json` (that file wires Claude-CLI process hooks —
scope guard, spec gate — a different layer entirely, not prompt content), and not a parallel
registry next to the one that already exists.

**This also answers the ordering question ro asked about directly.** Because the codemap rides
in through `workerSystemAppend` — code Beckett owns — rather than through either host's plugin
API, it needs zero per-host adaptation. The moment a `CursorDriver` exists and calls
`agent.send()` with the same composed prompt string (as the sibling plan describes), it inherits
the codemap for free. That's the concrete reason building this first and integrating Cursor
after is the right sequence, not just a convenient one: the codemap is cheapest to build against
one prompt-construction path today, and it stops being "one path" the moment a second driver
exists that has to be separately taught about it.

**A secondary, later, optional surface:** wrap the same generator as a real Claude Code
skills-directory plugin (`claude plugin init`, a `SessionStart` hook returning
`additionalContext`) for a human running `claude` interactively on a Beckett-managed repo
outside a Beckett-spawned run — ro's own terminal, for instance. Different consumption path
(the human's own Claude Code session, not a Beckett worker), same generator underneath. Not
part of the first slice; only worth building once the primary path has proven the map is worth
the tokens.

**General seam vs. build directly: build the codemap directly.** A "context management plugin"
abstraction with codemaps as its first and only instance would just be a second, thinner version
of the capability spine that already exists for exactly this purpose (composable `promptBlock`s
registered per module). Per this repo's own stated principle (`CLAUDE.md`: no abstraction beyond
what the task requires), and because a general seam with one real user is the textbook case for
skipping it — add `codemap` as one capability module now. If a second, unrelated context-provider
shows up later (say, a test-coverage map or a recent-incidents digest), *that's* the point to ask
whether the capability spine needs a narrower `ContextProvider` sub-interface — not before.

## 4. How we know it worked

**Metric:** count of `Read`/`Grep`/`Glob` tool calls (and, if obtainable from the transcript,
their token cost) between a run's start and its first `Edit`/`Write`/`MultiEdit`. This is
directly readable from `~/.beckett/journal/<run>.log` today (demonstrated above) without new
instrumentation — the journal already timestamps every tool call by name and target.

**Baseline: doesn't exist yet, and has to be measured before this goes past the first slice.**
Sample N recent runs (a few dozen, spanning tickets that do and don't name a file up front),
compute the exploration-call count and elapsed time to first edit per run, split by whether the
ticket already named a target file — that split matters, because (per §2) a codemap can only
help the "didn't name a file" half. Re-measure the same split after the codemap capability
module ships and compare. If the reduction on the "didn't name a file" cohort isn't real, the
module should come back out rather than carry a permanent ~5k-token tax for nothing — this is
the gate in §7, not a nice-to-have.

## 5. Risks

- **Staleness the worker trusts.** Mitigated structurally by regenerating at worktree-cut time
  (§2), but the map must say what commit it was built from and be framed as a hint, not ground
  truth — a worker's own uncommitted edits are invisible to it by construction.
- **Token bloat creeping back in.** The 43k-token full-symbol-index temptation is real, especially
  once someone wants "just a little more detail." The file-level map's budget should be a hard
  cap enforced in the generator (truncate, don't grow), not a target someone eyeballs.
  Symbol-level detail stays retrieval-only (§2).
- **Fabricated purpose lines.** If the generator ever grows an LLM summarization step, a
  hallucinated one-liner is worse than a missing one — degrade to "path + export names" rather
  than invent prose (§2).
- **Per-host divergence.** Structurally avoided for Beckett's own fleet, because the codemap
  never depends on either host's plugin API (§3) — it's plain prompt text Beckett already
  controls. The only place divergence could creep in is the secondary, optional
  `.claude-plugin` wrapper for human-interactive sessions, which is why it's explicitly out of
  the first slice.
- **Maintenance cost when a host's plugin API changes.** Doesn't apply to the primary path for
  the same reason. Would apply to the secondary wrapper if built later — a real but deferred
  cost, and Anthropic's plugin schema is the only one that wrapper would ever need to track,
  since Cursor isn't in that picture at all (§1).

## 6. Prior art — what to steal, what to skip

- **Aider's repo map** is the closest match to what's recommended here: a compact, token-budgeted
  structural map (ctags-derived symbol locations, ranked by relevance to the files currently in
  play, regenerated per request) rather than a static dump. Steal the *shape* — cheap structural
  map always present, detail pulled in only for files in play — not the ranking algorithm on day
  one; start with plain directory+file structure (§2, §7) and only add relevance-ranking if the
  flat map still doesn't fit the budget once real repos are tried.
- **repomix** flattens an entire repo into one file for LLM context, with no symbol-level
  compression. Wrong shape for an 85k-LOC repo — it's built for "hand a whole small repo to a
  one-shot task," not "give a worker a cheap map of a big one." Skip.
- **ctags / LSP indexes** give exact, precise symbol locations with zero prose. Good as the
  location source for the retrieval-on-demand layer (§2's "ask for symbols in this directory"),
  not for the injected summary itself — they don't produce "what does this do," which is most of
  what a worker actually needs up front.
- **Embeddings-based retrieval** (Sourcegraph/Cody-style semantic search) is heavier
  infrastructure than this problem currently justifies — no evidence yet (§4) that the simple
  structural map isn't enough. Revisit only if the file-level map's break-even data says
  retrieval quality, not map presence, is the bottleneck.

## 7. Smallest first slice, and what gates it

1. A static-parse generator (no LLM call, no network): walks non-test source files, extracts a
   header doc-comment if present else the file's exported names, emits one line per file plus a
   short per-directory grouping — budget-capped at roughly the ~5k-token file-level size from
   §2. Language-scoped to TS/JS first (this repo, and most Beckett-managed repos); explicitly
   not solving every language on day one.
2. Wire it as `src/capability/modules/codemap.ts`, registered in `availableCapabilityModules()`,
   contributing a `promptBlock` to `workerSystemAppend` — automatic for every worker, no
   per-run opt-in flag, matching how every other capability's `promptBlock` already works.
   Regenerate at worktree-cut time (§2).
3. Pull the baseline in §4 on a real sample of recent runs, split by whether the ticket named a
   file, **before** step 2 ships to more than a couple of manually-picked test runs.
4. Re-measure the same split after step 2 is live on that same sample size.

**Gate: only leave it on by default if step 4 shows a real drop in exploration calls on the
"ticket didn't name a file" cohort.** If it doesn't move that number, pull the capability module
back out rather than let a ~5k-token tax become permanent on the strength of "it feels like it
should help." Symbol-level retrieval-on-demand (§2), the secondary Claude Code plugin wrapper
for human sessions (§3), and any relevance-ranking beyond flat structure (§6) are explicitly
follow-on work, gated on this first slice actually proving out — not part of what ro is signing
off on here.
