-- Indie campaign end-to-end audit fixes: subdomain suppression and final-send guard.
-- Additive, forward-only. Apply to staging first; do not deploy automatically.
begin;

create or replace function public._intel_indie_domain_matches(p_host text, p_blocked_domain text)
returns boolean
language sql immutable
set search_path = pg_catalog, public
as $$
  select case
    when public._intel_indie_domain(p_host) = '' or public._intel_indie_domain(p_blocked_domain) = '' then false
    else public._intel_indie_domain(p_host) = public._intel_indie_domain(p_blocked_domain)
      or public._intel_indie_domain(p_host) like '%.' || public._intel_indie_domain(p_blocked_domain)
  end
$$;

-- Keep the worker's suppression lookup consistent with the contact-verification
-- RPC and include both recipient and prospect domains.
create or replace function public.intel_agent_indie_suppression_facts(p_email text default '', p_domain text default '')
returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.intel_agent_org();
  v_email text := public.intel_norm_email(p_email);
  v_email_domain text := split_part(v_email, '@', 2);
  v_domain text := public._intel_indie_domain(p_domain);
  v_bounced boolean;
  v_complained boolean;
  v_suppressed boolean;
  v_reason text;
begin
  select coalesce(bool_or(lower(reason) like '%bounce%'), false),
         coalesce(bool_or(lower(reason) like '%complaint%'), false),
         coalesce(bool_or(true), false),
         string_agg(distinct nullif(reason, ''), '; ')
    into v_bounced, v_complained, v_suppressed, v_reason
    from public.intel_suppressions s
   where s.organization_id = v_org
     and ((s.kind = 'email' and s.value = v_email and v_email <> '')
       or (s.kind = 'domain' and (public._intel_indie_domain_matches(v_domain, s.value)
         or public._intel_indie_domain_matches(v_email_domain, s.value))));
  return jsonb_build_object('bounced', v_bounced, 'complained', v_complained,
    'suppressed', v_suppressed, 'suppression_reason', coalesce(v_reason, ''));
end $$;

-- Last-resort database guard. The Phase 8 mark_sending RPC remains the primary
-- gate; this trigger prevents an Indie message from entering reserved/sending if
-- a parent-domain suppression (e.g. example.com for mail.example.com) exists.
create or replace function public._intel_indie_subdomain_send_guard()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_org uuid := new.organization_id;
  v_email text := public.intel_norm_email(new.to_email);
  v_email_domain text := split_part(v_email, '@', 2);
  v_prospect_domain text := '';
  v_labels text[];
  v_suffix text;
  i integer;
begin
  if new.state not in ('reserved', 'sending') or new.prospect_id is null then return new; end if;
  if not exists (select 1 from public.intel_prospects p
    where p.id = new.prospect_id and p.organization_id = v_org and p.type = 'indie_game_developer') then
    return new;
  end if;
  select public._intel_indie_domain(p.domain) into v_prospect_domain
    from public.intel_prospects p where p.id = new.prospect_id and p.organization_id = v_org;

  -- Acquire the same policy-key locks used by suppression mutations for every
  -- parent suffix. This closes the race for a suppression inserted mid-send.
  v_labels := string_to_array(v_email_domain, '.');
  if coalesce(array_length(v_labels, 1), 0) >= 2 then
    for i in 1..array_length(v_labels, 1) - 1 loop
      v_suffix := array_to_string(v_labels[i:array_length(v_labels, 1)], '.');
      perform pg_advisory_xact_lock(hashtextextended(v_org::text || ':suppression:domain:' || v_suffix, 0));
    end loop;
  end if;
  if exists (select 1 from public.intel_suppressions s
      where s.organization_id = v_org
        and ((s.kind = 'email' and s.value = v_email)
          or (s.kind = 'domain' and (public._intel_indie_domain_matches(v_email_domain, s.value)
            or public._intel_indie_domain_matches(v_prospect_domain, s.value))))) then
    raise exception 'Indie campaign send blocked by email or parent-domain suppression';
  end if;
  return new;
end $$;
revoke all on function public._intel_indie_subdomain_send_guard() from public, anon, authenticated;
drop trigger if exists intel_indie_subdomain_send_guard on public.intel_messages;
create trigger intel_indie_subdomain_send_guard
before update of state on public.intel_messages
for each row when (new.state in ('reserved', 'sending'))
execute function public._intel_indie_subdomain_send_guard();

revoke all on function public._intel_indie_domain_matches(text,text) from public, anon, authenticated;
revoke all on function public.intel_agent_indie_suppression_facts(text,text) from public, anon;
grant execute on function public.intel_agent_indie_suppression_facts(text,text) to authenticated;

notify pgrst, 'reload schema';
commit;
