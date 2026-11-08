-- Phase 11 corrective hardening: serialize each sliding-window bucket.
-- Each RPC runs in its own transaction; the xact advisory lock is held until
-- the count/decision/insert has committed, so concurrent calls for the same
-- (scope, subject) cannot all pass against the same stale count.
begin;

create or replace function public.portal_rate_limit(
  p_scope text, p_subject_hash text, p_limit integer, p_window_seconds integer
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_count integer;
  v_lock_key bigint;
begin
  if p_scope is null or char_length(p_scope) < 1 or char_length(p_scope) > 60
     or p_subject_hash is null or char_length(p_subject_hash) < 1 or char_length(p_subject_hash) > 128
     or p_limit is null or p_limit < 1
     or p_window_seconds is null or p_window_seconds < 1 then
    return false;
  end if;

  -- A 64-bit hash maps the bucket identity to a transaction-scoped advisory lock.
  -- Hash collisions can only serialize unrelated buckets; they cannot bypass limits.
  v_lock_key := hashtextextended('portal_rate_limit:' || p_scope || ':' || p_subject_hash, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  if random() < 0.02 then
    delete from public.portal_access_events where created_at < now() - interval '2 days';
  end if;

  select count(*) into v_count
    from public.portal_access_events e
   where e.scope = p_scope
     and e.subject_hash = p_subject_hash
     and e.created_at > now() - make_interval(secs => p_window_seconds);

  if v_count >= p_limit then
    return false;
  end if;

  insert into public.portal_access_events(scope, subject_hash)
  values (p_scope, p_subject_hash);
  return true;
end;
$$;

revoke all on function public.portal_rate_limit(text,text,integer,integer) from public, anon, authenticated;
grant execute on function public.portal_rate_limit(text,text,integer,integer) to service_role;

commit;
