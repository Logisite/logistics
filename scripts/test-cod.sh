#!/usr/bin/env bash
# Pricing-only integration test — isolated from full suite.
# Uses a dedicated pglite DB dir + port to avoid test-pgdata-pglite pollution.
# Schema is reset between suites so each runs against a clean database.
# Output -> scripts/outputs/test-cod.log
set -euo pipefail
source "$(dirname "$(realpath "$0")")/lib.sh"
log_init

cd "$(dirname "$(realpath "$0")")/.."

export PGLITE_PORT=5436
export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5436/postgres"

reset_db() {
  (cd apps/api && ./node_modules/.bin/tsx scripts/reset-test-db.ts)
}

# Kill leftover cod pglite-server from a previous failed run
if [ -f .pglite-cod.pid ]; then
  OLD_PID=$(cat .pglite-cod.pid)
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping stale cod pglite-server (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
  rm -f .pglite-cod.pid
fi

if (echo > /dev/tcp/127.0.0.1/$PGLITE_PORT) 2>/dev/null; then
  echo "ERROR: port $PGLITE_PORT held by an unknown process; kill it and re-run"
  exit 1
fi

# Fresh data dir so the database starts empty even before the first reset_db
export PGLITE_DB="$PWD/test-pgdata-cod"
rm -rf "$PGLITE_DB"

echo "Starting isolated pglite-server on port $PGLITE_PORT (DB: $PGLITE_DB)..."
(cd apps/api && ./node_modules/.bin/tsx scripts/pglite-server.ts) &
PGPID=$!
echo "$PGPID" > .pglite-cod.pid
trap 'kill "$PGPID" 2>/dev/null || true; rm -f .pglite-cod.pid' EXIT

for i in $(seq 1 120); do
  if ! kill -0 "$PGPID" 2>/dev/null; then
    echo "ERROR: cod pglite-server died"
    exit 1
  fi
  if (echo > /dev/tcp/127.0.0.1/"$PGLITE_PORT") 2>/dev/null; then
    break
  fi
  sleep 0.5
done
if ! (echo > /dev/tcp/127.0.0.1/"$PGLITE_PORT") 2>/dev/null; then
  echo "ERROR: cod pglite-server not ready"
  exit 1
fi
echo "cod pglite-server ready (PID $PGPID)"

run "cod-reconciliation" pnpm -F @logistics/api exec vitest run --reporter=verbose test/cod.reconciliation.test.ts
reset_db
run "cod-settlement" pnpm -F @logistics/api exec vitest run --reporter=verbose test/cod.settlement.test.ts
run "cod-money" pnpm -F @logistics/api exec vitest run --reporter=verbose test/cod.money.test.ts
