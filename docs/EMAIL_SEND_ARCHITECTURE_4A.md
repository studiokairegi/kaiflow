# KairFlow Email — Phase 4A: Sending Architecture Audit and Contract

**Date:** 10 November 2026
**Baseline:** `KairFlow_MultiProvider_Phase3_Adapters.zip` (`00 repo/`)
**Scope:** audit and specification only. **No repository file was changed, no migration written, nothing deployed or sent.**
**Next step:** your approval of this document. 4B has not been started.

---

## 1. Read this first

| Item | Result |
|---|---|
| Repo state check | The zip has **no Git history** (`git/` and `main/` are empty folders), so rule 3 ("verify the Git diff") cannot be done literally. I verified instead against the Phase 3 handoff: every file it lists exists, `email-send/index.ts` is the 31-line thin wiring it describes, and `sendInner` goes through `resolveAdapter`. |
| Test baseline | `node --experimental-strip-types --test` → **885 pass, 0 fail**. Matches the Phase 3 handoff exactly. |
| Roadmap conflict | The Phase 3 handoff previewed "Phase 4 = general-Email OAuth (`email_oauth_states`, `email_provider_connections`, `EMAIL_CREDENTIAL_KEY`)". Your revised Phase 4 is sending and CRM activity. I followed **your revised document**. The OAuth work is not cancelled, only unscheduled (decision D5). |
| Only one adapter exists | `BUILTIN_ADAPTERS` contains Resend only. "Multiple connected sender accounts" and "provider selection" can be tested in 4F only with several Resend accounts plus a fake second adapter (the Phase 3 tests already have one). |
| Not verified | Supabase hosted state, Phase 2 SQL (still unexecuted per the Phase 3 handoff), Deno runtime, live Resend. |

---

## 2. Current send flow (as read from the code)

1. **Composer** (`src/email/components/ComposeDialog.jsx`) → `emailApi.send` (`src/email/api.js`) → `functions.invoke("email-send")`. Body: `account_id, to, cc, bcc, subject, text, html, conversation_id, draft_id, idempotency_key, attachments`. No `provider`, no `lead_id`.
2. **`email-send/index.ts`** authenticates with the caller's JWT, requires `email_has_access` and `email_require_access` (admin + active Master User), and obtains the organization id **from the database**, not from the request.
3. **`handleSend` / `sendInner`** (`_shared/email_resend_logic.ts`):
   - `validateSendRequest` (recipients ≤ 50, attachments ≤ 10 / 10 MB, subject, body size, key format). Unknown body fields are silently ignored.
   - `getAccount(org, account_id)` → must exist and be `active`. **`account.provider` is the only input to dispatch.**
   - `getProviderRegistryRow` → `resolveAdapter` (`provider_not_registered` 409, `provider_disabled` 503, `adapter_unavailable` 503).
   - `adapter.configurationProblem`, then the legacy flag (`email_provider_enabled('resend')`).
   - Limits: 20 per minute per org (all providers), daily per provider (default 100).
   - `getThreadParent` (org + account scoped) → `buildThreadHeaders`.
   - `email_create_outbound` RPC: idempotent on `(organization_id, idempotency_key)`, refuses a conversation or draft belonging to another account, inserts the `queued` row, conversation and participants.
   - `markResult(sending)` → `adapter.send` → outcome handling → `markResult(sent | rejected | failed | sending+error)`.
4. **Resend adapter** (`email_adapter_resend.ts`): `Idempotency-Key: kf-<key>`, bounded retry on 429/5xx, `unknown` outcome when acceptance cannot be ruled out.

**Existing Resend safeguards (all preserved, all covered by tests):** server-only API key, provider from DB row, idempotency key at both our DB and Resend, unknown outcome never auto-resent, thrown adapter exception treated as unknown, attachment copy failure never reported as send failure, `sent` bookkeeping failure reported as success with a warning.

---

## 3. Findings

**F1 — The send path carries no CRM context.** Lead association exists only *after the fact*, at conversation level: `email_link_lead(conversation_id, lead_id)` is a separate RPC the Inbox calls from a dropdown. There is no lead-card composer; `ComposeDialog` is only used from the Inbox. A send "from a CRM Lead Card" does not exist yet.

**F2 — Two different ownership models meet here.** Email is organization-scoped. Leads are **user-owned** (`leads.user_id`, and `email_link_lead` checks `l.user_id = auth.uid()`). A lead owned by user A cannot be linked by user B in the same organization, even though both may send from the same sender account. 4B/4D must pick one rule (D1).

**F3 — "CRM activity" is not a table.** It is `leads.activity_log` (jsonb) plus the `leads.emails[]` "sent" flags, both written **client-side** by `buildActivityEntries` in `App.jsx`, which saves the *whole* lead object with `activityLog: [...old, ...new]`. A server-side append to that array can be overwritten by a stale client save. Intelligence has its own server path (`intel_agent_confirm_send` updates `leads.emails`), which this roadmap must not disturb. Details in §5.

