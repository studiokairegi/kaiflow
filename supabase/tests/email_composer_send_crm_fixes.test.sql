-- Regression coverage for the 2026-12-22 Inbox composer/send/CRM corrective migration.
-- Run after email_crm_activity.test.sql fixtures and 20261222100000_email_composer_send_crm_fixes.sql.
do $$
<<test_block>>
declare
  ADMIN uuid := '00000000-0000-0000-0000-0000000000e1';
  MASTER uuid := '00000000-0000-0000-0000-0000000000e2';
  orgA uuid := '20000000-0000-0000-0000-00000000000a';
  acc uuid;
  lead_id uuid;
  draft_id uuid;
  draft_conv uuid;
  colleague_conv uuid;
  colleague_msg uuid;
  retry_msg uuid;
  capped_msg uuid;
  r jsonb;
  retry jsonb;
  quota_result jsonb;
begin
  perform ti.as_super();
  insert into public.email_accounts (organization_id, address, display_name, is_default)
  values (orgA, 'composer-fixes@studiokairegi.com', 'Composer fixes', false) returning id into acc;
  insert into public.leads (user_id, company_name, activity_log) values (ADMIN, 'Composer draft lead', '[]'::jsonb) returning id into lead_id;

  -- A lead-linked compose draft stores its lead on both the conversation and the draft row.
  perform ti.as_user(ADMIN);
  r := public.email_save_draft(null, null, acc, array['draft@example.com'], '{}', '{}', 'CRM draft', 'Draft body', '', lead_id);
  draft_id := (r ->> 'draft_id')::uuid;
  draft_conv := (r ->> 'conversation_id')::uuid;
  perform ti.ok((select crm_lead_id = test_block.lead_id from public.email_messages where id = test_block.draft_id)
    and (select lead_id = test_block.lead_id from public.email_conversations where id = test_block.draft_conv),
    'saving a CRM compose draft persists its lead association');

  -- A draft edited through the same 10-argument RPC retains the association.
  r := public.email_save_draft(draft_id, draft_conv, acc, array['draft@example.com'], '{}', '{}', 'CRM draft edited', 'Edited body', '', lead_id);
  perform ti.ok((select crm_lead_id = test_block.lead_id from public.email_messages where id = test_block.draft_id),
    'editing a CRM draft preserves the lead association');

  -- Submitting the draft continues to carry the lead into the outbound message.
  perform ti.as_super();
  r := public.email_create_outbound(jsonb_build_object('organization_id', orgA, 'account_id', acc, 'draft_id', draft_id,
    'user_id', ADMIN, 'crm_lead_id', lead_id, 'crm_user_id', ADMIN, 'idempotency_key', 'composer-fix-draft-send',
    'to_emails', jsonb_build_array('draft@example.com'), 'subject', 'CRM draft edited', 'body_text', 'Edited body'));
  perform ti.ok((select crm_lead_id = test_block.lead_id from public.email_messages where id = test_block.draft_id),
    'sending a saved CRM draft retains the lead association');

  -- A studio colleague may reply in the shared thread without inheriting another user's CRM write authority.
  insert into public.email_conversations (organization_id, account_id, subject, normalized_subject, lead_id)
  values (orgA, acc, 'Shared lead thread', 'shared lead thread', lead_id) returning id into colleague_conv;
  r := public.email_create_outbound(jsonb_build_object('organization_id', orgA, 'account_id', acc, 'conversation_id', colleague_conv,
    'user_id', MASTER, 'idempotency_key', 'composer-fix-colleague-reply', 'to_emails', jsonb_build_array('reply@example.com'),
    'subject', 'Re: Shared lead thread', 'body_text', 'Colleague reply'));
  colleague_msg := (r ->> 'message_id')::uuid;
  perform ti.ok((select crm_lead_id is null and created_by = MASTER from public.email_messages where id = test_block.colleague_msg)
    and (select lead_id = test_block.lead_id from public.email_conversations where id = test_block.colleague_conv),
    'a colleague reply is allowed without transferring CRM ownership or changing the linked lead');

  -- The claim RPC is single-winner. A second same-key retry sees sending and cannot submit again.
  perform ti.ok(public.email_claim_outbound(colleague_msg, 'reply-token@example.com'), 'first queued-to-sending claim succeeds');
  perform ti.ok(not public.email_claim_outbound(colleague_msg, 'reply-token@example.com'), 'a second queued-to-sending claim loses atomically');

  -- Reply headers are transport metadata, not immutable message content: a new inbound reply must not invalidate a retry.
  r := public.email_create_outbound(jsonb_build_object('organization_id', orgA, 'account_id', acc, 'user_id', ADMIN,
    'idempotency_key', 'composer-fix-thread-fingerprint', 'to_emails', jsonb_build_array('retry@example.com'),
    'subject', 'Thread retry', 'body_text', 'Same body', 'in_reply_to', '<old@client.test>', 'references_ids', '<old@client.test>'));
  retry_msg := (r ->> 'message_id')::uuid;
  retry := public.email_create_outbound(jsonb_build_object('organization_id', orgA, 'account_id', acc, 'user_id', ADMIN,
    'idempotency_key', 'composer-fix-thread-fingerprint', 'to_emails', jsonb_build_array('retry@example.com'),
    'subject', 'Thread retry', 'body_text', 'Same body', 'in_reply_to', '<new@client.test>', 'references_ids', '<old@client.test> <new@client.test>'));
  perform ti.ok((retry ->> 'duplicate')::boolean and (retry ->> 'message_id')::uuid = retry_msg,
    'changing thread headers between attempts does not conflict with the immutable content fingerprint');

  -- Quotas are checked after the duplicate lookup but before a new row is created.
  insert into public.email_messages (organization_id,conversation_id,account_id,direction,status,from_email,to_emails,subject,body_text,is_read,created_by)
  select orgA,draft_conv,acc,'outbound','sent','composer-fixes@studiokairegi.com',array['quota@example.com'],'Quota test','Existing message',true,ADMIN
    from generate_series(1,20);
  retry := public.email_create_outbound(jsonb_build_object('organization_id',orgA,'account_id',acc,'user_id',ADMIN,
    'idempotency_key','composer-fix-thread-fingerprint','to_emails',jsonb_build_array('retry@example.com'),
    'subject','Thread retry','body_text','Same body','in_reply_to','<later@client.test>',
    'rate_limit_minute',20,'rate_limit_daily',100));
  perform ti.ok((retry ->> 'duplicate')::boolean and (retry ->> 'message_id')::uuid = retry_msg,
    'an existing idempotent submission remains repairable even when the organization quota is full');
  quota_result := public.email_create_outbound(jsonb_build_object('organization_id',orgA,'account_id',acc,'user_id',ADMIN,
    'idempotency_key','composer-fix-minute-quota','to_emails',jsonb_build_array('quota@example.com'),
    'subject','Minute quota','body_text','Must not queue','rate_limit_minute',20,'rate_limit_daily',100));
  perform ti.ok(quota_result ->> 'rate_limited' = 'minute', 'the organization-wide minute quota is enforced before a new outbound row is inserted');
  update public.email_messages set created_at=now()-interval '2 minutes' where organization_id=orgA and subject='Quota test';
  quota_result := public.email_create_outbound(jsonb_build_object('organization_id',orgA,'account_id',acc,'user_id',ADMIN,
    'idempotency_key','composer-fix-daily-quota','to_emails',jsonb_build_array('quota@example.com'),
    'subject','Daily quota','body_text','Must not queue','rate_limit_minute',20,'rate_limit_daily',20));
  perform ti.ok(quota_result ->> 'rate_limited' = 'day', 'the provider-specific daily quota is enforced before a new outbound row is inserted');

  -- A permanently failing recovery candidate is bounded and cannot be selected forever.
  insert into public.email_messages (organization_id, conversation_id, account_id, direction, status, from_email, to_emails,
    subject, body_text, is_read, created_by, crm_lead_id, provider_message_id, sent_at, crm_recovery_attempts)
  values (orgA, draft_conv, acc, 'outbound', 'sent', 'composer-fixes@studiokairegi.com', array['capped@example.com'],
    'Capped recovery', 'No activity', true, MASTER, lead_id, 'provider-capped-recovery', now(), 10)
  returning id into capped_msg;
  r := public.email_recover_crm_activities(100);
  perform ti.ok((select crm_recovery_attempts = 10 from public.email_messages where id = test_block.capped_msg)
    and not exists (select 1 from public.email_crm_activities where message_id = test_block.capped_msg),
    'ten-attempt CRM recovery failures are excluded from future recovery batches');

  perform ti.as_super();
  delete from public.email_crm_activities where message_id in (draft_id, colleague_msg, retry_msg, capped_msg);
  delete from public.email_messages where id in (colleague_msg, retry_msg, capped_msg, draft_id);
  delete from public.email_messages where organization_id=orgA and subject='Quota test';
  delete from public.email_conversations where id = colleague_conv;
  delete from public.email_accounts where id = acc;
  delete from public.leads where id = lead_id;
  raise notice 'PASS email_composer_send_crm_fixes.test.sql complete';
end $$;
