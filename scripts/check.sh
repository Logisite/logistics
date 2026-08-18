#!/usr/bin/env bash
# typecheck + lint across the monorepo. Output -> scripts/outputs/check.log
set -euo pipefail
source "$(dirname "$(realpath "$0")")/lib.sh"
log_init

cd "$(dirname "$(realpath "$0")")/.."

run "pnpm typecheck" pnpm typecheck
run "pnpm lint" pnpm lint
