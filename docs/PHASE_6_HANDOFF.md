# KairFlow Intelligence — Phase 6 Handoff

**Phase:** 6 — Re-evaluate existing studio prospects and protect CRM ownership  
**Status:** Implementation complete locally; automated suites pass.  
**Disposition:** Ready for administrator review and a controlled database dry-run. No production data was changed and no prospect population was re-evaluated in a live database.

## 1. Approved outreach architecture preserved

The Phase 5 project baseline already contains the later approved dynamic multi-adapter implementation. Phase 6 preserves it without replacing or rewriting provider code:

- Prospect communication routes through the dynamic Gmail, Zoho Mail and SMTP adapter registry.
- Resend is absent from the prospect-communication registry and remains deferred to a separate legitimate transactional route.
- Multiple provider accounts are supported through durable per-message account assignments.
- Incomplete account assignments fail closed; the router does not silently fall back to another provider.
- Zoho prospecting requires explicit human approval at the database gate.
- Existing provider/account purpose permissions, consent requirements, global caps, kill switch, idempotency and no-automatic-failover controls are untouched.

## 2. What was inspected

- `intelligence-worker/kairflow_intel/scoring.py`
- `intelligence-worker/kairflow_intel/research.py`
- `intelligence-worker/kairflow_intel/studio_reeval.py`
- `intelligence-worker/kairflow_intel/takeover.py`
- `intelligence-worker/tests/test_studio_scoring.py`
- `intelligence-worker/tests/test_takeover.py`
- `supabase/migrations/20261116090000_intelligence_crm_takeover.sql`
- `supabase/migrations/20261117090000_intelligence_studio_reevaluation.sql`
- `supabase/migrations/20261117100000_intelligence_studio_reevaluation_admin_rpc.sql`
- Existing CRM and prospect views, provider registry and provider-policy migrations.

## 3. Changes

### A. Scoring history and model attribution

- Added `intel_prospects.score_model` and backfilled it from the existing score breakdown / estimates. Where the previous model cannot be established, it is explicitly recorded as `legacy-unknown` rather than guessed.
- Added `intel_score_history` to preserve the prior status, score, model, breakdown, review reason and a snapshot of up to 100 supporting evidence rows whenever the score changes.
- Backfilled a baseline history snapshot for currently scored prospects. This is the earliest recoverable snapshot; it does not claim to reconstruct data that was never stored.
- Added administrator read-only RPC `intel_admin_phase6_score_audit()` for score/model/status counts, score-history counts, origin counts and the pre-outreach candidate population.
- Added the score/ownership inventory to the reevaluation panel.

### B. Existing prospect re-evaluation

- Expanded the controlled studio-v2 re-evaluation population from rejected-only to discovered animation-studio prospects in `rejected`, `needs_review`, `qualified` and `lead_linked` states.
- Qualified/lead-linked prospects are eligible only before Intelligence has recorded any message or pasted conversation. A valid existing CRM link is retained.
- Re-evaluation uses evidence freshly collected during the specific run; stale evidence cannot decide a new score.
- A previously qualified or lead-linked prospect is moved to `needs_review` pending human review, even if the new model says qualified. It is never silently re-qualified for outreach.
- A previously rejected prospect that scores qualified is also held at `needs_review` pending human review.
- Human-rejected, suppressed, already-contacted, conversation-history, manual/CRM-taken-over and indie-game records remain excluded.
- Re-evaluation does not create or modify CRM lead rows, draft messages, send messages, or change provider routing, autonomy, kill-switch or sending limits.
- Updated the UI copy and pilot/full-run confirmation to describe the wider pre-outreach scope and retained CRM links.

### C. CRM ownership and takeover provenance

- Added `origin_detail` to distinguish `discovered`, `manual` and `taken_over` origins without changing the existing `origin` enum relied on by older code.
- Added `takeover_actor` and `takeover_at`, populated from the authenticated actor or the original history record's `created_by` / `created_at` when available.
- Takeover removal is reversible: when the final pasted history is removed, the takeover actor/time are cleared and the origin detail returns to `manual`; when another history remains, the current history's actor/time is used.
- Added an administrator-only `intel_admin_crm_taken_over()` inventory RPC.
- Added a dedicated **Taken over** filter to the existing CRM follow-up view.
- Added fail-closed unique indexes to prevent multiple Intelligence prospects owning the same CRM lead or one prospect being attached to multiple CRM leads. The migration aborts with an explicit message if pre-existing duplicates need manual reconciliation; it never merges them silently.

