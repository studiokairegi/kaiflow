-- Run this in the Supabase SQL Editor to add invoicing support.
-- Safe to run alongside your existing schema.

alter table projects add column if not exists budget_mode text not null default 'manual';

create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  invoice_number text not null default '',
  description text default '',
  amount numeric not null default 0,
  amount_paid numeric not null default 0,
  issue_date text default '',
  due_date text default '',
  status text not null default 'unpaid',
  created_at timestamptz default now()
);

alter table invoices enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'invoices' and policyname = 'Users manage their own invoices'
  ) then
    create policy "Users manage their own invoices"
      on invoices for all
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end $$;

create index if not exists invoices_user_id_idx on invoices(user_id);
create index if not exists invoices_project_id_idx on invoices(project_id);
