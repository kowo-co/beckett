# Market research: the AI-coworker-as-a-service landscape

Snapshot as of mid-2026, prepared for the v1 redesign. Method: vendor docs/blogs, third-party
reviews and pricing teardowns, web research current to early August 2026. All prices USD. This
market moves fast — treat the numbers below as a dated snapshot, not a permanent ranking.

## 1. The landscape at a glance

| Product | Intake surface | Orchestration | Human gate | Pricing (mid-2026) | Coworker-ness |
|---|---|---|---|---|---|
| **Devin** (Cognition) | Slack, Linear/Jira, GitHub issues, web app, Devin Desktop IDE | Fleet: dozens of parallel sessions, Command Center + Spaces, local subagents | PR review; mid-task Q&A in Slack thread | Free / Pro $20 / Max $200 / Teams $80 base + $40/seat; enterprise ACU-contracted (~$2.25/ACU legacy) | High — named agent, asks clarifying questions, posts progress |
| **Factory** (Droids) | Terminal UI, CI (headless), web | Coordinator + specialized droids (code/review/docs/test/knowledge); Missions = plan → milestones → validation | Milestone validation phases; PR review | Free / Pro $20 / Plus $100 / Max $200 + usage capacity | Medium — role-specialized workers, not one persona |
| **OpenAI Codex** cloud agents | @Codex in Slack, Linear, GitHub Action, IDE ext, CLI, web | Parallel cloud tasks (50–300 per 5-h rolling window on Pro tiers), one execution substrate everywhere | PR review; results posted to originating thread | ChatGPT Plus $20 / Pro 5x $100 / Pro 20x $200 | Medium — good thread etiquette, no persistent identity/memory |
| **GitHub Copilot** coding agent + Agent HQ | Assign a GitHub issue; mission control on github.com, VS Code, mobile, CLI | Agent HQ orchestrates first- and third-party agents (Claude, Codex, Devin, Jules, xAI); agentic review can auto-spawn fix PRs | Draft PR + branch controls, identity mgmt | Free (50 agent reqs) / Pro $10 / Pro+ $39 (1,500 premium reqs); $0.04/req overage | Low-medium — right metaphor ("assignee"), but it's plumbing |
| **Cursor** background agents | IDE, web/mobile dashboard, Slack ping | ~8–10 parallel remote agents in isolated Ubuntu VMs, own branches | Push to branch, human merges | Hobby $0 / Pro $20 / Pro+ $60 / Ultra $200 | Low — explicitly a power tool inside an editor |
| **Claude Code / Cowork / Claude Tag** (Anthropic) | Terminal, web/cloud sessions, Cowork desktop+mobile, @Claude in Slack (Tag) | Agent Teams (lead + teammates, mailbox + task list); Dynamic Workflows preview (up to 1,000 subagents); `/effort ultracode` | Permissions, hooks, PR review; Tag shows staged, visible work | Pro $20 / Max $100–200; parallel agents burn quota linearly | High (Tag): one shared identity, org memory; Code itself is substrate, not persona |
| **OpenHands** (All Hands) | Web UI (cloud or self-host), GitHub integration | Single agent + sandboxed runtime; Planning Mode beta; K8s support | Review in web UI / PR | OSS free; Individual cloud free + BYOK; Enterprise custom | Low — an open engine, deliberately unopinionated |
| **Google Jules** | Web, GitHub issues | Async cloud VM per task; 3–60 concurrent tasks by tier | Plan approval, then PR | Free (15/day) / AI Pro $19.99 (100/day) / AI Ultra $124.99 (300/day) | Low — task machine with a name |
| **Lindy** | Web builder; agents live in email, Slack, phone (Gaia voice), browser (Autopilot cloud VM) | Many small single-purpose "Lindies," event-triggered; swarm-style parallel runs | Configurable approval steps per workflow | Free 400 credits / $19.99 / $49.99 / $99.99 / $199.99; credits per action | Medium — "AI employees" framing, but per-workflow not one persona |
| **Dust** | @agent in Slack, web workspace | Many purpose-built agents grounded in company knowledge (61+ connectors) | Suggest-and-review; rarely destructive | €29/user/mo Pro; Enterprise 100+ seats | Medium — knowledgeable colleagues, weak at execution |
| **Viktor** | Slack + MS Teams native | One coworker fronting 3,000+ app integrations; ops work, code, reports | Chat confirmation | Seat/usage SaaS (undisclosed tiers); $15M ARR, 2,000+ orgs 3 months post-launch | High — the whole pitch is "coworker in your channel" |
| **OpenClaw** (ex-Clawdbot/Moltbot) | WhatsApp, Telegram, Discord, Slack, Signal, iMessage; CLI/TUI | Single self-hosted agent; cron jobs, browser tools, channel actions | You are the gate (runs on your machine) | Free OSS + your API keys | Very high — persistent memory, your channels, your machine; a cult "pet/person" |
| **Agent Team** (coupon.dev) | Discord-native: mention a role (coder/reviewer/tech-support) | Role roster; sandboxed per-task containers; agents review each other; scheduled checks | Coder pushes `agent/*` branch only; reviewer read-only; owner alone merges | Subscription (bot install); Opus 4.8 coder, Sonnet 5 reviewer | High for Discord — the closest direct competitor to Beckett |

