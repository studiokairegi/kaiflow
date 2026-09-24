-- =========================================================================
-- Teams Module — Phase 1: payment logging atomicity (brief §26)
-- =========================================================================
-- "Log payment" for a shot currently runs as two separate client calls:
--   1. insert an expense row
--   2. update shots.assigned_paid = true
-- A retry (double-click, a request that appears to hang and gets resent,
-- etc.) between those two steps can create a second expense for the same
-- payment before the shot is ever marked paid, with no way to detect it
-- after the fact — expenses.shot_id didn't exist to tie the two together.
--
-- This migration:
--   * adds expenses.shot_id, linking a payment expense back to its shot
--   * adds a unique partial index so at most one expense can ever be tied
--     to a given shot, making a duplicate insert impossible at the
--     database level regardless of how many times the client retries
--   * adds log_shot_payment(), a single atomic RPC that does the insert +
--     the assigned_paid update together, guarded by that same uniqueness
--
-- Safe to run alongside the existing schema — additive only.
-- =========================================================================

alter table expenses add column if not exists shot_id uuid references shots(id) on delete set null;

-- At most one expense may be linked to any given shot. This is what makes
-- log_shot_payment() idempotent: a second attempt to log the same shot's
-- payment hits this constraint and is treated as "already logged" rather
-- than silently inserting a duplicate.
create unique index if not exists expenses_shot_id_unique_idx
  on expenses(shot_id)
  where shot_id is not null;

create or replace function public.log_shot_payment(
  p_shot_id uuid,
  p_project_id uuid,
  p_category text,
  p_description text,
  p_amount numeric,
  p_currency text,
  p_date text
)
returns table (expense_id uuid, already_paid boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_shot_owner uuid;
  v_shot_already_paid boolean;
  v_expense_id uuid;
begin
  select user_id, assigned_paid into v_shot_owner, v_shot_already_paid
  from shots where id = p_shot_id
  for update; -- lock the row for the duration of this transaction

  if v_shot_owner is null then
    raise exception 'Shot not found';
  end if;
  if v_shot_owner <> v_user_id then
    raise exception 'Not authorized to log payment for this shot';
  end if;

  if p_project_id is not null and not exists (select 1 from projects where id = p_project_id and user_id = v_user_id) then
    raise exception 'Not authorized to use this project';
  end if;

  if v_shot_already_paid then
    -- Idempotent no-op: this shot was already marked paid by an earlier
    -- call (e.g. the first of two rapid clicks). Report which expense
    -- that was rather than creating a second one.
    select id into v_expense_id from expenses where shot_id = p_shot_id;
    return query select v_expense_id, true;
    return;
  end if;

  insert into expenses (user_id, project_id, shot_id, category, description, amount, currency, date)
  values (v_user_id, p_project_id, p_shot_id, p_category, p_description, p_amount, p_currency, p_date)
  on conflict (shot_id) where shot_id is not null do nothing
  returning id into v_expense_id;

  if v_expense_id is null then
    -- Lost a race with a concurrent call between the lock above and this
    -- insert (shouldn't happen given the row lock, but the unique index
    -- is the real backstop either way).
    select id into v_expense_id from expenses where shot_id = p_shot_id;
    return query select v_expense_id, true;
    return;
  end if;

  update shots set assigned_paid = true where id = p_shot_id;

  return query select v_expense_id, false;
end;
$$;

revoke all on function public.log_shot_payment(uuid, uuid, text, text, numeric, text, text) from public;
grant execute on function public.log_shot_payment(uuid, uuid, text, text, numeric, text, text) to authenticated;
