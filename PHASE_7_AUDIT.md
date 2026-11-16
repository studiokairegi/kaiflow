# KairFlow Indie Outreach — Phase 7 Audit

**Audit date:** 2026-11-12  
**Repository audited:** `KairFlow_Indie_V2_Phase_6_Confirmed_Bugfixes.zip`  
**Phase audited:** Session 7 — Admin UI, Reply Review and Release Integration  
**Scope:** Read-only source, migration, contract-test and handoff review. No repository source files were modified. No database, secrets, worker, provider or deployment operations were performed.

## Verdict

**Phase 7 is not releasable as delivered.** The evidence-review UI and four-stage settings presentation are largely aligned with the Phase 7 handoff. However, the manual reply composer contradicts the approval-first requirement: it creates messages directly in the `approved` state, despite telling the administrator that the message is only a draft awaiting approval. The worker's approved-outbound queue treats that state as sendable.

The full Node suite and Python worker suite pass, but these results do not cover this runtime/database contract. The UI contract test checks source text and labels; it does not execute the reply RPC or prove the message remains pending approval.

## Confirmed findings

### P1 — Manual replies bypass the promised human-approval step

**Evidence**

- `src/intelligence/OutreachView.jsx:70-76` renders “Reply yourself”, says “Creates a draft for your approval. It is not sent automatically”, and calls `intelApi.composeReply(...)` when “Queue reply” is clicked.
- `src/intelligence/api.js:33` routes that action to `intel_admin_compose_reply`.
- The latest definition in `supabase/migrations/20261109120000_intelligence_rpcs.sql:268-283` inserts the outbound message with `kind='reply'` and `state='approved'` (line 279). It does not set `pending_approval`.
- `intel_agent_approved_outbound` selects outbound rows in `approved` or `reserved` state (`supabase/migrations/20261109120000_intelligence_rpcs.sql:895-900`). The worker therefore sees this manually composed reply as already approved and eligible for dispatch.
- No later migration in this archive replaces `intel_admin_compose_reply`.

**Impact**

If sending is enabled and the worker is running, clicking “Queue reply” can cause the message to be sent without a separate review/approval action. This directly contradicts the Phase 7 handoff and the UI's own copy that manual replies remain pending approval.

**Required correction**

Add a forward migration that changes `intel_admin_compose_reply` to create `pending_approval` messages with `auto_sent=false`. Keep the send queue restricted to explicitly approved messages. Add an integration-level regression proving a composed reply is absent from `intel_agent_approved_outbound` until an administrator explicitly approves it. Update the UI wording to match the actual state machine.

### P2 — Reply composer remains available for opt-out and other non-contactable outcomes

**Evidence**

- `src/intelligence/OutreachView.jsx:70` displays the composer whenever `conv.inbound && p` is true; it does not inspect `m.classification` or the prospect's contactability state.
- The Phase 6 classification RPC closes prospects for `unsubscribe`, `complaint`, `not_interested` and `already_has_trailer`, and creates permanent suppression for unsubscribe/complaint (`supabase/migrations/20261231100000_intelligence_phase6_reply_outreach_corrections.sql:25-38`).
- `intel_admin_compose_reply` does not check prospect status or suppression before inserting the message (`supabase/migrations/20261109120000_intelligence_rpcs.sql:268-283`).
- The existing reservation gate does re-check suppression and closed/suppressed prospect status and discards blocked messages (`supabase/migrations/20261116100000_intelligence_crm_reserve_send_email_gate.sql:18-31`). This is a downstream safeguard, so this finding does **not** establish that an opt-out email will be sent; it establishes that the UI/RPC can create an already-approved message that the send gate later rejects.

**Impact**

The interface invites an administrator to queue a reply after an unsubscribe or complaint even though the outcome banner says further contact is blocked. The RPC accepts it and relies on a later send-time denial. This creates misleading approved queue entries and obscures the true contactability state.

**Required correction**

Hide or disable the composer for unsubscribe/complaint and other terminal non-contactable outcomes, and make `intel_admin_compose_reply` reject suppressed/closed prospects and suppressed recipient addresses. Keep the send-time gate as the final independent safeguard.

## Validation and test results

| Check | Result |
|---|---:|
| Full Node test suite (`node --experimental-strip-types --test`) | **1,139 passed, 0 failed** |
| Full Intelligence worker suite (`unittest discover`) | **903 passed, 0 failed** |
| Focused Phase 7 Indie UI + qualification contract tests | **11 passed, 0 failed** |
| Production build (`npm run build`) | **Blocked** — `node_modules/vite/bin/vite.js` is missing |
| PostgreSQL / SQL execution | **Not run** — `psql` and Supabase CLI are unavailable |
| Browser / React interaction E2E | **Not run** |
| Live provider / send-path smoke test | **Not run** |

The Phase 7 UI contract test (`src/intelligence/phase7-indie-ui-contract.test.mjs`) has three source-pattern tests. It checks component/RPC names, settings copy, and outcome labels, but does not assert the actual database state created by `intel_admin_compose_reply`. The evidence RPC tests in the worker suite are also source-level migration checks, not execution of the SQL functions against PostgreSQL.

The worker suite printed expected mocked/preflight diagnostics, including unavailable structured-output probes and an `p_force_review` RPC probe failure; the unittest suite itself completed successfully. These diagnostics are not evidence that the Phase 7 UI works against a live database.

## What holds up

- `IndieAdminPanel` is mounted only for Indie Game Developer prospects and exposes separate reviewed evidence selection for developer identity, exact project title and contact email.
- The frontend API wrappers match the Phase 5 evidence/verification RPC signatures present in the archive.
- The database RPCs scope evidence and verification to the current admin organization and the exact prospect/evidence IDs. Identity verification requires separately reviewed developer and project evidence; contact verification requires the exact email in its reviewed evidence row.
- The evidence UI clearly distinguishes official project/developer evidence from external professional-profile contact evidence and warns that Kickstarter is not an accepted evidence source.
- The settings UI exposes `max_followups` from 0–4 and explains the Indie Day 5 / Day 10 / Month 3 / Month 6 sequence. The Phase 6 candidate SQL retains the non-Indie cap of three.
- Reply outcome labels distinguish `not_interested` from unsubscribe/complaint, and the UI states that `tell_me_more` replies require approval.
- The Intelligence module itself is guarded by the database-derived administrator/Master User access check; the UI does not create a new public route around that gate.

## Release blockers / acceptance still required

1. Fix P1 and P2 above in a forward-only patch; do not edit historical migrations that may already have been applied elsewhere.
2. Add real PostgreSQL tests for the composed-reply state, approval transition, send-candidate exclusion before approval, and suppression/closed-prospect rejection.
3. Run the complete migration chain in a disposable staging database and verify the RPC signatures/grants and RLS behavior.
4. Install dependencies in a controlled environment and run `npm ci`, `npm test`, and `npm run build`.
5. Complete browser acceptance for evidence creation, identity verification, contact verification, four-stage setting save/reload, each reply outcome banner, manual reply draft, explicit approval, and suppression behavior.
6. Confirm the deployed migration ledger before applying anything. The archive contains migrations from later roadmap phases; `supabase db push` may apply all pending local migrations, not only Phase 7.

## Audit boundaries

This was a source-only audit. No source changes were made to the extracted repository or the uploaded ZIP. No SQL was executed, no migration was applied, no Supabase project was contacted, no secrets were changed, no worker was started, and no email was sent.
