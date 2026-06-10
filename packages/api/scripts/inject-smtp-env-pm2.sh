#!/usr/bin/env bash
# Group B Part 2 — SMTP env injection on prod EC2.
#
# Reads the Gmail app password from stdin (no echo, never argv, never history).
# Writes seven SMTP_*/WEB_APP_URL lines into /etc/environment and PM2's process
# env so the running gaslink-api picks them up immediately AND survives reboot.
#
# Run on EC2 only:
#     ssh gaslink-prod
#     bash ~/inject-smtp-env-pm2.sh
#
# The script asks for the app password at the prompt. Nothing is echoed.
#
# After it exits 0:
#   - /etc/environment has the seven new lines
#   - pm2 process 0 (gaslink-api) has them in its env
#   - SMTP_PASS is masked in the final verification print as
#     length=<N> sha256=<first16hex>… so a screenshot is safe.
set -euo pipefail

ENVFILE="/etc/environment"
PM2_PROC="gaslink-api"

# ─── Defaults — overridable via env before invoke ────────────────────────────
SMTP_HOST="${SMTP_HOST:-smtp.gmail.com}"
SMTP_PORT="${SMTP_PORT:-587}"
SMTP_USER="${SMTP_USER:-info@mygaslink.com}"
SMTP_FROM="${SMTP_FROM:-info@mygaslink.com}"
SMTP_FROM_NAME="${SMTP_FROM_NAME:-MyGasLink}"
WEB_APP_URL="${WEB_APP_URL:-https://mygaslink.com}"

echo "── Group B Part 2 — SMTP env injection ──"
echo "  Host         : ${SMTP_HOST}"
echo "  Port         : ${SMTP_PORT}"
echo "  User         : ${SMTP_USER}"
echo "  From         : ${SMTP_FROM}"
echo "  From name    : ${SMTP_FROM_NAME}"
echo "  WEB_APP_URL  : ${WEB_APP_URL}"
echo

if [[ ! -w "${ENVFILE}" && ! -O "${ENVFILE}" ]]; then
  if ! sudo -n true 2>/dev/null; then
    echo "❌  ${ENVFILE} needs sudo. Re-run with sudo cached: \`sudo -v && bash $0\`"
    exit 1
  fi
fi

# Read the app password silently. No echo, no argv leak.
read -r -s -p "Paste Gmail app password (16 chars, no spaces) then Enter: " SMTP_PASS
echo
if [[ -z "${SMTP_PASS}" ]]; then
  echo "❌  empty password — aborting"
  exit 1
fi

# ─── Write to /etc/environment ──────────────────────────────────────────────
write_env_line() {
  local key="$1" val="$2"
  # Remove any existing line for this key, then append the new one.
  sudo sed -i "/^${key}=/d" "${ENVFILE}"
  # Single-quote-wrap so app passwords with special chars don't get mangled
  # by the shell. /etc/environment is read by PAM and a couple of init paths;
  # both accept quoted values.
  echo "${key}=\"${val}\"" | sudo tee -a "${ENVFILE}" > /dev/null
}

write_env_line SMTP_HOST       "${SMTP_HOST}"
write_env_line SMTP_PORT       "${SMTP_PORT}"
write_env_line SMTP_USER       "${SMTP_USER}"
write_env_line SMTP_PASS       "${SMTP_PASS}"
write_env_line SMTP_FROM       "${SMTP_FROM}"
write_env_line SMTP_FROM_NAME  "${SMTP_FROM_NAME}"
write_env_line WEB_APP_URL     "${WEB_APP_URL}"

# ─── Reload PM2 env ─────────────────────────────────────────────────────────
# `pm2 restart --update-env` re-reads the shell env of THIS bash, so we must
# source the freshly-written /etc/environment first.
set -a
# shellcheck disable=SC1091
source "${ENVFILE}"
set +a

pm2 restart "${PM2_PROC}" --update-env >/dev/null
pm2 save >/dev/null

# ─── Verify + masked print ──────────────────────────────────────────────────
echo
echo "── Verification (PM2 env, SMTP_PASS masked) ──"
PASS_LEN=$(printf %s "${SMTP_PASS}" | wc -c | tr -d ' ')
PASS_FP=$(printf %s "${SMTP_PASS}" | sha256sum | awk '{print $1}' | cut -c1-16)

pm2 env 0 | grep -E "^(SMTP_|WEB_APP_URL)" | while IFS= read -r line; do
  if [[ "${line}" == SMTP_PASS=* ]]; then
    echo "SMTP_PASS=<masked> length=${PASS_LEN} sha256=${PASS_FP}…"
  else
    echo "${line}"
  fi
done

# ─── Clear plaintext from this bash's memory ────────────────────────────────
unset SMTP_PASS
unset PASS_LEN
unset PASS_FP

echo
echo "✅  Done. Now run the SMTP test from /opt/gaslink:"
echo "    cd /opt/gaslink && pnpm --filter @gaslink/api tsx scripts/test-smtp.ts"
echo "    Then check info@mygaslink.com inbox for the 'SMTP Test — MyGasLink' message."
