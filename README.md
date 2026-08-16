# Beckett

**A Discord-native AI engineer that lives in your server, talks like a person, and ships real code.**

You @mention Beckett in Discord. It chats back in its own voice, decides how much effort your
request actually deserves, and when there's real work to do it **deploys a run** in one call and a
fleet of coding agents builds it — opening PRs, deploying sites, generating images — while it keeps
you posted in the channel you asked in. Open a thread and point it at the work (`&42`, or `&recent`
for a whole wave) and it reports there instead. One long-lived agent is the face; a run supervisor
and a pool of workers are the hands.

This repo is the whole thing: the Discord front-of-house, the task registry, the run engine, and
the ops to run it. It's built to be **forked** — rename it, give it a new personality, point it at
your own Discord, and you have your own Beckett.

---

## Table of contents

- [What Beckett is](#what-beckett-is)
- [Fork it and make it yours](#fork-it-and-make-it-yours)
- [Architecture in one paragraph](#architecture-in-one-paragraph)
- [Run your own Beckett](#run-your-own-beckett)
- [Configuration & secrets](#configuration--secrets)
- [Federation — many Becketts talking to each other](#federation--many-becketts-talking-to-each-other)
- [Everyday commands](#everyday-commands)
- [Deploying changes](#deploying-changes)
- [Repo layout](#repo-layout)
- [Contributing / working in the code](#contributing--working-in-the-code)
- [License](#license)

---

## What Beckett is

Beckett has two seats:

- **The Concierge** — a long-lived `claude -p` (Opus) agent that owns Discord. It's the only
  thing that talks to people. It chats, sizes effort, and for real work makes exactly one call —
  `beckett task deploy --prompt "<the ask>"`. It never writes the code itself. It's not
  single-threaded: each channel (and each DM) gets its own persistent session, so conversations in
  different channels run concurrently under a bounded turn gate — being deep in one room never
  queues everyone else behind it.
- **The fleet** — a **run supervisor** picks a deployed run up within seconds of the call: it
  provisions the project repo, cuts an isolated git worktree and a branch, writes a `spec.md`
  whose checklist the worker must fill in and tick off (a Stop hook enforces it), and spawns the
  implement worker. A fresh reviewer then grinds the diff against that checklist; a pass publishes
  the branch and opens the PR, a fail sends it back for a bounded number of rework cycles. Live
  runs are steerable, and the concierge can message a running worker by name for status.

The workers aren't all the same model. Each run is **cast** per stage — implement with one
model/effort, review with another — so cheap work stays cheap and hard work gets the firepower;
`--ultracode` puts a multifaceted build on the deepest seat with its own workflow of subagents.
Claude is the backbone.

### Deep work: `--ultracode`

There is no separate board for big work. A run whose ask spans several subsystems — a migration
plus its tests plus its docs, "audit everything and fix what's broken" — is deployed with
`--ultracode`: the implement stage goes to the deepest seat and plans its own workflow of
subagents inside the one worktree, so a large ask stays one branch, one review, one PR. Everything
else stays on the default seat. (v7 removed the old INT design board along with the ticket
tracker.)

Beckett also has hands beyond code: it can generate images, deploy throwaway mockups to
`<name>.your-domain`, manage its own public site, remember people and projects across
conversations, and self-provision tools it doesn't have yet.

Browser errands run through [BetterWright](https://www.npmjs.com/package/betterwright), a dedicated,
persistent, policy-guarded Chromium backend rather than a disposable identity. The computer-use seat
writes Playwright-style JavaScript through one small MCP tool, can work across tabs in parallel,
keeps site cookies between errands, and detaches from chat while it works. BetterWright's sandboxed
worker owns browser actions while Beckett's isolated host owns the lease and proof artifacts. A real
blocker arrives in Discord as one bounded message with its marked screenshot; reply to that message
and the same agent session continues from the same page. Replies are deleted before their contents
are used, including stale or unauthorized answers. Replies whose bot reference cannot be inspected
are not retained; Beckett gives resend guidance rather than letting their contents enter chat memory.
Computer-use is available to every user admitted through Beckett's normal owner/access-list gate,
and only the initiating user can answer that run. Visible completions return a proof screenshot
automatically, or are reported unverified if fresh proof capture fails. Browser
questions and terminal results go directly to Discord without another model or Chilltext formatting
pass; controller-owned tab, download, and profile budgets keep the persistent identity bounded.

## Fork it and make it yours

Beckett's **personality is a single editable file**, separate from how it works:

- **`persona.md`** (`~/.beckett/persona.md` on the box) is the voice — tone, slang, attitude.
  It's Beckett's to rewrite: ask it to "change your vibe" in Discord and it edits this file and
  reloads itself live, no redeploy. On a fresh install it's seeded from `DEFAULT_PERSONA` in
  [`src/concierge/index.ts`](src/concierge/index.ts) (the stock Beckett is a cocky 19-year-old
  dev who texts in lowercase).
- **`src/concierge/concierge.md`** is the *doctrine* — how it works (sizing effort, starting
  tasks, surfacing progress). This is fixed; don't put personality here.

So "a bunch of Becketts, each with their own flair" is exactly the intended shape: fork the repo,
rewrite the persona, register a new Discord bot, and run it. The engineering brain is shared; the
character is yours.

## Architecture in one paragraph

> A **Concierge** (a long-lived `claude -p` Opus agent) owns Discord. It chats in Beckett's
> voice, decides effort, and for real work runs `beckett task deploy --prompt "…"` — one call that
> writes a **Run** to the ledger and pings the daemon. It never does the work itself. The
> **RunSupervisor** takes it from there: worktree + branch + `spec.md` scaffold, then the implement
> worker (under a scope-guard, with the spec-gate Stop hook), then a fresh reviewer with the diff
> in hand, then publish → PR → done. Rework is a bounded loop; steering reaches a live worker as a
> nudge; anything that needs a human parks with the reason. v7 removed the ticket tracker, the
> poller, and the whole filing ceremony — a run's card in Discord is the receipt, and it edits
> itself as the work moves.

The authoritative architecture doc is [`docs/architecture.md`](docs/architecture.md); the run
engine's own contract lives in `src/run/` (types, store, spec-file, supervisor). Design
history lives in [`specs/`](specs/): the original spec set under `specs/_legacy/`, the v2 design
under `specs/_legacy-v2/`, and the v3 build contract under `specs/_legacy-v3/` — historical only.

## Run your own Beckett

Beckett runs as a set of **systemd user services**. Supported hosts are Ubuntu 22.04, 24.04, and
26.04 or Debian 12 and 13, with systemd, x64/arm64, at least 4 GB RAM, and 5 GB free disk. Most VPS
images log in
as root, so the shortest install is:

```bash
curl -fsSL https://raw.githubusercontent.com/kowo-co/beckett/main/install.sh | bash
```

From a sudo-enabled account, pipe to `sudo bash` instead. A minimal image without `curl` needs
`apt-get update && apt-get install -y curl` first.

The installer is interactive even through a pipe: it reads setup answers from the terminal and
keeps secret input hidden. To inspect it before running:

```bash
curl -fsSL https://raw.githubusercontent.com/kowo-co/beckett/main/install.sh -o /tmp/install-beckett.sh
less /tmp/install-beckett.sh
bash /tmp/install-beckett.sh        # as root; otherwise: sudo bash /tmp/install-beckett.sh
```

It creates an unprivileged `beckett` account, enables user-service lingering, installs Node 24
LTS plus Bun/Claude/Codex/Pi/GitHub CLI, clones the locked app dependencies, downloads Chromium,
writes private instance config, and links the systemd units. Set
`BECKETT_INSTALL_BROWSER_SMOKE=1` only when you want the optional live browser-sandbox smoke during
installation (it is otherwise a post-install diagnostic). It deliberately does
**not** grant passwordless sudo or weaken the host's AppArmor policy.

Have these ready when prompted:

- a Discord app installed into your server with the `bot` scope. Enable the Message Content
  privileged intent and grant View Channels, Send Messages, Read Message History, Send Messages
  in Threads, Create Public Threads, Manage Threads, **Manage Messages**, Use Application Commands,
  and Attach Files. Manage Messages lets Beckett remove password and OTP replies before using them.
  Numbered task threads inherit their parent channel's visibility, so put task creation in a
  suitably private parent when task names are sensitive. Discord's [bot quick start](https://docs.discord.com/developers/quick-start/getting-started)
  walks through creation and Guild Install;
- your Discord user ID (Developer Mode → right-click your user → Copy User ID), as well as the bot token;
- GitHub credentials. The reference instance runs as a **GitHub App** owned by its org — the
  identity users install on their own repos (see [`deploy/github-app.md`](deploy/github-app.md));
  a self-hosted install can either register its own app or fall back to a PAT (classic `repo` +
  `workflow`, or a fine-grained token with equivalent repository and Actions write access) plus
  the matching GitHub username;
- a Claude Code subscription login. Pi is enabled by default, so either complete its login too or
  answer **no** when the installer asks to enable it. Codex needs a login only when enabled.

Browser/device authentication cannot be completed on someone else's behalf. On a fresh install,
the `beckett-v4` user service therefore starts in **`healthy-pending-configuration`** mode rather
than crash-looping: `sudo -iu beckett beckett status --pretty` lists exactly what remains. It accepts
only `status` until the required secrets and enabled harness credentials exist. The installer prints
the exact login commands and one rerun command; that rerun validates the GitHub credential and
then runs `beckett doctor`. Every rerun is idempotent,
preserves custom config/secrets, and explicitly restarts an already-running daemon onto the new code.

Installing a fork is the same flow:

```bash
curl -fsSL https://raw.githubusercontent.com/kowo-co/beckett/main/install.sh |
  bash -s -- --repo https://github.com/<you>/beckett.git
```

The manual/advanced path remains in [`deploy/host-setup.md`](deploy/host-setup.md). Maintainers can
re-run the from-zero Docker/systemd check with `./scripts/check-public-install.sh`; it uses the real
installer and downloads, but intentionally leaves configuration blank to assert the pending state.
`deploy/install.sh` is the lower-level unit refresher; `--no-start` links the units and enforces a
stopped/disabled daemon, while the default path restarts onto current code and waits for a real
control-socket response before reporting either normal readiness or
`healthy-pending-configuration`.

**Auth is subscription-only by design.** Beckett drives `claude` / `codex` / `pi` through their
own `~/.claude` / `~/.codex` / `~/.pi` logins — it deliberately refuses `ANTHROPIC_*` / `OPENAI_*`
API keys from `.env` (see [`src/env.ts`](src/env.ts)). Log those CLIs in as their user once.

## Configuration & secrets

Two files, both under `~/.beckett/` on the box (never in git):

- **`.env`** — secrets and instance identity: `DISCORD_TOKEN`, `DISCORD_OWNER_ID`,
  `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY_PATH` (or a legacy `GITHUB_PAT`),
  `DISCORD_ALERT_WEBHOOK_URL`, … The committed `.env.example` is the full inventory with per-key
  mint/scope notes. The pending daemon will not become fully live until Discord and GitHub are set.
- **`config.toml`** — runtime overrides. Validation is **strict**: every key is defaulted, so a
  near-empty file boots, but an unknown or out-of-range value is a loud refuse-to-start.
  [`deploy/config.toml.example`](deploy/config.toml.example) is every key at its default (it's
  generated from the live schema by `beckett config print-default`, so it can't drift).

Secrets are backed up **age-encrypted to a separate machine** — see `deploy/host-setup.md`. This
repo is public; nothing sensitive belongs in it.

## Federation — many Becketts talking to each other

Discord bots ignore each other by default, and Beckett drops *every* bot message so it never
reacts to its own posts and loops. A sibling Beckett becomes a trusted **peer** only when the
**owner** adds it — and then its messages reach the Concierge like anyone else's.

**Add a peer live, from Discord (no restart):**

```
you (owner):  @beckett add @ABot to my peers
beckett:      done — ABot's on the list. their side has to add me back for a two-way though.
```

Beckett resolves the @mention to a bot id and appends it to `~/.beckett/peers.txt` — a living
file exactly like the `access.txt` whitelist. `remove @ABot` and `who are my peers?` work too.
Each owner governs only their *own* Beckett's list, so a real conversation only happens once
**both** owners have added the other — mutual consent is structural, not a handshake.

Guardrails:

- **Owner-only.** A non-owner asking to add a peer is declined (`concierge.md` → *Talking to
  another Beckett*).
- **Your own id is always ignored** even if listed (self-loop guard); unlisted bots stay dropped.
- **Talk ≠ authority.** Being a peer lets a bot *message* you; it does **not** let it put work on
  your fleet — that stays owner-gated.
- A per-channel burst cap (`federation.peer_burst_per_min`, default 5) is a hard runaway backstop
  on top of the Concierge's own "don't start a loop" judgment.

`config.toml` can also seed a permanent baseline for whoever provisions the box:

```toml
[federation]
peers = ["123456789012345678"]   # baseline trusted peer ids (unioned with the live peers.txt)
peer_burst_per_min = 5
```

Ships **inert** — no peers configured means byte-for-byte today's "ignore all bots" behavior.
This is the trust primitive; the richer protocol on top (discovery, delegation, real loop
semantics) is an open design question left for a follow-up.

## Everyday commands

Discord exposes the common read/create paths natively:

| Slash command | What it does |
|---|---|
| `/task create name:<name>` | Allocates `#N` and creates `#N.1`. Opens no thread — work reports into the channel it was asked in. |
| `/task show number:<N>` | Shows the task and its branch states without internal identifiers. |
| `/branch reference:<N.x>` | Shows aggregate additions, deletions, files, commits, checks, review, and conversation counts. Never raw diff lines. |
| `/stats` | Privately shows the owner's remaining Claude and Codex subscription windows and reset times. |

Asking a short status question such as `what's #42.1 looking like?` returns the same branch card.
`/stats` is ephemeral and owner-only; its probes use local subscription metadata with zero model
turns and never include account email or raw provider output.

For operator/Concierge use on the host:

Run on the box as the beckett user (`bun src/cli/beckett.ts <...>`, usually aliased to `beckett`):

| Command | What it does |
|---|---|
| `beckett status --pretty` | What the live daemon is doing right now (workers, runs, Discord, concierge). |
| `beckett doctor` | Would Beckett work right now? Binaries, live token probes, env drift, leaked workers. Non-zero exit on any failure. |
| `beckett discord reply --channel <id> "…"` | Post a message as Beckett into a channel. A reply-ack timeout reports `mayHaveSent`, not a retryable failure; do not resend it automatically. Set `BECKETT_DISCORD_REPLY_ACK_TIMEOUT_MS` to tune the 75s acknowledgement budget. |
| `beckett reload` | Re-read `persona.md` and re-ground on a fresh session (live voice retune). |
| `beckett task deploy --prompt "…" [--repo <slug>] [--ultracode]` | The one call that starts real work: files a run, the supervisor builds it. |
| `beckett task ask <run>` | A run's state, its `spec.md` checklist progress, its journal tail, and the live worker's session name. |
| `beckett task steer <run> "…"` | Send a mid-flight instruction to the running worker. |
| `beckett task create|branch|show|list …` | The public `#N` / `#N.x` registry: name work humans refer to, and inspect what's in flight. |
| `beckett finish -m "…"` | The whole landing motion from the branch's checkout: push, open/reuse the PR, wait for CI, merge to main, then run the guarded redeploy. Every stop names the blocker and its fix; re-running is safe. |
| `beckett eval "author/model" [--short|--full]` | Run the curated coding prompt suite against any OpenRouter model and save a readable report. |
| `beckett memory recall "…"` / `remember …` | Query / write Beckett's cross-conversation knowledge. |
| `beckett identity set --user <id> …` | Teach Beckett who someone is and how to address them. |

`task deploy` is the whole work motion: the prompt you pass is the worker's brief, `--channel`
is where updates report back, `--repo <slug>` is the project it builds in (omit it and the run
targets Beckett's own source). `task create` still allocates a durable `#N` / `#N.x` reference for
work humans want to name and attach to a thread; a run can be linked to one with `--task '#N.x'`.

(Beckett itself uses these via skills; you rarely need them by hand.)

## Deploying changes

Prod (`~/beckett` on the box) only ever runs `origin/main` and is **never edited by hand**. From
the branch's checkout, once the work is finished:

```bash
beckett finish -m "what this work shipped"
```

That is PR → CI → merge → deploy in one call, and it is how Beckett ships its own work. The deploy
half is the script below; run it directly when the merge already happened some other way:

```bash
./deploy/deploy-prod.sh
```

It fetches, fast-forward-pulls, `bun install`, installs the lockfile-matched full Chromium build,
typechecks (never restarts onto broken code),
restarts `beckett-v4.service`, reads back health, and tags the deployed version. Crash alerts and
a weekly heartbeat post to the Discord alert channel.

Both of its writes to GitHub ride the GitHub App installation token, never a bare `git push`
(the script re-execs into a systemd user scope with no ambient git credential, and `main` is
branch-protected anyway): the release-version bump lands through its own PR via `beckett gh land`,
and the annotated tag via `beckett gh push --tag`. It preflights that credential before it commits
anything, so a missing app key fails immediately with a named cause.

## Repo layout

```
src/
  concierge/    the Discord-facing Opus agent — concierge.md (doctrine) + persona seed
  discord/      gateway, message chunking, access control, federation (peer bots)
  run/          the run model, ledger, spec.md codec, and the RunSupervisor engine
  dispatch/     worker spawn + stage prompts (implement / review)
  task/         durable #N / #N.x task and branch registry
  worker/       the coding-agent harness (worktree, scope-guard, casting)
  drivers/      claude / codex / pi process drivers
  memory/       cross-conversation knowledge graph
  cli/          the `beckett` CLI (one entrypoint, beckett.ts)
  config.ts     strict, fully-defaulted config schema
deploy/         systemd units, install.sh, deploy-prod.sh, host-setup.md
docs/           the design set: architecture.md, orchestration.md, vision.md, migration.md, …
specs/          design history (v3 under _legacy-v3/, v2 under _legacy-v2/, original under _legacy/)
```

## Contributing / working in the code

- **Runtime:** [Bun](https://bun.sh) + TypeScript. No build step for dev.
- **Before you commit:**
  ```bash
  bun x tsc --noEmit    # typecheck — must be clean
  bun test              # the suite
  ```
- **Classifier prompt changes:** run `bun run eval:triage --provider=claude --runs=3` or use
  `--provider=cerebras --model=gemma-4-31b` with `CEREBRAS_API_KEY` set. The labeled contrast suite
  reports repeated-run exact accuracy, respond precision/recall, addressee and kind accuracy,
  classifier failures, p50/p95 latency, and a quality gate rather than requiring a stochastic model
  to reproduce every label in every run.
- **Style:** match the neighbors. This codebase leans on dense, explanatory comments that say
  *why*, strict config validation, and pure/testable helpers split out from I/O. Read
  [`docs/architecture.md`](docs/architecture.md) for the non-negotiable conventions.
- **New to the repo?** There's a paste-into-your-AI-agent onboarding prompt at
  [`docs/onboarding-prompt.md`](docs/onboarding-prompt.md) that gets a coding agent up to speed
  fast.

---

## License

[MIT](LICENSE). Fork it, redistribute it, no permission needed. Just give yours a name.
