#!/usr/bin/env bash
# Validate openapi.json quality: schemas populated, security present, response content on all paths
set -euo pipefail

cd "$(dirname "$(realpath "$0")")/.."

SPEC="apps/api/openapi.json"

if [ ! -f "$SPEC" ]; then
  echo "FAIL: $SPEC not found — run openapi:generate first"
  exit 1
fi

node -e "
const spec = require('./$SPEC');
const errors = [];

// 1. components.schemas must not be empty
const schemas = Object.keys(spec.components?.schemas || {});
if (schemas.length === 0) {
  errors.push('components.schemas is empty — no Zod schemas registered');
}

// 2. securitySchemes must exist
if (!spec.components?.securitySchemes?.bearerAuth) {
  errors.push('components.securitySchemes.bearerAuth missing');
}

// 3. Every path operation must type its SUCCESS response.
//    204/205/304 are bodyless by definition, so an operation whose only
//    success is one of those is exempt.
let missing = 0;
const BODYLESS = ['204', '205', '304'];
for (const [path, methods] of Object.entries(spec.paths || {})) {
  for (const [method, op] of Object.entries(methods)) {
    if (method === 'parameters') continue;
    const success = Object.entries(op.responses || {})
      .filter(([status]) => /^2\d\d$/.test(status));
    const typed = success.filter(([, r]) => r?.content);
    const bodylessOnly = success.length > 0 && success.every(([status]) => BODYLESS.includes(status));
    if (typed.length === 0 && !bodylessOnly) {
      missing++;
      console.error('  missing success content:', method.toUpperCase(), path);
    }
  }
}
if (missing > 0) {
  errors.push(missing + ' operations missing response content');
}

// 4. Every path operation must have security
let noSecurity = 0;
for (const [path, methods] of Object.entries(spec.paths || {})) {
  for (const [method, op] of Object.entries(methods)) {
    if (method === 'parameters') continue;
    if (!op.security) {
      noSecurity++;
      console.error('  missing security:', method.toUpperCase(), path);
    }
  }
}
if (noSecurity > 0) {
  errors.push(noSecurity + ' operations missing security');
}

if (errors.length > 0) {
  console.error('FAIL: OpenAPI validation failed:');
  errors.forEach(e => console.error('  -', e));
  process.exit(1);
}

console.log('OK: ' + schemas.length + ' schemas, ' + (Object.keys(spec.paths || {}).length) + ' paths, all operations have typed success + security');
"
