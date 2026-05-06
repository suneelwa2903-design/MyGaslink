#!/bin/bash
# ADLC Framework — Telegram Alert Script
# Usage: ./telegram.sh "Your message here"
# Env vars required: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
# Optional: PROJECT_NAME (defaults to directory name)

BOT_TOKEN="${TELEGRAM_BOT_TOKEN}"
CHAT_ID="${TELEGRAM_CHAT_ID}"
MESSAGE="$1"
PROJECT="${PROJECT_NAME:-$(basename $(pwd))}"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

if [ -z "$BOT_TOKEN" ] || [ -z "$CHAT_ID" ]; then
  echo "ERROR: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set"
  exit 1
fi

if [ -z "$MESSAGE" ]; then
  echo "ERROR: No message provided"
  exit 1
fi

FULL_MESSAGE="[${PROJECT}] ${TIMESTAMP}
${MESSAGE}"

RESPONSE=$(curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  -d chat_id="${CHAT_ID}" \
  -d text="${FULL_MESSAGE}" \
  -d parse_mode="HTML")

if echo "$RESPONSE" | grep -q '"ok":true'; then
  echo "Alert sent: ${MESSAGE}"
else
  echo "Failed to send alert: ${RESPONSE}"
  exit 1
fi