**F4 — Duplicate risk on ambiguous outcomes (Phase 4C's core problem).** `ComposeDialog.send` rotates `key.current = newKey()` on **every** error. `emailApi.send` throws on `data.ok === false`, and the 202 "outcome unknown" answer has `ok: false`. So after an unknown outcome (or a client timeout where no answer arrives) pressing Send again uses a **new key**. For a new message that is a new row and a second Resend call, i.e. a possible duplicate email. (A saved draft is protected because a draft that is no longer `draft` raises "Draft not found".) Server-side idempotency is sound; the client contract is what breaks it. I read this; I did not run it.

**F5 — Provider-accepted but database-unrecorded loses the provider id.** If `markResult(sent, provider_message_id)` throws after Resend accepted the mail, the function returns `warning: sent_status_not_saved` but writes the provider message id **nowhere** (the `send_result` audit line carries no id). The row stays `sending`. Recovery by "record the accepted message instead of resubmitting" is impossible without that id (Resend's idempotent replay is the only fallback and only works inside Resend's idempotency window, which 4C must confirm against Resend's documentation).

**F6 — No reconciler for `sending` rows.** An unknown-outcome message stays `sending` forever with an error string. Nothing re-checks it, and there is no `unknown` value in the `email_messages.status` check constraint.

**F7 — Dispatch is already server-side.** 4B's "prevent frontend-supplied provider identities" is true today and tested; 4B is mostly *verify and extend*. Gaps for 4B: authorization is organization-level only (any admin Master User may send from any active account in the org); `paused` accounts are refused at send but can still be offered in the composer (Phase 1 Finding 9).

**F8 — Response shapes are inconsistent.** Success `{ok,message_id,conversation_id,status,warning?}`, duplicate `{ok:true,duplicate:true,…}`, unknown `202 {ok:false,status:"unknown"}`, refusals `{error,code?}`. The browser cannot reliably tell "failed, safe to retry" from "unknown, do not resend".

**F9 — Transactional Resend isolation.** The only other files that call Resend are `intel-resend-send` and `intel-resend-webhook` (Intelligence). They share `RESEND_API_KEY` and, through `resend-webhook`, the delivery-event path. I found **no separate "transactional notification" sender** in this zip. Please tell me which function(s) you mean so the isolation tests target the right files (D6).

---

## 4. Normalized contract (proposed)

### 4.1 Request (browser → `email-send`)

```ts
interface SendRequestV2 {
  account_id: string;            // UUID of an email_accounts row. The ONLY sender input.
  to: string[]; cc: string[]; bcc: string[];
  subject: string; text: string; html: string; reply_to: string;
  conversation_id: string | null;
  draft_id: string | null;
  idempotency_key: string;       // identifies ONE logical send; see 4.3
  attachments: { filename: string; content_base64: string; content_type?: string }[];
  crm?: { lead_id: string } | null;   // NEW, optional
}
```

- `provider`, `adapter`, `organization_id`, `user_id` are never read. A test asserts a request containing them cannot change dispatch (extends the Phase 3 test).
- `crm.lead_id` is **a claim to be verified**, never trusted: the server checks the lead exists and the caller may use it (D1) before the outbound row is created.

### 4.2 Response (`email-send` → browser)

```ts
type SendOutcome = "accepted" | "duplicate" | "rejected" | "failed" | "unknown";
interface SendResponseV2 {
  ok: boolean;                   // true only for accepted | duplicate-of-accepted
  outcome: SendOutcome;
  message_id?: string; conversation_id?: string;
  status?: string;               // email_messages.status
  retry_with_same_key?: boolean; // true for unknown; the client MUST reuse the key
  crm?: { lead_id: string; activity: "recorded" | "pending" | "skipped" };
  warning?: "sent_status_not_saved" | "crm_activity_pending";
  code?: AdapterErrorCode;       // existing normalised codes
  error?: string;                // safe, no secrets, no bodies, no provider payloads
}
```

| Situation | HTTP | `outcome` | Safe to resend? |
|---|---|---|---|
| Provider accepted | 200 | `accepted` | No (done) |
| Same key seen before, accepted | 200 | `duplicate` | No |
| Same key seen before, still `sending` | 202 | `unknown` | **Only with the same key** |
| Provider refused permanently (4xx except 429) | 422 | `rejected` | Yes, after editing, with a **new** key |
| Provider/transport failure proven not accepted (e.g. 429/5xx exhausted) | 502/429 | `failed` | Yes, same or new key |
| Provider may have accepted | 202 | `unknown` | **Same key only** |
| Auth / validation / configuration / disabled provider | 401/403/400/503/409 | none (`code`) | After fixing the cause |

Existing HTTP statuses and `AdapterError` codes are kept. The additions are `outcome`, `retry_with_same_key`, `crm`.

### 4.3 Idempotency rule

The key identifies the logical send. **Rotate it only after `rejected`, or after a pre-send refusal that created no row. After `unknown`, a timeout or no response, reuse it.** This is a client change (4C) plus the server returning the original row's state for a repeated key (already true).

### 4.4 Adapter contract

`EmailAdapter.send(ctx, account, AdapterSendInput) → AdapterSendOutcome` is **unchanged**. CRM context stays out of the adapter entirely: adapters never see lead ids. `providerMessageId` from the adapter is the single value 4D records.

---

## 5. How CRM lead context travels

```
Lead Card ──crm.lead_id──▶ email-send ──verify lead & caller──▶ email_create_outbound
                                                               │ writes email_conversations.lead_id
                                                               │ (same transaction as the outbound row)
                          adapter.send ◀──(no lead data)───────┘
                                │ providerMessageId
                                ▼
                markResult(sent, provider_message_id)  ──▶  CRM activity row (4D)
```

Proposed rules (each needs your approval):

1. **Lead id is persisted with the outbound row, atomically.** `email_create_outbound` sets `email_conversations.lead_id` when the conversation has none; a conversation already linked to a *different* lead is refused. Lead association therefore exists before the provider is called, so it survives any later failure.
2. **Activity is created only from a durable `sent` message** and keyed `UNIQUE(message_id)`, which gives idempotent creation and a natural recovery query ("messages with a lead, status sent or later, and no activity row").
3. **Source of truth = a new server-written table** (working name `crm_email_activities`: organization, lead, message, account, provider, provider message id, direction, from, recipients, subject, sent_at, recorded_at) referencing `email_messages` for the body (no second copy of content). The Lead Card reads it. **I recommend not appending to `leads.activity_log` from the server** because of the lost-update risk in F3 (D2).
4. **Recovery is independent of sending.** A recorder reads existing `sent` messages and writes activity rows. It never calls an adapter, so it cannot cause a second email.

Provider id durability (answer to F5), to be built in 4C/4D: write `provider_message_id` and `status='sent'` in one statement, retry the write a bounded number of times, and add `provider_message_id` to the `send_result` audit line (an opaque id, not personal data) so an operator can repair a row whose write failed.

---

## 6. Decisions I need from you

| # | Decision | My recommendation |
|---|---|---|
| D1 | Who may attach a lead to a send? Today leads are per-user. | Keep per-user ownership (the lead's `user_id` must equal the caller). Least change, no new sharing semantics. Say so if leads should be organization-wide. |
| D2 | CRM activity store | New `crm_email_activities` table; do not write `leads.activity_log` from the server. |
| D3 | Sending permission | Keep "any admin Master User in the org may use any **active** org account" for now; per-user account grants only if you want them (it would be a new table). |
| D4 | Add `unknown` to `email_messages.status`? | Not in 4C unless you want it; keep `sending` + error and add a reconciler view. Cheaper, no constraint change. |
| D5 | Old Phase 4 (OAuth connections, second real provider) | Defer and renumber later. 4F tests multiple accounts with Resend + the fake adapter. |
| D6 | Which functions are the "transactional Resend notifications"? | Tell me names; I will add a structure test that 4B–4F do not modify them. |

---

## 7. Rules added to the roadmap

1. Each sub-phase is a separate session / independently reviewable unit.
2. Inspect the current repository state at the start of every sub-phase.
3. Do not assume earlier changes were applied as proposed; verify the Git diff and the actual files. *(This zip has no Git history; until it does, verify against the previous handoff and re-run the test suite.)*
4. Do not start the next sub-phase without explicit approval.
5. Preserve all completed earlier work.
6. No real prospect emails in testing: controlled test accounts or mocks only.
7. Transactional Resend notifications stay isolated through all six sub-phases.
8. End every sub-phase with: modified files, migrations, tests, unresolved issues, rollback considerations.

**Architectural rule:** CRM activity recording must be recoverable independently of provider sending. If a provider accepts a message and the CRM write fails, recovery records the already-accepted message and never submits it again.

---

## 8. What 4B will and will not do (preview, not started)

- Verify and test the existing server-side dispatch against §4.1 (including `crm.lead_id` verification and the D1/D3 outcomes); add the response envelope of §4.2 for refusals and errors.
- Not in 4B: idempotency changes and client key rotation (4C), activity table and recorder (4D), Inbox sync (4E).
- Rollback for 4B: redeploy previous `email-send`; any migration will ship with a reverse script.

**Approval requested:** (a) this contract and §5 rules, (b) answers to D1–D6. Until then nothing in the repo changes.
