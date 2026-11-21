# Finance V3 - Paystack Integration Audit and Specification

Status: **Phase 1 deliverable (roadmap sections D and G).** Binding on Phases 2-7 unless a later phase documents a deviation, with reasons, in its handoff. Nothing here is implemented; Phase 1 creates no function, table, migration or route.

Evidence labels: **CONFIRMED (code)**, **CONFIRMED (executed)**, **STATIC (database)** (read from SQL, live DB not queried), **UNVERIFIED** (needs the live Paystack account, deployed secrets or database; owner checks in section 10).

Not accessed in this session: the live Paystack account, deployed secrets, the live database, PostgreSQL. The SQL payment tests (`supabase/tests/payments*.test.sql`, harness `run.sh`) were **not run** (no PostgreSQL). Nothing below claims production Paystack works; it records what the code does.

---

## 1. What exists today (audit, roadmap section D)

| Roadmap item | Finding | Label |
|---|---|---|
| Account configuration | Server secrets `PAYSTACK_MODE` (`test`/`live`), `PAYSTACK_TEST_SECRET_KEY`, `PAYSTACK_LIVE_SECRET_KEY`, single `PAYSTACK_SECRET_KEY` (filed by prefix), legacy `PAYMENTS_MODE=sandbox`, `APP_URL` (must be `https://` for live). Key prefix must match mode (`sk_test_`/`sk_live_`), otherwise payments stay disabled; a key is never echoed. Per-user non-secret settings live in `payment_providers.settings` (currencies, channels) | CONFIRMED (code) |
| API integration | `_shared/paystack_api.ts`: `paystackFetch` to `https://api.paystack.co` only, bearer key, 15 s timeout, key-prefix check per environment. `_shared/paystack_core.ts`: pure helpers (amounts, signature, verification interpretation) | CONFIRMED (code) |
| Payment initialization | Public function `paystack-checkout` (`verify_jwt=false`; authorised by an unguessable 64-hex checkout token): actions `quote`, `start`, `wise_start`, `wise_submit`, `confirm`. Browser never supplies amount, rate or currency. One open attempt per invoice; an attempt with unknown outcome is verified with Paystack before another starts. Admin function `paystack-payments` (JWT): `status`, `connect`, `init`, `verify`, `snapshot`, `balance`, `settlements` | CONFIRMED (code) |
| Checkout integration | Paystack-hosted checkout via `authorization_url`; channels limited to `card` and `apple_pay` (bank transfer removed by `20270112090000`); **checkout always charges in KES** (`20261028090000`), with a server-made 15-minute FX quote bound to the session (`payment_quotes`, `payment_fx_snapshots`; snapshot older than 36 h = "no reliable rate") | CONFIRMED (code) / STATIC |
| Reference generation | `KRL-L-<first 8 hex of invoice id>-<random md5 slice>` (live), `KRL-W-...` (Wise/manual). The first segment embeds part of the internal invoice id | CONFIRMED (code) |
| Transaction verification | `GET /transaction/verify/<reference>` then `interpretVerification`: checks `status === true`, **domain equals expected environment** (missing domain refused for live), reference equality, status, **currency**, **amount in minor units**; returns success/failed/abandoned/reversed/pending/rejected. Final cross-check again in SQL (`payments_apply_verification`) | CONFIRMED (code) |
| Webhook | `paystack-webhook` (`verify_jwt=false`): body cap 256 KB; **HMAC-SHA512 of the raw body** vs `x-paystack-signature`, constant-time compare; environment decided by *which* configured key reproduces the signature (live checked first); invalid -> 401. Handled events: `charge.success`, `refund.processed`, `refund.failed`, `refund.pending`, `refund.processing`; everything else stored and ignored | CONFIRMED (code) |
| Event storage and dedup | `paystack_webhook_events` with unique `event_key` (`<env>:<event>:<data.id>`; refunds keyed by `refund_reference` or body hash); status `received/processed/ignored/failed`, `attempts`; payload **sanitised** (no customer/card/authorization objects). Duplicate of a processed/ignored event returns 200 `{duplicate:true}` | CONFIRMED (code) |
| Payment records | `paystack_transactions` (unique `reference`; `invoice_id`, `user_id`, amounts, status, fee, `invoice_payment_id`, `fee_expense_id`, `apply_status`, `reconciliation_status`, refund tracking) and `payment_*` tables (providers, checkout sessions with **hashed** tokens, quotes, manual payments, events, FX snapshots) | CONFIRMED (code) / STATIC |
| Applying a payment | `payments_apply_verification` (service role only) locks the transaction row, re-checks amount/currency, then `payments_apply_to_invoice` -> `payments_settle_invoice` -> V2 `finance_settle` / `finance_post_entry`; books **actual** Paystack fee as an expense once; if the ledger cannot take it, `apply_status='failed'`, `reconciliation_status='needs_review'` (money never silently dropped) | CONFIRMED (code) |
| Refunds | `payments_apply_refund`: idempotent by event ref; requires the charge to be applied first (webhook answers 500 out of order so Paystack retries); **full** refund voids the V2 payment entry; **partial** refund records the amount and flags `needs_review` for manual adjustment. Nothing asks Paystack to refund | CONFIRMED (code) |
| Edge Functions | `paystack-checkout`, `paystack-payments`, `paystack-webhook` | CONFIRMED (code) |
| Secrets exposure | Keys read only in Edge Functions; `.env.example` contains none; guard scan found only obvious test fixtures | CONFIRMED (executed) |
| Baseline tests (executed) | `src/payments/*.test.mjs`: **93 run, 93 pass** (JavaScript tests of the helpers and function logic; no live Paystack call) | CONFIRMED (executed) |
| Not executed | `supabase/tests/payments*.test.sql` and `run.sh` (need PostgreSQL) | NOT RUN |

