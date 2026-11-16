# Emma: the Agent Chat that acts (13 Nov 2026)

Emma can now do things, not only answer. The safety model is the same one as before, extended.

## What she can do
| Ask | Tool | Runs as |
|---|---|---|
| "Email jane@x.com and tell her…" | `send_email` (Emma writes subject and body) | your browser, through `email-send` (same path as the Inbox) |
| "Add to the knowledge base: …" / "replace the logo pricing entry" | `save_knowledge` (saves and approves), `retire_knowledge` | your session, via the existing KB functions |
| "Change the send window to 9–17", "set the time zone to Asia/Tokyo" | `change_setting` (12 allowed settings) | your session, via `intel_admin_update_settings` |
| "Rewrite the draft to Pixel Moon, shorter" | `list_drafts`, `edit_message` | your session |
| Everything from before (approve, limits, campaigns, prospects) | unchanged | unchanged |
Read tools: `settings_overview`, `knowledge_list`, `knowledge_get`, `list_drafts`, `check_recipient`.

## Ask or do it
Chat > Emma > Permissions. Per kind of action: **Ask me** (a card you confirm) or **Do it** (Emma goes ahead while the chat is open). Defaults: everything = Ask me (a fresh install runs nothing by itself). Sender name, send window, time zone, warm-up and every daily limit are protected: they always wait for Confirm and can never be set to Do it. Stored in `intel_settings.emma_authority`; the database enforces it.
Only cards created after you opened the thread run by themselves; older pending cards always wait for a tap. Email is the one to switch on last: with "Do it", "email X saying Y" sends immediately.

## Never automatic, whatever you choose
Turning sending on, changing autonomy, do-not-contact entries, sender email / address / opt-out text. Also never possible from chat: user roles, admin status, memberships, permissions, removing a suppression, kill-switch changes through settings.

## Safeguards
- The worker still only proposes or reads. It cannot run or confirm anything.
- Every card is re-validated against current state when it runs (for example, a recipient added to do-not-contact after the card was made is refused).
- Email is claimed once in the database (`pending → running → done/failed`) and sent with the key `emma-<card id>`, so a double click or retry cannot send twice. Recipients on the do-not-contact list (address or domain) are refused. The recipient cannot be edited on the card; subject and body can.
- A request containing an email address no longer goes to the prospect draft resolver (that blocked "write to jane@x.com"). A prospect name still uses the Outreach draft flow.
- Knowledge text can no longer close its prompt block (`</approved_knowledge>`); retrieval now also uses your previous question.

## Deploy
1. Apply `supabase/migrations/20270103100000_intelligence_emma_actions.sql` (after the Phase 3 provenance migration and the Phase 4 job-reliability migration; independent of both). Not run anywhere yet.
2. Deploy the frontend; restart the worker (`chat.py`, `chat_kb.py`).
3. Chat > Emma > Permissions to review the defaults.
Rollback is at the bottom of the migration.

## Verified / not verified
Worker tests 955 OK; frontend `node --test` over the whole repo 1123 pass; `ChatView.jsx` parses. **Not run:** the SQL (no Postgres here), the Vite build, and a real send or live Gemini/Ollama turn. Test first with a message to yourself.


## Audit fixes (C1-C9)

- **Order of deployment (C6).** Apply the migrations first, then deploy the frontend: `20270102090000` (provenance), `20270103100000` (Emma actions), `20270109110000` (recover stuck), `20270110090000` (snapshot). Keep `20270105090000` after `20270103100000` (the grant loop now also exempts those two functions, so order no longer undoes it). The frontend degrades instead of failing if a migration is missing (no provenance badge, no stuck-card recovery), but the Emma actions migration is required for cards.
- **Emergency stop (C1).** `send_email` is refused at prepare and at claim while `kill_switch` is on.
- **Grounding (C2-C4).** Every proposal tool needs an `intent_quote` that appears, as whole words, in an order-shaped clause of the administrator's recent messages; `send_email` also needs its recipient typed by the administrator. Tool results are escaped so they cannot close the `<untrusted>` block.
- **Not changed (C9, by design).** The duplicate migration names (`intelligence_authorization`, `core_tables`, `crm_notifications`, `rpcs`, `zoho_oauth`, 20261108* and 20261109*) and the 2027 dates are not renamed: they may already be recorded in a remote migration history, and renaming applied versions breaks `db push`. Decide with `supabase migration list` against the real database before touching them.

## Second audit fixes (N1-N9)

- **Guard (N1-N4).** Japanese negation (ない, ません, するな, ...) and retractions in the latest message ("never mind", "cancel that", やっぱり) stop an order. English negation counts only before the quote, so "pause the indie campaign, not the studio one" works; "Do add this" is no longer read as a question; a quote may span two sentences. A knowledge entry must be mostly drawn from the administrator's own words. Email bodies are written by Emma by design, so email stays "Ask me" by default and its recipient must be typed by the administrator.
- **Stopped sending (N5).** While the emergency stop is on, an email card is not claimed and stays pending, so it can be sent after sending is turned back on (until it expires). Reasons are shown in words.
- **N7.** `20261112140000` had an extra `)` and could not be replayed on PostgreSQL 16; fixed. The whole Intelligence chain through `20270110090000` now replays on PostgreSQL 16.15.
- **Accepted, not changed (N8).** A stop flipped in the moment between the database claim and the browser send does not cancel that one email, and `email-send` does not read the kill switch (it also serves manual Inbox mail).
- **SQL contract.** `supabase/tests/intelligence_emma_actions.test.sql`, run by `run_intelligence_emma.sh` on a database prepared by `run_intelligence_auth.sh`. Note `run_intelligence_auth.sh` itself stops at `20261012090000` (`activity_log.shot_id` missing in the stub schema); that is separate from Emma.
