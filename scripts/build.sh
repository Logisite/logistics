#!/usr/bin/env bash
# Full monorepo build. Output -> scripts/outputs/build.log
set -euo pipefail
source "$(dirname "$(realpath "$0")")/lib.sh"
log_init

cd "$(dirname "$(realpath "$0")")/.."

export GIT_SHA=$(git rev-parse --short HEAD)

run "pnpm build" pnpm build
