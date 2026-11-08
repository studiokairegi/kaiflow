# Phase 2.6 — SMTP submission adapter foundation

## Included

- Added a reviewed, code-installed `smtp` adapter to the same provider registry used by Gmail and Zoho.
- Added an account-scoped SMTP submission client supporting implicit TLS (465) and STARTTLS (587) only. Plaintext SMTP is rejected.
- Added a Settings account-connection form and an admin-only Edge Function that encrypts credentials before saving them in `intel_provider_accounts` with `auth_method=smtp_password`.
- Added worker-only credential retrieval through the existing scoped token endpoint. SMTP passwords are returned only to the authenticated Intelligence worker and are cached in memory briefly; never exposed in account inventory or browser responses.
- SMTP accounts start with sync and sending disabled, business correspondence only, and conservative 25/day, 5/hour, 1/minute quotas. Provider-wide sending remains OFF.
- Sender address must match the authenticated mailbox. Header injection is rejected. TLS certificate validation uses the platform trust store. SMTP hostnames resolving to non-public IP addresses are rejected to reduce SSRF risk.
- Preserves RFC Message-ID, In-Reply-To and References headers for outbound messages.
- SMTP is send-only. It does not implement inbox sync, IMAP, Sent-folder search or provider-side message reconciliation. Uncertain SMTP outcomes remain unknown and are never automatically resent.
- Resend remains excluded from the prospect dispatcher.

## New deployment files

- `supabase/migrations/20261125100000_intelligence_smtp_adapter.sql`
- `supabase/functions/intel-provider-smtp-connect/index.ts`

Apply the migration only after reconciling hosted Supabase migration history. Deploy the Edge Function and the updated `intel-provider-token` function together. Ensure `INTEL_TOKEN_ENCRYPTION_KEY` is configured. No production migrations, Edge Functions, credentials, or provider settings were changed during local implementation.

## Operational caveats

- The account connection stores configuration; it does not perform a live SMTP login test. Account health remains unknown until a separately authorized connection-test workflow is run.
- SMTP providers vary in authentication policy, sender aliases and rate limits. Use an app-specific password where supported, and ensure the authenticated mailbox matches the configured sender.
- A network interruption after SMTP DATA can be ambiguous. KairFlow records the message as unknown and requires manual/provider-side verification rather than risking duplicate delivery.
- SMTP has no standardized Sent API. IMAP and Sent reconciliation are intentionally deferred; SMTP accounts should not be used for workflows requiring automatic inbound reply synchronization until that later adapter exists.
- Public DNS resolution checks reduce SSRF exposure but do not replace network egress allowlisting at deployment. Restrict worker outbound SMTP destinations to approved hosts where possible.

## Verification

- Python worker suite includes SMTP adapter tests for STARTTLS, sender identity, header injection, account scoping, private-address rejection, and conservative unknown-outcome reconciliation.
- JavaScript repository suite remains part of regression verification.
- No live SMTP connection or email send was performed. SQL migration, Edge Function deployment/type-check, and frontend production build remain unverified without the corresponding deployment toolchain and credentials.
