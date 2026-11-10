begin;

-- Phase 4D: durable CRM attribution + idempotent post-acceptance activity recording.
-- The email_messages row is the recovery source: it is created before provider submission
-- and stores crm_lead_id. If CRM recording fails after provider acceptance, recovery replays
-- email_record_crm_activity; it NEVER submits to a provider.

alter table public.email_messages
  add column if not exists crm_lead_id uuid references public.leads(id) on delete set null;
create index if not exists email_messages_crm_recovery_idx
  on public.email_messages (sent_at, created_at)
  where direction = 'outbound' and crm_lead_id is not null
    and status in ('sent','delivered','delivery_delayed','bounced','complained');

-- Full approved email content is kept in a dedicated CRM activity record. The lead's existing
-- activity_log receives a compact timeline entry referencing this immutable record.
create table if not exists public.email_crm_activities (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null unique references public.email_messages(id) on delete cascade,
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  account_id uuid not null references public.email_accounts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  provider_message_id text not null,
  from_email text not null,
  from_name text not null default '',
  to_emails text[] not null default '{}',
  cc_emails text[] not null default '{}',
  bcc_emails text[] not null default '{}',
  reply_to text not null default '',
  subject text not null default '',
  body_text text not null default '',
  body_html text not null default '',
  sent_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists email_crm_activities_lead_idx
  on public.email_crm_activities (lead_id, sent_at desc);
alter table public.email_crm_activities enable row level security;
revoke all on public.email_crm_activities from public, anon, authenticated;
grant select on public.email_crm_activities to authenticated;
drop policy if exists email_crm_activities_select on public.email_crm_activities;
create policy email_crm_activities_select on public.email_crm_activities
  for select to authenticated using (user_id = auth.uid());

-- Replace the 4C RPC without changing its no-CRM fingerprint. CRM submissions add lead + user
-- to the fingerprint, so reusing an idempotency key for a different lead is a conflict.
create or replace function public.email_create_outbound(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := (p ->> 'organization_id')::uuid;
  v_acc public.email_accounts;
  v_conv uuid := nullif(p ->> 'conversation_id', '')::uuid;
  v_conv_acc uuid;
  v_draft uuid := nullif(p ->> 'draft_id', '')::uuid;
  v_draft_acc uuid;
  v_key text := nullif(p ->> 'idempotency_key', '');
  v_lead uuid := nullif(p ->> 'crm_lead_id', '')::uuid;
  v_crm_user uuid := nullif(p ->> 'crm_user_id', '')::uuid;
  v_lead_owner uuid;
  m public.email_messages;
  v_addr text;
  r text;
  v_fingerprint text;
begin
  if (v_lead is null) <> (v_crm_user is null) then
    raise exception 'CRM lead and user must be supplied together' using errcode = '22023';
  end if;
  if v_lead is not null then
    if v_crm_user is distinct from nullif(p ->> 'user_id', '')::uuid then
      raise exception 'CRM user must match the authenticated sender' using errcode = '42501';
    end if;
    select user_id into v_lead_owner from public.leads where id = v_lead;
    if not found or v_lead_owner is distinct from v_crm_user then
      raise exception 'CRM lead not found' using errcode = '42501';
    end if;
  end if;

  v_fingerprint := md5((jsonb_build_object(
    'account_id', p ->> 'account_id', 'user_id', p ->> 'user_id', 'conversation_id', nullif(p ->> 'conversation_id',''),
    'draft_id', nullif(p ->> 'draft_id',''), 'to_emails', coalesce(p -> 'to_emails','[]'::jsonb),
    'cc_emails', coalesce(p -> 'cc_emails','[]'::jsonb), 'bcc_emails', coalesce(p -> 'bcc_emails','[]'::jsonb),
    'reply_to', coalesce(p ->> 'reply_to',''), 'subject', coalesce(p ->> 'subject',''),
    'body_text', coalesce(p ->> 'body_text',''), 'body_html', coalesce(p ->> 'body_html',''),
    'in_reply_to', nullif(p ->> 'in_reply_to',''), 'references_ids', nullif(p ->> 'references_ids',''),
    'attachments', coalesce(p -> 'attachments','[]'::jsonb)
  ) || case when v_lead is not null then jsonb_build_object('crm_lead_id', v_lead, 'crm_user_id', v_crm_user) else '{}'::jsonb end)::text);

  select * into v_acc from public.email_accounts where id = (p ->> 'account_id')::uuid and organization_id = v_org;
  if not found then raise exception 'Sender address not found'; end if;
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
  if v_conv is not null then
    select account_id into v_conv_acc from public.email_conversations where id = v_conv and organization_id = v_org;
    if not found then raise exception 'Conversation not found'; end if;
    if v_conv_acc <> v_acc.id then raise exception 'This conversation belongs to a different sender account'; end if;
  end if;
  if v_draft is not null then
    select conversation_id, account_id into v_conv, v_draft_acc from public.email_messages
      where id = v_draft and organization_id = v_org and status = 'draft' for update;
    if not found then raise exception 'Draft not found'; end if;
    if v_draft_acc <> v_acc.id then raise exception 'This draft belongs to a different sender account'; end if;
    update public.email_messages
       set status = 'queued', from_email = v_acc.address, from_name = v_acc.display_name,
           to_emails = coalesce(array(select jsonb_array_elements_text(p -> 'to_emails')), '{}'),
           cc_emails = coalesce(array(select jsonb_array_elements_text(p -> 'cc_emails')), '{}'),
           bcc_emails = coalesce(array(select jsonb_array_elements_text(p -> 'bcc_emails')), '{}'),
           reply_to = left(coalesce(p ->> 'reply_to', ''), 500), subject = left(coalesce(p ->> 'subject', ''), 998),
           body_text = left(coalesce(p ->> 'body_text', ''), 200000), body_html = left(coalesce(p ->> 'body_html', ''), 400000),
           in_reply_to = nullif(p ->> 'in_reply_to', ''), references_ids = nullif(p ->> 'references_ids', ''),
           idempotency_key = v_key, request_fingerprint = v_fingerprint, created_by = nullif(p ->> 'user_id', '')::uuid,
           crm_lead_id = v_lead
     where id = v_draft returning * into m;
  else
    if v_conv is null then
      insert into public.email_conversations (organization_id, account_id, subject, normalized_subject)
      values (v_org, v_acc.id, left(coalesce(p ->> 'subject', ''), 998), coalesce(p ->> 'normalized_subject', '')) returning id into v_conv;
    end if;
    insert into public.email_messages (organization_id, conversation_id, account_id, direction, status, from_email, from_name,
      to_emails, cc_emails, bcc_emails, reply_to, subject, body_text, body_html, in_reply_to, references_ids,
      is_read, idempotency_key, request_fingerprint, created_by, crm_lead_id)
    values (v_org, v_conv, v_acc.id, 'outbound', 'queued', v_acc.address, v_acc.display_name,
      coalesce(array(select jsonb_array_elements_text(p -> 'to_emails')), '{}'),
      coalesce(array(select jsonb_array_elements_text(p -> 'cc_emails')), '{}'),
      coalesce(array(select jsonb_array_elements_text(p -> 'bcc_emails')), '{}'), left(coalesce(p ->> 'reply_to', ''), 500),
      left(coalesce(p ->> 'subject', ''), 998), left(coalesce(p ->> 'body_text', ''), 200000),
      left(coalesce(p ->> 'body_html', ''), 400000), nullif(p ->> 'in_reply_to', ''), nullif(p ->> 'references_ids', ''),
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

-- Called only after the provider has accepted the message. All writes are one transaction:
-- full activity row + compact lead timeline entry. A retry is safe by message_id.
create or replace function public.email_record_crm_activity(p_message_id uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  m public.email_messages;
  a public.email_accounts;
  v_lead_owner uuid;
  v_activity_id uuid;
  v_entry jsonb;
  v_recipient text;
begin
  select * into m from public.email_messages where id = p_message_id for update;
  if not found then raise exception 'Email message not found'; end if;
  if m.direction <> 'outbound' or m.crm_lead_id is null then
    return jsonb_build_object('recorded', false, 'duplicate', false, 'reason', 'no_crm_lead');
  end if;
  if m.status not in ('sent','delivered','delivery_delayed','bounced','complained') then
    raise exception 'CRM activity cannot be recorded before provider acceptance';
  end if;
  if nullif(m.provider_message_id, '') is null then
    raise exception 'Provider message id is required for CRM activity recording';
  end if;
  select * into a from public.email_accounts where id = m.account_id and organization_id = m.organization_id;
  if not found then raise exception 'Sender account ownership mismatch'; end if;
  select user_id into v_lead_owner from public.leads where id = m.crm_lead_id for update;
  if not found or v_lead_owner is distinct from m.created_by or m.created_by is null then
    raise exception 'CRM lead ownership mismatch';
  end if;

  insert into public.email_crm_activities (
    message_id, organization_id, lead_id, account_id, user_id, provider, provider_message_id,
    from_email, from_name, to_emails, cc_emails, bcc_emails, reply_to, subject, body_text, body_html, sent_at
  ) values (
    m.id, m.organization_id, m.crm_lead_id, m.account_id, m.created_by, m.provider, m.provider_message_id,
    m.from_email, m.from_name, m.to_emails, m.cc_emails, m.bcc_emails, m.reply_to, m.subject, m.body_text, m.body_html,
    coalesce(m.sent_at, m.created_at, now())
  ) on conflict (message_id) do nothing returning id into v_activity_id;

  if v_activity_id is null then
    select id into v_activity_id from public.email_crm_activities where message_id = m.id;
    return jsonb_build_object('recorded', true, 'duplicate', true, 'activity_id', v_activity_id);
  end if;

  v_recipient := coalesce(nullif(m.to_emails[1], ''), 'recipient');
  v_entry := jsonb_build_object(
    'ts', coalesce(m.sent_at, m.created_at, now()),
    'type', 'email_sent',
    'note', left('Email sent to ' || v_recipient || ' — ' || coalesce(nullif(m.subject, ''), '(no subject)'), 500),
    'emailMessageId', m.id,
    'emailActivityId', v_activity_id,
    'provider', m.provider,
    'providerMessageId', m.provider_message_id
  );
  update public.leads
     set activity_log = coalesce(activity_log, '[]'::jsonb) || jsonb_build_array(v_entry)
   where id = m.crm_lead_id and user_id = m.created_by
     and not exists (
       select 1 from jsonb_array_elements(coalesce(activity_log, '[]'::jsonb)) e
        where e ->> 'emailMessageId' = m.id::text
     );
  if not found then
    -- Either an existing timeline event already represents this message or the owner row vanished.
    if not exists (select 1 from public.leads where id = m.crm_lead_id and user_id = m.created_by) then
      raise exception 'CRM lead disappeared during activity recording';
    end if;
  end if;
  return jsonb_build_object('recorded', true, 'duplicate', false, 'activity_id', v_activity_id);
end $$;
revoke all on function public.email_record_crm_activity(uuid) from public, anon, authenticated;
grant execute on function public.email_record_crm_activity(uuid) to service_role;

-- The CRM editor writes activity_log as part of a full lead-row save. Preserve email timeline
-- entries if a stale browser snapshot is saved after the server has appended a new email event.
create or replace function public._email_preserve_crm_activity_entries() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
declare
  v_entry jsonb;
  v_log jsonb := coalesce(new.activity_log, '[]'::jsonb);
begin
  if tg_op = 'UPDATE' then
    for v_entry in
      select e.value from jsonb_array_elements(coalesce(old.activity_log, '[]'::jsonb)) e(value)
       where e.value ->> 'type' = 'email_sent' and e.value ? 'emailMessageId'
    loop
      if not exists (
        select 1 from jsonb_array_elements(v_log) n(value)
         where n.value ->> 'emailMessageId' = v_entry ->> 'emailMessageId'
      ) then
        v_log := v_log || jsonb_build_array(v_entry);
      end if;
    end loop;
    new.activity_log := v_log;
  end if;
  return new;
end $$;
drop trigger if exists leads_preserve_email_crm_activity on public.leads;
create trigger leads_preserve_email_crm_activity
  before update of activity_log on public.leads
  for each row execute function public._email_preserve_crm_activity_entries();

-- Repair worker: scans only provider-accepted outbound rows with a lead association and no
-- activity row. Each message is isolated so one bad/deleted lead cannot block the rest.
create or replace function public.email_recover_crm_activities(p_limit integer default 100) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v record;
  v_attempted integer := 0;
  v_recorded integer := 0;
  v_failed integer := 0;
begin
  for v in
    select m.id
      from public.email_messages m
     where m.direction = 'outbound'
       and m.crm_lead_id is not null
       and m.status in ('sent','delivered','delivery_delayed','bounced','complained')
       and not exists (select 1 from public.email_crm_activities c where c.message_id = m.id)
     order by coalesce(m.sent_at, m.created_at)
     limit greatest(1, least(coalesce(p_limit, 100), 500))
  loop
    v_attempted := v_attempted + 1;
    begin
      perform public.email_record_crm_activity(v.id);
      v_recorded := v_recorded + 1;
    exception when others then
      v_failed := v_failed + 1;
      raise warning 'CRM activity recovery failed for message %: %', v.id, sqlerrm;
    end;
  end loop;
  return jsonb_build_object('attempted', v_attempted, 'recorded', v_recorded, 'failed', v_failed);
end $$;
revoke all on function public.email_recover_crm_activities(integer) from public, anon, authenticated;
grant execute on function public.email_recover_crm_activities(integer) to service_role;

commit;

-- Rollback (non-destructive): drop trigger leads_preserve_email_crm_activity on public.leads;
-- drop function public._email_preserve_crm_activity_entries();
-- drop function public.email_recover_crm_activities(integer);
-- drop function public.email_record_crm_activity(uuid);
-- restore email_create_outbound(jsonb) from 20261206100000_email_provider_idempotency.sql;
-- drop table public.email_crm_activities; drop index public.email_messages_crm_recovery_idx;
-- alter table public.email_messages drop column crm_lead_id;
-- No sent message is deleted or resubmitted by rollback.

-- Operational recovery (service role only):
--   select public.email_recover_crm_activities(100);
-- Schedule this RPC with pg_cron / Supabase Cron when the project is ready. It repairs CRM activity
-- only; it never calls an email provider and never changes message submission state.
