-- Finance V3, Phase 4 (migration 2 of 2): studio operations RPCs.
--
-- Projects, animators, allocations, reserves, owner compensation and the safe-to-spend read model. Clients reach finance_v3 only
-- through these public.fin3_* RPCs (SECURITY DEFINER, pinned search_path). Every write:
--   * checks the caller's permission in the organization,   * takes lock_org first (concurrent spends cannot both pass),
--   * is idempotent by a caller key or a deterministic event key,   * posts to the ledger ONLY through post_event / reverse_entry,
--   * writes an audit record.
-- Money crosses the API as decimal strings and is parsed to exact numerics; nothing here uses floating point.
-- Rollback: supabase/rollback/20270115091000_finance_v3_studio_ops.rollback.sql

begin;

insert into finance_v3.schema_version (version, notes)
values ('20270115091000', 'phase 4 migration 2: project finance, animator obligations, allocations, reserves, owner compensation, safe-to-spend RPCs')
on conflict (version) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.assert_key(p_key text)
returns void
language plpgsql immutable
set search_path = pg_catalog, finance_v3
as $$
begin
  if p_key is null or char_length(p_key) not between 1 and 200 or p_key !~ '^[A-Za-z0-9_.:-]+$' then
    raise exception 'A valid idempotency key is required.' using errcode = 'V3011';
  end if;
end;
$$;

create or replace function finance_v3.assert_keys_allowed(p_obj jsonb, p_allowed text[], p_what text)
returns void
language plpgsql immutable
set search_path = pg_catalog, finance_v3
as $$
declare v_k text;
begin
  if p_obj is null or jsonb_typeof(p_obj) <> 'object' then
    raise exception 'The % must be an object.', p_what using errcode = 'V3011';
  end if;
  select k into v_k from jsonb_object_keys(p_obj) k where k <> all (p_allowed) limit 1;
  if v_k is not null then raise exception 'Unknown % field "%".', p_what, v_k using errcode = 'V3011'; end if;
end;
$$;

create or replace function finance_v3.assert_currency(p_ccy text)
returns text
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  if p_ccy is null or finance_v3.minor_unit(upper(p_ccy)) is null then
    raise exception 'Unsupported currency "%".', coalesce(p_ccy, '') using errcode = 'V3011';
  end if;
  return upper(p_ccy);
end;
$$;

create or replace function finance_v3.money_field(p_obj jsonb, p_key text, p_label text, p_ccy text, p_allow_zero boolean, p_default text default null)
returns numeric
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  if not (p_obj ? p_key) or jsonb_typeof(p_obj -> p_key) = 'null' then
    if p_default is not null then return finance_v3.parse_money(p_default, p_label, p_ccy, p_allow_zero); end if;
    raise exception '% is required.', p_label using errcode = 'V3011';
  end if;
  if jsonb_typeof(p_obj -> p_key) <> 'string' then
    raise exception '% must be a decimal string such as "12.50", not a number.', p_label using errcode = 'V3011';
  end if;
  return finance_v3.parse_money(p_obj ->> p_key, p_label, p_ccy, p_allow_zero);
end;
$$;

create or replace function finance_v3.clamp_limit(p_limit integer)
returns integer language sql immutable set search_path = pg_catalog, finance_v3 as $$ select least(greatest(coalesce(p_limit, 50), 1), 200) $$;

create or replace function finance_v3.clamp_offset(p_offset integer)
returns integer language sql immutable set search_path = pg_catalog, finance_v3 as $$ select greatest(coalesce(p_offset, 0), 0) $$;

create or replace function finance_v3.assert_project(p_org uuid, p_project uuid)
returns void
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  if p_project is null or not finance_v3.project_in_org(p_org, p_project) then
    raise exception 'The project is not part of this studio.' using errcode = 'V3011';
  end if;
end;
$$;

create or replace function finance_v3.prot_json(p_prot jsonb)
returns jsonb language sql immutable set search_path = pg_catalog, finance_v3 as $$
  select case when p_prot is null or p_prot ->> 'outcome' = 'ok' then '{}'::jsonb else jsonb_build_object('protection', p_prot) end
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Protection settings, safe-to-spend, spend pre-check, protection events
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fin3_get_protection_settings(p_org uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare s finance_v3.protection_settings;
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  select * into s from finance_v3.protection_settings x where x.organization_id = p_org;
  if not found then
    return jsonb_build_object('mode', 'block', 'commitment_horizon_days', 30, 'is_default', true);
  end if;
  return jsonb_build_object('mode', s.mode, 'commitment_horizon_days', s.commitment_horizon_days, 'is_default', false, 'updated_at', s.updated_at);
end;
$$;

create or replace function public.fin3_update_protection_settings(p_org uuid, p_settings jsonb)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.admin');
  v_mode text; v_h smallint; s finance_v3.protection_settings;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  perform finance_v3.assert_keys_allowed(p_settings, array['mode', 'commitment_horizon_days'], 'settings');
  insert into finance_v3.protection_settings (organization_id) values (p_org) on conflict (organization_id) do nothing;
  select * into s from finance_v3.protection_settings x where x.organization_id = p_org for update;
  v_mode := coalesce(p_settings ->> 'mode', s.mode);
  if v_mode not in ('block', 'warn') then raise exception 'Mode must be block or warn.' using errcode = 'V3011'; end if;
  if p_settings ? 'commitment_horizon_days' then
    if (p_settings ->> 'commitment_horizon_days') !~ '^[0-9]{1,3}$' or (p_settings ->> 'commitment_horizon_days')::int > 365 then
      raise exception 'The horizon must be a whole number of days from 0 to 365.' using errcode = 'V3011';
    end if;
    v_h := (p_settings ->> 'commitment_horizon_days')::smallint;
  else
    v_h := s.commitment_horizon_days;
  end if;
  update finance_v3.protection_settings x set mode = v_mode, commitment_horizon_days = v_h, updated_by = v_uid, updated_at = now()
   where x.organization_id = p_org;
  perform finance_v3.write_audit(p_org, v_uid, 'update_protection_settings', 'protection_settings', p_org::text,
    jsonb_build_object('mode', s.mode, 'commitment_horizon_days', s.commitment_horizon_days),
    jsonb_build_object('mode', v_mode, 'commitment_horizon_days', v_h), null);
  return jsonb_build_object('mode', v_mode, 'commitment_horizon_days', v_h, 'is_default', false);
end;
$$;

-- p_currency null = every currency the studio holds, plus a base-currency estimate where a stored rate exists.
create or replace function public.fin3_safe_to_spend(p_org uuid, p_currency text default null)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  s finance_v3.org_settings; c text; v_list jsonb := '[]'::jsonb; j jsonb; v_rate numeric; v_rate_date date; v_total numeric := 0;
  v_missing jsonb := '[]'::jsonb; v_est jsonb := '[]'::jsonb; v_safe numeric; v_ccys text[];
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  s := finance_v3.assert_org_ready(p_org);
  if p_currency is not null then
    return finance_v3.safe_to_spend_json(p_org, finance_v3.assert_currency(p_currency));
  end if;
  select coalesce(array_agg(distinct x.c order by x.c), array[]::text[]) into v_ccys from (
    select l.currency c from finance_v3.journal_lines l
      where l.organization_id = p_org and l.account_id in (select ca.account_id from finance_v3.cash_account_ids(p_org) ca)
    union select w.currency from finance_v3.animator_work_items w where w.organization_id = p_org and w.status = 'approved' and w.outstanding > 0
    union select b.currency from finance_v3.payables b where b.organization_id = p_org and b.status in ('approved', 'partially_paid')
    union select o.currency from finance_v3.owner_payments o where o.organization_id = p_org and o.status = 'scheduled'
    union select a.currency from finance_v3.fund_allocations a where a.organization_id = p_org and a.remaining > 0
    union select r.currency from finance_v3.reserves r where r.organization_id = p_org and r.is_active
    union select s.base_currency) x;
  foreach c in array v_ccys loop
    j := finance_v3.safe_to_spend_json(p_org, c);
    v_list := v_list || jsonb_build_array(j);
    v_safe := (j ->> 'safe_to_spend')::numeric;
    if c = s.base_currency then
      v_rate := 1; v_rate_date := null;
    else
      select r.rate, r.rate_date into v_rate, v_rate_date from finance_v3.resolve_fx(p_org, c, s.base_currency, current_date, 3650) r;
    end if;
    if v_rate is null then
      if v_safe > 0 then v_missing := v_missing || to_jsonb(c); end if;
    else
      v_total := v_total + round(v_safe * v_rate, finance_v3.minor_unit(s.base_currency)::integer);
      if c <> s.base_currency and v_safe > 0 then
        v_est := v_est || jsonb_build_array(jsonb_build_object('currency', c, 'rate', v_rate::text, 'rate_date', v_rate_date));
      end if;
    end if;
  end loop;
  return jsonb_build_object('as_of', current_date, 'base_currency', s.base_currency, 'currencies', v_list,
    'base_estimate', jsonb_build_object('amount', finance_v3.money_text(v_total, s.base_currency), 'currency', s.base_currency,
      'is_estimate', true, 'rates_used', v_est, 'excluded_no_rate', v_missing,
      'note', 'Each currency is judged on its own. This total converts positive balances at the latest stored rate and is for display only.'));
end;
$$;

-- Dry run: what would happen if this money left now? Writes nothing.
create or replace function public.fin3_check_spend(p_org uuid, p_amount text, p_currency text, p_check text default 'spend', p_project uuid default null)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_ccy text; v_amt numeric; v_rel numeric := 0; v_viol jsonb; v_mode text;
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  if p_check not in ('spend', 'commitment_payment', 'reserve_contribution') then
    raise exception 'Check must be spend, commitment_payment or reserve_contribution.' using errcode = 'V3011';
  end if;
  v_ccy := finance_v3.assert_currency(p_currency);
  v_amt := finance_v3.parse_money(p_amount, 'Amount', v_ccy, false);
  if p_project is not null and p_check = 'spend' then
    perform finance_v3.assert_project(p_org, p_project);
    v_rel := finance_v3.releasable_allocation(p_org, p_project, v_ccy, v_amt);
  end if;
  v_viol := finance_v3.protection_violations(p_org, p_check, v_amt, v_ccy, v_rel, null);
  select coalesce(max(ps.mode), 'block') into v_mode from finance_v3.protection_settings ps where ps.organization_id = p_org;
  return jsonb_build_object('allowed', jsonb_array_length(v_viol) = 0, 'mode', v_mode, 'violations', v_viol,
    'would_use_project_allocation', finance_v3.money_text(v_rel, v_ccy));
end;
$$;

create or replace function public.fin3_list_protection_events(p_org uuid, p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  return coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'rule', e.rule, 'outcome', e.outcome, 'check', e.check_kind,
      'subject_type', e.subject_type, 'subject_id', e.subject_id, 'amount', finance_v3.money_text(e.amount, e.currency), 'currency', e.currency,
      'available', finance_v3.money_text(e.available, e.currency), 'shortfall', finance_v3.money_text(e.shortfall, e.currency),
      'reason', e.reason, 'actor', e.actor, 'at', e.at) order by e.at desc, e.id desc)
    from (select * from finance_v3.protection_events x where x.organization_id = p_org order by x.at desc, x.id desc
           limit finance_v3.clamp_limit(p_limit) offset finance_v3.clamp_offset(p_offset)) e), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Project finance
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.pf_json(pf finance_v3.project_finance)
returns jsonb language sql stable set search_path = pg_catalog, finance_v3 as $$
  select jsonb_build_object('id', pf.id, 'project_id', pf.project_id, 'client_id', pf.client_id, 'currency', pf.currency,
    'contract_value', finance_v3.money_text(pf.contract_value, pf.currency), 'budget_total', finance_v3.money_text(pf.budget_total, pf.currency),
    'animator_budget', finance_v3.money_text(pf.animator_budget, pf.currency), 'production_budget', finance_v3.money_text(pf.production_budget, pf.currency),
    'is_active', pf.is_active, 'notes', pf.notes);
