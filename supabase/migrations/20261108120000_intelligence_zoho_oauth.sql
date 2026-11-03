-- KairFlow Intelligence: single-use OAuth state for connecting Zoho Mail. Additive. Safe to run more than once.
-- Only the Edge Functions (service role) touch this table: RLS on with no policies and no grants for clients.
begin;
create table if not exists public.intel_oauth_states (
  state uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  data_center text not null check (data_center in ('com','eu','in','com.au','jp','ca','sa','com.cn')),
  created_at timestamptz not null default now(),
  used_at timestamptz
);
alter table public.intel_oauth_states enable row level security;
revoke all on public.intel_oauth_states from public, anon, authenticated;
commit;

-- The callback runs with the service role (no user JWT), so it re-checks the starter's authorization here:
-- the same strict rule as intel_is_authorized(), evaluated for an explicit user. Executable by service_role only.
begin;
create or replace function public.intel_is_authorized_user(p_user_id uuid, p_organization_id uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public as $$
  select p_user_id is not null and p_organization_id is not null
     and exists (select 1 from public.user_settings s where s.user_id = p_user_id and s.is_admin is true)
     and exists (select 1 from public.studio_memberships m where m.user_id = p_user_id and m.organization_id = p_organization_id and m.role = 'master_user' and m.status = 'active')
$$;
revoke all on function public.intel_is_authorized_user(uuid, uuid) from public, anon, authenticated;
grant execute on function public.intel_is_authorized_user(uuid, uuid) to service_role;
commit;
