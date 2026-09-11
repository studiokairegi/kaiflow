-- Run this in the Supabase SQL Editor to add expense tracking for the Finance module.
-- Safe to run alongside your existing schema.

create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  category text not null default 'Miscellaneous',
  description text default '',
  amount numeric not null default 0,
  date text default '',
  created_at timestamptz default now()
);

alter table expenses enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'expenses' and policyname = 'Users manage their own expenses'
  ) then
    create policy "Users manage their own expenses"
      on expenses for all
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end $$;

create index if not exists expenses_user_id_idx on expenses(user_id);
create index if not exists expenses_project_id_idx on expenses(project_id);
