-- Forward correction for confirmed production findings:
-- 1) Restore valid sender-address checks under standard_conforming_strings=on.
-- 2) Keep structured CRM activity attribution aligned with conversation relink/unlink/rethread.
begin;

create or replace function public.email_upsert_account(
  p_address text, p_display_name text default '', p_provider text default 'resend'
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.email_require_access();
  v_addr text := lower(btrim(coalesce(p_address, '')));
  v_prov text := lower(btrim(coalesce(p_provider, '')));
  r public.email_accounts;
begin
  -- Prevent concurrent first-account inserts from racing the organization default.
  perform pg_advisory_xact_lock(hashtextextended(v_org::text, 0));

  if v_addr !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Enter a valid email address';
  end if;
  if not exists (
    select 1 from public.email_provider_registry
    where provider_key = v_prov and enabled = true and capabilities ->> 'send' = 'true'
  ) then
    raise exception 'Unknown, disabled, or non-sending email provider';
  end if;

  insert into public.email_accounts (organization_id, provider, address, display_name, is_default)
  values (
    v_org, v_prov, v_addr, left(btrim(coalesce(p_display_name, '')), 120),
    not exists (select 1 from public.email_accounts where organization_id = v_org)
  )
  on conflict (organization_id, provider, address)
  do update set display_name = excluded.display_name
  returning * into r;

  return to_jsonb(r) - 'last_connection_error';
end $$;
revoke all on function public.email_upsert_account(text, text, text) from public, anon;
grant execute on function public.email_upsert_account(text, text, text) to authenticated;

-- An email activity remains durable when a conversation is unlinked; its CRM lead association is nullable.
alter table public.email_crm_activities alter column lead_id drop not null;

-- Repair existing rows as well as future relink/unlink events. The conversation is authoritative.
update public.email_crm_activities a
   set lead_id = c.lead_id
  from public.email_messages m
  left join public.email_conversations c
    on c.id = m.conversation_id and c.organization_id = m.organization_id
 where a.message_id = m.id
   and a.lead_id is distinct from c.lead_id;

create or replace function public._email_sync_message_crm_timeline(p_message_id uuid) returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  m public.email_messages;
  v_lead uuid;
  v_entry jsonb;
  v_from text;
  v_auto_submitted text;
  v_precedence text;
  v_auto_reply text;
  v_local text;
  v_previous_relink_flag text;
begin
  select * into m from public.email_messages where id = p_message_id;
  if not found then return; end if;
  select c.lead_id into v_lead from public.email_conversations c
   where c.id = m.conversation_id and c.organization_id = m.organization_id;

  v_previous_relink_flag := current_setting('app.email_timeline_relink', true);
  perform set_config('app.email_timeline_relink', 'on', true);
  update public.leads l
     set activity_log = coalesce((
       select jsonb_agg(e.value order by e.ordinality)
         from jsonb_array_elements(coalesce(l.activity_log, '[]'::jsonb)) with ordinality e(value, ordinality)
        where e.value ->> 'emailMessageId' is distinct from m.id::text
     ), '[]'::jsonb)
   where exists (
     select 1 from jsonb_array_elements(coalesce(l.activity_log, '[]'::jsonb)) e
      where e ->> 'emailMessageId' = m.id::text
   );
  perform set_config('app.email_timeline_relink', coalesce(v_previous_relink_flag, ''), true);

  -- Keep the structured activity attribution aligned with the conversation's current CRM link.
  -- Unlinking sets lead_id to NULL; relinking moves the record to the new lead.
  update public.email_crm_activities
     set lead_id = v_lead
   where message_id = m.id
     and lead_id is distinct from v_lead;

  if v_lead is null then return; end if;

  if m.direction = 'inbound' then
    v_local := lower(split_part(coalesce(m.from_email, ''), '@', 1));
    v_auto_submitted := lower(coalesce(m.headers ->> 'auto-submitted', ''));
    v_precedence := lower(coalesce(m.headers ->> 'precedence', ''));
    v_auto_reply := lower(coalesce(m.headers ->> 'x-autoreply', m.headers ->> 'x-autorespond', ''));
    if v_local in ('mailer-daemon', 'postmaster')
       or (v_auto_submitted <> '' and v_auto_submitted <> 'no')
       or v_precedence in ('bulk', 'list', 'junk')
       or v_auto_reply in ('yes', 'true', '1')
       or lower(coalesce(m.subject, '')) ~ '(automatic reply|auto.?reply|out of office|undeliverable|delivery status notification|mail delivery failed|returned mail)' then
      return;
    end if;
    v_from := coalesce(nullif(m.from_name, ''), nullif(m.from_email, ''), 'sender');
    v_entry := jsonb_build_object(
      'ts', coalesce(m.received_at, m.created_at, now()),
      'type', 'email_received',
      'note', left('Email received from ' || v_from || ' — ' || coalesce(nullif(m.subject, ''), '(no subject)'), 500),
      'emailMessageId', m.id,
      'emailConversationId', m.conversation_id,
      'provider', m.provider
    );
  elsif m.direction = 'outbound' and m.status in ('sent','delivered','delivery_delayed','bounced','complained') then
    v_entry := jsonb_build_object(
      'ts', coalesce(m.sent_at, m.created_at, now()),
      'type', 'email_sent',
      'note', left('Email sent to ' || coalesce(nullif(m.to_emails[1], ''), 'recipient') || ' — ' || coalesce(nullif(m.subject, ''), '(no subject)'), 500),
      'emailMessageId', m.id,
      'emailConversationId', m.conversation_id,
      'provider', m.provider,
      'providerMessageId', m.provider_message_id
    );
  else
    return;
  end if;

  update public.leads l
     set activity_log = coalesce(l.activity_log, '[]'::jsonb) || jsonb_build_array(v_entry)
   where l.id = v_lead
     and not exists (
       select 1 from jsonb_array_elements(coalesce(l.activity_log, '[]'::jsonb)) e
        where e ->> 'emailMessageId' = m.id::text
     );
exception when others then
  raise warning 'email CRM timeline reconciliation skipped for message %: %', p_message_id, sqlerrm;
end $$;
revoke all on function public._email_sync_message_crm_timeline(uuid) from public, anon, authenticated;

commit;

-- Rollback: restore email_upsert_account(text,text,text) from 20261220100000_email_provider_sender_safety.sql
-- only after correcting its address regex; restore _email_sync_message_crm_timeline(uuid) from
-- 20261223100000_email_crm_timeline_reconciliation.sql and set email_crm_activities.lead_id NOT NULL
-- only after every NULL attribution has been manually reconciled.
