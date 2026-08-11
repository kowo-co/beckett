# Beckett host setup (manual/advanced)

The supported fresh-host path is the repository-root `install.sh`; it performs these steps
idempotently and stages the service until credentials are ready. This document keeps the manual
recovery/operator path. The long-form history of the original host lives in
`my-docs/loom-desk-setup-log.md`.

Host requirements: Ubuntu 22.04, 24.04, or 26.04, or Debian 12 or 13, with systemd, x64/arm64,
4 GB RAM, and 5 GB free disk. The public installer also installs `sudo` so its printed operator
commands work on minimal root-first Debian images.

## 1. OS user + lingering

```bash
sudo useradd -m -s /bin/bash beckett
sudo loginctl enable-linger beckett          # user units run without an open session
```

Do not give this account unrestricted passwordless sudo on a public/shared host: every model
worker runs with the account's privileges. Install host-level tools as an administrator instead.

## 2. Browser-process isolation (Ubuntu 24.04)

On Linux, the daemon starts the trusted Playwright controller and every disposable model-code
evaluator in separate sibling `bubblewrap` sandboxes. Both drop all capabilities; the evaluator also
uses `prlimit` from `util-linux` for a 16 GiB virtual-address ceiling plus process, file, and CPU
bounds, while Node caps its V8 heap at 256 MiB. The virtual ceiling leaves room for Node's large,
nonresident WebAssembly reservation. The installer provisions both tools. Verify that the dedicated
Beckett account can create a fresh user namespace and that `prlimit` is available:

```bash
command -v bwrap prlimit
sudo -u beckett bwrap --unshare-all --share-net --die-with-parent --ro-bind / / /bin/true
```

Some Ubuntu 24.04 images block unprivileged user namespaces through AppArmor. On a dedicated
Beckett host, enable them if the smoke command is denied, then rerun `beckett doctor`:

```bash
echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/99-beckett-userns.conf
sudo sysctl --system
```

Then exercise the real controller-plus-evaluator production path from the checkout:

```bash
sudo -u beckett -H bash -lc 'cd ~/beckett && bun run browser:smoke'
```

The Bun daemon launches the sandboxed controller with Node. That Node host manually starts the pinned
Chromium binary with only an ephemeral loopback debugging port and then attaches Playwright over CDP;
it does not combine Playwright's managed WebSocket/debugging pipe with a second port. Chromium stays
in the controller's process group so a hard supervisor kill reaps browser and renderer descendants.

The controller starts with a 128 MiB per-file `RLIMIT_FSIZE`. Within that ceiling, each browser lease
accepts at most four downloads and 100 MiB total. A CDP `Browser.downloadProgress` guard tracks both
received bytes and the projected remainder while transfers are active, cancelling before the
aggregate crosses the budget; artifact streaming is a second bounded copy path, not the only
pre-completion guard. Cancellation is tried against the default and every live browser context id.
Root download events count each GUID once, including raw/hidden-target downloads, and the controller
restores its trusted download behavior if raw CDP redirects it. Over-budget and partial files are
deleted. Root target inspection enforces a 32 page-target ceiling even for targets hidden from
Playwright's page list. Browser tool results are capped as a complete serialized envelope, with a
24,000 character default.

Do not treat the model-facing `browser()`/raw-CDP wrappers as a security boundary: Playwright's
private graph must be assumed reachable. The controller watches target creation and polls all browser
context ids every 100 ms, forcibly disposing every non-default context, including contexts that have
no targets yet. The integration test exercises that private-graph bypass directly.

The trusted controller scans allocated profile bytes asynchronously and serially. It starts at 100 ms,
backs off as far as 2 seconds while storage is quiet, and returns to 100 ms on rapid growth or low
headroom. It closes Chromium and fails the lease if the profile grows by more than 100 MiB during one
run or exceeds 512 MiB absolutely; an already-oversized profile fails before launch. The profile is
not wiped, and a bounded mode-`0600` controller snapshot restores session-only cookies after the
controlled Chromium restart. These limits are fixed runtime safety bounds, not host sizing guidance.

