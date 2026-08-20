#!/usr/bin/env bash
# API integration tests against pglite-socket server.
# Requires pglite-server running (see scripts/pglite-start.sh).
# Output -> scripts/outputs/test-api.log
set -euo pipefail
source "$(dirname "$(realpath "$0")")/lib.sh"
log_init

cd "$(dirname "$(realpath "$0")")/.."

export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/postgres"

# Verify server is reachable
if ! (echo > /dev/tcp/127.0.0.1/5432) 2>/dev/null; then
  echo "ERROR: pglite-server not reachable on port 5432"
  echo "Run: bash scripts/pglite-start.sh"
  exit 1
fi

run "auth" pnpm -F @logistics/api exec vitest run --reporter=verbose test/auth.test.ts
run "customers" pnpm -F @logistics/api exec vitest run --reporter=verbose test/customers.test.ts
run "merchants" pnpm -F @logistics/api exec vitest run --reporter=verbose test/merchants.test.ts
run "locations" pnpm -F @logistics/api exec vitest run --reporter=verbose test/locations.test.ts
