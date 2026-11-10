# KairFlow Email — Phase 4E Inbox and Conversation Integration

**Status:** Implemented in the supplied Phase 4D-corrected repository snapshot. Local Node regression suite passes. PostgreSQL migration execution and live provider behavior remain unverified.

## Scope

Phase 4E requires sent-message visibility in the shared Inbox, account/conversation association, provider and RFC threading context, correct reply/forward behavior, duplicate protection, and durable CRM lead associations.

## Corrections and implementation

1. **Safe inline-reply idempotency.** Inline replies now use the same `shouldRotateSendKey` policy as the main composer. A key is retained after network failures, database failures, accepted-but-unpersisted outcomes, and ambiguous provider outcomes. It rotates only after a confirmed terminal provider rejection/failure that explicitly says the same key must not be retried. This prevents a retry from becoming a second send under a fresh key.
2. **Reply-To routing.** Inbound messages persist the Reply-To header as `email_messages.reply_to`. Reply recipient selection now parses that persisted header first, falls back to From only when Reply-To has no valid address, and filters out the studio's own sender addresses. Previously the UI looked for a non-existent `reply_to_address` field and silently replied to From instead.
3. **Chronological thread-parent selection.** The prior query ordered only by `received_at`; outbound messages have `received_at = NULL`, so a newer outbound message could be ignored in favor of an older inbound message. A service-role-only `email_get_thread_parent` RPC now orders RFC-bearing messages by `coalesce(received_at, sent_at, created_at)` and verifies organization, account and conversation together.
4. **Shared Inbox conversation metadata.** The message-counter trigger now increments message counts only on first transition out of draft, while recalculating latest message timestamp, direction and snippet when provider status/timestamps change. This advances Inbox ordering when the provider-confirmed `sent_at` arrives. The migration also repairs existing denormalized conversation counters and latest-message metadata from the source message rows.
5. **CRM association preservation.** Existing Phase 4D database logic remains authoritative: a conversation's lead association is inherited by outbound replies and cannot silently be switched by a conflicting request. Inbound replies are attached to the matched conversation, so its lead association remains on that conversation.
6. **Duplicate protection.** Existing provider webhook claims, account-scoped provider/RFC uniqueness, outbound idempotency and CRM activity uniqueness remain intact. This phase does not add a second send or a second CRM activity path.

## Migration

`supabase/migrations/20261211100000_email_inbox_conversation_consistency.sql`

- Replaces `_email_message_counters()` and its trigger.
- Repairs existing conversation counters/snippets/timestamps from message rows.
- Adds `email_get_thread_parent(uuid,uuid,uuid)`, executable by `service_role` only.
- Makes no provider API calls and does not alter transactional Resend/Intelligence notification paths.

## Files changed

- `src/email/components/InlineReply.jsx`
- `src/email/lib/logic.js`
- `src/email/email.test.mjs`
- `supabase/functions/_shared/email_resend_store.ts`
- `supabase/migrations/20261211100000_email_inbox_conversation_consistency.sql`
- `supabase/tests/email_resend.test.sql`
- `src/email/provider-foundation.test.mjs` (migration-order/contract coverage)
- `src/intelligence/v1-completion.test.mjs` (migration-order exclusion for Email-owned migration)

## Verification

- Full repository Node suite: **930 passed, 0 failed, 0 skipped**.
- New tests cover Reply-To preference/fallback, studio-address exclusion, inline reply idempotency-key policy, migration order, and SQL regression assertions for sent timestamp ordering and RFC parent selection.
- PostgreSQL SQL regression tests: written/updated but **not executed**; no PostgreSQL/Supabase CLI runtime was available in the extracted environment.
- Production build: **not run** because `node_modules` is absent (`vite` is unavailable).
- No Supabase migration was applied, no Edge Function deployed, and no real prospect email sent.
- Live provider behavior remains unverified.

## Deployment order

1. Review and apply `20261211100000_email_inbox_conversation_consistency.sql` after the Phase 4C/4D migrations.
2. Deploy the updated `email-send` Edge Function so it calls the new thread-parent RPC.
3. Deploy the updated frontend.
4. Validate using controlled test mailboxes: inbound Reply-To, inbound/outbound thread chronology, multiple sender accounts, accepted-send visibility, CRM-linked reply, duplicate webhook delivery, and ambiguous send retry.

## Rollback

Only if Phase 4E is not in use: restore `_email_message_counters()` and the `email_messages_counters` trigger from `20261110090000_email_resend_core.sql`, then drop `email_get_thread_parent(uuid,uuid,uuid)`. The recalculated conversation metadata is non-destructive and can remain. Do not roll back Phase 4C/4D migrations or delete message/activity records.
