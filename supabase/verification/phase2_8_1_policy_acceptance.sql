-- Read-only acceptance checks for the Phase 2.8.1 provider-policy hardening.
do $$
declare
  v_manifest jsonb;
  v_assign text;
  v_send text;
  v_review text;
begin
  select manifest into v_manifest from public.intel_email_provider_registry where provider_key='zoho';
  if v_manifest is null or not (coalesce(v_manifest->'message_purposes','[]'::jsonb) ? 'consented_prospecting') then
    raise exception 'Zoho prospecting purpose is not registered for the human-review path';
  end if;
  v_assign := pg_get_functiondef('public.intel_agent_assign_provider_account(uuid)'::regprocedure);
  if position('message_purposes' in v_assign)=0 then raise exception 'provider purpose intersection missing from assignment gate'; end if;
  v_send := pg_get_functiondef('public.intel_agent_mark_sending(uuid)'::regprocedure);
  if position('Zoho outreach requires explicit human approval' in v_send)=0 then raise exception 'Zoho human-approval gate missing'; end if;
  v_review := pg_get_functiondef('public.intel_admin_review_message(uuid,text,text,text)'::regprocedure);
  if position('manual-approve-send:' in v_review)=0 then raise exception 'human approval does not enqueue a send attempt'; end if;
  if exists(select 1 from public.intel_provider_accounts where provider_key='zoho' and send_enabled=true) then
    raise exception 'Zoho account sending unexpectedly enabled during acceptance';
  end if;
end $$;
