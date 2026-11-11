-- Phase 5 follow-up SQL tests: inbound replies on the CRM timeline. Run AFTER 20261221090000_email_crm_inbound_timeline.sql and the
-- email migrations it depends on. Self-contained: plain assertions, creates its own rows inside a transaction and rolls back.
begin;
do $$
declare
  v_org uuid; v_acc uuid; v_user uuid; v_lead uuid; v_other_lead uuid; v_conv uuid; v_unlinked uuid; v_msg uuid; v_n int; v_log jsonb;
begin
  select id into v_user from auth.users limit 1;
  select organization_id, id into v_org, v_acc from public.email_accounts limit 1;
  if v_user is null or v_acc is null then raise exception 'SKIP: needs one auth user and one email account fixture'; end if;
  insert into public.leads (user_id, company_name, activity_log) values (v_user, 'Inbound Timeline Lead', '[]'::jsonb) returning id into v_lead;
  insert into public.leads (user_id, company_name, activity_log) values (v_user, 'Other Lead', '[]'::jsonb) returning id into v_other_lead;
  insert into public.email_conversations (organization_id, account_id, subject, normalized_subject, lead_id) values (v_org, v_acc, 'Hello', 'hello', v_lead) returning id into v_conv;
  insert into public.email_conversations (organization_id, account_id, subject, normalized_subject) values (v_org, v_acc, 'No lead', 'no lead') returning id into v_unlinked;

  insert into public.email_messages (organization_id, conversation_id, account_id, direction, status, from_email, from_name, subject, received_at)
    values (v_org, v_conv, v_acc, 'inbound', 'received', 'client@example.com', 'Client Name', 'Re: Hello', now()) returning id into v_msg;
  select activity_log into v_log from public.leads where id = v_lead;
  if jsonb_array_length(v_log) <> 1 or v_log -> 0 ->> 'type' <> 'email_received' or v_log -> 0 ->> 'emailMessageId' <> v_msg::text
     or v_log -> 0 ->> 'emailConversationId' <> v_conv::text then raise exception 'FAIL: reply on a linked conversation adds one email_received entry (%)', v_log; end if;
  raise notice 'PASS: reply on a linked conversation adds one email_received entry';

  select jsonb_array_length(activity_log) into v_n from public.leads where id = v_other_lead;
  if v_n <> 0 then raise exception 'FAIL: other leads are untouched'; end if;
  raise notice 'PASS: other leads are untouched';

  insert into public.email_messages (organization_id, conversation_id, account_id, direction, status, from_email, subject, received_at)
    values (v_org, v_unlinked, v_acc, 'inbound', 'received', 'x@example.com', 'Unlinked', now());
  select count(*) into v_n from public.leads where id = v_lead and jsonb_array_length(activity_log) <> 1;
  if v_n <> 0 then raise exception 'FAIL: reply on an unlinked conversation changes no lead'; end if;
  raise notice 'PASS: reply on an unlinked conversation changes no lead';

  -- A stale editor saving an old activity_log must not drop the email entry.
  update public.leads set activity_log = '[]'::jsonb where id = v_lead;
  select activity_log into v_log from public.leads where id = v_lead;
  if jsonb_array_length(v_log) <> 1 or v_log -> 0 ->> 'type' <> 'email_received' then raise exception 'FAIL: stale save keeps the email_received entry (%)', v_log; end if;
  raise notice 'PASS: stale save keeps the email_received entry';

  -- Outbound messages never add an inbound entry.
  insert into public.email_messages (organization_id, conversation_id, account_id, direction, status, from_email, subject, created_by)
    values (v_org, v_conv, v_acc, 'outbound', 'draft', 'me@example.com', 'Out', v_user);
  select jsonb_array_length(activity_log) into v_n from public.leads where id = v_lead;
  if v_n <> 1 then raise exception 'FAIL: outbound messages add no inbound entry'; end if;
  raise notice 'PASS: outbound messages add no inbound entry';

  -- A broken timeline write must not block receiving mail.
  alter table public.leads disable trigger leads_preserve_email_crm_activity;
  update public.leads set activity_log = '"not-an-array"'::jsonb where id = v_lead;
  insert into public.email_messages (organization_id, conversation_id, account_id, direction, status, from_email, subject, received_at)
    values (v_org, v_conv, v_acc, 'inbound', 'received', 'client@example.com', 'Still arrives', now());
  raise notice 'PASS: a timeline failure never blocks inbound mail';
  alter table public.leads enable trigger leads_preserve_email_crm_activity;
end $$;
rollback;
