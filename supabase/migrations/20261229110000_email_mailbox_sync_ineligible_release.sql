-- Round 7.1: losing eligibility is not a provider synchronization failure.
-- Additive. Adds one service-only function; no existing function body is replaced.
-- When renewal, checkpoint commit or finish discovers that the account is no longer eligible,
-- the worker stops provider work and releases its lease through this path. The release:
--   * never increments consecutive_failures,
--   * never sets or changes next_retry_at,
--   * never rewrites last_error, cursor, last_success_at or last_attempt_at,
--   * only acts when the account is ineligible RIGHT NOW and the caller still holds the token.
-- If the account is eligible, the function changes nothing and returns false so the caller can
-- treat the problem as a genuine failure or lease expiry and use email_fail_sync.
-- Rollback: drop function public.email_release_sync_ineligible(uuid,uuid). No data is touched.
begin;

do $$
begin
  if to_regprocedure('public.email_mailbox_sync_account_eligible(uuid)') is null then
    raise exception 'Round 7.1 prerequisite missing: apply 20261229100000_email_mailbox_sync_eligibility.sql first';
  end if;
end $$;

create or replace function public.email_release_sync_ineligible(p_account_id uuid, p_lease_token uuid)
returns boolean
language plpgsql security definer set search_path = pg_catalog, public as $$
declare n integer;
begin
  if p_account_id is null or p_lease_token is null then return false; end if;
  update public.email_sync_state s
     set lease_token = null, lease_expires_at = null
   where s.account_id = p_account_id
     and s.lease_token = p_lease_token
     and not public.email_mailbox_sync_account_eligible(s.account_id);
  get diagnostics n = row_count;
  if n = 1 then
    -- 'skipped' is already an allowed run status. The run is closed without a failure message.
    update public.email_sync_runs r
       set status = 'skipped', finished_at = now()
     where r.account_id = p_account_id and r.status = 'running' and r.finished_at is null
       and r.started_at = (select max(x.started_at) from public.email_sync_runs x
                            where x.account_id = p_account_id and x.status = 'running' and x.finished_at is null);
  end if;
  return n = 1;
end $$;
revoke all on function public.email_release_sync_ineligible(uuid,uuid) from public, anon, authenticated;
grant execute on function public.email_release_sync_ineligible(uuid,uuid) to service_role;

commit;
