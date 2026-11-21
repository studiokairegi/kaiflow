# Finance V3 - Resend Integration Audit and Specification

Status: **Phase 1 deliverable (roadmap sections C and F).** Binding on Phases 2-7 unless a later phase documents a deviation, with reasons, in its handoff. Nothing here is implemented; Phase 1 creates no function, table or template.

Evidence labels (same as the root-cause audit):
* **CONFIRMED (code)** - read directly from the supplied repository.
* **CONFIRMED (executed)** - a command was run and its output observed.
* **STATIC (database)** - read from SQL files; the live database was not queried.
* **UNVERIFIED** - cannot be established from the repository (live Resend account, DNS, secrets, deployed state). Owner checks are in section 9.

Not accessed in this session: the live Resend account, the live Supabase project, deployed secrets, DNS. Nothing below claims the Resend integration works in production; the repo's own header says the Resend adapter is "NOT exercised against a live Resend account".

---

## 1. What exists today (audit, roadmap section C)

### 1.1 Inventory

| Roadmap item | Finding | Label |
|---|---|---|
| Resend send implementation | `supabase/functions/_shared/email_adapter_resend.ts`: `buildResendPayload`, `sendViaResend`, `verifySvixSignature`, `statusForEvent`. `Idempotency-Key: kf-<key>` on every send; max 3 attempts; retries only 429 and 5xx; an ambiguous result (network error, 5xx) stays *unknown* and is never auto-resent with a fresh key; unknown 409 variants fail closed. Adds a Resend `tags` entry `kf_message_id` (UUID) so an accepted send can be recovered from a later webhook even if the post-send database write failed | CONFIRMED (code) |
| Sending functions | (a) `email-send` - signed-in person; authorization is `email_has_access()` + `email_require_access()` (Inbox access: admin and active Master User); loads an `email_accounts` row, resolves adapter through `email_provider_registry`, builds an Inbox conversation/thread, optionally links a CRM lead. (b) `intel-resend-send` - Intelligence only; worker authenticates with an agent JWT and sends only a message id; content comes from an agent-scoped RPC; honours the Intelligence kill switch | CONFIRMED (code) |
| Sender identities | `email_accounts` (organization-scoped: `address` lowercase, `display_name`, `status active/paused`, `is_default`, provider key). Created by `email_upsert_account` (requires Inbox access; advisory-locked per organization). Intelligence has its own `intel_provider_accounts` / `intel_mail_account` / `intel_settings.sender_email`. The *verified sending domain* lives in the Resend dashboard, not in the repo | CONFIRMED (code) / UNVERIFIED (domain) |
| Normal Inbox | `email_conversations`, `email_messages`, `email_participants`, `email_attachments`, `email_events`, `email_crm_activities`, `email_sync_*`; threading by Reply-To token (`EMAIL_THREAD_TOKENS`, `EMAIL_INBOUND_DOMAIN`), CRM lead association, mailbox sync for Gmail/Zoho (`email-mailbox-sync`) | CONFIRMED (code) |
| Inbound email | `email.received` handled by `processInbound` inside `resend-webhook`; separate Intelligence-only inbound endpoint `intel-resend-webhook` (routes only replies carrying a valid Intelligence token) | CONFIRMED (code) |
| Webhook processing | **One** shared endpoint `resend-webhook` (`verify_jwt = false`): rejects unless the Svix signature verifies (HMAC-SHA256 over `<id>.<timestamp>.<raw body>`, constant-time compare, 5-minute replay window, `whsec_` prefix handled), body cap, then `claimWebhook` (table `email_webhook_events`, unique `svix_id`, lease + attempts + `exhausted`), then `processInbound` or `processDeliveryEvent`, then `finishWebhook` (ownership token). Failures return 500 so Resend retries. Intelligence plugs a *sink* (`applyIntelDeliveryEvent`) into the same handler | CONFIRMED (code) |
| Delivery events | `email.sent/delivered/delivery_delayed/bounced/complained/failed/suppressed/rejected` -> Inbox status (`sent, delivered, delivery_delayed, bounced, complained, failed, rejected`). Temporary/soft bounces map to `delivery_delayed`. A signed event that matches no row yet is stored and "queued for reconciliation"; insert/update triggers replay it when the provider id is committed | CONFIRMED (code) / STATIC (triggers) |
| Email templates | **None.** Search of `email-send`, `email_resend_logic.ts` and the adapter finds no template mechanism: bodies are composed by the user (text/html) or by Intelligence | CONFIRMED (code) |
| Message records | `email_messages` (Inbox; has `conversation_id`, `account_id`, `direction`, `provider_message_id`, `status`, `idempotency_key`, `created_by`, no invoice/client/financial-event column) and `intel_messages` (Intelligence) | CONFIRMED (code) / STATIC |
| Error handling and retries | Adapter-level bounded retries with the same idempotency key; accepted-send reconciliation migrations (`20261213100000`), recovery schedule (`20261220090000`); provider error text sanitised (`sanitizeProviderMessage`); secrets scrubbed from logs (tests `dispatch-4b.test.mjs`) | CONFIRMED (code) |
| Intelligence Resend transport | `intel-resend-send`, `intel-resend-webhook`, `_shared/intel_resend_*`, `intel_messages`, `intel_delivery_events`, kill switch (`intel_admin_set_kill_switch`, `20261118090000`), Python worker `intelligence-worker/kairflow_intel/resend.py`. It calls `api.resend.com` **directly** from the two functions | CONFIRMED (code) |
| Secrets and configuration | Edge Function secrets `RESEND_API_KEY` (read in `email-send` path, `resend-webhook`, `intel-resend-send`, `intel-resend-webhook`), `RESEND_WEBHOOK_SECRET` (`resend-webhook`, `intel-resend-webhook`), `EMAIL_INBOUND_DOMAIN`, `EMAIL_THREAD_TOKENS`, `INTEL_TOKEN_ENCRYPTION_KEY` (OAuth providers only). **One API key and one webhook secret are shared by Inbox, Intelligence and (later) Finance.** `.env.example` lists none of them (Edge Function secrets are set in Supabase) | CONFIRMED (code) |
| JWT settings | `supabase/config.toml` sets `verify_jwt = false` for `resend-webhook`, `intel-resend-webhook`, `email-mailbox-sync`; `email-send` and `intel-resend-send` have no entry (Supabase default applies) and authenticate in code | CONFIRMED (code) |
| Baseline tests (executed here) | `src/email/*.test.mjs`: 315 run, 314 pass, **1 fail** (`compose from a lead opens a modal over the pipeline...`, pre-existing, same failure as the full-suite baseline). `src/intelligence/*resend*.test.mjs`: 16 run, 16 pass. These are JavaScript contract/logic tests; no live Resend call | CONFIRMED (executed) |

