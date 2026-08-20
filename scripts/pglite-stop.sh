#!/usr/bin/env bash
# Stop the pglite-socket server.
set -euo pipefail

SCRIPT_DIR="$(dirname "$(realpath "$0")")"
cd "$SCRIPT_DIR/.."

PID_FILE=".pglite.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "No .pglite.pid found — server not running."
  exit 0
fi

PID=$(cat "$PID_FILE")
if kill -0 "$PID" 2>/dev/null; then
  echo "Stopping pglite-server (PID $PID)..."
  kill "$PID"
  for i in $(seq 1 10); do
    if ! kill -0 "$PID" 2>/dev/null; then break; fi
    sleep 0.25
  done
  kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null || true
else
  echo "PID $PID not running (stale pidfile)."
fi

rm -f "$PID_FILE"
echo "pglite-server stopped."
