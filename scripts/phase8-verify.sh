#!/usr/bin/env bash
# Phase 8 verifier — full smoke + build + invariants.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

FAIL=0
ok()   { echo "✓ $*"; }
fail() { echo "✗ $*"; FAIL=1; }

if bash scripts/smoke.sh acceptance; then ok "smoke.sh acceptance"
else fail "smoke.sh acceptance"; fi

if bash scripts/check-build.sh >/dev/null 2>&1; then ok "check-build.sh"
else fail "check-build.sh"; bash scripts/check-build.sh; fi

if bash scripts/check-invariants.sh >/dev/null 2>&1; then ok "check-invariants.sh"
else fail "check-invariants.sh"; bash scripts/check-invariants.sh; fi

if [ "$FAIL" -eq 0 ]; then
	echo "phase8-verify: PASS"
	exit 0
fi
echo "phase8-verify: FAIL"
exit 1
