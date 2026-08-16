# Beckett [DEV] — the staging instance

A second, fully isolated Beckett daemon on the same box as prod, for trying changes against a real
Discord gateway before they touch `beckett-v4`. It shares nothing with prod on disk or in Discord
except the git history: separate checkout (`~/beckett-dev`), separate state dir
(`~/.beckett-dev`), separate systemd unit (`beckett-dev.service`), separate bot application.

## What jason must supply

Nothing here is seeded for you — the daemon stays in first-run "pending" mode until these exist.

1. **A second Discord bot application and its bot token.** A Discord bot token authorizes exactly
   one gateway connection at a time, so DEV cannot reuse prod's token or prod's application — create
   a new application in the [Discord developer portal](https://discord.com/developers/applications),
   add a bot user to it, and copy its token. Treat it like any other secret; `seed.sh` never prints
   it and it is never committed.
2. **A guild for the dev bot to join.** A separate test server is strongly recommended — do not
   invite the dev bot into prod's guild. Grant it the same scopes/intents as prod's invite: the
   `bot` scope, the Message Content privileged intent, and the same permission set documented in
   the main [`README.md`](../README.md#run-your-own-beckett) (View Channels, Send Messages, Read
   Message History, Send Messages in Threads, Create Public Threads, Manage Threads, Manage
   Messages, Use Application Commands, Attach Files).
3. **Your numeric Discord user id** (`DISCORD_OWNER_ID`) — Developer Mode → right-click your user →
   Copy User ID. Same value you used for prod; DEV just needs its own copy of it.
4. **Optionally, channel ids** you want DEV to post into. If you supply none, the unit's
   `BECKETT_STARTUP_CHANNEL_ID=disabled` and `BECKETT_CARDS_CHANNEL_ID=disabled` keep DEV
   completely silent — no boot banner, no status dashboard, no cards — which is the safe default
   for a staging instance sharing a box with prod.

That's the whole list. Nothing else is required to seed, start, and exercise DEV.

## What is deliberately absent

`deploy/dev/env.example` is the full inventory; the short version, and what breaks as a result:

- `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ZONE_ID` / `CLOUDFLARE_TUNNEL_ID` — omitted, so
  `beckett deploy` / `beckett dns` are off in DEV.
- `DISCORD_ALERT_WEBHOOK_URL` — omitted, so the crash-alert webhook is off (the unit also carries
  no `OnFailure=` — a staging instance must never narrate into the channels/webhook production
  uses).
- `DISCORD_LOG_CHANNEL_ID` — omitted, so the log-mirror channel is off.
- `BECKETT_ROUTINE_CHANNEL_ID` — omitted, so routines have no origin channel to narrate into.
- `AGENTMAIL_API_KEY` / `FAL_KEY` / `OPENROUTER_*` / `CEREBRAS_API_KEY` — omitted, so mail/image/
  triage extras are off.
- `GITHUB_PAT` is set to the placeholder `disabled-in-dev-staging` — it satisfies the first-run
  gate but is not a real credential; any real GitHub call fails by design. `config.toml`'s
  `identity.github_user = "beckett-dev-staging"` only satisfies the identity resolver, it does not
  grant push access.

## Isolation invariants

These hold regardless of what secrets you supply, and are enforced by
`deploy/systemd/beckett-dev.service`, not by convention:

- `BECKETT_DIR=%h/.beckett-dev` — relocates all daemon state (db, events, logs, memory, socket,
  config, `.env`, …) away from prod's `~/.beckett`.
- `BECKETT_HOME=%h/.beckett-dev` — relocates `paths.home` so `paths.projects` derives under
  `~/.beckett-dev` too.
- `BECKETT_PROJECTS_ROOT=%h/.beckett-dev/projects` — the worker/dispatcher ticket-repo root, kept
  away from prod's project tree so a staging worker can never collide with a production worktree.
- Never `enable`d — DEV starts on demand only, never at boot (`systemctl --user is-enabled
  beckett-dev` reads `disabled`).
- No `OnFailure=` — a crash in DEV never pages or posts anywhere.
- `BECKETT_STARTUP_CHANNEL_ID=disabled` / `BECKETT_CARDS_CHANNEL_ID=disabled` — see "optionally the
  channel ids" above; these keep DEV silent until you override them.
- `PATH=%h/.local/bin:%h/.bun/bin:/usr/local/bin:/usr/bin:/bin` — pinned explicitly (a systemd unit
  does not inherit the interactive shell's `PATH`), matching prod's `daemonPath()`.

## Seed

```bash
# with an operator-supplied token (recommended):
./deploy/dev/seed.sh --token-file /path/to/dev-bot-token.txt --owner-id <your-discord-id>

# or via env vars:
BECKETT_DEV_DISCORD_TOKEN=<token> DISCORD_OWNER_ID=<your-discord-id> ./deploy/dev/seed.sh

# or, if this box already has a seeded prod ~/.beckett/.env with CALLIE_DISCORD_TOKEN +
# DISCORD_OWNER_ID, seed.sh falls back to reading those:
./deploy/dev/seed.sh

# to prove the whole path with no token at all (seeds config/peers/routines/unit, skips .env):
./deploy/dev/seed.sh --no-secrets

# --dry-run works with any of the above and touches nothing:
./deploy/dev/seed.sh --dry-run --no-secrets
```

`seed.sh` is idempotent — safe to re-run after a config change. It never prints a token or owner
id, and it never runs with `set -x`.

## Start / stop / tail

```bash
systemctl --user start beckett-dev
systemctl --user status beckett-dev
journalctl --user -u beckett-dev -f
systemctl --user stop beckett-dev
```

## Redeploy

```bash
git -C ~/beckett-dev pull
systemctl --user restart beckett-dev
```

## Teardown

```bash
systemctl --user stop beckett-dev
systemctl --user disable beckett-dev   # no-op if never enabled, which it shouldn't be
rm -f ~/.config/systemd/user/beckett-dev.service
systemctl --user daemon-reload
rm -rf ~/.beckett-dev ~/beckett-dev
```
Then delete the dev bot application from the Discord developer portal if you no longer need it.

## How to know it worked

The first three need no token at all:

1. `bash -n deploy/dev/seed.sh` — the script parses.
2. `./deploy/dev/seed.sh --dry-run --no-secrets` — exits 0, prints the actions it would take,
   names `~/.beckett-dev`, touches nothing.
3. `bun test deploy/dev/dev-instance.test.ts` — the dev `config.toml` and `routines.json` still
   validate against the live schema, and the unit still pins the isolation env.

Once a token exists:

4. `./deploy/dev/seed.sh --token-file <path> --owner-id <id>` — exits 0, seeds `~/.beckett-dev`.
5. `systemctl --user start beckett-dev && journalctl --user -u beckett-dev -f` — the dev bot comes
   online in its guild and `beckett status` (run from inside `~/beckett-dev`, with `BECKETT_DIR`
   pointed at `~/.beckett-dev`) reports healthy.
