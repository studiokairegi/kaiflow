-- Fix Finance V2 balance-trigger permission errors.
-- The validator remains SECURITY DEFINER and retains all balance checks.
-- The trigger wrapper also needs SECURITY DEFINER because it invokes the
-- validator during journal_lines writes performed by authenticated users.
-- Keep a fixed search_path to prevent object-shadowing attacks.

create or replace function public.finance_check_balance_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.finance_assert_entry_balanced(coalesce(new.entry_id, old.entry_id));
  return null;
end
$$;
