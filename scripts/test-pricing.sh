#!/usr/bin/env bash
# Pricing-only integration test — isolated from full suite.
# Uses a dedicated pglite DB dir + port to avoid test-pgdata-pglite pollution.
# Schema is reset between suites so each runs against a clean database.
# Output -> scripts/outputs/test-pricing.log
set -euo pipefail
source "$(dirname "$(realpath "$0")")/lib.sh"
log_init

cd "$(dirname "$(realpath "$0")")/.."

export PGLITE_PORT=5433
export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5433/postgres"

reset_db() {
  (cd apps/api && ./node_modules/.bin/tsx scripts/reset-test-db.ts)
}

# Kill leftover pricing pglite-server from a previous failed run
if [ -f .pglite-pricing.pid ]; then
  OLD_PID=$(cat .pglite-pricing.pid)
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping stale pricing pglite-server (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
  rm -f .pglite-pricing.pid
fi

if (echo > /dev/tcp/127.0.0.1/$PGLITE_PORT) 2>/dev/null; then
  echo "ERROR: port $PGLITE_PORT held by an unknown process; kill it and re-run"
  exit 1
fi

# Fresh data dir so the database starts empty even before the first reset_db
export PGLITE_DB="$PWD/test-pgdata-pricing"
rm -rf "$PGLITE_DB"

echo "Starting isolated pglite-server on port $PGLITE_PORT (DB: $PGLITE_DB)..."
(cd apps/api && ./node_modules/.bin/tsx scripts/pglite-server.ts) &
PGPID=$!
echo "$PGPID" > .pglite-pricing.pid
trap 'kill "$PGPID" 2>/dev/null || true; rm -f .pglite-pricing.pid' EXIT

for i in $(seq 1 120); do
  if ! kill -0 "$PGPID" 2>/dev/null; then
    echo "ERROR: pricing pglite-server died"
    exit 1
  fi
  if (echo > /dev/tcp/127.0.0.1/"$PGLITE_PORT") 2>/dev/null; then
    break
  fi
  sleep 0.5
done
if ! (echo > /dev/tcp/127.0.0.1/"$PGLITE_PORT") 2>/dev/null; then
  echo "ERROR: pricing pglite-server not ready"
  exit 1
fi
echo "pricing pglite-server ready (PID $PGPID)"

run "pricing-admin" pnpm -F @logistics/api exec vitest run --reporter=verbose test/pricing.admin.test.ts
reset_db
run "pricing-quote" pnpm -F @logistics/api exec vitest run --reporter=verbose test/pricing.quote.test.ts
reset_db
run "pricing-booking" pnpm -F @logistics/api exec vitest run --reporter=verbose test/pricing.booking.test.ts
