-- Resend-only deployments do not create a legacy Zoho/Gmail mailbox row.
-- Preserve the emergency kill switch and agent/compliance checks while allowing
-- the Resend Edge Function to be the authoritative provider-configuration gate.
begin;

create or replace function public.intel_admin_set_kill_switch(p_on boolean) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org(); s public.intel_settings;
begin
  select * into s from public.intel_settings where organization_id = v_org for update;
  if not found then raise exception 'Run setup first (intel_admin_bootstrap)'; end if;
  if p_on is false then
    if btrim(coalesce(s.sender_email, '')) = '' or btrim(coalesce(s.physical_address, '')) = '' or btrim(coalesce(s.opt_out_text, '')) = '' then
      raise exception 'Set sender email, physical address and opt-out text before enabling sending';
    end if;
    if s.agent_user_id is null then raise exception 'Register the agent identity before enabling sending'; end if;
    -- If a legacy mailbox is connected it remains valid. If none is connected,
    -- the Resend send Edge Function must still validate RESEND_API_KEY at send time.
  end if;
  update public.intel_settings
     set kill_switch = p_on,
         warmup_started_on = case when p_on is false and warmup_started_on is null then public._intel_today(v_org) else warmup_started_on end,
         updated_at = now(), updated_by = auth.uid()
   where organization_id = v_org;
  perform public._intel_log(v_org, 'admin', case when p_on then 'kill_switch_on' else 'kill_switch_off' end, 'settings', v_org::text, '{}'::jsonb);
  return jsonb_build_object('kill_switch', p_on);
end $$;

revoke all on function public.intel_admin_set_kill_switch(boolean) from public, anon;
grant execute on function public.intel_admin_set_kill_switch(boolean) to authenticated;
commit;
