#!/bin/bash
# ADLC Framework — Cron Runner with Telegram Alerting
# Usage: ./cron-runner.sh "job-name" "command"
# Example: ./cron-runner.sh "gst-daily-report" "python manage.py generate_gst_report"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALERT="${SCRIPT_DIR}/../alerts/telegram.sh"
ENV_FILE="${SCRIPT_DIR}/../../.env.monitor"

if [ -f "$ENV_FILE" ]; then
  set -a; source "$ENV_FILE"; set +a
fi

JOB_NAME="${1:-unknown-job}"
COMMAND="$2"
ALERT_ON_SUCCESS="${ALERT_ON_SUCCESS:-false}"

if [ -z "$COMMAND" ]; then
  echo "ERROR: No command provided"
  echo "Usage: $0 'job-name' 'command to run'"
  exit 1
fi

LOG_DIR="${SCRIPT_DIR}/../../logs/crons"
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/${JOB_NAME}-$(date +%Y%m%d).log"
START_TIME=$(date +%s)

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >> "$LOG_FILE"
echo "START: $(date)" >> "$LOG_FILE"
echo "JOB:   ${JOB_NAME}" >> "$LOG_FILE"
echo "CMD:   ${COMMAND}" >> "$LOG_FILE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >> "$LOG_FILE"

eval "$COMMAND" >> "$LOG_FILE" 2>&1
EXIT_CODE=$?

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >> "$LOG_FILE"
echo "END:      $(date)" >> "$LOG_FILE"
echo "DURATION: ${DURATION}s" >> "$LOG_FILE"
echo "STATUS:   $([ $EXIT_CODE -eq 0 ] && echo SUCCESS || echo FAILED)" >> "$LOG_FILE"

if [ $EXIT_CODE -ne 0 ]; then
  # Get last 5 lines of log for context
  TAIL=$(tail -8 "$LOG_FILE" | head -5)
  $ALERT "🔴 CRON FAILED — <b>${JOB_NAME}</b>
Exit code: ${EXIT_CODE} | Duration: ${DURATION}s
Last output:
<code>${TAIL}</code>"
  exit $EXIT_CODE
fi

if [ "$ALERT_ON_SUCCESS" = "true" ]; then
  $ALERT "✅ CRON OK — ${JOB_NAME} completed in ${DURATION}s"
fi

exit 0
