#!/usr/bin/env bash
# API auth integration tests (single vitest file, PGlite). Output -> scripts/outputs/test-api.log
set -euo pipefail
source "$(dirname "$(realpath "$0")")/lib.sh"
log_init

cd "$(dirname "$(realpath "$0")")/.."

run "pnpm -F @logistics/api exec vitest run --reporter=verbose test/auth.test.ts" pnpm -F @logistics/api exec vitest run --reporter=verbose test/auth.test.ts