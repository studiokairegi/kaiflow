-- Regression check for the Phase 8 shared row-lock trigger.
-- The function must not dereference purpose on intel_suppressions, which does
-- not have that column.
do $$
declare
  v_def text := pg_get_functiondef('public._intel_phase8_lock_policy_key()'::regprocedure);
begin
  if position('tg_table_name = ''intel_suppressions''' in v_def) = 0 then
    raise exception 'Phase 8 lock function does not branch for intel_suppressions';
  end if;
  if position('tg_table_name = ''intel_contact_permissions''' in v_def) = 0 then
    raise exception 'Phase 8 lock function does not branch for intel_contact_permissions';
  end if;
  if position('else' || ' :permission:' in v_def) > 0 then
    raise exception 'Phase 8 lock function still has an unsafe generic purpose branch';
  end if;
end;
$$;
