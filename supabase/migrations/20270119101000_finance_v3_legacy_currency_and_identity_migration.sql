-- Normalize legacy currency symbols and stop treating invoice numbers as unique source IDs.
-- Legacy invoice numbers are reused across clients and projects; source_id is the stable key.
do $do$
declare v text;
begin
  v := pg_get_functiondef('finance_v3.legacy_validate(uuid,jsonb)'::regprocedure);
  v := replace(v,
    $old$v_ccy    text := upper(btrim(coalesce(p ->> 'currency', '')));$old$,
    $new$v_ccy    text := case upper(btrim(coalesce(p ->> 'currency', ''))) when '$' then 'USD' when '¥' then 'JPY' when '€' then 'EUR' when '£' then 'GBP' when 'KSH' then 'KES' else upper(btrim(coalesce(p ->> 'currency', ''))) end;$new$);
  v := replace(v, $old$ or r.invoice_no = v_no$old$, '');
  execute v;

  v := pg_get_functiondef('finance_v3.legacy_import_one(uuid,bigint,uuid,date)'::regprocedure);
  v := replace(v,
    $old$v_ccy := upper(btrim(p ->> 'currency'));$old$,
    $new$v_ccy := case upper(btrim(p ->> 'currency')) when '$' then 'USD' when '¥' then 'JPY' when '€' then 'EUR' when '£' then 'GBP' when 'KSH' then 'KES' else upper(btrim(p ->> 'currency')) end;$new$);
  execute v;
end
$do$;

create or replace function public.fin3_migration_extract_legacy_invoices(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'finance_v3'
as $function$
begin
  perform finance_v3.assert_permission(p_org, 'finance.admin');
  perform finance_v3.assert_org_ready(p_org);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'source_id', to_jsonb(i) ->> 'id',
      'invoice_number', to_jsonb(i) ->> 'invoice_number',
      'client_name', coalesce(nullif(btrim(to_jsonb(p) ->> 'client'), ''), nullif(btrim(to_jsonb(p) ->> 'client_name'), ''), 'Legacy client'),
      'client_email', coalesce(to_jsonb(p) ->> 'client_email', to_jsonb(p) ->> 'email'),
      'project_id', to_jsonb(i) ->> 'project_id',
      'currency', case upper(btrim(to_jsonb(i) ->> 'currency'))
        when '$' then 'USD' when '¥' then 'JPY' when '€' then 'EUR' when '£' then 'GBP' when 'KSH' then 'KES'
        else upper(btrim(to_jsonb(i) ->> 'currency')) end,
      'amount', to_jsonb(i) ->> 'amount',
      'amount_paid', to_jsonb(i) ->> 'amount_paid',
      'issue_date', coalesce(nullif(to_jsonb(i) ->> 'issue_date', ''), to_char((i.created_at at time zone 'UTC')::date, 'YYYY-MM-DD')),
      'due_date', coalesce(nullif(to_jsonb(i) ->> 'due_date', ''), nullif(to_jsonb(i) ->> 'issue_date', ''), to_char((i.created_at at time zone 'UTC')::date, 'YYYY-MM-DD')),
      'status', to_jsonb(i) ->> 'status',
      'description', to_jsonb(i) ->> 'description')
      order by to_jsonb(i) ->> 'id')
    from public.invoices i
    join public.studio_data_owners o on o.user_id = i.user_id and o.organization_id = p_org
    left join public.projects p on p.id = i.project_id
  ), '[]'::jsonb);
end;
$function$;
