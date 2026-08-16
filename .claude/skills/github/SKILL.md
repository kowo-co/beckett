---
name: github
description: Use whenever you touch GitHub — creating a repo, pushing a branch, opening/merging/reviewing a PR, filing or answering an issue, or getting installed on someone's repo. Always go through `beckett gh ...`; never call raw `gh`/`git push` and never run `gh auth`.
---

# github

## Who you are on GitHub

You are a **GitHub App owned by the `kowo-co` org**, not a user account. You act as
**`beckett[bot]`**. There is no password, no browser session, no 2FA — the credential is a private
key that signs a JWT, which buys a short-lived installation token.

You used to be the machine account `0xbeckett`. That account is gone permanently. Anything that
still says `0xbeckett/…` is stale; your own source repo is **`kowo-co/beckett`**.

The consequence that matters day to day: **your reach is defined by installations, not by
membership.** Someone installs you on their account or org, picks which repos you can see, and
from that moment you can work there as a first-class actor. Nobody has to add you as a
collaborator. This is the good version — but it also means a repo nobody has installed you on is
genuinely invisible to you, and no amount of retrying changes that.

## The one rule

**Never call the bare `gh` binary, and never `gh auth status` / `gh auth login`.** You are already
authenticated — a fresh installation token is injected per-invocation. Bare `gh` (without the token
in env) will see "not logged in" and you'll waste turns fixing auth that isn't broken. Always go
through `beckett gh` — either a curated verb or the `raw` passthrough (both inject the token):

| Want to… | Run |
|---|---|
| Make a new repo | `beckett gh repo create <name> [--public] [--desc "<d>"] [--source <dir>] [--push]` |
| Push a branch | `beckett gh push --repo <owner/name> --branch <remoteBranch> [--ref HEAD] [--dir <worktree>]` |
| Push a release tag | `beckett gh push --repo <owner/name> --tag <tag> [--dir <worktree>]` |
| Open a PR | `beckett gh pr create --repo <owner/name> --base main --head <branch> --title "<t>" --body "<b>" [--draft]` |
| Check PR is green | `beckett gh pr status <num> --repo <owner/name>` |
| Comment / review | `beckett gh pr review <num> --repo <owner/name> --event COMMENT\|APPROVE\|REQUEST_CHANGES --body "<b>"` |
| Merge a PR | `beckett gh pr merge <num> --repo <owner/name> [--strategy squash\|merge\|rebase]` |
| File an issue | `beckett gh issue create <owner/repo> --title "<t>" [--body "<b>" \| --body-stdin] [--label <l> …]` |
| Read issues | `beckett gh issue list <owner/repo> [--state open\|closed\|all] [--limit N]` |
| Answer an issue | `beckett gh issue comment <owner/repo> <number> [--body "<b>" \| --body-stdin]` |
| See your own identity/reach | `beckett gh app status` / `installations` / `repos` / `diagnose` / `install-url` |
| **Anything else** | `beckett gh raw -- <any gh args>` (see below) |

All output is JSON on stdout. `--private` is the default for `repo create`; pass `--public` to
override. Issue bodies are long markdown — pipe them in (`… | beckett gh issue create <owner/repo>
--title "<t>" --body-stdin`) rather than fighting quoting in argv.

## Token mechanics (why things are the way they are)

- The JWT is signed with the app's private key (`GITHUB_APP_ID` +
  `GITHUB_APP_PRIVATE_KEY_PATH` in `~/.beckett/.env`) and lives ~9 minutes.
- It buys an **installation access token**: valid **one hour**, scoped to **one installation** and
  that installation's repo selection. It is minted per operation and cached; you never handle it.
- Which installation gets used is resolved from the **target repo/owner** of the call — repo's
  installation → owner's installation → the pinned home installation → the sole installation. If
  none of those cover the target, the call fails loudly with the install link rather than guessing.
- `git` over HTTPS authenticates as username `x-access-token`; `gh` gets `GH_TOKEN`. Both ride the
  environment, never argv.
- Practical effect: a long job never hits a stale token, and a token from someone else's
  installation can never leak into their neighbour's repo.

## Getting installed on someone's repo

When a person wants you working in a repo you can't reach, the fix is an install, and the link is:

```
https://github.com/apps/<slug>/installations/new
```

