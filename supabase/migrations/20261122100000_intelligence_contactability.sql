begin;

-- Contactability reads existing suppression facts; it never probes mailboxes or mutates suppression state.
create or replace function public.intel_agent_contactability_facts(p_email text default '', p_domain text default '')
returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.intel_agent_org();
  v_email text := public.intel_norm_email(p_email);
  v_domain text := lower(btrim(coalesce(p_domain, '')));
  v_bounced boolean;
  v_complained boolean;
begin
  select
    coalesce(bool_or(lower(reason) like '%bounce%'), false),
    coalesce(bool_or(lower(reason) like '%complaint%'), false)
  into v_bounced, v_complained
  from public.intel_suppressions
  where organization_id = v_org
    and ((kind = 'email' and value = v_email and v_email <> '')
      or (kind = 'domain' and value = v_domain and v_domain <> ''));

  return jsonb_build_object('bounced', v_bounced, 'complained', v_complained);
end $$;

revoke all on function public.intel_agent_contactability_facts(text, text) from public, anon;
grant execute on function public.intel_agent_contactability_facts(text, text) to authenticated;

commit;
