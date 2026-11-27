-- Finance V3: archive legacy transaction history without reposting V2 ledger activity.
-- Invoice migration already carries amount_paid into receivables.opening_paid. Reposting
-- old payment journal entries would double-count cash and receivables. This migration
-- preserves the original V2 payment/expense documents and journal-line evidence as
-- read-only history. It does not change the V3 ledger or engine.

begin;

insert into finance_v3.schema_version(version, notes)
values ('20270119090000', 'legacy payments and expenses archival history; no ledger reposting')
on conflict (version) do nothing;

create table if not exists finance_v3.legacy_transaction_history (
  id bigint generated always as identity primary key,
  organization_id uuid not null references finance_v3.org_settings(organization_id) on delete restrict,
  source_table text not null check (source_table in ('invoice_payments','expenses')),
  source_id text not null check (char_length(source_id) between 1 and 100),
  record_kind text not null check (record_kind in ('payment','expense')),
  transaction_date date,
  amount numeric(19,4),
  currency text,
  invoice_id uuid,
  invoice_number text,
  category text,
  description text,
  counterparty text,
  method text,
  reference text,
  legacy_status text,
  legacy_journal_entry_id uuid,
  legacy_journal_entry_no bigint,
  legacy_journal_lines jsonb not null default '[]'::jsonb,
  source_payload jsonb not null,
  imported_at timestamptz not null default now(),
  constraint uq_fin3_legacy_history_source unique (organization_id, source_table, source_id)
);

create index if not exists ix_fin3_legacy_history_org_date
  on finance_v3.legacy_transaction_history(organization_id, transaction_date desc);
create index if not exists ix_fin3_legacy_history_org_kind
  on finance_v3.legacy_transaction_history(organization_id, record_kind, currency);

alter table finance_v3.legacy_transaction_history enable row level security;
drop policy if exists fin3_select_legacy_history on finance_v3.legacy_transaction_history;
create policy fin3_select_legacy_history on finance_v3.legacy_transaction_history
  for select to authenticated
  using (finance_v3.has_permission(organization_id, 'finance.admin'));
revoke all on finance_v3.legacy_transaction_history from public, anon, authenticated, service_role;
grant select on finance_v3.legacy_transaction_history to authenticated;
revoke all on sequence finance_v3.legacy_transaction_history_id_seq from public, anon, authenticated, service_role;

