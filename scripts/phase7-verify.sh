#!/usr/bin/env bash
# Phase 7 verify — cutover sanity checks.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
FAIL=0
ok()   { echo "✓ $*"; }
fail() { echo "✗ $*"; FAIL=1; }

# 1. modes.ts and orchestration/ both gone.
if [ ! -e extensions/modes.ts ] && [ ! -d extensions/orchestration ]; then
  ok "extensions/modes.ts and extensions/orchestration/ are gone"
else
  fail "modes.ts or orchestration/ still present"
fi

# 2. No stale ../orchestration imports.
if [ "$(grep -rEn 'from "\.\./(.*/)?orchestration' extensions/ 2>/dev/null | wc -l | tr -d ' ')" = "0" ]; then
  ok "no stale ../orchestration imports"
else
  echo "stale imports:"
  grep -rEn 'from "\.\./(.*/)?orchestration' extensions/ 2>/dev/null
  fail "stale ../orchestration imports remain"
fi

# 3. defaultAgent rename complete in tracked settings*.json (if any).
SETTINGS_FILES=$(find . -name 'settings*.json' -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null)
if [ -z "$SETTINGS_FILES" ]; then
  ok "no tracked settings*.json files (rename check vacuously passes)"
else
  HITS=$(grep -wn 'defaultAgent' $SETTINGS_FILES 2>/dev/null | grep -v defaultPrimaryAgent || true)
  if [ -z "$HITS" ]; then
    ok "no bare 'defaultAgent' in tracked settings*.json"
  else
    echo "$HITS"
    fail "bare 'defaultAgent' still present in tracked settings*.json"
  fi
fi

# 4. Every agents/*.md declares mode: + (subagent|all) → has description:.
for f in agents/*.md; do
  [ -e "$f" ] || continue
  if ! grep -Eq '^mode:[[:space:]]*(primary|subagent|all)[[:space:]]*$' "$f"; then
    fail "$f: missing mode: declaration"
    continue
  fi
  if grep -Eq '^mode:[[:space:]]*(subagent|all)[[:space:]]*$' "$f"; then
    if ! grep -q '^description:' "$f"; then
      fail "$f: subagent/all missing description:"
    else
      ok "$f: mode + description ok"
    fi
  else
    ok "$f: mode ok"
  fi
done

# 5. No transitional flags in code.
if [ "$(grep -rEn 'agents\.enabled|tasks\.enabled' extensions/ 2>/dev/null | wc -l | tr -d ' ')" = "0" ]; then
  ok "no agents.enabled / tasks.enabled gates in extensions/"
else
  grep -rEn 'agents\.enabled|tasks\.enabled' extensions/ 2>/dev/null
  fail "transitional enabled flags still referenced"
fi

# 6. build + invariants.
if bash scripts/check-build.sh > /dev/null 2>&1; then ok "check-build.sh"; else fail "check-build.sh"; fi
if bash scripts/check-invariants.sh > /dev/null 2>&1; then ok "check-invariants.sh"; else fail "check-invariants.sh"; fi

if [ "$FAIL" -eq 0 ]; then
  echo "phase7-verify: PASS"
  exit 0
fi
echo "phase7-verify: FAIL"
exit 1
