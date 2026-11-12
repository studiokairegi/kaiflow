-- Round 7.2: close orphaned 'running' sync-run rows when a new lease is claimed.
-- A worker that crashed or timed out never reaches finish/fail/release, so its run row stayed 'running'
-- forever. email_claim_sync only succeeds once the previous lease is expired or released, so any run
-- still 'running' at that moment is provably abandoned. It is closed as 'failed' with a fixed safe message.
-- This replaces ONLY email_claim_sync, keeping the Round 7 eligibility, retry and lease checks unchanged.
-- Failure counters and retry state are NOT touched: abandonment is recorded on the run row only.
-- Rollback: re-create email_claim_sync from 20261229100000_email_mailbox_sync_eligibility.sql. No data is deleted.
begin;

do $$
begin
  if to_regprocedure('public.email_release_sync_ineligible(uuid,uuid)') is null then
    raise exception 'Round 7.2 prerequisite missing: apply 20261229110000 first';
  end if;
end $$;

create or replace function public.email_claim_sync(p_account_id uuid, p_lease_seconds integer default 180)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare a public.email_accounts; s public.email_sync_state; v_token uuid := gen_random_uuid(); v_lease integer := least(greatest(coalesce(p_lease_seconds,180),30),600);
begin
  if not public.email_mailbox_sync_account_eligible(p_account_id) then
    return jsonb_build_object('claimed',false,'reason','account_ineligible');
  end if;
  select * into a from public.email_accounts where id = p_account_id;
  insert into public.email_sync_state(account_id,organization_id) values(a.id,a.organization_id)
  on conflict(account_id) do nothing;
  select * into s from public.email_sync_state where account_id = a.id for update;
  if s.next_retry_at is not null and s.next_retry_at > now() then
    return jsonb_build_object('claimed',false,'reason','retry_not_due','retry_at',s.next_retry_at,'checkpoint',s.cursor);
  end if;
  if s.lease_expires_at is not null and s.lease_expires_at > now() then
    return jsonb_build_object('claimed',false,'reason','sync_in_progress','checkpoint',s.cursor);
  end if;
  -- The row lock above serializes claimers; no live lease exists, so earlier running rows are orphans.
  update public.email_sync_runs set status='failed', safe_error='Run was interrupted before completion', finished_at=now()
   where account_id = a.id and status = 'running' and finished_at is null;
  update public.email_sync_state set lease_token=v_token, lease_expires_at=now()+make_interval(secs=>v_lease),
    last_attempt_at=now(), last_error=''
  where account_id=a.id;
  insert into public.email_sync_runs(account_id,organization_id,provider_key,status) values(a.id,a.organization_id,a.provider,'running');
  return jsonb_build_object('claimed',true,'lease_token',v_token,'checkpoint',s.cursor,'consecutive_failures',s.consecutive_failures);
end $$;
revoke all on function public.email_claim_sync(uuid,integer) from public, anon, authenticated;
grant execute on function public.email_claim_sync(uuid,integer) to service_role;

commit;
