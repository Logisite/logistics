#!/usr/bin/env bash
# Delete the persisted pglite database for a fresh start.
# Server must be stopped first (pglite-stop.sh).
set -euo pipefail

SCRIPT_DIR="$(dirname "$(realpath "$0")")"
cd "$SCRIPT_DIR/.."

DB_DIR="./test-pgdata-pglite"
PID_FILE=".pglite.pid"

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "ERROR: pglite-server is still running. Stop it first: bash scripts/pglite-stop.sh"
  exit 1
fi

if [[ -d "$DB_DIR" ]]; then
  rm -rf "$DB_DIR"
  echo "Deleted $DB_DIR"
else
  echo "$DB_DIR does not exist — nothing to reset."
fi
