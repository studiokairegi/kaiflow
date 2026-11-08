-- Phase 12: worker reliability, safe recovery, send-window deferral and RFC threading.
-- Additive/replace-only. No worker is started and no queue rows are modified by this migration.

create index if not exists intel_jobs_expired_lease_idx
  on public.intel_jobs (organization_id, lease_until)
  where state = 'running' and lease_until is not null;

create or replace function public.intel_agent_claim_job(
  p_worker_id text, p_kinds text[] default null, p_lease_seconds int default 300)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org(); v_job public.intel_jobs;
begin
  -- Expired leases are recovered atomically. Preserve a bounded diagnostic so an
  -- operator can distinguish a crash/lease expiry from an ordinary handler error.
  update public.intel_jobs
     set state = case when attempts >= max_attempts then 'dead' else 'queued' end,
         locked_by = null, lease_until = null,
         last_error = left(concat_ws(' | ', nullif(last_error,''),
           'lease expired at ' || now()::text || ' (previous owner ' || coalesce(locked_by,'unknown') || ')'), 1000),
         updated_at = now(),
         finished_at = case when attempts >= max_attempts then now() else null end
   where organization_id = v_org and state = 'running'
     and lease_until is not null and lease_until <= now();

  select * into v_job from public.intel_jobs
   where organization_id = v_org and state = 'queued' and run_after <= now()
     and (p_kinds is null or kind = any (p_kinds))
   order by priority desc, run_after, created_at
   limit 1 for update skip locked;
  if not found then return null; end if;

  update public.intel_jobs
     set state = 'running', attempts = attempts + 1,
         locked_by = left(p_worker_id, 80),
         lease_until = now() + make_interval(secs => greatest(30, least(p_lease_seconds, 3600))),
         updated_at = now(), finished_at = null
   where id = v_job.id returning * into v_job;
  return to_jsonb(v_job);
end $$;


-- Do not repeatedly enqueue initial/follow-up sends while the studio is outside
-- its local send window. The final send boundary still rechecks immediately before
-- provider submission; replies remain eligible at any time.
create or replace function public.intel_agent_approved_outbound(p_limit int default 10) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', m.id, 'kind', m.kind, 'state', m.state) order by m.created_at)
      from (
        select msg.* from public.intel_messages msg
        join public.intel_settings s on s.organization_id = msg.organization_id
       where msg.organization_id = v_org and msg.direction = 'outbound'
         and msg.state in ('approved','reserved')
         and (msg.kind not in ('initial','followup') or (
           extract(hour from (now() at time zone s.timezone)) >= s.send_start_hour
           and extract(hour from (now() at time zone s.timezone)) < s.send_end_hour
           and (not s.send_weekdays_only or extract(isodow from (now() at time zone s.timezone)) <= 5)
         ))
       order by msg.created_at
       limit greatest(1, least(p_limit, 50))
      ) m
  ), '[]'::jsonb);
end $$;

