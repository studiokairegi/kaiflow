-- Studio Time fixes (additive; safe to re-run).
-- 1) studio_server_time(): lets the client correct for a wrong device clock when showing elapsed time.
create or replace function public.studio_server_time()
returns timestamptz
language sql
stable
security invoker
set search_path = public
as $$ select now() $$;
revoke execute on function public.studio_server_time() from public;
grant execute on function public.studio_server_time() to authenticated;

-- 2) clock_out_active_session_at(p_at): closes the caller's active session at a given moment (used when a
--    focus round ended while the app was closed, so the session is not left running past its planned end).
--    The moment is clamped to [clock_in, now()], so it can never lengthen a session or predate it.
create or replace function public.clock_out_active_session_at(p_at timestamptz)
returns work_sessions
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_session work_sessions%rowtype;
begin
  update work_sessions
    set clock_out = least(greatest(p_at, clock_in), now()),
        duration = extract(epoch from (least(greatest(p_at, clock_in), now()) - clock_in))::integer
    where user_id = auth.uid() and clock_out is null
    returning * into v_session;
  if not found then
    raise exception 'No active session to clock out';
  end if;
  return v_session;
end;
$$;
revoke execute on function public.clock_out_active_session_at(timestamptz) from public;
grant execute on function public.clock_out_active_session_at(timestamptz) to authenticated;
