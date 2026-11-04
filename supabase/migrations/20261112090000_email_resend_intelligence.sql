-- Intelligence Resend transport. Additive; apply manually after review. Does not change settings,
-- caps, RLS policies, or the normal Inbox Resend workflow.
begin;

-- Canonical provider-neutral identifier; legacy zoho_message_id remains populated for compatibility.
alter table public.intel_messages add column if not exists provider_message_id text;
create unique index if not exists intel_messages_provider_uidx
  on public.intel_messages(organization_id, provider_message_id) where provider_message_id is not null;

-- Final database-side send gate: the worker cannot mark a reserved message as sending
-- while the emergency stop is ON. Existing reserve/cap/compliance checks remain unchanged.
create or replace function public.intel_agent_mark_sending(p_message_id uuid) returns boolean
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org();
begin
  if exists (select 1 from public.intel_settings where organization_id = v_org and kill_switch is true) then
    return false;
  end if;
  update public.intel_messages set state = 'sending'
   where id = p_message_id and organization_id = v_org and state = 'reserved';
  return found;
end $$;

-- The Edge Function asks for the message by id; it never accepts message content from
-- the worker. Only the authenticated Intelligence agent can read its own currently-sending row.
create or replace function public.intel_agent_resend_send_context(p_message_id uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org(); m public.intel_messages; s public.intel_settings;
begin
  select * into s from public.intel_settings where organization_id = v_org;
  if not found or s.kill_switch is true then return null; end if;
  select * into m from public.intel_messages
   where id = p_message_id and organization_id = v_org and direction = 'outbound' and state = 'sending';
  if not found then return null; end if;
  return jsonb_build_object('id', m.id, 'token', m.token, 'to_email', m.to_email, 'from_email', s.sender_email,
    'sender_email', s.sender_email, 'sender_name', s.sender_name, 'subject', m.subject, 'body_text', m.body_text,
    'in_reply_to', m.in_reply_to, 'references_ids', m.references_ids);
end $$;

-- Extend stale-send results with the provider id. The legacy column is retained for backwards
-- compatibility with Zoho/Gmail installations; for Resend it stores Resend's email id.
create or replace function public.intel_agent_stale_sends(p_older_than_seconds int default 600) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org();
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'token', m.token, 'to_email', m.to_email,
    'subject', m.subject, 'state', m.state, 'reserved_at', m.reserved_at, 'zoho_message_id', m.zoho_message_id, 'provider_message_id', m.provider_message_id))
    from public.intel_messages m where m.organization_id = v_org and m.direction = 'outbound'
      and m.state in ('sending','unknown') and m.reserved_at < now() - make_interval(secs => p_older_than_seconds)), '[]'::jsonb);
end $$;


-- Persist the Resend id immediately after provider acceptance, before the normal confirmation RPC.
create or replace function public.intel_agent_record_resend_acceptance(p_message_id uuid, p_provider_message_id text) returns boolean
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org();
begin
  if nullif(btrim(coalesce(p_provider_message_id, '')), '') is null then return false; end if;
  update public.intel_messages set provider_message_id = p_provider_message_id, zoho_message_id = p_provider_message_id
   where id = p_message_id and organization_id = v_org and direction = 'outbound'
     and state in ('sending','unknown') and (zoho_message_id is null or zoho_message_id = p_provider_message_id)
     and (provider_message_id is null or provider_message_id = p_provider_message_id);
  return found;
end $$;

-- Verify requests are scoped to the agent's own unresolved message and the exact saved provider id.
create or replace function public.intel_agent_resend_verify_context(p_message_id uuid, p_provider_message_id text) returns boolean
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org();
begin
  return exists (select 1 from public.intel_messages where organization_id = v_org and id = p_message_id
    and direction = 'outbound' and state in ('sending','unknown') and provider_message_id = p_provider_message_id);
end $$;

