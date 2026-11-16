# Merge: Phase 4 repo + Emma upgrade (13 Nov 2026)

Inputs: `KairFlow_Phase_4_Controller_Worker_Reliability_Full_Repo` (newer: Phase 4 job reliability, Emma master switch, shared chat UI, chat bug fixes) and `Emma_upgrade` (Emma can act: send email, knowledge, settings, draft edits, permissions). The upgrade was built on an older copy of the chat files, so overwriting would have dropped fixes from the Phase 4 repo. Merged by hand, hunk by hunk.

## What came from where
| File | Result |
|---|---|
| `kairflow_intel/chat.py` | Emma's tools, read tools, prompt, arg kinds (email/key/longtext), auto-run render text, email-address routing **plus** the Phase 4 repo's fixes: `_arg_hint`, question/negation-safe keyword fallback, whole-word prospect matching, follow-up draft routing, `InvalidModelOutput` handling, existing-draft message. Added argument hints for the new arg kinds. |
| `kairflow_intel/chat_kb.py` | Phase 4 repo's matching fixes (`'s`, opt-out, follow-up words) **plus** Emma's `_plain()` prompt-injection guard. |
| `src/intelligence/logic.js` | Phase 4 repo (jobPhase, emmaSwitch, ...) plus Emma's tool labels and the `running` action status. |
| `src/intelligence/api.js` | Phase 4 `lease_until` plus Emma's `chatClaim`, `chatFinish`, `setEmmaAuthority`, `p_auto`, `args/category/auto` columns. |
| `src/intelligence/ChatView.jsx` | **Rebuilt, not copied.** Emma's version was the old plain UI. Her cards, email card with edit/send, permissions panel, auto-run, Confirm all and starters were ported into the newer shared-chat UI (sidebar, MessageList, Composer, typing bubble). Existing tests for that UI still pass. Small additions in `emma-chat.css`. |
| `emma.js`, `emma-actions.test.mjs`, `test_emma_actions.py`, `docs/EMMA_AGENT.md` | Added as is (paths adjusted for the migration rename). |
| `test_v1.py`, `test_phase6_routing.py`, `test_phase7_integration.py`, `test_proposals.py`, `chat-actions.test.mjs` | Emma's versions (they only differ by `send_email` now being a real tool, and by the new migration). |
| `IntelligenceModule.jsx` | Identical in both. |

## Migration order (changed from the upgrade zip)
The Emma migration was `20270103090000`, the same version as Phase 4's `20270103090000_intelligence_phase4_job_reliability.sql`. Renamed to **`20270103100000_intelligence_emma_actions.sql`** so it applies after Phase 4. They touch different functions. Emma's migration also supersedes `_intel_chat_prepare` from `20261230100000` and already contains that migration's 0-4 follow-up ceiling. Do not run a blanket `supabase db push` (see Phase 4 handoff).

Deploy order: Phase 4 migration, Emma migration, frontend, restart controller, restart worker.

## Verified
Python `unittest` 1024 OK (Phase 4 baseline 1006, +18 Emma). Node `--test` 1191 pass, 0 fail (baseline 1173, +18 Emma). `chat.py` and `chat_kb.py` compile. `ChatView.jsx` syntax-checked with `tsc`.

## Not verified
Vite build, a browser run of the merged ChatView (layout of the permissions panel and email card inside the chat bubbles is untested visually), the SQL (no Postgres here), a real send, a live Gemini/Ollama turn, and the Windows switch. As before, test email with a message to yourself first.
