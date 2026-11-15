# Agent Chat Architecture (Phase 3, 12 Nov 2026)

## What already existed (verified, kept)
Agent Chat is a worker job (`chat.py`). The model returns `{action, tool, args, reply}`; code validates the tool against a fixed allowlist (`TOOLS`, `PROPOSALS`), cleans arguments, and calls one database function that re-checks the requester, caps calls per request and audits. Changes (approve, limits, sending, autonomy, suppression) are only *prepared*; the administrator confirms in the UI. There is no tool for roles or permissions. Tool results reach the model inside `<untrusted>` tags. Routing goes through the shared AI router as site `chat.plan`. None of this was weakened.

## What Phase 3 added
1. **Knowledge retrieval (`chat_kb.py`).** Each turn calls `intel_agent_kb` (approved rows only, same source as the email composer). Deterministic keyword scoring (key/title/body hits plus a kind boost: e.g. "price" boosts `pricing_guidance`) picks at most 4 entries, 1,400 characters each, 4,200 total. The prompt also carries a one-line index of every approved key and title, so the model knows what exists and what does not. The whole base is never inserted. No AI or extra request is used for retrieval.
2. **Grounding rules (`KB_RULES`).** Studio facts only from `<approved_knowledge>`; otherwise "not on file" and point to Settings > Knowledge base; no general-knowledge gap filling; pricing is guidance not a quote. Fixed rules in code: studio not freelancer; no unpaid/free samples; no promises on price, deadlines, capacity or contract terms. Knowledge text cannot add tools, relax rules or grant permissions (the allowlist is in code, tested).
3. **Failure behaviour.** If the KB cannot be read the turn continues and the prompt says "unavailable"; if it is empty the prompt says so. A KB failure never fails a chat turn.
4. **Message-level provenance (P1-04).** Each assistant reply stores provider, exact model, fallback reason, total planner latency, answer mode (`ai`, `deterministic_fallback`, `draft_handler`, `unavailable`) and the KB keys quoted. Migration `20270102090000_intelligence_phase3_chat_provenance.sql` adds the columns and replaces `intel_agent_chat_reply` with a 5-argument version (`p_meta`, default `{}`); the old 4-argument call still works. The worker saves the answer without metadata if the migration is not applied yet.
5. **UI.** The chat shows one line under each assistant message ("Answered by Gemini (model) · 1.2 s · knowledge: key", "Answered by Ollama … fallback reason: …", "Plain summary: no AI provider answered", etc.). Older rows show nothing.
6. **F-06.** The generic failure text no longer blames Ollama alone; keyword-fallback notes say "No AI provider could answer". Fallback answers are labelled deterministic and are never recorded as Gemini.

## Context and history
Tools (unchanged) supply active campaigns, prospects, opportunities, stats and CRM review on demand, only for the authorised administrator. History is the newest 16 messages of the same thread (1,500 chars each); threads persist across sessions. There is no cross-thread memory.

## Privacy note (D1=C, free tier)
Approved KB excerpts are sent to the chat planner, so under D1=C they go to Gemini with the history and tool results. Do not approve KB text you would not want under free-tier terms.
