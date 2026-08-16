#!/usr/bin/env bash
# Beckett - install/refresh the systemd user units (idempotent; issue #29).
# Run as the Beckett service user. Pass --no-start while staging a fresh host.
set -euo pipefail

START=1
case "${1:-}" in
  "") ;;
  --no-start) START=0 ;;
  *)
    echo "usage: $0 [--no-start]" >&2
    exit 2
    ;;
esac

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${HOME}/.config/systemd/user"
mkdir -p "${UNIT_DIR}"

# Symlink every unit in deploy/systemd — the repo is the source of truth; editing the live
# copy under ~/.config drifts silently (that is exactly what this script ends).
#
# Entrypoint rename cutover (issue #150): beckett-v4.service now runs `src/shell/main.ts`
# (renamed from `src/shell/v4-main.ts`). The UNIT FILENAME is unchanged, so this is a
# content-only cutover — no dangling-unit dance like the v3→v4 rename below. The `ln -sf`
# here is idempotent, and the `daemon-reload` + `restart beckett-v4.service` further down
# pick up the new ExecStart from the already-linked unit. Because the file was moved in the
# same commit, `git pull` lands the new unit + new entrypoint atomically before this runs.
for unit in "${REPO_DIR}"/deploy/systemd/*.service "${REPO_DIR}"/deploy/systemd/*.timer; do
  [ -e "${unit}" ] || continue
  name="$(basename "${unit}")"
  ln -sf "${unit}" "${UNIT_DIR}/${name}"
  echo "linked ${name}"
done

# Retire the dead v0/v2/v3 units if this box still has them (v0/v2 code was deleted in issue
# #28; the v3 unit was renamed to beckett-v4 in the 4.0.0 multiplayer release).
# ORDER MATTERS on a rename cutover: after `git pull` the old unit's symlink dangles, and on
# systemd 255 `disable --now` FAILS on a dangling unit ("Unit file does not exist") WITHOUT
# stopping the running process — leaving two daemons on one Discord token. `stop` still works
# on the loaded unit, so stop explicitly first, then disable, then remove every trace: the
# unit symlink AND the default.target.wants enablement link (disable can't clean what it
# can't load). Any drop-in dir (e.g. a TEMP log-level override) migrates to beckett-v4 so it
# keeps applying rather than being silently orphaned.
for stale in beckett.service beckett-v2.service beckett-v3.service beckett-rpc.service; do
  if [ -e "${UNIT_DIR}/${stale}" ] || [ -L "${UNIT_DIR}/${stale}" ]; then
    systemctl --user stop "${stale}" 2>/dev/null || true
    systemctl --user disable "${stale}" 2>/dev/null || true
    rm -f "${UNIT_DIR}/${stale}" "${UNIT_DIR}/default.target.wants/${stale}"
    if [ -d "${UNIT_DIR}/${stale}.d" ]; then
      if [ "${stale}" = "beckett-v3.service" ]; then
        mkdir -p "${UNIT_DIR}/beckett-v4.service.d"
        mv "${UNIT_DIR}/${stale}.d"/*.conf "${UNIT_DIR}/beckett-v4.service.d/" 2>/dev/null || true
        echo "migrated ${stale}.d drop-ins to beckett-v4.service.d"
      fi
      rm -rf "${UNIT_DIR}/${stale}.d"
    fi
    echo "removed stale ${stale}"
  fi
done

systemctl --user daemon-reload

stage_units() {
  systemctl --user disable --now beckett-v4.service >/dev/null 2>&1 || true
  systemctl --user disable --now beckett-heartbeat.timer >/dev/null 2>&1 || true
  # `disable` removes a manually linked unit's primary symlink as well as its wants link. Restore
  # the source-of-truth links so a staged install remains startable without rerunning this script.
  ln -sf "${REPO_DIR}/deploy/systemd/beckett-v4.service" "${UNIT_DIR}/beckett-v4.service"
  ln -sf "${REPO_DIR}/deploy/systemd/beckett-heartbeat.timer" "${UNIT_DIR}/beckett-heartbeat.timer"
  systemctl --user daemon-reload
}

if [ "${START}" -eq 0 ]; then
  stage_units
  echo "beckett-v4 units installed, disabled, and stopped (--no-start)"
  exit 0
fi

# A fresh public install deliberately has no secrets or subscription login. The daemon recognizes
# that state and serves a status-only `healthy-pending-configuration` control socket rather than
# crash-looping. Once configuration is complete, this same start path boots the full daemon.
systemctl --user enable beckett-v4.service
systemctl --user reset-failed beckett-v4.service
if ! systemctl --user restart beckett-v4.service; then
  stage_units
  echo "beckett-v4 failed to restart" >&2
  exit 1
fi

# An immediate is-active can catch a process between crashes. The control socket proves the
# daemon finished booting far enough to answer a real request.
PATH="${HOME}/.local/bin:${HOME}/.bun/bin:${PATH:-/usr/local/bin:/usr/bin:/bin}"
export PATH
READY=0
for _ in $(seq 1 "${BECKETT_START_TIMEOUT_SECS:-45}"); do
  if ! systemctl --user is-active --quiet beckett-v4.service; then
    sleep 1
    continue
  fi
  if [ -x "${HOME}/.local/bin/beckett" ]; then
    STATUS="$("${HOME}/.local/bin/beckett" status 2>/dev/null || true)"
    if [ -n "${STATUS}" ]; then
      READY=1
      break
    fi
  fi
  sleep 1
done

if [ "${READY}" -ne 1 ]; then
  echo "beckett-v4 did not become ready within ${BECKETT_START_TIMEOUT_SECS:-45}s" >&2
  systemctl --user status --no-pager beckett-v4.service >&2 || true
  stage_units
  exit 1
fi

if printf '%s\n' "${STATUS:-}" | grep -q '"state": "healthy-pending-configuration"'; then
  echo "beckett-v4 installed and healthy-pending-configuration"
  exit 0
fi

# Weekly doctor heartbeat (issue #30) - a no-op until DISCORD_ALERT_WEBHOOK_URL is set.
systemctl --user enable --now beckett-heartbeat.timer
echo "beckett-v4 installed and ready"
