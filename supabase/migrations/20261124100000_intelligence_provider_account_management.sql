-- Phase 2.4: administrator controls for independently connected provider accounts.
-- Sending stays fail-closed; this migration deliberately exposes no send-enable switch.
begin;

create or replace function public.intel_admin_update_provider_account(p_account_id uuid, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org(); v_account public.intel_provider_accounts;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object'
     or exists (select 1 from jsonb_object_keys(p_patch) k where k not in ('is_enabled')) then
    raise exception 'unsupported provider account update';
  end if;
  update public.intel_provider_accounts a
     set is_enabled = coalesce((p_patch->>'is_enabled')::boolean, a.is_enabled),
         updated_at = now()
   where a.id = p_account_id and a.organization_id = v_org and a.status = 'connected'
   returning * into v_account;
  if not found then raise exception 'connected provider account not found'; end if;
  return jsonb_build_object('ok', true, 'id', v_account.id, 'is_enabled', v_account.is_enabled,
                            'send_enabled', v_account.send_enabled, 'status', v_account.status);
end $$;
revoke all on function public.intel_admin_update_provider_account(uuid,jsonb) from public, anon;
grant execute on function public.intel_admin_update_provider_account(uuid,jsonb) to authenticated;

create or replace function public.intel_admin_disconnect_provider_account(p_account_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_admin_org(); v_id uuid;
begin
  update public.intel_provider_accounts a
     set status = 'disconnected', health_status = 'unknown', is_enabled = false, send_enabled = false,
         credentials_ciphertext = '', disconnected_at = now(), updated_at = now()
   where a.id = p_account_id and a.organization_id = v_org
   returning a.id into v_id;
  if v_id is null then raise exception 'provider account not found'; end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'status', 'disconnected');
end $$;
revoke all on function public.intel_admin_disconnect_provider_account(uuid) from public, anon;
grant execute on function public.intel_admin_disconnect_provider_account(uuid) to authenticated;

-- The account registry remains the sole inventory. No credentials or OAuth state are exposed
-- by either catalogue RPC; the existing admin read RPCs remain the only UI read path.
commit;
