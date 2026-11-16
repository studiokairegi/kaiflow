# PHASE 6 HANDOFF — Personalized Outreach and Reply Handling

**Date:** 2026-11-12  
**Starting archive:** `KairFlow_Indie_V2_Phase_5.zip`  
**Scope:** Session 6 only. Session 7 has not started.

## Outcome

Session 6 implements project-specific initial outreach, a hard no-unsolicited-portfolio rule, explicit deterministic reply outcomes, and a four-stage Indie sequence. The workflow remains approval-first and does not send messages.

## Main implementation

1. **Project-specific first contact:** exact game title, verified project evidence, verified visual evidence, concrete game/visual detail, cinematic animation opportunity, Studio Kairegi anime-animation-studio introduction, natural question, no em dash, no URL. A source-backed Indie candidate without a verified title is held for review.
2. **Portfolio policy:** no portfolio/showreel/reel/sample content or links in initial, follow-up, or re-engagement. Share portfolio only in a reply to an explicit request. Final outbound policy independently checks cold messages.
3. **Reply outcomes:** `not_now`, `not_interested`, `already_has_trailer`, `wrong_person`, `referral`, and `tell_me_more` are explicit. `not_interested` stops the current sequence but is not treated as unsubscribe/DNC. `tell_me_more` can produce a human-approved reply. Unsubscribe/complaint/bounce safety remains higher priority.
4. **Indie sequence:** Day 5 and Day 10 business-day follow-ups, then Month 3 and Month 6 re-engagement anchored to the original introduction. Re-engagement requires new verified dated development or marketing evidence. Any inbound message interrupts the sequence.
5. **CRM takeover:** the same Indie sequence and outcome distinctions apply to takeover conversations. Other campaign types keep their existing three-slot cadence.

## Database migration

`supabase/migrations/20261112192000_intelligence_indie_outreach_v6.sql`

- `max_followups` check expands from 0–3 to 0–4; default for new settings rows becomes 4.
- Existing settings values are intentionally preserved. Existing organizations must explicitly set `max_followups=4` to use all four Indie sequence stages.
- Replaces `intel_agent_followup_candidates(int)` with Indie Day5/Day10/Month3/Month6 logic. Non-Indie campaigns retain the prior configured business-day logic and a three-follow-up cap.
- Preserves authenticated-only function execution and organization scoping through `intel_agent_org()`.
- Migration is **not applied**. Staging review and deployed migration-ledger reconciliation are required.

## Files changed

Worker: `drafting.py`, `policy.py`, `classify.py`, `jobs.py`, `takeover.py`, `chat.py`; new `indie_outreach.py`.  
Tests: new `test_indie_outreach_v6.py`, plus updates to `test_logic.py`, `test_phase2_fixes.py`, `test_phase5_audit_fixes.py`, `test_takeover.py`, and `test_v1.py`.  
Database: new migration listed above.  
Documentation: `docs/INDIE_GAME_OUTREACH_V2.md` and this handoff.

No files removed. No frontend files changed.

## Validation

- Python unit tests: **863 passed, 0 failed**.
- Python compileall: passed.
- Frontend/Node tests: **1,126 passed, 0 failed**.
- `npm run build`: blocked because `node_modules/vite/bin/vite.js` is missing.
- SQL execution/RLS integration: not run; no `psql`, Supabase CLI or staging database.
- Browser E2E: not run.
- No live provider sends, CRM mutations, production migration or deployment.

## Known deployment caveats

- Existing organization `max_followups` settings are not automatically raised. Admins must choose 4 to enable all four Indie stages.
- The repository's migration filenames extend beyond the audit date. Confirm the actual deployed Supabase migration history before applying this migration.
- Session 7 must add the frontend for reply outcome review, portfolio-request handling, sequence settings, manual approval, and browser E2E. The backend RPC/worker flow is ready for that integration but has not been deployed.

## Next phase

Session 7 — frontend integration, administrator review controls, settings presentation, browser E2E, release checklist and final integration validation. Start only from the Phase 6 ZIP.
