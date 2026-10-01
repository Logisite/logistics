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

// 2b. No schema may be an untyped hole. A bare {} or an items:{} tells a
//     generated client nothing, which is how the sync static-reference arrays
//     shipped as an untyped bag.
const untyped = [];
const components = spec.components?.schemas || {};
const refName = (s) => (typeof s.\$ref === 'string' ? s.\$ref.split('/').pop() : null);
const isHole = (s, seen = new Set()) => {
  if (!s || typeof s !== 'object') return true;
  const ref = refName(s);
  if (ref) {
    if (seen.has(ref)) return false;
    seen.add(ref);
    return isHole(components[ref], seen);
  }
  const keys = Object.keys(s);
  if (keys.length === 0) return true;
  if (s.type === 'object' && s.properties === undefined && s.additionalProperties === undefined
      && s.allOf === undefined && s.anyOf === undefined && s.oneOf === undefined) return true;
  if (s.items !== undefined && isHole(s.items, seen)) return true;
  if (s.properties && typeof s.properties === 'object') {
    return Object.values(s.properties).some(p => isHole(p, seen));
  }
  return false;
};
for (const [name, schema] of Object.entries(spec.components?.schemas || {})) {
  if (isHole(schema)) untyped.push(name);
}
for (const [path, methods] of Object.entries(spec.paths || {})) {
  for (const [method, op] of Object.entries(methods)) {
    if (method === 'parameters') continue;
    for (const [status, r] of Object.entries(op.responses || {})) {
      const body = r?.content?.['application/json']?.schema;
      if (body && isHole(body)) {
        untyped.push(method.toUpperCase() + ' ' + path + ' (' + status + ')');
      }
    }
  }
}
if (untyped.length > 0) {
  untyped.forEach(u => console.error('  untyped schema:', u));
  errors.push(untyped.length + ' untyped schema(s) — a bare {} generates nothing useful');
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
