-- Schedules general Email mailbox synchronization (Edge Function email-mailbox-sync).
-- Nothing is scheduled until an administrator stores the function URL and secret in public.email_sync_config AND pg_cron + pg_net exist.
-- Without them this migration only creates the config table and the kick function; it never raises. Safe to re-run.
-- Setup (service role / SQL editor):
--   insert into public.email_sync_config(id, function_url, secret) values (true, 'https://<project>.functions.supabase.co/email-mailbox-sync', '<same value as EMAIL_SYNC_CRON_SECRET>')
--   on conflict (id) do update set function_url = excluded.function_url, secret = excluded.secret;
begin;

create table if not exists public.email_sync_config (
  id boolean primary key default true check (id),
  function_url text not null check (function_url ~ '^https://'),
  secret text not null check (length(secret) >= 16),
  updated_at timestamptz not null default now()
);
alter table public.email_sync_config enable row level security;
revoke all on public.email_sync_config from public, anon, authenticated;
grant all on public.email_sync_config to service_role;

create or replace function public.email_kick_mailbox_sync() returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_cfg public.email_sync_config%rowtype;
begin
  select * into v_cfg from public.email_sync_config limit 1;
  if not found or to_regnamespace('net') is null then return; end if;
  execute format('select net.http_post(url := %L, headers := %L::jsonb, body := %L::jsonb)',
    v_cfg.function_url, jsonb_build_object('Content-Type', 'application/json', 'x-email-sync-secret', v_cfg.secret)::text, '{}');
exception when others then
  null;   -- a missed tick only delays synchronization until the next one
end $$;
revoke all on function public.email_kick_mailbox_sync() from public, anon, authenticated;
grant execute on function public.email_kick_mailbox_sync() to service_role;

do $$
begin
  if to_regnamespace('cron') is null then
    raise notice 'pg_cron is not enabled; mailbox sync is not scheduled. Enable pg_cron and re-run this file.';
  else
    perform cron.unschedule(jobid) from cron.job where jobname = 'kairflow_email_mailbox_sync';
    perform cron.schedule('kairflow_email_mailbox_sync', '*/2 * * * *', 'select public.email_kick_mailbox_sync()');
  end if;
end $$;

commit;
-- Rollback: select cron.unschedule(jobid) from cron.job where jobname = 'kairflow_email_mailbox_sync'; drop function public.email_kick_mailbox_sync(); drop table public.email_sync_config;
