#!/usr/bin/env bash
# typecheck + lint + drift gates across the monorepo. Output -> scripts/outputs/check.log
set -euo pipefail
source "$(dirname "$(realpath "$0")")/lib.sh"
log_init

cd "$(dirname "$(realpath "$0")")/.."

run "pnpm typecheck" pnpm typecheck
run "pnpm lint" pnpm lint

# migration integrity: every journal entry must have a .sql and snapshot, no duplicate idx
run "migration integrity" bash -c '
  journal="packages/db/drizzle/meta/_journal.json"
  entries=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); [print(e[\"idx\"],e[\"tag\"]) for e in d[\"entries\"]]" "$journal")
  dupes=$(echo "$entries" | awk "{print \$1}" | sort -n | uniq -d)
  if [ -n "$dupes" ]; then echo "FAIL: duplicate idx in journal: $dupes"; exit 1; fi
  while read -r idx tag; do
    sql="packages/db/drizzle/${tag}.sql"
    snap="packages/db/drizzle/meta/${tag}_snapshot.json"
    [ -f "$sql" ] || { echo "FAIL: missing $sql"; exit 1; }
    [ -f "$snap" ] || { echo "FAIL: missing $snap"; exit 1; }
  done <<< "$entries"
  echo "OK: $(echo "$entries" | wc -l) migrations, all present"
'

# openapi drift: regenerate spec and ensure no uncommitted diff
run "openapi generate" pnpm --filter @logistics/api exec tsx src/openapi/generate.ts
run "openapi drift gate" bash -c '
  git diff --exit-code apps/api/openapi.json || {
    echo "FAIL: openapi.json has uncommitted changes after regeneration"
    echo "Run: pnpm --filter @logistics/api exec tsx src/openapi/generate.ts"
    exit 1
  }
'
