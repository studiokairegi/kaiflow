# Finance V3 database tests

Phase 1 ships no SQL tests (no V3 database objects exist yet). Conventions for Phase 2+:

* One file per area: `ledger.test.sql`, `rls.test.sql`, `posting_concurrency.test.sh`, ...
* Run against a **disposable** PostgreSQL 16 / local Supabase instance, never against production.
* Each SQL test file runs inside `begin; ... rollback;` and uses `do $$ ... assert/raise exception ... $$` so any failure aborts with a non-zero exit (`psql -v ON_ERROR_STOP=1`).
* Impersonate users with `set local role authenticated; set local request.jwt.claims = '{"sub":"<uuid>"}';` to exercise RLS honestly. Never test RLS as the table owner.
* Concurrency tests (parallel posting, duplicate idempotency keys) need several psql sessions; use a shell driver.
* The existing `supabase/tests/run.sh` harness (payments) is the pattern to copy: bootstrap stubs -> `schema.sql` -> app table stubs -> migrations in order.
* Record the exact command and the real output in the phase handoff. A test that was not run is reported as "not run".