$$;

create or replace function public.fin3_upsert_project_finance(p_org uuid, p_project uuid, p_values jsonb)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.approve');
  pf finance_v3.project_finance; v_old jsonb; v_ccy text; v_client uuid; v_cv numeric; v_bt numeric; v_ab numeric; v_pb numeric; v_notes text; v_active boolean;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  perform finance_v3.assert_project(p_org, p_project);
  perform finance_v3.assert_keys_allowed(p_values, array['client_id', 'currency', 'contract_value', 'budget_total', 'animator_budget', 'production_budget', 'notes', 'is_active'], 'project finance');
  select * into pf from finance_v3.project_finance x where x.organization_id = p_org and x.project_id = p_project for update;
  v_ccy := case when found then pf.currency else finance_v3.assert_currency(p_values ->> 'currency') end;
  if found and p_values ? 'currency' and upper(p_values ->> 'currency') <> pf.currency then
    raise exception 'The currency of a project cannot be changed once it is set up.' using errcode = 'V3011';
  end if;
  v_cv := case when p_values ? 'contract_value' then finance_v3.money_field(p_values, 'contract_value', 'Contract value', v_ccy, true) else coalesce(pf.contract_value, 0) end;
  v_bt := case when p_values ? 'budget_total' then finance_v3.money_field(p_values, 'budget_total', 'Budget', v_ccy, true) else coalesce(pf.budget_total, 0) end;
  v_ab := case when p_values ? 'animator_budget' then finance_v3.money_field(p_values, 'animator_budget', 'Animator budget', v_ccy, true) else coalesce(pf.animator_budget, 0) end;
  v_pb := case when p_values ? 'production_budget' then finance_v3.money_field(p_values, 'production_budget', 'Production budget', v_ccy, true) else coalesce(pf.production_budget, 0) end;
  v_notes := case when p_values ? 'notes' then nullif(btrim(p_values ->> 'notes'), '') else pf.notes end;
  v_active := case when p_values ? 'is_active' then (p_values ->> 'is_active')::boolean else coalesce(pf.is_active, true) end;
  if p_values ? 'client_id' and nullif(p_values ->> 'client_id', '') is not null then
    if not finance_v3.valid_uuid(p_values ->> 'client_id') then raise exception 'Invalid client.' using errcode = 'V3011'; end if;
    v_client := (p_values ->> 'client_id')::uuid;
    if not exists (select 1 from finance_v3.contacts_v3 c where c.organization_id = p_org and c.id = v_client and c.kind = 'client') then
      raise exception 'Choose a client of this studio.' using errcode = 'V3010';
    end if;
  elsif p_values ? 'client_id' then v_client := null;
  else v_client := pf.client_id; end if;
  begin
    if pf.id is null then
      insert into finance_v3.project_finance (organization_id, project_id, client_id, currency, contract_value, budget_total, animator_budget, production_budget, is_active, notes, created_by)
      values (p_org, p_project, v_client, v_ccy, v_cv, v_bt, v_ab, v_pb, v_active, v_notes, v_uid) returning * into pf;
    else
      v_old := finance_v3.pf_json(pf);
      update finance_v3.project_finance x set client_id = v_client, contract_value = v_cv, budget_total = v_bt, animator_budget = v_ab,
             production_budget = v_pb, is_active = v_active, notes = v_notes, updated_at = now()
       where x.id = pf.id returning * into pf;
    end if;
  exception when check_violation then
    raise exception 'The animator and production budgets cannot exceed the total budget.' using errcode = 'V3011';
  end;
  perform finance_v3.write_audit(p_org, v_uid, 'upsert_project_finance', 'project_finance', pf.id::text, v_old, finance_v3.pf_json(pf), null);
  return finance_v3.pf_json(pf);
end;
$$;