Terminal browser results are written to a minimal mode-`0600` `~/.beckett/browser-results.json`
envelope before Discord posting. A failed durable write prevents the post; transient delivery
failures retry while the daemon is live, and pending envelopes retry after restart. The outbox stores
run/channel/state, redacted result, and proof paths, not the original task or requester identity.
Proof attachment failures retain both the envelope and screenshot for retry. Terminal results post
directly to Discord without third-party Chilltext processing.

Blocking-question correlation uses a separate mode-`0600` ledger. If its durable write fails after
Discord accepts a question, Beckett deletes that visible question and aborts the wait. Restarted
anchors are stale privacy tombstones whose Discord deletion is retried. Only a confirmed deletion
starts the seven-day expiry clock or makes a record safe to compact. The ledger is capped at 1,000
without dropping unconfirmed anchors, so it fails closed on new questions if none can be removed.
Question whitespace is normalized and Discord's `singleMessage` path keeps the prompt, fixed reply
instruction, and screenshot in one post. The screenshot is uploaded under the reserved
`beckett-browser-question.png` attachment name; that name plus the fixed suffix is the restart-safe
marker. This marker, not the ledger alone, covers a crash between Discord acceptance and persistence:
recognized orphan replies are consumed, the orphan question is deleted, and the user is told to
restart the run. An uninspectable bot reference is also consumed fail-closed with guidance to resend
the answer as a fresh mention. Every recognized reply is deleted before its contents are used,
including stale, wrong-user, and role-revoked answers. Grant the Discord bot Manage Messages; if
deletion cannot be confirmed, Beckett refuses to use the answer.

This is a filesystem and process boundary, not a separate-UID or network boundary. Processes already
running as the `beckett` Unix user remain trusted, and both browser sandboxes share the host network
namespace so the evaluator can reach Chromium over loopback CDP. Keep computer-use on a dedicated
Beckett machine rather than a multi-tenant host.

## 3. Toolchain (as `beckett`)

Node 24 LTS under `~/.local/bin`, Bun under `~/.bun/bin`, the native `claude` and `codex`
installers, Pi's current `@earendil-works/pi-coding-agent` package, plus `gh`, `rg`, `fd`, and
`jq`. The public installer uses vendor-supported install paths and verifies Node's published
SHA256 before extraction. Cloudflared is optional.

## 4. Credentials (from the encrypted backup — never in git)

| File | What |
|---|---|
| `~/.beckett/.env` | `DISCORD_TOKEN`, `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY_PATH` (see [`github-app.md`](github-app.md)), `DISCORD_ALERT_WEBHOOK_URL`, … — the committed `.env.example` is the full inventory with per-key mint/scope notes (`beckett doctor` flags drift) |
| `~/.claude/.credentials.json` | claude subscription login |
| `~/.codex/auth.json` | codex ChatGPT login |
| `~/.pi/agent/auth.json` | pi OAuth login |
| `~/.beckett/config.toml` | runtime overrides (validated strict — prune keys when the schema prunes; `deploy/config.toml.example` = every key at its default) |

### The encrypted backup (issue #34)

All five files are backed up age-encrypted to the **Mac** (`~/.beckett-backups/`); the age private
key (`~/.config/age/beckett-backup.key`) exists ONLY there. Backups are deliberately not committed
— this repo is public, and public git history is forever.

- **After any secret change** (rotation, new key), from the Mac: `./deploy/backup-secrets.sh`
  (pulls, encrypts, and decrypt-verifies in one step).
- **Restore onto a fresh box**, from the Mac:

  ```bash
  age -d -i ~/.config/age/beckett-backup.key \
    ~/.beckett-backups/beckett-secrets-<newest>.tar.age | ssh beckett@HOST 'tar -x -C ~'
  ```

  Then continue at step 5 below. A from-scratch environment is `git clone` + this one command +
  `./deploy/install.sh` — zero source-reading.

## 5. Clone + units

```bash
git clone https://github.com/kowo-co/beckett.git ~/beckett
cd ~/beckett && bun install --frozen-lockfile
./deploy/install.sh --no-start  # links units and keeps any existing daemon disabled/stopped
# After credentials are ready:
./deploy/install.sh
```

