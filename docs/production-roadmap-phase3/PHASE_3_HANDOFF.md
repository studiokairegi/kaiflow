# Phase 3 Handoff: Agent Chat and Studio Knowledge Integration

**Status: PARTIAL.** Code, migration, UI and mocked tests done; live evaluation, migration execution and KB content approval are outstanding. Phase 2's live gate is also still open (accepted by the owner on 12 Nov 2026 by asking to proceed).

## Files
- Created: `intelligence-worker/kairflow_intel/chat_kb.py`; `intelligence-worker/tests/test_phase3_chat_knowledge.py`; `supabase/migrations/20270102090000_intelligence_phase3_chat_provenance.sql`; `supabase/tests/intelligence_phase3_chat_provenance.test.sql`; `src/intelligence/chat-provenance.test.mjs`; `docs/production-roadmap-phase3/*`.
- Changed: `kairflow_intel/chat.py` (KB context, `_Trace`, `_clean_meta`, `_reply` with `p_meta`, draft-handler labelling, F-06 wording); `src/intelligence/api.js`, `logic.js` (`aiLabel`), `ChatView.jsx`; tests `test_proposals.py`, `test_phase7_integration.py` (expectations updated, see test results).
- Removed: none.

## Deployment (in this order)
1. Apply migration `20270102090000_...sql` (additive columns; replaces the 4-argument `intel_agent_chat_reply` with a 5-argument one with a default; grants re-applied). Run the SQL test file first on a copy. Rollback notes are in the migration header.
2. Deploy the frontend (shows the provenance line; older rows show nothing).
3. Restart the worker. If it runs before step 1, replies still save, without provenance.
4. In Settings > Knowledge base, add and approve the entries listed in `STUDIO_KAIREGI_KNOWLEDGE_BASE.md`.

## Tests (actual)
Worker 933 OK; npm 1146 pass; all mocked. SQL, build, live: not run (see `AGENT_CHAT_TEST_RESULTS.md`).

## Known risks / unresolved
- KB retrieval is keyword-based: synonyms the scoring does not know may miss an entry (the index still lists every key so the model can say what exists). Japanese matching is crude bigram overlap.
- Approved KB text goes to Gemini under D1=C on the free tier.
- Deterministic keyword fallback (no AI) still exists; it is now labelled, not removed.
- History is 16 messages per thread; no cross-thread memory.
- Chat cannot yet quote prospect/message history beyond what the existing tools return.
- Carried: Phase 2 live verification; Phase 4 items N-01, N-06 to N-08; Phase 7 migration ledger.

## Secrets: none new. **Outbound sending untouched and disabled; kill-switch state not verified.**

## Next (Phase 4)
Read roadmap and Phase 1 to 3 handoffs. Close the Phase 2 and 3 live checks or accept proceeding on mocks. Then controller/worker reliability: N-01, N-05 to N-08.
