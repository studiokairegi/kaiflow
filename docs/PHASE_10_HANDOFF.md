# KairFlow Intelligence — Phase 10 Handoff

**Phase:** 10 — Fix schema, migrations and email-provider integration  
**Status:** Local implementation and regression tests complete; disposable-PostgreSQL migration acceptance remains blocked by the absence of PostgreSQL/Docker in this environment.  
**Disposition:** Do not deploy or apply the migration to a live database based on these source-level checks alone.

## 1. Objective

Address M-01 migration/schema alignment, M-02 legacy mailbox prerequisite, M-03 Resend webhook-secret naming, M-08 mailbox status, and clarify provider authority in the actual worker.

## 2. What was inspected

- Intelligence migration history from initial singleton mailbox schema through dynamic provider registry, multi-account dispatch, SMTP, Zoho policy, provider-assignment integrity, delivery events, final send boundary and Phase 9 source registry.
- `intel_admin_set_kill_switch` definitions and final send gate.
- `intel_admin_mail_status`, provider-account admin RPCs and Settings/Overview status UI.
- `intel-resend-webhook`, shared Resend webhook logic and Resend setup documentation.
- Worker `mailops.py`, `providers/router.py`, provider registry and OAuth result messaging.

## 3. Changes

### M-01 — additive schema alignment

Added `20261130100000_intelligence_phase10_schema_provider_alignment.sql`. It checks that the provider registry exists before applying, then idempotently adds provider-account metadata columns consumed by account-management/status code where a partial older table may lack them. It does not drop data or replace credentials.

This is an additive source-level schema repair. It is **not** a claim that all historical production migration states have been proven equivalent; that requires replay against a disposable PostgreSQL database.

### M-02 — legacy mailbox prerequisite / provider authority

The new final `intel_admin_set_kill_switch` definition no longer depends on the legacy singleton `intel_mail_account` row. Before lifting the emergency stop, it requires sender/compliance details, registered agent identity, and at least one connected, enabled, send-enabled Gmail/Zoho/SMTP account with its deployment-owned provider sending gate enabled.

The final Phase 8 send gate remains stricter and independently validates the exact message account immediately before provider submission. No provider gate was enabled by this phase.

### M-03 — Resend webhook secret

Verified and regression-tested that both the Intelligence inbound Resend webhook and shared transactional webhook logic read `RESEND_WEBHOOK_SECRET`, matching `docs/RESEND_EMAIL_SETUP.md`. No secret values were read or exposed.

### M-08 — mailbox status

The admin mail-status RPC now reports the dynamic provider-account registry as its source of truth, including multiple account statuses. The legacy singleton is returned only as a labelled migration bridge when no registry accounts exist. The UI label now handles multiple accounts without pretending they are one Zoho mailbox.

Resend is not a mailbox adapter and is not represented as a connected Gmail/Zoho/SMTP mailbox. It remains a separate transactional-email integration.

### Worker authority

Updated Gmail/Zoho OAuth success messages: operators are no longer told to set `KAIRFLOW_MAIL_PROVIDER` to choose prospect-outreach sends. Outbound messages use durable `provider_account_id` + `provider_key` assignment and `DynamicProviderRouter`; partial assignments fail closed. The configured legacy/default adapter remains only for non-message mailbox jobs during migration compatibility.

### Zoho-versus-Resend responsibility report

Added `docs/PHASE_10_PROVIDER_RESPONSIBILITY.md`. It documents prospect outreach, human approval, inbound reply, delivery-event and transactional-email responsibilities. No integration was removed.

## 4. Files changed

- `supabase/migrations/20261130100000_intelligence_phase10_schema_provider_alignment.sql` (new)
- `src/intelligence/logic.js`
- `src/intelligence/gmail-provider.test.mjs`
- `src/intelligence/phase10-provider-schema-contract.test.mjs` (new)
- `docs/PHASE_10_PROVIDER_RESPONSIBILITY.md` (new)
- `docs/PHASE_10_HANDOFF.md` (new)

## 5. Verification

- Full JavaScript suite (`npm test`): **1,600 passed, 0 failed**.
- Targeted Phase 10 + provider regression tests: **14 passed, 0 failed**.
- Full Python worker suite: **442 passed, 0 failed**.
- Python compilation: passed.
- The Python suite's optional live preflight emitted environment diagnostics in a separate probe (including missing/inconsistent Ollama capabilities and one missing live RPC signature); the unit-test runner itself completed `OK`.
- Frontend production build: not run successfully; `vite` is not installed in this checkout.
- PostgreSQL migration execution: not performed; neither `psql` nor Docker is available. The SQL migration has source-level contract coverage only, not a disposable-database execution result.

## 6. Remaining acceptance work

1. Replay the complete Intelligence migration sequence in a disposable PostgreSQL/Supabase database, including the new Phase 10 migration.
2. Test both a clean install and a database with legacy `intel_mail_account` rows plus partially populated provider-account records.
3. Verify the final `intel_admin_mail_status` output for zero, one and multiple provider accounts, and legacy-only state.
4. Verify the kill switch refuses release without an eligible dynamic account and succeeds only when the deployment provider gate and account gates are explicitly enabled in the disposable test database.
5. Run frontend production build in an environment with project dependencies installed.
6. Confirm deployed Edge Function secrets by configuration metadata only; never print or retrieve secret values.

## 7. Safety confirmation

- No migration applied to any database.
- No production or staging data changed.
- No provider account connected, enabled or activated.
- No credentials, API keys or webhook secret values accessed or changed.
- No Edge Function deployed.
- No worker activated or restarted.
- No autonomy or kill-switch setting changed.
- No Git push or production deployment.
- No real email sent.
- Zoho human approval and Phase 8's global explicit-human-approval gate remain intact.
- Resend remains excluded from prospect outreach.

## 8. Stop condition

Phase 10 local implementation is complete, but database acceptance is outstanding. Stop here. **Phase 11 — Security and controller hardening** is the next roadmap phase and requires separate authorization.

## Phase 10 corrective bugfix pass (2026-11-08)

Fixed the confirmed Settings/provider-authority defects:
- Removed the legacy single-mailbox `AccessCard` from Intelligence Settings. The dynamic `ProviderAccountsCard` is now the only mailbox connection/account-management UI; this removes conflicting singleton reconnect/disconnect controls and stale `KAIRFLOW_MAIL_PROVIDER` instructions.
- Strengthened the Phase 10 migration preflight. Before additive column repair, it now verifies the provider registry's non-fabricable identity/relationship columns exist and emits an actionable exception directing operators to restore the canonical Phase 2 provider-registry schema if they do not.
- Updated the existing Settings contract test and added regressions for the dynamic-only UI and migration preflight.

Corrective validation:
- JavaScript suite: 1,602 passed, 0 failed.
- Python worker suite: 442 passed, 0 failed (`PYTHONPATH=intelligence-worker python -m unittest discover -s intelligence-worker -t intelligence-worker -p 'test*.py'`).
- Python compileall: passed.
- The worker live preflight emits environment-dependent Ollama/RPC probe failures in this environment; those probes are not part of the 442-test unit suite.
- PostgreSQL migration execution remains unverified because no disposable PostgreSQL runtime is available. Do not apply this migration to production based only on source-level tests.
- Frontend build remains unverified because Vite is not installed in this runtime.

No deployment, migration execution, provider activation, credential access/change, worker restart, production data modification, or email send was performed.
