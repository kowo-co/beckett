#!/usr/bin/env bash
# Beckett — THE deploy (issue #29). Run from the Mac after a PR merges to main:
#   ./deploy/deploy-prod.sh
# Prod (~/beckett on desktop) only ever runs origin/main: fetch, ff-only pull, typecheck,
# restart, health read-back. Also tags the deployed version (from package.json) and prunes
# dead wk_* worker branches so the graveyard never regrows.
set -euo pipefail

HOST="${BECKETT_HOST:-beckett@desktop}"

# ── self-deploy survival guard (issue #81) ──────────────────────────────────────────────────
# When beckett deploys ITSELF, the running daemon spawns this script, so it (and its ssh child)
# land INSIDE beckett-v4.service's cgroup. The remote `systemctl --user restart beckett-v4.service`
# below tears down that whole cgroup (systemd's default KillMode=control-group), which used to kill
# this script mid-run — before the annotated release tag was created and pushed. Package.json got
# bumped and main pushed, but `git ls-remote --tags origin vX.Y.Z` stayed empty and the log
# truncated at the restart with no "deploy complete".
#
# Since issue #30 the tag is now pushed in phase 2, BEFORE the restart, so a cgroup kill can no
# longer lose it. But this scope is still necessary: the restart would otherwise kill the script
# mid-phase-3, before the health read-back and the phase-4 post-restart tag verification — a
# silent half-deploy. So still escape the cgroup: re-exec the whole script into a transient user
# *scope* — a sibling of beckett-v4.service under the user manager, not a child of it. The restart
# can no longer reach us, so the ssh client stays connected, the remote health gate returns
# normally, and phases 3–4 run to completion. This is a no-op off the daemon host (e.g. the Mac, or
# an interactive shell on loom-desk), where this script isn't a child of beckett-v4.service.
if [ -z "${BECKETT_DEPLOY_SCOPED:-}" ] && grep -qs 'beckett-v4\.service' /proc/self/cgroup; then
  echo "== self-deploy detected: re-exec into a detached user scope so the restart can't kill us =="
  command -v systemd-run >/dev/null || {
    echo "FATAL: running inside beckett-v4.service's cgroup but systemd-run is unavailable; the" >&2
    echo "restart would kill this script before the release tag is pushed. Install systemd-run" >&2
    echo "(part of systemd) or run the deploy from a shell outside the daemon's cgroup." >&2
    exit 1
  }
  exec env BECKETT_DEPLOY_SCOPED=1 systemd-run --user --scope --quiet -- "$0" "$@"
fi

# ── the one credential every push in this script rides (issue #5) ───────────────────────────
# NOTHING here uses a bare `git push`: the self-deploy guard above re-execs into a
# `systemd --user --scope`, which inherits no git credential helper — a bare push dies with
# `fatal: could not read Username for 'https://github.com'` even when it has nothing to push.
# Both writes go through the GitHub App installation token (`x-access-token:<token>`, minted by
# src/github/app.ts): the bump via `beckett gh push --branch main`, the release tag via
# `beckett gh push --tag`. `main`'s ruleset requires a PR + CI for humans but lists the 0x-beck
# App as a bypass actor (2026-08-12), so the App token pushes the bump commit straight at main —
# no release PR, no CI wait; the phase-1 gate below is what stands between the push and the
# restart. Reads (`git fetch`, `git ls-remote`) work anonymously and are left alone. Preflight
# the credential HERE, before anything is written, so a missing app key is a named FATAL rather
# than git's "could not read Username" ten minutes in.
REPO="${BECKETT_DEPLOY_REPO:-$(git remote get-url origin | sed -E 's#\.git$##; s#/+$##; s#^[^@/]+@[^:]+:##; s#^[a-z+]+://[^/]+/##')}"
echo "== preflighting the GitHub App credential for ${REPO} =="
if ! CRED_PREFLIGHT="$(bun run beckett gh preflight --repo "${REPO}" --dir "$PWD" 2>&1)"; then
  echo "FATAL: no usable GitHub credential for ${REPO} — this deploy cannot publish anything." >&2
  echo "${CRED_PREFLIGHT}" >&2
  echo "The release-bump PR and the release tag both push with the GitHub App installation token;" >&2
  echo "there is no fallback to ambient git credentials (this script re-execs into a systemd user" >&2
  echo "scope that has none). Set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY_PATH in ~/.beckett/.env" >&2
  echo "(see deploy/github-app.md), confirm with 'beckett gh app diagnose --repo ${REPO}', then" >&2
  echo "re-run ./deploy/deploy-prod.sh. Nothing has been committed, pushed, or restarted." >&2
  exit 1
fi

