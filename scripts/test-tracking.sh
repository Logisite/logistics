#!/usr/bin/env bash
# Pricing-only integration test — isolated from full suite.
# Uses a dedicated pglite DB dir + port to avoid test-pgdata-pglite pollution.
# Schema is reset between suites so each runs against a clean database.
# Output -> scripts/outputs/test-tracking.log
set -euo pipefail
source "$(dirname "$(realpath "$0")")/lib.sh"
log_init

cd "$(dirname "$(realpath "$0")")/.."

export PGLITE_PORT=5435
export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5435/postgres"

reset_db() {
  (cd apps/api && ./node_modules/.bin/tsx scripts/reset-test-db.ts)
}

# Kill leftover tracking pglite-server from a previous failed run
if [ -f .pglite-tracking.pid ]; then
  OLD_PID=$(cat .pglite-tracking.pid)
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping stale tracking pglite-server (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
  rm -f .pglite-tracking.pid
fi

if (echo > /dev/tcp/127.0.0.1/$PGLITE_PORT) 2>/dev/null; then
  echo "ERROR: port $PGLITE_PORT held by an unknown process; kill it and re-run"
  exit 1
fi

# Fresh data dir so the database starts empty even before the first reset_db
export PGLITE_DB="$PWD/test-pgdata-tracking"
rm -rf "$PGLITE_DB"

echo "Starting isolated pglite-server on port $PGLITE_PORT (DB: $PGLITE_DB)..."
(cd apps/api && ./node_modules/.bin/tsx scripts/pglite-server.ts) &
PGPID=$!
echo "$PGPID" > .pglite-tracking.pid
trap 'kill "$PGPID" 2>/dev/null || true; rm -f .pglite-tracking.pid' EXIT

for i in $(seq 1 120); do
  if ! kill -0 "$PGPID" 2>/dev/null; then
    echo "ERROR: tracking pglite-server died"
    exit 1
  fi
  if (echo > /dev/tcp/127.0.0.1/"$PGLITE_PORT") 2>/dev/null; then
    break
  fi
  sleep 0.5
done
if ! (echo > /dev/tcp/127.0.0.1/"$PGLITE_PORT") 2>/dev/null; then
  echo "ERROR: tracking pglite-server not ready"
  exit 1
fi
echo "tracking pglite-server ready (PID $PGPID)"

run "tracking" pnpm -F @logistics/api exec vitest run --reporter=verbose test/tracking.test.ts
reset_db
run "notifications" pnpm -F @logistics/api exec vitest run --reporter=verbose test/notifications.test.ts
