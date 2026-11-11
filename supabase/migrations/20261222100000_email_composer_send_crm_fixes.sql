-- Inbox composer/send/CRM correctness fixes (additive, safe to re-run).
begin;
create or replace function public.email_save_draft(
  p_draft_id uuid, p_conversation_id uuid, p_account_id uuid,
  p_to text[], p_cc text[], p_bcc text[], p_subject text, p_body_text text, p_body_html text,
  p_crm_lead_id uuid
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.email_require_access();
  v_conv uuid := p_conversation_id;
  v_acc public.email_accounts;
  m public.email_messages;
  v_conv_acc uuid;
  v_lead uuid := p_crm_lead_id;
  v_explicit_lead uuid := p_crm_lead_id;
  v_owner uuid;
begin
  select * into v_acc from public.email_accounts where id = p_account_id and organization_id = v_org;
  if not found then raise exception 'Sender address not found'; end if;
  if p_draft_id is not null then
    select * into m from public.email_messages where id = p_draft_id and organization_id = v_org and status = 'draft' for update;
    if not found then raise exception 'Draft not found'; end if;
    if m.account_id <> v_acc.id then raise exception 'This draft belongs to a different sender account'; end if;
    if v_conv is not null and v_conv is distinct from m.conversation_id then
      raise exception 'Draft conversation does not match the requested conversation';
    end if;
    if v_conv is null then v_conv := m.conversation_id; end if;
    if v_lead is null then v_lead := m.crm_lead_id; end if;
  end if;
  if v_conv is not null then
    select c.account_id, l.user_id into v_conv_acc, v_owner from public.email_conversations c
      left join public.leads l on l.id = c.lead_id where c.id = v_conv and c.organization_id = v_org;
    if not found then raise exception 'Conversation not found'; end if;
    if v_conv_acc <> v_acc.id then raise exception 'This conversation belongs to a different sender account'; end if;
    if v_lead is null then v_lead := (select lead_id from public.email_conversations where id = v_conv); end if;
    if (select lead_id from public.email_conversations where id = v_conv) is not null
       and v_lead is not null and (select lead_id from public.email_conversations where id = v_conv) <> v_lead then
      raise exception 'crm_lead_conflict' using errcode = '22023';
    end if;
  end if;
  if v_lead is not null then
    select user_id into v_owner from public.leads where id = v_lead;
    if not found then raise exception 'CRM lead not found' using errcode = '42501'; end if;
    if v_owner is distinct from auth.uid() then
      if v_explicit_lead is not null then raise exception 'CRM lead not found' using errcode = '42501'; end if;
      v_lead := null; -- shared conversation/draft: colleague may save without writing another user's CRM activity
    end if;
  end if;
  if v_conv is null then
    insert into public.email_conversations (organization_id, account_id, subject, normalized_subject, lead_id)
    values (v_org, v_acc.id, left(coalesce(p_subject, ''), 998), '', v_lead) returning id into v_conv;
  elsif v_lead is not null then
    update public.email_conversations set lead_id = v_lead where id = v_conv and lead_id is null;
  end if;
  if p_draft_id is not null then
    update public.email_messages set to_emails=coalesce(p_to,'{}'), cc_emails=coalesce(p_cc,'{}'), bcc_emails=coalesce(p_bcc,'{}'),
      subject=left(coalesce(p_subject,''),998), body_text=left(coalesce(p_body_text,''),200000), body_html=left(coalesce(p_body_html,''),1100000),
      crm_lead_id=v_lead, ai_generated=false where id=p_draft_id returning * into m;
  else
    insert into public.email_messages (organization_id,conversation_id,account_id,direction,status,from_email,from_name,to_emails,cc_emails,bcc_emails,subject,body_text,body_html,is_read,created_by,crm_lead_id)
    values (v_org,v_conv,v_acc.id,'outbound','draft',v_acc.address,v_acc.display_name,coalesce(p_to,'{}'),coalesce(p_cc,'{}'),coalesce(p_bcc,'{}'),
      left(coalesce(p_subject,''),998),left(coalesce(p_body_text,''),200000),left(coalesce(p_body_html,''),1100000),true,auth.uid(),v_lead) returning * into m;
  end if;
  return jsonb_build_object('draft_id',m.id,'conversation_id',m.conversation_id);
end $$;
revoke all on function public.email_save_draft(uuid,uuid,uuid,text[],text[],text[],text,text,text,uuid) from public, anon;
grant execute on function public.email_save_draft(uuid,uuid,uuid,text[],text[],text[],text,text,text,uuid) to authenticated;

-- Preserve the original RPC signature for older clients.
create or replace function public.email_save_draft(
  p_draft_id uuid, p_conversation_id uuid, p_account_id uuid,
  p_to text[], p_cc text[], p_bcc text[], p_subject text, p_body_text text, p_body_html text default ''
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.email_require_access();
begin
  if not exists (select 1 from public.email_accounts where id = p_account_id and organization_id = v_org) then
    raise exception 'Sender address not found';
  end if;
  return public.email_save_draft(p_draft_id,p_conversation_id,p_account_id,p_to,p_cc,p_bcc,p_subject,p_body_text,p_body_html,null::uuid);
end;
$$;
revoke all on function public.email_save_draft(uuid,uuid,uuid,text[],text[],text[],text,text,text) from public, anon;
grant execute on function public.email_save_draft(uuid,uuid,uuid,text[],text[],text[],text,text,text) to authenticated;
create or replace function public.email_create_outbound(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := (p ->> 'organization_id')::uuid;
  v_acc public.email_accounts;
  v_conv uuid := nullif(p ->> 'conversation_id', '')::uuid;
  v_conv_acc uuid;
  v_draft uuid := nullif(p ->> 'draft_id', '')::uuid;
  v_draft_acc uuid;
  v_draft_status text;
  v_conv_lead uuid;
  v_key text := nullif(p ->> 'idempotency_key', '');
  v_lead uuid := nullif(p ->> 'crm_lead_id', '')::uuid;
  v_crm_user uuid := nullif(p ->> 'crm_user_id', '')::uuid;
  v_lead_owner uuid;
  m public.email_messages;
  v_addr text;
  r text;
  v_fingerprint text;
  v_rate_minute integer := greatest(1, least(coalesce(nullif(p ->> 'rate_limit_minute','')::integer,20),1000));
  v_rate_daily integer := greatest(1, least(coalesce(nullif(p ->> 'rate_limit_daily','')::integer,100),100000));
begin
  select * into v_acc from public.email_accounts where id = (p ->> 'account_id')::uuid and organization_id = v_org;
  if not found then raise exception 'Sender address not found'; end if;

  -- Serialize submissions sharing an organization-scoped idempotency key. This closes the
  -- read-before-insert race for concurrent new conversations as well as draft submissions.
  if v_key is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_org::text || ':' || v_key, 0));
  end if;
  -- Resolve a draft's conversation before fingerprinting, but allow an already-submitted
  -- draft row to be found on an idempotent retry. The draft row and conversation are locked
  -- so a concurrent lead relink cannot race this authoritative decision.
  if v_draft is not null then
    select conversation_id, account_id, status into v_conv, v_draft_acc, v_draft_status
      from public.email_messages
     where id = v_draft and organization_id = v_org
     for update;
    if not found then raise exception 'Draft not found'; end if;
    if v_draft_acc <> v_acc.id then raise exception 'This draft belongs to a different sender account'; end if;
    if nullif(p ->> 'conversation_id', '') is not null
       and (p ->> 'conversation_id')::uuid is distinct from v_conv then
      raise exception 'Draft conversation does not match the requested conversation';
    end if;
  end if;

  if v_conv is not null then
    select account_id, lead_id into v_conv_acc, v_conv_lead
      from public.email_conversations
     where id = v_conv and organization_id = v_org
     for update;
    if not found then raise exception 'Conversation not found'; end if;
    if v_conv_acc <> v_acc.id then raise exception 'This conversation belongs to a different sender account'; end if;
    if v_conv_lead is not null and v_lead is not null and v_conv_lead <> v_lead then
      raise exception 'crm_lead_conflict' using errcode = '22023';
    end if;
    if v_lead is null and v_conv_lead is not null then
      select user_id into v_lead_owner from public.leads where id = v_conv_lead;
      if found and v_lead_owner = nullif(p ->> 'user_id', '')::uuid then v_lead := v_conv_lead; end if;
    end if;
  end if;

  if v_lead is not null then
    if v_crm_user is null then v_crm_user := nullif(p ->> 'user_id', '')::uuid; end if;
    if v_crm_user is distinct from nullif(p ->> 'user_id', '')::uuid then
      raise exception 'CRM user must match the authenticated sender' using errcode = '42501';
    end if;
    select user_id into v_lead_owner from public.leads where id = v_lead for share;
    if not found or v_lead_owner is distinct from v_crm_user then
      raise exception 'CRM lead not found' using errcode = '42501';
    end if;
  elsif v_crm_user is not null then
    raise exception 'CRM lead and user must be supplied together' using errcode = '22023';
  end if;

  v_fingerprint := md5((jsonb_build_object(
    'account_id', p ->> 'account_id', 'user_id', p ->> 'user_id', 'conversation_id', nullif(p ->> 'conversation_id',''),
    'draft_id', nullif(p ->> 'draft_id',''), 'to_emails', coalesce(p -> 'to_emails','[]'::jsonb),
    'cc_emails', coalesce(p -> 'cc_emails','[]'::jsonb), 'bcc_emails', coalesce(p -> 'bcc_emails','[]'::jsonb),
    'reply_to', coalesce(p ->> 'reply_to',''), 'subject', coalesce(p ->> 'subject',''),
    'body_text', coalesce(p ->> 'body_text',''), 'body_html', coalesce(p ->> 'body_html',''),
    'attachments', coalesce(p -> 'attachments','[]'::jsonb)
  ) || case when v_lead is not null then jsonb_build_object('crm_lead_id', v_lead, 'crm_user_id', v_crm_user) else '{}'::jsonb end)::text);

  if v_key is not null then
    select * into m from public.email_messages where organization_id = v_org and idempotency_key = v_key;
    if found then
      if m.account_id <> v_acc.id or m.request_fingerprint is null or m.request_fingerprint <> v_fingerprint then
        raise exception 'idempotency_key_conflict' using errcode = '22023';
      end if;
      return jsonb_build_object('duplicate', true, 'message_id', m.id, 'conversation_id', m.conversation_id,
        'status', m.status, 'provider_message_id', m.provider_message_id);
    end if;
  end if;

  -- Rate checks run only after the duplicate lookup and before any new message is inserted.
  -- The organization lock serializes concurrent sends so two simultaneous requests cannot both pass the burst cap.
  perform pg_advisory_xact_lock(hashtextextended(v_org::text || ':email-rate-limit', 0));
  if (select count(*) from public.email_messages
       where organization_id = v_org and direction = 'outbound' and status <> 'draft'
         and created_at >= now() - interval '1 minute') >= v_rate_minute then
    return jsonb_build_object('duplicate', false, 'rate_limited', 'minute');
  end if;
  if (select count(*) from public.email_messages
       where organization_id = v_org and provider = v_acc.provider and direction = 'outbound' and status <> 'draft'
         and created_at >= now() - interval '1 day') >= v_rate_daily then
    return jsonb_build_object('duplicate', false, 'rate_limited', 'day');
  end if;

  if v_conv is not null and v_conv_lead is null and v_lead is not null then
    update public.email_conversations set lead_id = v_lead where id = v_conv;
  end if;

  if v_draft is not null then
    if v_draft_status <> 'draft' then raise exception 'Draft not found'; end if;
    update public.email_messages
       set status = 'queued', from_email = v_acc.address, from_name = v_acc.display_name,
           to_emails = coalesce(array(select jsonb_array_elements_text(p -> 'to_emails')), '{}'),
           cc_emails = coalesce(array(select jsonb_array_elements_text(p -> 'cc_emails')), '{}'),
           bcc_emails = coalesce(array(select jsonb_array_elements_text(p -> 'bcc_emails')), '{}'),
           reply_to = left(coalesce(p ->> 'reply_to', ''), 500), subject = left(coalesce(p ->> 'subject', ''), 998),
           body_text = left(coalesce(p ->> 'body_text', ''), 200000), body_html = left(coalesce(p ->> 'body_html', ''), 1100000),
           in_reply_to = nullif(p ->> 'in_reply_to', ''), references_ids = nullif(p ->> 'references_ids', ''),
           idempotency_key = v_key, request_fingerprint = v_fingerprint, created_by = nullif(p ->> 'user_id', '')::uuid,
           crm_lead_id = v_lead
     where id = v_draft returning * into m;
  else
    if v_conv is null then
      insert into public.email_conversations (organization_id, account_id, subject, normalized_subject, lead_id)
      values (v_org, v_acc.id, left(coalesce(p ->> 'subject', ''), 998), coalesce(p ->> 'normalized_subject', ''), v_lead) returning id into v_conv;
    end if;
    insert into public.email_messages (organization_id, conversation_id, account_id, direction, status, from_email, from_name,
      to_emails, cc_emails, bcc_emails, reply_to, subject, body_text, body_html, in_reply_to, references_ids,
      is_read, idempotency_key, request_fingerprint, created_by, crm_lead_id)
    values (v_org, v_conv, v_acc.id, 'outbound', 'queued', v_acc.address, v_acc.display_name,
      coalesce(array(select jsonb_array_elements_text(p -> 'to_emails')), '{}'),
      coalesce(array(select jsonb_array_elements_text(p -> 'cc_emails')), '{}'),
      coalesce(array(select jsonb_array_elements_text(p -> 'bcc_emails')), '{}'), left(coalesce(p ->> 'reply_to', ''), 500),
      left(coalesce(p ->> 'subject', ''), 998), left(coalesce(p ->> 'body_text', ''), 200000),
      left(coalesce(p ->> 'body_html', ''), 1100000), nullif(p ->> 'in_reply_to', ''), nullif(p ->> 'references_ids', ''),
      true, v_key, v_fingerprint, nullif(p ->> 'user_id', '')::uuid, v_lead)
    returning * into m;
  end if;

  foreach r in array array['to_emails', 'cc_emails'] loop
    for v_addr in select lower(btrim(x)) from jsonb_array_elements_text(coalesce(p -> r, '[]'::jsonb)) x loop
      insert into public.email_participants (organization_id, conversation_id, email)
      values (v_org, m.conversation_id, v_addr) on conflict (conversation_id, email) do nothing;
    end loop;
  end loop;
  insert into public.email_participants (organization_id, conversation_id, email, name)
  values (v_org, m.conversation_id, v_acc.address, v_acc.display_name) on conflict (conversation_id, email) do nothing;
  return jsonb_build_object('duplicate', false, 'message_id', m.id, 'conversation_id', m.conversation_id, 'status', m.status);
end $$;
revoke all on function public.email_create_outbound(jsonb) from public, anon, authenticated;
grant execute on function public.email_create_outbound(jsonb) to service_role;
create or replace function public.email_claim_outbound(p_message_id uuid, p_reply_to text default null) returns boolean
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_count integer;
begin
  update public.email_messages set status='sending', reply_to=left(coalesce(p_reply_to,reply_to,''),500)
   where id=p_message_id and direction='outbound' and status='queued';
  get diagnostics v_count = row_count;
  return v_count = 1;
end $$;
revoke all on function public.email_claim_outbound(uuid,text) from public, anon, authenticated;
grant execute on function public.email_claim_outbound(uuid,text) to service_role;
alter table public.email_messages add column if not exists crm_recovery_attempts integer not null default 0;
alter table public.email_messages add column if not exists crm_recovery_last_attempt_at timestamptz;
create index if not exists email_messages_crm_recovery_fair_idx
  on public.email_messages (crm_recovery_last_attempt_at nulls first, coalesce(sent_at,created_at))
  where direction='outbound' and crm_lead_id is not null
    and status in ('sent','delivered','delivery_delayed','bounced','complained') and crm_recovery_attempts < 10;
create or replace function public.email_recover_crm_activities(p_limit integer default 100) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v record; v_attempted integer:=0; v_recorded integer:=0; v_failed integer:=0;
begin
  for v in
    select m.id from public.email_messages m
     where m.direction='outbound' and m.crm_lead_id is not null
       and m.status in ('sent','delivered','delivery_delayed','bounced','complained')
       and m.crm_recovery_attempts < 10
       and not exists (select 1 from public.email_crm_activities c where c.message_id=m.id)
     order by m.crm_recovery_last_attempt_at nulls first, coalesce(m.sent_at,m.created_at)
     limit greatest(1,least(coalesce(p_limit,100),500))
     for update skip locked
  loop
    v_attempted:=v_attempted+1;
    update public.email_messages set crm_recovery_attempts=crm_recovery_attempts+1, crm_recovery_last_attempt_at=now() where id=v.id;
    begin
      perform public.email_record_crm_activity(v.id); v_recorded:=v_recorded+1;
    exception when others then
      v_failed:=v_failed+1;
      raise warning 'CRM activity recovery failed for message %: %',v.id,sqlerrm;
    end;
  end loop;
  return jsonb_build_object('attempted',v_attempted,'recorded',v_recorded,'failed',v_failed);
end $$;
revoke all on function public.email_recover_crm_activities(integer) from public, anon, authenticated;
grant execute on function public.email_recover_crm_activities(integer) to service_role;
commit;

-- Rollback: restore email_save_draft from 20261204100000_email_provider_scoping.sql,
-- restore email_create_outbound from 20261209100000_email_crm_conversation_attribution.sql,
-- drop email_claim_outbound(uuid,text), and drop the two crm_recovery_* columns/index.
-- No messages, drafts, CRM activities, accounts or provider credentials are deleted.
