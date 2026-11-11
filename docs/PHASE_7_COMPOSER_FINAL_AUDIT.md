# Manual Lead Email Composition — Phase 7: Final Audit & Deployment Preparation

**Baseline:** `00_repo_34_phase6-security.zip` (Phases 1–6)
**Status:** Review complete. **Not deployed. No migration applied. No real email sent. No production change.**
**Verdict:** Deployment approval remains withheld. SQL migration-chain validation, production build, browser acceptance, and Git review remain outstanding.

> Not to be confused with the older `PHASE_7_*` files in `docs/`, which belong to the Intelligence roadmap.

## 1. Blockers before merge or deploy

| # | Blocker | Action |
|---|---|---|
| B1 | The earlier audit reported a Paystack live-key file in a working folder. That exact file is **not present in the latest Phase 6 archive inspected for this correction**. | Check the original local working copy and any separately shared archives. Rotate the key only if it was actually exposed; keep live keys in Supabase secrets, never in source archives. |
| B2 | **SQL test files have never run against the real migration chain** (no PostgreSQL in the review environment; the repo's own runner fails at its baseline). | Run the `supabase/tests/email_*.test.sql` files on a staging database after applying every migration, plus a two-user cross-organization check. |
| B3 | **`npm run build` has not run** (no `node_modules`, no network). | Run `npm ci && npm test && npm run build` in CI or locally. |

## 2. What was reviewed

**Git diffs.** The supplied archive has no `.git` directory. Therefore the current branch, commit history, origin/main comparison, feature branch, remote, and pull-request state cannot be independently verified. The zero-byte root files named `git` and `main` are ordinary empty files, not repository metadata or branch references. Do not treat `feature/lead-email-composer` as an existing branch until it is verified in the original working repository. The original Phase 1–5 diffs are not recoverable from this archive.

**Composer code paths (read in full or by targeted audit):** `src/email/lib/logic.js` (compose eligibility, sender gating, timeline merge), `src/App.jsx` (Compose button, timeline refresh, Open email), `supabase/functions/email-send` and `_shared/email_resend_logic.ts` / `email_resend_store.ts`, the sixteen composer-family migrations, and the credential vault.

**Syntax check.** A TypeScript parse of 133 client JS/JSX files and the email Edge Function sources found **0 syntax errors**. This is a parse, not a build.

**Tests.** I independently ran `npm test` from this extracted workspace: **1,029 passed, 0 failed**.

## 3. Migrations and rollback

The previous inventory was incomplete: it stopped at `20261221090000` and omitted three later composer migrations. The corrected full sequence, prerequisite set, transaction notes, separate Intelligence migration warning, and rollback guidance are maintained in [`PHASE_7_DEPLOYMENT_MANIFEST.md`](PHASE_7_DEPLOYMENT_MANIFEST.md).

The composer family contains **16 migrations**, not 13. The omitted files are:

- `20261220100000_email_provider_sender_safety.sql`
- `20261222100000_email_composer_send_crm_fixes.sql`
- `20261223100000_email_crm_timeline_reconciliation.sql`

The last migration now has a dedicated rollback script at `supabase/rollback/20261223100000_email_crm_timeline_reconciliation.rollback.sql`. Rollback requires redeploying the prior webhook function first because the current store calls the RFC wrapper introduced by that migration. The rollback does not delete email/CRM rows, but it does not reverse timeline entries already reconciled.

**Critical deployment rule:** `supabase db push` applies all pending migrations in the repository, not only the composer family. Check `supabase migration list --remote` and `supabase db push --dry-run`; stop if unrelated or unapproved Intelligence migrations are pending. No remote migration history was available in this audit, so the target's actual pending set is unknown.

The rollback of `20261208100000_email_crm_activity.sql` remains destructive: it drops CRM email attribution storage and `email_messages.crm_lead_id`. Prefer a forward fix and take a backup before any rollback. The sender-safety migration `20261220100000` should not be rolled back casually because doing so removes server-side send-capability validation and exposes the old account RPC behavior.

## 4. Final security audit (cumulative, Phases 1–7)

Confirmed in Phase 6 and re-checked: RLS on all 14 email tables with no client write grants; credential, OAuth-state, sync and webhook tables are service-role only; every `SECURITY DEFINER` function pins `search_path`; server-only functions are not executable by clients; every browser RPC requires access and scopes by organization; lead ownership is enforced in both the Edge Function and the database; provider tokens never reach the browser; sends are idempotent and a failed or unknown send never writes a CRM activity.

Phase 7 additions:
- **JWT settings.** `email-send` is not listed in `supabase/config.toml`, so it keeps `verify_jwt = true`, and it also authenticates and checks access itself. `resend-webhook` is `verify_jwt = false`, which is correct because it verifies the Svix signature before any database work.
- **Compose button.** Shown only when the lead qualifies **and** `email_has_access()` returned `true`. Hiding is a convenience; the server enforces access independently.
- **No new secrets needed.** The email functions read `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, and optionally `EMAIL_DAILY_LIMIT`, `EMAIL_THREAD_TOKENS`, `EMAIL_INBOUND_DOMAIN`, plus the standard Supabase variables.

Open items (none blocks the feature, all should be tracked):
- **OAuth connection gate:** the current `email-send` path checks `resolved.row.capabilities.oauth` and rejects any account whose `connection_status` is not `connected`. The earlier F1 finding is stale and is not an outstanding defect.
- **Account error-field exposure:** migration `20261220100000_email_provider_sender_safety.sql` removes `last_connection_error` from both `email_list_accounts()` and `email_upsert_account()` responses. The earlier F3 note is addressed in the current migration set.
- **F4 (info):** CORS is `Access-Control-Allow-Origin: *` on email functions. Acceptable for bearer-token APIs (no cookies); an origin allowlist is optional hardening.
- **F5:** `npm audit` / dependency review was not possible offline.
- **Repo hygiene:** zero-byte files named `git`, `main`, `supabase.cmd` and a duplicate `FIXES_APPLIED - Copy.md` sit in the repo root; `kairegi-working-changes.patch` and similar patch files are checked in. Clean up in a separate change.

## 5. Desktop and mobile

Reviewed statically only; **no browser was available.** `index.html` declares `viewport-fit=cover`. The Inbox CSS has breakpoints at 760 px and 480 px, the composer's two-column rows collapse to one column at 480 px, and no fixed pixel widths of 100 px or more were found in the Inbox styles. **Do a manual pass** at roughly 375, 768 and 1280 px: open a lead card, tap Compose, send, return to the lead, tap Open email.

## 6. Deployment requirements

1. **Before anything:** rotate the Paystack key (B1) if applicable; take a database backup.
2. **Staging first.** Follow the complete sequence and prerequisites in `docs/PHASE_7_DEPLOYMENT_MANIFEST.md`; run the SQL test files; confirm `select * from email_provider_registry` shows `resend` enabled. Review every pending migration because `db push` includes the entire pending local set.
3. **Edge Functions:**
   ```
   supabase functions deploy email-send
   supabase functions deploy resend-webhook --no-verify-jwt
   ```
   `email-send` must **not** use `--no-verify-jwt`.
4. **Secrets** (only if not already set): `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, optional `EMAIL_DAILY_LIMIT`, `EMAIL_THREAD_TOKENS`, `EMAIL_INBOUND_DOMAIN`.
5. **Recovery job:** verify whether `pg_cron` was enabled when `20261220090000_email_crm_recovery_schedule.sql` ran. If it was not, enable it and deliberately re-run that migration or schedule `select public.email_recover_crm_activities(100);` every ~10 minutes.
6. **Frontend:** `npm ci && npm test && npm run build`, then deploy `dist/`.
7. **Smoke test with no prospect contact.** Create a test lead whose email is an address you own (or Resend's `delivered@resend.dev`), click Compose, pick a sender, send. Confirm: the message appears in Sent, the lead timeline shows an **Email** entry, **Open email** jumps to the conversation, a repeat of the same send makes no duplicate, and a reply from your own address appears on the lead timeline within about 30 seconds.
8. **Rollback plan:** redeploy the previous function versions and frontend build first (fully safe, no data loss). Use database rollback only per section 3 and only after a backup.

## 7. Pull request

A draft description is in `docs/PULL_REQUEST_COMPOSER.md`. `feature/lead-email-composer` is only a proposed branch name in the supplied documentation; the ZIP has no `.git` directory, so no branch or commits are verified. Nothing was pushed and no pull request was created. Restore/open the original Git working copy, inspect `git status` and `git diff`, then create or verify the feature branch there.

## 8. Final objective check

> Manually create a CRM lead, click Compose, select a connected sender account, send through the existing Inbox, and automatically see the confirmed email in both Inbox and the correct lead's timeline.

Every step is implemented and covered by automated tests against fakes (compose eligibility, sender selection, send, CRM recording, timeline merge, inbound reply linking). **It has not been exercised end to end against a live database and provider**; step 7 above is that acceptance test. The build, SQL execution, browser/mobile pass, and Git diff review are still required before deployment approval.
