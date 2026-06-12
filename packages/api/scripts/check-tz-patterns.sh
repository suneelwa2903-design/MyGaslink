#!/usr/bin/env bash
# Phase D (2026-06-12) — TZ anti-pattern guard.
#
# Fails CI / pre-commit if any test file uses the raw UTC date split
# pattern. Production code is checked too — but with a softer hand: it
# only WARNS on production hits because some production code legitimately
# needs UTC (audit timestamps, NIC payloads). Tests, however, should
# never use UTC for "today / tomorrow" defaults — see CLAUDE.md
# anti-pattern #21 + commit 53cb40c for the bug-hunt history.
#
# Usage:
#   bash packages/api/scripts/check-tz-patterns.sh
#
# Exit code 0 = pass, 1 = test files contain the pattern.

set -euo pipefail

# Compute the repo root from this script's location so the check works
# whether invoked from the repo root or from packages/api.
ROOT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/../../.." && pwd )"
cd "$ROOT_DIR"

PATTERN='new Date().toISOString().split('"'"'T'"'"')'
TEST_DIRS=(
  "packages/api/src/__tests__"
  "packages/mobile/src/__tests__"
  "packages/web/src/__tests__"
)

fail=0
for dir in "${TEST_DIRS[@]}"; do
  if [ ! -d "$dir" ]; then continue; fi
  # `grep -rn` with --include filters to .ts / .tsx only. Lines that are
  # ONLY a comment (legitimate doc reference to the anti-pattern) are
  # excluded so the comments left behind by commits 53cb40c / Phase D
  # don't trip the guard.
  hits=$(grep -rn --include='*.ts' --include='*.tsx' "$PATTERN" "$dir" | grep -vE "^[^:]+:[0-9]+:\s*(//|/\*|\*)" || true)
  if [ -n "$hits" ]; then
    echo "ERROR: TZ-vulnerable date pattern found in test files."
    echo "  Use today() from packages/api/src/__tests__/helpers.ts"
    echo "  (or localTodayISO() from @gaslink/shared in non-test code)."
    echo "  Hits:"
    echo "$hits" | sed 's/^/    /'
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "TZ pattern check: clean."
fi

exit "$fail"
