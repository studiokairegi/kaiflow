# KairFlow Intelligence — Follow-Up Workflow (Phase 6)

**Scope:** Master roadmap Phase 6, task 7-11 ("draft follow-ups based on actual conversation history",
"support existing prospects including the backlog of older prospects", "detect replies and classify
conversations", "synchronize messages with CRM records", "make drafts accessible through Intelligence
and Inbox").

**Baseline inspected this session:** `kairflow_intel/indie_outreach.py`, `studio_reeval.py`,
`drafting.py` (`build_followup`, `next_step`, `thread_parent`), `policy.py` (`scan_inbound`,
`hard_class`), and the frontend module list under `src/intelligence/` (file presence and naming only
— component internals were not individually re-read line by line this session).

## 1. Follow-up sequencing (task 7-8) — already in place

- `indie_outreach.due_sequence_stage(initial_sent, today, sent_followups)` computes which numbered
  follow-up (if any) is due, using business-day spacing (`business_days_between`) rather than calendar
  days, so a prospect isn't followed up on over a weekend gap.
- `drafting.next_step()` / `drafting.max_step()` cap the number of follow-ups per prospect
  (4 for `indie_game_developer`, 3 for everything else) and `thread_parent()` finds the correct message
  to reply into so a follow-up threads onto the original conversation rather than starting a new one.
- `drafting.build_followup()` composes from the actual prior thread (`sent_on`, `parent_subject`), not
  a generic template disconnected from what was already said.
- **Backlog of older prospects needing follow-up (task 8) - already implemented (corrected in the reconcile pass).** The
  scheduled `followup_scan` job (`jobs.h_followup_scan`) calls `intel_agent_followup_candidates` (latest definition:
  `20270101101000_intelligence_indie_pause_followups.sql`), which returns up to 20 (cap 100) `contacted` prospects per scan,
  oldest-sent first, that: have a linked CRM lead whose email matches the prospect's, have at least one sent initial/follow-up,
  have **no inbound reply**, have **no open follow-up draft**, and are due by business-day spacing (indie: 5 / 10 business days,
  then 3 and 6 months; others: `followup_business_days`, capped at 3). Indie prospects additionally require an active campaign.
  Prospects with a pasted conversation (`intel_lead_history`) are routed to the `takeover` job so the follow-up continues that
  thread; later steps become `reengagement` drafts. `h_draft` re-checks status before writing and `intel_agent_reserve_send`
  re-checks suppression/kill switch/caps at send time, so the scan itself needs no extra safeguard.
- `studio_reeval.py` is a **different** mechanism (re-scoring rejected/needs_review studios under `studio-v2`); an earlier version of
  this document wrongly presented it as the follow-up backlog. Phase 6 added only the `needs_review` explanation note to it.

## 2. Reply detection and classification (task 9) — already in place

`policy.scan_inbound(subject, body)` strips quoted history (`first_unquoted`, handling both top- and
bottom-posted replies and Outlook/Apple Mail/Thunderbird quote markers in English and Japanese) and
classifies the sender's own new text against ~15 categories (`unsubscribe`, `complaint`, `pricing`,
`negotiation`, `contract`, `deadline`, `availability`, `meeting`, `portfolio`, `interest`, `decline`,
`not_now`, `not_interested`, `already_has_trailer`, `wrong_person`, `referral`, `tell_me_more`).
`hard_class()` picks one class by a fixed priority order (`unsubscribe` and `complaint` always win)
specifically so these **cannot be overridden by anything the model decides** — classification of a
reply into a "hard" class is pure regex, not an AI judgment call, matching Global Implementation Rule
5 ("keep safeguards deterministic"). `is_bounce` / `bounce_details` / `is_auto_reply` separately handle
delivery failures and out-of-office auto-replies so neither is mistaken for a real human reply.

## 3. CRM / conversation sync (task 10) and draft accessibility (task 11) — now actually audited

The first pass only confirmed these files exist by name. This pass read them:

- **CRM sync is real and is confirmed delivery-only.** The migration
  `supabase/migrations/20261115110000_intelligence_sync_crm_email_status.sql` (read in full this
  session) defines `intel_agent_confirm_send(p_message_id, p_zoho_message_id, p_rfc_message_id,
  p_thread_id, p_sent_at)`: it is only called **after** a provider has confirmed delivery (the
  function itself rejects any message not already `reserved`/`sending`/`unknown`, and is idempotent
  if the message is already `sent`), and only then does it materialize the sent message into the
  matching CRM lead's `emails` jsonb array slot (`sent: true`, `dateSent`, `message`), advance
  `last_contacted_at`, and move a pool lead's `stage` to `cold_email` for an initial send. The
  function is `security definer`, access is `revoke`d from `public`/`anon` and `grant`ed only to
  `authenticated`. `src/intelligence/lead-email-sync.test.mjs` (a Node `node:test` file, not a Python
  test — it is not part of the 1116-test Python count anywhere else in this handoff) asserts these
  exact properties against the live migration text itself, so a future edit to the migration that
  removed the confirmed-delivery gate or the CRM update would fail that test.
- **Draft accessibility is real.** `src/intelligence/OutreachView.jsx`'s `ReviewModal` lets a human
  edit a pending draft's subject/body, then either **discard** it or **approve and queue** it; the UI
  text itself states the safety contract verbatim: *"Approving queues it. It is sent only if sending
  is on, a daily limit allows it, and the recipient is not suppressed."* `Thread` additionally blocks
  a reply UI entirely (`replyBlocked`) once the prospect is `closed`/`suppressed` or any inbound
  message was classified `unsubscribe`/`complaint` — the frontend enforces the same suppression logic
  the backend already enforces, so a human reviewer can't be shown a compose box for a contact the
  backend would refuse to send to anyway.
- `src/intelligence/conversation.js` (read in full this session) is a separate, **manual** take-over
  tool: an admin pastes an existing email thread (sent by hand, or from another mailbox) and
  `parseConversation()` makes a best-effort guess at message boundaries, direction and dates — purely
  client-side string parsing, no network, extensively guarded (`entryProblems()` refuses to save a
  conversation with an undetermined direction, an invalid date, or over the length caps). This is a
  different mechanism from the automated `intel_agent_confirm_send` sync above; both exist for
  different situations (an automated outreach send vs. importing a conversation that happened outside
  the system), and both are real, not stubs.
- `CrmFollowupView.jsx` was located but not read line-by-line this pass either (time was spent on the
  three items above, which were the ones directly named by Phase 6's task list); if the next session
  needs to verify it, the same read-the-actual-file approach used here should be applied before
  claiming anything about it.

**Conclusion:** tasks 10 and 11 are genuinely implemented, not gaps. No code change was needed in this
section once actually verified.

## 4. What this session changed here

Nothing in this section's code was modified — this section documents verification, not changes. The
only Phase 6 code changes across both passes are: the qualification-review addition described in
`PROSPECT_QUALIFICATION_SPEC.md` (`research.py`, `jobs.py`, `airouter.py`, plus their tests), and the
`ProspectModal.jsx` display addition also described there.
