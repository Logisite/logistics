# TODO — verification before next phase

Run these **outside opencode** (2.7 GiB box, one at a time):

```bash
bash scripts/check.sh
cat scripts/outputs/check.log
```

```bash
bash scripts/test-api.sh
cat scripts/outputs/test-api.log
```

Single-socket mode: tests use PGlite (`test-pgdata/`) unless `DATABASE_URL` is set.
Real-PG parity (optional nightly):
```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/logistics bash scripts/test-api.sh
```

Expected: `check.sh` exit 0 (scoped `tsc --noEmit` + `eslint --max-warnings 0`), `test-api.sh` 80+ tests green including `runs.dispatch.test.ts` 7/7 (dispatcher build, field lock ADMIN-only, duplicate guard, ineligible status, self-claim, cancel-while-active releases lock, non-dispatcher rejected).

Next issues queued (one at a time):
- 12 sync server (per-device FIFO, sole-writer, `shipment_events` dedup redesign)
- 10a already closed (6a4b704), 10 closed by this commit
