#!/usr/bin/env bash
# Shared runner used by the scripts/ heavy-command scripts.

set -euo pipefail

if [[ -z "${LOG_DIR:-}" ]]; then
  LOG_DIR="$(dirname "$(realpath "${BASH_SOURCE[0]}")")/outputs"
fi

mkdir -p "$LOG_DIR"

# Reset the log for the current script (called once at the top of each script).
log_init() {
  local caller="${BASH_SOURCE[1]}"
  : > "$LOG_DIR/$(basename "$caller" .sh).log"
}

# Run a command, streaming its output live to the terminal while appending a
# copy to the per-script log file. Prints a header before and a result line
# (exit code + elapsed seconds) after. A failing command aborts the script via
# the restored `set -e` + nonzero return.
run() {
  local label="$1"
  shift

  local caller="${BASH_SOURCE[1]}"
  local log_file="$LOG_DIR/$(basename "$caller" .sh).log"
  local start elapsed status=0

  start="$(date +%s)"

  echo "==> $label" | tee -a "$log_file"

  set +e
  "$@" 2>&1 | tee -a "$log_file"
  status="${PIPESTATUS[0]}"
  set -e

  elapsed="$(( $(date +%s) - start ))"
  echo "--> $label: exit $status (${elapsed}s)" | tee -a "$log_file"
  return "$status"
}
