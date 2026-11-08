-- Explicit chat-created drafts must remain pending even if global autonomy is autonomous.
-- Existing scheduled/campaign workflows retain their prior behavior by default.
begin;
drop function if exists public.intel_agent_upsert_draft(uuid,text,integer,text,text,text,text,boolean,text,text);
create or replace function public.intel_agent_upsert_draft(
  p_prospect_id uuid, p_kind text, p_step int, p_subject text, p_body text, p_idempotency_key text, p_to_email text, p_auto_ok boolean default false,
  p_in_reply_to text default null, p_references text default null, p_force_review boolean default false)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org(); s public.intel_settings; p public.intel_prospects; v_state text; v_id uuid; v_to text := public.intel_norm_email(p_to_email);
begin
  select * into s from public.intel_settings where organization_id = v_org;
  select * into p from public.intel_prospects where id = p_prospect_id and organization_id = v_org;
  if not found then raise exception 'prospect not found'; end if;
  if p_kind not in ('initial','followup','reply') then raise exception 'bad kind'; end if;
  if p.status in ('suppressed','rejected','closed') then return public._intel_deny('prospect_not_contactable'); end if;
  if not (v_to = public.intel_norm_email(p.contact_email)
          or (p_kind = 'reply' and exists (select 1 from public.intel_messages i where i.prospect_id = p.id and i.direction = 'inbound' and public.intel_norm_email(i.from_email) = v_to))) then
    return public._intel_deny('recipient_not_allowed');
  end if;
  if v_to = '' then return public._intel_deny('no_recipient'); end if;
  v_state := case
    when coalesce(p_force_review, false) then 'pending_approval'
    when p.origin = 'crm_existing' then 'pending_approval'
    when s.autonomy = 'autonomous' and (p_kind <> 'reply' or p_auto_ok) then 'approved'
    when s.autonomy = 'assisted' and p_kind = 'followup' then 'approved'
    when s.autonomy = 'assisted' and p_kind = 'reply' and p_auto_ok then 'approved'
    else 'pending_approval' end;
  insert into public.intel_messages(organization_id, prospect_id, lead_id, campaign_type, direction, kind, step, state, to_email, from_email, subject, body_text,
                                    idempotency_key, auto_sent, in_reply_to, references_ids)
  values (v_org, p.id, p.lead_id, p.type, 'outbound', p_kind, coalesce(p_step, 0), v_state, v_to, s.sender_email, left(p_subject, 300), left(p_body, 20000),
          left(p_idempotency_key, 200), v_state = 'approved', left(p_in_reply_to, 998), left(p_references, 4000))
  on conflict (organization_id, idempotency_key) do nothing returning id into v_id;
  if v_id is null then
    select id, state into v_id, v_state from public.intel_messages where organization_id = v_org and idempotency_key = left(p_idempotency_key, 200);
    return jsonb_build_object('ok', true, 'message_id', v_id, 'created', false, 'state', v_state);
  end if;
  perform public._intel_log(v_org, 'agent', 'draft_' || p_kind, 'message', v_id::text, jsonb_build_object('state', v_state, 'origin', p.origin));
  return jsonb_build_object('ok', true, 'message_id', v_id, 'created', true, 'state', v_state);
exception when unique_violation then
  return public._intel_deny('already_introduced');
end $$;
revoke all on function public.intel_agent_upsert_draft(uuid,text,int,text,text,text,text,boolean,text,text,boolean) from public, anon;
grant execute on function public.intel_agent_upsert_draft(uuid,text,int,text,text,text,text,boolean,text,text,boolean) to authenticated;
commit;

-- Refresh PostgREST's function signature cache so the worker can pass p_force_review immediately.
notify pgrst, 'reload schema';
