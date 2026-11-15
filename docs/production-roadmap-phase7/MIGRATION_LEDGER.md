# Migration ledger (generated from `supabase/migrations/` on 14 November 2026)

**Purpose.** Phases 3, 4 and 5 each carried forward "Phase 7 migration ledger" and "hosted migration ledger unknown; do not run a blanket `supabase db push`".
This is that ledger: every migration file in the repository, in the order the Supabase CLI applies them, with what it does and what needs care.
It is generated from the files, so it records what the repository contains. **It does not know what is applied on the hosted project.** Nothing
in this repository can tell you that; Section 2 shows how to find out without changing anything.

## 1. Totals and what needs care

| | |
|---|---|
| `.sql` migration files | 140 (versions are unique) |
| Before Intelligence (shot tracker, studio, payments, portal) | 39 |
| Intelligence and Email (from 20261108130000) | 101 |
| Newest migration | `20270105090000_intelligence_phase7_service_role_grants.sql` (**new in Phase 7**) |
| Real destructive DDL in Intelligence/Email migrations | **1 file, 2 tables** (below) |
| Stray non-`.sql` files in the folder (the CLI skips them) | 4 (kept for audit history; listed in Section 4) |

**Needs an explicit owner decision before it is ever applied**

- `20261217090000_intelligence_remove_legacy_mailbox.sql` permanently **drops `intel_mail_account` and `intel_oauth_states`**. It first backfills
  the provider-account registry and refuses to continue if a connected legacy credential did not transfer, but the dropped tables (including
  encrypted refresh tokens) cannot be restored from inside the database. Required before applying: owner authorization, a dated export of both
  tables, and the verification query in `ROLLBACK_PROCEDURES.md` Section 4. `test_phase7_production_validation.py` fails if any other destructive
  statement appears in an Intelligence or Email migration.

**Added by this roadmap and never executed anywhere (no database was reachable in Phases 2-7)**

| Version | Phase | What it changes | Reversible |
|---|---|---|---|
| `20270102090000_intelligence_phase3_chat_provenance` | 3 | adds 6 nullable columns to `intel_chat_messages`; replaces `intel_agent_chat_reply` (4 args -> 5 args with a default) | yes, note in the file header |
| `20270103090000_intelligence_phase4_job_reliability` | 4 | replaces `intel_agent_fail_job` and `intel_agent_complete_job` (same signatures) | yes, re-apply the earlier definitions from `20261109120000_intelligence_rpcs.sql` (checked: that file holds the immediately previous definitions) |
| `20270105090000_intelligence_phase7_service_role_grants` | 7 | `revoke`/`grant` only, on 2 functions: removes `authenticated` execute from `intel_resend_record_inbound` and `intel_agent_apply_delivery_event` | yes, grants listed in the file header (not recommended) |

Phase 5 and Phase 6 added **no** migration.

**Why the Phase 7 migration exists.** `20270103100000_intelligence_emma_actions.sql` ends with a bulk loop that grants `EXECUTE` to `authenticated`
on every `intel_*` function except the private `_intel_*` helpers and `intel_is_authorized_user`. It runs after two service-role-only functions had
been explicitly locked to `service_role`, so it silently re-opened them to signed-in users. Their bodies still refuse any caller whose role is not
`service_role`, so nothing was exploitable; the grant was wider than intended. The new migration narrows it again, and
`test_phase7_production_validation.py` replays every migration in order and fails if any later loop widens it a second time.

## 2. Find out what is applied, without changing anything

Run from the repository root with the Supabase CLI logged in and linked to the project:

1. `supabase migration list --linked` shows local and remote versions side by side. A version present locally and missing remotely is pending.
2. `supabase db push --dry-run --linked` prints what a push **would** apply and applies nothing. Read it before any real push.
3. Do **not** run a blanket `supabase db push`. Apply the pending Intelligence migrations one at a time, in version order, after Stage 0 of
   `PRODUCTION_ROLLOUT_PLAN.md`, and never `20261217090000` without the decision above. If the CLI refuses an out-of-order version it says so; do
   not use `--include-all` without reading the list it would apply.
4. Record the result in the table in Section 5 of this file.

## 3. Every migration

Versions are timestamps; some are dated after today because earlier sessions chose future dates to stay ahead of the hosted ledger. That is a
convention in this repository, not an error, and the CLI orders by version, so the order below is the order of application.

