-- Phase 2 production hardening: enforce studio-wide spacing across all worker processes.
-- The intel_settings row is the serialization point already used by reserve_send.
-- A per-message id makes slot acquisition idempotent across safe job retries.
begin;

alter table public.intel_settings
  add column if not exists send_slot_until timestamptz,
  add column if not exists send_slot_message_id uuid;

create or replace function public.intel_agent_acquire_send_slot(p_message_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org uuid := public.intel_agent_org();
  s public.intel_settings;
  m public.intel_messages;
  v_gap_seconds int;
  v_retry_seconds int;
begin
  -- Lock the same organization row used by reserve_send: this serializes all
  -- workers for a studio, not merely jobs inside one Python process.
  select * into s
    from public.intel_settings
   where organization_id = v_org
   for update;
  if not found then
    return public._intel_deny('not_configured');
  end if;

  select * into m
    from public.intel_messages
   where id = p_message_id
     and organization_id = v_org
   for update;
  if not found then
    return public._intel_deny('not_found');
  end if;
  if m.direction <> 'outbound' or m.state <> 'reserved' then
    return public._intel_deny('not_reserved');
  end if;
  if s.kill_switch then
    update public.intel_messages
       set state = 'approved', send_day = null, reserved_at = null,
           error = 'emergency stop enabled before provider send'
     where id = m.id and state = 'reserved';
    update public.intel_settings
       set send_slot_message_id = null, send_slot_until = null
     where organization_id = v_org and send_slot_message_id = p_message_id;
    return public._intel_deny('kill_switch');
  end if;

  -- If this exact message already owns the slot, a retry may continue without
  -- consuming another slot. A later message may replace ownership after the gap.
  if s.send_slot_message_id = p_message_id and s.send_slot_until > now() then
    return jsonb_build_object('ok', true, 'resumed', true);
  end if;

  if s.send_slot_until is not null and s.send_slot_until > now() then
    v_retry_seconds := greatest(1, ceil(extract(epoch from (s.send_slot_until - now())))::int);
    return jsonb_build_object('ok', false, 'reason', 'send_spacing', 'retry_after', v_retry_seconds);
  end if;

  -- Randomized 45–120 second interval. The interval is written atomically while
  -- holding the organization row lock, so concurrent workers cannot burst-send.
  v_gap_seconds := 45 + floor(random() * 76)::int;
  update public.intel_settings
     set send_slot_until = now() + make_interval(secs => v_gap_seconds),
         send_slot_message_id = p_message_id
   where organization_id = v_org;

  perform public._intel_log(v_org, 'agent', 'send_slot_acquired', 'message', p_message_id::text,
                            jsonb_build_object('gap_seconds', v_gap_seconds));
  return jsonb_build_object('ok', true, 'resumed', false, 'gap_seconds', v_gap_seconds);
end;
$$;

revoke all on function public.intel_agent_acquire_send_slot(uuid) from public, anon;
grant execute on function public.intel_agent_acquire_send_slot(uuid) to authenticated;

-- Recheck the emergency stop under the settings-row lock immediately before
-- transitioning a reserved message into the provider-call state. A message
-- released by this guard returns to approved and can be picked up after restart.
create or replace function public.intel_agent_mark_sending(p_message_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org uuid := public.intel_agent_org();
  s public.intel_settings;
  m public.intel_messages;
begin
  select * into s
    from public.intel_settings
   where organization_id = v_org
   for update;
  if not found then return false; end if;

  select * into m
    from public.intel_messages
   where id = p_message_id and organization_id = v_org
   for update;
  if not found or m.state <> 'reserved' then return false; end if;

  if s.kill_switch then
    update public.intel_messages
       set state = 'approved', send_day = null, reserved_at = null,
           error = 'emergency stop enabled before provider send'
     where id = m.id and state = 'reserved';
    update public.intel_settings
       set send_slot_message_id = null
     where organization_id = v_org and send_slot_message_id = p_message_id;
    return false;
  end if;

  update public.intel_messages
     set state = 'sending'
   where id = m.id and organization_id = v_org and state = 'reserved';
  return found;
end;
$$;

revoke all on function public.intel_agent_mark_sending(uuid) from public, anon;
grant execute on function public.intel_agent_mark_sending(uuid) to authenticated;

-- Persisted organization-wide outbound history for duplicate/near-duplicate checks.
-- Return only the fields needed by the worker; do not expose recipient addresses.
create or replace function public.intel_agent_recent_outbound(p_limit int default 500)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org uuid := public.intel_agent_org();
  v_limit int := greatest(1, least(coalesce(p_limit, 500), 500));
begin
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.created_at desc)
      from (
        select id, prospect_id, kind, state, subject, body_text, created_at
          from public.intel_messages
         where organization_id = v_org
           and direction = 'outbound'
           and state in ('draft','pending_approval','approved','reserved','sending','sent','unknown')
           and created_at >= now() - interval '180 days'
         order by created_at desc
         limit v_limit
      ) x
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.intel_agent_recent_outbound(int) from public, anon;
grant execute on function public.intel_agent_recent_outbound(int) to authenticated;

commit;
