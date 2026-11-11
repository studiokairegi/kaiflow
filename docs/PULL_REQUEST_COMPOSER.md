# feat(crm-email): manual lead email composition with CRM tracking

**Proposed branch:** `feature/lead-email-composer` → `main` (must be verified/created in the original Git repository; the supplied ZIP has no `.git` metadata).

## Summary
Lets a signed-in studio member click **Compose** on a CRM lead card, pick a sender account, send through the existing Inbox, and see the confirmed email in both the Inbox and that lead's activity timeline. Inbound replies on a linked conversation also appear on the lead timeline.

## What it does
- **Sender accounts:** real accounts from `email_accounts`; paused, disabled, unknown, or unconnected-OAuth accounts cannot be selected.
- **Compose from CRM:** button only for saved, active, user-owned leads with a valid email; opens the existing Inbox composer with recipient and lead id prefilled.
- **Send and track:** reuses the provider adapter send path; the CRM activity is written only after the provider accepts the message; idempotent request keys prevent duplicates; a CRM write failure is recoverable (`pending`, then automatic recovery) and never causes a second send.
- **Inbox ↔ CRM sync:** sent mail shows in Sent; replies keep the conversation's lead; timeline shows **Email** entries with **Open email**; the open lead refreshes every 30 s.

## Security
RLS on all email tables with no client writes; credentials in a service-role-only encrypted table; every definer function pins `search_path`; lead ownership enforced in the Edge Function and in the database; no provider secret reaches the browser. 23 automated tests in `src/email/phase6-security.test.mjs` guard this (the Phase 6 follow-up reports 23/23 passing).

## Not touched
KairFlow Intelligence AI routing, campaigns, autonomy settings, kill switch, and global email safety controls.

## Migrations (apply in order; see `docs/PHASE_7_COMPOSER_FINAL_AUDIT.md` §3)
The complete composer-family sequence contains 16 migrations, from `20261204090000_email_provider_registry.sql` through `20261223100000_email_crm_timeline_reconciliation.sql`, after the Email core and hardening migrations. See `docs/PHASE_7_DEPLOYMENT_MANIFEST.md` for prerequisites, the complete sequence, separate Intelligence migrations, and rollback guidance. Rolling back `20261208100000` deletes CRM email attribution data; back up first.

## Deployment
`supabase functions deploy email-send` (JWT verification stays on) and `supabase functions deploy resend-webhook --no-verify-jwt`; no new secrets required. Full runbook: audit doc §6.

## Test evidence
- `npm test`: 1,029 passed, 0 failed in the Phase 6 follow-up; rerun before merge.
- TypeScript syntax parse of 133 client files and the email functions: 0 errors.
- **Not run:** SQL tests against the real migration chain, `npm run build`, a browser/mobile pass, a live provider send.

## Known limitations
- Replies received before the timeline migration or before a lead link are not backfilled.
- Timeline refresh is polling (30 s), not instant.
- The current send path enforces `connection_status === "connected"` for OAuth-capable providers. The automated suite covers this gate; live OAuth-provider integration remains unverified.
- A teammate's lead cannot be emailed by another user (leads are per-user); the UI hides Compose.

## Reviewer checklist

- [ ] Verify the actual Git branch and diff in the original `.git` working copy; no branch/commit/PR is asserted by the supplied ZIP.
- [ ] Paystack key rotated and `paystack-live.env.txt` removed from every working copy
- [ ] SQL tests pass on staging after the approved migration set
- [ ] `npm ci && npm test && npm run build` green in CI
- [ ] Manual smoke test with an owned address (no prospect email)
- [ ] Mobile check at ~375 / 768 / 1280 px