-- The project's financial picture, in the project's currency. Cash and accounting profitability are separate blocks on purpose.
create or replace function finance_v3.project_financials(p_org uuid, p_project uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  pf finance_v3.project_finance; c text; f jsonb;
  v_invoiced numeric; v_cl_out numeric; v_rev numeric; v_costs numeric; v_anim_cost numeric; v_fees numeric;
  v_anim_sub numeric; v_anim_appr numeric; v_draft_bills numeric; v_profit numeric; v_committed numeric; v_remaining numeric;
  v_received numeric; v_paid_out numeric; v_other_ccy integer; v_bill_out numeric; v_anim_out numeric; v_anim_paid numeric;
begin
  select * into pf from finance_v3.project_finance x where x.organization_id = p_org and x.project_id = p_project;
  if not found then raise exception 'Set up finance for this project first.' using errcode = 'V3010'; end if;
  c := pf.currency;
  f := finance_v3.project_funds(p_org, p_project);
  v_received := (f ->> 'client_money_received')::numeric; v_paid_out := (f ->> 'paid_out')::numeric;
  v_anim_out := (f ->> 'committed_to_animators')::numeric; v_bill_out := (f ->> 'committed_to_bills')::numeric; v_anim_paid := (f ->> 'animator_paid')::numeric;

  select coalesce(sum(r.total - r.credit_total), 0), coalesce(sum(r.outstanding) filter (where r.status in ('issued', 'partially_paid')), 0)
    into v_invoiced, v_cl_out
    from finance_v3.receivables r
   where r.organization_id = p_org and r.project_id = p_project and r.currency = c and r.status in ('issued', 'partially_paid', 'paid', 'credited');

  select coalesce(sum(case when a.account_type = 'revenue' then case l.side when 'credit' then l.amount_native else -l.amount_native end else 0 end), 0),
         coalesce(sum(case when a.account_type in ('cost_of_sales', 'operating_expense') then case l.side when 'debit' then l.amount_native else -l.amount_native end else 0 end), 0),
         coalesce(sum(case when a.system_key = 'cos_animator' then case l.side when 'debit' then l.amount_native else -l.amount_native end else 0 end), 0),
         coalesce(sum(case when a.system_key = 'bank_fees' then case l.side when 'debit' then l.amount_native else -l.amount_native end else 0 end), 0)
    into v_rev, v_costs, v_anim_cost, v_fees
    from finance_v3.journal_lines l
    join finance_v3.journal_entries e on e.id = l.entry_id
    join finance_v3.accounts a on a.organization_id = l.organization_id and a.id = l.account_id
   where l.organization_id = p_org and e.status = 'posted' and l.currency = c and coalesce(l.project_id, e.project_id) = p_project;

  select coalesce(sum(w.submitted_amount) filter (where w.status = 'submitted'), 0), coalesce(sum(w.approved_amount) filter (where w.status = 'approved'), 0)
    into v_anim_sub, v_anim_appr
    from finance_v3.animator_work_items w join finance_v3.animator_assignments a on a.organization_id = w.organization_id and a.id = w.assignment_id
   where w.organization_id = p_org and a.project_id = p_project and w.currency = c;
  select coalesce(sum(b.total), 0) into v_draft_bills from finance_v3.payables b
   where b.organization_id = p_org and b.project_id = p_project and b.currency = c and b.status = 'draft';
  select (select count(*) from finance_v3.animator_work_items w join finance_v3.animator_assignments a on a.organization_id = w.organization_id and a.id = w.assignment_id
           where w.organization_id = p_org and a.project_id = p_project and w.currency <> c and w.status in ('submitted', 'approved'))
       + (select count(*) from finance_v3.receivables r where r.organization_id = p_org and r.project_id = p_project and r.currency <> c and r.status <> 'draft' and r.status <> 'void')
       + (select count(*) from finance_v3.expense_records e where e.organization_id = p_org and e.project_id = p_project and e.currency <> c)
    into v_other_ccy;

  v_profit := v_rev - v_costs;
  v_committed := v_anim_sub + v_draft_bills;
  v_remaining := case when pf.budget_total > 0 then pf.budget_total - v_costs - v_committed else null end;
  return jsonb_build_object(
    'project_id', p_project, 'currency', c, 'is_active', pf.is_active,
    'contract', jsonb_build_object('contract_value', finance_v3.money_text(pf.contract_value, c), 'invoiced', finance_v3.money_text(v_invoiced, c),
      'client_payments_received', finance_v3.money_text(v_received, c), 'client_payments_outstanding', finance_v3.money_text(v_cl_out, c),
      'not_yet_invoiced', finance_v3.money_text(greatest(pf.contract_value - v_invoiced, 0), c)),
    'budget', jsonb_build_object('total', finance_v3.money_text(pf.budget_total, c), 'animator', finance_v3.money_text(pf.animator_budget, c),
      'production', finance_v3.money_text(pf.production_budget, c),
      'animator_budget_remaining', case when pf.animator_budget > 0 then finance_v3.money_text(pf.animator_budget - v_anim_appr, c) else null end,
      'remaining', case when v_remaining is null then null else finance_v3.money_text(v_remaining, c) end),
    'animators', jsonb_build_object('submitted_awaiting_approval', finance_v3.money_text(v_anim_sub, c), 'approved_costs', finance_v3.money_text(v_anim_appr, c),
      'paid', finance_v3.money_text(v_anim_paid, c), 'outstanding_obligations', finance_v3.money_text(v_anim_out, c)),
    'costs', jsonb_build_object('actual_costs', finance_v3.money_text(v_costs, c), 'animator_costs', finance_v3.money_text(v_anim_cost, c),
      'other_production_expenses', finance_v3.money_text(v_costs - v_anim_cost - v_fees, c), 'transfer_and_payment_fees', finance_v3.money_text(v_fees, c),
      'committed_costs', finance_v3.money_text(v_committed, c),
      'committed_note', 'Committed = animator work submitted but not yet approved, plus draft bills. Approved work is already an actual cost.'),
    'accounting', jsonb_build_object('revenue', finance_v3.money_text(v_rev, c), 'profit', finance_v3.money_text(v_profit, c),
      'margin_percent', case when v_rev > 0 then round(v_profit * 100 / v_rev, 2)::text else null end),
    'cash', jsonb_build_object('received_from_client', finance_v3.money_text(v_received, c), 'paid_out', finance_v3.money_text(v_paid_out, c),
      'net_cash_position', finance_v3.money_text(v_received - v_paid_out, c), 'still_owed_to_animators_and_bills', finance_v3.money_text(v_anim_out + v_bill_out, c)),
    'funds', f - '_unallocated_raw',
    'other_currency_records', v_other_ccy,
    'warnings', (select coalesce(jsonb_agg(w), '[]'::jsonb) from (
        select 'Some records of this project are in another currency and are not included in these figures.' w where v_other_ccy > 0
        union all select 'Approved animator costs are over the animator budget.' where pf.animator_budget > 0 and v_anim_appr > pf.animator_budget
        union all select 'Actual and committed costs are over the project budget.' where v_remaining is not null and v_remaining < 0
        union all select 'More money is committed on this project than the client has paid.' where v_anim_out + v_bill_out > v_received - v_paid_out) q));
end;
$$;

create or replace function public.fin3_get_project_financials(p_org uuid, p_project uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.assert_project(p_org, p_project);
  return finance_v3.project_financials(p_org, p_project);
end;
$$;

create or replace function public.fin3_list_project_financials(p_org uuid, p_include_inactive boolean default false, p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  return coalesce((select jsonb_agg(finance_v3.project_financials(p_org, q.project_id) order by q.created_at, q.project_id)
    from (select * from finance_v3.project_finance x where x.organization_id = p_org and (p_include_inactive or x.is_active)
           order by x.created_at, x.project_id limit least(finance_v3.clamp_limit(p_limit), 100) offset finance_v3.clamp_offset(p_offset)) q), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Animator assignments
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.assignment_json(a finance_v3.animator_assignments)
returns jsonb language sql stable security definer set search_path = pg_catalog, finance_v3 as $$
  select jsonb_build_object('id', a.id, 'project_id', a.project_id, 'animator_id', a.animator_id,
    'animator_name', (select c.name from finance_v3.contacts_v3 c where c.organization_id = a.organization_id and c.id = a.animator_id),
    'rate_unit', a.rate_unit, 'agreed_rate', round(a.agreed_rate, 4)::text, 'currency', a.currency, 'role_label', a.role_label,
    'status', a.status, 'legacy_ref', a.legacy_ref, 'notes', a.notes);
$$;

create or replace function public.fin3_upsert_animator_assignment(p_org uuid, p_assignment jsonb)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.approve');
  a finance_v3.animator_assignments; v_old jsonb; v_proj uuid; v_anim uuid; v_ccy text; v_rate numeric; v_unit text; v_status text; v_id uuid;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  perform finance_v3.assert_keys_allowed(p_assignment, array['id', 'project_id', 'animator_id', 'rate_unit', 'agreed_rate', 'currency', 'role_label', 'status', 'legacy_ref', 'notes'], 'assignment');
  if nullif(p_assignment ->> 'id', '') is not null then
    if not finance_v3.valid_uuid(p_assignment ->> 'id') then raise exception 'Invalid assignment.' using errcode = 'V3011'; end if;
    select * into a from finance_v3.animator_assignments x where x.organization_id = p_org and x.id = (p_assignment ->> 'id')::uuid for update;
    if not found then raise exception 'Assignment not found.' using errcode = 'V3010'; end if;
    if (p_assignment ? 'project_id' and (p_assignment ->> 'project_id')::uuid is distinct from a.project_id)
       or (p_assignment ? 'animator_id' and (p_assignment ->> 'animator_id')::uuid is distinct from a.animator_id)
       or (p_assignment ? 'currency' and upper(p_assignment ->> 'currency') <> a.currency)
       or (p_assignment ? 'rate_unit' and p_assignment ->> 'rate_unit' <> a.rate_unit) then
      raise exception 'The project, animator, currency and unit of an assignment cannot change. End it and create a new one.' using errcode = 'V3011';
    end if;
    v_old := finance_v3.assignment_json(a);
    v_ccy := a.currency;
    v_rate := case when p_assignment ? 'agreed_rate' then finance_v3.parse_decimal(p_assignment -> 'agreed_rate', 'Agreed rate', 4, 0.0001, 1000000000000) else a.agreed_rate end;
    v_status := coalesce(p_assignment ->> 'status', a.status);
    if v_status not in ('active', 'ended') then raise exception 'Status must be active or ended.' using errcode = 'V3011'; end if;
    begin
      update finance_v3.animator_assignments x set agreed_rate = v_rate, status = v_status,
             role_label = case when p_assignment ? 'role_label' then nullif(btrim(p_assignment ->> 'role_label'), '') else x.role_label end,
             notes = case when p_assignment ? 'notes' then nullif(btrim(p_assignment ->> 'notes'), '') else x.notes end,
             legacy_ref = case when p_assignment ? 'legacy_ref' then nullif(btrim(p_assignment ->> 'legacy_ref'), '') else x.legacy_ref end,
             updated_at = now()
       where x.id = a.id returning * into a;
    exception when check_violation then raise exception 'One of the assignment values is not valid.' using errcode = 'V3011';
              when unique_violation then raise exception 'This animator already has an active assignment for this project and unit.' using errcode = 'V3017'; end;
  else
    if not finance_v3.valid_uuid(p_assignment ->> 'project_id') or not finance_v3.valid_uuid(p_assignment ->> 'animator_id') then
      raise exception 'Choose a project and an animator.' using errcode = 'V3011';
    end if;
    v_proj := (p_assignment ->> 'project_id')::uuid; v_anim := (p_assignment ->> 'animator_id')::uuid;
    perform finance_v3.assert_project(p_org, v_proj);
    if not exists (select 1 from finance_v3.contacts_v3 c where c.organization_id = p_org and c.id = v_anim and c.kind = 'freelancer' and c.is_active) then
      raise exception 'Choose an active freelancer (animator) of this studio.' using errcode = 'V3010';
    end if;
    v_ccy := finance_v3.assert_currency(p_assignment ->> 'currency');
    v_unit := p_assignment ->> 'rate_unit';
    v_rate := finance_v3.parse_decimal(p_assignment -> 'agreed_rate', 'Agreed rate', 4, 0.0001, 1000000000000);
    begin
      insert into finance_v3.animator_assignments (organization_id, project_id, animator_id, rate_unit, agreed_rate, currency, role_label, legacy_ref, notes, created_by)
      values (p_org, v_proj, v_anim, v_unit, v_rate, v_ccy, nullif(btrim(p_assignment ->> 'role_label'), ''), nullif(btrim(p_assignment ->> 'legacy_ref'), ''),
              nullif(btrim(p_assignment ->> 'notes'), ''), v_uid) returning * into a;
    exception when check_violation then raise exception 'One of the assignment values is not valid.' using errcode = 'V3011';
              when unique_violation then raise exception 'This animator already has an active assignment for this project and unit.' using errcode = 'V3017'; end;
  end if;
  perform finance_v3.write_audit(p_org, v_uid, 'upsert_animator_assignment', 'animator_assignment', a.id::text, v_old, finance_v3.assignment_json(a), null);
  return finance_v3.assignment_json(a);
end;
$$;

create or replace function public.fin3_list_animator_assignments(p_org uuid, p_project uuid default null, p_animator uuid default null, p_include_ended boolean default false)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  return coalesce((select jsonb_agg(finance_v3.assignment_json(a) order by a.created_at, a.id)
    from finance_v3.animator_assignments a
   where a.organization_id = p_org and (p_project is null or a.project_id = p_project) and (p_animator is null or a.animator_id = p_animator)
     and (p_include_ended or a.status = 'active')), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Animator work and obligations
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.work_json(w finance_v3.animator_work_items)
returns jsonb language sql stable security definer set search_path = pg_catalog, finance_v3 as $$
  select jsonb_build_object('id', w.id, 'assignment_id', w.assignment_id, 'project_id', a.project_id, 'animator_id', a.animator_id,
    'animator_name', (select c.name from finance_v3.contacts_v3 c where c.organization_id = w.organization_id and c.id = a.animator_id),
    'work_ref', w.work_ref, 'description', w.description, 'rate_unit', a.rate_unit, 'currency', w.currency, 'rate', round(w.rate, 4)::text,
    'submitted_quantity', round(w.submitted_quantity, 4)::text, 'submitted_amount', finance_v3.money_text(w.submitted_amount, w.currency),
    'status', w.status, 'approved_quantity', round(w.approved_quantity, 4)::text,
    'approved_amount', case when w.approved_amount is null then null else finance_v3.money_text(w.approved_amount, w.currency) end,
    'amount_paid', finance_v3.money_text(w.amount_paid, w.currency), 'outstanding', finance_v3.money_text(w.outstanding, w.currency),
    'payment_status', w.payment_status, 'due_date', w.due_date, 'submitted_on', w.submitted_on,
    'is_overdue', (w.status = 'approved' and w.outstanding > 0 and w.due_date is not null and w.due_date < current_date),
    'decision_reason', w.decision_reason, 'approved_at', w.approved_at)
  from finance_v3.animator_assignments a where a.organization_id = w.organization_id and a.id = w.assignment_id;
$$;

create or replace function public.fin3_submit_animator_work(p_org uuid, p_key text, p_assignment uuid, p_work jsonb)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.post');
  a finance_v3.animator_assignments; w finance_v3.animator_work_items; v_qty numeric; v_amt numeric; v_due date; v_ref text;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  perform finance_v3.assert_key(p_key);
  select * into w from finance_v3.animator_work_items x where x.organization_id = p_org and x.idempotency_key = p_key;
  if found then return finance_v3.work_json(w); end if;
  perform finance_v3.assert_keys_allowed(p_work, array['work_ref', 'description', 'quantity', 'due_date'], 'work');
  select * into a from finance_v3.animator_assignments x where x.organization_id = p_org and x.id = p_assignment;
  if not found then raise exception 'Assignment not found.' using errcode = 'V3010'; end if;
  if a.status <> 'active' then raise exception 'This assignment has ended.' using errcode = 'V3017'; end if;
  v_ref := nullif(btrim(p_work ->> 'work_ref'), '');
  if v_ref is null or char_length(v_ref) > 80 then raise exception 'A work reference (such as a shot code) is required.' using errcode = 'V3011'; end if;
  v_qty := finance_v3.parse_decimal(p_work -> 'quantity', 'Quantity', 4, 0.0001, 1000000000);
  v_amt := round(v_qty * a.agreed_rate, finance_v3.minor_unit(a.currency)::integer);
  if v_amt <= 0 then raise exception 'The amount for this quantity rounds to zero.' using errcode = 'V3011'; end if;
  if nullif(p_work ->> 'due_date', '') is not null then
    begin v_due := (p_work ->> 'due_date')::date; exception when others then raise exception 'The due date is not valid.' using errcode = 'V3011'; end;
  end if;
  begin
    insert into finance_v3.animator_work_items (organization_id, assignment_id, work_ref, description, currency, rate, submitted_quantity, submitted_amount,
                                                due_date, idempotency_key, created_by)
    values (p_org, a.id, v_ref, btrim(coalesce(p_work ->> 'description', '')), a.currency, a.agreed_rate, v_qty, v_amt, v_due, p_key, v_uid) returning * into w;
  exception when unique_violation then
    raise exception 'Work "%" is already recorded for this animator and project.', v_ref using errcode = 'V3017';
  when check_violation then
    raise exception 'One of the work values is not valid.' using errcode = 'V3011'; end;
  perform finance_v3.write_audit(p_org, v_uid, 'submit_animator_work', 'animator_work', w.id::text, null, finance_v3.work_json(w), null);
  return finance_v3.work_json(w);
end;
$$;

-- Approval creates the obligation: Dr Animator Costs / Cr Animator and Freelancer Payables, both tagged with the project.
create or replace function public.fin3_approve_animator_work(p_org uuid, p_work uuid, p_approved_quantity text default null, p_date date default null)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.approve');
  w finance_v3.animator_work_items; a finance_v3.animator_assignments; v_qty numeric; v_amt numeric; v_date date; v_entry uuid; v_name text;
  v_budget numeric; v_total numeric; v_warn jsonb := '[]'::jsonb;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  select * into w from finance_v3.animator_work_items x where x.organization_id = p_org and x.id = p_work for update;
  if not found then raise exception 'Work item not found.' using errcode = 'V3010'; end if;
  if w.status = 'approved' then return finance_v3.work_json(w); end if;                              -- replay
  if w.status <> 'submitted' then raise exception 'Only submitted work can be approved.' using errcode = 'V3017'; end if;
  select * into a from finance_v3.animator_assignments x where x.organization_id = p_org and x.id = w.assignment_id;
  v_qty := case when p_approved_quantity is null then w.submitted_quantity
                else finance_v3.parse_decimal(to_jsonb(p_approved_quantity), 'Approved quantity', 4, 0.0001, 1000000000) end;
  if v_qty > w.submitted_quantity then raise exception 'You cannot approve more than was submitted.' using errcode = 'V3012'; end if;
  v_amt := round(v_qty * w.rate, finance_v3.minor_unit(w.currency)::integer);
  if v_amt <= 0 then raise exception 'The approved amount rounds to zero.' using errcode = 'V3011'; end if;
  v_date := coalesce(p_date, current_date);
  if v_date > current_date + 1 then raise exception 'The accounting date is not valid.' using errcode = 'V3011'; end if;
  select c.name into v_name from finance_v3.contacts_v3 c where c.organization_id = p_org and c.id = a.animator_id;
  v_entry := finance_v3.post_event(p_org, 'animator_obligation', 'fin3:animator:' || w.id::text || ':approve', v_date,
    jsonb_build_array(
      jsonb_build_object('account_id', finance_v3.system_account(p_org, 'cos_animator'), 'side', 'debit', 'amount', finance_v3.money_text(v_amt, w.currency), 'currency', w.currency, 'project_id', a.project_id),
      jsonb_build_object('account_id', finance_v3.system_account(p_org, 'animator_payables'), 'side', 'credit', 'amount', finance_v3.money_text(v_amt, w.currency), 'currency', w.currency, 'project_id', a.project_id)),
    jsonb_build_object('memo', left('Animator work ' || w.work_ref || ' - ' || coalesce(v_name, 'animator'), 500), 'reference', left(w.work_ref, 120), 'project_id', a.project_id));
  update finance_v3.animator_work_items x set status = 'approved', approved_quantity = v_qty, approved_amount = v_amt, approved_entry_id = v_entry,
         approved_by = v_uid, approved_at = now(), updated_at = now() where x.id = w.id returning * into w;
  perform finance_v3.write_audit(p_org, v_uid, 'approve_animator_work', 'animator_work', w.id::text, null,
    jsonb_build_object('approved_amount', finance_v3.money_text(v_amt, w.currency), 'currency', w.currency, 'entry_id', v_entry), null);
  select pf.animator_budget into v_budget from finance_v3.project_finance pf where pf.organization_id = p_org and pf.project_id = a.project_id and pf.currency = w.currency;
  if v_budget is not null and v_budget > 0 then
    select coalesce(sum(x.approved_amount), 0) into v_total from finance_v3.animator_work_items x
      join finance_v3.animator_assignments aa on aa.organization_id = x.organization_id and aa.id = x.assignment_id
     where x.organization_id = p_org and aa.project_id = a.project_id and x.currency = w.currency and x.status = 'approved';
    if v_total > v_budget then
      v_warn := jsonb_build_array('Approved animator costs for this project (' || w.currency || ' ' || finance_v3.money_text(v_total, w.currency) ||
                                  ') are over the animator budget (' || finance_v3.money_text(v_budget, w.currency) || ').');
    end if;
  end if;
  return finance_v3.work_json(w) || jsonb_build_object('warnings', v_warn);
end;
$$;

create or replace function public.fin3_reject_animator_work(p_org uuid, p_work uuid, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.approve');
  w finance_v3.animator_work_items; v_reason text := nullif(btrim(p_reason), '');
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  if v_reason is null or char_length(v_reason) > 500 then raise exception 'A reason is required.' using errcode = 'V3011'; end if;
  select * into w from finance_v3.animator_work_items x where x.organization_id = p_org and x.id = p_work for update;
  if not found then raise exception 'Work item not found.' using errcode = 'V3010'; end if;
  if w.status = 'rejected' then return finance_v3.work_json(w); end if;
  if w.status <> 'submitted' then raise exception 'Only submitted work can be rejected.' using errcode = 'V3017'; end if;
  update finance_v3.animator_work_items x set status = 'rejected', decision_reason = v_reason, updated_at = now() where x.id = w.id returning * into w;
  perform finance_v3.write_audit(p_org, v_uid, 'reject_animator_work', 'animator_work', w.id::text, null, null, v_reason);
  return finance_v3.work_json(w);
end;
$$;

-- Void: submitted work is simply withdrawn; approved work with no payments reverses its obligation. Paid work needs its payments reversed first.
create or replace function public.fin3_void_animator_work(p_org uuid, p_work uuid, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.approve');
  w finance_v3.animator_work_items; v_reason text := nullif(btrim(p_reason), ''); v_rev uuid;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  if v_reason is null or char_length(v_reason) > 500 then raise exception 'A reason is required.' using errcode = 'V3011'; end if;
  select * into w from finance_v3.animator_work_items x where x.organization_id = p_org and x.id = p_work for update;
  if not found then raise exception 'Work item not found.' using errcode = 'V3010'; end if;
  if w.status = 'void' then return finance_v3.work_json(w); end if;
  if w.status = 'rejected' then raise exception 'Rejected work is already closed.' using errcode = 'V3017'; end if;
  if w.status = 'approved' then
    if w.amount_paid > 0 then raise exception 'This work has payments. Reverse them before voiding it.' using errcode = 'V3017'; end if;
    v_rev := finance_v3.reverse_entry(p_org, w.approved_entry_id, 'fin3:animator:' || w.id::text || ':void', v_reason, null);
  end if;
  update finance_v3.animator_work_items x set status = 'void', void_entry_id = v_rev, decision_reason = v_reason, updated_at = now() where x.id = w.id returning * into w;
  perform finance_v3.write_audit(p_org, v_uid, 'void_animator_work', 'animator_work', w.id::text, null, jsonb_build_object('reversal_entry_id', v_rev), v_reason);
  return finance_v3.work_json(w);
end;
$$;

create or replace function finance_v3.apay_json(p finance_v3.animator_payments)
returns jsonb language sql stable set search_path = pg_catalog, finance_v3 as $$
  select jsonb_build_object('id', p.id, 'work_item_id', p.work_item_id, 'amount', finance_v3.money_text(p.amount, p.currency), 'currency', p.currency,
    'paid_on', p.paid_on, 'pay_account_id', p.pay_account_id, 'reference', p.reference, 'status', p.status, 'entry_id', p.entry_id, 'created_at', p.created_at);
$$;

create or replace function public.fin3_pay_animator(p_org uuid, p_key text, p_work uuid, p_amount text, p_paid_on date, p_pay_account uuid,
                                                    p_reference text default null, p_override jsonb default null)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.pay');
  w finance_v3.animator_work_items; a finance_v3.animator_assignments; ap finance_v3.animator_payments; v_amt numeric; v_entry uuid; v_prot jsonb; v_name text;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  perform finance_v3.assert_key(p_key);
  select * into ap from finance_v3.animator_payments x where x.organization_id = p_org and x.idempotency_key = p_key;
  if found then
    select * into w from finance_v3.animator_work_items x where x.organization_id = p_org and x.id = ap.work_item_id;
    return finance_v3.work_json(w) || jsonb_build_object('payment', finance_v3.apay_json(ap));              -- duplicate submission: original result
  end if;
  select * into w from finance_v3.animator_work_items x where x.organization_id = p_org and x.id = p_work for update;
  if not found then raise exception 'Work item not found.' using errcode = 'V3010'; end if;
  if w.status <> 'approved' or w.outstanding <= 0 then raise exception 'Only approved work with an unpaid balance can be paid.' using errcode = 'V3017'; end if;
  if p_paid_on is null or p_paid_on > current_date + 1 then raise exception 'The payment date is not valid.' using errcode = 'V3011'; end if;
  v_amt := finance_v3.parse_money(p_amount, 'Payment amount', w.currency, false);
  if v_amt > w.outstanding then
    raise exception 'The payment (%) is more than the outstanding balance (%).', finance_v3.money_text(v_amt, w.currency), finance_v3.money_text(w.outstanding, w.currency) using errcode = 'V3012';
  end if;
  perform finance_v3.assert_cash_account(p_org, p_pay_account, w.currency);
  select * into a from finance_v3.animator_assignments x where x.organization_id = p_org and x.id = w.assignment_id;
  v_prot := finance_v3.enforce_protection(p_org, v_uid, 'commitment_payment', v_amt, w.currency, 0, 'animator_work', w.id::text, p_override);
  select c.name into v_name from finance_v3.contacts_v3 c where c.organization_id = p_org and c.id = a.animator_id;
  v_entry := finance_v3.post_event(p_org, 'animator_payment', 'fin3:animator:' || w.id::text || ':pay:' || finance_v3.key_hash(p_key), p_paid_on,
    jsonb_build_array(
      jsonb_build_object('account_id', finance_v3.system_account(p_org, 'animator_payables'), 'side', 'debit', 'amount', finance_v3.money_text(v_amt, w.currency), 'currency', w.currency, 'project_id', a.project_id),
      jsonb_build_object('account_id', p_pay_account, 'side', 'credit', 'amount', finance_v3.money_text(v_amt, w.currency), 'currency', w.currency)),
    jsonb_strip_nulls(jsonb_build_object('memo', left('Payment to ' || coalesce(v_name, 'animator') || ' for ' || w.work_ref, 500),
      'reference', left(coalesce(nullif(btrim(p_reference), ''), w.work_ref), 120), 'project_id', a.project_id)));
  insert into finance_v3.animator_payments (organization_id, work_item_id, amount, currency, paid_on, pay_account_id, reference, entry_id, idempotency_key, created_by)
  values (p_org, w.id, v_amt, w.currency, p_paid_on, p_pay_account, nullif(btrim(p_reference), ''), v_entry, p_key, v_uid) returning * into ap;
  update finance_v3.animator_work_items x set amount_paid = x.amount_paid + v_amt, updated_at = now() where x.id = w.id returning * into w;
  perform finance_v3.write_audit(p_org, v_uid, 'pay_animator', 'animator_work', w.id::text, null,
    jsonb_build_object('amount', finance_v3.money_text(v_amt, w.currency), 'entry_id', v_entry), null);
  return finance_v3.work_json(w) || jsonb_build_object('payment', finance_v3.apay_json(ap)) || finance_v3.prot_json(v_prot);
end;
$$;

create or replace function public.fin3_reverse_animator_payment(p_org uuid, p_payment uuid, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.approve');
  ap finance_v3.animator_payments; w finance_v3.animator_work_items; v_reason text := nullif(btrim(p_reason), '');
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  if v_reason is null or char_length(v_reason) > 500 then raise exception 'A reason is required.' using errcode = 'V3011'; end if;
  select * into ap from finance_v3.animator_payments x where x.organization_id = p_org and x.id = p_payment for update;
  if not found then raise exception 'Payment not found.' using errcode = 'V3010'; end if;
  select * into w from finance_v3.animator_work_items x where x.organization_id = p_org and x.id = ap.work_item_id for update;
  if ap.status = 'reversed' then return finance_v3.work_json(w) || jsonb_build_object('payment', finance_v3.apay_json(ap)); end if;
  perform finance_v3.reverse_entry(p_org, ap.entry_id, 'fin3:animatorpay:' || ap.id::text || ':reverse', v_reason, null);
  update finance_v3.animator_payments x set status = 'reversed' where x.id = ap.id returning * into ap;
  update finance_v3.animator_work_items x set amount_paid = x.amount_paid - ap.amount, updated_at = now() where x.id = w.id returning * into w;
  perform finance_v3.write_audit(p_org, v_uid, 'reverse_animator_payment', 'animator_work', w.id::text, null, jsonb_build_object('payment_id', ap.id), v_reason);
  return finance_v3.work_json(w) || jsonb_build_object('payment', finance_v3.apay_json(ap));
end;
$$;

create or replace function public.fin3_list_animator_obligations(
  p_org uuid, p_animator uuid default null, p_project uuid default null, p_currency text default null,
  p_status text default null, p_outstanding_only boolean default false, p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  if p_status is not null and p_status not in ('submitted', 'approved', 'rejected', 'void') then raise exception 'Unknown status.' using errcode = 'V3011'; end if;
  return coalesce((select jsonb_agg(finance_v3.work_json(q) order by q.created_at desc, q.id)
    from (select w.* from finance_v3.animator_work_items w join finance_v3.animator_assignments a on a.organization_id = w.organization_id and a.id = w.assignment_id
           where w.organization_id = p_org and (p_animator is null or a.animator_id = p_animator) and (p_project is null or a.project_id = p_project)
             and (p_currency is null or w.currency = upper(p_currency)) and (p_status is null or w.status = p_status)
             and (not p_outstanding_only or w.outstanding > 0)
           order by w.created_at desc, w.id limit finance_v3.clamp_limit(p_limit) offset finance_v3.clamp_offset(p_offset)) q), '[]'::jsonb);
end;
$$;

-- One animator: what they earned, were paid and are still owed, per currency, with the open items.
create or replace function public.fin3_animator_statement(p_org uuid, p_animator uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare v_name text;
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  select c.name into v_name from finance_v3.contacts_v3 c where c.organization_id = p_org and c.id = p_animator and c.kind = 'freelancer';
  if v_name is null then raise exception 'Animator not found.' using errcode = 'V3010'; end if;
  return jsonb_build_object('animator_id', p_animator, 'animator_name', v_name,
    'totals', coalesce((select jsonb_agg(jsonb_build_object('currency', t.currency, 'earned', finance_v3.money_text(t.earned, t.currency),
        'paid', finance_v3.money_text(t.paid, t.currency), 'outstanding', finance_v3.money_text(t.outstanding, t.currency),
        'overdue', finance_v3.money_text(t.overdue, t.currency)) order by t.currency)
      from (select w.currency, sum(w.approved_amount) earned, sum(w.amount_paid) paid, sum(w.outstanding) outstanding,
                   coalesce(sum(w.outstanding) filter (where w.due_date < current_date), 0) overdue
              from finance_v3.animator_work_items w join finance_v3.animator_assignments a on a.organization_id = w.organization_id and a.id = w.assignment_id
             where w.organization_id = p_org and a.animator_id = p_animator and w.status = 'approved' group by w.currency) t), '[]'::jsonb),
    'open_items', coalesce((select jsonb_agg(finance_v3.work_json(q) order by q.due_date nulls last, q.created_at)
      from (select w.* from finance_v3.animator_work_items w join finance_v3.animator_assignments a on a.organization_id = w.organization_id and a.id = w.assignment_id
             where w.organization_id = p_org and a.animator_id = p_animator and w.status in ('submitted', 'approved') and (w.status = 'submitted' or w.outstanding > 0)
             order by w.due_date nulls last, w.created_at limit 200) q), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(finance_v3.apay_json(q) order by q.paid_on desc, q.created_at desc)
      from (select p.* from finance_v3.animator_payments p join finance_v3.animator_work_items w on w.organization_id = p.organization_id and w.id = p.work_item_id
              join finance_v3.animator_assignments a on a.organization_id = w.organization_id and a.id = w.assignment_id
             where p.organization_id = p_org and a.animator_id = p_animator order by p.paid_on desc, p.created_at desc limit 100) q), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Fund allocations (logical set-asides of a project's money)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.alloc_json(a finance_v3.fund_allocations)
returns jsonb language sql stable set search_path = pg_catalog, finance_v3 as $$
  select jsonb_build_object('id', a.id, 'project_id', a.project_id, 'purpose', a.purpose, 'currency', a.currency,
    'amount', finance_v3.money_text(a.amount, a.currency), 'used', finance_v3.money_text(a.amount_used, a.currency),
    'released', finance_v3.money_text(a.amount_released, a.currency), 'remaining', finance_v3.money_text(a.remaining, a.currency),
    'status', case when a.remaining > 0 then 'active' else 'closed' end, 'note', a.note, 'created_at', a.created_at);
$$;

create or replace function public.fin3_allocate_project_funds(p_org uuid, p_key text, p_project uuid, p_purpose text, p_amount text, p_note text default null)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.approve');
  a finance_v3.fund_allocations; pf finance_v3.project_finance; v_amt numeric; v_free numeric;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  perform finance_v3.assert_key(p_key);
  select * into a from finance_v3.fund_allocations x where x.organization_id = p_org and x.idempotency_key = p_key;
  if found then return finance_v3.alloc_json(a); end if;
  if p_purpose not in ('production', 'operations') then raise exception 'Purpose must be production or operations.' using errcode = 'V3011'; end if;
  perform finance_v3.assert_project(p_org, p_project);
  select * into pf from finance_v3.project_finance x where x.organization_id = p_org and x.project_id = p_project;
  if not found then raise exception 'Set up finance for this project first.' using errcode = 'V3010'; end if;
  v_amt := finance_v3.parse_money(p_amount, 'Allocation amount', pf.currency, false);
  v_free := (finance_v3.project_funds(p_org, p_project) ->> '_unallocated_raw')::numeric;
  if v_amt > greatest(v_free, 0) then
    raise exception 'Only % % of this project''s money is unallocated, so % cannot be set aside.', pf.currency, finance_v3.money_text(greatest(v_free, 0), pf.currency),
      finance_v3.money_text(v_amt, pf.currency) using errcode = 'V3007';
  end if;
  insert into finance_v3.fund_allocations (organization_id, project_id, purpose, currency, amount, note, idempotency_key, created_by)
  values (p_org, p_project, p_purpose, pf.currency, v_amt, nullif(btrim(p_note), ''), p_key, v_uid) returning * into a;
  perform finance_v3.write_audit(p_org, v_uid, 'allocate_project_funds', 'fund_allocation', a.id::text, null, finance_v3.alloc_json(a), null);
  return finance_v3.alloc_json(a);
end;
$$;

create or replace function public.fin3_release_allocation(p_org uuid, p_allocation uuid, p_amount text default null, p_reason text default null)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.approve');
  a finance_v3.fund_allocations; v_amt numeric; v_reason text := nullif(btrim(p_reason), '');
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  if v_reason is null or char_length(v_reason) > 500 then raise exception 'A reason is required.' using errcode = 'V3011'; end if;
  select * into a from finance_v3.fund_allocations x where x.organization_id = p_org and x.id = p_allocation for update;
  if not found then raise exception 'Allocation not found.' using errcode = 'V3010'; end if;
  if a.remaining <= 0 then raise exception 'Nothing is left to release.' using errcode = 'V3017'; end if;
  v_amt := case when p_amount is null then a.remaining else finance_v3.parse_money(p_amount, 'Release amount', a.currency, false) end;
  if v_amt > a.remaining then raise exception 'Only % remains in this allocation.', finance_v3.money_text(a.remaining, a.currency) using errcode = 'V3012'; end if;
  update finance_v3.fund_allocations x set amount_released = x.amount_released + v_amt, updated_at = now() where x.id = a.id returning * into a;
  perform finance_v3.write_audit(p_org, v_uid, 'release_allocation', 'fund_allocation', a.id::text, null,
    jsonb_build_object('released', finance_v3.money_text(v_amt, a.currency)), v_reason);
  return finance_v3.alloc_json(a);
end;
$$;

create or replace function public.fin3_list_allocations(p_org uuid, p_project uuid default null, p_include_closed boolean default false)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  return coalesce((select jsonb_agg(finance_v3.alloc_json(a) order by a.created_at, a.id)
    from finance_v3.fund_allocations a
   where a.organization_id = p_org and (p_project is null or a.project_id = p_project) and (p_include_closed or a.remaining > 0)), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Business reserves
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.reserve_json(r finance_v3.reserves)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare v_cur numeric := finance_v3.reserve_balance(r.organization_id, r.id); v_status text;
begin
  v_status := case when not r.is_active then 'inactive' when v_cur < r.minimum_amount then 'below_minimum'
                   when v_cur < r.target_amount then 'below_target' else 'healthy' end;
  return jsonb_build_object('id', r.id, 'name', r.name, 'purpose', r.purpose, 'currency', r.currency, 'mode', r.mode,
    'ledger_account_id', r.ledger_account_id, 'target', finance_v3.money_text(r.target_amount, r.currency),
    'minimum', finance_v3.money_text(r.minimum_amount, r.currency), 'current', finance_v3.money_text(v_cur, r.currency),
    'gap_to_target', finance_v3.money_text(greatest(r.target_amount - v_cur, 0), r.currency),
    'percent_of_target', case when r.target_amount > 0 then round(v_cur * 100 / r.target_amount, 1)::text else null end,
    'status', v_status, 'is_active', r.is_active);
end;
$$;

create or replace function public.fin3_upsert_reserve(p_org uuid, p_reserve jsonb)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.admin');
  r finance_v3.reserves; v_old jsonb; v_ccy text; v_mode text; v_acc uuid; v_target numeric; v_min numeric; v_name text; v_active boolean;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  perform finance_v3.assert_keys_allowed(p_reserve, array['id', 'name', 'purpose', 'currency', 'mode', 'ledger_account_code', 'target_amount', 'minimum_amount', 'is_active'], 'reserve');
  if nullif(p_reserve ->> 'id', '') is not null then
    if not finance_v3.valid_uuid(p_reserve ->> 'id') then raise exception 'Invalid reserve.' using errcode = 'V3011'; end if;
    select * into r from finance_v3.reserves x where x.organization_id = p_org and x.id = (p_reserve ->> 'id')::uuid for update;
    if not found then raise exception 'Reserve not found.' using errcode = 'V3010'; end if;
    if (p_reserve ? 'currency' and upper(p_reserve ->> 'currency') <> r.currency) or (p_reserve ? 'mode' and p_reserve ->> 'mode' <> r.mode) or p_reserve ? 'ledger_account_code' then
      raise exception 'A reserve keeps its currency, type and account. Create a new reserve instead.' using errcode = 'V3011';
    end if;
    v_old := finance_v3.reserve_json(r);
    v_name := coalesce(nullif(btrim(p_reserve ->> 'name'), ''), r.name);
    v_target := case when p_reserve ? 'target_amount' then finance_v3.money_field(p_reserve, 'target_amount', 'Target', r.currency, true) else r.target_amount end;
    v_min := case when p_reserve ? 'minimum_amount' then finance_v3.money_field(p_reserve, 'minimum_amount', 'Minimum', r.currency, true) else r.minimum_amount end;
    v_active := case when p_reserve ? 'is_active' then (p_reserve ->> 'is_active')::boolean else r.is_active end;
    begin
      update finance_v3.reserves x set name = v_name, target_amount = v_target, minimum_amount = v_min, is_active = v_active,
             purpose = case when p_reserve ? 'purpose' then nullif(btrim(p_reserve ->> 'purpose'), '') else x.purpose end, updated_at = now()
       where x.id = r.id returning * into r;
    exception when check_violation then raise exception 'The minimum cannot be more than the target, and the name must be 1 to 80 characters.' using errcode = 'V3011';
              when unique_violation then raise exception 'A reserve with this name already exists.' using errcode = 'V3017'; end;
  else
    v_ccy := finance_v3.assert_currency(p_reserve ->> 'currency');
    v_mode := coalesce(p_reserve ->> 'mode', 'logical');
    if v_mode not in ('logical', 'account') then raise exception 'Mode must be logical or account.' using errcode = 'V3011'; end if;
    v_target := finance_v3.money_field(p_reserve, 'target_amount', 'Target', v_ccy, true, '0');
    v_min := finance_v3.money_field(p_reserve, 'minimum_amount', 'Minimum', v_ccy, true, '0');
    if v_mode = 'account' then
      select a.id into v_acc from finance_v3.accounts a where a.organization_id = p_org and a.code = p_reserve ->> 'ledger_account_code';
      if v_acc is null then raise exception 'Choose an existing cash or bank account for this reserve.' using errcode = 'V3010'; end if;
      perform finance_v3.assert_cash_account(p_org, v_acc, v_ccy);
      if exists (select 1 from finance_v3.accounts a where a.id = v_acc and (a.system_key is not null)) then
        raise exception 'A system account cannot be a reserve account.' using errcode = 'V3009';
      end if;
    elsif p_reserve ? 'ledger_account_code' and nullif(p_reserve ->> 'ledger_account_code', '') is not null then
      raise exception 'A logical reserve has no ledger account.' using errcode = 'V3011';
    end if;
    begin
      insert into finance_v3.reserves (organization_id, name, purpose, currency, mode, ledger_account_id, target_amount, minimum_amount, created_by)
      values (p_org, btrim(coalesce(p_reserve ->> 'name', '')), nullif(btrim(p_reserve ->> 'purpose'), ''), v_ccy, v_mode, v_acc, v_target, v_min, v_uid) returning * into r;
    exception when check_violation then raise exception 'The minimum cannot be more than the target, and the name must be 1 to 80 characters.' using errcode = 'V3011';
              when unique_violation then raise exception 'A reserve with this name or account already exists.' using errcode = 'V3017'; end;
  end if;
  perform finance_v3.write_audit(p_org, v_uid, 'upsert_reserve', 'reserve', r.id::text, v_old, finance_v3.reserve_json(r), null);
  return finance_v3.reserve_json(r);
end;
$$;

create or replace function public.fin3_move_reserve(p_org uuid, p_key text, p_reserve uuid, p_type text, p_amount text, p_moved_on date,
                                                    p_note text default null, p_override jsonb default null)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid;
  r finance_v3.reserves; m finance_v3.reserve_movements; v_amt numeric; v_prot jsonb; v_cur numeric;
begin
  if p_type not in ('contribution', 'withdrawal') then raise exception 'Kind must be contribution or withdrawal.' using errcode = 'V3011'; end if;
  v_uid := finance_v3.assert_permission(p_org, case p_type when 'contribution' then 'finance.pay' else 'finance.owner_pay' end);
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  perform finance_v3.assert_key(p_key);
  select * into m from finance_v3.reserve_movements x where x.organization_id = p_org and x.idempotency_key = p_key;
  if found then
    select * into r from finance_v3.reserves x where x.organization_id = p_org and x.id = m.reserve_id;
    return finance_v3.reserve_json(r) || jsonb_build_object('movement_id', m.id);
  end if;
  select * into r from finance_v3.reserves x where x.organization_id = p_org and x.id = p_reserve for update;
  if not found then raise exception 'Reserve not found.' using errcode = 'V3010'; end if;
  if not r.is_active then raise exception 'This reserve is not active.' using errcode = 'V3017'; end if;
  if r.mode = 'account' then
    raise exception 'This reserve is a real account. Move money into or out of it with a transfer.' using errcode = 'V3017';
  end if;
  if p_moved_on is null or p_moved_on > current_date + 1 then raise exception 'The date is not valid.' using errcode = 'V3011'; end if;
  v_amt := finance_v3.parse_money(p_amount, 'Amount', r.currency, false);
  if p_type = 'withdrawal' then
    v_cur := finance_v3.reserve_balance(p_org, r.id);
    if v_amt > v_cur then raise exception 'The reserve only holds % %.', r.currency, finance_v3.money_text(v_cur, r.currency) using errcode = 'V3012'; end if;
    v_prot := finance_v3.enforce_protection(p_org, v_uid, 'reserve_withdrawal', v_amt, r.currency, 0, 'reserve', r.id::text, p_override, r.id);
  else
    v_prot := finance_v3.enforce_protection(p_org, v_uid, 'reserve_contribution', v_amt, r.currency, 0, 'reserve', r.id::text, p_override);
  end if;
  insert into finance_v3.reserve_movements (organization_id, reserve_id, kind, amount, currency, moved_on, note, idempotency_key, created_by)
  values (p_org, r.id, p_type, v_amt, r.currency, p_moved_on, nullif(btrim(p_note), ''), p_key, v_uid) returning * into m;
  perform finance_v3.write_audit(p_org, v_uid, 'reserve_' || p_type, 'reserve', r.id::text, null,
    jsonb_build_object('amount', finance_v3.money_text(v_amt, r.currency), 'currency', r.currency), null);
  return finance_v3.reserve_json(r) || jsonb_build_object('movement_id', m.id) || finance_v3.prot_json(v_prot);
end;
$$;

create or replace function public.fin3_list_reserves(p_org uuid, p_include_inactive boolean default false)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  return coalesce((select jsonb_agg(finance_v3.reserve_json(r) order by r.name, r.id)
    from finance_v3.reserves r where r.organization_id = p_org and (p_include_inactive or r.is_active)), '[]'::jsonb);
end;
$$;

create or replace function public.fin3_reserve_history(p_org uuid, p_reserve uuid, p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare r finance_v3.reserves;
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  select * into r from finance_v3.reserves x where x.organization_id = p_org and x.id = p_reserve;
  if not found then raise exception 'Reserve not found.' using errcode = 'V3010'; end if;
  return jsonb_build_object('reserve', finance_v3.reserve_json(r), 'movements', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'kind', m.kind,
      'amount', finance_v3.money_text(m.amount, m.currency), 'currency', m.currency, 'moved_on', m.moved_on, 'note', m.note, 'created_by', m.created_by) order by m.moved_on desc, m.created_at desc)
    from (select * from finance_v3.reserve_movements x where x.organization_id = p_org and x.reserve_id = p_reserve order by x.moved_on desc, x.created_at desc
           limit finance_v3.clamp_limit(p_limit) offset finance_v3.clamp_offset(p_offset)) m), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Owner compensation
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.owner_json(o finance_v3.owner_payments)
returns jsonb language sql stable set search_path = pg_catalog, finance_v3 as $$
  select jsonb_build_object('id', o.id, 'kind', o.kind, 'classification', o.classification, 'status', o.status,
    'amount', finance_v3.money_text(o.amount, o.currency), 'currency', o.currency, 'scheduled_for', o.scheduled_for, 'paid_on', o.paid_on,
    'account_id', o.account_id, 'category_id', o.category_id, 'project_id', o.project_id, 'note', o.note, 'entry_id', o.entry_id, 'created_at', o.created_at);
$$;

-- Ledger lines and event kind for an owner payment kind. Returns the debit account, credit account and kind.
create or replace function finance_v3.owner_posting(p_org uuid, p_type text, p_cash uuid)
returns table (debit_account uuid, credit_account uuid, event_kind text)
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  if p_type = 'salary' then return query select finance_v3.system_account(p_org, 'owner_salary'), p_cash, 'owner_salary'::text;
  elsif p_type in ('draw', 'personal_withdrawal') then return query select finance_v3.system_account(p_org, 'owner_draws'), p_cash, 'owner_draw'::text;
  elsif p_type = 'contribution' then return query select p_cash, finance_v3.system_account(p_org, 'owner_contributions'), 'owner_contribution'::text;
  elsif p_type = 'reimbursement' then return query select finance_v3.system_account(p_org, 'owner_payable'), p_cash, 'owner_reimbursement'::text;
  else raise exception 'Unsupported owner payment kind.' using errcode = 'V3011';
  end if;
end;
$$;

create or replace function finance_v3.owner_payable_balance(p_org uuid, p_ccy text)
returns numeric
language sql stable security definer
set search_path = pg_catalog, finance_v3
as $$
  select coalesce(sum(case l.side when 'credit' then l.amount_native else -l.amount_native end), 0)
    from finance_v3.journal_lines l join finance_v3.journal_entries e on e.id = l.entry_id
   where l.organization_id = p_org and l.currency = p_ccy and e.status = 'posted'
     and l.account_id = (select a.id from finance_v3.accounts a where a.organization_id = p_org and a.system_key = 'owner_payable');
$$;

-- Posts an owner cash payment of any kind and returns the entry. Shared by record and execute. Protection is judged by the caller.
create or replace function finance_v3.post_owner_cash(p_org uuid, p_type text, p_event_key text, p_amount numeric, p_ccy text, p_date date, p_cash uuid, p_note text, p_ref text)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare pst record;
begin
  select * into pst from finance_v3.owner_posting(p_org, p_type, p_cash);
  return finance_v3.post_event(p_org, pst.event_kind, p_event_key, p_date,
    jsonb_build_array(
      jsonb_build_object('account_id', pst.debit_account, 'side', 'debit', 'amount', finance_v3.money_text(p_amount, p_ccy), 'currency', p_ccy),
      jsonb_build_object('account_id', pst.credit_account, 'side', 'credit', 'amount', finance_v3.money_text(p_amount, p_ccy), 'currency', p_ccy)),
    jsonb_strip_nulls(jsonb_build_object('memo', left(coalesce(nullif(btrim(p_note), ''), 'Owner ' || replace(p_type, '_', ' ')), 500), 'reference', p_ref)));
end;
$$;

create or replace function public.fin3_record_owner_payment(p_org uuid, p_key text, p_type text, p_amount text, p_currency text, p_paid_on date,
                                                            p_account uuid, p_note text default null, p_override jsonb default null)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.owner_pay');
  o finance_v3.owner_payments; v_ccy text; v_amt numeric; v_entry uuid; v_prot jsonb;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  perform finance_v3.assert_key(p_key);
  select * into o from finance_v3.owner_payments x where x.organization_id = p_org and x.idempotency_key = p_key;
  if found then return finance_v3.owner_json(o); end if;
  if p_type not in ('salary', 'draw', 'personal_withdrawal', 'contribution', 'reimbursement') then
    raise exception 'Kind must be salary, draw, personal_withdrawal, contribution or reimbursement.' using errcode = 'V3011';
  end if;
  if p_paid_on is null or p_paid_on > current_date + 1 then raise exception 'The payment date is not valid.' using errcode = 'V3011'; end if;
  v_ccy := finance_v3.assert_currency(p_currency);
  v_amt := finance_v3.parse_money(p_amount, 'Amount', v_ccy, false);
  perform finance_v3.assert_cash_account(p_org, p_account, v_ccy);
  if p_type = 'reimbursement' and v_amt > finance_v3.owner_payable_balance(p_org, v_ccy) then
    raise exception 'The studio only owes the owner % % for expenses paid personally.', v_ccy, finance_v3.money_text(finance_v3.owner_payable_balance(p_org, v_ccy), v_ccy) using errcode = 'V3012';
  end if;
  if p_type <> 'contribution' then
    v_prot := finance_v3.enforce_protection(p_org, v_uid, 'spend', v_amt, v_ccy, 0, 'owner_' || p_type, null, p_override);
  end if;
  v_entry := finance_v3.post_owner_cash(p_org, p_type, 'fin3:owner:' || finance_v3.key_hash(p_key), v_amt, v_ccy, p_paid_on, p_account, p_note, null);
  insert into finance_v3.owner_payments (organization_id, kind, status, amount, currency, paid_on, account_id, note, entry_id, idempotency_key, created_by, executed_by)
  values (p_org, p_type, 'recorded', v_amt, v_ccy, p_paid_on, p_account, nullif(btrim(p_note), ''), v_entry, p_key, v_uid, v_uid) returning * into o;
  perform finance_v3.write_audit(p_org, v_uid, 'record_owner_payment', 'owner_payment', o.id::text, null, finance_v3.owner_json(o), null);
  return finance_v3.owner_json(o) || finance_v3.prot_json(v_prot);
end;
$$;

create or replace function public.fin3_schedule_owner_payment(p_org uuid, p_key text, p_type text, p_amount text, p_currency text, p_scheduled_for date,
                                                              p_account uuid default null, p_note text default null)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.owner_pay');
  o finance_v3.owner_payments; v_ccy text; v_amt numeric;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  perform finance_v3.assert_key(p_key);
  select * into o from finance_v3.owner_payments x where x.organization_id = p_org and x.idempotency_key = p_key;
  if found then return finance_v3.owner_json(o); end if;
  if p_type not in ('salary', 'draw', 'personal_withdrawal', 'reimbursement') then
    raise exception 'Only salary, draw, personal_withdrawal or reimbursement can be scheduled.' using errcode = 'V3011';
  end if;
  if p_scheduled_for is null or p_scheduled_for < current_date or p_scheduled_for > current_date + 730 then
    raise exception 'Choose a date from today to two years ahead.' using errcode = 'V3011';
  end if;
  v_ccy := finance_v3.assert_currency(p_currency);
  v_amt := finance_v3.parse_money(p_amount, 'Amount', v_ccy, false);
  if p_account is not null then perform finance_v3.assert_cash_account(p_org, p_account, v_ccy); end if;
  insert into finance_v3.owner_payments (organization_id, kind, status, amount, currency, scheduled_for, account_id, note, idempotency_key, created_by)
  values (p_org, p_type, 'scheduled', v_amt, v_ccy, p_scheduled_for, p_account, nullif(btrim(p_note), ''), p_key, v_uid) returning * into o;
  perform finance_v3.write_audit(p_org, v_uid, 'schedule_owner_payment', 'owner_payment', o.id::text, null, finance_v3.owner_json(o), null);
  return finance_v3.owner_json(o);
end;
$$;

-- Turns a scheduled payment into a real one. The scheduled amount is already held back by safe-to-spend, so it counts as released.
create or replace function public.fin3_execute_owner_payment(p_org uuid, p_payment uuid, p_paid_on date, p_account uuid default null, p_override jsonb default null)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.owner_pay');
  o finance_v3.owner_payments; v_acc uuid; v_entry uuid; v_prot jsonb; v_rel numeric := 0; v_h smallint;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  select * into o from finance_v3.owner_payments x where x.organization_id = p_org and x.id = p_payment for update;
  if not found then raise exception 'Owner payment not found.' using errcode = 'V3010'; end if;
  if o.status = 'recorded' then return finance_v3.owner_json(o); end if;                         -- replay
  if o.status <> 'scheduled' then raise exception 'Only a scheduled payment can be executed.' using errcode = 'V3017'; end if;
  if p_paid_on is null or p_paid_on > current_date + 1 then raise exception 'The payment date is not valid.' using errcode = 'V3011'; end if;
  v_acc := coalesce(p_account, o.account_id);
  if v_acc is null then raise exception 'Choose the account the money is paid from.' using errcode = 'V3011'; end if;
  perform finance_v3.assert_cash_account(p_org, v_acc, o.currency);
  if o.kind = 'reimbursement' and o.amount > finance_v3.owner_payable_balance(p_org, o.currency) then
    raise exception 'The studio only owes the owner % % for expenses paid personally.', o.currency, finance_v3.money_text(finance_v3.owner_payable_balance(p_org, o.currency), o.currency) using errcode = 'V3012';
  end if;
  select coalesce(max(ps.commitment_horizon_days), 30) into v_h from finance_v3.protection_settings ps where ps.organization_id = p_org;
  if o.scheduled_for <= current_date + coalesce(v_h, 30) then v_rel := o.amount; end if;
  v_prot := finance_v3.enforce_protection(p_org, v_uid, 'spend', o.amount, o.currency, v_rel, 'owner_' || o.kind, o.id::text, p_override);
  v_entry := finance_v3.post_owner_cash(p_org, o.kind, 'fin3:owner:' || o.id::text || ':execute', o.amount, o.currency, p_paid_on, v_acc, o.note, null);
  update finance_v3.owner_payments x set status = 'recorded', paid_on = p_paid_on, account_id = v_acc, entry_id = v_entry, executed_by = v_uid, updated_at = now()
   where x.id = o.id returning * into o;
  perform finance_v3.write_audit(p_org, v_uid, 'execute_owner_payment', 'owner_payment', o.id::text, null, finance_v3.owner_json(o), null);
  return finance_v3.owner_json(o) || finance_v3.prot_json(v_prot);
end;
$$;

create or replace function public.fin3_cancel_owner_payment(p_org uuid, p_payment uuid, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.owner_pay');
  o finance_v3.owner_payments; v_reason text := nullif(btrim(p_reason), '');
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  if v_reason is null or char_length(v_reason) > 500 then raise exception 'A reason is required.' using errcode = 'V3011'; end if;
  select * into o from finance_v3.owner_payments x where x.organization_id = p_org and x.id = p_payment for update;
  if not found then raise exception 'Owner payment not found.' using errcode = 'V3010'; end if;
  if o.status = 'cancelled' then return finance_v3.owner_json(o); end if;
  if o.status <> 'scheduled' then raise exception 'Only a scheduled payment can be cancelled. Reverse a recorded one.' using errcode = 'V3017'; end if;
  update finance_v3.owner_payments x set status = 'cancelled', updated_at = now() where x.id = o.id returning * into o;
  perform finance_v3.write_audit(p_org, v_uid, 'cancel_owner_payment', 'owner_payment', o.id::text, null, null, v_reason);
  return finance_v3.owner_json(o);
end;
$$;

create or replace function public.fin3_reverse_owner_payment(p_org uuid, p_payment uuid, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.owner_pay');
  o finance_v3.owner_payments; v_reason text := nullif(btrim(p_reason), '');
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  if v_reason is null or char_length(v_reason) > 500 then raise exception 'A reason is required.' using errcode = 'V3011'; end if;
  select * into o from finance_v3.owner_payments x where x.organization_id = p_org and x.id = p_payment for update;
  if not found then raise exception 'Owner payment not found.' using errcode = 'V3010'; end if;
  if o.status = 'reversed' then return finance_v3.owner_json(o); end if;
  if o.status <> 'recorded' then raise exception 'Only a recorded payment can be reversed.' using errcode = 'V3017'; end if;
  perform finance_v3.reverse_entry(p_org, o.entry_id, 'fin3:ownerpay:' || o.id::text || ':reverse', v_reason, null);
  update finance_v3.owner_payments x set status = 'reversed', updated_at = now() where x.id = o.id returning * into o;
  perform finance_v3.write_audit(p_org, v_uid, 'reverse_owner_payment', 'owner_payment', o.id::text, null, null, v_reason);
  return finance_v3.owner_json(o);
end;
$$;

-- A business cost the owner paid personally: Dr expense category / Cr Owner Payable. It is repaid later with a reimbursement.
create or replace function public.fin3_record_owner_paid_expense(p_org uuid, p_key text, p_expense jsonb)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.owner_pay');
  o finance_v3.owner_payments; cat finance_v3.expense_categories; v_ccy text; v_amt numeric; v_date date; v_proj uuid; v_entry uuid; v_desc text;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  perform finance_v3.assert_key(p_key);
  select * into o from finance_v3.owner_payments x where x.organization_id = p_org and x.idempotency_key = p_key;
  if found then return finance_v3.owner_json(o); end if;
  perform finance_v3.assert_keys_allowed(p_expense, array['category_id', 'description', 'amount', 'currency', 'expense_date', 'project_id'], 'expense');
  if not finance_v3.valid_uuid(p_expense ->> 'category_id') then raise exception 'Choose an expense category.' using errcode = 'V3011'; end if;
  select * into cat from finance_v3.expense_categories c where c.organization_id = p_org and c.id = (p_expense ->> 'category_id')::uuid and c.is_active;
  if not found then raise exception 'Choose an active expense category.' using errcode = 'V3010'; end if;
  v_ccy := finance_v3.assert_currency(p_expense ->> 'currency');
  v_amt := finance_v3.money_field(p_expense, 'amount', 'Amount', v_ccy, false);
  begin v_date := (p_expense ->> 'expense_date')::date; exception when others then raise exception 'The expense date is not valid.' using errcode = 'V3011'; end;
  if v_date is null or v_date > current_date + 1 then raise exception 'The expense date is not valid.' using errcode = 'V3011'; end if;
  v_desc := btrim(coalesce(p_expense ->> 'description', ''));
  if char_length(v_desc) not between 1 and 500 then raise exception 'Describe the expense in up to 500 characters.' using errcode = 'V3011'; end if;
  if nullif(p_expense ->> 'project_id', '') is not null then
    if not finance_v3.valid_uuid(p_expense ->> 'project_id') then raise exception 'Invalid project.' using errcode = 'V3011'; end if;
    v_proj := (p_expense ->> 'project_id')::uuid;
    perform finance_v3.assert_project(p_org, v_proj);
  end if;
  v_entry := finance_v3.post_event(p_org, 'owner_paid_expense', 'fin3:ownerexp:' || finance_v3.key_hash(p_key), v_date,
    jsonb_build_array(
      jsonb_strip_nulls(jsonb_build_object('account_id', cat.account_id, 'side', 'debit', 'amount', finance_v3.money_text(v_amt, v_ccy), 'currency', v_ccy, 'project_id', v_proj)),
      jsonb_build_object('account_id', finance_v3.system_account(p_org, 'owner_payable'), 'side', 'credit', 'amount', finance_v3.money_text(v_amt, v_ccy), 'currency', v_ccy)),
    jsonb_strip_nulls(jsonb_build_object('memo', left('Paid by owner: ' || v_desc, 500), 'project_id', v_proj)));
  insert into finance_v3.owner_payments (organization_id, kind, status, amount, currency, paid_on, category_id, project_id, note, entry_id, idempotency_key, created_by, executed_by)
  values (p_org, 'owner_paid_expense', 'recorded', v_amt, v_ccy, v_date, cat.id, v_proj, v_desc, v_entry, p_key, v_uid, v_uid) returning * into o;
  perform finance_v3.write_audit(p_org, v_uid, 'record_owner_paid_expense', 'owner_payment', o.id::text, null, finance_v3.owner_json(o), null);
  return finance_v3.owner_json(o);
end;
$$;

create or replace function public.fin3_list_owner_payments(p_org uuid, p_type text default null, p_status text default null, p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  return coalesce((select jsonb_agg(finance_v3.owner_json(q) order by q.created_at desc, q.id)
    from (select * from finance_v3.owner_payments o where o.organization_id = p_org and (p_type is null or o.kind = p_type) and (p_status is null or o.status = p_status)
           order by o.created_at desc, o.id limit finance_v3.clamp_limit(p_limit) offset finance_v3.clamp_offset(p_offset)) q), '[]'::jsonb);
end;
$$;

-- Per currency: what the owner took (by classification), put in, is owed back, and has scheduled.
create or replace function public.fin3_owner_summary(p_org uuid, p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare v_from date := coalesce(p_from, date '1990-01-01'); v_to date := coalesce(p_to, current_date + 1);
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  return jsonb_build_object('from', p_from, 'to', p_to, 'currencies', coalesce((select jsonb_agg(jsonb_build_object('currency', t.currency,
      'salary', finance_v3.money_text(t.salary, t.currency), 'draws', finance_v3.money_text(t.draws, t.currency),
      'personal_withdrawals', finance_v3.money_text(t.personal, t.currency), 'contributions', finance_v3.money_text(t.contrib, t.currency),
      'reimbursements_paid', finance_v3.money_text(t.reimb, t.currency), 'paid_by_owner_for_business', finance_v3.money_text(t.owner_paid, t.currency),
      'owed_to_owner', finance_v3.money_text(finance_v3.owner_payable_balance(p_org, t.currency), t.currency),
      'scheduled', finance_v3.money_text(t.scheduled, t.currency)) order by t.currency)
    from (select o.currency,
                 coalesce(sum(o.amount) filter (where o.kind = 'salary' and o.status = 'recorded' and o.paid_on between v_from and v_to), 0) salary,
                 coalesce(sum(o.amount) filter (where o.kind = 'draw' and o.status = 'recorded' and o.paid_on between v_from and v_to), 0) draws,
                 coalesce(sum(o.amount) filter (where o.kind = 'personal_withdrawal' and o.status = 'recorded' and o.paid_on between v_from and v_to), 0) personal,
                 coalesce(sum(o.amount) filter (where o.kind = 'contribution' and o.status = 'recorded' and o.paid_on between v_from and v_to), 0) contrib,
                 coalesce(sum(o.amount) filter (where o.kind = 'reimbursement' and o.status = 'recorded' and o.paid_on between v_from and v_to), 0) reimb,
                 coalesce(sum(o.amount) filter (where o.kind = 'owner_paid_expense' and o.status = 'recorded' and o.paid_on between v_from and v_to), 0) owner_paid,
                 coalesce(sum(o.amount) filter (where o.status = 'scheduled'), 0) scheduled
            from finance_v3.owner_payments o where o.organization_id = p_org group by o.currency) t), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'fin3\_%' loop
    execute format('revoke all on function %s from public, anon, service_role', r.sig);
    execute format('grant execute on function %s to authenticated', r.sig);
  end loop;
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'fin3svc\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'finance_v3' loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', r.sig);
  end loop;
end $$;
grant execute on function finance_v3.has_permission(uuid, text) to authenticated;

commit;
