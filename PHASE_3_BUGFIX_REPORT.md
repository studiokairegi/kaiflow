# Phase 3 Bug Review and Fix Report (Agent Chat and Studio Knowledge)

Date: 12 Nov 2026. Scope: Phase 3 files only (`chat_kb.py`, `chat.py`, migration `20270102090000_intelligence_phase3_chat_provenance.sql`, `src/intelligence/api.js`, `logic.js`, `ChatView.jsx`, Phase 3 tests).

## Method
Read the Phase 3 code and migration, compared the new `intel_agent_chat_reply` with the version it replaces, and probed knowledge retrieval with sample entries and queries. The migration was reviewed by reading only; it was not run.

## Confirmed bugs (all fixed)
| ID | File | Bug | Fix |
|----|------|-----|-----|
| B-01 | `chat_kb.py` `_tokens` | Words shorter than 3 characters were dropped, so `2D` and `3D` never matched (and the `"2d"` service hint was dead). | Keep 2-character terms that contain a digit. |
| B-02 | `chat_kb.py` `KIND_HINTS` | `"who"` and `"about"` were hint words but also stopwords, so they could never fire. | Removed them from the studio hints. |
| B-03 | `chat_kb.py` `KIND_HINTS` | The generic word `"work"` boosted every portfolio entry; the +4 boost alone was enough to select an entry unrelated to the question ("How does the work get done?"). | Removed `"work"` from the portfolio hints. |
| B-04 | `chat_kb.py` `_tokens` | Hiragana-only pairs (について, ください) matched nearly every Japanese entry, so unrelated entries were quoted to the model. | Pairs made only of hiragana are ignored. |
| B-05 | `chat.py` end of `handle` | When the model planned a tool call but gave no reply, the code-rendered summary was saved as mode `ai` with provider and model, so the UI said "Answered by Gemini". | Saved as `deterministic_fallback` (no provider or model). |
| B-06 | `chat.py` end of `handle`, `logic.js` | A model answer that was not a usable reply or tool call produced the "No AI provider answered, check Ollama" message and mode `unavailable`. The `deterministic_fallback` label also said no provider answered. | `unavailable` and the Ollama message only when the model really was unreachable; otherwise a "please rephrase" message. Label now reads "Plain text from the app, not written by an AI model". |

## Checked and not a bug
- Latency regex `'^\d{1,8}$'` in the migration is correct (single backslash in the file).
- The migration keeps the original function's checks and conflict handling; it only adds the provenance columns. The unique reply index it relies on exists in the v1 completion migration.
- `api.js` selects the new columns, and table-level select is granted to `authenticated`, so the new columns are readable.

## Open items (not changed)
- The keyword-fallback reply text still says "No AI provider answered" even when a model gave an unusable plan.
- Knowledge retrieval uses only the current message, not conversation history.
- Entries are truncated at 1,400 characters, which can cut a sentence.
- Knowledge text is inserted into the prompt unescaped (a `</approved_knowledge>` inside an entry would end the block). Only admins can approve entries.
- Carried from the Phase 3 handoff: migration not applied, live evaluation and KB content approval outstanding; SQL test and build not run.

## Verification
- Worker: 937 tests, OK (933 before; 4 added in `ReviewFixes`).
- Frontend (`node --test src/intelligence/*.test.mjs`): 245 pass, 0 fail (one assertion in `chat-provenance.test.mjs` updated for the new label text).
- Not run: SQL tests, build, live Gemini/Ollama checks.

## Files changed
- `intelligence-worker/kairflow_intel/chat_kb.py`
- `intelligence-worker/kairflow_intel/chat.py`
- `src/intelligence/logic.js`
- `src/intelligence/chat-provenance.test.mjs`
- `intelligence-worker/tests/test_phase3_chat_knowledge.py`
- Added: `PHASE_3_BUGFIX_REPORT.md` (this file)

## Deployment
No migration. Deploy the frontend (label text) and restart the worker. Nothing here touches sending, the kill switch, secrets or production data.
