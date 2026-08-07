#!/usr/bin/env bash
# Anti-pattern #21 guard — UTC date drift between 00:00–05:30 IST.
#
# Originally landed (Phase D, 2026-06-12) covering only api test files.
# Extended (2026-06-25, this commit) to sweep web + mobile source files
# AND api source files after the dispatch-no-op bug surfaced live (an
# admin clicked Add-to-Trip just past midnight IST, the modal sent
# yesterday's UTC date, preflight returned zero orders, silent no-op).
#
# Two pattern variants are banned:
#   new Date().toISOString().split('T')[0]
#   new Date().toISOString().slice(0, 10)
# Both return the UTC calendar date and lag one day behind IST for the
# 5.5h window after midnight local. Replace with localTodayISO() (no
# args) or localDateISO(d) (when you already have a Date instance) from
# @gaslink/shared.
#
# Lines that are pure comments are excluded so historical doc references
# to the anti-pattern don't trip the guard.
#
# Patterns derived from a *mutated* / two-statement `new Date()` (e.g.
#     const d = new Date();
#     const s = d.toISOString().split('T')[0];
# ) are NOT matched by the line-oriented regexes below — they need
# variable-level analysis. That gap was left "to code review" and it bit
# for real: customerService.importOpeningBalances shipped exactly that
# shape. It is now covered by check-tz-twoline.mjs, invoked at the end of
# this script (Node, because `grep -P` backreferences are unavailable in
# the Git Bash build on the dev machines).
#
# Exit 0 = clean. Exit 1 = pattern found.

set -euo pipefail

ROOT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/../../.." && pwd )"
cd "$ROOT_DIR"

PATTERNS=(
  "new Date().toISOString().split('T')"
  "new Date().toISOString().slice(0, 10)"
  "new Date().toISOString().slice(0,10)"
)

# Where to look. Source dirs scoped to TS/TSX files. Tests already get
# the same treatment under packages/api/src/__tests__ (legacy scope).
SCOPED_DIRS=(
  # API
  "packages/api/src"
  # Web
  "packages/web/src"
  # Mobile (expo-router pages live under app/, shared screens under src/)
  "packages/mobile/app"
  "packages/mobile/src"
)

# Files that are allowed to keep the pattern. Keep this set TINY and
# justify every entry inline. Right now we don't need any.
ALLOWLIST_REGEX=""

fail=0
for dir in "${SCOPED_DIRS[@]}"; do
  if [ ! -d "$dir" ]; then continue; fi
  for pattern in "${PATTERNS[@]}"; do
    raw_hits=$(grep -rn --include='*.ts' --include='*.tsx' -F "$pattern" "$dir" || true)
    if [ -z "$raw_hits" ]; then continue; fi
    # Drop comment-only lines (// or /* or *) so historical doc references
    # to the anti-pattern don't trip the guard.
    hits=$(echo "$raw_hits" | grep -vE "^[^:]+:[0-9]+:\s*(//|/\*|\*)" || true)
    if [ -n "$ALLOWLIST_REGEX" ] && [ -n "$hits" ]; then
      hits=$(echo "$hits" | grep -vE "$ALLOWLIST_REGEX" || true)
    fi
    if [ -n "$hits" ]; then
      echo "ERROR (anti-pattern #21): UTC date drift in $dir"
      echo "  pattern: $pattern"
      echo "  fix: use localTodayISO() or localDateISO(d) from @gaslink/shared"
      echo "  hits:"
      echo "$hits" | sed 's/^/    /'
      fail=1
    fi
  done
done

if [ "$fail" -eq 0 ]; then
  echo "TZ pattern check: clean."
fi

# Second pass — the two-statement form this script's regexes cannot see.
if ! node "$ROOT_DIR/packages/api/scripts/check-tz-twoline.mjs"; then
  fail=1
fi

exit "$fail"