Get it with `beckett gh app install-url` (don't hand-build it — the slug comes from GitHub).

What they see when they click: a page asking **which account** to install on (their personal
account, or an org they belong to), then a choice between **All repositories** and **Only select
repositories** with a repo picker. On an org where they aren't an owner, their click files an
**approval request** to an owner — until that's approved you'll still see the org as not-installed.

**Scope guidance.** Recommend **only the repo at hand**, and mention all-repos exists without
selling it. Least privilege is the default and people trust it more. If access comes up a **second
time** — a different repo in the same account — that's the natural moment to offer the switch to
all-repos, because now the friction is real and observed rather than hypothetical. Point them at
the same install link; re-running it adds repos to an existing installation.

You cannot install yourself. There is no API for it. The link is the whole move.

## Anything the table doesn't cover: `beckett gh raw`

The curated verbs are a convenience layer, not the whole of `gh`. For anything they don't cover —
releases, gists, labels, workflow runs, `gh api`, arbitrary flags — forward it verbatim to
the real `gh` binary with the token already injected:

```
beckett gh raw -- <any gh args>
beckett gh raw --dir <worktree> -- <any gh args>   # run gh inside a specific checkout
```

Everything after `--` is passed to `gh` untouched (including gh's own `--flags`); stdout/stderr
stream live and gh's exit code is propagated. Examples:

- `beckett gh raw -- release create v6.0.4 --generate-notes --repo kowo-co/beckett`
- `beckett gh raw -- api repos/kowo-co/beckett/rulesets --paginate`
- `beckett gh raw -- issue close 12 --repo kowo-co/beckett` (open/list/comment have curated verbs)

This is `beckett`'s sanctioned passthrough, **not** the bare `gh` binary — the one rule still
holds: reach for `beckett gh raw`, never a bare `gh`, and never `gh auth …`. Prefer a curated verb
when one fits (its JSON output and posture gating are load-bearing); use `raw` for the rest.

## Hard limits — things you genuinely cannot do

Say these plainly when they come up. Don't work around them, and don't promise around them.

- **No browser login to github.com.** No account, no session, no password to recover. Everything is
  the REST API and `git` over HTTPS.
- **No reach into repos where you aren't installed.** You cannot fork an arbitrary repo, cannot
  open a drive-by PR on a stranger's project, cannot read a private repo outside an installation's
  selection. The answer is always "install me here", never another route in.
- **No user-only actions**: starring, following, sponsoring, reacting as a person.
  `PUT /user/starred/...` returns `403 Resource not accessible by integration`. `beckett gh repo
  star` only works on the legacy PAT path.
- **Commit verification splits by path.** Commits you push with the **git CLI** are *unverified*
  and carry whatever `user.email` the worktree has. Commits created through the **API** (contents
  API, the PR merge endpoint) are signed by GitHub and show **Verified** as `beckett[bot]`. If
  someone cares about the green Verified badge, that's the difference — say which one you used.
- **Permissions are fixed at the app level**: contents RW, pull_requests RW, issues RW, metadata R,
  checks R. Anything outside that 403s. Widening them re-prompts *every* existing installation for
  approval, so it's a real decision, not a quick fix — file it, don't do it inline.

## How a deployed run's work lands

A `beckett task deploy` run against a repo you own does not stage a diff for you to merge by
hand: the machinery pushes its branch, opens or reuses a PR against trunk, waits (bounded) on CI,
and merges via the API with squash. There is no local rebase-and-push onto trunk for that path —
the only direct push straight to a default branch is a brand-new, ref-less repo that has nothing
to PR against yet. If it parks, the blocker names the open PR; clear whatever's blocking it there
(CI, conflicts, review) rather than pushing anything by hand, then `beckett task courier <run-id>
[--pr-url <url>]` once it's merged. This skill's own verbs below are for the PRs *you* drive
directly from this seat — an inline fix, `beckett finish`, courier work.

## Spinning up a new project repo

The common flow when a task means "make a thing and put it on GitHub":

1. Build it in a dir (worktree or fresh dir), `git init` + a first commit if it isn't one already.
2. `beckett gh repo create <name> --source <dir> --push --desc "<one-liner>"` — creates the repo
   under the configured owner and pushes the initial commits in a single step.
3. Report the repo URL in channel (see [[deliver]]).

## What's free vs. what needs a handshake

- **Free** (just do it, then say you did): `repo create`, `push`, `pr create`, `pr review`,
  `pr status` — reversible / proposals. And **`pr merge` of work whose review passed**: a green,
  reviewed PR is finished work, and merging it is the last step of the job, not a question
  (Volition). Conflicts on the way are yours to clear — rebase, reconcile, re-check, merge.
- **Handshake-gated**: `pr merge` of UNREVIEWED work to a shared branch (main) — nothing has
  gated it yet, so you are the gate: "PR's up — review or merge?" and wait for the go. Also
  anything the owner put an explicit hold on; a hold beats a green check every time.

## Notes

- Worktree workers commit on `beckett/<id>` branches. To deliver one, either `integrate` it
  locally (merge to the local default branch) or `push` the branch and `pr create` it — pick based
  on whether the repo has a remote.
- If `beckett gh` errors with "no GitHub credentials" the app just isn't configured on this box —
  say so plainly (`deploy/github-app.md` is the runbook); don't try to re-auth.
- **If a GitHub call fails because you can't see a repo, do NOT reply until you've run the access
  triage** — [[troubleshooting]] entry 1. "Not installed", "installed but that repo isn't
  selected", and "no such repo" produce completely different answers, and guessing wrong wastes
  someone's turn.
