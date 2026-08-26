# AGENTS.md

Cooperation rules for agents working in this repository — the offline-first logistics platform.

## Agent skills

### Issue tracker

Issues and specs for this repo live as local markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels
The five canonical role strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs
Single-context layout: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Running heavy commands

The dev device is memory-constrained (2.7 GiB RAM, often swapping). This shapes how work is executed, never how code is written.

- Run heavy commands (`typecheck`, `lint`, `build`, `test`) one at a time — never chain or run in parallel. `pnpm -r` fan-out + opencode at once will swap-thrash.
- For anything heavier than a one-shot check, use the committed `scripts/` runner: `bash scripts/<check|build|test|test-api>.sh`. It streams live output to the terminal, writes a copy to `scripts/outputs/<name>.log`, and `set -euo pipefail` fails loudly. Invoke it, then read the log rather than re-running inside the session. `test-api.sh` runs just the API auth integration test file (`test/auth.test.ts`); `test.sh` runs the full api + db suites.
- `scripts/outputs/` and `packages/db/test-pgdata/` are gitignored machine state.
- **Agent must not run test scripts directly.** The user runs them outside opencode to avoid memory thrash. Agent adds test files to the script, tells the user to run it, then reads `scripts/outputs/<name>.log` for results. See `.scratch/user.md`.

### CI scripts

| Script | What it runs | When to use |
|--------|-------------|-------------|
| `check.sh` | `pnpm typecheck` + `pnpm lint` | Main CI lint/typecheck gate |
| `build.sh` | `pnpm build` | Main CI build |
| `test.sh` | API tests + DB tests (full suite) | **Main CI test suite** |
| `test-api.sh` | auth + customers + merchants + locations tests (verbose) | Full API integration suite |
| `test-shipments.sh` | shipments transitions + cancel suites (isolated pglite, port 5434) | Issue-07 state machine suites |
| `test-pricing.sh` | pricing admin/quote/booking suites (isolated pglite, port 5433) | Pricing suites |
| `test-tracking.sh` | tracking + notifications suites (isolated pglite, port 5435) | Issue-08 suites |
| `test-cod.sh` | cod reconciliation + settlement suites (isolated pglite, port 5436) | Issue-09 suites |

`test.sh` is the main CI test script — it runs both api and db suites. `test-api.sh` runs the full API integration suite (auth, customers, merchants, locations, shipments, tracking, notifications, cod) with a schema reset between suites; every suite is independently re-runnable. The per-module isolated scripts run one concern against its own pglite instance on a dedicated port. Every feature module MUST have integration tests — write them alongside the code, not after.

## packages/db tests

`pnpm -F @logistics/db test` (via `scripts/test.sh`) runs against **PGlite** by default (persistent `test-pgdata/` dir, real Postgres compiled to WASM). Set `DATABASE_URL` to point the same test file at a real PostgreSQL instead — the schema, queries, and migrations are byte-identical across both backends. Seam is `test/db.ts`.

## Database migrations

Never hand-write SQL in `packages/db/drizzle/`. Schema changes live in `packages/db/src/schema/*.ts`; migrations are generated append-only via `pnpm --filter @logistics/db exec drizzle-kit generate` (reads `drizzle.config.ts`, writes `drizzle/*.sql` + `drizzle/meta/*`). Use `drizzle-kit push` only for ephemeral local experiments, never for committed history. See ADR 0012. Hand-written migrations caused `M-002` (0003/0004 duplicate columns, fresh-DB crash) — the generator is the single source of truth.

## OpenAPI autonomy

Every new route must be autonomous: define its Zod schema once and call `defineRoute` from `apps/api/src/openapi/registry.ts` at top level so the schema drives validation and `OpenAPIRegistry` at import time. `apps/api/src/openapi/generator.ts` side-effect imports all routers and `OpenApiGeneratorV31` emits `openapi: 3.1.0` to `apps/api/openapi.json`. Never maintain a second spec or hand-edit `openapi.json`. See ADR 0014. Error handling (400/401/403/404/409) is part of the route definition — include all expected responses in `defineRoute`.

## Test file conventions

### File size

**Soft limit: 500 lines.** Split before hitting this. A 26-test monolith is unmaintainable — the dev can't find, run, or debug individual tests.

### Naming pattern

`{module}.{category}.test.ts` — one file per logical concern:

```
auth.register.test.ts    — registration + email verification
auth.sessions.test.ts    — session lifecycle (rotate, revoke, list)
auth.rbac.test.ts        — role bundles, permissions, invite
auth.password.test.ts    — forgot/reset password flows
auth.seed.test.ts        — bootstrap owner, seed repair
auth.hardening.test.ts   — production hardening (security POCs)
```

### Split by `describe` blocks

Each top-level `describe` in a large file becomes its own test file. The file name describes the concern, not the implementation detail.

### Shared helpers

Common setup (`createTestDb`, `seedAdmin`, `FakeMailer`, `TEST_PASSWORD`) lives in `test/helpers.ts`. Each test file imports what it needs and sets up its own state — no shared mutable globals across files.

### Each file is independently runnable

Every test file has its own imports, `beforeAll`/`afterAll`, and can run standalone via `vitest run test/auth.sessions.test.ts`.

### When to split

- File exceeds 400-500 lines
- Multiple `describe` blocks testing different concerns
- Merge conflicts in the test file become frequent
- Developers can't find relevant tests

## Commit messages

Follow **Conventional Commits** — every commit is machine-parseable and human-readable.

### Format

```
type(scope): short description

[optional body — explain what and why, not how]
[optional footer — issue refs, breaking changes]
```

### Rules

1. **Subject line**: imperative mood ("add", "fix", "remove" — not "added", "fixes"). ≤50 characters. No period.
2. **Scope** (optional): the module or area affected — `feat(auth):`, `fix(api):`, `test(locations):`.
3. **Body** (optional): what changed and why. The diff shows how; the body explains why. Wrap at 72 characters. One blank line after the subject.
4. **Footers** (optional): `Closes #123`, `BREAKING CHANGE: ...`. One blank line after the body.
5. **Types**: `feat` (new feature), `fix` (bug fix), `docs`, `style`, `refactor`, `test`, `chore` (deps, tooling), `perf`, `build`, `ci`.
6. **Breaking changes**: `feat(api)!: remove v1 endpoint` or `BREAKING CHANGE: ...` footer.

### Examples

```
feat(locations): admin CRUD for hubs, pickup locations, zones

PostGIS geometry columns on hubs, pickup_locations, zones with
GiST spatial indexes. Mapbox v5 geocoding for UK addresses.
15 routes (12 admin + 3 public reads). 25 integration tests.
```

```
fix(auth): prevent session fixation on login

Regenerate the session ID after successful authentication.
The old session data is copied to the new session before
the ID is rotated.
```

```
chore(deps): bump drizzle-orm to 0.37
```

**Do not** put AI tool names, co-authored-by lines, or metadata in the commit message. Write it like a human developer would — the change speaks for itself.