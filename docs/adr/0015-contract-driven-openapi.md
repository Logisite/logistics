# Contract-Driven OpenAPI

## Status

Accepted

## Context

The OpenAPI spec (`openapi.json`) is the contract frontend will build against. Before this ADR, every `defineRoute` call declared only a status code with `{ description: 'ok' }` — no response body schemas, no error responses, no summaries, no security schemes. A frontend dev reading the spec would have no idea what any endpoint returns or what errors to handle.

The spec was also stale — missing 6 routes that existed in Express but not in OpenAPI, and missing response schemas on all 91 routes.

## Decision

Make `defineRoute` the quality gate for API contract completeness. Every route must declare its full contract: request body, response body, error responses, security, and summary.

### 1. `registry.ts` as the contract engine

`defineRoute` auto-merges:
- **Security:** `[{ bearerAuth: [] }]` on all routes by default. Public routes opt out with `security: []`.
- **Error responses:** 400 (validation), 401 (unauthenticated), 403 (forbidden), 404 (not found), 409 (conflict) — all with `ErrorResponse` schema. Routes override when they don't throw certain codes.
- **Summary:** Auto-generated from METHOD + path (e.g. `POST /auth/login`).

### 2. Schema registration via `.openapi('Name')`

Every Zod schema gets a PascalCase name (e.g. `AuthLoginRequest`, `PricingQuoteResponse`). This populates `components.schemas` in the generated spec, enabling `$ref` reuse across the document.

### 3. Response content schemas

Every `defineRoute` must declare response body schemas with `application/json` content. 204 responses stay bodyless (REST standard). No more `{ description: 'ok' }` without a schema.

### 4. CI enforcement

`scripts/check.sh` already regenerates the spec and fails on drift. A new validation script checks quality: non-empty `components.schemas`, all paths have response content, security schemes present.

### 5. Error response shape

Matches the existing `HttpError` handler in `app.ts`:

```json
{ "error": { "code": "VALIDATION", "message": "Invalid request payload" } }
```

Shared `ErrorResponse` schema in `registry.ts` is auto-merged into all error responses.

## Consequences

- **Frontend gets a complete contract.** Every endpoint's request, response, and errors are documented. No guessing.
- **Drift is impossible.** New routes must call `defineRoute` with a response schema or the spec regenerates with gaps that CI catches.
- **TypeScript enforces the contract.** If `defineRoute` expects a response schema and you don't provide one, it won't compile.
- **The spec is self-documenting.** Swagger UI shows summaries, security requirements, request/response examples, and error codes for every endpoint.
- **Maintenance burden is low.** Add a route → add a `defineRoute` call with a response schema → the spec grows automatically. No second file to keep in sync.
