-- Test-harness only: makes sure the CRM tables Intelligence touches have the columns it uses.
-- (In production these come from the root migration_*.sql files and supabase/migrations.)
create table if not exists leads (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade, company_name text not null default '', created_at timestamptz not null default now());
alter table leads add column if not exists contact_person text not null default '';
alter table leads add column if not exists email text not null default '';
alter table leads add column if not exists website text not null default '';
alter table leads add column if not exists country text not null default '';
alter table leads add column if not exists notes text not null default '';
alter table leads add column if not exists stage text not null default 'pool';
alter table leads add column if not exists channel text not null default '';
alter table leads add column if not exists contacted_via text not null default '';
alter table leads add column if not exists priority text not null default 'warm';
alter table leads add column if not exists last_contacted_at timestamptz;
alter table leads add column if not exists stage_changed_at timestamptz;
alter table leads add column if not exists emails jsonb not null default '[{"sent":false},{"sent":false},{"sent":false},{"sent":false}]'::jsonb;
create table if not exists activity_log (id uuid primary key default gen_random_uuid(), user_id uuid not null, project_id uuid, event_type text not null default '', description text not null default '', meta jsonb not null default '{}'::jsonb, created_at timestamptz not null default now());
alter table activity_log add column if not exists meta jsonb not null default '{}'::jsonb;
alter table activity_log add column if not exists description text not null default '';
alter table activity_log add column if not exists project_id uuid;
