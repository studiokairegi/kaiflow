-- Phase 4D database regression tests. Run after the Phase 4D migration and email_resend.test.sql fixtures.
-- Uses the shared ti test helpers and known users/orgs from the email/Intelligence test harness.
do $$
<<test_block>>
declare
  ADMIN uuid := '00000000-0000-0000-0000-0000000000e1';
  MASTER uuid := '00000000-0000-0000-0000-0000000000e2';
  orgA uuid := '20000000-0000-0000-0000-00000000000a';
  acc uuid;
  lead_id uuid;
  other_lead uuid;
  msg_id uuid;
  msg2_id uuid;
  draft_id uuid;
  r jsonb;
begin
  perform ti.as_super();
  insert into public.email_accounts (organization_id, address, display_name, is_default)
  values (orgA, 'phase4d-crm@studiokairegi.com', 'Phase 4D', false) returning id into acc;
  insert into public.leads (user_id, company_name, activity_log) values (ADMIN, 'Phase 4D Lead', '[]'::jsonb) returning id into lead_id;
  insert into public.leads (user_id, company_name, activity_log) values (MASTER, 'Other Owner Lead', '[]'::jsonb) returning id into other_lead;

  -- A new CRM-attributed send must atomically bind both message and conversation.
  r := public.email_create_outbound(jsonb_build_object('organization_id', orgA, 'account_id', acc, 'user_id', ADMIN,
    'crm_lead_id', lead_id, 'crm_user_id', ADMIN, 'idempotency_key', 'phase4d-conversation-bind',
    'to_emails', jsonb_build_array('bind@example.com'), 'subject', 'Bound conversation', 'body_text', 'Bound body'));
  perform ti.ok((select c.lead_id = test_block.lead_id from public.email_conversations c where c.id = (r ->> 'conversation_id')::uuid),
    'new CRM-attributed outbound send binds the conversation and message to the same lead');

  -- Existing conversation links are authoritative inside the RPC; a stale explicit lead is rejected.
  perform ti.throws(format($q$select public.email_create_outbound(%L::jsonb)$q$,
    jsonb_build_object('organization_id', orgA, 'account_id', acc, 'conversation_id', (r ->> 'conversation_id')::uuid,
      'user_id', ADMIN, 'crm_lead_id', other_lead, 'crm_user_id', ADMIN, 'idempotency_key', 'phase4d-stale-link',
      'to_emails', jsonb_build_array('conflict@example.com'), 'subject', 'Conflict', 'body_text', 'Conflict')::text),
    'crm_lead_conflict', 'the database rejects a stale lead association rather than misattributing an email');

  -- A reply with no explicit CRM payload inherits the locked conversation association.
  r := public.email_create_outbound(jsonb_build_object('organization_id', orgA, 'account_id', acc,
    'conversation_id', (r ->> 'conversation_id')::uuid, 'user_id', ADMIN, 'idempotency_key', 'phase4d-inherit-link',
    'to_emails', jsonb_build_array('reply@example.com'), 'subject', 'Reply', 'body_text', 'Reply body'));
  perform ti.ok((select crm_lead_id = test_block.lead_id from public.email_messages where id = (r ->> 'message_id')::uuid)
    and (select lead_id = test_block.lead_id from public.email_conversations where id = (r ->> 'conversation_id')::uuid),
    'a subsequent reply inherits the conversation CRM lead inside the database transaction');

  -- A saved draft must resolve and inherit the same association when it is submitted.
  perform ti.as_user(ADMIN);
  r := public.email_save_draft(null, (select id from public.email_conversations where lead_id = test_block.lead_id order by created_at limit 1),
    acc, array['draft@example.com'], '{}', '{}', 'CRM draft', 'Draft body', '');
  draft_id := (r ->> 'draft_id')::uuid;
  perform ti.as_super();
  r := public.email_create_outbound(jsonb_build_object('organization_id', orgA, 'account_id', acc, 'draft_id', draft_id,
    'user_id', ADMIN, 'idempotency_key', 'phase4d-draft-inherit', 'to_emails', jsonb_build_array('draft@example.com'),
    'subject', 'CRM draft', 'body_text', 'Draft body'));
  perform ti.ok((select crm_lead_id = test_block.lead_id from public.email_messages where id = test_block.draft_id)
    and (select lead_id = test_block.lead_id from public.email_conversations c join public.email_messages m on m.conversation_id = c.id where m.id = test_block.draft_id),
    'sending a saved draft inherits the conversation CRM lead and persists it on the message');

  -- The database validates lead ownership independently of the Edge Function.
  perform ti.throws(format($q$select public.email_create_outbound(%L::jsonb)$q$,
    jsonb_build_object('organization_id', orgA, 'account_id', acc, 'user_id', ADMIN, 'crm_lead_id', other_lead, 'crm_user_id', ADMIN,
      'idempotency_key', 'phase4d-owner-conflict', 'to_emails', jsonb_build_array('client@example.com'), 'subject', 'No', 'body_text', 'No')::text),
    'CRM lead not found', 'a different user cannot attribute an email to another owner's lead');

  r := public.email_create_outbound(jsonb_build_object('organization_id', orgA, 'account_id', acc, 'user_id', ADMIN,
    'crm_lead_id', lead_id, 'crm_user_id', ADMIN, 'idempotency_key', 'phase4d-message-1',
    'to_emails', jsonb_build_array('client@example.com'), 'cc_emails', jsonb_build_array('copy@example.com'),
    'bcc_emails', jsonb_build_array('blind@example.com'), 'subject', 'Approved subject', 'body_text', 'Approved plain text', 'body_html', '<p>Approved HTML</p>'));
  msg_id := (r ->> 'message_id')::uuid;
  update public.email_messages set status = 'sent', provider_message_id = 'provider-phase4d-1', sent_at = now() where id = msg_id;

  r := public.email_record_crm_activity(msg_id);
  perform ti.ok((r ->> 'recorded')::boolean and not (r ->> 'duplicate')::boolean, 'first post-acceptance CRM activity is recorded');
  perform ti.ok((select count(*) = 1 from public.email_crm_activities c where c.message_id = test_block.msg_id and c.organization_id = test_block.orgA
    and c.lead_id = test_block.lead_id and c.account_id = test_block.acc and c.user_id = test_block.ADMIN and c.provider_message_id = 'provider-phase4d-1'
    and c.subject = 'Approved subject' and c.body_text = 'Approved plain text' and c.body_html = '<p>Approved HTML</p>'
    and c.to_emails = array['client@example.com'] and c.cc_emails = array['copy@example.com'] and c.bcc_emails = array['blind@example.com']),
    'the durable activity preserves organization, lead, account, provider identity, recipients and approved content');
  perform ti.ok((select jsonb_array_length(activity_log) = 1 and activity_log -> 0 ->> 'type' = 'email_sent'
    and activity_log -> 0 ->> 'emailMessageId' = msg_id::text from public.leads where id = test_block.lead_id),
    'the lead timeline receives one compact email event');
  r := public.email_record_crm_activity(msg_id);
  perform ti.ok((r ->> 'recorded')::boolean and (r ->> 'duplicate')::boolean
    and (select count(*) = 1 from public.email_crm_activities where message_id = test_block.msg_id)
    and (select jsonb_array_length(activity_log) = 1 from public.leads where id = test_block.lead_id),
    'replaying CRM activity is idempotent');

  -- Recovery scans accepted messages with a CRM lead but no activity; it does not submit mail.
  r := public.email_create_outbound(jsonb_build_object('organization_id', orgA, 'account_id', acc, 'user_id', ADMIN,
    'crm_lead_id', lead_id, 'crm_user_id', ADMIN, 'idempotency_key', 'phase4d-message-2',
    'to_emails', jsonb_build_array('client2@example.com'), 'subject', 'Recovery subject', 'body_text', 'Recovery body'));
  msg2_id := (r ->> 'message_id')::uuid;
  update public.email_messages set status = 'sent', provider_message_id = 'provider-phase4d-2', sent_at = now() where id = msg2_id;
  r := public.email_recover_crm_activities(100);
  perform ti.ok((r ->> 'attempted')::int >= 1 and (r ->> 'failed')::int = 0
    and exists (select 1 from public.email_crm_activities where message_id = test_block.msg2_id),
    'recovery records an accepted message whose first CRM write was missed');
  perform ti.ok((select count(*) = 2 from public.email_crm_activities c where c.lead_id = test_block.lead_id)
    and (select count(*) = 2 from jsonb_array_elements((select activity_log from public.leads where id = test_block.lead_id)) e(value) where e.value ->> 'type' = 'email_sent'),
    'recovery creates exactly one additional CRM activity');

  -- Client roles cannot write the full-content activity table or call the recovery RPC.
  perform ti.as_user(ADMIN);
  perform ti.throws(format($q$insert into public.email_crm_activities(message_id,organization_id,lead_id,account_id,user_id,provider,from_email,sent_at) values (%L,%L,%L,%L,%L,'resend','sender@example.com',now())$q$,
    test_block.msg_id, test_block.orgA, test_block.lead_id, test_block.acc, test_block.ADMIN), 'permission denied', 'authenticated users cannot forge CRM email activity records');
  perform ti.throws($q$select public.email_recover_crm_activities(10)$q$, 'permission denied', 'only service role can invoke recovery');

  perform ti.as_super();
  delete from public.email_crm_activities where message_id in (msg_id, msg2_id);
  delete from public.email_accounts where id = test_block.acc;
  delete from public.leads where id in (test_block.lead_id, test_block.other_lead);
  raise notice 'PASS email_crm_activity.test.sql complete';
end $$;