# ── smart semver bump (OPS-188) ─────────────────────────────────────────────────────────────
# BEFORE we ship the merge, decide whether this release is a MINOR (new capability) or a PATCH
# (fix / internal / behavior-preserving) from the commits since the last deployed tag, then write
# + commit the new version to the source of truth (package.json). The same commit also cuts
# CHANGELOG.md — the `## Unreleased` block moves under a dated `## vX.Y.Z` heading and a fresh stub
# is left behind (issue #147) — so the changelog and version can never drift. MAJOR is owner-only — it never
# comes from the classifier, only an explicit override. The suggestion is CONFIRMABLE: run
# interactively and beckett prompts; or pre-decide non-interactively with
#   BECKETT_BUMP=minor|patch|major|yes|set:X.Y.Z ./deploy/deploy-prod.sh
# ("yes" accepts the auto suggestion; "set:X.Y.Z" pins an exact version — pre-releases like
# set:7.0.0-rc.1 included). The bump commit must reach origin/main before prod pulls,
# so we sync main, bump, and push it (App-token, ruleset bypass) here.
echo "== computing version bump since last deploy =="
git fetch origin --tags --prune
git checkout main
git pull --ff-only origin main
BASE_SHA="$(git rev-parse origin/main)"
BUMP_ARGS=()
case "${BECKETT_BUMP:-}" in
  minor) BUMP_ARGS=(--minor) ;;
  patch) BUMP_ARGS=(--patch) ;;
  major) BUMP_ARGS=(--major) ;;
  yes)   BUMP_ARGS=(--yes) ;;
  set:*) BUMP_ARGS=(--set "${BECKETT_BUMP#set:}") ;;
  "")    : ;;  # interactive: beckett prompts for confirm/override
  *)     echo "FATAL: BECKETT_BUMP must be one of minor|patch|major|yes|set:X.Y.Z" >&2; exit 1 ;;
esac
# ${VAR[@]+...} → nothing when empty (safe under set -u, portable to bash 3.2 on the Mac).
if ! bun run beckett version bump ${BUMP_ARGS[@]+"${BUMP_ARGS[@]}"}; then
  echo "FATAL: version bump aborted — not deploying" >&2
  exit 1
fi

# Is there anything to land? Compared by TREE, not by sha, so both no-op shapes are one branch:
# `beckett version bump` reporting `"level": "none"` (nothing merged since the last release, so no
# commit was made at all), and a re-run whose bump already landed on origin/main (possibly under a
# different sha from the PR-landing era). Either way there is nothing to push, we do not touch
# GitHub, and the deploy proceeds straight to the gates — the re-run wedge issue #5 describes was
# exactly this step failing on a push it did not even need to make.
if git diff --quiet "${BASE_SHA}" HEAD; then
  git reset --hard -q "${BASE_SHA}"   # drop a same-content leftover commit from an earlier run
  echo "== no version bump to land — main already matches origin/main =="
else
  VERSION_TO_LAND="v$(python3 -c 'import json;print(json.load(open("package.json"))["version"])')"
  # Push the bump commit straight at main with the App token: the main ruleset requires a PR +
  # CI for humans but lists the 0x-beck App as a bypass actor (2026-08-12), so releases no longer
  # generate a PR or block ~4 minutes on its CI run. The phase-1 gate below (typecheck + fast
  # test lane on the prod host) is what stands between this push and the restart; CI still runs
  # on the main push asynchronously as a second opinion.
  echo "== pushing ${VERSION_TO_LAND} straight to main (App-token push; humans still PR) =="
  if ! bun run beckett gh push --repo "${REPO}" --branch main --dir "$PWD"; then
    echo "FATAL: could not push the release bump ${VERSION_TO_LAND} to main (cause above)." >&2
    echo "Nothing was tagged, restarted, or deployed. Resetting local main to origin/main;" >&2
    echo "re-run ./deploy/deploy-prod.sh once the blocker is cleared — the bump is recomputed." >&2
    git reset --hard -q "${BASE_SHA}"
    exit 1
  fi
  git fetch origin --tags --prune
  REMOTE_MAIN="$(git ls-remote origin refs/heads/main | awk '{print $1}')"
  [ "${REMOTE_MAIN}" = "$(git rev-parse HEAD)" ] || {
    echo "FATAL: pushed ${VERSION_TO_LAND} but origin/main is at ${REMOTE_MAIN}, not $(git rev-parse HEAD)" >&2
    echo "(a concurrent push?) — inspect, then re-run ./deploy/deploy-prod.sh" >&2
    exit 1
  }
  echo "== ${VERSION_TO_LAND} is on origin/main =="
fi