Adjacent, worth naming: **Amp** (Sourcegraph, ad-supported free agentic coding, 40k+ teams);
**CodeRabbit Agent in Discord** (PR-review agent, free for OSS maintainers, run from Discord);
**Charlie Labs** (Slack+GitHub TypeScript "AI teammate," end-to-end PRs); **Buzz** (Jack Dorsey,
Jul 21 2026) and **Sila** (YC W2026) — chat platforms rebuilt agent-native, i.e. the *surface
itself* is being redesigned for AI coworkers; **Devin Desktop** — Windsurf rebranded, ships Agent
Client Protocol (ACP, Apache-2.0) so Codex/Claude/Gemini/Junie run inside one editor.

## 2. Product reads

**Devin (Cognition).** Strongest "remote teammate" loop in the market — acks in-thread, narrates
progress, asks clarifying questions mid-task. Org "Knowledge" and Playbooks steer it. Independent
evals still show only ~14–15% of complex real-world tasks completed with zero correction: it wins
by making correction cheap, not by being right. June 2026 pricing restructure replaced the visible
ACU rate card with quota + on-demand credits for self-serve; enterprise stays ACU-contracted.
**Verdict: coworker**, the reference implementation of the category.

**Factory (Droids).** The most explicit fleet architecture: a coordinator decomposes work and
dispatches to specialized droids (code, review, docs, test, knowledge) with hard role boundaries.
Missions (2026) turn a business-outcome description into a plan of milestones, each ending in a
validation phase (tests, regressions, integration) — the emerging quality mechanism the market is
converging on. Model-agnostic; #1 on Terminal-Bench; $150M Series C at $1.5B (Apr 2026). **Verdict:
tool** — "you are the architect and manager of a multi-agent mission," not a colleague.

