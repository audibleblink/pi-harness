#!/usr/bin/env bash
# phase5-verify.sh — verify Phase 5 (extensions/tasks/) deliverables.
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

# 1. All 7 tool files exist.
for f in create list get update output stop execute; do
  if [ -f "extensions/tasks/tools/$f.ts" ]; then
    echo "✓ extensions/tasks/tools/$f.ts exists"
  else
    echo "✗ extensions/tasks/tools/$f.ts missing"
    FAIL=1
  fi
done

# rg -c 'execute:' returns one count per file; count files with >=1 match.
EXECUTE_COUNT=$(rg -c "execute:" extensions/tasks/tools/ --glob '!deps.ts' | wc -l | tr -d ' ')
assert "execute: in 7 tool files" "$EXECUTE_COUNT" "7"

# 2. TaskCreate registered in create.ts.
TC_COUNT=$(rg -l 'name: "TaskCreate"' extensions/tasks/tools/create.ts | wc -l | tr -d ' ')
assert "TaskCreate registration in create.ts" "$TC_COUNT" "1"

# 3. orchestration/index.ts: TaskCreate registration is gated by `if (!settings.tasks?.enabled)`.
GATED=$(awk '
  /if \(!settings\.tasks\?\.enabled\)/ { guard=NR }
  /name: "TaskCreate"/                  { if (guard>0 && NR-guard<10 && NR-guard>0) { print "ok"; exit } }
' extensions/orchestration/index.ts)
if [ "$GATED" = "ok" ]; then
  echo "✓ orchestration TaskCreate gated by tasks.enabled"
else
  echo "✗ orchestration TaskCreate not gated"
  FAIL=1
fi

# 4. Manual smoke checklist (documented; trivially passes).
cat <<'EOF'
=== Phase 5 manual smoke checklist (informational) ===
With settings.tasks.enabled=true:
  1. TaskCreate {subject:"x", description:"y"} → returns "Task #1 created…"
  2. TaskList                                  → shows #1 [pending] x
  3. TaskGet {taskId:"1"}                      → returns task detail
  4. TaskUpdate {taskId:"1", status:"completed"} → success
  5. After ~4 turns, TaskList                  → "No tasks found" (auto-clear)
  6. orchestration's task tools must NOT register (verified above)
EOF
echo "✓ smoke checklist documented"

# 5. check-build + check-invariants.
bash scripts/check-build.sh > /dev/null && echo "✓ check-build.sh passes" || { echo "✗ check-build.sh failed"; FAIL=1; }
bash scripts/check-invariants.sh > /dev/null && echo "✓ check-invariants.sh passes" || { echo "✗ check-invariants.sh failed"; FAIL=1; }

if [ "$FAIL" -eq 1 ]; then
  echo ""
  echo "PHASE 5 VERIFY FAILED"
  exit 1
fi
echo ""
echo "PHASE 5 VERIFY PASSED"