create or replace function public.fin3_migration_extract_legacy_history(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_result jsonb;
begin
  perform finance_v3.assert_permission(p_org, 'finance.admin');
  perform finance_v3.assert_org_ready(p_org);

  with payment_rows as (
    select jsonb_build_object(
      'source_table','invoice_payments',
      'source_id',ip.id::text,
      'record_kind','payment',
      'transaction_date',ip.paid_date::text,
      'amount',ip.amount::text,
      'currency',case upper(btrim(ip.currency))
        when '$' then 'USD' when '¥' then 'JPY' when '€' then 'EUR' when '£' then 'GBP'
        when 'KSH' then 'KES' else upper(btrim(ip.currency)) end,
      'invoice_id',ip.invoice_id::text,
      'invoice_number',coalesce(ip.invoice_number,i.invoice_number),
      'category',null,
      'description',coalesce(i.description,''),
      'counterparty',coalesce(p.client,p.client_name,''),
      'method',ip.method,
      'reference',ip.reference,
      'legacy_status',ip.status,
      'legacy_journal_entry_id',ip.journal_entry_id::text,
      'legacy_journal_entry_no',je.entry_no,
      'legacy_journal_lines',coalesce((
        select jsonb_agg(jsonb_build_object(
          'line_no',jl.line_no,'account_code',ca.code,'account_name',ca.name,
          'account_type',ca.type,'currency',jl.currency,
          'side',case when jl.debit > 0 then 'debit' else 'credit' end,
          'amount',case when jl.debit > 0 then jl.debit::text else jl.credit::text end,
          'base_amount',case when jl.base_debit > 0 then jl.base_debit::text else jl.base_credit::text end,
          'bank_account',ba.name,'memo',jl.memo
        ) order by jl.line_no)
        from public.journal_lines jl
        join public.chart_accounts ca on ca.id=jl.account_id
        left join public.bank_accounts ba on ba.id=jl.bank_account_id
        where jl.entry_id=ip.journal_entry_id
      ),'[]'::jsonb),
      'source_payload',to_jsonb(ip) || jsonb_build_object(
        'legacy_invoice',case when i.id is null then null else to_jsonb(i) end,
        'legacy_project',case when p.id is null then null else jsonb_build_object('id',p.id,'name',p.name,'client',p.client) end
      )
    ) as payload
    from public.invoice_payments ip
    join public.studio_data_owners o on o.user_id=ip.user_id and o.organization_id=p_org
    left join public.invoices i on i.id=ip.invoice_id
    left join public.projects p on p.id=i.project_id
    left join public.journal_entries je on je.id=ip.journal_entry_id
    where ip.status='posted'
  ),
  expense_rows as (
    select jsonb_build_object(
      'source_table','expenses',
      'source_id',e.id::text,
      'record_kind','expense',
      'transaction_date',case when coalesce(e.date,'') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then e.date else null end,
      'amount',e.amount::text,
      'currency',case upper(btrim(e.currency))
        when '$' then 'USD' when '¥' then 'JPY' when '€' then 'EUR' when '£' then 'GBP'
        when 'KSH' then 'KES' else upper(btrim(e.currency)) end,
      'invoice_id',null,
      'invoice_number',null,
      'category',e.category,
      'description',e.description,
      'counterparty',e.vendor,
      'method',null,
      'reference',e.reference,
      'legacy_status',case when e.journal_entry_id is not null then 'posted' else 'unposted' end,
      'legacy_journal_entry_id',e.journal_entry_id::text,
      'legacy_journal_entry_no',je.entry_no,
      'legacy_journal_lines',coalesce((
        select jsonb_agg(jsonb_build_object(
          'line_no',jl.line_no,'account_code',ca.code,'account_name',ca.name,
          'account_type',ca.type,'currency',jl.currency,
          'side',case when jl.debit > 0 then 'debit' else 'credit' end,
          'amount',case when jl.debit > 0 then jl.debit::text else jl.credit::text end,
          'base_amount',case when jl.base_debit > 0 then jl.base_debit::text else jl.base_credit::text end,
          'bank_account',ba.name,'memo',jl.memo
        ) order by jl.line_no)
        from public.journal_lines jl
        join public.chart_accounts ca on ca.id=jl.account_id
        left join public.bank_accounts ba on ba.id=jl.bank_account_id
        where jl.entry_id=e.journal_entry_id
      ),'[]'::jsonb),
      'source_payload',to_jsonb(e) || jsonb_build_object(
        'legacy_project',case when p.id is null then null else jsonb_build_object('id',p.id,'name',p.name,'client',p.client) end
      )
    ) as payload
    from public.expenses e
    join public.studio_data_owners o on o.user_id=e.user_id and o.organization_id=p_org
    left join public.projects p on p.id=e.project_id
    left join public.journal_entries je on je.id=e.journal_entry_id
    where e.journal_entry_id is not null
  )
  select coalesce(jsonb_agg(payload order by payload->>'source_table',payload->>'source_id'),'[]'::jsonb)
    into v_result
  from (select payload from payment_rows union all select payload from expense_rows) rows;
  return v_result;
end;
$$;

create or replace function public.fin3_migration_import_legacy_history(p_org uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.admin');
  v_rows jsonb;
  v_item jsonb;
  v_inserted integer := 0;
  v_payments integer := 0;
  v_expenses integer := 0;
  v_row_count integer := 0;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  v_rows := public.fin3_migration_extract_legacy_history(p_org);

  for v_item in select value from jsonb_array_elements(v_rows) loop
    insert into finance_v3.legacy_transaction_history(
      organization_id,source_table,source_id,record_kind,transaction_date,amount,currency,
      invoice_id,invoice_number,category,description,counterparty,method,reference,legacy_status,
      legacy_journal_entry_id,legacy_journal_entry_no,legacy_journal_lines,source_payload
    ) values (
      p_org,
      v_item->>'source_table',
      v_item->>'source_id',
      v_item->>'record_kind',
      nullif(v_item->>'transaction_date','')::date,
      nullif(v_item->>'amount','')::numeric,
      nullif(v_item->>'currency',''),
      nullif(v_item->>'invoice_id','')::uuid,
      nullif(v_item->>'invoice_number',''),
      nullif(v_item->>'category',''),
      nullif(v_item->>'description',''),
      nullif(v_item->>'counterparty',''),
      nullif(v_item->>'method',''),
      nullif(v_item->>'reference',''),
      nullif(v_item->>'legacy_status',''),
      nullif(v_item->>'legacy_journal_entry_id','')::uuid,
      nullif(v_item->>'legacy_journal_entry_no','')::bigint,
      coalesce(v_item->'legacy_journal_lines','[]'::jsonb),
      coalesce(v_item->'source_payload','{}'::jsonb)
    )
    on conflict (organization_id,source_table,source_id) do nothing;
    get diagnostics v_row_count = row_count;
    v_inserted := v_inserted + v_row_count;
    if v_row_count = 1 and v_item->>'record_kind' = 'payment' then v_payments := v_payments + 1; end if;
    if v_row_count = 1 and v_item->>'record_kind' = 'expense' then v_expenses := v_expenses + 1; end if;
  end loop;

  perform finance_v3.write_audit(
    p_org,v_uid,'migration_import_legacy_history','legacy_transaction_history',p_org::text,
    null,jsonb_build_object('inserted',v_inserted,'payments',v_payments,'expenses',v_expenses),null
  );

  return jsonb_build_object(
    'inserted',v_inserted,
    'payments_inserted',v_payments,
    'expenses_inserted',v_expenses,
    'source_rows',jsonb_array_length(v_rows),
    'ledger_entries_posted',0,
    'note','Source history and original journal evidence archived only; existing V2 amounts were not reposted to the V3 ledger.'
  );
end;
$$;

create or replace function public.fin3_migration_legacy_history_report(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  perform finance_v3.assert_permission(p_org, 'finance.admin');
  perform finance_v3.assert_org_ready(p_org);
  return jsonb_build_object(
    'total', (select count(*) from finance_v3.legacy_transaction_history h where h.organization_id=p_org),
    'payments', (select count(*) from finance_v3.legacy_transaction_history h where h.organization_id=p_org and h.record_kind='payment'),
    'expenses', (select count(*) from finance_v3.legacy_transaction_history h where h.organization_id=p_org and h.record_kind='expense'),
    'by_currency', coalesce((
      select jsonb_agg(jsonb_build_object('kind',q.record_kind,'currency',q.currency,'count',q.n,'amount',q.total) order by q.record_kind,q.currency)
      from (
        select record_kind,currency,count(*) n,sum(amount) total
        from finance_v3.legacy_transaction_history
        where organization_id=p_org
        group by record_kind,currency
      ) q
    ),'[]'::jsonb),
    'ledger_postings_created',0
  );
end;
$$;

revoke all on function public.fin3_migration_extract_legacy_history(uuid) from public,anon;
revoke all on function public.fin3_migration_import_legacy_history(uuid) from public,anon;
revoke all on function public.fin3_migration_legacy_history_report(uuid) from public,anon;
grant execute on function public.fin3_migration_extract_legacy_history(uuid) to authenticated;
grant execute on function public.fin3_migration_import_legacy_history(uuid) to authenticated;
grant execute on function public.fin3_migration_legacy_history_report(uuid) to authenticated;

commit;