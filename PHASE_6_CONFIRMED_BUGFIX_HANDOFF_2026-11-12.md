# KairFlow Intelligence — Phase 6 Confirmed Bug Fix Handoff

**Date:** 12 November 2026  
**Scope:** Corrective fixes for the Phase 6 Personalized Outreach and Reply defects found in the independent audit.  
**Mode:** Local repository changes only. No deployment, Supabase migration application, production database access, email sending, or worker startup was performed.

## Result

The repository has been patched for the confirmed Phase 6 defects. The Python worker suite passes **903 tests** using:

```bash
cd intelligence-worker
python -m unittest discover -s tests -t . -q
```

The run emitted environment/diagnostic warnings (Gemini quota/auth fallback). Separate live smoke probes also reported failures for Ollama structured-output/model checks and one `p_force_review` RPC probe (`PGRST202`); these were not unittest failures, but they remain environment/integration checks to resolve. No PostgreSQL client or Supabase CLI was available, so the migration was not executed against a database and SQL syntax/runtime behavior is not certified by this handoff.

## Fixes applied

1. **Reply RPC label acceptance and safe outcomes**
   - Added `not_now`, `not_interested`, `already_has_trailer`, `wrong_person`, `referral`, and `tell_me_more` to the installed forward migration's accepted classification set.
   - `not_interested` and `already_has_trailer` stop the prospect sequence without inserting a permanent suppression.
   - `not_now`, wrong-person, referral, and tell-me-more outcomes are saved as replies and stop cold follow-ups. They are escalated through the existing review notification event.
   - Permanent reply suppressions are created for `unsubscribe` and `complaint`; the legacy `rejection` label is retained for compatibility but no longer creates a permanent reply suppression. Existing confirmed hard-bounce handling remains a separate delivery-failure safeguard.
   - Queued and reserved initial/follow-up messages are discarded when a reply is classified.
   - Legacy/model `rejection` results and explicit decline fallback are normalized to `not_interested`. Broad ambiguous decline patterns were narrowed; `not at this time` and the corresponding Japanese phrase are classified as `not_now`.

2. **Migration version collisions**
   - Renumbered the Phase 4 Kickstarter corrective migration to `20261112190000`.
   - Renumbered the Phase 5 integrity migration to `20261112191000`.
   - Renumbered the Phase 6 Indie outreach migration to `20261112192000`.
   - Added the Phase 6 forward correction migration at `20261231100000`, after the repository's prior latest migration (`20261230100000`).
   - The three former duplicate-version files now have distinct versions in the local migration directory.

3. **Follow-up candidate safeguards and campaign compatibility**
   - Rebuilt `intel_agent_followup_candidates` after the later CRM/Phase 2 overrides, rather than relying on the earlier Phase 6 function that would be overwritten.
   - Restored the manual-review `review_reason` exclusion and made it NULL-safe.
   - Added `Re-engagement held:` to the review exclusion. A no-new-evidence re-engagement now records a review reason on the prospect, avoiding a repeated daily model-drafting loop; a reviewer can clear the reason after new verified evidence is added.
   - Preserved Indie day 5/day 10 and month 3/month 6 scheduling, anchored to the original initial send.
   - Preserved the non-Indie three-follow-up cap and added the `max_followups >= 2` guard. The non-Indie re-engagement threshold now uses its effective three-step cap, so it remains reachable when configured for 3 or 4 and is not selected when configured for 1.
   - Restored the column default to 3. Indie accounts must explicitly opt into 4 stages. Existing stored values are not rewritten because the repository cannot distinguish a deliberate value of 4 from a value created under the previous default.

4. **Em-dash policy**
   - The final outbound policy boundary now blocks U+2014 em dashes in both subject and body for `initial`, `followup`, and `reengagement` cold outreach.
   - The Indie initial-draft validator also checks the subject as well as the body.
   - Reply messages remain outside this cold-outreach restriction.

5. **Held re-engagement visibility**
   - When the Indie evidence gate holds a re-engagement, the worker now sets a review reason as well as logging the event. Clear that review reason only after new verified, dated project evidence is available.

## Files changed

- `intelligence-worker/kairflow_intel/classify.py`
- `intelligence-worker/kairflow_intel/policy.py`
- `intelligence-worker/kairflow_intel/drafting.py`
- `intelligence-worker/kairflow_intel/jobs.py`
- `intelligence-worker/tests/test_indie_outreach_v6.py`
- `intelligence-worker/tests/test_phase3_japanese.py`
- `intelligence-worker/tests/test_indie_research_integrity_v6.py`
- `intelligence-worker/tests/test_discovery.py`
- `supabase/migrations/20261112192000_intelligence_indie_outreach_v6.sql` (renamed)
- `supabase/migrations/20261112191000_intelligence_indie_research_integrity_v6.sql` (renamed)
- `supabase/migrations/20261112190000_intelligence_kickstarter_exclusion_identity_fixes.sql` (renamed)
- `supabase/migrations/20261231100000_intelligence_phase6_reply_outreach_corrections.sql` (new)
- `supabase/verification/phase6_reply_outreach_regression.sql` (new)

## Verification and limitations

- **Passed:** 903 Python unittest tests.
- **Passed:** static duplicate migration-version scan; no duplicate 14-digit versions remain.
- **Added:** `supabase/verification/phase6_reply_outreach_regression.sql`, a read-only database-side contract check against the installed RPC definitions and `intel_settings.max_followups` default. Run it in staging after applying the corrective migration.
- **Not run:** PostgreSQL migration execution, live RPC behavior tests, browser/UI tests, Node tests, Supabase CLI checks, production/staging database operations.

The verification SQL inspects the actual installed function definitions. It is not a substitute for end-to-end fixture-based RPC tests. Before release, run it in staging and exercise reply classification for each new label, checking the prospect status, suppression rows, and discarded queued messages. Also verify the final send boundary rejects a previously reserved cold message after an inbound reply.

## Deployment cautions

- This package has not been deployed. Do not infer that the migrations have been applied.
- Because three historical migration filenames were renumbered to resolve duplicate versions, compare the remote `supabase_migrations.schema_migrations` history before pushing. If any old colliding version was already recorded remotely, reconcile the migration history deliberately rather than blindly applying the renamed files.
- No production data was modified. The default change affects newly inserted settings rows; existing rows with `max_followups = 4` are intentionally left untouched.
- Not Now remains a human-reviewed pause. This patch does not invent an automatic re-contact date or schedule. Interested replies continue to update the CRM lead stage and notify the owner; creating a dedicated opportunity record remains a separate product/schema decision. Wrong Person and Referral still require a separate contact-capture workflow; Already Has Trailer stops the sequence but does not yet create a dedicated CRM “No Current Need” marker. Pricing replies remain human-reviewed, but the $450 / $650 / $800+ reviewer guidance has not been encoded. These are Phase 6 specification gaps, not silently treated as completed.

## Recommended next release gate

1. Apply the migration to a staging database after reconciling migration history.
2. Run `supabase/verification/phase6_reply_outreach_regression.sql`.
3. Add fixture-backed tests that invoke the actual `intel_agent_classify_inbound` RPC and assert database side effects for all six new labels, unsubscribe, complaint, rejection, and bounce.
4. Test the full reservation-to-final-send race: receive a reply after reservation, classify it, and prove `intel_agent_mark_sending` refuses the queued cold message.
5. Resolve the outstanding Not Now, opportunity, contact-capture, and pricing-guidance decisions, then mark Phase 6 releasable and proceed to Phase 7 UI work.
