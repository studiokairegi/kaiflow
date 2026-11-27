create or replace function public.fin3_migration_validate(p_org uuid, p_run uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'finance_v3'
as $function$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.admin');
  rec record;
  v jsonb;
  v_dups integer := 0;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  if not exists (
    select 1 from finance_v3.migration_runs r
    where r.organization_id = p_org and r.id = p_run
  ) then
    raise exception 'Migration run not found.' using errcode = 'V3010';
  end if;

  for rec in
    select m.id, m.payload
    from finance_v3.migration_records m
    where m.organization_id = p_org
      and m.run_id = p_run
      and m.status in ('staged', 'valid', 'invalid', 'duplicate', 'skipped', 'failed')
    order by m.id
  loop
    v := finance_v3.legacy_validate(p_org, rec.payload);
    update finance_v3.migration_records m
       set status = v ->> 'status',
           mode = v ->> 'mode',
           errors = v -> 'errors',
           updated_at = now()
     where m.id = rec.id;
  end loop;

  -- Invoice numbers are presentation identifiers, not unique source keys.
  -- Distinct legacy invoice rows may legitimately reuse an invoice number.
  -- Duplicate source rows are handled by migration_records(run_id, source_id).
  update finance_v3.migration_runs r
     set status = case when r.status = 'imported' then 'imported' else 'validated' end,
         updated_at = now()
   where r.organization_id = p_org and r.id = p_run;

  perform finance_v3.write_audit(
    p_org, v_uid, 'migration_validate', 'migration_run', p_run::text,
    null, jsonb_build_object('run_duplicates', v_dups, 'duplicate_rule', 'source_id'), null
  );
  return public.fin3_migration_report(p_org, p_run);
end;
$function$;
