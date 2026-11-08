# Phase 2.8 — Production integration and acceptance

## Local hardening completed

- Removed the organization-admin UI action that could mutate the global `intel_email_provider_registry.sending_enabled` flag.
- The provider gate is now displayed read-only in Intelligence Settings with an explicit deployment-owner control label.
- Removed the browser API wrapper for the global provider gate RPC.
- Added migration `20261126090000_intelligence_provider_gate_owner_only.sql`, which drops the tenant-callable global-gate RPC and reasserts OFF for Gmail, Zoho and SMTP during initial rollout.
- Added read-only target-database assertions at `supabase/verification/phase2_8_provider_acceptance.sql`.
- Added regression coverage for the global-gate boundary.

## Why this was required

`intel_email_provider_registry` is a global catalogue, not organization-scoped. The previous `intel_admin_set_provider_sending_enabled` RPC authenticated an organization administrator but updated the global provider row. That meant one tenant administrator could affect the provider-wide gate for other organizations. The RPC is removed. Organization administrators retain only account-level controls scoped by `organization_id`; provider-wide activation remains a deployment-owner operation.

## Deployment is NOT performed by this workspace

This repository snapshot has no `supabase/config.toml`, no project reference, and no configured Supabase CLI or Deno runtime. No database connection, project credentials, OAuth client secrets, or deployment authorization were supplied. Therefore no migration was applied, no Edge Function was deployed, no OAuth connection was started, and no worker was restarted.

The migration filenames in this snapshot run through `20261126090000`, while the audit date is 2026-11-08 and the preceding repository history already contains future-dated migrations. Do not rename or reorder them based on local assumptions. First compare `supabase migration list --linked` with the hosted `supabase_migrations.schema_migrations` ledger and resolve any version collisions or missing versions with the project owner.

## Required target-environment sequence

1. Back up the production database and record the currently deployed application and worker versions.
2. Confirm the hosted migration ledger and reconcile all versions from `20261124090000` through `20261126090000`. Apply only the missing, reviewed migrations in order; do not blindly push the whole folder.
3. Configure secrets for the generic provider OAuth functions: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `INTEL_TOKEN_ENCRYPTION_KEY`, `APP_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, and `ZOHO_REDIRECT_URI`. Keep the legacy Gmail/Zoho redirect endpoints until old connections have been verified against the new path.
4. Deploy `intel-provider-connect`, `intel-provider-callback`, `intel-provider-token`, and `intel-provider-smtp-connect`. Deploy the OAuth callback with JWT verification disabled because the identity provider redirects without a Supabase bearer token; the callback must continue to validate its short-lived, single-use OAuth state and initiating user authorization. Do not disable JWT verification on connect or token endpoints.
5. Run `supabase/verification/phase2_8_provider_acceptance.sql` against the target database while all provider and account sending gates are OFF.
6. Run the deployed Edge Function auth/authorization tests and connect one non-production Gmail account, one Zoho account in the correct data center, and one test SMTP mailbox if available. Verify account identity, credential encryption, account isolation, token refresh, account disable/disconnect and error handling. Do not send email during this step.
7. Deploy the matching worker build with `KAIRFLOW_MAIL_PROVIDER` and `KAIRFLOW_MAIL_ACCOUNT_ID` configured only for the designated test account. Confirm the worker receives only that account's credentials and cannot retrieve another organization's account.
8. Verify that disabled global provider gates, disabled account flags, kill switch, recipient-purpose policy, human approval, global caps and per-account quotas each independently block dispatch.
9. Verify durable account assignment, retries, provider message IDs, Sent reconciliation for Gmail/Zoho, and manual resolution for ambiguous SMTP outcomes. Do not auto-retry unknown SMTP outcomes.
10. Only after sign-off, enable one test mailbox for a narrowly scoped business-correspondence test. Keep prospecting disabled unless documented recipient-specific consent is present and the organization explicitly authorizes that purpose.

## Acceptance criteria

- No tenant administrator can mutate the global provider gate.
- Client roles cannot directly read provider credentials, OAuth state, usage ledger or recipient permission evidence.
- Provider accounts remain disabled by default and are isolated by organization.
- Gmail, Zoho and SMTP token retrieval is scoped to the authenticated worker and account ID.
- Resend remains outside the prospect dispatch registry.
- No duplicate delivery occurs after an ambiguous SMTP outcome.
- Kill switch and all global/account-level controls are checked immediately before provider submission.

## Verification in this workspace

- Python worker suite: 398 passed.
- JavaScript repository suite: 770 passed.
- Python compilation: passed.
- SQL acceptance script added, but not executed against a database.
- Frontend production build not run: `node_modules` is absent (Vite is not installed in this workspace).
- Supabase migration execution, Edge Function deployment/compilation and live provider tests remain unverified.
- No environment variables, production credentials, provider gates, connected accounts or outbound messages were changed.


## Phase 2.8.1 bug-fix addendum

The follow-up patch adds `20261126093000_intelligence_provider_policy_human_review.sql`. It enforces the intersection of each provider manifest's supported message purposes and each account's allowed purposes at assignment and immediately before sending. Zoho prospecting is supported only as a human-reviewed path: automatically approved Zoho initial/follow-up messages are returned to `pending_approval`, the send slot is released, and the explicit admin approval RPC clears the automatic-send marker and queues a fresh send job. The same rule covers the legacy singleton Zoho connection. Recipient-specific consent remains mandatory.

The worker router now permits legacy fallback only when both durable assignment fields are absent; a partial assignment fails closed. SMTP host validation now returns the resolved public IP set and the built-in SMTP transports connect to a validated IP directly, retaining the original hostname for TLS verification/SNI and avoiding a second DNS lookup.

Regression verification after this addendum: 772 JavaScript tests passed; 402 Python tests passed; Python compileall passed. These are local tests only. The SQL migration still requires reconciliation against the hosted Supabase migration history and execution in the target environment before deployment.

The read-only target-database checks for the follow-up patch are in `supabase/verification/phase2_8_1_policy_acceptance.sql`.

## Phase 2.8.1 / 2.8.2 recheck additions

- Zoho initial/follow-up messages that were auto-approved by autonomy are returned to `pending_approval` in the account-assignment RPC, before the account-usage quota row is inserted. The final `intel_agent_mark_sending` guard remains as defense in depth. The explicit admin review RPC clears `auto_sent` only after an administrator approves the exact message and enqueues a fresh send job.
- Provider purpose checks use the intersection of the provider registry manifest and the organization account's `allowed_message_purposes` at assignment and immediately before sending.
- A database trigger rejects partial account assignments and assignments whose account ID, organization, and provider key do not match. The worker router independently rejects half-populated assignments rather than falling back to a legacy mailbox.
- SMTP DNS resolution is pinned to the validated public IP for the connection; TLS still verifies the configured hostname.

The new integrity migration is `20261126100000_intelligence_provider_assignment_integrity.sql`. Apply migrations in repository order only after reconciling the hosted migration history. This package has not been tested against a live Supabase database or real mail provider.
