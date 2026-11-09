# Intelligence bug-fix handoff — 9 November 2026

## Implemented

1. **Steam self-publisher filter:** replaced the impossible `len(devs) == 0` condition with a case-insensitive set inclusion check. Third-party publishers are now rejected; self-published titles remain eligible.
2. **Multi-account inbound sync:** added account inventory and per-account cursor RPCs, account-scoped Gmail/Zoho adapter creation, namespaced provider message IDs, and idempotent classification enqueue.
3. **Registry enablement and safe fallback:** disabled/disconnected registry accounts are visible as non-receivable and cannot accidentally fall through to the legacy singleton mailbox. Account-scoped mailboxes continue to sync even when the legacy fallback provider is `none`.
4. **SMTP sync behavior:** SMTP is explicitly skipped by inbound synchronization because the adapter is send-only; users receive a clear reason instead of a missing-method/runtime error.
5. **Resend provider contract:** worker documentation now accurately states that Resend is not installed in the prospect provider registry and remains a separate transactional integration.
6. **Privilege guard ordering:** both historical Intelligence authorization migrations install the `user_settings.is_admin`/`plan` trigger before defining Intelligence authorization functions. The Phase 11 corrective migration remains in place for installations that already applied the historical sequence.
7. **Deployment documentation:** setup instructions now cover the full incremental migration history and Phase 13 deployment requirements.

## Validation

- Python worker suite: **482 tests passed**.
- JavaScript application suite: **831 tests passed**.
- SQL migrations: not executed in this environment (PostgreSQL/Supabase CLI unavailable).
- Frontend production build: not executed; `npm ci` timed out and Vite dependencies were not installed.
- Live Supabase, Edge Functions, Gmail/Zoho accounts, Windows controller and Task Scheduler: not accessed or changed.

## Remaining acceptance gates

- Apply migrations in staging, then run `docs/verify_live_database.sql` and the SQL authorization suite.
- Verify the live privileged-user trigger; source presence alone does not establish production state.
- Deploy the matching Edge Function and worker versions, then test all connected inboxes in staging.
- Calibrate the indie style-fit score with the business owner before changing scoring weights; the prior audit described this as a policy-calibration concern, not a proven code defect.
