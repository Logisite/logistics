# The contract is authoritative at runtime

## Status

Accepted

Supersedes the enforcement half of [0015](0015-contract-driven-openapi.md). That ADR made
`defineRoute` the gate for contract *completeness* — every route must declare a request,
response, error, security, and summary. It did not make the declaration *binding*: nothing
checked that a handler actually returned what it declared, and nothing stopped a handler
returning a whole database row.

## Context

Two independent audits — an adversarial QA pass over the API and a frontend developer's pass
over the published spec — converged on the same failure mode from opposite ends. From the
backend: `GET /tracking/shipments` returned the raw Drizzle row, so a CUSTOMER received
`senderEmail`, `recipientPhone`, `quoteAmountCents`, `quoteSnapshot`, `fieldLock`, and
`createdByUserId`. From the frontend: that same route advertised `200: { description: 'ok' }`,
so a generated client typed it as `void` — the PII leak was invisible *and* the contract was
useless.

Both are one bug: the declared schema was documentation rather than a boundary. A gap between
"what we said we'd return" and "what we return" is invisible in review, invisible to the
type system, and invisible to the frontend until someone reads the handler.

A second class of gap: discriminators typed as bare `string`. `shipments.status` had a
ten-value `pgEnum` and the spec said `{"type": "string"}`. A frontend cannot derive which
transitions are legal, and a typo in a sync op's `action` is a runtime surprise rather than a
compile error.

A third, narrower class: money aggregates. `::int` on `sum(amount_cents)` overflows past
2^31-1 cents (~$21.4M) and turns a large tenant's report into a 500. The obvious fix,
`numeric`, is worse: PostgreSQL OID 1700 is not in postgres-js's parser table, so it falls
through to `from: null, // defaults to string` and the total serialises as `"1234"`. That
silently changes the wire type from number to string. `float8` (OID 701) is parsed by
`parse: x => +x` and stays a JS number; IEEE-754 doubles represent integers exactly to 2^53,
which is ~$90 trillion in cents, and `JSON.stringify` of an integral number emits no decimal.

## Decision

The contract is authoritative at runtime, and money is integer-typed.

### 1. Responses are projected through their declared schema

Outside production, every response body is parsed through the schema the route declared. Zod
strips undeclared keys by default, so a handler that spreads a database row physically cannot
leak an undeclared column — the class of bug is closed structurally rather than by review.

Enforcement lives in non-production because that is where CI runs and where a mismatch must
fail loudly. Production keeps the schema as the contract and skips the parse cost.

### 2. One contract artifact

`apps/api/openapi.json` is generated, drift-gated in `scripts/check.sh`, and served verbatim
from `/api/v1/openapi.json`. The second generation path is deleted. There is no longer a
committed file and a separately-computed response that can disagree.

### 3. Discriminators are enums derived from the database

Shipment status, run status, sync `action`/`entity`, and any future state machine are published
as enums derived from the drizzle `pgEnum` definitions. A bare `string` for a domain
discriminator is a defect. Deriving from the schema definition means the spec cannot drift from
the database.

### 4. Money is an integer

All money is integer minor units. Aggregates widen with `::float8` and serialise as JSON
numbers; every money field in the spec is `z.number().int()`. `numeric`-as-string is rejected
because it would force `z.string()` on the wire and break every consumer.

### 5. Tags on every operation

Derived from the path prefix, so grouping is machine-readable rather than convention.

### 6. Error responses are declared per route

`defineRoute` no longer blanket-stamps 400/401/403/404/409. A route declares the errors it can
actually return. A GET does not advertise 409.

## Consequences

**Several routes will fail validation on first run and need schemas completed.** That is the
intended effect. It surfaces drift that is currently invisible, which is the whole point, but
it means this is not a one-commit change.

**A parse per response in development and CI.** Acceptable; it buys the guarantee.

**The quality gate gets stricter.** It now requires a typed success response specifically,
exempting only 204/205/304, which are bodyless by definition.

## What this does not fix

Server-side authorisation. `defineRoute` and response schemas describe what a caller receives;
they say nothing about whether they should have received it. The object-level checks in
`shipments/service.ts` (`mayDriveShipment`) and the field-level permission split in
`patchShipment` are the mechanism for that, and no amount of contract discipline substitutes
for them. A contract can be perfectly typed and still hand one customer's data to another.

## Alternatives considered

**Reject unknown keys instead of stripping.** Stricter, but it turns an additive schema change
into a runtime 500 for every existing client. Stripping fails safe and still prevents the leak.

**Runtime validation in production too.** Would catch handler drift in prod, at the cost of a
parse on every request and a new failure mode where a schema bug takes down an endpoint. Not
worth it: the guarantee that matters is that CI never lets drift merge.

**Keep `numeric` and change the schemas to `z.string()`.** Most precise, but it is a silent
breaking change for every consumer mid-stream. Deferred unless a precision requirement appears
that 2^53 cents cannot cover.