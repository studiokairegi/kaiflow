# Manual Lead Email Composition — Phase 7 Deployment Manifest

**Purpose:** Corrected, timestamp-ordered migration inventory and rollback guidance for the CRM lead email composer.

**Important:** This is a source-repository manifest, not proof of what is applied to any Supabase project. The target database's migration history must be checked before deployment.

## 1. Required historical prerequisites

The Email Resend core migration explicitly depends on the Intelligence authorization/core migrations from `20261109*`. Confirm these are already applied before the Email core:

1. `20261109090000_intelligence_authorization.sql`
2. `20261109100000_intelligence_core_tables.sql`
3. `20261109110000_intelligence_crm_notifications.sql`
4. `20261109120000_intelligence_rpcs.sql`
5. `20261109130000_intelligence_zoho_oauth.sql`
6. `20261109140000_intelligence_v1_completion.sql`
7. `20261109150000_intelligence_gmail_provider.sql`
8. `20261109160000_intelligence_chat_actions.sql`
9. `20261109170000_intelligence_discovery.sql`

These are historical prerequisites in the existing project. This Phase 7 correction does not modify them.

## 2. Email core and hardening

| Order | Migration | Transaction | Notes |
|---:|---|---|---|
| 1 | `20261110090000_email_resend_core.sql` | Yes | Email schema/RPC foundation; requires the prerequisites above |
| 2 | `20261111090000_email_resend_hardening.sql` | Yes | Email hardening |

## 3. Complete composer-family sequence

The prior Phase 7 audit listed 13 composer migrations and stopped at `20261221090000`. That inventory was incomplete. The repository now contains **18** composer-family migrations in the following order, including the new forward production-bugfix migration:

| Order | Migration | Transaction | Rollback guidance |
|---:|---|---|---|
| 1 | `20261204090000_email_provider_registry.sql` | Yes | Use migration's documented rollback; review provider references first |
| 2 | `20261204100000_email_provider_scoping.sql` | Yes | Use migration's documented rollback |
| 3 | `20261206100000_email_provider_idempotency.sql` | Yes | Use migration's documented rollback |
| 4 | `20261208100000_email_crm_activity.sql` | Yes | Destructive rollback: drops CRM email activity storage and `email_messages.crm_lead_id`; avoid unless data loss is accepted and a backup exists |
| 5 | `20261209100000_email_crm_conversation_attribution.sql` | Yes | Use migration's documented rollback |
| 6 | `20261211100000_email_inbox_conversation_consistency.sql` | Yes | Use migration's documented rollback |
| 7 | `20261212100000_email_inbox_phase4f_counter_repair.sql` | Yes | Use migration's documented rollback |
| 8 | `20261213100000_email_accepted_send_reconciliation.sql` | Yes | Use migration's documented rollback |
| 9 | `20261214100000_email_mailbox_phase5_foundation.sql` | Yes | Rollback is only safe before mailbox accounts/sync state are in use; review its migration comments |
| 10 | `20261215100000_email_mailbox_lease_and_provider_state.sql` | Yes | Use migration's documented rollback |
| 11 | `20261216090000_email_independent_access.sql` | Yes | Use rollback block at the end of the migration |
| 12 | `20261220090000_email_crm_recovery_schedule.sql` | No; single `DO` block | Unschedule the exact cron job created by the migration; do not guess its job name—inspect `cron.job` first |
| 13 | `20261220100000_email_provider_sender_safety.sql` | Yes | **Do not roll back casually.** Reverting removes send-capability validation, the concurrent-default lock, and the removal of `last_connection_error` from the RPC response. Prefer a forward fix; restore prior RPC bodies only after a security review |
| 14 | `20261221090000_email_crm_inbound_timeline.sql` | No; multiple statements | Use its documented rollback; this removes inbound timeline behavior but leaves existing CRM/email data in place |
| 15 | `20261222100000_email_composer_send_crm_fixes.sql` | Yes | Use the migration's rollback comments; restores prior draft/send RPCs and removes the recovery columns/index. Do not drop the CRM activity data from migration 4 as part of this rollback |
| 16 | `20261223100000_email_crm_timeline_reconciliation.sql` | Yes | See the dedicated rollback script below; rollback requires the prior webhook function version first |
| 17 | `20261224100000_email_crm_confirmed_production_bugfixes.sql` | Yes | Forward fix for sender regex, backfill of existing structured CRM attribution, and relink/unlink synchronization. Roll back only after manually reconciling nullable `lead_id` rows; do not set NOT NULL while any remain |
| 18 | `20261225100000_email_crm_recovery_current_link.sql` | Yes | Forward fix for delayed CRM recovery; restores the prior `email_record_crm_activity` and `email_recover_crm_activities` bodies only after reviewing pending recovery candidates and attribution |