# ── phase 1: prepare + gate the release on the host (NOT restarting yet) ────────────────────
# Bring ~/beckett to origin/main and run every hard gate — build, browser smoke, `tsc --noEmit`.
# NOTHING here restarts the daemon: the restart (and the browser-drain guard that must run right
# before it) is phase 3, AFTER the tag lands. If any gate here fails, ssh returns non-zero, the
# local `set -e` aborts, and we never tag — so a tag still only ever records a gate-passing build.
echo "== gating origin/main on ${HOST} (build + smoke + typecheck; NOT restarting yet) =="
ssh "${HOST}" 'bash -s' <<'REMOTE'
set -euo pipefail
# Non-login ssh shells don't source .bash_profile, so pin the daemon PATH explicitly (bun lives
# in ~/.bun/bin on installer-provisioned hosts; loom-desk kept a /usr/local/bin copy, desktop
# does not). MUST stay in sync with `Environment=PATH=` in deploy/systemd/beckett-v4.service.
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"
cd ~/beckett
if [ -n "$(git status --porcelain)" ]; then
  echo "FATAL: deploy checkout is dirty — ~/beckett must never be edited by hand:" >&2
  git status --short >&2
  exit 1
fi
git fetch origin
git checkout main
git pull --ff-only origin main
# Global model-selection doctrine for every claude session on this account (workers, quick,
# free-time, concierge): the repo file is the source of truth, this keeps the installed copy in
# sync on every deploy. Idempotent — a plain overwrite, safe to re-run.
mkdir -p "$HOME/.claude"
cp ~/beckett/deploy/claude-global.md "$HOME/.claude/CLAUDE.md"
bun install --frozen-lockfile
# BetterWright's documented setup provisions its managed runtime. Since 1.7.x a bare
# `betterwright setup` installs three legs: the Obscura resident DOM engine
# (~/.betterwright/obscura — bound read-only into the browser-host sandbox by
# src/browser/isolated.ts, so headless DOM work no longer keeps Chromium resident),
# the on-demand Chromium pixel renderer (~/.betterwright/chromium — deliberately NOT
# bound into the sandbox: screenshot promotion stays on the managed CloakBrowser via
# the storage-quota shim), and the managed CloakBrowser (~/.cloakbrowser). A missing
# Obscura install is a silent fallback to CloakBrowser, so this line failing partway
# degrades rather than breaks. Beckett's own pinned-Playwright Chromium (the default
# backend + evaluator) is installed separately below.
bun x betterwright setup
bun x playwright install --no-shell chromium
browser_smoke() {
  bun -e 'import { chromium } from "playwright"; const browser = await chromium.launch({ headless: true, channel: "chromium" }); await browser.close();'
}
if ! browser_smoke; then
  echo "Chromium is installed but cannot launch; attempting one-time Linux dependency provisioning" >&2
  if ! sudo -n "$(command -v bun)" x playwright install-deps chromium; then
    echo "FATAL: Chromium system libraries are missing and passwordless sudo is unavailable." >&2
    echo "Run once as an administrator: cd /home/beckett/beckett && sudo /usr/bin/env PATH=/home/beckett/.bun/bin:/usr/local/bin:/usr/bin:/bin bun x playwright install-deps chromium" >&2
    exit 1
  fi
  browser_smoke
fi
command -v bwrap >/dev/null || {
  echo "FATAL: bubblewrap is required for the isolated browser host; install the bubblewrap package." >&2
  exit 1
}
command -v prlimit >/dev/null || {
  echo "FATAL: prlimit (util-linux) is required for browser evaluator resource limits." >&2
  exit 1
}
bwrap --unshare-all --share-net --die-with-parent --ro-bind / / /bin/true || {
  echo "FATAL: bubblewrap is installed but user namespaces are blocked; see deploy/host-setup.md." >&2
  exit 1
}
bun run browser:smoke
bun x tsc --noEmit                      # never restart onto broken code
# The fast test lane (~35s; browser e2e files excluded — browser health is covered by the smoke
# above). Now that releases push straight to main instead of waiting on a PR's CI, this is the
# only test run standing between the push and the restart, so it is a hard gate.
bun run test
# prune the dead per-worker branches the retired flow left behind (and any new strays).
# Two patterns because for-each-ref globs are pathname-aware: `*` stops at `/`, so nested
# branches like beckett/wk_0012f678/OPS-11 need the `/**` form.
git for-each-ref --format='%(refname:short)' 'refs/heads/beckett/wk_*' 'refs/heads/beckett/wk_*/**' | xargs -r git branch -D
# Self-healing unit install (v3→v4 cutover): if the beckett-v4 unit isn't linked yet, this box
# still has the old unit — run install.sh (idempotent) to link v4 and retire the stale ones. This
# must be in place before the phase-3 restart; it does NOT itself restart anything.
systemctl --user cat beckett-v4.service >/dev/null 2>&1 || ~/beckett/deploy/install.sh
REMOTE