-- Server-side inbound ingestion. Only service_role (after Svix verification in the Edge Function)
-- may call this. Exact kf token AND prospect sender match are required; unrelated Inbox mail is ignored.
create or replace function public.intel_resend_record_inbound(
  p_provider_message_id text, p_rfc_message_id text, p_in_reply_to text, p_references text,
  p_from_email text, p_subject text, p_body_text text, p_received_at timestamptz, p_token text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid; v_prospect uuid; v_lead uuid; v_type text; v_id uuid; v_from text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  if nullif(btrim(coalesce(p_provider_message_id, '')), '') is null or nullif(btrim(coalesce(p_token, '')), '') is null then
    return jsonb_build_object('ignored', true, 'reason', 'missing provider id or Intelligence token');
  end if;
  select organization_id into v_org from public.intel_messages
   where direction = 'outbound' and token = p_token and state in ('sent','unknown','sending')
   order by created_at desc limit 1;
  if v_org is null then return jsonb_build_object('ignored', true, 'reason', 'unknown Intelligence token'); end if;
  select id into v_id from public.intel_messages where organization_id = v_org and (provider_message_id = p_provider_message_id or zoho_message_id = p_provider_message_id);
  if v_id is not null then return jsonb_build_object('duplicate', true, 'message_id', v_id); end if;
  v_from := public.intel_norm_email(p_from_email);
  select p.id, p.lead_id, p.type into v_prospect, v_lead, v_type
    from public.intel_messages o join public.intel_prospects p on p.id = o.prospect_id
   where o.organization_id = v_org and o.direction = 'outbound' and o.token = p_token
     and public.intel_norm_email(p.contact_email) = v_from
   order by o.created_at desc limit 1;
  if v_prospect is null then return jsonb_build_object('ignored', true, 'reason', 'sender does not match token prospect'); end if;

  insert into public.intel_messages(organization_id, prospect_id, lead_id, campaign_type, direction, kind, state,
    to_email, from_email, subject, body_text, idempotency_key, rfc_message_id, in_reply_to, references_ids,
    zoho_message_id, provider_message_id, received_at)
  values (v_org, v_prospect, v_lead, v_type, 'inbound', 'inbound', 'received', '', v_from,
    left(coalesce(p_subject, ''), 300), left(coalesce(p_body_text, ''), 20000), 'in:resend:' || p_provider_message_id,
    nullif(p_rfc_message_id, ''), nullif(p_in_reply_to, ''), nullif(p_references, ''), p_provider_message_id, p_provider_message_id,
    coalesce(p_received_at, now()))
  on conflict (organization_id, idempotency_key) do nothing returning id into v_id;
  if v_id is null then
    select id into v_id from public.intel_messages where organization_id = v_org and idempotency_key = 'in:resend:' || p_provider_message_id;
    return jsonb_build_object('duplicate', true, 'message_id', v_id);
  end if;

  insert into public.intel_jobs(organization_id, kind, payload, idempotency_key, priority)
  values (v_org, 'classify', jsonb_build_object('message_id', v_id), 'classify:resend:' || p_provider_message_id, 5)
  on conflict (organization_id, idempotency_key) do nothing;
  return jsonb_build_object('duplicate', false, 'message_id', v_id, 'prospect_id', v_prospect, 'matched', true);
exception when unique_violation then
  select id into v_id from public.intel_messages where organization_id = v_org and
    (provider_message_id = p_provider_message_id or zoho_message_id = p_provider_message_id or rfc_message_id = nullif(p_rfc_message_id, '')) limit 1;
  return jsonb_build_object('duplicate', true, 'message_id', v_id);
end $$;

revoke all on function public.intel_resend_record_inbound(text,text,text,text,text,text,text,timestamptz,text) from public, anon, authenticated;
grant execute on function public.intel_resend_record_inbound(text,text,text,text,text,text,text,timestamptz,text) to service_role;
revoke all on function public.intel_agent_resend_send_context(uuid) from public, anon;
revoke all on function public.intel_agent_record_resend_acceptance(uuid,text) from public, anon;
revoke all on function public.intel_agent_resend_verify_context(uuid,text) from public, anon;
grant execute on function public.intel_agent_resend_send_context(uuid) to authenticated;
grant execute on function public.intel_agent_record_resend_acceptance(uuid,text) to authenticated;
grant execute on function public.intel_agent_resend_verify_context(uuid,text) to authenticated;

commit;
