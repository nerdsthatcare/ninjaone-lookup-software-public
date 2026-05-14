#!/usr/bin/env bash
# Build for Linux/macOS (run on the target platform).
set -euo pipefail
cd "$(dirname "$0")"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
OUT="NinjaSoftwareLookup"
[ "$OS" = "darwin" ] && OUT="NinjaSoftwareLookup-mac"

CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "$OUT" .
echo "Built: $OUT"
