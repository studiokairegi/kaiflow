-- Finishing every remaining item from the audit queue - nothing deferred
-- this round. Run after migration_audit_fixes_7.sql.

-- =========================================================================
-- 1. Database-level ownership consistency for project/shot references
-- =========================================================================
-- shots.project_id, invoices.project_id, expenses.project_id,
-- activity_log.project_id, and leads.linked_project_id are all plain FKs
-- with no check that the referenced project actually belongs to the same
-- user_id on the row doing the referencing. The UI always keeps these
-- aligned, so this was never a practical exploit for an ordinary user -
-- but proper multi-tenant isolation shouldn't rely on the frontend
-- behaving honestly, and the public sharing RPCs (get_shared_project,
-- get_shared_shot) are SECURITY DEFINER functions that join across these
-- tables without independently re-checking that alignment themselves.
create or replace function public.enforce_project_id_ownership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
begin
  if auth.role() = 'service_role' then
    return new;
  end if;
  if new.project_id is null then
    return new; -- nullable on expenses/activity_log - nothing to check
  end if;
  select user_id into v_owner from projects where id = new.project_id;
  if v_owner is null or v_owner <> new.user_id then
    raise exception 'Cannot reference a project you do not own' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_shots_project_ownership on shots;
create trigger trg_enforce_shots_project_ownership
before insert or update on shots
for each row execute function public.enforce_project_id_ownership();

drop trigger if exists trg_enforce_invoices_project_ownership on invoices;
create trigger trg_enforce_invoices_project_ownership
before insert or update on invoices
for each row execute function public.enforce_project_id_ownership();

drop trigger if exists trg_enforce_expenses_project_ownership on expenses;
create trigger trg_enforce_expenses_project_ownership
before insert or update on expenses
for each row execute function public.enforce_project_id_ownership();

drop trigger if exists trg_enforce_activity_log_project_ownership on activity_log;
create trigger trg_enforce_activity_log_project_ownership
before insert or update on activity_log
for each row execute function public.enforce_project_id_ownership();

-- activity_log.shot_id needs the same check against shots.user_id, and
-- leads.linked_project_id needs it against projects.user_id - different
-- column names, so these get their own small functions rather than
-- forcing them through the one above.
create or replace function public.enforce_activity_log_shot_ownership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
begin
  if auth.role() = 'service_role' then
    return new;
  end if;
  if new.shot_id is null then
    return new;
  end if;
  select user_id into v_owner from shots where id = new.shot_id;
  if v_owner is null or v_owner <> new.user_id then
    raise exception 'Cannot reference a shot you do not own' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_activity_log_shot_ownership on activity_log;
create trigger trg_enforce_activity_log_shot_ownership
before insert or update on activity_log
for each row execute function public.enforce_activity_log_shot_ownership();

create or replace function public.enforce_lead_linked_project_ownership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
begin
  if auth.role() = 'service_role' then
    return new;
  end if;
  if new.linked_project_id is null then
    return new;
  end if;
  select user_id into v_owner from projects where id = new.linked_project_id;
  if v_owner is null or v_owner <> new.user_id then
    raise exception 'Cannot link to a project you do not own' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_leads_linked_project_ownership on leads;
create trigger trg_enforce_leads_linked_project_ownership
before insert or update on leads
for each row execute function public.enforce_lead_linked_project_ownership();

