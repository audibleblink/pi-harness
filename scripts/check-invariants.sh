#!/bin/bash
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
FAIL=0

check() {
  local desc="$1"
  local count="$2"
  local expected="$3"
  if [ "$count" -eq "$expected" ]; then
    echo "✓ $desc ($count matches, expected $expected)"
  else
    echo "✗ $desc ($count matches, expected $expected)"
    FAIL=1
  fi
}

# DoD #1: No TUI chrome calls outside extensions/ui/
check "setStatus outside ui/" "$(rg -l 'setStatus\(' extensions/ -g '*.ts' | grep -v '^extensions/ui/' | wc -l | tr -d ' ')" "0"
check "setWidget outside ui/" "$(rg -l 'setWidget\(' extensions/ -g '*.ts' | grep -v '^extensions/ui/' | wc -l | tr -d ' ')" "0"
check "setFooter outside ui/" "$(rg -l 'setFooter\(' extensions/ -g '*.ts' | grep -v '^extensions/ui/' | wc -l | tr -d ' ')" "0"
check "setWorkingMessage outside ui/" "$(rg -l 'setWorkingMessage\(' extensions/ -g '*.ts' | grep -v '^extensions/ui/' | wc -l | tr -d ' ')" "0"
check "setWorkingIndicator outside ui/" "$(rg -l 'setWorkingIndicator\(' extensions/ -g '*.ts' | grep -v '^extensions/ui/' | wc -l | tr -d ' ')" "0"
check "setEditorComponent outside ui/" "$(rg -l 'setEditorComponent\(' extensions/ -g '*.ts' | grep -v '^extensions/ui/' | wc -l | tr -d ' ')" "0"

# DoD #2: No bare subagents:* event names (in emit/on calls, not comments)
check "subagents: event names in emit/on" "$(rg -c "(emit|on)\(['\"]subagents:" extensions/ -g '*.ts' 2>/dev/null | wc -l | tr -d ' ')" "0"

# Allowed event names (P3 introduces agents:subagent_end emitted by extensions/agents/).
# Keep this list current; new event names must be added explicitly.
# Allowed: agents:subagent_end

# DoD #3: Symbol.for pi-subagents
check "Symbol.for pi-subagents" "$(rg -l 'Symbol\.for\("pi-subagents:' extensions/ -g '*.ts' 2>/dev/null | wc -l | tr -d ' ')" "0"

# DoD #4: agentTaskMap in exactly one file
ATM_COUNT=$(rg -l 'agentTaskMap' extensions/ -g '*.ts' 2>/dev/null | wc -l | tr -d ' ')
check "agentTaskMap in exactly one file" "$ATM_COUNT" "1"

# DoD #5: Old dirs/files gone
check "pi-subagents dir gone" "$(ls -d extensions/pi-subagents 2>/dev/null | wc -l | tr -d ' ')" "0"
check "pi-tasks dir gone" "$(ls -d extensions/pi-tasks 2>/dev/null | wc -l | tr -d ' ')" "0"
check "zentui.ts gone" "$(ls extensions/zentui.ts 2>/dev/null | wc -l | tr -d ' ')" "0"
check "working-messages.ts gone" "$(ls extensions/working-messages.ts 2>/dev/null | wc -l | tr -d ' ')" "0"
check "_debug.ts gone" "$(ls extensions/_debug.ts 2>/dev/null | wc -l | tr -d ' ')" "0"

# setInterval audit (informational)
echo ""
echo "=== setInterval audit (informational) ==="
rg -n 'setInterval\(' extensions/ -g '*.ts' || true
echo "  Expected:"
echo "    extensions/ui/ticker.ts          — animation ticker (80ms, widget animation)"
echo "    extensions/orchestration/agent-manager.ts — 60s GC cleanup (non-animation)"
echo "    extensions/orchestration/index.ts — foreground spinner during spawnAndWait (non-animation, cleared immediately)"

# setTitle audit (informational — allowed outside ui/, just noted)
echo ""
echo "=== setTitle audit (informational) ==="
rg -n 'setTitle\(' extensions/ -g '*.ts' || echo "  (none)"

if [ "$FAIL" -eq 1 ]; then
  echo ""
  echo "INVARIANT CHECK FAILED"
  exit 1
else
  echo ""
  echo "All invariants passed ✓"
fi
