-- Phase 2 follow-up: enforce send-slot ownership and eliminate transaction-time expiry drift.
-- Forward-only corrective migration; do not edit previously deployed migrations.
begin;

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
  select * into s from public.intel_settings
   where organization_id = v_org for update;
  if not found then return public._intel_deny('not_configured'); end if;

  select * into m from public.intel_messages
   where id = p_message_id and organization_id = v_org for update;
  if not found then return public._intel_deny('not_found'); end if;
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

  if s.send_slot_message_id = p_message_id
     and s.send_slot_until > clock_timestamp() then
    return jsonb_build_object('ok', true, 'resumed', true);
  end if;

  if s.send_slot_until > clock_timestamp() then
    v_retry_seconds := greatest(1, ceil(extract(epoch from (s.send_slot_until - clock_timestamp())))::int);
    return jsonb_build_object('ok', false, 'reason', 'send_spacing', 'retry_after', v_retry_seconds);
  end if;

  v_gap_seconds := 45 + floor(random() * 76)::int;
  update public.intel_settings
     set send_slot_until = clock_timestamp() + make_interval(secs => v_gap_seconds),
         send_slot_message_id = p_message_id
   where organization_id = v_org;

  perform public._intel_log(v_org, 'agent', 'send_slot_acquired', 'message', p_message_id::text,
                            jsonb_build_object('gap_seconds', v_gap_seconds));
  return jsonb_build_object('ok', true, 'resumed', false, 'gap_seconds', v_gap_seconds);
end;
$$;

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
  select * into s from public.intel_settings
   where organization_id = v_org for update;
  if not found then return false; end if;

  select * into m from public.intel_messages
   where id = p_message_id and organization_id = v_org for update;
  if not found or m.state <> 'reserved' then return false; end if;

  if s.kill_switch then
    update public.intel_messages
       set state = 'approved', send_day = null, reserved_at = null,
           error = 'emergency stop enabled before provider send'
     where id = m.id and state = 'reserved';
    update public.intel_settings
       set send_slot_message_id = null, send_slot_until = null
     where organization_id = v_org and send_slot_message_id = p_message_id;
    return false;
  end if;

  if s.send_slot_message_id = p_message_id
     and (s.send_slot_until is null or s.send_slot_until <= clock_timestamp()) then
    -- The slot expired before the final transition. Release the reservation
    -- rather than leaving a message stranded in `reserved`; it requires a fresh
    -- approval/send attempt and a newly acquired slot.
    update public.intel_messages
       set state = 'approved', send_day = null, reserved_at = null,
           error = 'send slot expired before provider submission'
     where id = m.id and state = 'reserved';
    update public.intel_settings
       set send_slot_message_id = null, send_slot_until = null
     where organization_id = v_org and send_slot_message_id = p_message_id;
    return false;
  end if;

  if s.send_slot_message_id is distinct from p_message_id
     or s.send_slot_until is null
     or s.send_slot_until <= clock_timestamp() then
    return false;
  end if;

  update public.intel_messages
     set state = 'sending'
   where id = m.id and organization_id = v_org and state = 'reserved';
  return found;
end;
$$;

revoke all on function public.intel_agent_acquire_send_slot(uuid) from public, anon;
grant execute on function public.intel_agent_acquire_send_slot(uuid) to authenticated;
revoke all on function public.intel_agent_mark_sending(uuid) from public, anon;
grant execute on function public.intel_agent_mark_sending(uuid) to authenticated;

commit;
