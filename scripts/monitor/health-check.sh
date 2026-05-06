#!/bin/bash
# ADLC Framework — Infrastructure Health Check
# Runs on cron every 5 minutes. Alerts via Telegram only on failure.
# Configure via .env.monitor in project root

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALERT="${SCRIPT_DIR}/../alerts/telegram.sh"
ENV_FILE="${SCRIPT_DIR}/../../.env.monitor"

# Load environment config
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

ERRORS=0
WARNINGS=0

# ─── 1. API Health Check ───────────────────────────────────────────
if [ -n "$SERVICE_URL" ]; then
  RESPONSE=$(curl -s -o /dev/null -w "%{http_code} %{time_total}" \
    --max-time 5 "${SERVICE_URL}/health" 2>/dev/null)
  HTTP_CODE=$(echo "$RESPONSE" | awk '{print $1}')
  LATENCY=$(echo "$RESPONSE" | awk '{print $2}')

  if [ "$HTTP_CODE" != "200" ]; then
    $ALERT "🔴 API DOWN — ${SERVICE_URL} returned HTTP ${HTTP_CODE}"
    ERRORS=$((ERRORS + 1))
  elif (( $(echo "$LATENCY > 2.0" | bc -l 2>/dev/null || echo 0) )); then
    $ALERT "⚠️ API SLOW — ${SERVICE_URL} latency: ${LATENCY}s (threshold: 2s)"
    WARNINGS=$((WARNINGS + 1))
  fi
fi

# ─── 2. PostgreSQL Check ───────────────────────────────────────────
if [ -n "$DB_HOST" ]; then
  if command -v pg_isready &>/dev/null; then
    if ! pg_isready -h "$DB_HOST" -p "${DB_PORT:-5432}" -q 2>/dev/null; then
      $ALERT "🔴 DATABASE UNREACHABLE — ${DB_HOST}:${DB_PORT:-5432}"
      ERRORS=$((ERRORS + 1))
    fi
  fi
fi

# ─── 3. Redis Check ────────────────────────────────────────────────
if [ -n "$REDIS_HOST" ]; then
  if command -v redis-cli &>/dev/null; then
    if ! redis-cli -h "$REDIS_HOST" -p "${REDIS_PORT:-6379}" ping > /dev/null 2>&1; then
      $ALERT "🔴 REDIS UNREACHABLE — ${REDIS_HOST}:${REDIS_PORT:-6379}"
      ERRORS=$((ERRORS + 1))
    fi
  fi
fi

# ─── 4. Disk Usage ─────────────────────────────────────────────────
DISK_USAGE=$(df / | awk 'NR==2 {gsub(/%/, "", $5); print $5}')
THRESHOLD="${DISK_THRESHOLD:-80}"
CRITICAL_THRESHOLD="${DISK_CRITICAL:-90}"

if [ "$DISK_USAGE" -gt "$CRITICAL_THRESHOLD" ]; then
  $ALERT "🔴 DISK CRITICAL — ${DISK_USAGE}% used (critical threshold: ${CRITICAL_THRESHOLD}%)"
  ERRORS=$((ERRORS + 1))
elif [ "$DISK_USAGE" -gt "$THRESHOLD" ]; then
  $ALERT "⚠️ DISK HIGH — ${DISK_USAGE}% used (threshold: ${THRESHOLD}%)"
  WARNINGS=$((WARNINGS + 1))
fi

# ─── 5. Memory Check ───────────────────────────────────────────────
if command -v free &>/dev/null; then
  MEM_USAGE=$(free | awk '/Mem:/ {printf "%.0f", $3/$2 * 100}')
  MEM_THRESHOLD="${MEM_THRESHOLD:-90}"
  if [ "$MEM_USAGE" -gt "$MEM_THRESHOLD" ]; then
    $ALERT "⚠️ MEMORY HIGH — ${MEM_USAGE}% used (threshold: ${MEM_THRESHOLD}%)"
    WARNINGS=$((WARNINGS + 1))
  fi
fi

# ─── 6. Process Check (optional) ───────────────────────────────────
if [ -n "$REQUIRED_PROCESS" ]; then
  if ! pgrep -f "$REQUIRED_PROCESS" > /dev/null 2>&1; then
    $ALERT "🔴 PROCESS DOWN — ${REQUIRED_PROCESS} not running"
    ERRORS=$((ERRORS + 1))
  fi
fi

# ─── Summary ───────────────────────────────────────────────────────
LOG_DIR="${SCRIPT_DIR}/../../logs/monitor"
mkdir -p "$LOG_DIR"
echo "$(date): errors=${ERRORS} warnings=${WARNINGS}" >> "${LOG_DIR}/health.log"

if [ "$ERRORS" -gt 0 ]; then
  exit 1
fi

exit 0