-- =========================================================================
-- 2. Atomic project creation with its initial shot checklist
-- =========================================================================
-- handleSaveProject previously did this as two separate calls (insert
-- project, then insert N shot rows). If the shots insert failed after the
-- project succeeded, the result was a real project with zero shots and no
-- automatic way to retry just the missing part - the same failure mode
-- convert_planner_to_project was built to close for Planner conversions,
-- just never extended to the app's single most common write. security
-- invoker (the default) keeps this running as the calling user, so RLS
-- and the free-plan project-limit trigger apply exactly as they do on a
-- normal insert.
create or replace function public.create_project_with_shots(
  p_name text,
  p_client text,
  p_notes text,
  p_budget text,
  p_budget_mode text,
  p_currency text,
  p_deadline text,
  p_priority text,
  p_share_enabled boolean,
  p_share_token text,
  p_shot_count int
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_project projects%rowtype;
  v_shots jsonb;
  v_total int := greatest(0, least(500, coalesce(p_shot_count, 0)));
  v_pad int := greatest(2, length(v_total::text));
begin
  insert into projects (
    name, client, notes, budget, budget_mode, currency, deadline, priority,
    share_enabled, share_token, user_id
  ) values (
    coalesce(p_name, 'Untitled project'), coalesce(p_client, ''), p_notes, coalesce(p_budget, ''),
    coalesce(p_budget_mode, 'manual'), coalesce(p_currency, '$'), nullif(p_deadline, ''),
    coalesce(p_priority, 'normal'), coalesce(p_share_enabled, false), p_share_token, auth.uid()
  )
  returning * into v_project;

  if v_total > 0 then
    insert into shots (project_id, title, client, rate, due, priority, notes, stage, user_id)
    select
      v_project.id,
      'Cut ' || lpad(gs::text, v_pad, '0'),
      coalesce(p_client, ''),
      '', '', 'normal', '',
      'character_design',
      auth.uid()
    from generate_series(1, v_total) as gs;
  end if;

  select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) into v_shots from shots s where s.project_id = v_project.id;

  return jsonb_build_object('project', to_jsonb(v_project), 'shots', v_shots);
end;
$$;

revoke all on function public.create_project_with_shots(text,text,text,text,text,text,text,text,boolean,text,int) from public;
grant execute on function public.create_project_with_shots(text,text,text,text,text,text,text,text,boolean,text,int) to authenticated;

-- =========================================================================
-- 3. Atomic milestone-invoice creation
-- =========================================================================
-- handleCreateMilestones looped 3 sequential handleSaveInvoice() calls
-- with no rollback - a failure on invoice 2 or 3 left a broken partial
-- milestone set (e.g. just the upfront payment) with no automatic way to
-- fix it, and no error surfaced to the user either way (handleSaveInvoice
-- swallows its own errors). The budget-split math itself stays in the
-- client (project_budget_summary's logic isn't duplicated here, to avoid
-- two implementations of the same business rule silently drifting apart) -
-- this only makes the actual database write atomic: a single multi-row
-- INSERT either creates all 3 invoices or none of them.
create or replace function public.create_milestone_invoices(p_rows jsonb)
returns setof invoices
language plpgsql
set search_path = public
as $$
begin
  return query
    insert into invoices (user_id, project_id, invoice_number, description, amount, amount_paid, currency, issue_date, due_date, status, paid_date)
    select
      auth.uid(),
      (r->>'projectId')::uuid,
      coalesce(r->>'invoiceNumber', ''),
      coalesce(r->>'description', ''),
      coalesce(nullif(r->>'amount', '')::numeric, 0),
      coalesce(nullif(r->>'amountPaid', '')::numeric, 0),
      coalesce(r->>'currency', '$'),
      coalesce(r->>'issueDate', ''),
      coalesce(r->>'dueDate', ''),
      coalesce(nullif(r->>'status', ''), 'unpaid'),
      coalesce(r->>'paidDate', '')
    from jsonb_array_elements(p_rows) as r
    returning *;
end;
$$;

revoke all on function public.create_milestone_invoices(jsonb) from public;
grant execute on function public.create_milestone_invoices(jsonb) to authenticated;

-- =========================================================================
-- 4. Link shots to team members by id, not by free-text name
-- =========================================================================
-- computeMemberShots() matched a shot to a roster member by lowercasing
-- and trimming shots.assigned_to and comparing it to team_members.name.
-- That silently breaks on any spelling variation ("Mercy W." vs "Mercy
-- W"), and worse, renaming someone in the roster instantly detaches every
-- shot they were ever assigned - taking their entire pending/paid payment
-- history with it, with no error and no way to notice until the numbers
-- are already wrong.
--
-- assigned_to stays as-is (it's still what the freelancer-facing share
-- view displays, and one-off freelancers who aren't on the roster need to
-- keep working exactly as before). This just adds an optional real
-- reference so roster-assigned shots survive renames.
alter table shots add column if not exists assigned_member_id uuid references team_members(id) on delete set null;

create index if not exists shots_assigned_member_id_idx on shots(assigned_member_id);