The two omitted migrations from the previous final-audit table were `20261220100000_email_provider_sender_safety.sql` and `20261222100000_email_composer_send_crm_fixes.sql`; the latest Phase 5 timeline reconciliation migration `20261223100000_email_crm_timeline_reconciliation.sql` was also not represented in the deployment sequence. All three are now included above. The forward corrective migrations `20261224100000_email_crm_confirmed_production_bugfixes.sql` and `20261225100000_email_crm_recovery_current_link.sql` are required after the earlier composer migrations for already-deployed environments.

## 4. Phase 7 timeline migration rollback

A dedicated rollback script is provided at:

`supabase/rollback/20261223100000_email_crm_timeline_reconciliation.rollback.sql`

Before running it:

1. Take a database backup.
2. Redeploy the previous `resend-webhook`/Edge Function version that calls `email_reconcile_tagged_delivery_event()` rather than `email_reconcile_tagged_delivery_event_with_rfc()`.
3. Run the rollback SQL as a trusted database operator.
4. Verify the inbound timeline trigger and function permissions.

The rollback removes the two new relink/rethread triggers, removes the reconciliation helpers and RFC wrapper, and restores the inbound timeline/stale-editor trigger functions from `20261221090000_email_crm_inbound_timeline.sql`.

`email_link_lead(uuid,uuid)` is not separately restored because its Phase 7 definition is identical to the authorization-preserving definition from `20261110090000_email_resend_core.sql`. The rollback does not delete messages, leads, or existing activity-log entries. It does not reverse already-completed timeline backfills/relinks, so a rollback may leave the current projection as-is until a forward reconciliation is performed.

## 5. Other migrations in the repository are not silently included in this feature manifest

The repository also contains separate Intelligence migrations, including:

- `20261112090000_email_resend_intelligence.sql`
- `20261115100000_intelligence_resend_audit.sql`
- `20261115110000_intelligence_sync_crm_email_status.sql`
- `20261116090000_intelligence_crm_takeover.sql`
- `20261116100000_intelligence_crm_reserve_send_email_gate.sql`
- `20261118090000_intelligence_resend_kill_switch.sql`
- `20261118100000_intelligence_phase6_crm_ownership.sql`
- `20261217090000_intelligence_remove_legacy_mailbox.sql`
- `20261218090000_intelligence_phase8_lock_policy_hotfix.sql`
- `20261219090000_intelligence_phase8_kill_switch_job_defer.sql`
- `20261219100000_intelligence_send_job_terminal_denial.sql`

These are outside the composer-specific sequence and must be reviewed against the separate Intelligence release plan. Do not use the composer release as approval to change Intelligence routing, campaigns, autonomy, or kill-switch behavior.

**Supabase CLI warning:** `supabase db push` applies every local migration missing from the target database's migration history, not just the 16 composer-family migrations. Run `supabase migration list --remote` and `supabase db push --dry-run` against the intended project; inspect every pending migration. Stop if unrelated or unapproved migrations are included. The CLI migration history and Git-tracked migration files are separate records. `migration repair` changes history only; it does not execute or reverse SQL. See the [Supabase migration deployment guide](https://supabase.com/docs/guides/deployment/database-migrations).

## 6. Deployment sequence

1. Confirm the intended Supabase project and take a backup.
2. Confirm the prerequisite history and run `supabase migration list --remote`.
3. Run `supabase db push --dry-run` and review **all** pending migrations, including the separate Intelligence migrations above.
4. Apply only after the target and pending set have been approved, preferably to staging first.
5. Run the email SQL tests against the complete migration chain and perform the two-user cross-organization checks.
6. Deploy `email-send` with JWT verification enabled; deploy `resend-webhook` with `--no-verify-jwt` only because it verifies the Svix signature itself.
7. Run `npm ci && npm test && npm run build` and complete the owned-address smoke test and viewport checks.
8. Do not send real prospect emails during testing.

No command in this manifest has been run against a live database. No migration has been applied by this correction.