### 1.2 Defects and hazards found (relevant to Finance)

| # | Finding | Label | Consequence for V3 |
|---|---|---|---|
| R1 | `email-send` authorization is *Inbox access* (admin + active Master User), not a finance permission, and the function always creates/threads an Inbox conversation. | CONFIRMED (code) | Finance cannot call `email-send`; doing so would grant invoice sending to Inbox-only users, deny it to Finance staff, and pollute the Inbox with invoice mail |
| R2 | The webhook gate `webhookProviderAllowed` runs **before** the claim. If the `resend` row in `email_provider_registry` is disabled, *every* signed event is acknowledged (HTTP 200) and discarded - including delivery events for Finance mail. Resend will not retry them. | CONFIRMED (code) | Finance must persist the verified event itself before the Inbox gate can drop it (section 4.3) |
| R3 | The shared handler throws if *any* sink fails (`emailError \|\| intelError`), turning the whole delivery into a 500/retry. A buggy Finance sink would make Inbox and Intelligence events fail and retry. | CONFIRMED (code) | Finance sink must be fault-isolated: it may throw only if it cannot even persist the raw event (section 4.3) |
| R4 | One `RESEND_API_KEY` and one `RESEND_WEBHOOK_SECRET` are shared by all consumers. A Finance bug cannot leak them (server-side only) but a key rotation or Resend-side suspension affects Inbox, Intelligence and Finance together. | CONFIRMED (code) | Accept (roadmap 5.2 says reuse); record as operational risk; do not add a second key unless the owner wants separate Resend projects (decision D-20) |
| R5 | The adapter header says it is "the ONLY place that knows api.resend.com", but `intel-resend-send` and `intel-resend-webhook` call the API directly. | CONFIRMED (code) | Documentation inaccuracy; Finance must import the shared adapter rather than copy it or add a fourth direct caller |
| R6 | No email templates, no PDF generation for email, no Finance association columns exist. | CONFIRMED (code) | All Finance email content, records and associations are new (Phase 3) |
| R7 | Reply-To / inbound routing for Finance mail is undefined. Inbox thread tokens could capture client replies to invoices into the Inbox. | STATIC | Decide explicitly (section 3.4); default: replies go to the studio's billing mailbox via a plain `reply_to`, not to an Inbox thread token |
| R8 | Sending domain, SPF/DKIM/DMARC and the live webhook subscription (which event types are subscribed, to which URL) cannot be seen from the repo. | UNVERIFIED | Owner checks 9.1-9.3 before Phase 3 can claim delivery works |
| R9 | The unresolved-event replay relies on triggers on `email_messages` / `intel_messages` provider-id writes. Finance needs its own equivalent. | CONFIRMED (code) | Specified in 4.4 |

