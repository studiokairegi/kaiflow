create table if not exists user_settings (user_id uuid primary key references auth.users(id) on delete cascade, currency_symbol text default '$', is_admin boolean not null default false);
create table if not exists team_members (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null default '', email text default '', status text default 'active', rate_currency text default '$',
  created_at timestamptz default now());
alter table team_members enable row level security;
create policy "Users manage their own team" on team_members for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
alter table shots add column if not exists assigned_to text default '';
alter table shots add column if not exists assigned_member_id uuid references team_members(id) on delete set null;
alter table shots add column if not exists assigned_pay numeric default 0;
alter table shots add column if not exists assigned_paid boolean default false;
alter table projects add column if not exists currency text default '$';
create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  invoice_number text, doc_type text default 'invoice', description text default '',
  line_items jsonb default '[]', amount_mode text default 'manual',
  amount numeric, amount_paid numeric default 0, currency text default '$',
  issue_date text, due_date text, status text default 'unpaid', paid_date text default '',
  converted_from_id uuid references invoices(id) on delete set null,
  created_at timestamptz default now());
alter table invoices enable row level security;
create policy "Users manage their own invoices" on invoices for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  shot_id uuid references shots(id) on delete set null,
  category text, description text, amount numeric, currency text default '$', date text,
  created_at timestamptz default now());
create unique index if not exists expenses_shot_unique on expenses(shot_id) where shot_id is not null;
alter table expenses enable row level security;
create policy "Users manage their own expenses" on expenses for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
