#!/usr/bin/env bash
# Shipments-only integration test - isolated from full suite.
# Reuses the pricing pglite port/dir pattern; schema resets between suites.
# Output -> scripts/outputs/test-shipments.log
set -euo pipefail
source "$(dirname "$(realpath "$0")")/lib.sh"
log_init

cd "$(dirname "$(realpath "$0")")/.."

export PGLITE_PORT=5434
export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5434/postgres"

reset_db() {
  (cd apps/api && ./node_modules/.bin/tsx scripts/reset-test-db.ts)
}

# Kill leftover shipments pglite-server from a previous failed run
if [ -f .pglite-shipments.pid ]; then
  OLD_PID=$(cat .pglite-shipments.pid)
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping stale shipments pglite-server (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
  rm -f .pglite-shipments.pid
fi

if (echo > /dev/tcp/127.0.0.1/$PGLITE_PORT) 2>/dev/null; then
  echo "ERROR: port $PGLITE_PORT held by an unknown process; kill it and re-run"
  exit 1
fi

export PGLITE_DB="$PWD/test-pgdata-shipments"
rm -rf "$PGLITE_DB"

echo "Starting isolated pglite-server on port $PGLITE_PORT (DB: $PGLITE_DB)..."
(cd apps/api && ./node_modules/.bin/tsx scripts/pglite-server.ts) &
PGPID=$!
echo "$PGPID" > .pglite-shipments.pid
trap 'kill "$PGPID" 2>/dev/null || true; rm -f .pglite-shipments.pid' EXIT

for i in $(seq 1 120); do
  if ! kill -0 "$PGPID" 2>/dev/null; then
    echo "ERROR: shipments pglite-server died"
    exit 1
  fi
  if (echo > /dev/tcp/127.0.0.1/"$PGLITE_PORT") 2>/dev/null; then
    break
  fi
  sleep 0.5
done
if ! (echo > /dev/tcp/127.0.0.1/"$PGLITE_PORT") 2>/dev/null; then
  echo "ERROR: shipments pglite-server not ready"
  exit 1
fi
echo "shipments pglite-server ready (PID $PGPID)"

run "shipments-transitions" pnpm -F @logistics/api exec vitest run --reporter=verbose test/shipments.transitions.test.ts
reset_db
run "shipments-cancel" pnpm -F @logistics/api exec vitest run --reporter=verbose test/shipments.cancel.test.ts
