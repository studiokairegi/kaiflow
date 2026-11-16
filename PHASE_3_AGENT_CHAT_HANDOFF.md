# Agent Chat ("Emma") Handoff Report

Date: 13 Nov 2026
Scope: Agent Chat only: `chat.py`, `chat_kb.py`, `ChatView.jsx`, the chat part of `logic.js`, `api.js`, and the chat SQL functions the worker calls. Starting point: `KairFlow_Phase_3_Bugfixed_Repository.zip` (937 worker tests, 245 frontend tests passing).

## 1. Summary
Three review passes (bug hunt, recheck, line-by-line) found and fixed **15 bugs**, and the tab was renamed from "Agent Chat" to **Emma**. All fixes have regression tests. No migration and no database change. Nothing here touches sending, the kill switch, secrets or production data.

| Check | Result |
|---|---|
| Worker tests (`python -m unittest discover -s tests -t .` in `intelligence-worker`) | 953 pass (937 + 16 new) |
| Frontend tests (`node --test src/intelligence/*.test.mjs`) | 249 pass (245 + 4 new) |
| SQL tests, production build, live Gemini/Ollama check | **Not run** |
| Migration `20270102090000_...phase3_chat_provenance.sql` | Read only, never executed |

## 2. What changed

### Safety of the keyword fallback (used only when the model is unavailable or unusable)
| # | Bug | Fix |
|---|---|---|
| 1 | Questions and negations ran real actions: "why did we stop sending last week" triggered an emergency stop; "don't pause anything" paused all campaigns; "who is responsible" returned stats. | Stop and pause run only from a clause that is an order (not a question, not negated). "Can you…/please…" still counts as an order. `respon` needs response/respond forms. |
| 8 | (Regression of 1) a bare "no" blocked orders such as "no, stop all sending". | "no" removed from the negation list. |
| 12 | Any "studio" in a pause request chose only the animation-studio campaign. | "all/everything/both" means every campaign; a bare "studio" no longer counts. |

### Honesty of what the user is told
| # | Bug | Fix |
|---|---|---|
| 2 | A reachable model returning invalid JSON twice was reported as "check that Ollama is running" (mode `unavailable`). | Handled apart from outages: "please rephrase" message, mode `deterministic_fallback`. Keyword-fallback text no longer says "No AI provider" in that case. |
| 3 | Failed draft replies were labelled "Draft saved by the outreach composer". | Error replies read "No draft was saved (…)". |
| 13 | An already-waiting draft was reported as "Saved the initial outreach draft". | Says it is already waiting; no new draft created. |
| 14 | Empty campaign list printed ". Sending is ON."; "Paused 0 campaign(s)." when all were already paused. | Clear wording for both. |

### Routing and matching
| # | Bug | Fix |
|---|---|---|
| 4 | "Write a follow-up email to X" produced an INITIAL draft (or a confusing refusal). | Follow-up draft requests go to the model (which has `prepare_followups`). Introduction requests that merely mention a follow-up still draft. |
| 7 | Prospect names matched as substrings: "Starlight Games" resolved to an unrelated prospect "Star", so research/review could hit the wrong company. | Whole-word matching; Japanese keeps substring matching. |
| 9 | (Regression of 4) a Japanese `フォロー` pattern blocked "初回メールを作成、フォローは後で". | Pattern limited to フォロー(アップ)(の)メール/連絡. |
| 11 | Accented names broke the draft path ("Ubisoft Montréal" became "Ubisoft Montr"). | Unicode word characters in the name pattern. |
| 5 | `studio's`, `clients'` never matched `studio`, `clients` in knowledge retrieval. | Strip `'s` and trailing `'`/`-`; added `opt-out` and `follow-up` hint spellings. |

### Prompt
| # | Bug | Fix |
|---|---|---|
| 10 | The model saw argument names only, never the allowed values, so "Find 10 indie game developers" depended on guessing `indie_game_developer`; other guesses were silently dropped and denied as `bad_type`. | The tool list now shows allowed values and ranges for every argument (e.g. `type: indie_game_developer|animation_studio_support`, `limit: integer 1-25`). |

### Frontend
| # | Bug | Fix |
|---|---|---|
| 6 | Clicking a suggestion chip wiped the text being typed. | Textarea cleared only when the message came from it. |
| 15 | "New chat" created an empty thread on every click; a tool used 3 times was listed 3 times. | Reuse the current thread while empty; list each tool once. |

### Rename
"Agent Chat" is now **Emma** (tab label, `INTELLIGENCE_SECTIONS`, section title). Internal names (`chat` tab id, `chat.py`, database objects) are unchanged. The assistant's own prompt does not use the name yet.

## 3. Files changed (7)
- `intelligence-worker/kairflow_intel/chat.py`
- `intelligence-worker/kairflow_intel/chat_kb.py`
- `intelligence-worker/tests/test_phase3_chat_knowledge.py` (classes `ReviewFixesRound2`, `ReviewFixesRound3`, `LineByLineFixes`)
- `src/intelligence/ChatView.jsx`
- `src/intelligence/logic.js`
- `src/intelligence/IntelligenceModule.jsx`
- `src/intelligence/chat-provenance.test.mjs`

## 4. Deployment
1. Build and deploy the frontend (tab name, label text, chip and New chat behaviour).
2. Restart the intelligence worker (prompt, fallback and matching changes).
3. No migration is required for these changes. The Phase 3 provenance migration from the earlier handoff is still **not applied**; the worker tolerates its absence (it saves replies without provenance if `p_meta` is rejected).

Rollback: redeploy the previous frontend and worker. Nothing persistent changed.

## 5. Behaviour changes to be aware of
- The model now sees a longer tool list (allowed values per argument). Expect slightly larger prompts.
- With the model down, "stop"/"pause" phrased as a question or negation now returns a status/stats answer instead of acting. Clear orders still act.
- Follow-up email requests no longer create an introduction draft; the model handles them.
- A draft request for a prospect already awaiting approval now says so instead of "Saved".

## 6. Known limitations (not changed)
- A draft request phrased noun-first ("The email for X needs work, can you write a shorter one") is treated as an order to draft.
- A prospect name containing a stop word ("Games for Change") is cut at that word, so the draft path cannot resolve it.
- The keyword fallback understands English only.
- Knowledge retrieval uses the current message only, not history.
- Knowledge entries are cut at 1,400 characters (can end mid-sentence) and are not escaped inside the `<approved_knowledge>` block (only admins can approve entries).
- Smaller UI items: stale messages can flash briefly when switching threads; a reply arriving after the 5-minute "no answer" banner appears only on the next refresh.

## 7. Still outstanding (carried from the Phase 3 handoff)
- Apply the provenance migration and run the SQL tests.
- Run the production build.
- Live evaluation with Gemini and Ollama, including the "Find 10 indie game developers" chip and a pause/stop request.
- Approve knowledge-base content so Emma has studio facts to quote.
- Decide whether Emma should introduce itself by name in the system prompt.