### 1.1 Defects and hazards (relevant to Finance V3)

| # | Finding | Label | Consequence for V3 |
|---|---|---|---|
| P1 | **Unknown references are acknowledged and ignored** (`"reference does not belong to this app"`, HTTP 200). A V3 payment reference that the V2 tables do not know would be silently dropped. | CONFIRMED (code) | The existing webhook **must** be extended with a router; a V3 handler cannot live in a separate endpoint (P7) |
| P2 | A permanent verification mismatch (amount/currency/reference/domain) throws -> event `failed` -> **HTTP 500 -> Paystack retries**. No `needs_review` record is created for mismatches (only for ledger-apply failures). A permanent condition thus retries until Paystack stops, with no alert. | CONFIRMED (code) | V3 must acknowledge permanent mismatches (200), persist them as `needs_review`, and alert; 5xx only for transient conditions (section 5.3) |
| P3 | Scope is **per user and admin-only**: `payments_require_admin` reads `user_settings.is_admin`; `payment_providers`, sessions and transactions carry `user_id`; apply checks `inv.user_id = t.user_id`. Same single-owner model as audit F1. | CONFIRMED (code) | V3 intents are organization-scoped with finance permissions |
| P4 | Settlement posts into the **V2 per-user ledger** via `finance_settle`, creates `invoice_payments` and changes legacy invoice paid state (audit F3, F4). | CONFIRMED (code) | V3 settles through its own posting service; cutover re-points per organization (D-09) |
| P5 | Test-mode payments are applied to the same V2 ledger as real ones (labelled "Paystack (test mode)", fee expense labelled TEST). | STATIC | V3: test-environment intents never post to a production organization's ledger (section 4.4) |
| P6 | The public `paystack-checkout` endpoint shows no request throttling in code (no rate-limit reference in the function). Tokens are 256-bit random and stored hashed, so guessing is impractical; the risk is quote/start spam. | CONFIRMED (absence in code) | Add throttling by token hash and source address in Phase 3 |
| P7 | Paystack delivers events to **one webhook URL per mode** configured in its dashboard. A second Finance webhook function would receive nothing, or would require moving the URL away from the existing handler. | UNVERIFIED (owner to confirm in dashboard, check 10.1) | Reinforces the single-handler decision (D-17) |
| P8 | The V2 reference embeds 8 characters of the internal invoice id. | CONFIRMED (code) | V3 references contain **no** database id fragment (section 4.2) |
| P9 | Refund semantics differ from the roadmap: V2 *voids* the original payment entry on a full refund. | CONFIRMED (code) | V3 refunds are separate events; the original payment is never voided or deleted (section 7) |
| P10 | Paystack account currency/channel capability (KES only? USD?) and webhook subscription are not visible in the repo. | UNVERIFIED | Owner check 10.2 |

