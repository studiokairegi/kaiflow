# KairFlow — Phase 1–7 audit: confirmed-bug fixes (KF-01, KF-02, KF-03)

## Scope
Source-only. No migration was executed, no database touched, nothing deployed, no email sent, no secret or setting changed.
Only the audit findings that are **confirmed defects in the code** were fixed. Missing features (OAuth, sync pipeline, second adapter, live
verification) are not bugs and are listed under "Not fixed" below.

## Fixed
### KF-01 — General Email depended on Intelligence authorization
* New migration `supabase/migrations/20261216090000_email_independent_access.sql` redefines `email_can_access(uuid)`, `email_has_access()` and
  `email_require_access()` from base tables (`user_settings.is_admin` AND active `studio_memberships.role = 'master_user'`). No `intel_*` call remains.
  The rule is identical today: nobody gains or loses access on apply.
* Multi-studio Master Users: studio choice now prefers a studio that already has an email account (was: one with `intel_settings`). Single-studio users unaffected.
* Browser: new `src/email/access.js` (`canAccessEmail`, `loadEmailAccess` -> `email_has_access`). `InboxModule.jsx` no longer imports Intelligence access.
  `App.jsx` holds a separate `emailAccess` state for the Inbox tab, Inbox render and unread polling; Intelligence keeps `intelAccess`.

### KF-02 — Shared Resend kill switch
* `email_adapter_resend.ts`: `legacyFlagKey: null`. General Email send and the Resend webhook are now gated only by `email_provider_registry.enabled`.
  `public.email_provider_flags` is no longer read by general Email; Intelligence's admin switch can no longer disable Email sending or inbound.
* **Operational change:** to pause general Email, set `email_provider_registry.enabled = false` for `resend` (SQL by the owner, as the registry migration documents).

### KF-03 / finding F — Webhook crossed the Intelligence boundary
* Intelligence delivery code moved out of `email_resend_store.ts` into `supabase/functions/_shared/intel_resend_delivery_sink.ts` (Intelligence-owned).
* `WebhookStore.applyIntelDeliveryEvent` is now **optional**; `resend-webhook/index.ts` plugs the sink in. General Email store/logic contain no `intel_*` table or RPC.
* `processDeliveryEvent` now attempts the CRM side and the Intelligence side independently. If either fails, the other has still run, then the error is
  thrown (HTTP 500, Resend retries). Both sides are idempotent. Previously a CRM failure skipped Intelligence entirely on that attempt.

## Tests
* JS: 978 / 978 passing (was 967; +11 in new `src/email/independence.test.mjs`).
* Updated tests that pinned the old coupling: shared-flag-gates-Email assertions (now assert the opposite), Inbox wiring, Intelligence sink location,
  migration-order lists.
* **Approval flag:** `resend-webhook/index.ts` was hash-pinned ("update only with explicit approval") in `dispatch-4b.test.mjs` and `phase-4f.e2e.test.mjs`.
  The KF-03 fix requires changing that file, so the pin was updated to `1a1efa7f669ff0fd5027ba7a745e5eeb878d0fb37d89228004caa622b95b9be2`. The other four pins are unchanged.
* Not run here: Python worker suite (sandbox lacks pytest/deps; no Python file changed), PostgreSQL execution of the new migration, Deno type-check, `vite build` (Vite not installed).

## Deliberately NOT changed (decision or scope needed)
* **DB-level suppression propagation:** `email_apply_delivery_event` (Phase 7 migration) still writes `intel_suppressions` for CRM bounces/complaints. This protects
  Intelligence contactability, so removing it changes behaviour. Decide whether to keep it as a deliberate one-way safety link.
* **KF-09 legacy Gmail/Zoho flags:** the table is Intelligence's (its admin switch and `provider_guard.ts` use it). General Email no longer reads it; removing rows/constraint
  needs Intelligence to get its own provider-control table first.
* **Fresh installs:** `20261110090000` still requires the Intelligence migrations to exist (historical file not edited). Run-time coupling is gone; install-order coupling remains until a squash.
* `InboxModule.jsx` still imports the generic `useLoad` hook from `intelligence/kit.jsx` (UI helper, not authorization).
* KF-04 (transactional notification isolation), KF-05 to KF-08 (OAuth, sync pipeline, second adapter, connect UI), KF-10 (missing Phase 1 report), KF-11 (live verification), KF-12 (migration dates): not code defects fixable here.

## Rollback
Run the rollback block at the bottom of `20261216090000_email_independent_access.sql`; revert `legacyFlagKey` to `"resend"`; restore the sink method into `email_resend_store.ts`.

## Files
New: `20261216090000_email_independent_access.sql`, `_shared/intel_resend_delivery_sink.ts`, `src/email/access.js`, `src/email/independence.test.mjs`, this report.
Modified: `_shared/email_adapter_resend.ts`, `_shared/email_resend_logic.ts`, `_shared/email_resend_store.ts`, `resend-webhook/index.ts`, `src/email/InboxModule.jsx`, `src/App.jsx`,
and tests `adapter`, `dispatch-4b`, `email`, `phase-4f.e2e`, `provider-foundation`, `intelligence-authorization`, `phase7-delivery-events-contract`, `phase7-resend-delivery-regression`, `v1-completion`.