# ── phase 2: tag the release BEFORE the restart (issue #30) ─────────────────────────────────
# "This commit is release vX.Y.Z" becomes TRUE the moment the version-bump commit is on origin/main
# and the phase-1 gates pass — it does not depend on THIS restart succeeding. The old ordering put
# the tag AFTER the restart, so a script death anywhere between the restart and `git tag -a` (issue
# #81's cgroup kill, an ssh drop, a health-gate abort) lost the tag entirely — and a lost tag then
# wedged the NEXT deploy's bump base. Tagging here, before the restart, trades that fragile ordering
# for a durable one; phase 3 still re-verifies the tag survived on origin after the restart.
#
# Push through `beckett gh push --tag` — the App-credentialed tag path (`GitHubCli.pushTag`, which
# pushes `refs/tags/<v>:refs/tags/<v>` so a tag lands as a tag). A bare `git push origin refs/tags/…`
# used to sit here and could not authenticate at all inside the deploy's systemd user scope
# (`could not read Username`), which is what left releases untagged (issue #5). A pre-existing tag
# must already be an annotated tag on THIS exact release commit; silently accepting a local
# lightweight/stale tag would let package.json and origin's history drift again.
VERSION="v$(python3 -c 'import json;print(json.load(open("package.json"))["version"])')"
HEAD_COMMIT="$(git rev-parse HEAD)"
if git rev-parse -q --verify "refs/tags/${VERSION}" >/dev/null; then
  [ "$(git cat-file -t "refs/tags/${VERSION}")" = "tag" ] || {
    echo "FATAL: existing ${VERSION} is not an annotated tag" >&2
    exit 1
  }
  [ "$(git rev-list -n 1 "${VERSION}")" = "${HEAD_COMMIT}" ] || {
    echo "FATAL: existing ${VERSION} does not point at the release commit" >&2
    exit 1
  }
  echo "== annotated tag ${VERSION} already exists =="
else
  git -c tag.gpgSign=false tag -a "${VERSION}" -m "beckett: release ${VERSION}"
  echo "== created annotated tag ${VERSION} =="
fi
if ! bun run beckett gh push --repo "${REPO}" --tag "${VERSION}" --dir "$PWD"; then
  echo "FATAL: could not push the release tag ${VERSION} to ${REPO}." >&2
  echo "The bump for ${VERSION} is already on main; re-run ./deploy/deploy-prod.sh once the cause" >&2
  echo "above is cleared (the bump step will be a no-op and it will retry the tag)." >&2
  exit 1
fi
REMOTE_TAG="$(git ls-remote --tags origin "refs/tags/${VERSION}" | awk '{print $1}')"
LOCAL_TAG="$(git rev-parse "refs/tags/${VERSION}")"
[ "${REMOTE_TAG}" = "${LOCAL_TAG}" ] || {
  echo "FATAL: origin did not retain ${VERSION} after push" >&2
  exit 1
}
echo "== tagged and pushed ${VERSION} BEFORE restart =="

# ── phase 3: drain in-flight browser work, then restart onto the tagged release ─────────────
# The browser-drain guard is a HARD gate that must run as late as possible — immediately before the
# restart — because a browser run started between phase 1 and here would otherwise be lost by the
# restart. It stays ahead of the restart; it is not weakened. A browser run (including a queued one)
# is durable only until shutdown: its Claude/browser session cannot survive this restart. The guard
# queries the STILL-OLD daemon, prints run ids and ages while it waits, then fails closed after a
# capped deadline rather than losing a routine run. Set BECKETT_BROWSER_DRAIN_WAIT_SECS=0 to refuse
# immediately (maximum: ten minutes).
echo "== draining browser work and restarting ${HOST} =="
ssh "${HOST}" 'bash -s' <<'REMOTE'
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"
cd ~/beckett
bun deploy/browser-drain-guard.ts
systemctl --user restart beckett-v4.service
sleep 5
systemctl --user is-active beckett-v4.service
journalctl --user -u beckett-v4.service -n 12 --no-pager -o cat
REMOTE

# ── phase 4: verify the tag SURVIVED the restart on origin ──────────────────────────────────
# The tag was pushed in phase 2, but re-check origin after the restart: this is the loud alarm the
# old flow never had. If anything (a force-push race, a mirror hiccup) dropped the tag, fail here
# rather than reporting a clean deploy over a missing release record.
REMOTE_TAG_AFTER="$(git ls-remote --tags origin "refs/tags/${VERSION}" | awk '{print $1}')"
[ "${REMOTE_TAG_AFTER}" = "${LOCAL_TAG}" ] || {
  echo "FATAL: ${VERSION} is missing from origin after the restart — release tag was lost" >&2
  exit 1
}
echo "== verified ${VERSION} still on origin after restart =="
echo "== deploy complete =="
