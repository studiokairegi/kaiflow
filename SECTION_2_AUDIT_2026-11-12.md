# KairFlow Section 2 / Phase 2 Audit

**Audit date:** 2026-11-12  
**Source:** `KairFlow_Indie_V2_Confirmed_Bug_Fixes_2026-11-12(1).zip`  
**Scope:** Phase 2 Indie Game Developers qualification/scoring, contactability, evidence gates, send lifecycle, worker/provider safety and database migration contracts.

## Executive verdict

**Phase 2 is substantially intact and its local regression suites pass, but it is not fully sign-off ready.** One concrete send-lifecycle defect remains: a reserved message can be stranded when its previously acquired global send slot expires and another message takes ownership before the first message reaches `intel_agent_mark_sending`.

## Confirmed finding

### P1 — Expired/replaced send slot can strand a message in `reserved`

- `supabase/migrations/20261120090000_intelligence_phase2_send_slot_enforcement.sql`, lines 107–110: when the slot is owned by a different message, `intel_agent_mark_sending` returns `false` without changing the current message's state.
- `intelligence-worker/kairflow_intel/mailops.py`, lines 91–92: the worker reports this as `not_reserved_or_send_stopped`.
- `intelligence-worker/kairflow_intel/jobs.py`, lines 517–532: this outcome is not generally deferred/requeued unless the send window happens to be closed. Otherwise it becomes a job failure. The message itself remains `reserved`.

**Reproduction:** Worker A reserves a slot for message A, then pauses long enough for the 45–120 second slot to expire. Worker B acquires the next slot for message B. Worker A resumes and calls `intel_agent_mark_sending(A)`. The database sees B's slot ownership and returns false, but A remains reserved. This can strand A and leave it outside normal approved-message recovery.

**Required correction:** In the final transition RPC, when the message is still `reserved` but the slot is no longer owned by it (including ownership replaced by another message), atomically release A back to `approved`, clear `send_day`/`reserved_at`, and record a specific reason. Alternatively, return a structured retry outcome and ensure the worker safely releases/re-reserves A. Add a regression test for the replaced-slot case, not only the same-message-expired case. Preserve the final kill-switch check and never call the provider unless the current message owns a live slot.

## Areas that hold up at source/test level

- Indie qualification remains a 100-point deterministic model with independent mandatory gates; score alone cannot qualify a prospect.
- Project identity, dated activity/marketing opportunity, anime visual/style evidence, exact verified email, suppression status and protected-account checks are independently represented.
- Contactability does not equate a published email with deliverability; human confirmation or provider delivery evidence is required.
- Model-written English replies/drafts are not auto-approved; policy/grounding/duplicate checks and manual-review routing remain in place.
- Evidence trace is persisted write-once against outbound messages; the model receives stable evidence IDs from the context RPC.
- Global send pacing is database-coordinated rather than process-local; the final state transition rechecks kill switch and slot ownership.
- Ambiguous provider outcomes remain unknown/reconciliation-only rather than being blindly resent; Zoho reply threading fails closed.
- `intel_agent_org()` binds authenticated RPC calls to the configured Intelligence agent user, while relevant RPCs revoke public/anon execution.

## Validation performed on supplied archive

| Check | Result |
|---|---:|
| Full Node suite (`npm test`) | **1,138 passed, 0 failed, 0 skipped** |
| Full Python worker suite | **882 passed, 0 failed** |
| ZIP integrity | Passed; 952 entries |
| `npm run build` | Blocked: Vite dependency is absent (`node_modules/vite/bin/vite.js`) |
| PostgreSQL/Supabase migration execution | Not run; no database/`psql` runtime available |
| Live Gmail/Zoho/Resend acceptance | Not run; no provider calls or sends made |

The Python suite emitted expected mocked error/fallback/preflight diagnostics while still completing successfully. The local suite is not evidence that hosted RPC signatures, trigger ordering, RLS, provider response shapes or real mailbox behavior are correct.

## Deployment/documentation risks

1. The Phase 2 handoff still lists items as future Session 3–7 work even though this supplied combined repository includes later phase work. Treat those bullets as historical notes, not the current status of the combined repository.
2. The Phase 2 qualification migration has not been executed according to its handoff. The migration history contains later-dated files; reconcile the hosted Supabase migration ledger and apply only reviewed missing migrations in order. Do not blindly push the whole migration directory.
3. Production build, browser E2E, database runtime tests and live provider acceptance remain outstanding.

## Release recommendation

**Hold Phase 2 sign-off until the replaced-slot reservation defect is fixed and regression-tested.** Afterward, apply/reconcile the migrations in staging, run PostgreSQL acceptance checks, build the frontend, and test a single controlled mailbox with sending initially disabled. No production database, provider, account, or email was changed during this audit.