create or replace function public.intel_agent_send_window_status(p_message_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.intel_agent_org();
  v_kind text;
  v_timezone text;
  v_start int;
  v_end int;
  v_weekdays boolean;
  v_local timestamp;
  v_next timestamptz;
begin
  select m.kind, s.timezone, s.send_start_hour, s.send_end_hour, s.send_weekdays_only
    into v_kind, v_timezone, v_start, v_end, v_weekdays
    from public.intel_messages m
    join public.intel_settings s on s.organization_id = m.organization_id
   where m.id = p_message_id and m.organization_id = v_org;
  if not found then return jsonb_build_object('allowed', false, 'reason', 'message_not_found'); end if;
  if v_kind not in ('initial','followup') then
    return jsonb_build_object('allowed', true, 'reason', 'not_window_limited');
  end if;

  v_local := now() at time zone v_timezone;
  if extract(hour from v_local) >= v_start
     and extract(hour from v_local) < v_end
     and (not v_weekdays or extract(isodow from v_local) <= 5) then
    return jsonb_build_object('allowed', true, 'reason', 'inside_send_window');
  end if;

  select timezone(v_timezone, (candidate_day::timestamp + make_interval(hours => v_start)))
    into v_next
    from generate_series(v_local::date, v_local::date + 8, interval '1 day') as days(candidate_day)
   where (not v_weekdays or extract(isodow from candidate_day) <= 5)
     and (candidate_day::timestamp + make_interval(hours => v_start)) > v_local
   order by candidate_day
   limit 1;
  return jsonb_build_object('allowed', false, 'reason', 'outside_send_window', 'next_open_at', v_next);
end $$;

-- Rebuild inbound association with tokenized RFC Message-ID matching. In-Reply-To
-- is preferred to References; both require sender-address agreement with the
-- original outbound recipient to prevent forged headers cross-linking prospects.
create or replace function public.intel_agent_record_inbound(
  p_zoho_message_id text, p_rfc_message_id text, p_in_reply_to text, p_references text, p_from_email text,
  p_subject text, p_body_text text, p_received_at timestamptz, p_thread_id text, p_token text)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.intel_agent_org();
  v_from text := public.intel_norm_email(p_from_email);
  v_prospect uuid;
  v_lead uuid;
  v_type text;
  v_id uuid;
  v_ids text[];
  p public.intel_prospects;
begin
  if coalesce(p_zoho_message_id,'') = '' then raise exception 'provider message id required'; end if;
  select id into v_id from public.intel_messages
   where organization_id = v_org and zoho_message_id = p_zoho_message_id;
  if v_id is not null then return jsonb_build_object('message_id',v_id,'duplicate',true); end if;

  -- Token association remains the strongest match, but the sender must still be
  -- the address we originally contacted.
  if coalesce(p_token,'') <> '' then
    select m.prospect_id into v_prospect
      from public.intel_messages m
     where m.organization_id = v_org and m.direction = 'outbound'
       and m.token = p_token
       and public.intel_norm_email(m.to_email) = v_from
     order by m.created_at desc limit 1;
  end if;

  -- Exact In-Reply-To Message-ID match first. If a header contains multiple
  -- identifiers, prefer its last identifier in header order.
  if v_prospect is null and coalesce(p_in_reply_to,'') <> '' then
    select coalesce(array_agg(ids[1]), array[]::text[]) into v_ids
      from regexp_matches(p_in_reply_to, '<[^<>[:space:]]{3,998}>', 'g') as captures(ids);
    if cardinality(v_ids) > 0 then
      select m.prospect_id into v_prospect
        from public.intel_messages m
       where m.organization_id = v_org and m.direction = 'outbound'
         and m.rfc_message_id = any (v_ids)
         and public.intel_norm_email(m.to_email) = v_from
       order by array_position(v_ids, m.rfc_message_id) desc, m.sent_at desc nulls last, m.created_at desc
       limit 1;
    end if;
  end if;

  -- If In-Reply-To is absent/unmatched, use the newest matching ID in References order.
  if v_prospect is null and coalesce(p_references,'') <> '' then
    select coalesce(array_agg(ids[1]), array[]::text[]) into v_ids
      from regexp_matches(p_references, '<[^<>[:space:]]{3,998}>', 'g') as captures(ids);
    if cardinality(v_ids) > 0 then
      select m.prospect_id into v_prospect
        from public.intel_messages m
       where m.organization_id = v_org and m.direction = 'outbound'
         and m.rfc_message_id = any (v_ids)
         and public.intel_norm_email(m.to_email) = v_from
       order by array_position(v_ids, m.rfc_message_id) desc, m.sent_at desc nulls last, m.created_at desc
       limit 1;
    end if;
  end if;

  -- Legacy compatibility: exact contact address only when exactly one prospect
  -- with prior outbound history uses that address; ambiguity stays unmatched.
  if v_prospect is null and v_from <> '' then
    select p0.id into v_prospect from public.intel_prospects p0
     where p0.organization_id = v_org and public.intel_norm_email(p0.contact_email) = v_from
       and exists (select 1 from public.intel_messages m where m.prospect_id = p0.id
                    and m.direction = 'outbound' and m.state in ('sent','unknown'))
       and not exists (
         select 1 from public.intel_prospects p1
          where p1.organization_id = v_org and p1.id <> p0.id
            and public.intel_norm_email(p1.contact_email) = v_from
            and exists (select 1 from public.intel_messages m1 where m1.prospect_id = p1.id
                         and m1.direction = 'outbound' and m1.state in ('sent','unknown'))
       )
     limit 1;
  end if;

  if v_prospect is not null then
    select * into p from public.intel_prospects
     where id = v_prospect and organization_id = v_org for update;
    if found then v_lead := p.lead_id; v_type := p.type; else v_prospect := null; end if;
  end if;

  insert into public.intel_messages(organization_id,prospect_id,lead_id,campaign_type,direction,kind,state,to_email,from_email,subject,body_text,
                                    idempotency_key,rfc_message_id,in_reply_to,references_ids,zoho_message_id,zoho_thread_id,received_at)
  values(v_org,v_prospect,v_lead,v_type,'inbound','inbound','received','',v_from,left(coalesce(p_subject,''),300),left(coalesce(p_body_text,''),20000),
         'in:' || p_zoho_message_id,nullif(p_rfc_message_id,''),nullif(p_in_reply_to,''),nullif(p_references,''),p_zoho_message_id,nullif(p_thread_id,''),coalesce(p_received_at,now()))
  returning id into v_id;
  return jsonb_build_object('message_id',v_id,'duplicate',false,'prospect_id',v_prospect,'matched',v_prospect is not null);
exception when unique_violation then
  select id into v_id from public.intel_messages where organization_id = v_org
   and (zoho_message_id = p_zoho_message_id or (p_rfc_message_id is not null and rfc_message_id = p_rfc_message_id));
  return jsonb_build_object('message_id',v_id,'duplicate',true);
end $$;

create or replace function public.intel_admin_overview() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org(); s public.intel_settings; v_today date; v jsonb;
begin
  select * into s from public.intel_settings where organization_id = v_org;
  if not found then return jsonb_build_object('configured', false); end if;
  v_today := public._intel_today(v_org);
  select jsonb_build_object(
    'configured', true, 'kill_switch', s.kill_switch, 'autonomy', s.autonomy, 'today', v_today,
    'initial_cap', public._intel_effective_initial_cap(v_org), 'initial_cap_configured', s.daily_initial_cap,
    'followup_cap', s.daily_followup_cap,
    'initial_sent_today', (select count(*) from public.intel_messages where organization_id = v_org and kind = 'initial' and send_day = v_today and state in ('reserved','sending','sent','unknown')),
    'followup_sent_today', (select count(*) from public.intel_messages where organization_id = v_org and kind = 'followup' and send_day = v_today and state in ('reserved','sending','sent','unknown')),
    'prospects_by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from public.intel_prospects where organization_id = v_org group by status) x), '{}'::jsonb),
    'prospects_by_type', coalesce((select jsonb_object_agg(type, n) from (select type, count(*) n from public.intel_prospects where organization_id = v_org group by type) x), '{}'::jsonb),
    'pending_approval', (select count(*) from public.intel_messages where organization_id = v_org and state = 'pending_approval'),
    'unknown_sends', (select count(*) from public.intel_messages where organization_id = v_org and state = 'unknown'),
    'dead_jobs', (select count(*) from public.intel_jobs where organization_id = v_org and state = 'dead'),
    'failed_jobs', (select count(*) from public.intel_jobs where organization_id = v_org and state = 'failed'),
    'queued_jobs', (select count(*) from public.intel_jobs where organization_id = v_org and state in ('queued','running')),
    'running_jobs', (select count(*) from public.intel_jobs where organization_id = v_org and state = 'running'),
    'ready_jobs', (select count(*) from public.intel_jobs where organization_id = v_org and state = 'queued' and run_after <= now()),
    'scheduled_jobs', (select count(*) from public.intel_jobs where organization_id = v_org and state = 'queued' and run_after > now()),
    'expired_leases', (select count(*) from public.intel_jobs where organization_id = v_org and state = 'running' and lease_until <= now()),
    'oldest_queued_seconds', (select extract(epoch from (now() - min(created_at)))::int from public.intel_jobs where organization_id = v_org and state = 'queued' and run_after <= now()),
    'worker_id', (select h.worker_id from public.intel_worker_heartbeat h where h.organization_id = v_org),
    'worker_info', coalesce((select h.info from public.intel_worker_heartbeat h where h.organization_id = v_org), '{}'::jsonb),
    'worker_last_seen_seconds', (select extract(epoch from (now() - h.last_seen))::int from public.intel_worker_heartbeat h where h.organization_id = v_org),
    'agent_registered', s.agent_user_id is not null
  ) into v;
  return v;
end $$;

create or replace function public.intel_admin_requeue_job(p_job_id uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org(); v_kind text; v_state text; v_attempts int;
begin
  select kind, state, attempts into v_kind, v_state, v_attempts
    from public.intel_jobs where id = p_job_id and organization_id = v_org for update;
  if not found then return jsonb_build_object('ok',false,'reason','not_found'); end if;
  if v_state not in ('dead','failed') then return jsonb_build_object('ok',false,'reason','not_recoverable','state',v_state); end if;
  update public.intel_jobs set state = 'queued', attempts = 0, run_after = now(), locked_by = null,
    lease_until = null, finished_at = null, result = null,
    last_error = left(coalesce(last_error,'') || ' [manually requeued from ' || v_state || ' after ' || v_attempts || ' attempts]',1000),
    updated_at = now() where id = p_job_id and organization_id = v_org;
  perform public._intel_log(v_org, 'admin', 'requeue_job', 'job', p_job_id::text,
    jsonb_build_object('kind',v_kind,'previous_state',v_state,'previous_attempts',v_attempts));
  return jsonb_build_object('ok',true,'state','queued','kind',v_kind);
end $$;

revoke all on function public.intel_agent_send_window_status(uuid) from public, anon;
grant execute on function public.intel_agent_send_window_status(uuid) to authenticated;
revoke all on function public.intel_admin_requeue_job(uuid) from public, anon;
grant execute on function public.intel_admin_requeue_job(uuid) to authenticated;
revoke all on function public.intel_agent_record_inbound(text,text,text,text,text,text,text,timestamptz,text,text) from public, anon;
grant execute on function public.intel_agent_record_inbound(text,text,text,text,text,text,text,timestamptz,text,text) to authenticated;