### 1.3 What can be reused safely

| Component | Reuse? | How |
|---|---|---|
| `sendViaResend`, `buildResendPayload`, `RESEND_API` | **Yes - import, do not copy** | Finance Edge Function imports them from `_shared/email_adapter_resend.ts` (Deno). They are pure and unit-tested |
| `verifySvixSignature` | **Yes** | Same import. Already used by `intel-resend-webhook` |
| `sanitizeProviderMessage`, `isValidEmail`, `htmlToText`, `safeFileName` (`email_common.ts`) | Yes | Import |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` | Yes (decision D-20) | Same secrets; same webhook URL |
| `resend-webhook` endpoint | **Extend, do not duplicate** | Add a Finance sink with the same plug-in pattern as Intelligence; no second Finance webhook endpoint (Resend deliveries to one URL; a second endpoint would need a second subscription and a second signing secret) |
| `email-send` function | **No** | R1 |
| `email_accounts` rows as sender identities | **Read-only reference**, optional | Finance may *reference* a verified sender address chosen by the owner, but stores its own copy in `finance_v3.org_settings`/sender config; never writes to `email_accounts` |
| `email_messages`, `email_events`, `email_webhook_events` | **Do not write** from Finance. `email_webhook_events` is *shared claim infrastructure*: the existing handler writes it before any sink runs; Finance does not touch it | |
| Intelligence transport | **Never touched** | Guard test pins it (section 8) |

### 1.4 Decision: shared transactional email service

Finance email is a **new Edge Function `finance-email-send`** (plus a dispatcher for queued jobs) that reuses the shared transport code, with its own authorization, records, templates and audit. The existing `resend-webhook` gets one **additive** Finance sink. Reasons: R1 (authorization/threading mismatch), roadmap 1.6 and 5.2 (reuse transport, separate operations), R2/R3 (isolation).

---

## 2. Responsibilities

| Concern | Owner |
|---|---|
| Invoice status, balances, payments, receipts, ledger | Finance V3 database (never Resend) |
| Email intent, content snapshot, status, attempts, retry policy, audit | Finance V3 (`finance_v3.email_messages`, `email_attempts`, `email_events`) |
| Transport, DKIM, bounce detection | Resend |
| Secrets, signature verification, idempotent event intake | Supabase Edge Functions |
| "Was the invoice emailed?" | Derived **only** from a `finance_v3.email_messages` row reaching `sent` or `delivered`, never from the API request being issued |

Hard rule: no email operation reads or writes a journal, invoice balance, payment or receipt *amount*. Email jobs reference those records by id; the content snapshot is rendered at send time from database values.

---

## 3. Data contract

### 3.1 `finance_v3.email_messages` (one row per intended email)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | **Internal message id.** Never the Resend id. Also sent to Resend as tag `kf_finance_message_id` |
| `organization_id` | uuid not null | Tenant. RLS on this |
| `invoice_id` | uuid null | `finance_v3.receivables.id` (null only for non-invoice mail, none in V3.0) |
| `payment_id` | uuid null | Set for receipts and payment confirmations |
| `receipt_id` | uuid null | Set for receipts |
| `refund_id` | uuid null | Set for refund notices |
| `financial_event_id` | uuid null | The `finance_v3.events` row that caused the mail (payment recorded, invoice issued, ...) |
| `client_id` | uuid not null | `finance_v3.contacts_v3.id` |
| `email_type` | text | `invoice`, `invoice_reminder`, `overdue_notice`, `payment_receipt`, `invoice_update`, `refund_notice` |
| `recipient` | text | Single normalized address per message (one message per recipient; CC/BCC out of V3.0 except an optional internal BCC audit copy chosen by the owner) |
| `sender` | text | `from` as sent (`Name <address>`) |
| `reply_to` | text | Explicit; see 3.4 |
| `subject` | text | Snapshot |
| `body_html`, `body_text` | text | Snapshot rendered at queue time from a versioned template (`template_key`, `template_version`) |
| `attachments` | jsonb | `[{kind:'invoice_pdf'|'receipt_pdf', storage_path, sha256, bytes}]`. PDF bytes are generated by the server, stored, and referenced; never rebuilt differently on retry |
| `status` | text | `queued`, `sending`, `sent`, `delivered`, `bounced`, `failed` (six values; see 3.2) |
| `delivery_flags` | text[] | Extra provider facts that do not change the six-state status: `delayed`, `complained`, `suppressed` |
| `provider` | text | `resend` |
| `provider_message_id` | text null | Resend email id once accepted. Unique per `(provider, provider_message_id)` where not null |
| `idempotency_key` | text | See 3.3. Unique per `(organization_id, idempotency_key)` |
| `attempt_count` | int | |
| `next_attempt_at` | timestamptz null | Retry scheduler |
| `unknown_outcome` | boolean | True when an attempt ended ambiguously; blocks auto-resend with a new key (mirrors the adapter's rule) |
| `created_at`, `queued_at`, `sent_at`, `delivered_at`, `failed_at` | timestamptz | |
| `failure_code`, `failure_detail` | text | Sanitised, no secrets or recipient content |
| `created_by` | uuid | User, or null for system jobs (with `trigger` column naming the job) |

Satisfies the roadmap's required fields (internal id, organization, invoice, client, type, recipient, sender, subject, Resend id, status, attempts, creation/sent/delivered timestamps, failure information).

`finance_v3.email_attempts(id, message_id, attempt_no, started_at, finished_at, outcome, http_status, provider_message_id, error_detail)` - append-only.
`finance_v3.email_events(id, organization_id, message_id null, provider_event_id, event_type, occurred_at, payload_digest, applied boolean, received_at)` - append-only delivery history, unique `(provider, provider_event_id)`. Raw payload is **not** stored beyond the digest and the recipient-free fields needed for audit.

### 3.2 Status model

```
queued --claim--> sending --provider accepted--> sent --email.delivered--> delivered
                     |                              \--email.bounced (permanent)--> bounced
                     |--definitive refusal / retries exhausted--> failed
                     |--ambiguous result--> sending (unknown_outcome=true) --webhook proves acceptance--> sent
                                                                    \--reconciler finds no acceptance after the window--> failed (manual resend allowed)
