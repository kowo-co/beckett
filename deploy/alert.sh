#!/usr/bin/env bash
# Beckett — post a unit-failure alert to Discord via a RAW webhook (issue #30). Deliberately not
# routed through the daemon: this must fire precisely when the daemon is the thing that died.
# 25 daemon starts in 3.5 days and Discord never said a word — this script is the fix.
#
# Two callers:
#   ExecStopPost=%h/beckett/deploy/alert.sh %n            — every stop; silent on clean stops
#   beckett-alert@.service (OnFailure): alert.sh %i terminal — the unit gave up entirely
#
# Env: DISCORD_ALERT_WEBHOOK_URL from the unit's EnvironmentFile (~/.beckett/.env);
#      SERVICE_RESULT/EXIT_CODE/EXIT_STATUS are provided by systemd in ExecStopPost context.
# ALWAYS exits 0 — alerting must never make a unit's stop path fail.
set -u

# Callers pass either the full unit name (%n from ExecStopPost) or the bare instance (%i from
# the template) — normalize to the bare name so stamps/messages/windows agree.
UNIT="${1:-unknown}"; UNIT="${UNIT%.service}"
MODE="${2:-stop}"

# Clean stops (deploys, manual restarts, shutdown) are not alerts.
if [ "${MODE}" = "stop" ] && [ "${SERVICE_RESULT:-success}" = "success" ]; then exit 0; fi

WEBHOOK="${DISCORD_ALERT_WEBHOOK_URL:-}"
[ -z "${WEBHOOK}" ] && exit 0

# Rate limit per unit so a crash loop is one alert a minute, not one per RestartSec. Non-prod
# units are lower-stakes — throttle them much harder.
WINDOW=60
[ "${UNIT}" != "beckett-v4" ] && WINDOW=3600
STAMP="${HOME}/.beckett/alert-${UNIT}.stamp"
NOW="$(date +%s)"
LAST="$(cat "${STAMP}" 2>/dev/null || echo 0)"
[ $((NOW - LAST)) -lt "${WINDOW}" ] && exit 0
mkdir -p "${HOME}/.beckett" && echo "${NOW}" > "${STAMP}"

RESTARTS="$(systemctl --user show -p NRestarts --value "${UNIT}.service" 2>/dev/null || echo '?')"
if [ "${MODE}" = "terminal" ]; then
  TEXT="🔴 loom-desk: ${UNIT} entered FAILED state (crash-looped past the start limit, restarts=${RESTARTS}). It will NOT come back on its own — run: systemctl --user restart ${UNIT}"
else
  TEXT="🟠 loom-desk: ${UNIT} died (result=${SERVICE_RESULT:-?}, exit=${EXIT_CODE:-?}/${EXIT_STATUS:-?}, restarts=${RESTARTS}) — systemd is restarting it"
fi

# TEXT is fully script-controlled and contains no JSON-special characters beyond plain ASCII.
curl -fsS -m 10 -H 'Content-Type: application/json' \
  -d "{\"content\": \"${TEXT}\"}" "${WEBHOOK}" >/dev/null 2>&1 || true
exit 0
