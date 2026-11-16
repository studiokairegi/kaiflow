# Rollback procedures

**Status: written and cross-checked against the code and migrations; NEVER EXECUTED.** No database, worker, mail provider or hosting account was
reachable in the Phase 7 session. Every SQL statement below was checked against the table and column definitions in the migrations
(`test_phase7_production_validation.py` checks the same names for the metrics pack), but none has been run. Run each one in a safe moment first
(the "drill" in Section 9) so the first time you need one is not an emergency.

**Who may run these.** Only the owner. Several statements need the Supabase SQL editor, which runs as the database owner and bypasses
row-level security; that is why they work when the app is down, and why they must be handled with care.

**Where the SQL editor matters.** The app's admin functions (for example `intel_admin_set_kill_switch`) only work from a signed-in owner session,
because they read the signed-in user. In the SQL editor there is no signed-in user, so those functions refuse. Use the direct statements below there.

---

## 1. Emergency stop: the sending ladder

Sending is protected by **three independent gates** plus the worker itself. Go down the ladder only as far as the situation needs; steps 1 and 2
are always safe and cost nothing to reverse. After each step, confirm with the query shown.

| Step | Do this | Confirm with |
|---|---|---|
| **1. Kill switch ON, autonomy shadow** (stops every send reservation) | In the app: Intelligence -> Overview -> the **Emergency stop** button (it reads **Enable sending** when sending is already off; leave it alone then). Or in the SQL editor: `update public.intel_settings set kill_switch = true, autonomy = 'shadow', updated_at = now();` | query 16 in `SHADOW_MODE_METRICS.sql` must show `kill_switch = true`, `autonomy = shadow` |
| **2. Stop the worker** | Controller: Stop (or stop the worker process). In-flight jobs are recovered by lease expiry the next time any worker claims (the claim function re-queues expired `running` jobs, or marks them `dead` when attempts are used up). | query 15: `silent_for` keeps growing; query 4 lists anything left `running` |
| **3. Provider accounts cannot send** | `update public.intel_provider_accounts set send_enabled = false, updated_at = now();` | query 17: every row `send_enabled = false` |
| **4. Provider-level gate closed** | `update public.intel_email_provider_registry set sending_enabled = false, updated_at = now();` and `update public.email_provider_flags set enabled = false, updated_at = now() where provider in (select provider_key from public.intel_email_provider_registry);` **Side effect: `email_provider_flags` is read by the general Email module as well, so this can stop that module sending through the same provider. Use it only when step 1-3 are not enough.** | query 17b |
| **5. Remove the credential** | Disconnect the account in the app (Provider accounts), or rotate/revoke the key at the provider (Resend dashboard, Google account security page, Zoho). | the provider's own dashboard |

**Then check nothing went out:** query 11 must return no rows during shadow mode and draft-only tests. If it returns rows, stop, keep the kill switch on,
and read the rows (`to_email`, `sent_at`, `provider_key`) before doing anything else.

**What does the kill switch actually stop?** It is checked by the final send reservation in the database (`intel_agent_reserve_send`) and by the
send job (which returns `kill_switch` without sending, and treats a missing setting as "on", so it fails closed). The worker cannot change it: `test_phase7_production_validation.py` fails if any worker
code can write the kill switch. Turning sending **on** needs sender email, physical address, opt-out text and a registered agent identity;
turning it **off** needs nothing.

## 2. Roll back the AI provider

| Goal | Do this | Confirm |
|---|---|---|
| Send **every** model call to Ollama at once | In `worker.env` set `KAIRFLOW_AI_FORCE_OLLAMA=1`, restart the worker | `python -m kairflow_intel selftest gemini` prints `SKIP ... rollback flag; Gemini was not called`, and `INFO routing: ... forced_ollama=True` |
| Stop Gemini being used at all (no key) | Empty `KAIRFLOW_GEMINI_API_KEY`, restart | selftest prints `SKIP gemini: KAIRFLOW_GEMINI_API_KEY not set` |
| Make the key unusable | Revoke it in Google AI Studio | the next selftest shows Gemini failing; calls fall back to Ollama and are marked as fallbacks |
| Change which sites use Gemini | `KAIRFLOW_AI_POLICY` (see `docs/production-roadmap-phase2/AI_ROUTING_CONFIGURATION.md`) | selftest routing lines |

Fallbacks never pretend Gemini succeeded: each job result stores how many calls each provider served and how many were fallbacks (queries 3 and 14).
The forced-Ollama behaviour is covered by mocked tests (`test_phase7_integration.py`, `RollbackEndToEnd`); it has not been exercised against a real worker.

## 3. Roll back discovery, research and queued work (non-destructive)

Global Rule 6 forbids deleting production data without explicit authorization, so none of these delete anything.

| Goal | Statement |
|---|---|
| Stop new discovery for a campaign | `update public.intel_campaigns set status = 'paused', updated_at = now() where type = 'indie_game_developer';` (or `'animation_studio_support'`) |
| Switch off one discovery source | `update public.intel_sources set enabled = false, updated_at = now() where key = '<source key>';` |
| Cancel work that has not started | `update public.intel_jobs set state = 'cancelled', finished_at = now(), updated_at = now() where state = 'queued' and kind in ('discover','research','qualify','draft');` |
| Retire an approved knowledge-base entry | `update public.intel_kb set approved = false, updated_at = now() where key = '<entry key>';` |
| Revive a dead job later | in the app's Logs view use the requeue action (it calls `intel_admin_requeue_job`) |