### 1.2 What can be reused

| Component | Reuse? | How |
|---|---|---|
| `paystack_core.ts` (`loadKeyRing`, `identifyWebhookEnvironment`, `verifyWebhookSignature`, `toMinor`, `interpretVerification`, `webhookEventKey`, `isHandledEvent`) | **Yes - import unchanged** | They are pure and tested; Finance does not re-implement signature or verification logic |
| `paystack_api.ts` (`paystackFetch`) | Yes | Import |
| `paystack-webhook` endpoint | **Extend (router only)** | Section 5.1 |
| `paystack-checkout`, `paystack-payments` | **No** (V2-bound) | V3 gets its own public checkout function and admin function that reuse the shared helpers (section 3) |
| `payment_*`, `paystack_*` tables | **Do not write from V3** | V3 owns `finance_v3.payment_*` tables; guard test forbids V3 migrations touching the V2 payment tables |
| `payments_apply_*`, `finance_settle`, `finance_post_entry` | **Never called by V3** | V3 uses `fin3_settle_payment` (Phase 3) |
| FX quote/snapshot idea | Concept only | V3 has its own `fx_rates` and per-intent quote |

### 1.3 Decision: extend the existing webhook, do not build a second one

Question (roadmap D): can existing notifications be safely extended, or is a new isolated service required? **Answer: extend the existing handler with a reference-prefix router; do not create a second webhook processor.** Reasons: P1 (V3 references would otherwise be dropped), P7 (single URL per mode), roadmap 1.7 (no duplicate webhook handlers that can independently post the same transaction). Isolation is preserved by routing *before* any V2 table is touched and by pinning the V2 path with regression tests and the baseline hash.

---

## 2. Responsibilities

| Concern | Owner |
|---|---|
| Invoice balance, payment records, receipts, refunds, ledger, audit | Finance V3 database |
| Hosted checkout, card/Apple Pay collection, event notification, transaction truth lookup | Paystack |
| Secret keys, signature verification, verify-API calls, idempotent intake, routing | Supabase Edge Functions |
| "Was this payment received?" | Derived only from a **verified** `payments` row, never from a browser redirect, an email or an unverified webhook |

Paystack never creates a journal entry. Only `fin3_settle_payment` (service role) translates a *verified* payment into a financial event, and it knows nothing about Paystack beyond opaque `provider` and `provider_reference` strings (roadmap 5.7).

---

## 3. Data contract (schema `finance_v3`)

### 3.1 Relationship chain (roadmap G)

```
organization_id
  -> client_id (contacts_v3)
  -> invoice_id (receivables)
       -> payment_intent_id (payment_intents)        internal id, created by finance
            -> provider_reference (KRL3-...)         our reference, sent to Paystack as `reference`
                 -> provider_events (verified webhook/verify records)
                 -> payment_id (payments)             exists only after verification
                      -> ledger_entry_id (journal_entries)   one posting per payment
                      -> receipt_id (receipts)
                      -> refunds (0..n) -> reversal/credit entries
```

Every link is a foreign key; `organization_id` is repeated and checked on each row (composite FKs) so a cross-tenant link cannot exist.

### 3.2 Tables

**`payment_intents`** - one row per attempt to collect money online.

