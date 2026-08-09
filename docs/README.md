# Beckett v1 — the docs

This folder is the **v1 design set**: the contract for rebuilding Beckett on Claude Code-native
orchestration, cutting roughly 90% of the v0 codebase, and moving it into a dedicated account on
an Omarchy (Arch + Hyprland) machine. The previous docs folder (v0 architecture, audits,
benchmarks) was cleared in one commit and lives intact in git history just before this set;
design history older than that is archived under [`specs/`](../specs/README.md).

v1 in one paragraph: one **Supervisor** (a Bun process on the Agent SDK, systemd user service)
owns one SQLite store — `~/.beckett/beckett.db` — holding **Jobs** (the only unit of work; a
recursive row that absorbs ticket, task, stage, DAG node, review cycle, and gate) and **Events**
(the only ledger). A **Wire** adapter speaks Discord: gateway in, cards out, card edits rendered
by code rather than model turns. Two concierge **Seats** share one persona — a Haiku front desk
that reads and banters, a Sonnet mind that decides and files. All doctrine (agents, skills,
hooks, one in-process MCP server) ships as one Claude Code plugin in this repo. A **Trigger** is
the one door through which work starts with nobody typing — a standing rule a human armed, which
files an ordinary Job. There is no ticket tracker, no dispatcher, and no poller in the dispatch
path — the one declared tick in the design is the trigger evaluator's, and it schedules nothing but
initiative. A Job's id (`j7`, `j7.1`) *is* the git branch, the worktree, the session name, the
Discord card, and the ref a human types.

## Read in this order

| Doc | What it settles |
|---|---|
| [`vision.md`](vision.md) | Why v1 exists, the six commitments, what Beckett refuses to be |
| [`orchestration.md`](orchestration.md) | **The core contract.** Jobs, states, every mechanic (steering, review, deps, resume, budgets, gates, casting, initiative), the concierge cost attack, risk register |
| [`architecture.md`](architecture.md) | The eight concepts as a system: process model, the one store, module map with LOC targets, old→new absorption table |
| [`initiative.md`](initiative.md) | Unprompted work: trigger sources, the act-or-ask gate as rows, budgets and rate limits, idempotency, the audit trail, every off switch |
| [`migration.md`](migration.md) | The 90% cut as an executable plan: disposition table, build order, cutover, acceptance checklist |
| [`token-efficiency.md`](token-efficiency.md) | The economics doctrine: measured v0 baseline, ranked waste sources and their by-construction fixes, the casting ladder, cost targets |
| [`discord.md`](discord.md) | The invariants that make Beckett feel like a colleague, the Wire design, platform limits, surfaces kept/added/cut |
| [`computer-use.md`](computer-use.md) | The token-efficient computer-use library: the escalation ladder (code > AX-tree > pixels), native Wayland toolbox, per-errand budgets |
| [`betterwright.md`](betterwright.md) | The browser lane: BetterWright architecture, all benchmark numbers, v1 usage doctrine |
| [`omarchy.md`](omarchy.md) | Beckett as a native Omarchy citizen: the dedicated account, headless Hyprland desktop, isolation, the Arch install path |
| [`market-research.md`](market-research.md) | The coworker-as-a-service landscape (mid-2026 snapshot), what Beckett steals, the gaps it owns |

## How this set was made

Ten research passes (five over the v0 codebase and its audits, five external) fed a design
panel: six proposer agents on mixed models — two Sonnet, two Haiku, two low-effort Opus — each
arguing the orchestration flow from a different lens, scored by three judges across token
efficiency, speed, robustness, simplicity, coworker feel, and GA-feasibility. The winning
architecture-purist proposal, with the judges' grafts from the other five, became the synthesis
these docs are written from. Where a doc and [`orchestration.md`](orchestration.md) disagree,
`orchestration.md` wins.

## Status

Design, not yet built. The running system is still v0 (see the repo README); `migration.md`
defines the order in which this set becomes the live one. Preview-feature bets are labeled
in-place in every doc, each with its GA fallback.