**Known behaviour to remember:** a `dead` scheduled job (for example `discover:<type>:<day>`) blocks its own day's slot until it is requeued, so
revive or replace it by hand if scheduled discovery stops (recorded in the Phase 4 and Phase 5 handoffs; there is no automatic revival yet).

Prospects and drafts made during a shadow run stay in the database. They are not harmful: nothing sends without approval and the kill switch.
If you want them hidden, that is a data decision for you; ask before any cleanup.

## 4. Roll back migrations

Apply migrations one at a time, in version order, after `MIGRATION_LEDGER.md` Section 2 shows what is pending. For each, the way back:

| Migration | Rollback | Data risk |
|---|---|---|
| `20270102090000_intelligence_phase3_chat_provenance` | restore the 4-argument `intel_agent_chat_reply` from `20261109140000_intelligence_v1_completion.sql`, then `alter table public.intel_chat_messages drop column if exists ai_provider, drop column if exists ai_model, drop column if exists ai_route_reason, drop column if exists ai_latency_ms, drop column if exists ai_mode, drop column if exists kb_keys;` (the file header has the same note) | dropping the columns deletes the provenance already stored; the worker still saves replies without it |
| `20270103090000_intelligence_phase4_job_reliability` | re-apply the two earlier function definitions from `20261109120000_intelligence_rpcs.sql` (checked: that file holds the immediately previous definitions of `intel_agent_fail_job` and `intel_agent_complete_job`) | none; function bodies only. The worker treats both versions as valid |
| `20270105090000_intelligence_phase7_service_role_grants` | the two `grant execute ... to authenticated` lines in the file header. **Not recommended**: it re-opens a grant wider than intended (the function bodies still refuse non-service-role callers) | none |
| `20261217090000_intelligence_remove_legacy_mailbox` | **There is no rollback.** It drops `intel_mail_account` and `intel_oauth_states`. Do not apply it without (1) your explicit authorization, (2) an export of both tables saved somewhere secure (`select * from public.intel_mail_account;` and `select * from public.intel_oauth_states;`, download as CSV; the first holds encrypted refresh tokens), (3) a check that every connected Gmail/Zoho account already appears in `public.intel_provider_accounts`. The migration itself refuses to continue if a connected legacy credential did not transfer | **permanent** |

Prefer a Supabase branch or a restored copy of the project to rehearse a migration before touching production. If a migration fails midway,
each file runs in one transaction (`begin; ... commit;`), so a failure leaves the previous state; read the error before retrying.

## 5. Roll back the app and the Edge Functions

Redeploy the previous build from your hosting provider's deployment history, and redeploy the previous version of any changed Edge Function
(`intel-resend-webhook`, `intel-resend-send`, `email-send` ...). The repository snapshot has no `.git`, so a git revert is not available from here;
in your clone `git revert <commit>` of the phase commit is the equivalent. The frontend tolerates older database rows (provenance and reports simply
do not show), so rolling the app back without rolling the database back is safe.

## 6. Roll back a rollout stage

Each stage in `PRODUCTION_ROLLOUT_PLAN.md` ends with a **stop rule**. When a stop rule fires: do Step 1 of Section 1 immediately, write down what you
saw (queries 4, 11, 12b, 14, 15 are the evidence), return to the previous stage's settings, and do not move forward until the cause is understood.

## 7. What cannot be rolled back

- **An email that has been sent.** It cannot be recalled. This is why sending stays disabled until you approve a stage, every message needs approval, and the first live stage is tiny.
- **Reputation effects at the mail provider** (bounces, complaints, blocklisting).
- **Dropped tables** (Section 4, legacy mailbox).
- **Text already sent to Gemini.** Under the current configuration approved knowledge-base text, chat history and CRM tool results can go to Gemini; free-tier terms apply (flagged in the Phase 2 handoff; Google's current terms were not checked).

## 8. Quick reference: which control is which

| Control | Where it lives | Default | Changed by |
|---|---|---|---|
| Kill switch (sending off) | `intel_settings.kill_switch` | **true** (off) | owner only; turning it off needs sender identity and a registered agent |
| Autonomy | `intel_settings.autonomy` | **shadow** | owner |
| Provider account may send | `intel_provider_accounts.send_enabled` | false when connected | owner |
| Provider-level send gate | `intel_email_provider_registry.sending_enabled` | per provider | owner |
| Daily caps and send window | `intel_settings` (`daily_initial_cap`, `daily_followup_cap`, `send_start_hour`, `send_end_hour`, `send_weekdays_only`) | see settings | owner |
| Per-message approval | `intel_messages.state` (`pending_approval` -> `approved`) | required | owner |
| Suppression list | `intel_suppressions` | empty | automatic on bounce/complaint/unsubscribe; owner |
| Force Ollama | `KAIRFLOW_AI_FORCE_OLLAMA` in `worker.env` | 0 | whoever controls the worker host |

## 9. Rollback drill (do this before Stage 2)

Run each item once while sending is off and nothing is queued, and tick it off with the date:

- [ ] Step 1 in the app, and Step 1 by SQL; confirm with query 16; set it back to the intended state.
- [ ] Stop and start the worker from the controller; confirm with query 15.
- [ ] `KAIRFLOW_AI_FORCE_OLLAMA=1`, restart, `selftest gemini` shows the SKIP line; set it back.
- [ ] Pause and re-activate a campaign; confirm with query 7 that no new prospects appear while paused.
- [ ] Cancel and re-create one harmless queued job (Section 3).
- [ ] Rehearse Section 4 on a branch or restored copy: apply `20270105090000`, then roll it back.