### 3a. Before Intelligence

| Version | Name | What it is (first comment line) | Notes |
|---|---|---|---|
| `20261007215055` | `finance_v2` | Finance v2: double-entry ledger foundation |  |
| `20261012090000` | `cut_review_final_delivery` | Cut review -> internal QC -> Final QC upload -> controlled client release |  |
| `20261012120000` | `contacts_clients` | Contacts & Clients. |  |
| `20261012180000` | `studio_tasks` | Tasks, daily/weekly planning and recurring tasks. |  |
| `20261012190000` | `finance_balance_trigger_security` | Fix Finance V2 balance-trigger permission errors. |  |
| `20261018090000` | `payments_paystack_sandbox` | Payments module: Paystack SANDBOX (test mode) + freelancer payout workflow |  |
| `20261021090000` | `payments_provider_neutral_admin_only` | Payments v2: provider-neutral architecture + ADMIN-ONLY enforcement |  |
| `20261022090000` | `studio_portfolio` | Studio portfolio: private media + secure no-login share links |  |
| `20261023090000` | `portfolio_google_drive` | Portfolio media moves from the Supabase 'portfolio' bucket to a dedicated Google Drive folder |  |
| `20261024090000` | `notification_center_state` | Notification centre: per-user read / snooze state for existing activity_log rows. |  |
| `20261025090000` | `paystack_live_checkout` | Paystack LIVE checkout (replaces the sandbox-only guard) |  |
| `20261025110000` | `paystack_production_live_apple_pay` | Paystack production hardening: LIVE-only public checkout + Apple Pay channel |  |
| `20261026090000` | `checkout_quotes_wise_manual` | Checkout FX quotes, converted-payment settlement, Wise/M-PESA manual payments |  |
| `20261027090000` | `payment_checkout_live_fx` | Refreshable checkout FX snapshots, separate from Finance's accounting snapshots. |  |
| `20261027120000` | `chat_drive_attachments` | Chat attachments are stored in the configured Google Drive account, never in Supabase Storage. |  |
| `20261028090000` | `force_kes_paystack_checkout` | Force KES-only Paystack initialization for this merchant. |  |
| `20261029090000` | `chat_collaboration` | KairFlow authenticated internal chat, with additive organization/membership primitives. |  |
| `20261030090000` | `studio_multiuser_core` | KairFlow shared-studio access foundation. |  |
| `20261031090000` | `studio_team_invites_and_bootstrap` | KairFlow: cohesive Teams onboarding, one-time invitations, and new-owner bootstrap. |  |
| `20261031100000` | `multi_organization_memberships` | Multi-organization accounts: preserve each per-studio role and workspace. |  |
| `20261101090000` | `frictionless_team_invites` | Frictionless team onboarding. |  |
| `20261102090000` | `access_overrides_directory_privacy` | KairFlow access hardening, part 1 of 2 (part 2: 20261102100000_portal_guest_client_chat.sql). |  |
| `20261102100000` | `portal_guest_client_chat` | KairFlow access hardening, part 2 of 2: Client Portal chat and freelancer guest chat. |  |
| `20261102110000` | `portal_freelancer_shot_chat` | Freelancer chat on the existing per-shot freelancer link (no new login, no new link to hand out). |  |
| `20261103090000` | `web_push` | Web Push: alerts that arrive when no KairFlow tab is open. |  |
| `20261104090000` | `lead_contact_channel` | Where the conversation with a lead is happening (Email, X, Discord, ...). Additive; existing leads defaul |  |
| `20261104100000` | `user_prefs_keys` | user_settings.user_prefs only accepted four keys (user_settings_prefs_keys_chk). The app now also stores |  |
| `20261104110000` | `work_sessions_server_time` | Studio Time fixes (additive; safe to re-run). |  |
| `20261105090000` | `task_series_atomic_update` | Atomic series edit: the series row update and the sync/regenerate of its |  |
| `20261105100000` | `portal_guest_messages_mine` | Guest chat: tell each guest which messages are theirs. Until now the browser guessed from the |  |
| `20261106090000` | `studio_document_details` | Studio contact details and payment instructions printed on invoices, proformas and receipts. |  |
| `20261107090000` | `portal_reply_reactions` | Client / guest / freelancer chat: reply-quoting and reactions, matching what direct chat offers. |  |
| `20261107204107` | `intelligence_phase2_reengagement_scan` | Adds the Intelligence follow-up candidate scan for re-engagement. | |
| `20261107204111` | `intelligence_resend_kill_switch` | Adds the admin kill-switch operation for controlling Intelligence outbound sending. | |
| `20261107204140` | `intelligence_phase2_global_send_pacing` | Adds global send-pacing settings to Intelligence configuration. | |
| `20261107204144` | `intelligence_phase2_send_slot_enforcement` | Adds send-slot acquisition enforcement for controlled outbound delivery. | |
| `20261107204213` | `intelligence_phase2_fixes` | Adds Phase 2 fixes, including the recent-outbound lookup. | |
| `20261107204217` | `intelligence_phase2_evidence_trace` | Adds evidence-trace storage to Intelligence messages. | |
| `20261108090000` | `portal_message_participant_identity` | Stable portal participant identity for message ownership. |  |

