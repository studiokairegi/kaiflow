# KairFlow shared-account gateway + Gmail/Zoho Inbox adapters

Date: 2026-11-12

## Scope

SMTP/IMAP remain deferred by owner decision. This phase uses only the existing Gmail and Zoho accounts connected through Settings/Intelligence. It does not add an OAuth connection flow or another credential store.

## Implemented

1. **Shared provider access-token resolver** (`supabase/functions/_shared/intel_provider_oauth.ts`)
   - Looks up `intel_provider_accounts` by the exact account UUID, organization UUID and provider key.
   - Requires the account to be connected and enabled.
   - For sending, also requires the existing organization provider gate, provider `sending_enabled`, account `send_enabled`, and `business_correspondence` in both the account allow-list and provider manifest.
   - Decrypts the existing Intelligence credential ciphertext using the existing key and OAuth adapter.
   - Refreshes Gmail/Zoho access tokens using the existing OAuth client configuration and Zoho data-center selection.
   - Updates account health on refresh success/failure.
   - Returns only a short-lived access token and non-secret mailbox/API metadata. It never copies refresh tokens to `email_provider_credentials` or exposes tokens to browser code.

2. **Gmail Inbox send adapter** (`email_adapter_gmail.ts`)
   - Uses Gmail API `users/me/messages/send` with MIME encoding.
   - Includes RFC Message-ID, In-Reply-To and References headers.
   - Preserves Gmail provider thread IDs for subsequent replies.
   - Supports the current composer attachment payload format.
   - Treats 429/5xx/network ambiguity as unknown and never automatically resubmits a potentially accepted message.

3. **Zoho Inbox manual-send adapter** (`email_adapter_zoho.ts`)
   - Uses the existing Zoho account UUID, external account ID, OAuth refresh token and regional API base.
   - Sends user-initiated business correspondence only.
   - Uses the stored provider-native parent message ID for native replies; refuses to downgrade a malformed/unavailable reply to a new unthreaded message.
   - Refuses replies to an outbound parent rather than replying to the sender's own sent message.
   - Fails closed on attachments until Zoho attachment upload is implemented and verified.
   - Treats 429/5xx/network ambiguity as unknown and never automatically resubmits.

4. **Paginated mailbox receive/sync adapters**
   - Gmail reads the existing mailbox through paginated INBOX and SENT label scans and normalizes RFC headers, body parts, attachment metadata, unread state and provider thread IDs.
   - Zoho discovers Inbox/Sent folders, pages message summaries with a bounded overlap checkpoint, retrieves message content and best-effort headers, and normalizes provider metadata. A content-fetch failure fails the page rather than silently ingesting an empty message.
   - Both adapters use the shared token resolver and the existing mailbox sync runner/store for leases, checkpoint persistence, idempotent message ingestion and conversation association.
   - These are paginated scans, not yet provider-native incremental/delta synchronization: Gmail History API checkpoints and Zoho change cursors are not implemented. Attachment bytes are not yet downloaded.

5. **Inbox send wiring**
   - `email-send` resolves the provider from the database account row and injects the shared token resolver.
   - Account organization and connection state remain server-checked.
   - Successful provider thread IDs are persisted in the existing message headers JSON for future threading.
   - The thread-parent RPC now returns the provider message ID, provider thread ID and parent direction, scoped to the exact organization, conversation and account.

6. **Registry migration**
   - Adds `20261228110000_email_provider_gmail_zoho_send_gateway.sql`.
   - Enables only the reviewed send operation for Gmail and Zoho in the central Inbox registry.
   - Leaves mailbox sync, remote search, folder operations, attachment retrieval, drafts, read-state and delivery events disabled until live acceptance and delta-sync completion.
   - Keeps SMTP/IMAP deferred and Resend excluded from Inbox/outreach.
   - Does not alter account identity or credentials.

## Confirmed bug fix in follow-up audit

- Fixed Zoho sync terminal-checkpoint recovery: an empty saved folder list now triggers folder rediscovery on the next run. A regression test covers completing Inbox/Sent and starting a subsequent sync from the terminal checkpoint. See `GATEWAY_CONFIRMED_BUGFIX_REPORT_2026-11-12.md`.

## Automated verification

- Node suite: **1,057 passed, 0 failed**.
- Python worker suite: **754 passed, 0 failed** (`python -m unittest discover -s tests -t .`).
- Targeted strict TypeScript check of the shared adapter, OAuth and send-service modules: **passed**.
- Added tests for Gmail MIME/threading and paginated INBOX/SENT sync, Zoho regional API send and paginated folder sync (including restart after terminal checkpoint), native reply routing, refusal of unsafe Zoho reply parents, Zoho attachment fail-closed behavior, content-fetch failure handling, organization-scoped token lookup and Zoho manual-purpose enforcement.

## Not yet complete / not verified

- Paginated Gmail and Zoho receive/sync adapters are implemented and covered by mock tests, but the database registry deliberately keeps sync/folder capabilities disabled pending live acceptance. Native incremental/delta synchronization remains incomplete (Gmail History API; Zoho change cursor).
- Full search, archive/move, draft, forward, attachment retrieval and attachment sending for Zoho remain incomplete. Read/unread reconciliation is only as reliable as the provider fields returned in each scan.
- The Gmail/Zoho APIs have not been tested against live connected mailboxes in this environment. These are implementation tests, not live-provider acceptance tests.
- The new SQL migration has not been applied to staging or production.
- Edge Functions have not been deployed; no production worker or gateway health was checked.
- `npm run build` could not run because `node_modules/vite` is unavailable. `npm ci --ignore-scripts --no-audit --no-fund` timed out before installing dependencies.
- Deno CLI, Supabase CLI and a PostgreSQL client were unavailable, so Deno runtime checks and migration execution were not run.

Do not describe the overall KairFlow email/outreach system as production-ready until mailbox synchronization, remaining Inbox operations, campaign E2E checks, deployment and live Gmail/Zoho acceptance are completed.
