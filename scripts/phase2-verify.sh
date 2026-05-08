#!/usr/bin/env bash
# Phase 2 verifier — extensions/agents/ skeleton (loader, primary, cycling).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

FAIL=0
ok()   { echo "✓ $1"; }
fail() { echo "✗ $1"; FAIL=1; }

# 1. All six new files exist; publishMode is referenced from agents/.
for f in index.ts loader.ts primary.ts commands.ts cycling.ts bus.ts; do
  if [ -f "extensions/agents/$f" ]; then ok "extensions/agents/$f exists"
  else fail "missing extensions/agents/$f"; fi
done
PM=$( { rg -c "publishMode" extensions/agents/ 2>/dev/null || true; } | awk -F: '{s+=$2} END{print s+0}')
if [ "$PM" -ge 1 ]; then ok "publishMode referenced ($PM)"; else fail "publishMode not referenced in extensions/agents/"; fi

# 2. modes.ts short-circuit installed.
M=$( { rg -n "agents\.enabled|agents\?\.enabled" extensions/modes.ts || true; } | wc -l | tr -d ' ')
if [ "$M" -ge 1 ]; then ok "modes.ts has agents.enabled short-circuit ($M hits)"
else fail "modes.ts missing agents.enabled short-circuit"; fi

# 3. No TUI chrome calls inside extensions/agents/.
C=$( { rg -n "setStatus|setWidget|setFooter|setWorkingMessage|setWorkingIndicator|setEditorComponent" extensions/agents/ 2>/dev/null || true; } | wc -l | tr -d ' ')
if [ "$C" -eq 0 ]; then ok "no TUI chrome calls in extensions/agents/"
else fail "TUI chrome calls leaked into extensions/agents/ ($C)"; fi

# 4. cycling.ts binds Tab and registers switch_agent.
T=$( { rg -n 'switch_agent|"Tab"|Key\.tab|key:\s*"Tab"' extensions/agents/cycling.ts || true; } | wc -l | tr -d ' ')
if [ "$T" -ge 2 ]; then ok "cycling.ts binds Tab + switch_agent ($T hits)"
else fail "cycling.ts missing Tab/switch_agent bindings ($T hits, expected ≥2)"; fi

# 5. Build check.
if bash scripts/check-build.sh >/dev/null 2>&1; then ok "check-build.sh passes"
else fail "check-build.sh failed"; bash scripts/check-build.sh; fi

# 6. Smoke step: harness scaffolding for `agents-primary` is non-trivial and
#    out of scope for Phase 2 (per plan: do not block on missing scaffolding).
#    Manual checklist below; exit 0 with a clear message.
echo ""
echo "smoke (agents-primary) — MANUAL until smoke harness lands:"
echo "  1. set { \"agents\": { \"enabled\": true } } in ~/.config/pi/agent/settings.json"
echo "  2. start pi; run /agent — selector lists primary agents"
echo "  3. press Tab and Ctrl+Shift+M — each publishes a 'mode' slot update"
echo "  4. add a settings.json \"agent\": {...} JSON entry — appears in cycle and overrides same-named markdown"

if [ "$FAIL" -eq 1 ]; then echo ""; echo "PHASE 2 VERIFY FAILED"; exit 1; fi
echo ""; echo "All Phase 2 checks passed ✓"
