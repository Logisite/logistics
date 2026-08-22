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

# Reset the schema so every suite starts from a clean database and can be
# re-run independently of previous runs.
reset_db() {
  (cd apps/api && ./node_modules/.bin/tsx scripts/reset-test-db.ts) >/dev/null
}

reset_db
run "auth" pnpm -F @logistics/api exec vitest run --reporter=verbose test/auth.test.ts
reset_db
run "customers" pnpm -F @logistics/api exec vitest run --reporter=verbose test/customers.test.ts
reset_db
run "merchants" pnpm -F @logistics/api exec vitest run --reporter=verbose test/merchants.test.ts
reset_db
run "locations" pnpm -F @logistics/api exec vitest run --reporter=verbose test/locations.test.ts
reset_db
run "pricing-admin" pnpm -F @logistics/api exec vitest run --reporter=verbose test/pricing.admin.test.ts
reset_db
run "pricing-quote" pnpm -F @logistics/api exec vitest run --reporter=verbose test/pricing.quote.test.ts
reset_db
run "pricing-booking" pnpm -F @logistics/api exec vitest run --reporter=verbose test/pricing.booking.test.ts
