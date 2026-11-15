-- Phase 7 (seven-phase roadmap): restore the intended privileges of the two service-role-only Intelligence functions.
--
-- WHY: 20261112090000 and 20261127100000 / 20261203100000 revoked EXECUTE from public, anon and authenticated on
--   public.intel_resend_record_inbound(...) and public.intel_agent_apply_delivery_event(...) and granted it to service_role only.
-- 20270103100000_intelligence_emma_actions.sql then ran a bulk loop that revokes from public/anon and GRANTS EXECUTE TO authenticated for every
-- intel_* function except the private _intel_* helpers and intel_is_authorized_user. That silently re-granted these two to signed-in users.
-- Both function bodies still refuse any caller whose auth.role() is not 'service_role', so this was not an open door; it was a grant wider
-- than intended. This migration narrows it again. The only legitimate callers are the Edge Functions intel-resend-webhook and
-- _shared/intel_resend_delivery_sink.ts, which use the service-role key.
--
-- SAFE TO APPLY: additive and idempotent (revoke / grant only). No table, row, function body, setting, kill switch or provider gate changes.
-- It must stay the LAST migration that touches these functions: any later "for r in ... pg_proc" bulk loop that grants authenticated must
-- exempt them too (test_phase7_production_validation.py replays every migration and fails if that happens).
--
-- ROLLBACK (not recommended; it re-opens the wider grant):
--   grant execute on function public.intel_resend_record_inbound(text,text,text,text,text,text,text,timestamptz,text) to authenticated;
--   grant execute on function public.intel_agent_apply_delivery_event(text,uuid,text,text,text,text,timestamptz,text,text) to authenticated;
begin;

do $$
begin
  if to_regprocedure('public.intel_resend_record_inbound(text,text,text,text,text,text,text,timestamptz,text)') is not null then
    execute 'revoke all on function public.intel_resend_record_inbound(text,text,text,text,text,text,text,timestamptz,text) from public, anon, authenticated';
    execute 'grant execute on function public.intel_resend_record_inbound(text,text,text,text,text,text,text,timestamptz,text) to service_role';
  end if;
  if to_regprocedure('public.intel_agent_apply_delivery_event(text,uuid,text,text,text,text,timestamptz,text,text)') is not null then
    execute 'revoke all on function public.intel_agent_apply_delivery_event(text,uuid,text,text,text,text,timestamptz,text,text) from public, anon, authenticated';
    execute 'grant execute on function public.intel_agent_apply_delivery_event(text,uuid,text,text,text,text,timestamptz,text,text) to service_role';
  end if;
end $$;

commit;
