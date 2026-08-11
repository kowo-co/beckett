---
name: troubleshooting
description: Use when something you tried didn't work and you're about to report it — a repo you can't see, a credential that isn't there, a harness that won't cast, a daemon that isn't answering. Diagnose the actual cause with the listed commands BEFORE replying; the wrong guess wastes someone's turn.
---

# troubleshooting

An ordered triage. Each entry is: the symptom, the commands that separate the real causes, and
what each cause actually means. Run the diagnosis **before** you say anything about the failure —
"I can't see that repo" and "you haven't installed me there yet" are the same symptom and
completely different answers.

Whole-box sweep, when more than one thing is off at once: **`beckett doctor`**. It probes
binaries, harness preflights, the tracker, live credentials, the env inventory, leaked harness
processes, disk, the daemon socket, and Chromium — every check below has a row in it.

---

## 1. A GitHub repo you can't reach

**Symptom:** any `beckett gh` call fails with `404 Not Found`, `Could not resolve to a Repository`,
`Resource not accessible by integration`, or a repo simply isn't there.

You are a GitHub App (see [[github]]). Your reach is defined by **installations**, so a 404 is
ambiguous by construction: not-installed, installed-but-unselected, and no-such-repo all look
identical from outside. **Do not reply until you've told them apart.**

```
beckett gh app diagnose --repo <owner>/<name>     # the whole triage in one call
```

It resolves in this order and returns a `status`:

| `status` | What actually happened | What it means |
|---|---|---|
| `ok` | `GET /repos/{o}/{r}/installation` → 200 | you can reach it; the failure was something else — keep reading this file |
| `not-installed` | repo lookup 404, owner lookup 404, but `GET /users/{owner}` → 200 | the account exists and has never installed you |
| `repo-not-selected` | owner installation exists; the repo is publicly visible but outside the selection | installed, but this repo wasn't picked |
| `repo-not-selected-or-missing` | owner installation exists; the repo is not visible unauthenticated | either a private repo outside the selection **or** it doesn't exist — GitHub cannot tell you which, so don't claim to know |
| `no-such-owner` | `GET /users/{owner}` → 404 | the owner login is wrong. Almost always a typo |

The supporting reads, when you want the detail rather than the verdict:

```
beckett gh app status                  # app id, slug, owner, every account that installed you
beckett gh app installations           # each installation: id, account, "all" vs "selected"
beckett gh app repos --owner <login>   # exactly which repos that installation can reach
beckett gh app install-url             # the link to hand someone
```

**What to do with each verdict**

- `not-installed` / `repo-not-selected` / `repo-not-selected-or-missing` → the fix is an install,
  and the only move you have is handing over the install link. Recommend scoping it to **the repo
  at hand**; mention that all-repositories exists without pushing it. If this is the **second**
  time access has blocked you in the same account, that's when to offer switching to all-repos —
  the friction is now observed, not hypothetical.
- `no-such-owner` → say the owner doesn't exist and ask for the right one. Don't send an install
  link for a login that isn't real.
- `ok` but the call still failed → it's not access. Check the specific error:
  - `403 Resource not accessible by integration` — the app lacks that permission, or it's a
    user-only action (starring, following). Neither is fixable inline; see [[github]] hard limits.
  - `409` / non-fast-forward on push — a branch conflict, not auth. Rebase and retry.
  - `422 Validation Failed` on `pr create` — head/base wrong, no commits between them, or a PR
    already exists.

**Credential-level failures** (these break *every* repo at once, not one):

| Error | Cause | Fix |
|---|---|---|
| `401 A JSON web token could not be decoded` | wrong/corrupt private key, or host clock skew | key path in `~/.beckett/.env`; `timedatectl` on the box |
| `no GitHub credentials in ~/.beckett/.env` | app not configured on this box | `deploy/github-app.md`; this is an operator task, not something you can fix |
| `422` on `access_tokens` | pinned `GITHUB_APP_INSTALLATION_ID` is stale/uninstalled | `beckett gh app installations` for the live id |
| `no installation covers <target>` | resolution found nothing | the install link — same as `not-installed` |

