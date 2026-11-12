# KairFlow Email / Outreach Scope Decision — SMTP/IMAP Deferred

Date: 2026-11-12

## Decision

SMTP and IMAP are explicitly out of scope for the current implementation and acceptance cycle. Do not spend implementation or verification effort on SMTP/IMAP in this cycle, and do not treat their absence as a blocker to completing the Gmail + Zoho scope.

This is a deferral, not a removal of the existing SMTP code, settings, account records, credentials, migrations, or historical data. Preserve those assets and avoid destructive migrations. Revisit SMTP/IMAP only when the owner explicitly reopens that scope.

## Active provider scope

| Provider | Current permitted use | Current implementation priority |
|---|---|---|
| Gmail | Manual correspondence, mailbox management, prospecting and automated outreach | In scope; complete and verify |
| Zoho | Manual business correspondence only | In scope; complete and verify |
| SMTP | None in this cycle | Deferred |
| IMAP | None in this cycle | Deferred with SMTP |
| Resend | Existing unrelated transactional email only; excluded from Inbox and outreach | Preserve existing separation |

## Non-negotiable constraints retained

- Settings/Intelligence remains the single source of truth for connected email accounts.
- Inbox and outreach reuse the same account UUIDs, ownership and credential lifecycle; no second connection flow or credential vault.
- Provider credentials remain server-side and must never reach browser code.
- Zoho is strictly manual correspondence. Enforce this at backend authorization and every sending boundary; no campaigns, automated prospecting, bulk sends or campaign follow-ups, even if a user manually approves a queued campaign.
- Gmail may be used for authorized manual correspondence and outreach, subject to consent, suppression, rate limits, sender identity and audit requirements.
- Resend must not be used as an Inbox or outreach fallback.
- Do not advertise provider capabilities or enable a provider catalogue entry until the corresponding implementation and tests are complete.

## Revised completion and acceptance sequence

1. Complete the authenticated provider gateway for the existing Intelligence account/credential infrastructure.
2. Complete Gmail send, reply/forward, mailbox sync, threading, pagination, attachments, read state, token refresh, retries and account health.
3. Complete Zoho manual correspondence and mailbox sync, including regional OAuth/token handling, threading, attachments, read state and retries.
4. Complete the central Inbox using the same Settings/Intelligence account identities.
5. Complete prospect management and Gmail-only campaign/outreach workflows, including queues, idempotency, pause/resume, retry, reply-stop, unsubscribe/suppression and audit history.
6. Prove Zoho is rejected at every automated/campaign sending boundary and Resend remains excluded from Inbox/outreach.
7. Run all applicable automated tests, production build, migration/RLS checks and deployment health checks.
8. Perform live Gmail and Zoho acceptance using authorized test accounts and test recipients. Do not send unapproved tests to real prospects.

SMTP sending, IMAP receiving, SMTP/IMAP live acceptance, and SMTP/IMAP deployment are not acceptance criteria for this cycle.

## Reporting rule

Reports must list SMTP/IMAP as **deferred by owner decision**, not as an implementation failure or a completed feature. The overall KairFlow system must not be called production-ready until all remaining in-scope Gmail, Zoho, Inbox, prospecting, campaign, security, deployment and live-acceptance criteria are actually verified.
