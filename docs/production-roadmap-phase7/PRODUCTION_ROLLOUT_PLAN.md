# Production rollout plan

**Authority.** This is a plan for you to approve, not an instruction anyone has carried out. Nothing in it has been executed. **Sending stays
disabled until you approve Stage 5 in writing**, and Stage 5 is the only stage that can send an email.

**Numbers in this plan are proposals.** Thresholds such as "18 of 20" or "bounce rate under 2%" are my suggestions so that each gate is a
measurable yes/no. They are not derived from your data (none exists yet). Change any of them before you rely on it; record the final values
in the approval table at the end.

**Conventions.** "Query N" means numbered query N in `SHADOW_MODE_METRICS.sql` (read-only; run in the Supabase SQL editor).
"Rollback step N" means step N of the sending ladder in `ROLLBACK_PROCEDURES.md` Section 1.

## The shape of it

| Stage | What changes in production | Can it send email? | Approval |
|---|---|---|---|
| 0. Prepare | nothing | no | none |
| 1. Apply additive migrations | database functions and columns (reversible) | no | you |
| 2. Live provider checks | worker starts; real Gemini and Ollama requests with synthetic prompts | no | you |
| 3. Shadow mode | discovery, research and qualification run on real public sources | no | you |
| 4. Draft-only | drafts are written and reviewed; replies are tested inbound-only | no | you |
| 5. Limited live sending | a tiny, approved, individually-approved send volume | **yes, only here** | **explicit, written** |
| 6. Gradual increase | caps rise in small steps | yes | you, per step |

Do not skip a stage and do not run two stages at once. Each stage has an **exit gate** (go/no-go) and **stop rules** (if one fires, do Rollback step 1,
write down what you saw, and go back one stage).

---

## Stage 0. Prepare (no production change)

1. **Know what is applied.** `MIGRATION_LEDGER.md` Section 2: `supabase migration list --linked`, then `supabase db push --dry-run --linked`. Fill in Section 5 of the ledger.
2. **Decide about `20261217090000_intelligence_remove_legacy_mailbox`** (drops two tables, no rollback). Either leave it out of this rollout, or follow
   `ROLLBACK_PROCEDURES.md` Section 4 (authorization, export, verification). Recommended: leave it out until Stage 3 has passed.
3. **Backups.** Confirm in the Supabase dashboard what backup or point-in-time recovery your plan provides, and note the time you are relying on.
4. **Get the code into git.** The snapshots you uploaded have no `.git` folder. Commit the merged Phase 6 + Phase 7 tree to a branch in your clone so every later step has a revert point.
5. **Secrets.** `KAIRFLOW_GEMINI_API_KEY` and the agent password live only in `worker.env` on the worker machine; confirm neither is in the repository.
   `KAIRFLOW_MAIL_PROVIDER` stays `none` until Stage 5.
6. **Run the offline validation yourself** on your machine: `python scripts/phase7_validation.py --full --controller` from `intelligence-worker/`, and the project's own `npm test` and `npm run build`
   (the Phase 7 session could not run a full `vite build`).
7. **Do the rollback drill** (`ROLLBACK_PROCEDURES.md` Section 9).

**Exit gate:** ledger Section 5 is filled in; a backup point is noted; the branch exists; the drill is ticked; your own test and build runs pass.

## Stage 1. Apply the additive migrations (reversible)

Rehearse first on a Supabase branch or a restored copy: `20270102090000` (Phase 3), `20270103090000` (Phase 4), `20270105090000` (Phase 7), in that order, only those
the dry run lists as pending. Run the SQL test files that ship with them on the copy. Then apply to production one file at a time, deploy the matching app build,
and restart the worker.

**Confirm:** `python -m kairflow_intel selftest supabase` signs in as the agent and reports the settings; query 16 shows `kill_switch = true`, `autonomy = shadow`; query 17 and 17b show nothing allowed to send.

**Exit gate:** every selftest line passes; queries 16/17/17b show the safe state; Agent Chat answers a question and the provenance fields fill in (query 14).
**Stop rules:** any migration error (read it, do not retry blindly); the app or worker cannot sign in afterward -> `ROLLBACK_PROCEDURES.md` Section 4/5.

## Stage 2. Live provider checks (still no prospects touched)

These are the Phase 2-6 live gates, none of which has ever been met:

1. `python -m kairflow_intel selftest ollama`, then `selftest gemini` (one real, tiny request).
2. `python scripts/phase2_gemini_benchmark.py ...` as its header describes (synthetic prompts only, capped; fills the model-benchmark gap).
3. Force a fallback on purpose: revoke nothing; set `KAIRFLOW_AI_FORCE_OLLAMA=1`, restart, ask Agent Chat a question, check query 14 shows Ollama with a route reason; set it back.
4. Approve the knowledge-base entries you want Agent Chat to use (Phase 3 handoff step 4). Unapproved entries are never quoted.
5. Run **one real** `research.qualification_review` on a genuine `needs_review` prospect and check `p_estimates.ambiguous_evidence_review.generated_by` (the Phase 6 open item).
   (If no such prospect exists yet, do this in Stage 3.)
6. Read the free-tier terms for what Google may keep, because Agent Chat can send approved knowledge-base text, chat history and CRM tool results to Gemini (flagged since Phase 2).

