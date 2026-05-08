#!/usr/bin/env bash
set -euo pipefail

# Locate tsc relative to the active node installation.
NODE_LIB="$(node -e "process.stdout.write(require('path').join(process.execPath,'../../lib/node_modules'))")"
TSC="$(find "$NODE_LIB" -name tsc -path "*/typescript/bin/tsc" 2>/dev/null | head -1)"

if [ -z "$TSC" ]; then
  echo "error: tsc not found in $NODE_LIB" >&2
  echo "Install typescript globally: npm install -g typescript" >&2
  exit 1
fi

REPO="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$TSC" --noEmit -p "$REPO"
