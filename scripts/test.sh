#!/usr/bin/env bash
# Schema + API integration tests (PGlite; memory-heavy; run outside opencode). Output -> scripts/outputs/test.log
set -euo pipefail
source "$(dirname "$(realpath "$0")")/lib.sh"
log_init

cd "$(dirname "$(realpath "$0")")/.."

# Api suite runs first so its output lands in the log before the heavier
# db suite's PGlite import (memory-constrained device).
run "pnpm -F @logistics/api test" pnpm -F @logistics/api test
run "pnpm -F @logistics/db test" pnpm -F @logistics/db test
