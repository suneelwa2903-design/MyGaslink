#!/usr/bin/env bash
# Anti-pattern #25 guard (2026-07-28) — Mobile bottom-sheet / picker Modal
# regressions.
#
# The class of bug: an in-app <Modal> containing a scrollable body renders
# on top of the OS system nav bar without honoring `useSafeAreaInsets()`
# on Android (RN <Modal> does NOT propagate outer SafeAreaView bottom
# insets). On Samsung with 3-button navigation (still the default) the
# last row of the sheet ends up under the nav bar. Live symptom: S23
# customer-picker in Create Order (2026-07-28).
#
# What this check enforces on every mobile screen file that contains
# both `<Modal` and a scrollable body (`<FlatList` OR `<ScrollView`):
#
#   1. The file imports `useSafeAreaInsets` (so insets can be honored).
#   2. The file uses `keyboardShouldPersistTaps` somewhere.
#
# Whitelist strategy — the check runs in two modes:
#
#   - Files listed in KNOWN_DEBT below are pre-existing violations from
#     before this guard was added. They emit a WARN and do NOT fail the
#     build. As each one is cleaned, remove it from the list.
#   - Files NOT in KNOWN_DEBT MUST pass. This blocks NEW pickers from
#     shipping the same anti-pattern.
#
# Exit 0 = no NEW violations. Exit 1 = at least one new picker regression.

set -euo pipefail

ROOT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/../../.." && pwd )"
cd "$ROOT_DIR"

MOBILE_DIRS=(
  "packages/mobile/app"
  "packages/mobile/src/components"
)

# ─── Known debt (pre-2026-07-28 violations) ─────────────────────────────
# These files were flagged when the guard was introduced. Fix them
# incrementally and delete their line as each is confirmed clean
# (imports useSafeAreaInsets AND uses keyboardShouldPersistTaps).
#
# Order: highest-user-impact first (customer & order flows before admin
# admin pages).
KNOWN_DEBT=(
  # 2026-07-28 cleanup pass — see docs/session commit. False positives
  # dropped (no <Modal> at all, or re-export files, or already compliant):
  #   (admin)/customers.tsx, (super-admin)/customers.tsx,
  #   (super-admin)/provider-catalog.tsx, DateRangeFilter, SignaturePad,
  #   SignaturePad.web (nonexistent), DateInput (iOS-only inline picker),
  #   (driver)/submit-payment (compliant), (finance)/customers (no Modal),
  #   (finance)/pending-payments (re-export).
  #
  # Real remaining debt — remove each entry as its file is fixed and
  # verified in this cleanup pass:
)

is_debt() {
  local f="$1"
  # Normalize backslashes from Git-Bash find output on Windows.
  f="${f//\\//}"
  for a in "${KNOWN_DEBT[@]}"; do
    if [ "$f" = "$a" ]; then return 0; fi
  done
  return 1
}

fail=0
new_warns=0
debt_warns=0

for dir in "${MOBILE_DIRS[@]}"; do
  if [ ! -d "$dir" ]; then continue; fi

  while IFS= read -r file; do
    file="${file//\\//}"
    # Match REAL JSX <Modal> elements only — `<Modal ` (with attrs) or
    # `<Modal>` (no attrs) or `<Modal\n`. Rules out identifiers with a
    # Modal prefix (e.g. <ModalHeader>) that grep -F "<Modal" would match.
    has_modal=$(grep -lE "<Modal( |>|$)" "$file" 2>/dev/null || true)
    if [ -z "$has_modal" ]; then continue; fi
    has_scroll=$(grep -lE "<FlatList( |>|$)|<ScrollView( |>|$)" "$file" 2>/dev/null || true)
    if [ -z "$has_scroll" ]; then continue; fi

    violates=0
    reasons=""
    if ! grep -q "useSafeAreaInsets" "$file"; then
      violates=1
      reasons+="\n    - missing useSafeAreaInsets"
    fi
    if ! grep -q "keyboardShouldPersistTaps" "$file"; then
      violates=1
      reasons+="\n    - missing keyboardShouldPersistTaps"
    fi

    if [ "$violates" -eq 0 ]; then continue; fi

    if is_debt "$file"; then
      debt_warns=$((debt_warns + 1))
      # Only surface the debt list at the end (keeps stdout usable).
    else
      echo "ERROR (anti-pattern #25): $file"
      echo -e "  new violation(s):${reasons}"
      echo "  Fix: import { useSafeAreaInsets } from 'react-native-safe-area-context';"
      echo "       const insets = useSafeAreaInsets();"
      echo "       // contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}"
      echo "       // scrollView.keyboardShouldPersistTaps='handled'"
      fail=1
    fi
  done < <(find "$dir" -type f \( -name "*.ts" -o -name "*.tsx" \))
done

if [ "$fail" -eq 0 ]; then
  echo "Mobile picker check: no NEW violations (${debt_warns} known-debt files pending cleanup)."
fi

exit "$fail"