**OpenAI Codex cloud agents.** Slack and Linear share one Cloud Environments execution substrate
with CI and web — intake surfaces multiply, the engine stays singular. Good ack → work → report
thread etiquette, but the Slack app can't post as the user (open issue), so it stays an agent in
the room rather than a proxy for you. Pro 5x ($100, direct answer to Claude Code's $100 tier)
targets parallel agents across active features. **Verdict: tool** — a very fast contractor with
zero persistent identity or memory.

**GitHub Copilot coding agent + Agent HQ.** Agent HQ bets the repo is mission control: one
dashboard orchestrating Copilot *and* third-party agents (OpenAI, Anthropic, Google, Cognition,
xAI). Agentic code review can hand findings straight to the coding agent for a closed review→fix
loop. Everything lands as a draft PR with branch-level compartmentalization and agent identity
management. Cheapest credible agent on the market (Free tier, Pro $10). **Verdict: tool** — the
"assign an issue to it" metaphor is exactly right, but no voice, no memory, no presence off
github.com.

**Cursor background agents.** Background agents run async in isolated cloud Ubuntu VMs on their
own branches; Cursor 3.0 made multi-agent the default posture. Plan review before execution, push
to branch, human merges in-editor. **Verdict: tool**, lowest coworker-ness of the majors — a
superb instrument nobody thanks in standup.

**Claude Code / Cowork / Claude Tag (Anthropic) — the substrate Beckett v1 builds on.** Agent
Teams (Feb 2026) gave one session a lead role with teammates that have their own context, tools,
and a mailbox + shared task list; Claude Code Review put an agent team on every PR. Dynamic
Workflows (research preview, May 2026) has Claude write a short JS orchestration program on the
fly — decompose, parallelize up to 1,000 subagents, validate, join; `/effort ultracode` chains
multiple workflows automatically. Cowork went GA on desktop then web/mobile with cloud remote
sessions that keep running laptop-closed; its computer-use consensus is "right direction, ~50%
success" on cross-app browser automation mid-2026 (see [`computer-use.md`](computer-use.md)).
Claude Tag (Jun 2026, Slack) is *one* shared Claude per team — one identity, one memory, staged
visible work anyone can pick up, learning the company passively from Slack. Parallel agents burn
subscription quota linearly (10 agents = 10x burn), which is why token efficiency is a first-order
design constraint here (see [`token-efficiency.md`](token-efficiency.md)). **Read for Beckett:**
everything v0 hand-rolled — poll loops, dispatch, worktrees, ticket plumbing — now exists natively,
better, one layer down. The market has validated the primitives; the open space is identity,
surface, and taste.

**OpenHands (All Hands AI).** OSS (ex-OpenDevin, 40–70k+ stars), sandboxed Docker runtime,
BYO-model, self-hostable with VPC/SAML at Enterprise tier. Proof there's durable demand for
self-hosted, model-agnostic agents — and proof that an engine without personality or a native
surface ends up as infrastructure, not a coworker. **Verdict: tool**, deliberately unopinionated.

**Google Jules.** Async cloud VM per task, plan approval then PR, tiered daily task quotas
(Free 15/day up to Ultra 300/day). **Verdict: tool** — a task machine with a name, no continuity
between tasks.

**Lindy.** No-code "AI employees" for sales/support/ops; 5,000+ integrations; Autopilot is a cloud
VM with a browser for computer-use without code. Credit-metered (Free 400 → $199.99 top tier), each
"Lindy" a single-purpose workflow rather than one continuous persona. **Verdict: medium** — the
strongest non-coding "coworker" business, but persona doesn't carry across workflows the way
Beckett's does through [BetterWright](betterwright.md).

**Dust.** Enterprise agents grounded in company knowledge (Slack threads, GitHub, Notion, 61+
connectors); Slack-native, security-forward, builder-oriented; €29/user/mo, no free tier.
**Verdict: medium** — knowledge-grounding is the moat, weak at execution. A coworker that already
knows the company beats a smarter stranger.

**Viktor.** Slack/Teams-native coworker fronting 3,000+ app integrations, doing operational work,
code, and reports in-channel. Launched Feb 2026; $15M ARR and 2,000+ orgs within 3 months; $75M
Series A (Accel, May 2026) — largest Polish Series A ever. **Verdict: high** — the fastest revenue
proof that "coworker in the channel you already use" is the winning wedge, and proof the enterprise
version is being built for Slack/Teams, not Discord.

**Discord-native and self-hosted comparables (Beckett's home turf).** **Agent Team (coupon.dev)**
is the only polished Discord-native AI dev team found: sign in with Discord, mention a role
(coder/reviewer/tech-support), each task runs in a fresh Anthropic-hosted container, GitHub tokens
AES-256-GCM-encrypted and injected at a proxy outside the sandbox, coder can only push `agent/*`
branches, reviewer is read-only. Nothing runs on the owner's machines — the exact inverse of
Beckett's self-hosted trust model. **CodeRabbit Agent in Discord** is a PR-review agent free for
OSS maintainers — a distribution playbook worth noting. **OpenClaw** (Peter Steinberger; Clawdbot
→ Moltbot → OpenClaw after an Anthropic trademark request) is open-source, self-hosted, and lives
in WhatsApp/Telegram/Discord/Slack/Signal/iMessage with browser tools, cron, file/terminal access,
and indefinite memory; it has a Wikipedia page and a cult community — the closest *spiritual*
comparable to Beckett, but a personal assistant, not an engineering-org-in-a-box (no ticket DAGs,
no worker fleets, no PR discipline). **Buzz** and **Sila** signal that incumbent chat surfaces are
considered inadequate for agents, built agent-native from day one. Generic Discord AI bots (MEE6,
Botpress/Voiceflow builds, Quickchat, eesel) are moderation/support/chat only — the category
"Discord bot that ships PRs" has exactly one commercial entrant before Beckett.

## 3. Patterns the best products share

1. **Chat-thread etiquette is the product.** Devin, Codex, Claude Tag, Viktor all follow ack →
   visible staged progress → mid-task questions → deliverable in-thread. The delta between "tool"
   and "coworker" is mostly communication discipline, not capability.
2. **PR/branch as the universal human gate.** Every serious player lands work on an isolated
   branch/draft PR and never touches main (Copilot branch controls, Agent Team's `agent/*`-only
   coder, Cursor branches). Autonomy inside the sandbox, ceremony at the merge.
3. **Fleet with a coordinator, specialists with boundaries.** Factory's coordinator+droids, Claude
   Agent Teams' lead+mailbox, Devin's Command Center, Copilot's Agent HQ. Validation/judge phases
   at milestones (Factory) are the emerging quality mechanism.
4. **Price convergence: $20 entry / $100–200 power tier, quota-metered.** Devin, Factory, Codex,
   Cursor, Claude all landed on the same ladder in H1 2026. Visible per-unit rate cards (ACUs) are
   being retired for self-serve; quotas and rolling windows won for legibility.
5. **Memory/knowledge is the moat.** Devin Knowledge/Playbooks, Claude Tag's one-memory-per-team,
   Dust's grounding. Agents that remember the org outperform smarter amnesiacs.
6. **One substrate, many intakes.** Codex explicitly runs Slack/Linear/CI/web on the same
   execution substrate. Intake surfaces multiply; the engine unifies.

## 4. What Beckett steals, per product

| From | Steal |
|---|---|
| Devin | Mid-task clarifying questions in-thread; per-task cost accounting (ACU-like metering per job); org Knowledge/Playbooks as first-class memory objects; optimize for cheap correction, not zero-shot perfection |
| Factory | Milestone → validation-phase loop in plans (job-tree quorum/judge rows already point here); explicit role boundaries per worker; outcome-language mission intake ("migrate X off Y") |
| Codex | Fast ack + report-back-to-originating-thread discipline (the `intake` skill already does the ack — keep it sacred); rolling usage windows for self-imposed token budgets |
| Copilot/Agent HQ | Issue-assignment metaphor (a job assigned to Beckett *is* the intake); review→auto-fix-PR closed loop; branch-level compartmentalization per worker |
| Cursor | Parallel isolated workers with trivially reviewable handoff; show the plan before executing |
| Claude Code | Adopt the GA primitives wholesale (`query()`, streaming input, resume, worktrees, hooks, skills) instead of hand-rolling — this is the whole v1 thesis; the preview tier (Agent Teams, Dynamic Workflows, `--bg` fleets) is explicitly rejected (see [`orchestration.md`](orchestration.md) §7); token burn is linear in fleet size, so effort-tiering per job matters |
| Claude Tag | One identity, one memory, staged *visible* work anyone can pick up; learn the "company" (the Discord server) passively from its channels |
| OpenHands | Stay open/self-hosted/model-agnostic as identity, not just architecture |
| Jules | Task-count quotas as a legible self-limit (n tasks/day) rather than raw token caps — taken literally as `max_per_day` on a trigger row ([initiative.md](initiative.md)) |
| Lindy | Credit-style metering for non-code errands; Autopilot-style dedicated browser VM — [BetterWright](betterwright.md) is Beckett's version, kept as a named capability |
| Dust | Ground answers in the owner's actual corpus (repos, channels, docs) before generating |
| Viktor | Breadth: ops/reports/errands in-channel, not just code — coworker means "whatever the team needs" |
| Agent Team (coupon.dev) | Credential isolation pattern (secrets injected outside the agent sandbox — the jingle keychain is the same idea; keep it); read-only reviewer role; role-mention UX in Discord |
| OpenClaw | Personality + persistent memory + heartbeat/cron proactivity as the emotional core; onboarding wizard + `doctor` self-diagnostics for a self-hosted product. **Taken, with the mechanism inverted:** [initiative.md](initiative.md) keeps the emotional core (Beckett notices things) and refuses the heartbeat-that-thinks — a trigger's condition is SQL or a registered probe, never a model turn on a timer, so a quiet day costs zero tokens and every firing is replayable from rows |

## 5. Gaps a self-hosted, Discord-native, personality-forward Beckett can own

1. **Discord is unclaimed.** All coworker capital ($75M Viktor, Claude Tag, Codex Slack app, Buzz)
   targets Slack/Teams. Discord — home of indie hackers, OSS communities, game studios, and solo
   founders — has exactly one commercial AI dev team (coupon.dev's Agent Team), and it's
   cloud-hosted. A self-hosted Discord-native coworker has zero direct competitors as of mid-2026.
   See [`discord.md`](discord.md) for how Beckett occupies that surface.
2. **Trust inversion.** Every hosted agent asks you to ship your repos, tokens, and screen to
   someone's VM. Beckett runs on the owner's [Omarchy](omarchy.md) box; credentials never leave
   (jingle); browser automation is local ([BetterWright](betterwright.md)). "Your coworker lives in
   your house, not in a call center" is a real, defensible position OpenClaw validated culturally
   but never took to engineering work.
3. **Personality as retention.** The market's engineering agents are personality-free (Factory,
   Cursor, Copilot); the personality-rich agent (OpenClaw) can't run an engineering org. Nobody
   combines Devin-class orchestration with an OpenClaw-class persona and a single continuous
   identity/voice (`deliver`, `self-improve`, memory graph). That combination is the "best AI
   coworker" slot — see [`vision.md`](vision.md).
4. **No per-seat rent.** Beckett's marginal cost is the owner's Claude subscription/API. Against
   $200/mo/power-user market rates, a self-hosted coworker with hard token-efficiency engineering
   (effort tiers, cheap-model routing, quota windows — see [`token-efficiency.md`](token-efficiency.md))
   is structurally cheaper — and the linear-burn economics of fleets make efficiency a feature, not
   plumbing.
5. **Desktop embodiment.** Cloud agents can't touch the owner's actual machine; Cowork's computer
   use is ~50% reliable and privacy-fraught on shared clouds. A dedicated local user account on
   Hyprland with real seat access (files, browser, local services) is a capability tier the hosted
   players structurally cannot match (see [`computer-use.md`](computer-use.md)).
6. **Community-facing coworker.** Discord servers are communities, not org charts: a Beckett that
   also answers members, runs the server, and ships code is a category (community CTO) no Slack
   product addresses.

## 6. Where the market is heading — and what it implies for v1

- **Pricing:** subscription-with-quota won developer agents ($20/$100–200 ladder everywhere);
  outcome pricing is real but concentrated in support (Intercom Fin $0.99, HubSpot Breeze $0.50,
  Zendesk $1.50–2.00 per resolution) — under 10% adoption today, projected dominant for agentic
  products; hybrid models are 43% of SaaS now, headed toward ~61% by end-2026. Expect
  per-merged-PR pricing experiments next. *Implication:* meter and report cost-per-job even
  though the owner pays wholesale — legibility is the point, not a bill.
- **Fleets are table stakes; the orchestration layer is being absorbed.** Standalone fleet
  dashboards died (Terragon shut down Jan 2026; Bloop/Vibe Kanban wound down hosted service;
  Conductor remains a niche macOS app) as platforms shipped it natively (Agent HQ, Agent
  Teams/Dynamic Workflows, Devin Command Center, Factory Missions). Value migrates up to identity,
  memory, and trust. *Implication:* this is exactly where v1's [`orchestration.md`](orchestration.md)
  should invest — adopt the Claude Code primitives, don't compete with them.
- **Computer use crosses the human line.** GPT-5.5 scores 78.7% on OSWorld-Verified vs a 72.4%
  human baseline; every frontier vendor has a browser-driving SKU; Microsoft shipped computer-use
  in Copilot Studio. *Implication:* within a year "can it use a browser" stops differentiating.
  Whose browser, with whose logins — local, credentialed, private — remains Beckett's edge; see
  [`computer-use.md`](computer-use.md) and [`betterwright.md`](betterwright.md).
- **Interop protocols normalize the mesh.** ACP (Devin Desktop) and MCP mean any surface can host
  any agent — the moat is not the engine but the relationship: memory, persona, and the surface
  where the team already lives.
- **The chat surface itself is being rebuilt for agents** (Buzz, Sila, Slack's native-AI push,
  Claude Tag). Bet: within a year, "AI teammate with one identity, shared memory, and visible
  staged work in your channel" is the standard shape. Beckett should be the definitive Discord
  instance of that shape before anyone funded shows up — the thesis laid out in
  [`vision.md`](vision.md).
