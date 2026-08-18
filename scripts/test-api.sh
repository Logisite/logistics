#!/usr/bin/env bash
# API integration tests (PGlite). Output -> scripts/outputs/test-api.log
# Runs test files SEQUENTIALLY to avoid multiple PGlite instances eating RAM.
set -euo pipefail
source "$(dirname "$(realpath "$0")")/lib.sh"
log_init

cd "$(dirname "$(realpath "$0")")/.."

run "auth" pnpm -F @logistics/api exec vitest run --reporter=verbose test/auth.test.ts
run "customers" pnpm -F @logistics/api exec vitest run --reporter=verbose test/customers.test.ts
run "merchants" pnpm -F @logistics/api exec vitest run --reporter=verbose test/merchants.test.ts
