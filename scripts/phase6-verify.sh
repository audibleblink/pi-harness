#!/usr/bin/env bash
# phase6-verify.sh — verify Phase 6 (cascade event wiring agents → tasks).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
FAIL=0

assert() {
  local desc="$1"; local actual="$2"; local expected="$3"
  if [ "$actual" = "$expected" ]; then
    echo "✓ $desc ($actual)"
  else
    echo "✗ $desc (got $actual, expected $expected)"
    FAIL=1
  fi
}

# 1. agentTaskMap lives in exactly one file (extensions/tasks/store.ts).
ATM_FILES=$(rg -l "agentTaskMap" extensions/ -g '*.ts' | tr '\n' ' ' | sed 's/ $//')
ATM_COUNT=$(rg -l "agentTaskMap" extensions/ -g '*.ts' | wc -l | tr -d ' ')
assert "agentTaskMap in exactly 1 file" "$ATM_COUNT" "1"
if [ "$ATM_FILES" != "extensions/tasks/store.ts" ]; then
  echo "✗ agentTaskMap path: got '$ATM_FILES', expected 'extensions/tasks/store.ts'"
  FAIL=1
else
  echo "✓ agentTaskMap path is extensions/tasks/store.ts"
fi

# 2. cascade.ts subscribes to agents:subagent_end.
SUB_COUNT=$(rg -n "agents:subagent_end" extensions/tasks/cascade.ts | wc -l | tr -d ' ')
if [ "$SUB_COUNT" -ge 1 ]; then
  echo "✓ extensions/tasks/cascade.ts references agents:subagent_end ($SUB_COUNT)"
else
  echo "✗ extensions/tasks/cascade.ts has no agents:subagent_end reference"
  FAIL=1
fi

# 3. cascade-stub no longer present.
STUB_COUNT=$( { rg -l "cascade-stub" extensions/ -g '*.ts' 2>/dev/null || true; } | wc -l | tr -d ' ')
assert "cascade-stub references gone" "$STUB_COUNT" "0"

# 4. Manual smoke checklist (documented; trivially passes).
cat <<'EOF'
=== Phase 6 manual smoke checklist (informational) ===
With settings.agents.enabled=true AND settings.tasks.enabled=true:
  1. TaskCreate {subject:"a", description:"d", agentType:"explore"} → #1 pending
  2. TaskCreate {subject:"b", description:"d2", agentType:"explore", addBlockedBy:["1"]} → #2 pending blocked-by #1
  3. TaskExecute {task_ids:["1"]} → spawns subagent, #1 in_progress
  4. Subagent completes → cascade.ts handles agents:subagent_end:
       - #1 → completed (autoClear.trackCompletion)
       - if cfg.autoCascade=true and cascadeConfig set → #2 launches automatically
  5. orchestration manager callback skips task tracking (settings.tasks.enabled guard)
  6. No double-fire; agentTaskMap stays single-owner.
EOF
echo "✓ smoke checklist documented"

# 5. check-build + check-invariants.
bash scripts/check-build.sh > /dev/null && echo "✓ check-build.sh passes" || { echo "✗ check-build.sh failed"; FAIL=1; }
bash scripts/check-invariants.sh > /dev/null && echo "✓ check-invariants.sh passes" || { echo "✗ check-invariants.sh failed"; FAIL=1; }

if [ "$FAIL" -eq 1 ]; then
  echo ""
  echo "PHASE 6 VERIFY FAILED"
  exit 1
fi
echo ""
echo "PHASE 6 VERIFY PASSED"
