#!/usr/bin/env bash
# Seed & install the Beckett [DEV] staging instance on this box. Idempotent — safe to re-run.
# See docs/dev-instance.md for the full operator contract (what you must supply, what stays off).
#
#   - clones/updates a SEPARATE checkout at ~/beckett-dev (never touches prod's ~/beckett),
#   - seeds ~/.beckett-dev/{config.toml,peers.txt,routines.json} from deploy/dev/,
#   - writes ~/.beckett-dev/.env from an operator-supplied token (never printing it), or
#     falls back to prod's ~/.beckett/.env only when that file exists and the var is set,
#   - installs the systemd unit but does NOT enable it (staging is started on demand).
#
# It does NOT start the daemon; see docs/dev-instance.md for start/stop/tail/redeploy.
#
# DISCORD_TOKEN / DISCORD_OWNER_ID sourcing, in precedence order:
#   1. --token-file <path>        (DISCORD_TOKEN, read once, trimmed, never echoed)
#      --owner-id <id>            (DISCORD_OWNER_ID, passed directly)
#   2. $BECKETT_DEV_DISCORD_TOKEN (DISCORD_TOKEN)
#      $DISCORD_OWNER_ID          (DISCORD_OWNER_ID)
#   3. prod's ~/.beckett/.env CALLIE_DISCORD_TOKEN / DISCORD_OWNER_ID, only if that file exists.
#
# Flags:
#   --token-file <path>   read DISCORD_TOKEN from this file (highest precedence).
#   --owner-id <id>       DISCORD_OWNER_ID (highest precedence).
#   --no-secrets          skip writing .env entirely — seeds everything else, needs no token.
#   --dry-run             print every action that would be taken; touch nothing.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROD_ENV="${HOME}/.beckett/.env"
DEV_DIR="${HOME}/.beckett-dev"
DEV_CHECKOUT="${HOME}/beckett-dev"
UNIT_DST="${HOME}/.config/systemd/user/beckett-dev.service"

TOKEN_FILE=""
OWNER_ID_ARG=""
NO_SECRETS=0
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --token-file)
      TOKEN_FILE="${2:-}"
      shift 2
      ;;
    --owner-id)
      OWNER_ID_ARG="${2:-}"
      shift 2
      ;;
    --no-secrets)
      NO_SECRETS=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    *)
      echo "seed: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

run() {
  if [ "${DRY_RUN}" -eq 1 ]; then
    echo "+ $*"
  else
    "$@"
  fi
}

# 1. Separate checkout. Clone from the prod checkout (a local, no-hardlink clone) if absent.
if [ ! -d "${DEV_CHECKOUT}/.git" ]; then
  run git clone --no-hardlinks "${HOME}/beckett" "${DEV_CHECKOUT}"
else
  echo "(exists) ${DEV_CHECKOUT}"
fi
if [ "${DRY_RUN}" -eq 1 ]; then
  echo "+ (cd ${DEV_CHECKOUT} && bun install)"
else
  ( cd "${DEV_CHECKOUT}" && bun install --frozen-lockfile 2>/dev/null || bun install )
fi

# 2. Seed state dir (config / peers / routines). These carry no secrets.
run mkdir -p "${DEV_DIR}" "${DEV_DIR}/projects"
run chmod 700 "${DEV_DIR}"
run cp "${HERE}/config.toml"   "${DEV_DIR}/config.toml"
run cp "${HERE}/peers.txt"     "${DEV_DIR}/peers.txt"
run cp "${HERE}/routines.json" "${DEV_DIR}/routines.json"

# 3. .env — never echo a secret. Resolve DISCORD_TOKEN + DISCORD_OWNER_ID in precedence order.
if [ "${NO_SECRETS}" -eq 1 ]; then
  echo "seeded without .env — write ~/.beckett-dev/.env before starting (see docs/dev-instance.md)"
else
  TOKEN=""
  OWNER_ID=""

  if [ -n "${TOKEN_FILE}" ]; then
    if [ ! -f "${TOKEN_FILE}" ]; then
      echo "seed: --token-file ${TOKEN_FILE} does not exist" >&2
      exit 2
    fi
    TOKEN="$(tr -d '\n\r' < "${TOKEN_FILE}")"
  elif [ -n "${BECKETT_DEV_DISCORD_TOKEN:-}" ]; then
    TOKEN="${BECKETT_DEV_DISCORD_TOKEN}"
  elif [ -f "${PROD_ENV}" ]; then
    TOKEN="$(grep -E '^\s*(export\s+)?CALLIE_DISCORD_TOKEN=' "${PROD_ENV}" 2>/dev/null | tail -1 | sed -E 's/^\s*(export\s+)?CALLIE_DISCORD_TOKEN=//; s/^["'"'"']//; s/["'"'"']\s*$//' || true)"
  fi

  if [ -n "${OWNER_ID_ARG}" ]; then
    OWNER_ID="${OWNER_ID_ARG}"
  elif [ -n "${DISCORD_OWNER_ID:-}" ]; then
    OWNER_ID="${DISCORD_OWNER_ID}"
  elif [ -f "${PROD_ENV}" ]; then
    OWNER_ID="$(grep -E '^\s*(export\s+)?DISCORD_OWNER_ID=' "${PROD_ENV}" 2>/dev/null | tail -1 | sed -E 's/^\s*(export\s+)?DISCORD_OWNER_ID=//; s/^["'"'"']//; s/["'"'"']\s*$//' || true)"
  fi

  if [ -z "${TOKEN}" ] || [ -z "${OWNER_ID}" ]; then
    echo "seed: no DISCORD_TOKEN/DISCORD_OWNER_ID source resolved. Supply one of:" >&2
    echo "  1. --token-file <path> --owner-id <id>" >&2
    echo "  2. \$BECKETT_DEV_DISCORD_TOKEN and \$DISCORD_OWNER_ID" >&2
    echo "  3. a prod ~/.beckett/.env with CALLIE_DISCORD_TOKEN and DISCORD_OWNER_ID" >&2
    echo "or pass --no-secrets to seed everything else and supply .env by hand later." >&2
    exit 2
  fi

  if [ "${DRY_RUN}" -eq 1 ]; then
    echo "+ write ${DEV_DIR}/.env (DISCORD_TOKEN, DISCORD_OWNER_ID, GITHUB_PAT)"
  else
    umask 077
    {
      printf '# Beckett [DEV] staging secrets — machine-seeded by deploy/dev/seed.sh. Do not commit.\n'
      printf 'DISCORD_TOKEN=%s\n' "${TOKEN}"
      printf 'DISCORD_OWNER_ID=%s\n' "${OWNER_ID}"
      printf 'GITHUB_PAT=disabled-in-dev-staging\n'
    } > "${DEV_DIR}/.env"
    chmod 600 "${DEV_DIR}/.env"
  fi
  unset TOKEN OWNER_ID
fi

# 4. Install the unit (NOT enabled — on-demand only).
run mkdir -p "$(dirname "${UNIT_DST}")"
run cp "${HERE}/../systemd/beckett-dev.service" "${UNIT_DST}"
if command -v systemctl >/dev/null 2>&1; then
  run systemctl --user daemon-reload
else
  echo "(no systemctl on this box — skipping daemon-reload)"
fi

if [ "${DRY_RUN}" -eq 1 ]; then
  echo "dry run: would seed ~/.beckett-dev and install beckett-dev.service (not enabled)."
else
  echo "seeded ~/.beckett-dev and installed beckett-dev.service (not enabled)."
  echo "start it with:  systemctl --user start beckett-dev"
fi
