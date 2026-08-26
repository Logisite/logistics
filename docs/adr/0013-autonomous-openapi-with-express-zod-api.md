# Status: Superseded by ADR 0014

> **Superseded by [ADR 0014](./0014-autonomous-openapi-via-defineRoute.md)** — we keep Express + supertest and use `defineRoute` (`@asteasolutions/zod-to-openapi`) instead of `express-zod-api` `EndpointsFactory`. The `express-zod-api` dependency has been removed (0 hits in `src/`).

# Autonomous OpenAPI via express-zod-api (superseded)

We replace manual `registry.registerPath` calls with `express-zod-api`'s `EndpointsFactory` + `Routing` + `Documentation`. Endpoints are declared once as `factory.build({input: z.object({}), output: z.object({}), handler})` in a single `Routing` object; input/output Zod schemas are validated at runtime and the same schemas are crawled by `Documentation` to emit `openapi: 3.1.0` with no second spec file.

We chose this over staying on `@asteasolutions/zod-to-openapi` because the manual registry is autonomous only if every dev remembers `defineRoute` — drift is a discipline problem. The framework removes the extra call: spec length equals routing surface automatically, security derived from middleware, and response validation is built in. It is hard to reverse because routing shape becomes factory-owned and `GET /openapi.json` is generated from `Routing`, not from side-effect imports.

