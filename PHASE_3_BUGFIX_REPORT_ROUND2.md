# Phase 3 Agent Chat: Round 2 bug fixes (13 Nov 2026)

| # | File | Bug | Fix |
|---|------|-----|-----|
| 1 | `chat.py` `fallback_plan` | With the model down, questions and negations ran real actions ("why did we stop sending last week" -> emergency stop; "don't pause anything" -> pause all). `respon` also matched "responsible". | Stop/pause run only from a clause that is an order: no negation, not a question (polite "can you / please" still counts as an order). Clauses keep their "?". `respon` now needs response/respond forms. |
| 2 | `chat.py` `_handle` | A reachable model returning invalid JSON twice was reported as "check that Ollama is running" (mode `unavailable`). | `InvalidModelOutput` is handled apart from outages: "please rephrase" message, mode `deterministic_fallback`; keyword-fallback text no longer says "No AI provider" in that case. |
| 3 | `logic.js` `aiLabel` | Failed draft replies were labelled "Draft saved by the outreach composer". | Error-status draft_handler replies read "No draft was saved (...)". |
| 4 | `chat.py` `_draft_clause` | "Write a follow-up email to X" produced an INITIAL draft (or a confusing "not lead_linked" refusal). | Follow-up draft requests are not treated as initial-draft orders; they go to the model, which has `prepare_followups`. Intro requests that merely mention a follow-up still draft. |
| 5 | `chat_kb.py` `_tokens` | `studio's`, `clients'` never matched `studio`, `clients`. | Strip `'s`/curly apostrophes and trailing `'`/`-`; added `opt-out` and `follow-up` hint spellings. |
| 6 | `ChatView.jsx` `send` | Clicking a suggestion chip cleared the textarea. | Clear only when the text came from the textarea. |

Tests: worker 944 OK (937 + 7), frontend 247 pass (245 + 2). Not run: SQL tests, build, live Gemini/Ollama. No migration; deploy frontend and restart worker.

## Recheck (same day)
| # | File | Bug | Fix |
|---|------|-----|-----|
| 7 | `chat.py` `_name_hit` | Prospect names matched as substrings: a request for "Starlight Games" resolved to an unrelated prospect "Star" (and "Ink" matched "think about"), so research/review could target the wrong company. | Whole-word matching (equal keys, or one name made of whole words of the other); Japanese keeps substring matching. |
| 8 | `chat.py` `_NEGATION` | Regression from fix 1: a bare "no" blocked orders ("no, stop all sending"). | "no" removed from the negation list. |
| 9 | `chat.py` `_FOLLOWUP_DRAFT` | Regression from fix 4: Japanese pattern `フォロー` blocked "初回メールを作成、フォローは後で". | Pattern limited to フォロー(アップ)(の)メール/連絡. |

Tests after recheck: worker 949 OK, frontend 247 pass.

## Line-by-line review
| # | File | Finding | Fix |
|---|------|---------|-----|
| 10 | `chat.py` `catalogue` | The model was shown argument NAMES only. It never saw the allowed `type`/`status`/enum values, so e.g. "Find 10 indie game developers" depended on guessing `indie_game_developer`; anything else was silently dropped by `clean_args` and denied by the database as `bad_type`. | Catalogue now lists allowed values and ranges per argument. |
| 11 | `chat.py` `_DRAFT_TARGET` | ASCII-only: "Ubisoft Montréal" -> "Ubisoft Montr", "Café Games" -> "Caf" (draft refused as not found); "Éclair Studio" -> nothing. | Unicode word characters. |
| 12 | `chat.py` `fallback_plan` | Any "studio" in a pause request chose the animation-studio campaign only ("pause everything, our studio needs a break"). | `_campaign_type_hint`: all/everything/both wins; needs "animation" or "studio support". |
| 13 | `chat.py` `_handle_explicit_draft` | An already-waiting draft was reported as "Saved the initial outreach draft". | Says it is already waiting; no new draft created. |
| 14 | `chat.py` `_render` | Empty campaign list gave ". Sending is ON."; "Paused 0 campaign(s)." when all were already paused. | Clear wording for both. |
| 15 | `ChatView.jsx` / `logic.js` | "New chat" created an empty thread on every click; a tool used 3 times was listed 3 times. | Reuse the current thread while it is empty; list each tool once. |

Known limitations (not changed): a draft request phrased noun-first ("The email for X needs work, can you write a shorter one") is treated as an order to draft; a prospect name containing a stop word ("Games for Change") is cut at that word; the keyword fallback understands English only; knowledge retrieval uses the current message only; entries are cut at 1,400 characters; knowledge text is not escaped inside its prompt block.

Tests: worker 953 OK, frontend 249 pass.

## Rename
The "Agent Chat" tab is now **Emma** (tab label, `INTELLIGENCE_SECTIONS`, and the section title in `ChatView.jsx`). Internal names (`chat` tab id, `chat.py`, database objects) are unchanged. Frontend tests: 249 pass.
