-- Bookkeeping for direct-to-Drive upload sessions.
--   1. Rate limiting: register_upload_session() refuses to open more than p_limit NEW sessions per scope per window
--      (scope = shot for freelancer share links, user for Final QC). Re-opening an existing upload id never counts.
--   2. Orphan cleanup: the drive-upload-cleanup Edge Function uses these rows to trash Drive files that were uploaded
--      but never finalized (or were rejected / duplicated). See docs/UPLOAD_FIXES_HANDOFF.md.
-- Idempotent. Rollback: drop function public.register_upload_session(text,text,text,uuid,uuid,text,integer,integer);
--                       drop function public.mark_upload_session_finalized(text,text,text);
--                       drop table public.upload_sessions;
create table if not exists public.upload_sessions (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('freelancer', 'final_qc')),
  upload_id text not null,
  scope text not null,
  user_id uuid,
  shot_id uuid,
  folder_id text,
  drive_file_id text,
  created_at timestamptz not null default now(),
  finalized_at timestamptz,
  cleaned_at timestamptz,
  unique (kind, upload_id)
);
create index if not exists upload_sessions_scope_created_idx on public.upload_sessions (kind, scope, created_at desc);
create index if not exists upload_sessions_cleanup_idx on public.upload_sessions (created_at) where cleaned_at is null;

alter table public.upload_sessions enable row level security;
-- No policies on purpose: only the service role (which bypasses RLS) reads or writes this table.
revoke all on table public.upload_sessions from public, anon, authenticated;
grant select, insert, update on table public.upload_sessions to service_role;

create or replace function public.register_upload_session(
  p_kind text, p_upload_id text, p_scope text, p_user_id uuid, p_shot_id uuid, p_folder_id text,
  p_limit integer, p_window_seconds integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if p_kind not in ('freelancer', 'final_qc') or coalesce(p_upload_id, '') = '' or coalesce(p_scope, '') = '' then
    raise exception 'invalid_upload_session';
  end if;
  -- Serialize per scope so two concurrent inits cannot both slip under the limit.
  perform pg_advisory_xact_lock(hashtextextended(p_kind || ':' || p_scope, 0));
  if exists (select 1 from public.upload_sessions where kind = p_kind and upload_id = p_upload_id) then
    return jsonb_build_object('allowed', true, 'created', false);
  end if;
  select count(*) into v_count
    from public.upload_sessions
   where kind = p_kind and scope = p_scope
     and created_at > now() - make_interval(secs => greatest(p_window_seconds, 1));
  if v_count >= greatest(p_limit, 1) then
    return jsonb_build_object('allowed', false, 'retry_after_seconds', greatest(p_window_seconds, 1));
  end if;
  insert into public.upload_sessions (kind, upload_id, scope, user_id, shot_id, folder_id)
  values (p_kind, p_upload_id, p_scope, p_user_id, p_shot_id, p_folder_id);
  return jsonb_build_object('allowed', true, 'created', true);
end;
$$;
revoke all on function public.register_upload_session(text, text, text, uuid, uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.register_upload_session(text, text, text, uuid, uuid, text, integer, integer) to service_role;

create or replace function public.mark_upload_session_finalized(p_kind text, p_upload_id text, p_drive_file_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  update public.upload_sessions
     set finalized_at = coalesce(finalized_at, now()), drive_file_id = p_drive_file_id
   where kind = p_kind and upload_id = p_upload_id;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;
revoke all on function public.mark_upload_session_finalized(text, text, text) from public, anon, authenticated;
grant execute on function public.mark_upload_session_finalized(text, text, text) to service_role;