| Column | Notes |
|---|---|
| `id` uuid PK | Internal |
| `organization_id`, `invoice_id`, `client_id` | Tenant and association |
| `provider` text | `paystack` (open set; `manual` is a separate path) |
| `environment` text | `test` or `live`; **test never posts to a production ledger** (4.4) |
| `provider_reference` text | Unique with `provider`. Format `KRL3-<L|T>-<random>` (4.2) |
| `invoice_amount`, `invoice_currency` | Amount of the invoice balance this intent will clear, in the invoice currency (`numeric(19,4)`) |
| `charge_amount_minor` bigint, `charge_currency` | What Paystack will actually charge (e.g. KES minor units) |
| `fx_rate`, `fx_rate_date`, `fx_source`, `quote_expires_at` | Snapshot used to derive the charge; null when currencies are equal |
| `status` | `created`, `initialized`, `pending`, `succeeded`, `failed`, `abandoned`, `expired`, `cancelled`, `needs_review` |
| `token_hash` text unique | sha256 of the public link token; token never stored |
| `link_expires_at` | |
| `authorization_url` | Provider hosted URL (not a secret, but not logged) |
| `created_by`, timestamps | |
| Constraint | **At most one open intent per invoice** (`unique (invoice_id) where status in ('created','initialized','pending')`). Regenerating a link cancels the previous open intent after verifying its outcome with Paystack (same rule the existing checkout uses) |

**`provider_events`** - append-only verified-event and verification log.

`(id, organization_id null, provider, environment, event_key, event_type, provider_reference, payment_intent_id null, status received|processing|processed|ignored|failed|needs_review|exhausted, attempts, error, payload_sanitised jsonb, received_at, processed_at)`. **Unique `(provider, event_key)`.** Sanitised payload only (no customer, card, authorization objects), as the existing handler does.

**`payments`** - one row per recorded money receipt (online or manual).

`(id, organization_id, invoice_id, client_id, method card|apple_pay|bank_transfer|cash|other, provider null, provider_reference null, provider_transaction_id null, environment, amount, currency, received_at, cash_account_id, fee_amount null, fee_currency null, verification_status verified|pending_verification|rejected, verified_at, verified_by null, ledger_entry_id, status recorded|refunded|partially_refunded, created_by null, idempotency_key)`.
Unique `(organization_id, idempotency_key)`; unique `(provider, provider_reference)` where not null; unique `provider_transaction_id` per provider where not null.
A payment row is created **only** in the same transaction as its ledger posting.

**`refunds`**: `(id, organization_id, payment_id, invoice_id, amount, currency, reason, status requested|approved|processing|processed|failed|rejected, provider_refund_reference null, requested_by, approved_by, processed_at, ledger_entry_id null, idempotency_key)`.

**`receipts`**: `(id, organization_id, payment_id unique, receipt_no, issued_at, snapshot jsonb)`; `snapshot` freezes studio/client details, invoice number, amounts, previous paid amount, remaining balance, payment method and provider reference at generation time (roadmap 3.D).

**`public_links`** (invoice view and pay): `(id, organization_id, invoice_id, kind view|pay, token_hash unique, expires_at, revoked_at)`. Opaque 256-bit tokens; no internal id appears in a URL.

---

## 4. Rules

### 4.1 Amount authority
* The amount of an intent is computed **in the database** from the receivable's outstanding balance at creation, may be lower for a partial payment (`p_amount <= outstanding`), and is **re-validated at settlement** against the *current* outstanding. A browser or Edge Function never supplies an amount, currency or rate.
* If the balance dropped after the intent was made, `fin3_settle_payment` records what it can only if the payment is not larger than the outstanding; otherwise the payment is held `needs_review` (overpayment `V3012`) - never silently accepted or truncated.

### 4.2 References
* Format: `KRL3-<L|T>-<12 random base32 characters>-<4 checksum characters>`. `KRL3-` is disjoint from every existing prefix (`KRL-L-`, `KRL-T-`, `KRL-W-`), which makes routing unambiguous. **No fragment of any internal id** (P8). Uniqueness enforced by the database; generation retries on collision. Paystack allows letters, digits, `-`, `.`, `=` in references; the format stays inside that set.
* A reference belongs to exactly one engine for its whole life.

### 4.3 Verification (roadmap 3.C, 5.3)
A payment becomes `verified` only when **all** hold: signature valid over the raw body with the key matching the environment; event type handled; reference known to V3; `GET /transaction/verify/<ref>` returns `status === true`, transaction `status = success`, `domain` equals the environment, `reference` equal, **currency equal**, **amount (minor units) equal** the stored intent; the invoice and intent belong to the same organization; the intent is not already settled. These checks reuse `interpretVerification`. Browser redirects, return pages and emails prove nothing; the return page may *trigger* the same server-side verification (like the existing `confirm` action) but cannot settle.

