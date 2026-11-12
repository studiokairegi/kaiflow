-- Round 7: authoritative account selection and eligibility for the general Email mailbox sync.
-- Additive and fail-closed. Gmail/Zoho remain ineligible until BOTH account opt-in and
-- provider remote_sync capability are deliberately enabled. This migration does not enable either.
-- Rollback: restore the prior email-mailbox-sync Edge Function account query and reapply the
-- email_claim_sync / email_renew_sync / email_commit_sync_checkpoint / email_finish_sync bodies
-- from 20261214100000_email_mailbox_phase5_foundation.sql. No mailbox data is deleted.
begin;

do $$
begin
  if to_regclass('public.email_accounts') is null
     or to_regclass('public.email_sync_state') is null
     or to_regclass('public.email_provider_registry') is null
     or to_regclass('public.intel_provider_accounts') is null
     or to_regclass('public.intel_email_provider_registry') is null then
    raise exception 'Round 7 prerequisites missing: shared Intelligence accounts and Email mailbox sync foundation are required';
  end if;
end $$;

-- The Intelligence account is the owner of account-level enablement. The Email registry is
-- the owner of Inbox adapter availability. Both gates, plus the Intelligence provider registry,
-- must be open. This helper deliberately supports only the two reviewed shared OAuth providers.
create or replace function public.email_mailbox_sync_account_eligible(p_account_id uuid)
returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select exists (
    select 1
      from public.email_accounts a
      join public.intel_provider_accounts ia
        on ia.id = a.source_provider_account_id
       and ia.organization_id = a.organization_id
       and ia.provider_key = a.provider
      join public.intel_email_provider_registry ir
        on ir.provider_key = ia.provider_key and ir.enabled is true
      join public.email_provider_registry er
        on er.provider_key = a.provider
       and er.enabled is true
       and er.capabilities @> '{"remote_sync":true}'::jsonb
     where a.id = p_account_id
       and a.provider in ('gmail','zoho')
       and a.source_provider_account_id is not null
       and a.status = 'active'
       and a.connection_status = 'connected'
       and lower(btrim(a.address)) = lower(btrim(ia.mailbox))
       and ia.status = 'connected'
       and ia.is_enabled is true
  );
$$;
revoke all on function public.email_mailbox_sync_account_eligible(uuid) from public, anon, authenticated;
grant execute on function public.email_mailbox_sync_account_eligible(uuid) to service_role;

-- Return only accounts that are eligible NOW, whose retry is due, and which have no live lease.
-- Deterministic least-recently-attempted ordering prevents a busy account from starving others.
create or replace function public.email_list_sync_accounts(p_limit integer default 25)
returns setof public.email_accounts
language sql stable security definer set search_path = pg_catalog, public as $$
  select a.*
    from public.email_accounts a
    left join public.email_sync_state s on s.account_id = a.id
   where public.email_mailbox_sync_account_eligible(a.id)
     and (s.next_retry_at is null or s.next_retry_at <= now())
     and (s.lease_expires_at is null or s.lease_expires_at <= now())
   order by coalesce(s.last_attempt_at, '-infinity'::timestamptz), a.id
   limit least(greatest(coalesce(p_limit,25),1),25);
$$;
revoke all on function public.email_list_sync_accounts(integer) from public, anon, authenticated;
grant execute on function public.email_list_sync_accounts(integer) to service_role;

-- Re-check eligibility atomically at claim time; list results are advisory and may become stale.
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
  update public.email_sync_state set lease_token=v_token, lease_expires_at=now()+make_interval(secs=>v_lease),
    last_attempt_at=now(), last_error=''
  where account_id=a.id;
  insert into public.email_sync_runs(account_id,organization_id,provider_key,status) values(a.id,a.organization_id,a.provider,'running');
  return jsonb_build_object('claimed',true,'lease_token',v_token,'checkpoint',s.cursor,'consecutive_failures',s.consecutive_failures);
end $$;
revoke all on function public.email_claim_sync(uuid,integer) from public, anon, authenticated;
grant execute on function public.email_claim_sync(uuid,integer) to service_role;

