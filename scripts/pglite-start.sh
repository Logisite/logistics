#!/usr/bin/env bash
# Start a PGlite socket server with PostGIS for integration tests.
# Uses persisted DB at ./test-pgdata-pglite.
set -euo pipefail

SCRIPT_DIR="$(dirname "$(realpath "$0")")"
cd "$SCRIPT_DIR/.."

PID_FILE=".pglite.pid"
DB_DIR="./test-pgdata-pglite"
PORT=5432

# Kill existing server if running
if [[ -f "$PID_FILE" ]]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing pglite-server (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
  rm -f "$PID_FILE"
fi

# Check port is free
if ss -tlnp 2>/dev/null | grep -q ":${PORT} "; then
  echo "ERROR: port $PORT already in use"
  exit 1
fi

if [[ ! -d "$DB_DIR" ]]; then
  echo "First start: initdb will run (slow). Subsequent starts skip this."
fi

echo "Starting pglite-server on 127.0.0.1:$PORT..."
(cd apps/api && ./node_modules/.bin/tsx scripts/pglite-server.ts) &
PGPID=$!

echo "$PGPID" > "$PID_FILE"

# Poll TCP port until ready
echo "Waiting for pglite-server on port $PORT..."
for i in $(seq 1 120); do
  if ! kill -0 "$PGPID" 2>/dev/null; then
    echo "ERROR: pglite-server process died"
    rm -f "$PID_FILE"
    exit 1
  fi
  if (echo > /dev/tcp/127.0.0.1/"$PORT") 2>/dev/null; then
    break
  fi
  sleep 0.5
done

if ! (echo > /dev/tcp/127.0.0.1/"$PORT") 2>/dev/null; then
  echo "ERROR: pglite-server did not become ready on port $PORT"
  kill "$PGPID" 2>/dev/null || true
  rm -f "$PID_FILE"
  exit 1
fi

echo "pglite-server ready (PID $PGPID, port $PORT)"