### 3b. Intelligence and Email

| Version | Name | What it is (first comment line) | Notes |
|---|---|---|---|
| `20261108130000` | `intelligence_authorization` | KairFlow Intelligence: strict authorization (Admin AND Master User). | repeated name, identical |
| `20261108140000` | `intelligence_core_tables` | KairFlow Intelligence: core tables. ADDITIVE ONLY (new tables, no changes to existing ones). | repeated name, DIFFERENT content |
| `20261108150000` | `intelligence_crm_notifications` | KairFlow Intelligence: CRM attribution, server-side duplicate detection, notification dedupe. | repeated name, identical |
| `20261108160000` | `intelligence_rpcs` | KairFlow Intelligence: privileged RPCs. | repeated name, DIFFERENT content |
| `20261108170000` | `intelligence_zoho_oauth` | KairFlow Intelligence: single-use OAuth state for connecting Zoho Mail. Additive. Safe to run more than o | repeated name, identical |
| `20261109090000` | `intelligence_authorization` | KairFlow Intelligence: strict authorization (Admin AND Master User). | repeated name, identical |
| `20261109100000` | `intelligence_core_tables` | KairFlow Intelligence: core tables. ADDITIVE ONLY (new tables, no changes to existing ones). | repeated name, DIFFERENT content |
| `20261109110000` | `intelligence_crm_notifications` | KairFlow Intelligence: CRM attribution, server-side duplicate detection, notification dedupe. | repeated name, identical |
| `20261109120000` | `intelligence_rpcs` | KairFlow Intelligence: privileged RPCs. | repeated name, DIFFERENT content |
| `20261109130000` | `intelligence_zoho_oauth` | KairFlow Intelligence: single-use OAuth state for connecting Zoho Mail. Additive. Safe to run more than o | repeated name, identical |
| `20261109140000` | `intelligence_v1_completion` | KairFlow Intelligence: V1 completion. |  |
| `20261109150000` | `intelligence_gmail_provider` | KairFlow Intelligence: Gmail as a second mail provider (free alternative to Zoho). Additive and re-runnab |  |
| `20261109160000` | `intelligence_chat_actions` | KairFlow Intelligence: Agent Chat "propose, then you confirm". |  |
| `20261109170000` | `intelligence_discovery` | KairFlow Intelligence: autonomous discovery. ADDITIVE ONLY. Requires the earlier Intelligence migrations  |  |
| `20261110090000` | `email_resend_core` | KairFlow Email (Resend): conversations, messages, attachments, events, webhook log, provider flags. |  |
| `20261111090000` | `email_resend_hardening` | KairFlow Email (Resend) hardening. NEW, ADDITIVE corrective migration on top of 20261110090000_email_rese |  |
| `20261111150000` | `email_inbox_account_provider_filters` | Add provider/account filters to the existing CRM Inbox query. |  |
| `20261112090000` | `email_resend_intelligence` | Intelligence Resend transport. Additive; apply manually after review. Does not change settings, |  |
| `20261112140000` | `intelligence_indie_project_qualification_v2` | Indie Game Developers V2: project-first qualification, date facts, and database gates. |  |
| `20261112160000` | `intelligence_indie_project_discovery_v3` | Indie Game Developers V2 / Phase 3: project-first Steam and itch.io discovery. |  |
| `20261112170000` | `intelligence_kickstarter_manual_intake_v4` | Indie Game Developers V2 / Phase 4: Kickstarter manual-only intake. |  |
| `20261112180000` | `intelligence_indie_research_verification_v5` | Indie Game Developers V2 / Phase 5: evidence-backed identity, visual review and contact verification. |  |
| `20261112190000` | `intelligence_kickstarter_exclusion_identity_fixes` | Indie Game Developers V2 / Phase 4 corrective fixes. |  |
| `20261112191000` | `intelligence_indie_research_integrity_v6` | Indie Game Developers V2 / Phase 5 corrective migration. |  |
| `20261112192000` | `intelligence_indie_outreach_v6` | Indie Game Developers V2 / Session 6. |  |
| `20261113090000` | `intelligence_manual_review` |  |  |
| `20261114090000` | `intelligence_new_lead_conversations` | Allow the authorized Intelligence administrator to start a new, manually reviewed |  |
| `20261115100000` | `intelligence_resend_audit` | Read-only, organization-scoped audit feed for Intelligence sends made through Resend. |  |
| `20261115110000` | `intelligence_sync_crm_email_status` | Keep the CRM email sequence in sync with confirmed Intelligence sends. |  |
| `20261116090000` | `intelligence_crm_takeover` | Phase 1: CRM lead take-over. |  |
| `20261116100000` | `intelligence_crm_reserve_send_email_gate` | Correct CRM email validation before resuming reserved messages. |  |
| `20261117090000` | `intelligence_studio_reevaluation` | KairFlow Intelligence: targeted reevaluation of REJECTED, DISCOVERED animation-studio prospects with the  |  |
| `20261117100000` | `intelligence_studio_reevaluation_admin_rpc` | Admin-facing controls for pre-outreach studio prospect reevaluation (rejected, review and qualified). |  |
| `20261117110000` | `intelligence_phase2_reengagement_scan` | Phase 2: schedule individualized re-engagement as the final configured follow-up slot. |  |
| `20261118090000` | `intelligence_resend_kill_switch` | Resend-only deployments do not create a legacy Zoho/Gmail mailbox row. |  |
| `20261118100000` | `intelligence_phase6_crm_ownership` | Phase 6: preserve scoring history and make CRM/takeover provenance explicit. |  |
| `20261119090000` | `intelligence_phase2_global_send_pacing` | Phase 2 production hardening: enforce studio-wide spacing across all worker processes. |  |
| `20261120090000` | `intelligence_phase2_send_slot_enforcement` | Phase 2 follow-up: enforce send-slot ownership and eliminate transaction-time expiry drift. |  |
| `20261121090000` | `intelligence_phase2_fixes` | Phase 2 fixes (forward-only; earlier migrations are not edited). |  |
| `20261122090000` | `intelligence_phase2_evidence_trace` | Phase 2 (round 3): evidence traceability on the message row, and recipient names for name-swap detection. |  |
| `20261122100000` | `intelligence_contactability` |  |  |
| `20261123100000` | `intelligence_chat_draft_force_review` | Explicit chat-created drafts must remain pending even if global autonomy is autonomous. |  |
| `20261124090000` | `intelligence_provider_registry_accounts` | KairFlow Intelligence Phase 2.1/2.2: dynamic adapter catalogue and multi-account storage. |  |
| `20261124100000` | `intelligence_provider_account_management` | Phase 2.4: administrator controls for independently connected provider accounts. |  |
| `20261125090000` | `intelligence_multi_account_dispatch` | Phase 2.5: deterministic message/account assignment, purpose consent and atomic mailbox quotas. |  |
| `20261125100000` | `intelligence_smtp_adapter` | Phase 2.6: reviewed SMTP submission adapter. Credentials remain encrypted at rest. |  |
| `20261125110000` | `intelligence_zoho_multi_account` | Phase 2.7: promote Zoho to the account-scoped OAuth adapter. |  |
| `20261126090000` | `intelligence_provider_gate_owner_only` | Phase 2.8 release hardening: provider catalogue sending gates are deployment-owner controls. |  |
| `20261126093000` | `intelligence_provider_policy_human_review` | Phase 2.8.1: enforce provider capability intersection and require human review for Zoho prospecting. |  |
| `20261126100000` | `intelligence_provider_assignment_integrity` | Phase 2.8.2: make durable provider assignments internally consistent. |  |
| `20261127100000` | `intelligence_delivery_events` | Phase 7: provider-neutral, idempotent delivery lifecycle for Intelligence prospect mail. |  |
| `20261128100000` | `intelligence_phase8_final_send_boundary` | Phase 8: atomically revalidate every mutable send permission immediately before |  |
| `20261129100000` | `intelligence_phase9_source_registry_enforcement` | Phase 9: make source-budget reservations atomic and fail closed. |  |
| `20261130100000` | `intelligence_phase10_schema_provider_alignment` | Phase 10: align provider status and kill-switch prerequisites with the dynamic |  |
| `20261130110000` | `intelligence_phase10_legacy_account_sync` | Phase 10 corrective migration: keep legacy Gmail/Zoho OAuth callbacks and the |  |
| `20261201090000` | `intelligence_phase11_privileged_user_guard` | Phase 11: make the privileged user_settings guard part of the ordered migration history. |  |
| `20261201100000` | `intelligence_phase11_atomic_portal_rate_limit` | Phase 11 corrective hardening: serialize each sliding-window bucket. |  |
| `20261202090000` | `intelligence_phase12_worker_reliability` | Phase 12: worker reliability, safe recovery, send-window deferral and RFC threading. |  |
| `20261203090000` | `intelligence_multi_account_inbox_sync` | Phase 13: account-scoped inbound synchronization for the multi-account provider registry. |  |
| `20261203100000` | `intelligence_phase7_delivery_event_corrective` | Phase 7 corrective patch: suppression propagation, provenance preservation and durable retry behavior. |  |
| `20261204090000` | `email_provider_registry` | KairFlow Email, multi-provider plan, PHASE 2 (1 of 2): general Email provider registry. |  |
| `20261204100000` | `email_provider_scoping` | KairFlow Email, multi-provider plan, PHASE 2 (2 of 2): provider-scoped accounts, messages and drafts. |  |
| `20261206100000` | `email_provider_idempotency` |  |  |
| `20261208100000` | `email_crm_activity` |  |  |
| `20261209100000` | `email_crm_conversation_attribution` | Phase 4D corrective migration: make conversation-to-CRM attribution authoritative and atomic. |  |
| `20261211100000` | `email_inbox_conversation_consistency` | Phase 4E: shared Inbox ordering, conversation counters and RFC threading consistency. |  |
| `20261212100000` | `email_inbox_phase4f_counter_repair` | Phase 4F validation correction. |  |
| `20261213100000` | `email_accepted_send_reconciliation` | Phase 4F corrective recovery: reconcile a provider-accepted send even when every |  |
| `20261214100000` | `email_mailbox_phase5_foundation` | KairFlow Email Phase 5 foundation: independent credential vault and durable sync leases. |  |
| `20261215100000` | `email_mailbox_lease_and_provider_state` | Phase 5 follow-up: renewable sync leases and provider-owned folder/deletion state. |  |
| `20261216090000` | `email_independent_access` | KairFlow Email: independent authorization (audit finding KF-01). NEW, ADDITIVE, re-runnable migration. |  |
| `20261217090000` | `intelligence_remove_legacy_mailbox` | Remove the legacy single-mailbox Gmail/Zoho bridge. The provider-account registry | **DESTRUCTIVE: drops 2 tables** |
| `20261218090000` | `intelligence_phase8_lock_policy_hotfix` | Phase 8 hotfix: the shared lock trigger function is installed on both |  |
| `20261219090000` | `intelligence_phase8_kill_switch_job_defer` | Preserve claimed send jobs when the operator kill switch is enabled. |  |
| `20261219100000` | `intelligence_send_job_terminal_denial` | Phase 8: a send job denied by a terminal policy/eligibility gate is not a success. |  |
| `20261220090000` | `email_crm_recovery_schedule` | Phase 4: automatic recovery of CRM email activities. |  |
| `20261220100000` | `email_provider_sender_safety` | Phase 2 sender-safety follow-up. |  |
| `20261221090000` | `email_crm_inbound_timeline` | Phase 5 follow-up: inbound replies on the CRM lead timeline, and "open this email" from a timeline entry. |  |
| `20261222100000` | `email_composer_send_crm_fixes` | Inbox composer/send/CRM correctness fixes (additive, safe to re-run). |  |
| `20261223100000` | `email_crm_timeline_reconciliation` | Phase 5 confirmed sync fixes: RFC threading persistence is handled by the send path; |  |
| `20261224100000` | `email_crm_confirmed_production_bugfixes` | Forward correction for confirmed production findings: |  |
| `20261225100000` | `email_crm_recovery_current_link` | Resolve delayed CRM activity attribution from the conversation's current lead link. |  |
| `20261226100000` | `email_inbox_stable_pagination` | Inbox pagination fix: ordering had no tiebreaker, so conversations sharing a timestamp could repeat or va |  |
| `20261226110000` | `email_mailbox_synced_conversation_insert_fix` | Fix: email_get_or_create_synced_conversation (20261214100000) listed five INSERT columns (including provi |  |
| `20261226120000` | `email_mailbox_resync_state_fixes` | Mailbox re-sync fixes (same signatures and grants as before; existing rows untouched). |  |
| `20261226130000` | `email_mailbox_sync_schedule` | Schedules general Email mailbox synchronization (Edge Function email-mailbox-sync). |  |
| `20261227110000` | `email_shared_intelligence_accounts` | Shared Intelligence mailbox identity for the central Inbox. |  |
| `20261228110000` | `email_provider_gmail_zoho_send_gateway` | Enable only the reviewed server-side Gmail/Zoho manual-send adapters. |  |
| `20261229100000` | `email_mailbox_sync_eligibility` | Round 7: authoritative account selection and eligibility for the general Email mailbox sync. |  |
| `20261229110000` | `email_mailbox_sync_ineligible_release` | Round 7.1: losing eligibility is not a provider synchronization failure. |  |
| `20261229120000` | `email_mailbox_sync_orphan_runs` | Round 7.2: close orphaned 'running' sync-run rows when a new lease is claimed. |  |
| `20261230100000` | `intelligence_campaign_followup_send_cap` | Enforce the campaign-specific follow-up ceiling at the final provider-send transition. |  |
| `20261231100000` | `intelligence_phase6_reply_outreach_corrections` | Phase 6 corrective release migration (forward-only). |  |
| `20270101090000` | `intelligence_phase7_reply_approval_safety` | Phase 7 corrective safety patch: manual replies require explicit approval and |  |
| `20270101100000` | `intelligence_indie_campaign_safety_hardening` | Indie campaign end-to-end audit fixes: subdomain suppression and final-send guard. |  |
| `20270101101000` | `intelligence_indie_pause_followups` | Stop Indie follow-up selection when its campaign is paused. The worker also |  |
| `20270102090000` | `intelligence_phase3_chat_provenance` | Phase 3: per-message AI provenance for Agent Chat (finding P1-04). Additive only: nullable columns, no da |  |
| `20270103090000` | `intelligence_phase4_job_reliability` | Phase 4: job settlement hardening. Two small, additive function replacements. No table, column, constrain |  |
| `20270103100000` | `intelligence_emma_actions` | KairFlow Intelligence: Emma (the Agent Chat) can now ACT, not only talk. |  |
| `20270104090000` | `intelligence_presskit_source` | Indie Game Developers / Phase 5 follow-up: "presskit" discovery source. ADDITIVE ONLY. LOCAL FILE: NOT AP |  |
| `20270105090000` | `intelligence_phase7_service_role_grants` | Phase 7 (seven-phase roadmap): restore the intended privileges of the two service-role-only Intelligence  | **NEW in Phase 7** |

## 4. Files in `supabase/migrations/` that are not migrations

None. Four old backup copies (`*.bak-cross-shot`, `*.before-cancel-fix`, `*.before-reeval-safety`, `*.pre-fix.bak`) were removed after Phase 7 and archived
outside the repository in `REMOVED_BACKUP_FILES_ARCHIVE.zip`. `test_phase7_production_validation.py` fails if a stray non-`.sql` file or a backup-style copy appears
in the migration, function, test or worker folders again.

## 5. Hosted status (owner fills in)

| Version | Applied on hosted project? | Date | Applied by | Notes |
|---|---|---|---|---|
| `20270102090000` (Phase 3) | | | | |
| `20270103090000` (Phase 4) | | | | |
| `20270105090000` (Phase 7) | | | | |
| `20261217090000` (legacy mailbox removal) | **do not apply without authorization** | | | |
