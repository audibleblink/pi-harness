#!/usr/bin/env bash
# Phase 3 verifier — subagent tools moved into extensions/agents/.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

FAIL=0
ok()   { echo "✓ $1"; }
fail() { echo "✗ $1"; FAIL=1; }

# 1. Agent tool registered in agents/subagent-tools.ts.
N=$( { rg -nl "name: \"Agent\"|name: 'Agent'" extensions/agents/subagent-tools.ts 2>/dev/null || true; } | wc -l | tr -d ' ')
if [ "$N" -eq 1 ]; then ok "Agent tool registered in extensions/agents/subagent-tools.ts"
else fail "Agent tool not found in extensions/agents/subagent-tools.ts ($N)"; fi

# 2. orchestration/index.ts gates Agent registration on agents.enabled — guard precedes registration within 30 lines.
if awk '
  /if \(!settings\.agents\?\.enabled\)/ { if (guard == 0) guard = NR }
  /name: "Agent"/                       { if (found == 0 && guard > 0) found = NR }
  END {
    if (guard > 0 && found > 0 && found - guard > 0 && found - guard < 30) exit 0;
    else exit 1;
  }
' extensions/orchestration/index.ts; then
  ok "orchestration/index.ts: agents.enabled guard precedes Agent registration within 30 lines"
else
  fail "orchestration/index.ts: agents.enabled guard missing or too far from Agent registration"
fi

# 3. agents:subagent_end emitted from runner + listed in lifecycle-events + invariants.
H=$( { rg -n "agents:subagent_end" extensions/agents/lifecycle-events.ts extensions/agents/subagent-runner.ts scripts/check-invariants.sh 2>/dev/null || true; } | wc -l | tr -d ' ')
if [ "$H" -ge 3 ]; then ok "agents:subagent_end referenced in 3 required locations ($H hits)"
else fail "agents:subagent_end missing in lifecycle-events / subagent-runner / check-invariants ($H hits)"; fi

# 4. New files exist; no TUI chrome leaked into agents/.
for f in subagent-tools.ts subagent-runner.ts subagent-bus.ts lifecycle-events.ts; do
  if [ -f "extensions/agents/$f" ]; then ok "extensions/agents/$f exists"
  else fail "missing extensions/agents/$f"; fi
done
C=$( { rg -n "setStatus|setWidget|setFooter|setWorkingMessage|setWorkingIndicator|setEditorComponent" extensions/agents/ 2>/dev/null || true; } | wc -l | tr -d ' ')
if [ "$C" -eq 0 ]; then ok "no TUI chrome calls in extensions/agents/"
else fail "TUI chrome calls leaked into extensions/agents/ ($C)"; fi

# 5. Build + invariants.
if bash scripts/check-build.sh >/dev/null 2>&1; then ok "check-build.sh passes"
else fail "check-build.sh failed"; bash scripts/check-build.sh; fi
if bash scripts/check-invariants.sh >/dev/null 2>&1; then ok "check-invariants.sh passes"
else fail "check-invariants.sh failed"; bash scripts/check-invariants.sh; fi

# Smoke: harness scaffolding for agents-spawn is non-trivial — manual checklist.
echo ""
echo "smoke (agents-spawn) — MANUAL until smoke harness lands:"
echo "  1. set { \"agents\": { \"enabled\": true } } in ~/.config/pi/agent/settings.json"
echo "  2. start pi; spawn a no-op subagent via the Agent tool"
echo "  3. verify orchestration + subagentUsage UIBus slots receive ≥1 publish each"
echo "  4. verify agents:subagent_end fires within 10s"

if [ "$FAIL" -eq 1 ]; then echo ""; echo "PHASE 3 VERIFY FAILED"; exit 1; fi
echo ""; echo "All Phase 3 checks passed ✓"