Never respond to a GitHub failure by retrying `gh auth`, by suggesting a PAT, or by asking to be
added as a collaborator. None of those are how this identity works.

---

## 2. A credential that isn't on the box

**Symptom:** a command reports a missing key, or a capability says it's unavailable.

```
beckett doctor            # rows: token: discord | token: github | token: cloudflare |
                          #       token: alert webhook | env: required keys | env: undocumented keys
```

`.env.example` in the repo is the authoritative key inventory; the real file is `~/.beckett/.env`
on the box (mode 0600). Doctor flags drift in **both** directions — a required key missing is a
fail, a key present but undocumented is a warn.

You cannot write `~/.beckett/.env` yourself. Name the exact key, say what it unlocks, and stop —
that's an operator action. For a credential a *human* holds (an account they made, an API key
they were issued), don't ask for a paste in channel: mint a secret-link (see [[jingle]]).

Keys that are *supposed* to be absent post-migration: `GITHUB_PAT`, `GH_TOKEN`, `GITHUB_USER`.
They're dead with the `0xbeckett` account. If something still reads them, that's the bug.

---

## 3. A harness that won't cast

**Symptom:** a worker fails to start, or a cast returns immediately with an auth/version error.

```
beckett doctor            # rows: preflight: claude (one row per enabled harness) |
                          #       binary: <bin>
```

The three distinct causes, which look alike from outside:

- **Not logged in** — the harness uses a subscription login, not an API key:
  `~/.claude/.credentials.json`. A missing file is
  an operator login, not something a retry fixes.
- **Rate-limit cooldown** — preflight reports a `warn` with a cooldown expiry, casts route to the
  substitute harness automatically, and it clears itself when quota resets. This is working as
  designed; say when it clears rather than treating it as broken.
- **Binary absent or wrong version on the DAEMON's PATH** — the daemon's PATH is not your login
  shell's. `binary:` rows probe with the daemon's PATH; a binary that works over ssh and fails
  under systemd is this.

---

## 4. The daemon isn't answering

**Symptom:** a `beckett` command hangs or reports no daemon; deployed work doesn't move.

```
beckett status
beckett doctor            # rows: daemon: control.sock | binaries | credentials
```

- `daemon: control.sock` fail → the service isn't running. `systemctl --user status
  beckett-v4.service` on the box. If it's crash-looping, the alert webhook has already fired.
- A queued run that never starts → the supervisor isn't picking it up; `beckett status` shows the
  live workers and the last supervisor tick. Work already in a worktree is unaffected — say so, so
  nobody assumes the code is lost.
- `healthy-pending-configuration` → a fresh install that hasn't been given credentials yet. The
  status payload lists exactly which ones.

---

## 5. Browser work that won't start

**Symptom:** any `beckett browser` errand fails before it navigates.

```
beckett doctor            # rows: browser: chromium | browser: process sandbox
```

- Chromium **installed but not launchable** is the common one — reinstall the pinned build
  (`bun x playwright install --no-shell chromium`, plus `install-deps` on Linux).
- Sandbox row failing means `bwrap`/`prlimit` are missing or user namespaces are blocked by
  AppArmor — an operator fix on the host, documented in `deploy/host-setup.md`.
- Lease exhaustion is not a failure: there is a concurrent-lease cap. Wait or drop a lease.

---

## 6. A deploy that looks landed but isn't live

**Symptom:** a change is merged on GitHub but the running system doesn't have it.

Merging is not deploying. Every change has to reach `main`, be pulled on the box, and the daemon
restarted. Check the running version against the repo before claiming it shipped:

```
beckett status            # the live version + commit
beckett gh raw -- api repos/kowo-co/beckett/commits/main --jq .sha
```

A version mismatch means the deploy step didn't happen — report that, don't re-merge.

---

## Reporting a failure you can't fix

Two things, always: the **specific cause** (from the triage above, never "something went wrong"),
and **who can fix it** — you, an operator, or the person asking. If it's theirs, give them the one
action that unblocks it (usually a link). If it's an operator's, name the file and the key. If it's
yours and durable, file it rather than re-explaining it next time.
