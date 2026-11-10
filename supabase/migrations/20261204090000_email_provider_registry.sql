-- KairFlow Email, multi-provider plan, PHASE 2 (1 of 2): general Email provider registry.
-- NEW, ADDITIVE migration on top of 20261110090000 / 20261111090000 / 20261203100000. It does not edit those files.
--
-- What it does
--   1. Creates public.email_provider_registry: the ONE list of mailbox providers the general Email module knows about
--      (provider_key, adapter_key, display name, explicit capabilities, enabled). Seeds ONLY 'resend'.
--      Gmail and Zoho are deliberately NOT seeded: they come back later, if ever, as a deliberate adapter (plan rule 9),
--      not through a legacy flag.
--   2. Re-points public.email_provider_flags_get() (the general Email browser RPC) at the registry, so the Inbox no
--      longer reports Gmail/Zoho flags. Same return shape: a jsonb object { provider_key: enabled }.
--   3. Adds public.email_provider_registry_list() for the (later) provider-aware setup screen.
--
-- What it does NOT touch (Intelligence owns these; see PHASE_1_AUDIT_REPORT_MULTI_PROVIDER.md section 5.2)
--   public.email_provider_flags (table and rows), public.email_provider_enabled(text), _shared/provider_guard.ts,
--   every intel_* object. email-send and resend-webhook keep reading email_provider_enabled('resend') until Phase 3.
--   Until Phase 3, registry.enabled is INFORMATIONAL for sending: the send gate is still email_provider_flags.
--
-- Nothing is sent by applying this migration. Re-runnable.
begin;

do $$ begin
  if to_regclass('public.email_accounts') is null or to_regclass('public.email_messages') is null
     or to_regclass('public.email_provider_flags') is null
     or to_regprocedure('public.email_has_access()') is null
     or to_regprocedure('public.email_require_access()') is null then
    raise exception 'Apply 20261110090000_email_resend_core.sql (and its hardening migration) first';
  end if;
end $$;

-- 1. Registry ---------------------------------------------------------------------------------------------------------------------
create table if not exists public.email_provider_registry (
  provider_key text primary key check (provider_key ~ '^[a-z][a-z0-9_]{1,31}$'),
  adapter_key  text not null check (adapter_key ~ '^[a-z][a-z0-9_]{1,63}$'),
  display_name text not null check (btrim(display_name) <> ''),
  capabilities jsonb not null default '{}'::jsonb check (jsonb_typeof(capabilities) = 'object'),
  enabled      boolean not null default false,        -- provider may be chosen for NEW accounts; does not connect or enable anything else
  sort_order   int not null default 100,
  note         text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.email_provider_registry enable row level security;
revoke all on public.email_provider_registry from public, anon, authenticated;
grant select on public.email_provider_registry to authenticated;
drop policy if exists email_provider_registry_select on public.email_provider_registry;
create policy email_provider_registry_select on public.email_provider_registry for select to authenticated
  using (public.email_has_access());                    -- same people as the rest of the Email module; no client writes

-- Seed: Resend only. 'enabled' starts from the current Resend flag so the two cannot disagree on day one.
-- Capabilities describe what the adapter really does today (the existing Resend path); nothing is promised that is not built.
insert into public.email_provider_registry (provider_key, adapter_key, display_name, capabilities, enabled, sort_order, note)
values (
  'resend', 'resend', 'Resend',
  jsonb_build_object(
    'send', true, 'inbound_webhook', true, 'delivery_events', true, 'attachments_send', true, 'attachments_receive', true,
    'threading_headers', true, 'drafts_local', true,
    'remote_sync', false, 'remote_search', false, 'remote_folders', false, 'remote_drafts', false, 'oauth', false),
  coalesce((select f.enabled from public.email_provider_flags f where f.provider = 'resend'), true),
  10,
  'Existing general Email path (send + inbound webhook). Transactional app email is not routed through it.')
on conflict (provider_key) do nothing;                    -- never overwrites a value changed later

-- 2. Browser RPCs -------------------------------------------------------------------------------------------------------------------
-- Same name and shape as before, now answered from the registry. Gmail/Zoho no longer appear here.
create or replace function public.email_provider_flags_get() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
  perform public.email_require_access();
  return coalesce((select jsonb_object_agg(provider_key, enabled) from public.email_provider_registry), '{}'::jsonb);
end $$;
revoke all on function public.email_provider_flags_get() from public, anon;
grant execute on function public.email_provider_flags_get() to authenticated;

create or replace function public.email_provider_registry_list() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
  perform public.email_require_access();
  return coalesce((
    select jsonb_agg(jsonb_build_object('provider_key', r.provider_key, 'display_name', r.display_name,
                                        'capabilities', r.capabilities, 'enabled', r.enabled) order by r.sort_order, r.provider_key)
      from public.email_provider_registry r), '[]'::jsonb);
end $$;
revoke all on function public.email_provider_registry_list() from public, anon;
grant execute on function public.email_provider_registry_list() to authenticated;

commit;

-- OWNER NOTES (not executed)
--   * Enabling a future provider is a deliberate act, after its adapter exists:
--       insert into public.email_provider_registry (provider_key, adapter_key, display_name, capabilities, enabled) values (...);
--     Connecting an account never flips 'enabled' as a side effect.
-- Rollback (removes only what this file created; email_provider_flags is untouched, so the 20261110 RPC definition is restored by re-running its
-- function block; run the scoping migration's rollback FIRST because it references this table):
--   drop function if exists public.email_provider_registry_list();
--   -- restore the old RPC body:
--   create or replace function public.email_provider_flags_get() returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public as $f$
--   begin perform public.email_require_access(); return coalesce((select jsonb_object_agg(provider, enabled) from public.email_provider_flags), '{}'::jsonb); end $f$;
--   drop table if exists public.email_provider_registry;
