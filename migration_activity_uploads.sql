-- Run this in the Supabase SQL Editor to add freelancer uploads and the
-- per-project Activity log. Safe to run alongside your existing schema.

-- Freelancer-submitted files, kept separate from the studio's own reference
-- attachments so it's clear which files came from which direction.
alter table shots add column if not exists deliverables jsonb not null default '[]'::jsonb;

-- Activity log, one row per event, newest first when read.
create table if not exists activity_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  shot_id uuid references shots(id) on delete set null,
  event_type text not null default 'note',
  description text not null default '',
  created_at timestamptz not null default now()
);

alter table activity_log enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'activity_log' and policyname = 'Users manage their own activity log'
  ) then
    create policy "Users manage their own activity log"
      on activity_log for all
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end $$;

create index if not exists activity_log_user_id_idx on activity_log(user_id);
create index if not exists activity_log_project_id_idx on activity_log(project_id);

-- Helper used by the storage policy below: confirms a share token belongs to
-- a real shot without exposing any shot data to the caller. SECURITY DEFINER
-- so it works even though the caller (a freelancer, no account) has no RLS
-- access to the shots table itself. A plain subquery in the storage policy
-- would get silently filtered by shots' own RLS and always fail, this
-- function is what makes token-based uploads actually work.
create or replace function is_valid_shot_token(p_token text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists(select 1 from shots where share_token = p_token);
$$;

grant execute on function is_valid_shot_token(text) to anon, authenticated;

-- Lets a freelancer, holding only the exact random share token for a shot,
-- upload a file into a folder named after that token. No login, and no way
-- to touch any other shot's folder without knowing its specific token.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'objects' and schemaname = 'storage'
      and policyname = 'Freelancer upload via share token'
  ) then
    create policy "Freelancer upload via share token"
      on storage.objects for insert
      to anon, authenticated
      with check (
        bucket_id = 'attachments'
        and (storage.foldername(name))[1] = 'freelancer'
        and is_valid_shot_token((storage.foldername(name))[2])
      );
  end if;
end $$;

-- RPC: records a freelancer's uploaded file against the correct shot and
-- logs it to the project's activity feed, verified purely by token match.
create or replace function add_shot_deliverable(
  p_token text,
  p_name text,
  p_path text,
  p_url text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shot shots%rowtype;
begin
  select * into v_shot from shots where share_token = p_token;
  if not found then
    return false;
  end if;

  update shots
    set deliverables = deliverables || jsonb_build_array(
      jsonb_build_object(
        'name', p_name,
        'path', p_path,
        'url', p_url,
        'uploadedAt', now()
      )
    )
    where id = v_shot.id;

  insert into activity_log (user_id, project_id, shot_id, event_type, description)
  values (
    v_shot.user_id,
    v_shot.project_id,
    v_shot.id,
    'freelancer_upload',
    coalesce(nullif(v_shot.assigned_to, ''), 'A freelancer') || ' uploaded "' || p_name || '" for ' || v_shot.title
  );

  return true;
end;
$$;

grant execute on function add_shot_deliverable(text, text, text, text) to anon, authenticated;

-- NOTE: get_shared_shot() used to be redefined here too (this was actually
-- the version that first added `deliverables`), but with 29-odd migration
-- files and no enforced run order, redefining the same function in
-- multiple places meant plain alphabetical ordering could pick a
-- different file's copy over this one - see migration_audit_fixes_5.sql's
-- own comment for the concrete case where that happened. get_shared_shot()
-- now has exactly one definition, in migration_audit_fixes_5.sql, and
-- nothing else in this project should ever `create or replace` it again.