**Exit gate:** a real Gemini request succeeded and was attributed to Gemini; the forced-fallback request was attributed to Ollama with a reason; daily request counts are within the limits (`KAIRFLOW_GEMINI_RPD`); you accept the data-handling terms or switch the policy to Ollama-only.
**Stop rules:** a request that should have stayed local appears as Gemini; the key appears in any log or screen.

## Stage 3. Shadow mode (real sources, no drafts sent, sending off)

Settings that must hold the whole time: kill switch **on**, autonomy **shadow**, no provider account `send_enabled`, `KAIRFLOW_MAIL_PROVIDER=none`.
Start with **one campaign** (indie developers first), public sources only (Kickstarter stays manual-only), then add the second campaign only after this stage passes for the first.

Run for **at least 7 days** so retries, restarts and a weekend show up. Each day check queries 1, 4, 11, 15; each end of week run queries 2, 3, 5-9, 14.

**Quality sample (a human judgement; this is the only way to measure accuracy).** Take the 20-report sample (query 9b). For each row open the source URLs and mark:
(a) *identity correct* - the studio or developer is real and the report names the right one; (b) *no invented facts* - every contact and claim traces to a source; (c) *qualification fair* - you agree with the qualified / needs-review / rejected call.
Record the marks in a spreadsheet; the ratio is the metric.

**Exit gate (proposed):** identity correct in at least 18 of 20; **zero** invented contacts or facts; qualification agreed in at least 16 of 20; query 11 returns **no rows**; dead jobs (query 4) are each explained;
duplicate share (query 8b) is understood, not necessarily zero; worker silent for no more than a few minutes outside planned stops (query 15); Gemini fallback share (query 3) is explained; no `kill_switch`/`autonomy` change by anything but you.
**Stop rules:** query 11 returns any row; any invented contact; the worker or a source fails repeatedly with no explanation; a source's terms look violated (disable it: `ROLLBACK_PROCEDURES.md` Section 3).

## Stage 4. Draft-only (sending still off)

1. Pick about 10 approved prospects per campaign. Generate drafts (the worker's `draft` job, or the opt-in `python scripts/phase3_acceptance.py --create-draft`, which never sends).
2. **Review every draft** against `OUTREACH_PERSONALIZATION_STANDARD.md`: studio positioning, nothing invented about clients, capacity or prices, no unpaid sample offered, personalization comes from recorded evidence, opt-out and sender identity present. Mark each *usable with light edit / needs rewrite / violates a rule*.
3. **Inbound test without sending anything from the system:** from another address of yours, email the connected mailbox with a test reply; confirm it syncs to the right thread and is classified sensibly (query 12 and 12b). Repeat with a bounce-style and an unsubscribe-style message.
4. Confirm follow-up *planning* only: queries 10 and 13 show follow-up drafts appear on schedule and none is sent.

**Exit gate (proposed):** at least 8 of 10 drafts per campaign usable with light edit; **zero** rule violations (any violation blocks the stage until its cause is fixed and the draft tests are re-run); inbound test replies synced and classified correctly in at least 9 of 10; query 11 still **no rows**.
**Stop rules:** any rule violation; any wrong-thread sync; query 11 returns a row.

## Stage 5. Limited live sending (needs your explicit, written approval)

I cannot approve this for you. Write the date, the volume and the stop rules in the approval table below before turning anything on.

Preconditions: Stages 0-4 passed; sender email, physical address and opt-out text set in Settings (turning sending on is refused without them); exactly one provider account connected and tested; suppression list loaded.

First live send goes to **your own addresses** (two or three, ideally at different providers) to check delivery, formatting, the opt-out link and bounce handling. Then:

- Autonomy stays **shadow** ("every email waits for your approval"): you approve each message yourself.
- Set `daily_initial_cap` to **3** (the default is 30) and the follow-up cap to **0** for the first week; keep warmup on; keep the business-hours send window.
- Turn the kill switch off only for the working window you are watching, and back on afterward, for the first week.
- After each day: queries 10, 11, 12, 15, and the provider's own dashboard for bounces and complaints.

**Exit gate (proposed, per week):** zero complaints; bounce rate under 2% on at least 20 sends; every inbound reply classified and visible; no message sent that you did not approve; every send traced in query 11 to an approval.
**Stop rules (do Rollback step 1 at once):** any complaint; a bounce rate of 5% or more; a message to a wrong or suppressed recipient; a business-rule violation in anything sent; the provider warns you or limits the account.

## Stage 6. Gradual increase

Raise one limit at a time, only with your approval, and only after a clean week at the current level: for example daily introductions 3 -> 5 -> 10, then follow-ups 0 -> 3. Never above the hard limit of 30
introductions a day (a database constraint), and never above the provider's own limits. Move to a less restrictive autonomy level only after weeks of clean data, and only by your decision; "autonomous" is outside this plan.

---

## What this plan cannot promise

- It cannot say these gates will be met; no live run exists yet.
- The Gemini free tier has daily request limits (`KAIRFLOW_GEMINI_RPD`, default 200). If shadow-mode volume exceeds that, calls fall back to Ollama and quality may drop; query 3 shows the share.
- It does not cover the general Email module's own rollout (its 7-phase plan is separate).

## Approval record (owner fills in)

| Stage | Approved by | Date | Settings at approval (caps, window, accounts) | Thresholds changed from this plan | Result |
|---|---|---|---|---|---|
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |
| 4 | | | | | |
| 5 (sending) | | | | | |
| 6, each step | | | | | |