```

* The status only moves **forward** by rank: `queued 0 < sending 1 < sent 2 < delivered 3`, with `bounced` and `failed` terminal. A late `email.sent` after `email.delivered` is recorded as an event but never regresses the status (contract `FINANCE_EMAIL_STATUS_RANK`).
* `email.delivery_delayed` and a temporary/soft bounce add the flag `delayed`; status stays `sent`.
* `email.complained` adds `complained`; status stays `delivered`.
* `email.suppressed` / `email.rejected` / `email.failed` -> `failed` with `failure_code` = the event type.
* **"Emailed" for the user** = `sent` or `delivered`. The UI shows all six states plainly (roadmap 5.B) and hides Resend internals.

### 3.3 Idempotency keys (contract `buildIdempotencyKey`)

| Operation | Key | Effect of replay |
|---|---|---|
| Queue invoice email | `fin3:email:invoice:<invoice_id>:<invoice_revision>:<recipient_sha8>` | Returns the existing message |
| Queue reminder | `fin3:email:reminder:<invoice_id>:<yyyymmdd>:<n>` | One reminder per scheduled slot |
| Queue overdue notice | `fin3:email:overdue:<invoice_id>:<yyyymmdd>` | One per day maximum |
| Queue receipt | `fin3:email:receipt:<receipt_id>` | One receipt email per receipt |
| Queue invoice update | `fin3:email:update:<invoice_id>:<revision>` | |
| Queue refund notice | `fin3:email:refund:<refund_id>` | |
| Manual resend | `fin3:email:resend:<original_message_id>:<n>` where `n` is a user-initiated counter | Explicit new message linked by `resend_of` |
| Resend API call | `kf-<message_id>` (adapter adds `kf-`), same key on every attempt of that message | Resend returns the original result |

### 3.4 Sender and reply-to

* One sender identity per organization for Finance (`org_settings.finance_email_from_name`, `..._from_address`), chosen by the Finance admin from addresses on a domain verified in Resend. Phase 3 validates the address belongs to a domain the owner confirmed in check 9.2; the verified-domain list is **not** discoverable from the repo.
* `reply_to` defaults to the studio's billing/contact address (owner-configured), a normal mailbox. It does **not** use Inbox thread tokens (R7). If the owner wants client replies to land in the Inbox, that is a separate decision recorded in the Phase 3 handoff, with the Inbox CRM association implications documented.

---

## 4. Architecture

### 4.1 Components (new unless stated)

| Component | Kind | Responsibility |
|---|---|---|
| `finance_v3.email_*` tables + RPCs `fin3_queue_email`, `fin3_list_invoice_communications`, `fin3_retry_email`, `fin3_resend_email` | Database | Intent, records, permissions, idempotent queueing. Queueing is part of the *same transaction* as the financial action that causes it (payment recorded -> receipt email row queued) |
| Edge Function `finance-email-send` | New, JWT-authenticated (user) | User-initiated send/resend/retry; checks `finance.send_email`; loads the already-rendered snapshot; calls the shared adapter |
| Edge Function `finance-email-dispatch` | New, cron/service-role with a shared secret header (pattern: `EMAIL_SYNC_CRON_SECRET`) | Claims due `queued` rows with a lease (`for update skip locked`), sends, records attempts, schedules retries |
| Finance **sink** in `resend-webhook` | Additive change to existing function wiring (`index.ts`) plus new `_shared/finance_email_sink.ts` | Applies delivery events to `finance_v3.email_messages` |
| PDF generation | Server-side, Phase 3 | Invoice and receipt PDFs from database values; stored; hash recorded. Existing client-side invoice PDF code (`src/invoicePdfLayout.js`) is a layout reference only |
| Templates | `finance_v3.email_templates` (versioned, per organization with studio branding fields) or code-resident templates keyed by `template_key`; Phase 3 chooses, but every send snapshots subject/body | |

### 4.2 Send flow (invoice)

1. User with `finance.issue` issues the invoice (Phase 3 RPC). In the same transaction: invoice moves to `issued`, ledger posts, an `email_messages` row (`queued`, idempotent) is created if "send on issue" was chosen.
2. PDF generated and stored; content snapshot rendered.
3. Dispatcher/function claims the row -> `sending`, writes an `email_attempts` row, calls `sendViaResend` with the message's idempotency key and `tags: [{name:'kf_finance_message_id', value:<id>}]`.
4. Accepted -> store `provider_message_id`, `status='sent'`, `sent_at`. Definitive refusal -> `failed` (or retry per policy). Ambiguous -> `unknown_outcome=true`, no auto-resend.
5. Webhook events advance status (4.3). The invoice's communication history lists the rows.
6. **Nothing in 3-5 touches invoice or ledger state.** A Resend outage leaves the invoice `issued`, the posting intact, and the message `queued`/`failed` with retry available (roadmap 5.4).

### 4.3 Webhook intake: Finance sink

Contract for the additive change to `resend-webhook` (Phase 3):

1. Keep everything the handler already does (signature, claim, Inbox, Intelligence) unchanged.
2. Run the Finance sink **before** the `webhookProviderAllowed` early-return for delivery events (fixes R2 for Finance without changing Inbox behaviour): the sink only acts if the event carries tag `kf_finance_message_id` or its `email_id` matches a `finance_v3.email_messages.provider_message_id`. Untagged events are untouched.
3. The sink first inserts the verified event identity into `finance_v3.email_events` (`insert ... on conflict (provider, provider_event_id) do nothing`). That insert is the idempotency point: a replay finds the row and returns "duplicate". If this insert fails, the sink throws (500 -> Resend retries; nothing lost).
4. Status application happens through RPC `fin3_apply_email_event` (service role only), which enforces rank, sets flags, and is a no-op on duplicates. If it fails after step 3, the failure is recorded on the event row (`applied=false`, error) and **not thrown**, so Inbox/Intelligence are never retried because of Finance (R3). The Finance reconciler (4.4) re-applies unapplied events.
5. Correlation: preferred = tag `kf_finance_message_id`; fallback = `provider_message_id` match (unique). Never match on recipient or subject alone.
6. Never log recipients, bodies, signatures or keys.

### 4.4 Reconciliation and retries

* Scheduler (Phase 3 ships the job; Phase 6 productionises it): re-apply `email_events.applied=false`; retry due `queued` rows (`next_attempt_at <= now()`) with backoff 1 min, 5 min, 30 min, 2 h, 12 h; at most 5 automatic attempts, then `failed`.
* **Ambiguous outcomes (`unknown_outcome = true`).** Two safe paths only: (a) a delivery webhook carrying the message's `kf_finance_message_id` tag proves acceptance and moves the row to `sent`; (b) a retry with the **same** idempotency key (`kf-<message_id>`), which Resend answers with the original result instead of sending twice. Path (b) is only safe inside Resend's idempotency retention window; Phase 3 must read that window from Resend's current documentation (not assumed here) and record it in its handoff. After the window with no proof of acceptance the row becomes `failed` with `failure_code='outcome_unknown'` and only a **manual resend** (new linked message, UI warning that a duplicate is possible) can follow. Never auto-resend with a fresh key.
* Replay of events that arrive before the send write commits: the sink stores them (step 3) and `fin3_apply_email_event` is retried by the reconciler once `provider_message_id` is set; a Finance-side trigger on `provider_message_id` assignment may replay immediately (mirrors the Inbox design).

### 4.5 Security and authorization

* API key only in Edge Function secrets; Finance code never exposes it. Guard test scans V3 paths for key patterns (extended in this phase).
* Permissions: `finance.send_email` (send, resend), `finance.read` (history). Membership-derived `organization_id`; payload org ids are never trusted (architecture D-02, D-16).
* Cross-organization: RLS on all `email_*` tables by `organization_id`; RPCs verify membership; Edge Functions use the caller's JWT for authorization and the service role only for the stored-job steps.
* Public links in the email (invoice view/payment) use opaque random tokens (Paystack spec 6.3), never database ids.
* Attachments: only server-generated PDFs referenced by hash.
* Unauthenticated callers can never queue or send. The webhook cannot create messages, only update existing Finance rows.
* Limits: reuse `LIMITS` (recipients, attachment 10 MB, subject 998, body 200,000).

### 4.6 Failure semantics (roadmap 5.4)

| Situation | Result |
|---|---|
| Resend down at issue time | Invoice issued; message `queued`/`failed`; retry/manual resend; ledger unchanged |
| Resend down after a payment | Payment recorded; receipt record exists (`generated`); receipt email `queued`/`failed`; retry; manual resend |
| Bounce | Message `bounced`; internal notification (Phase 6); invoice unaffected |
| Duplicate/repeated webhook | One event row; status not re-applied; no duplicate notification |
| Finance sink bug | Event persisted unapplied; Inbox/Intelligence unaffected; reconciler retries |

---

## 5. Service contracts (roadmap F, items 1-8)

All are RPCs in `public` (`authenticated`) unless marked *service*. Arguments finalise in Phase 3; names and semantics are fixed now. Every RPC derives the organization from the caller, checks the permission, writes an audit row, and is idempotent by key.

| # | Contract | Signature (shape) | Returns | Errors |
|---|---|---|---|---|
| 1 | Send invoice | `fin3_queue_invoice_email(p_org, p_invoice, p_recipient, p_options jsonb)` -> then `finance-email-send` (or dispatcher) | `{message_id, status}` | `V3010` not found, `V3017` invoice not sendable (draft/void), `V3018` bad recipient, `V3005` |
| 2 | Send reminder | `fin3_queue_invoice_reminder(p_org, p_invoice, p_slot)` | same | `V3017` if paid/void; no email if outstanding = 0 |
| 3 | Send overdue notice | `fin3_queue_overdue_notice(p_org, p_invoice, p_date)` | same | as above; only when `due_date < p_date` and outstanding > 0 |
| 4 | Send payment receipt | `fin3_queue_receipt_email(p_org, p_receipt)` | same | Requires a **recorded** payment and an existing receipt row |
| 5 | Send invoice update | `fin3_queue_invoice_update(p_org, p_invoice, p_revision)` | same | Requires a revision/credit-adjustment event |
| 6 | Retry failed email | `fin3_retry_email(p_org, p_message)` (automatic path is *service*: dispatcher) | `{message_id, status, attempt_count}` | Only from `queued`/`failed` without `unknown_outcome`; otherwise use resend (below) |
| - | Manual resend | `fin3_resend_email(p_org, p_message, p_reason)` | new `{message_id}` | Creates a new linked message; audit records the reason |
| 7 | Process delivery events | *service* `fin3_apply_email_event(p_provider, p_event_id, p_event_type, p_provider_message_id, p_message_id, p_occurred_at, p_bounce_type)` | `{found, duplicate, applied, status}` | Duplicate is success, never an error |
| 8 | Invoice communication history | `fin3_list_invoice_communications(p_org, p_invoice, p_cursor)` | Keyset-paginated timeline of email messages (+ attempts/events summary) joined with payment, receipt and refund events; financial and email events carry a `kind` so the UI keeps them distinguishable | `V3010`, `V3005` |

Rule for all queueing RPCs: they write **only** `finance_v3` rows. They never post a journal entry and never change an amount.

---

## 6. Notifications (feeds Phase 6)

Internal KairFlow notifications (not client emails) for: delivered, bounced, failed, retry required, reminder sent. Deduplicated on `(message_id, event_type)` so a Resend retry cannot create a second notification (roadmap 6.F). Existing notification system (`src/notifications`) is reused in Phase 6.

---

## 7. Phase mapping

| Phase | Resend work |
|---|---|
| 2 | Event/idempotency foundation only: `events.idempotency_key`, `audit_log`; reserve the email permission names. **No email tables, no function** |
| 3 | Tables 3.1, RPCs section 5, `finance-email-send`, `finance-email-dispatch`, `finance_email_sink.ts` and the additive `resend-webhook` wiring, PDF generators, templates, tests |
| 4 | Verify email status never changes financial balances (test) |
| 5 | Preview/confirm UI, status badges, resend, communication timeline |
| 6 | Notifications, scheduled reminders/overdue, retry job productionised, email delivery report/export |
| 7 | Resend audit (roadmap 7.B): key protection, signature, org isolation, duplicate events, outage and retry workflows, separation from Inbox and Intelligence |

---

## 8. Protection of existing infrastructure (enforced)

* `docs/finance-v3/integration-baseline.sha256` pins the Resend, Inbox and Intelligence transport files. A guard test fails if any changes. **Phase 3 legitimately modifies `supabase/functions/resend-webhook/index.ts`** (additive sink) and must update the baseline in the same change and say so in its handoff.
* Guard: no new Edge Function directory may be a second Resend webhook (allowed: `resend-webhook`, `intel-resend-webhook`).
* Guard: V3 migrations may not alter or write `email_*` or `intel_*` tables (read is allowed).
* V3 source never imports `src/email/` or `src/intelligence/`.

---

## 9. Owner checks before Phase 3 (cannot be done from the repo)

1. **Webhook subscription:** Resend dashboard -> Webhooks: which URL (`.../functions/v1/resend-webhook`) and which event types (`email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed`, `email.received`). Finance needs the delivery events.
2. **Sending domain:** Resend dashboard -> Domains: which domains are *verified*; which address should invoices come from (e.g. `billing@<verified domain>`).
3. **Deployed secrets:** confirm `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` exist for the project (names only; never paste values).
4. **Registry flag:** `select provider_key, enabled from email_provider_registry where provider_key='resend';` (expect `enabled = true`; see R2).
5. **Decision D-20:** keep one shared API key/webhook secret (default) or create a separate Resend key for Finance (more isolation, a second webhook secret and subscription).
6. **Reply handling:** should client replies to invoices go to a normal billing mailbox (default) or into the Inbox (R7)?

---

## 10. Acceptance (this specification)

* Existing Resend, Inbox and Intelligence infrastructure audited from the code, with confirmed defects separated from unknowns.
* Reuse boundaries defined; no second Resend integration, no second webhook endpoint.
* Message record, status model, idempotency, retry and fault-isolation rules defined.
* Eight service contracts defined.
* Protection rules are testable and (for the file-level ones) already enforced by guard tests.