## 4. Files changed

- `intelligence-worker/kairflow_intel/studio_reeval.py`
- `intelligence-worker/tests/test_studio_reevaluation_phase6.py` (new)
- `supabase/migrations/20261117090000_intelligence_studio_reevaluation.sql` (expanded pre-outreach scope)
- `supabase/migrations/20261117100000_intelligence_studio_reevaluation_admin_rpc.sql` (expanded admin selection scope)
- `supabase/migrations/20261118100000_intelligence_phase6_crm_ownership.sql` (new)
- `src/intelligence/api.js`
- `src/intelligence/ReevaluationPanel.jsx`
- `src/intelligence/CrmFollowupView.jsx`
- `src/intelligence/phase6-crm-ownership-contract.test.mjs` (new)
- `docs/PHASE_6_HANDOFF.md` (new)

No provider adapter source files or provider-policy migrations were modified.

## 5. Database migrations

- Modified the not-yet-applied studio re-evaluation migration to include pre-outreach rejected/review/qualified/lead-linked records.
- Added `20261118100000_intelligence_phase6_crm_ownership.sql` for score history, origin/takeover metadata, uniqueness enforcement and admin inventory RPCs.
- **No migration was applied.** The unique indexes deliberately fail if existing duplicate ownership records are found; inspect and reconcile those manually before applying.
- SQL was checked through source-level regression contracts, not executed against a disposable PostgreSQL database in this session.

## 6. Verification

- Python worker suite: **423 passed, 0 failed**.
- JavaScript suite (`npm test`): **778 passed, 0 failed**.
- Python compilation: passed (`python -m compileall -q intelligence-worker/kairflow_intel`).
- Added regression coverage for eligible status classes, manual/taken-over and indie exclusion, contacted/closed exclusion, score-history preservation, takeover actor/time, reversible takeover metadata, unique ownership constraints and re-evaluation scope.
- Existing tests also retain the Gmail/Zoho/SMTP adapter and Zoho human-approval contracts.

The worker test suite prints expected diagnostic output from mocked failure-path and environment preflight tests; the unittest runner exits successfully with `OK`. The live Ollama preflight and live Supabase RPC probe are environment checks, not part of the unit-test pass count; they reported missing/inconsistent external environment capabilities in this local session. No live records were written.

## 7. Remaining acceptance work / boundaries

- Run `intel_admin_phase6_score_audit()` and the reevaluation preview after applying migrations in a reviewed staging database; actual prospect counts and per-model distribution are not available from this local source package.
- Run a small administrator-approved pilot before any full re-evaluation. Do not start the full run merely because the code is ready.
- Review all `needs_review` outcomes manually before allowing outreach. Contactability remains an independent Phase 5 gate.
- If the uniqueness preflight detects duplicate CRM ownership, resolve it manually before migration application.
- Phase 7 still owns comprehensive delivered/delayed/bounced/complaint event reconciliation.
- Phase 8 still owns atomic final send eligibility and send-state race handling.
- Phase 9 still owns the Steam/itch source-registry bypass.

## 8. Safety confirmation

- No database migration applied; no production database modified.
- No deployment or Git push.
- No worker activation or restart.
- No provider account activated or connected.
- No autonomy, kill-switch, quota or sending-policy change.
- No real email or outreach sent.
- No Resend prospecting route introduced; Zoho human approval preserved.

## 9. Stop condition

Phase 6 implementation is complete. Stop here. Phase 7 is the next phase and must be separately authorized.

## 10. Post-audit bug fixes (8 November 2026)

A follow-up bug audit identified and corrected two defects:

1. The `origin_detail` backfill in `20261118100000_intelligence_phase6_crm_ownership.sql` referenced `p.id` in a correlated history lookup without aliasing the target table. The `UPDATE` now declares `public.intel_prospects p`.
2. `ReevaluationPanel` previously coupled reevaluation status and the optional score-audit RPC with `Promise.all`. It now uses `Promise.allSettled`, displays reevaluation status independently, and reports an audit-only error if the score-audit RPC is unavailable.

Regression coverage was added for both defects in `phase6-crm-ownership-contract.test.mjs`.

Post-fix verification:
- Python worker suite: 423 passed.
- JavaScript suite: 780 passed.
- Python compileall: passed.
- PostgreSQL migration execution remains unverified; no database was connected or modified.
- Frontend production build remains unverified because Vite is not installed in this checkout; no packages were installed.