-- A disabled/disconnected account loses its lease at the next heartbeat or request boundary.
create or replace function public.email_renew_sync(
  p_account_id uuid, p_lease_token uuid, p_lease_seconds integer default 180
) returns boolean
language plpgsql security definer set search_path = pg_catalog, public as $$
declare n integer; v_lease integer := least(greatest(coalesce(p_lease_seconds,180),30),600);
begin
  update public.email_sync_state s
     set lease_expires_at = now() + make_interval(secs => v_lease)
   where s.account_id = p_account_id and s.lease_token = p_lease_token
     and s.lease_expires_at > now()
     and public.email_mailbox_sync_account_eligible(s.account_id);
  get diagnostics n = row_count;
  return n = 1;
end $$;
revoke all on function public.email_renew_sync(uuid,uuid,integer) from public, anon, authenticated;
grant execute on function public.email_renew_sync(uuid,uuid,integer) to service_role;

-- Do not advance or finalize a checkpoint after the account has become ineligible.
create or replace function public.email_commit_sync_checkpoint(p_account_id uuid,p_lease_token uuid,p_checkpoint jsonb,p_pages integer default 0,p_messages integer default 0)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
declare n integer;
begin
  update public.email_sync_state set cursor=coalesce(p_checkpoint,'{}'::jsonb), last_error='',
    last_page_count=greatest(coalesce(p_pages,0),0), last_message_count=greatest(coalesce(p_messages,0),0)
  where account_id=p_account_id and lease_token=p_lease_token and lease_expires_at > now()
    and public.email_mailbox_sync_account_eligible(account_id);
  get diagnostics n = row_count;
  return n=1;
end $$;
revoke all on function public.email_commit_sync_checkpoint(uuid,uuid,jsonb,integer,integer) from public, anon, authenticated;
grant execute on function public.email_commit_sync_checkpoint(uuid,uuid,jsonb,integer,integer) to service_role;

create or replace function public.email_finish_sync(p_account_id uuid,p_lease_token uuid,p_pages integer default 0,p_messages integer default 0,p_inserted integer default 0,p_updated integer default 0,p_partial boolean default false)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
declare n integer;
begin
  update public.email_sync_state set lease_token=null, lease_expires_at=null, last_success_at=case when not p_partial then now() else last_success_at end,
    last_page_count=greatest(coalesce(p_pages,0),0),last_message_count=greatest(coalesce(p_messages,0),0),
    consecutive_failures=case when not p_partial then 0 else consecutive_failures end, next_retry_at=null
  where account_id=p_account_id and lease_token=p_lease_token and lease_expires_at > now()
    and public.email_mailbox_sync_account_eligible(account_id);
  get diagnostics n = row_count;
  if n=1 then
    update public.email_sync_runs set status=case when p_partial then 'partial' else 'succeeded' end,
      pages_processed=greatest(coalesce(p_pages,0),0),messages_seen=greatest(coalesce(p_messages,0),0),
      messages_inserted=greatest(coalesce(p_inserted,0),0),messages_updated=greatest(coalesce(p_updated,0),0),finished_at=now()
    where account_id=p_account_id and status='running' and finished_at is null and started_at=(select max(started_at) from public.email_sync_runs where account_id=p_account_id and status='running');
  end if;
  return n=1;
end $$;
revoke all on function public.email_finish_sync(uuid,uuid,integer,integer,integer,integer,boolean) from public, anon, authenticated;
grant execute on function public.email_finish_sync(uuid,uuid,integer,integer,integer,integer,boolean) to service_role;

-- Preserve the existing two-argument compatibility overload.
create or replace function public.email_finish_sync(p_account_id uuid,p_lease_token uuid) returns boolean
language sql security definer set search_path = pg_catalog, public as $$
  select public.email_finish_sync(p_account_id,p_lease_token,0,0,0,0,false)
$$;
revoke all on function public.email_finish_sync(uuid,uuid) from public, anon, authenticated;
grant execute on function public.email_finish_sync(uuid,uuid) to service_role;

commit;
