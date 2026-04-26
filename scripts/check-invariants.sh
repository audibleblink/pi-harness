#!/usr/bin/env bash
# Phase 0 baseline: runs PRD §6 DoD greps. Allowed to fail; prints results.
set -uo pipefail

REPO="/Users/blink/Code/pi-harness"
PASS=0
FAIL=0

check() {
  local desc="$1"
  local result
  if result=$(eval "$2" 2>&1); then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc"
    [ -n "$result" ] && echo "        $result"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== PRD §6 DoD invariant checks ==="

# No direct setFooter calls outside zentui — check count is 0
check "setFooter only in zentui.ts" \
  '[ "$(grep -rn "setFooter" '"$REPO"'/extensions --include="*.ts" | grep -cv "zentui.ts")" -eq 0 ]'

# No direct setEditorComponent calls outside zentui — check count is 0
check "setEditorComponent only in zentui.ts" \
  '[ "$(grep -rn "setEditorComponent" '"$REPO"'/extensions --include="*.ts" | grep -cv "zentui.ts")" -eq 0 ]'

# _debug.ts exists
check "_debug.ts exists" \
  "test -f '$REPO/extensions/_debug.ts'"

check "zentui.ts imports _debug" \
  "grep -q 'from.*_debug' '$REPO/extensions/zentui.ts'"

check "modes.ts imports _debug" \
  "grep -q 'from.*_debug' '$REPO/extensions/modes.ts'"

check "pi-undo-redo.ts imports _debug" \
  "grep -q 'from.*_debug' '$REPO/extensions/pi-undo-redo.ts'"

echo ""
echo "Results: $PASS passed, $FAIL failed (allowed to fail in Phase 0)"
exit 0