### No tracker (v7)

There is no ticket board any more. Work is a **run** in `~/.beckett/runs.json`, filed by
`beckett task deploy` and driven by the in-daemon run supervisor, so a fresh box needs nothing
installed for Beckett to ship.

**Upgrading a box that ran v6**, in this order:

1. `systemctl --user disable --now bored.service` — nothing reads it; leaving it up is a port and
   a process for no reason.
2. Drop `BECKETT_BORED_URL` from `~/.beckett/.env`.
3. Delete the `[tracker]` and `[progress]` sections from `~/.beckett/config.toml`. Both were
   retired with the run engine. The daemon still BOOTS with them present — `loadConfig` strips
   retired sections and logs one deprecation line per key — but that shim is temporary, so clean
   the file on this deploy rather than the next one.

Runs in flight across the upgrade are recovered from `runs.json` on boot, not re-filed.

## Ops visibility (issue #30)

- `bun src/cli/beckett.ts status --pretty` — what the live daemon is doing right now.
- `bun src/cli/beckett.ts doctor` — would Beckett work right now (binaries under the daemon PATH,
  live token probes, env drift, leaked worker processes)? Non-zero exit on any failing check.
- Crash alerts: every unclean unit death posts to `DISCORD_ALERT_WEBHOOK_URL` via `deploy/alert.sh`
  (rate-limited); a crash loop past the start limit fires `beckett-alert@<unit>` and stays down.
- `beckett-heartbeat.timer` posts a weekly doctor report — silence in the alert channel means
  healthy, not "alerting is broken too".

## 6. Deploys

From the Mac, after a PR merges to main:

```bash
./deploy/deploy-prod.sh
```

That is the entire deploy story: credential preflight → ff-only pull of origin/main → land the
release-version bump through its own PR → `bun install` → typecheck gate → version tag → restart →
health read-back. It refuses a dirty checkout by design.

`main` is branch-protected (PR + the `check` status check) and the script re-execs into a
`systemd --user --scope` with no ambient git credential, so it never runs a bare `git push`. The
bump goes onto `release-bump-vX.Y.Z` and lands via `beckett gh land` (push → PR → CI → merge); the
annotated tag goes up via `beckett gh push --tag`; both authenticate with the GitHub App
installation token. `beckett gh preflight --repo <owner/name>` runs first — no credential is a
named FATAL before anything is committed, never git's `could not read Username`. A re-run whose
bump already landed is a clean no-op on that step and proceeds to the gates.
`BECKETT_BUMP_CI_TIMEOUT` (seconds, default 1800) bounds the wait on the bump PR's CI.

**Rolling back across the v4 rename** (v4.0.0 renamed the unit `beckett-v3` → `beckett-v4`; the
unit symlinks point INTO the repo, so a checkout of an older release dangles the v4 unit): on the
box, `systemctl --user stop beckett-v4.service` **first** — the old release's `install.sh`
predates beckett-v4 and will not stop it, so skipping this step leaves two daemons on one Discord
token — then `git checkout v<previous>` in `~/beckett`, `bun install --frozen-lockfile`, and run
that checkout's `./deploy/install.sh` (re-links and starts the old unit). Rolling forward again is
just `./deploy/deploy-prod.sh` (its install-guard heals the unit rename cutover automatically).

## Clone roles (the anti-drift contract)

| Clone | Role | Rule |
|---|---|---|
| `beckett@loom-desk:~/beckett` | **deploy checkout** — what systemd runs | never edited by hand, never by workers; only `deploy-prod.sh` touches it |
| `beckett@loom-desk:~/Projects/<slug>` | worker checkouts (one per ticket project) | Beckett's own repo included: self-improvement tickets run in `~/Projects/beckett` and flow through PRs to `origin main` like everything else |
| dev clones (Mac, claude@loom-desk) | humans + interactive agents | short-lived feature branches off main, pushed same-day; no version-named long-lived branches |

Version identity: `package.json` is the ONE source (`BECKETT_VERSION` reads it); bump it with the
CHANGELOG in the PR; `deploy-prod.sh` tags `v<version>` at deploy.