### 4.4 Test versus live
`environment='test'` intents are allowed only for organizations flagged `is_sandbox` in `org_settings`, and `fin3_settle_payment` raises `V3019` (`ENVIRONMENT_NOT_ALLOWED`) for a test payment against a non-sandbox organization. A live event can never settle a test intent and vice versa (environment compared at every step, as V2 does).

### 4.5 Fees
Only the **actual** fee reported by Paystack is recorded, once, as a separate expense event in the cash currency (as V2 does). Estimated fees are never posted.

### 4.6 Cross-currency
Invoice in USD and charge in KES is allowed. The posting is: debit the KES cash account for the amount received, credit accounts receivable in invoice currency for the invoice amount cleared, balance the difference to realized FX gain/loss, with the FX snapshot stored on the payment. Missing rate = the intent cannot be created (never 1:1, never today's rate on history).

### 4.7 Manual payments
Bank transfer, cash, M-PESA/Wise-style transfers: `fin3_record_manual_payment` creates a `payments` row with `verification_status='pending_verification'` and **no ledger effect**. An authorized user with `finance.verify_payment` (different from the recorder where the organization enables four-eyes) confirms it, which posts it. Unverified payments never increase available cash or reduce an invoice balance.

---

## 5. Webhook architecture

### 5.1 Router (the only change to the existing handler)
In `supabase/functions/paystack-webhook/index.ts`, **after** signature/environment identification and JSON parsing and **before** the first write to `paystack_webhook_events`:

```
reference = data.reference || data.transaction_reference
if (reference startsWith "KRL3-")  -> return await handleFinanceV3Event(...)   // new shared module
// everything below is the existing V2 path, byte-for-byte unchanged
```

* The V3 handler lives in a new module (`_shared/finance_v3_paystack.ts`) imported by the router; the router adds no V3 logic.
* Phase 3 must add a regression test proving the V2 path is unchanged for non-`KRL3-` references and update `integration-baseline.sha256` in the same change.
* Signature verification happens once, in the existing code, before routing; V3 never re-implements it.

### 5.2 V3 event processing (maps the roadmap's 15 steps)

1. Receive; 2. verify signature on the raw body (existing code); 3. validate event type (`isHandledEvent`); 4. extract reference; 5. **insert into `finance_v3.provider_events`** with `on conflict (provider, event_key) do nothing` - the idempotency point; a processed/ignored duplicate returns 200 immediately; 6-9. call Paystack verify and run the checks of 4.3 (status, amount, currency, intent/invoice association, organization ownership); 10. detect an already-recorded transaction (`payments` unique constraints); 11-13. `fin3_settle_payment` (service role) records the payment, posts the accounting event and updates the receivable **in one transaction**; 14. queue the receipt (receipt row + email row, Resend spec 3.1) in the same transaction; 15. mark the event `processed`.

### 5.3 Response codes (fixes P2)

| Condition | Result | Event status |
|---|---|---|
| Invalid signature | 401 | none stored |
| Unknown event type, unknown V3 reference | 200 | `ignored` |
| Duplicate, already processed | 200 | unchanged |
| **Permanent mismatch** (amount, currency, domain, org, intent not payable, overpayment) | **200** | `needs_review`; intent `needs_review`; internal alert (Phase 6); **no payment recorded** |
| Payment verified but **ledger cannot post** (locked period, missing FX, closed invoice) | 200 | `needs_review`; the verified facts are kept on the intent so the posting can be retried by an authorized user - the customer is never asked to pay again |
| Transient failure (Paystack verify unreachable, database error, lease lost) | **500** (Paystack retries) | `failed` with `attempts+1`; reconciler also retries |
| Refund event before its charge is settled | 500 (retry later), as V2 does | `failed` |

### 5.4 Reconciliation
Scheduled job (Phase 3 ships it, Phase 6 schedules it): for intents `initialized`/`pending` older than N minutes, call verify and process through the same path; for `provider_events` `failed`/`received` re-run; for verified-but-unposted (`needs_review` with `ledger_pending`) surface in the Accountant reconciliation view. All idempotent through the keys in 6.

---

## 6. Idempotency and duplicate prevention (layers)

| Layer | Mechanism |
|---|---|
| Event | unique `(provider, event_key)` using the existing `webhookEventKey` |
| Reference | unique `(provider, provider_reference)` on intents and payments |
| Provider transaction | unique `(provider, provider_transaction_id)` on payments |
| Posting | settlement idempotency key `fin3:pay:<provider>:<provider_reference>` through `post_event` (architecture D-10) |
| Concurrency | `select ... for update` on the intent and the receivable inside `fin3_settle_payment`; N parallel notifications produce one payment, one entry, one balance change (Phase 7 tests it) |
| Intent creation | one open intent per invoice (partial unique index); `fin3:intent:<invoice_id>:<n>` key for explicit regeneration |
| Receipt | unique `payment_id`; email key `fin3:email:receipt:<receipt_id>` |
| Retry safety | re-processing a processed event returns the original result |

---

## 7. Refunds and failures

* A refund is a **separate financial event** (`refunds` row + its own posting that credits cash and debits receivable/revenue per Phase 3 rules), linked to the original payment, with its own audit. The original payment and its entry are never voided or deleted (P9).
* `refund.processed` for a V3 reference creates/updates the matching `refunds` row (verified against the original payment: same currency, cumulative refunds <= payment) and posts the reversal; `refund.pending/processing` update status only; `refund.failed` marks the refund `failed` with no posting.
* Nothing is refunded automatically because an event or email arrived. Initiating a refund at Paystack is a deliberate operator action recorded as `requested -> approved -> processing`; Phase 3 decides whether to call the Paystack refund API or record refunds made in the Paystack dashboard (default: record dashboard refunds, verify through the event). Client refund notification: Resend `refund_notice`.
* Failed/abandoned payment: intent status updated; no payment, no ledger; notification; the invoice stays payable and the link can be regenerated under the single-open-intent rule.

---

## 8. Service contracts (roadmap G, items 1-11)

RPC names are fixed now; arguments finalise in Phase 3. Public RPCs are `authenticated`, derive the organization, check the permission, audit, and are idempotent. "Service" = service role only (Edge Functions).

| # | Contract | Callable by | Behaviour |
|---|---|---|---|
| 1 | **Payment initialization** `fin3_create_payment_intent(p_org, p_key, p_invoice, p_amount default null, p_channel, p_expires_days)` | user (`finance.collect`) | Validates invoice payable, computes amount and (if needed) FX in the database, creates the intent with reference and link token hash; returns intent id and the **plaintext token once**. Edge Function `finance-paystack-checkout` then calls Paystack `/transaction/initialize` with the intent's reference and amount from the database |
| 2 | **Payment link generation** `fin3_regenerate_payment_link(p_org, p_key, p_invoice)` | user | Verifies the old open intent's outcome (service step), cancels it if unpaid, creates a new intent; never creates a second financial transaction |
| 3 | **Webhook reception** | Paystack -> existing `paystack-webhook` router | Section 5 |
| 4 | **Signature verification** | existing `verifyWebhookSignature` / `identifyWebhookEnvironment` | Reused, unchanged |
| 5 | **Transaction verification** `finance_v3_paystack.verifyIntent(intent)` | service module | Section 4.3; `interpretVerification` |
| 6 | **Invoice association** | database | Intent carries `invoice_id` + `organization_id`; settlement re-checks both and the receivable's state |
| 7 | **Payment recording** `fin3_settle_payment(p_org, p_key, p_intent|p_invoice, p_provider, p_reference, p_provider_txn, p_amount, p_currency, p_received_at, p_cash_account, p_fee, p_environment)` | **service only** | One transaction: lock, validate, insert `payments`, post, update receivable, queue receipt + email. Provider-agnostic (roadmap 5.7) |
| 8 | **Duplicate-event prevention** | database | Section 6 |
| 9 | **Payment status updates** `fin3_apply_payment_status(p_provider, p_reference, p_outcome, ...)` | service only | Moves non-success intents among `pending/failed/abandoned/expired`; never downgrades a settled payment |
| 10 | **Refund event handling** `fin3_apply_refund_event(p_provider, p_event_key, p_reference, p_refund_ref, p_amount, p_currency, p_status)` | service only | Section 7 |
| 11 | **Failed payment handling** | via 9 + notification | Section 7 |

Provider-independence rule: tables and RPCs above name no Paystack-specific column except `provider` and opaque references. Adding another provider later means adding an Edge Function adapter, not changing the engine.

---

## 9. Security

* Secret keys, the service-role key and webhook signing material stay server-side. Guard test scans V3 paths.
* Public checkout (V3 function): token is the only credential; compared as hash; per-token and per-source throttling (P6); responses expose no internal ids; errors are fixed user-safe strings.
* Public invoice/payment pages (Phase 3 backend, Phase 5 UI) use `public_links` tokens; revocable; expiring; never show other invoices.
* RLS by `organization_id` on every V3 table; client roles have no DML; settlement and event RPCs revoked from `public, anon, authenticated` and granted to `service_role` only (as V2 does for its apply functions).
* Webhook endpoint: unchanged hardening (body cap, signature before any DB work, key-ring environment detection).
* Audit: every payment, refund, override and `needs_review` resolution writes `audit_log`.

---

## 10. Owner checks before Phase 3 (cannot be done from the repo)

1. **Paystack dashboard -> Settings -> API Keys & Webhooks:** the *test* and *live* webhook URLs (expect `.../functions/v1/paystack-webhook`); confirm there is one URL per mode (P7).
2. **Account capability:** which currencies and channels the live merchant account can collect (the code forces KES; confirm whether USD collection is enabled) (P10).
3. **Deployed secrets** exist (names only): `PAYSTACK_MODE`, the key for that mode, `APP_URL` (https). **Rotate the live secret key**: the previous session reported a file that appeared to hold a live key was uploaded to a chat.
4. **Live data shape** (counts only):
   ```sql
   select status, apply_status, reconciliation_status, count(*) from paystack_transactions group by 1,2,3 order by 4 desc;
   select status, count(*) from paystack_webhook_events group by 1;
   ```
5. **Decision D-17** (extend the existing webhook with a router) - confirm.
6. **Decision D-18:** V3 charges in KES like today (default) or collects in invoice currency if the account supports it.
7. A Paystack **test** environment plus a disposable Supabase/PostgreSQL branch for Phase 3 testing.

---

## 11. Phase mapping

| Phase | Paystack work |
|---|---|
| 2 | Event and idempotency foundation (`events.idempotency_key`, provider-neutral external-event contract). **No payment tables or functions** |
| 3 | Tables 3.2, RPCs section 8, `finance-paystack-checkout`, `_shared/finance_v3_paystack.ts`, the webhook router, reconciliation job, receipts, manual payments, refunds, tests (incl. V2-path regression) |
| 4 | Verified payments feed cash availability only through the accounting layer; unverified payments never do (test) |
| 5 | Payment link UI, status, history, receipts |
| 6 | Notifications (verified, failed, pending, duplicate, amount/currency mismatch, unassociated, refund, manual review), scheduled reconciliation |
| 7 | Paystack audit and the 14 test scenarios of roadmap 7.C; **re-point V2 payment creation** (`payments_create_checkout_session`, `paystack-checkout`) to refuse V3 organizations; cutover/rollback |

---

## 12. Protection of existing infrastructure (enforced)

* `docs/finance-v3/integration-baseline.sha256` pins `paystack-webhook`, `paystack-checkout`, `paystack-payments`, `_shared/paystack_*`, `_shared/payments/*`, `config.toml`, and the Resend/Inbox/Intelligence transport files. **Phase 3 legitimately changes `paystack-webhook/index.ts` (router) and `resend-webhook/index.ts` (sink)**; it must update the baseline in the same change and say so.
* Guard: only one Paystack webhook function directory may exist; no second Resend webhook beyond the two that exist.
* Guard: V3 migrations may not alter, drop or write `paystack_*`, `payment_*`, `email_*`, `intel_*` tables.
* Guard: V3 reference prefix `KRL3-` must not collide with `KRL-`.
