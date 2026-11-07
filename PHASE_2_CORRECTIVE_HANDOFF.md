# KairFlow Intelligence — Phase 2 Corrective Handoff

**Scope:** Corrective patch for the four findings from the Phase 2 audit.  
**Safety:** No deployment, push, worker activation, autonomy change, live mailbox operation, or real email sending was performed.

## Changes

1. **Reply relevance and inbound grounding**
   - Replies must cite the actual inbound message ID.
   - Added a deterministic relevance guard for portfolio/link, call/meeting, and clarification requests, with lexical-overlap fallback for other inbound messages.
   - Consequential reply language continues to fail closed for human review.

2. **Japanese similarity**
   - Added Japanese character-bigram tokenization, which works without an additional dependency.
   - Similarity now distinguishes different Japanese messages rather than treating all Japanese text as empty token sets.
   - Added Japanese duplicate and name-swapped regression cases.

3. **Re-engagement workflow**
   - The follow-up scan now honors the SQL candidate's `draft_kind`.
   - The final configured follow-up slot is composed using the distinct `reengagement` prompt.
   - To preserve the existing database message-kind contract (`initial`, `followup`, `reply`), the resulting re-engagement draft is persisted as `followup` in the final allowed slot. Existing approval, suppression, opt-out, send-limit and send-boundary rules therefore continue to apply.
   - Added a migration that marks the final follow-up slot as re-engagement for non-takeover prospects. CRM-takeover leads continue through their transcript-aware handler.
   - Corrected policy validation to treat re-engagement as a follow-up for mandatory opt-out and postal-address checks.

4. **Similarity threshold evaluation**
   - Centralized the threshold at `drafting.SIMILARITY_THRESHOLD` (0.55).
   - Added a 12-pair English/Japanese benchmark fixture covering exact duplicates, near-duplicates, name swaps and distinct messages.
   - The benchmark currently produces 6/6 duplicate detections and 6/6 distinct-message passes (0 false negatives and 0 false positives on this small fixture). This is a regression benchmark, not a claim of production-wide statistical calibration.

## Files changed

- `intelligence-worker/kairflow_intel/drafting.py`
- `intelligence-worker/kairflow_intel/jobs.py`
- `intelligence-worker/tests/test_logic.py`
- `intelligence-worker/tests/test_takeover.py`
- `intelligence-worker/tests/test_v1.py`
- `intelligence-worker/tests/fixtures/phase2_similarity_pairs.json`
- `supabase/migrations/20261117110000_intelligence_phase2_reengagement_scan.sql`

## Verification

- Python worker suite: **216 tests passed** (to be reconfirmed after final run).
- JavaScript suite: **750 tests passed**.
- PostgreSQL migration execution: **not run**; no disposable PostgreSQL/Supabase database was available in this environment.
- Frontend production build: **not run**; frontend dependencies are not installed in this working copy.
- Live Zoho/Gmail/Resend tests: not run.
- Real email sending: not performed.

## Deployment notes

The new SQL migration must be applied in a disposable/staging database and the `intel_agent_followup_candidates` RPC response checked before the updated worker is run there. The migration has not been applied to any database.

## Remaining limitations

- The similarity fixture is deliberately small and should be expanded with anonymized real draft pairs before treating 0.55 as statistically calibrated.
- Reply relevance is a deterministic guard, not a full semantic evaluator. Ambiguous requests should continue to be routed to human review.
- Japanese copy generation itself remains outside this corrective patch; this patch fixes the shared Japanese similarity defect only.

## Acceptance recommendation

Accept the code-level corrective patch for review after staging SQL validation. Do not enable outbound sending solely on the basis of these local tests.
