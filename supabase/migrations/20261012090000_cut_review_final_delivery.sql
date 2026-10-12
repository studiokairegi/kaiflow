-- Cut review -> internal QC -> Final QC upload -> controlled client release
-- -> client comments / revisions / version-specific approval.
--
-- Additive and idempotent. Nothing is dropped, renamed or backfilled.
-- Run AFTER every existing migration (it reads shots, projects, activity_log).
--
-- FIELD MEANINGS (single source of truth for each concept)
--   shots.workflow_state   INTERNAL production/QC state, server-controlled:
--       in_progress      freelancer is working (or must rework)
--       pending_review   a freelancer submission awaits internal QC
--       qc_adjustments   submission passed QC; studio prepares + uploads the final file
--       ready_for_client a valid final file exists, nothing new is released yet
--       released         a final version has been released to the client
--   shots.review_status    EXISTING client-facing status, reused as-is:
--       in_progress (not released) | waiting (released, client reviewing)
--       | revisions (client requested changes) | approved (client approved)
--     Once a cut has ever been released this column is server-controlled.
--   cut_submissions        freelancer submissions (raw work, never client-visible)
--   cut_final_versions     QC-adjusted final files; delivery_state says whether a
--                          version is client-visible. THIS is what gates downloads.
--   cut_client_reviews     one client decision (approved / revisions) per released version
--   cut_comments           notes with an explicit audience (internal / client / freelancer)

-- ---------------------------------------------------------------------------
-- 1. Columns on existing tables
-- ---------------------------------------------------------------------------
alter table public.projects add column if not exists drive_final_qc_folder_id text;
alter table public.shots    add column if not exists drive_final_qc_folder_id text;
alter table public.shots    add column if not exists workflow_state text not null default 'in_progress';

alter table public.shots drop constraint if exists shots_workflow_state_check;
alter table public.shots add constraint shots_workflow_state_check
  check (workflow_state in ('in_progress','pending_review','qc_adjustments','ready_for_client','released'));

-- Visibility + version reference for activity events. Existing rows stay internal.
alter table public.activity_log add column if not exists audience text not null default 'internal';
alter table public.activity_log add column if not exists meta jsonb not null default '{}'::jsonb;
alter table public.activity_log drop constraint if exists activity_log_audience_check;
alter table public.activity_log add constraint activity_log_audience_check
  check (audience in ('internal','client'));

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------
create table if not exists public.cut_submissions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  project_id    uuid not null references public.projects(id) on delete cascade,
  shot_id       uuid not null references public.shots(id) on delete cascade,
  version       integer not null check (version > 0),
  drive_file_id text not null,
  file_name     text not null,
  mime_type     text,
  size_bytes    bigint,
  submitted_by  text not null default '',
  submitted_at  timestamptz not null default now(),
  status        text not null default 'pending'
                check (status in ('pending','approved','corrections_requested','superseded')),
  reviewed_at   timestamptz,
  reviewed_by   uuid references auth.users(id),
  unique (shot_id, version),
  unique (drive_file_id)
);
-- At most one active (pending) submission per cut: repeat uploads supersede, never duplicate.
create unique index if not exists cut_submissions_one_pending_idx
  on public.cut_submissions (shot_id) where status = 'pending';
create index if not exists cut_submissions_project_idx on public.cut_submissions (project_id);

create table if not exists public.cut_final_versions (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  project_id           uuid not null references public.projects(id) on delete cascade,
  shot_id              uuid not null references public.shots(id) on delete cascade,
  version              integer check (version is null or version > 0),  -- assigned only to valid files
  -- The freelancer submission that passed internal QC and this file was produced from.
  -- Its reviewed_at / reviewed_by are the QC approval reference.
  source_submission_id uuid not null references public.cut_submissions(id),
  upload_key           text not null,         -- client-generated idempotency key per upload attempt
  drive_file_id        text,
  drive_folder_id      text,
  file_name            text not null,
  mime_type            text,
  size_bytes           bigint,
  uploaded_by          uuid references auth.users(id),
  uploaded_at          timestamptz not null default now(),
  validation_status    text not null check (validation_status in ('valid','invalid')),
  validation_error     text,
  is_current           boolean not null default false,   -- the designated (latest valid) final
  delivery_state       text not null default 'unreleased'
                       check (delivery_state in ('unreleased','released','withdrawn','superseded')),
  released_at          timestamptz,
  released_by          uuid references auth.users(id),
  release_notes        text,
  withdrawn_at         timestamptz,
  withdrawn_by         uuid references auth.users(id),
  withdraw_reason      text,
  unique (shot_id, version),
  unique (shot_id, upload_key),
  check (validation_status <> 'valid' or (drive_file_id is not null and version is not null))
);
create unique index if not exists cut_final_one_current_idx
  on public.cut_final_versions (shot_id) where is_current;
create unique index if not exists cut_final_one_released_idx
  on public.cut_final_versions (shot_id) where delivery_state = 'released';
create unique index if not exists cut_final_drive_file_idx
  on public.cut_final_versions (drive_file_id) where drive_file_id is not null;
create index if not exists cut_final_project_idx on public.cut_final_versions (project_id);

create table if not exists public.cut_client_reviews (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  project_id       uuid not null references public.projects(id) on delete cascade,
  shot_id          uuid not null references public.shots(id) on delete cascade,
  final_version_id uuid not null references public.cut_final_versions(id) on delete cascade,
  decision         text not null check (decision in ('approved','revisions_requested')),
  reviewer_name    text not null,
  notes            text,
  created_at       timestamptz not null default now(),
  unique (final_version_id)   -- one decision per released version; a new release needs its own
);
create index if not exists cut_client_reviews_shot_idx on public.cut_client_reviews (shot_id);

create table if not exists public.cut_comments (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  project_id       uuid not null references public.projects(id) on delete cascade,
  shot_id          uuid not null references public.shots(id) on delete cascade,
  submission_id    uuid references public.cut_submissions(id) on delete set null,
  final_version_id uuid references public.cut_final_versions(id) on delete set null,
  audience         text not null check (audience in ('internal','client','freelancer')),
  kind             text not null default 'note'
                   check (kind in ('note','correction_request','revision_request','routing_note')),
  author_kind      text not null check (author_kind in ('studio','client','freelancer')),
  author_name      text not null default '',
  body             text not null check (length(btrim(body)) > 0),
  video_seconds    numeric check (video_seconds is null or video_seconds >= 0),
  created_at       timestamptz not null default now()
);
create index if not exists cut_comments_shot_idx on public.cut_comments (shot_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. Table access: studio owner can READ their own rows. Every write goes
--    through the SECURITY DEFINER functions below (or service-role Edge
--    Functions), never directly from a browser.
-- ---------------------------------------------------------------------------
alter table public.cut_submissions     enable row level security;
alter table public.cut_final_versions  enable row level security;
alter table public.cut_client_reviews  enable row level security;
alter table public.cut_comments        enable row level security;

revoke all on public.cut_submissions, public.cut_final_versions,
              public.cut_client_reviews, public.cut_comments from anon, authenticated;
grant select on public.cut_submissions, public.cut_final_versions,
                public.cut_client_reviews, public.cut_comments to authenticated;

drop policy if exists "Owner reads cut_submissions" on public.cut_submissions;
create policy "Owner reads cut_submissions" on public.cut_submissions
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "Owner reads cut_final_versions" on public.cut_final_versions;
create policy "Owner reads cut_final_versions" on public.cut_final_versions
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "Owner reads cut_client_reviews" on public.cut_client_reviews;
create policy "Owner reads cut_client_reviews" on public.cut_client_reviews
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "Owner reads cut_comments" on public.cut_comments;
create policy "Owner reads cut_comments" on public.cut_comments
  for select to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 4. Guard: workflow_state and the Final-QC folder id are server-controlled,
--    and review_status is server-controlled once a cut has been released
--    (otherwise a stale studio form save could silently undo a client's
--    approval). Cuts that never entered delivery keep today's manual
--    review_status editing unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.shots_guard_workflow_fields()
returns trigger
language plpgsql
as $$
begin
  if current_setting('kairil.workflow_write', true) = 'on'
     or coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.workflow_state := 'in_progress';
    new.drive_final_qc_folder_id := null;
    return new;
  end if;

  new.workflow_state := old.workflow_state;
  new.drive_final_qc_folder_id := old.drive_final_qc_folder_id;

  if exists (
    select 1 from public.cut_final_versions v
    where v.shot_id = old.id and v.delivery_state <> 'unreleased'
  ) then
    new.review_status := old.review_status;
  end if;
  return new;
end;
$$;

drop trigger if exists shots_guard_workflow_fields on public.shots;
create trigger shots_guard_workflow_fields
  before insert or update on public.shots
  for each row execute function public.shots_guard_workflow_fields();

-- ---------------------------------------------------------------------------
-- 5. Internal helpers (not callable by API roles)
-- ---------------------------------------------------------------------------
create or replace function public._cut_log(
  p_user uuid, p_project uuid, p_shot uuid,
  p_type text, p_desc text, p_audience text, p_meta jsonb
) returns void
language sql
security definer
set search_path = public
as $$
  insert into activity_log (user_id, project_id, shot_id, event_type, description, audience, meta)
  values (p_user, p_project, p_shot, p_type, p_desc, p_audience, coalesce(p_meta, '{}'::jsonb));
$$;
revoke all on function public._cut_log(uuid, uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;

create or replace function public._cut_enable_write()
returns void
language sql
as $$ select set_config('kairil.workflow_write', 'on', true); $$;
revoke all on function public._cut_enable_write() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Freelancer submission (called only by the freelancer-drive-upload Edge
--    Function, AFTER the Drive upload succeeded and was recorded).
-- ---------------------------------------------------------------------------
create or replace function public.register_freelancer_submission(
  p_token text, p_drive_file_id text, p_name text, p_mime text, p_size bigint
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shot shots%rowtype;
  v_existing cut_submissions%rowtype;
  v_version integer;
  v_id uuid;
begin
  select * into v_shot from shots where share_token = p_token for update;
  if not found then
    raise exception 'invalid_token' using errcode = 'P0002';
  end if;

  -- A Drive file may be retried only for the shot it was originally registered to.
  select * into v_existing from cut_submissions where drive_file_id = p_drive_file_id;
  if found then
    if v_existing.shot_id <> v_shot.id then
      raise exception 'drive_file_already_registered' using errcode = 'P0001';
    end if;
    return jsonb_build_object('submissionId', v_existing.id, 'version', v_existing.version, 'duplicate', true);
  end if;

  if v_shot.workflow_state not in ('in_progress', 'pending_review') then
    raise exception 'cut_not_accepting_submissions' using errcode = 'P0001';
  end if;

  update cut_submissions set status = 'superseded'
   where shot_id = v_shot.id and status = 'pending';

  select coalesce(max(version), 0) + 1 into v_version from cut_submissions where shot_id = v_shot.id;

  insert into cut_submissions (user_id, project_id, shot_id, version, drive_file_id, file_name, mime_type, size_bytes, submitted_by)
  values (v_shot.user_id, v_shot.project_id, v_shot.id, v_version, p_drive_file_id, p_name, p_mime, p_size,
          coalesce(nullif(v_shot.assigned_to, ''), 'Freelancer'))
  returning id into v_id;

  perform _cut_enable_write();
  update shots set workflow_state = 'pending_review' where id = v_shot.id;

  perform _cut_log(v_shot.user_id, v_shot.project_id, v_shot.id, 'cut_submitted',
    coalesce(nullif(v_shot.assigned_to, ''), 'A freelancer') || ' submitted v' || v_version || ' of ' || v_shot.title || ' for review',
    'internal', jsonb_build_object('submissionId', v_id, 'version', v_version));

  return jsonb_build_object('submissionId', v_id, 'version', v_version, 'duplicate', false);
end;
$$;
revoke all on function public.register_freelancer_submission(text, text, text, text, bigint) from public, anon, authenticated;
grant execute on function public.register_freelancer_submission(text, text, text, text, bigint) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Internal QC decision (studio owner only)
--    Approving = freelancer work passed QC. It does NOT release anything.
-- ---------------------------------------------------------------------------
create or replace function public.qc_review_submission(
  p_submission_id uuid,
  p_decision text,
  p_internal_notes text default null,
  p_correction_notes text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub cut_submissions%rowtype;
  v_shot shots%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if p_decision not in ('approve', 'corrections') then raise exception 'invalid_decision'; end if;

  select * into v_sub from cut_submissions where id = p_submission_id and user_id = auth.uid();
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;

  select * into v_shot from shots where id = v_sub.shot_id and user_id = auth.uid() for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  -- Re-read under the shot lock so concurrent clicks see each other.
  select * into v_sub from cut_submissions where id = p_submission_id;

  if p_decision = 'approve' then
    if v_sub.status = 'approved' then
      return jsonb_build_object('status', 'approved', 'duplicate', true);
    end if;
    if v_sub.status <> 'pending' or v_shot.workflow_state <> 'pending_review' then
      raise exception 'submission_not_pending' using errcode = 'P0001';
    end if;

    update cut_submissions set status = 'approved', reviewed_at = now(), reviewed_by = auth.uid()
     where id = v_sub.id;
    perform _cut_enable_write();
    update shots set workflow_state = 'qc_adjustments' where id = v_shot.id;

    if nullif(btrim(coalesce(p_internal_notes, '')), '') is not null then
      insert into cut_comments (user_id, project_id, shot_id, submission_id, audience, kind, author_kind, author_name, body)
      values (v_shot.user_id, v_shot.project_id, v_shot.id, v_sub.id, 'internal', 'note', 'studio', 'Studio QC', btrim(p_internal_notes));
    end if;
    perform _cut_log(v_shot.user_id, v_shot.project_id, v_shot.id, 'qc_approved',
      'Internal QC approved v' || v_sub.version || ' of ' || v_shot.title, 'internal',
      jsonb_build_object('submissionId', v_sub.id, 'version', v_sub.version));
    return jsonb_build_object('status', 'approved', 'duplicate', false);
  end if;

  -- corrections
  if v_sub.status = 'corrections_requested' then
    return jsonb_build_object('status', 'corrections_requested', 'duplicate', true);
  end if;
  if v_sub.status <> 'pending' or v_shot.workflow_state <> 'pending_review' then
    raise exception 'submission_not_pending' using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(p_correction_notes, ''))) < 3 then
    raise exception 'correction_notes_required' using errcode = 'P0001';
  end if;

  update cut_submissions set status = 'corrections_requested', reviewed_at = now(), reviewed_by = auth.uid()
   where id = v_sub.id;
  perform _cut_enable_write();
  update shots set workflow_state = 'in_progress' where id = v_shot.id;

  insert into cut_comments (user_id, project_id, shot_id, submission_id, audience, kind, author_kind, author_name, body)
  values (v_shot.user_id, v_shot.project_id, v_shot.id, v_sub.id, 'freelancer', 'correction_request', 'studio', 'Studio', btrim(p_correction_notes));
  if nullif(btrim(coalesce(p_internal_notes, '')), '') is not null then
    insert into cut_comments (user_id, project_id, shot_id, submission_id, audience, kind, author_kind, author_name, body)
    values (v_shot.user_id, v_shot.project_id, v_shot.id, v_sub.id, 'internal', 'note', 'studio', 'Studio QC', btrim(p_internal_notes));
  end if;
  perform _cut_log(v_shot.user_id, v_shot.project_id, v_shot.id, 'qc_corrections_requested',
    'Corrections requested on v' || v_sub.version || ' of ' || v_shot.title, 'internal',
    jsonb_build_object('submissionId', v_sub.id, 'version', v_sub.version));
  return jsonb_build_object('status', 'corrections_requested', 'duplicate', false);
end;
$$;
revoke all on function public.qc_review_submission(uuid, text, text, text) from public, anon;
grant execute on function public.qc_review_submission(uuid, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Final QC file registration (service role only; the Edge Function has
--    already authenticated the studio user, uploaded to Drive and validated).
--    Invalid / failed attempts are recorded but can never be released.
-- ---------------------------------------------------------------------------
create or replace function public.register_final_version(
  p_user_id uuid, p_shot_id uuid, p_upload_key text,
  p_drive_file_id text, p_drive_folder_id text,
  p_file_name text, p_mime text, p_size bigint,
  p_valid boolean, p_error text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shot shots%rowtype;
  v_src cut_submissions%rowtype;
  v_existing cut_final_versions%rowtype;
  v_version integer;
  v_id uuid;
begin
  select * into v_shot from shots where id = p_shot_id and user_id = p_user_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;

  select * into v_existing from cut_final_versions where shot_id = p_shot_id and upload_key = p_upload_key;
  if found then
    return jsonb_build_object('versionId', v_existing.id, 'version', v_existing.version,
      'validationStatus', v_existing.validation_status, 'duplicate', true);
  end if;

  if v_shot.workflow_state not in ('qc_adjustments', 'ready_for_client', 'released') then
    raise exception 'final_upload_not_unlocked' using errcode = 'P0001';
  end if;

  -- The QC approval this final file is produced from: the latest approved submission.
  select * into v_src from cut_submissions
   where shot_id = p_shot_id and status = 'approved'
   order by reviewed_at desc nulls last, version desc limit 1;
  if not found then raise exception 'no_qc_approval' using errcode = 'P0001'; end if;

  if not p_valid then
    insert into cut_final_versions (user_id, project_id, shot_id, source_submission_id, upload_key,
      drive_file_id, drive_folder_id, file_name, mime_type, size_bytes, uploaded_by,
      validation_status, validation_error, is_current)
    values (v_shot.user_id, v_shot.project_id, v_shot.id, v_src.id, p_upload_key,
      p_drive_file_id, p_drive_folder_id, p_file_name, p_mime, p_size, p_user_id,
      'invalid', left(coalesce(p_error, 'Validation failed'), 500), false)
    returning id into v_id;
    perform _cut_log(v_shot.user_id, v_shot.project_id, v_shot.id, 'final_validation_failed',
      'Final QC upload for ' || v_shot.title || ' failed validation: ' || left(coalesce(p_error, 'unknown'), 200),
      'internal', jsonb_build_object('versionId', v_id));
    return jsonb_build_object('versionId', v_id, 'version', null, 'validationStatus', 'invalid', 'duplicate', false);
  end if;

  select coalesce(max(version), 0) + 1 into v_version from cut_final_versions where shot_id = p_shot_id;
  update cut_final_versions set is_current = false where shot_id = p_shot_id and is_current;

  insert into cut_final_versions (user_id, project_id, shot_id, version, source_submission_id, upload_key,
    drive_file_id, drive_folder_id, file_name, mime_type, size_bytes, uploaded_by,
    validation_status, is_current)
  values (v_shot.user_id, v_shot.project_id, v_shot.id, v_version, v_src.id, p_upload_key,
    p_drive_file_id, p_drive_folder_id, p_file_name, p_mime, p_size, p_user_id,
    'valid', true)
  returning id into v_id;

  if v_shot.workflow_state = 'qc_adjustments' then
    perform _cut_enable_write();
    update shots set workflow_state = 'ready_for_client' where id = v_shot.id;
  end if;

  perform _cut_log(v_shot.user_id, v_shot.project_id, v_shot.id, 'final_uploaded',
    'Final QC v' || v_version || ' uploaded for ' || v_shot.title || ' (not yet released)', 'internal',
    jsonb_build_object('versionId', v_id, 'version', v_version, 'sourceSubmissionId', v_src.id));
  return jsonb_build_object('versionId', v_id, 'version', v_version, 'validationStatus', 'valid', 'duplicate', false);
end;
$$;
revoke all on function public.register_final_version(uuid, uuid, text, text, text, text, text, bigint, boolean, text) from public, anon, authenticated;
grant execute on function public.register_final_version(uuid, uuid, text, text, text, text, text, bigint, boolean, text) to service_role;

-- ---------------------------------------------------------------------------
-- 9. Delivery: release / withdraw (studio owner only)
-- ---------------------------------------------------------------------------
create or replace function public.release_final_version(p_version_id uuid, p_notes text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v cut_final_versions%rowtype;
  v_shot shots%rowtype;
  v_src cut_submissions%rowtype;
  v_portal boolean;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;

  select * into v from cut_final_versions where id = p_version_id and user_id = auth.uid();
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  select * into v_shot from shots where id = v.shot_id and user_id = auth.uid() for update;
  select * into v from cut_final_versions where id = p_version_id;   -- re-read under lock

  if v.delivery_state = 'released' then
    return jsonb_build_object('versionId', v.id, 'duplicate', true);
  end if;
  if v.validation_status <> 'valid' or v.drive_file_id is null then
    raise exception 'final_file_invalid' using errcode = 'P0001';
  end if;
  if not v.is_current then
    raise exception 'not_current_final' using errcode = 'P0001';
  end if;
  if v.delivery_state not in ('unreleased', 'withdrawn') then
    raise exception 'version_not_releasable' using errcode = 'P0001';
  end if;
  select * into v_src from cut_submissions where id = v.source_submission_id;
  if not found or v_src.status <> 'approved' then
    raise exception 'no_qc_approval' using errcode = 'P0001';
  end if;

  update cut_final_versions set delivery_state = 'superseded'
   where shot_id = v.shot_id and delivery_state = 'released';

  update cut_final_versions
     set delivery_state = 'released', released_at = now(), released_by = auth.uid(),
         release_notes = nullif(btrim(coalesce(p_notes, '')), ''),
         withdrawn_at = null, withdrawn_by = null, withdraw_reason = null
   where id = v.id;

  perform _cut_enable_write();
  update shots set workflow_state = 'released', review_status = 'waiting' where id = v_shot.id;

  select share_enabled and share_token is not null into v_portal from projects where id = v_shot.project_id;

  perform _cut_log(v_shot.user_id, v_shot.project_id, v_shot.id, 'cut_released',
    'v' || v.version || ' of ' || v_shot.title || ' was released to the client', 'client',
    jsonb_build_object('versionId', v.id, 'version', v.version));
  return jsonb_build_object('versionId', v.id, 'version', v.version, 'duplicate', false,
                            'clientPortalEnabled', coalesce(v_portal, false));
end;
$$;
revoke all on function public.release_final_version(uuid, text) from public, anon;
grant execute on function public.release_final_version(uuid, text) to authenticated;

create or replace function public.withdraw_release(p_version_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v cut_final_versions%rowtype;
  v_shot shots%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'withdraw_reason_required' using errcode = 'P0001';
  end if;

  select * into v from cut_final_versions where id = p_version_id and user_id = auth.uid();
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  select * into v_shot from shots where id = v.shot_id and user_id = auth.uid() for update;
  select * into v from cut_final_versions where id = p_version_id;

  if v.delivery_state = 'withdrawn' then
    return jsonb_build_object('versionId', v.id, 'duplicate', true);
  end if;
  if v.delivery_state <> 'released' then
    raise exception 'version_not_released' using errcode = 'P0001';
  end if;

  update cut_final_versions
     set delivery_state = 'withdrawn', withdrawn_at = now(), withdrawn_by = auth.uid(),
         withdraw_reason = btrim(p_reason)
   where id = v.id;

  perform _cut_enable_write();
  update shots
     set workflow_state = case when exists (
           select 1 from cut_final_versions c where c.shot_id = v.shot_id and c.is_current and c.validation_status = 'valid'
         ) then 'ready_for_client' else 'qc_adjustments' end,
         review_status = 'in_progress'
   where id = v_shot.id;

  perform _cut_log(v_shot.user_id, v_shot.project_id, v_shot.id, 'cut_withdrawn',
    'Release of v' || v.version || ' of ' || v_shot.title || ' was withdrawn', 'internal',
    jsonb_build_object('versionId', v.id, 'version', v.version));
  return jsonb_build_object('versionId', v.id, 'duplicate', false);
end;
$$;
revoke all on function public.withdraw_release(uuid, text) from public, anon;
grant execute on function public.withdraw_release(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 10. Studio decides how a client revision request is handled. A request
--     never assigns freelancer work by itself.
-- ---------------------------------------------------------------------------
create or replace function public.route_client_revision(p_shot_id uuid, p_route text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shot shots%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if p_route not in ('freelancer', 'internal') then raise exception 'invalid_route'; end if;

  select * into v_shot from shots where id = p_shot_id and user_id = auth.uid() for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_shot.review_status <> 'revisions' then
    raise exception 'no_client_revision_pending' using errcode = 'P0001';
  end if;
  if v_shot.workflow_state not in ('released', 'ready_for_client') then
    -- already routed (idempotent for double clicks)
    return jsonb_build_object('route', p_route, 'duplicate', true);
  end if;

  if p_route = 'freelancer' then
    if length(btrim(coalesce(p_note, ''))) < 3 then
      raise exception 'freelancer_note_required' using errcode = 'P0001';
    end if;
    perform _cut_enable_write();
    update shots set workflow_state = 'in_progress' where id = v_shot.id;
    -- Only text the studio explicitly chose to share reaches the freelancer.
    insert into cut_comments (user_id, project_id, shot_id, audience, kind, author_kind, author_name, body)
    values (v_shot.user_id, v_shot.project_id, v_shot.id, 'freelancer', 'routing_note', 'studio', 'Studio', btrim(p_note));
  else
    if not exists (select 1 from cut_submissions where shot_id = v_shot.id and status = 'approved') then
      raise exception 'no_qc_approval' using errcode = 'P0001';
    end if;
    perform _cut_enable_write();
    update shots set workflow_state = 'qc_adjustments' where id = v_shot.id;
  end if;

  perform _cut_log(v_shot.user_id, v_shot.project_id, v_shot.id, 'revision_routed',
    'Client revisions on ' || v_shot.title || ' routed to ' ||
      case when p_route = 'freelancer' then 'the freelancer' else 'internal QC adjustments' end,
    'internal', jsonb_build_object('route', p_route));
  return jsonb_build_object('route', p_route, 'duplicate', false);
end;
$$;
revoke all on function public.route_client_revision(uuid, text, text) from public, anon;
grant execute on function public.route_client_revision(uuid, text, text) to authenticated;

create or replace function public.add_cut_note(p_shot_id uuid, p_body text, p_audience text default 'internal')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shot shots%rowtype;
  v_rel cut_final_versions%rowtype;
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if p_audience not in ('internal', 'client') then raise exception 'invalid_audience'; end if;
  if length(btrim(coalesce(p_body, ''))) < 1 then raise exception 'empty_note' using errcode = 'P0001'; end if;

  select * into v_shot from shots where id = p_shot_id and user_id = auth.uid();
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;

  if p_audience = 'client' then
    select * into v_rel from cut_final_versions where shot_id = p_shot_id and delivery_state = 'released';
    if not found then raise exception 'no_released_version' using errcode = 'P0001'; end if;
  end if;

  insert into cut_comments (user_id, project_id, shot_id, final_version_id, audience, kind, author_kind, author_name, body)
  values (v_shot.user_id, v_shot.project_id, v_shot.id, v_rel.id, p_audience, 'note', 'studio', 'Studio', btrim(p_body))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.add_cut_note(uuid, text, text) from public, anon;
grant execute on function public.add_cut_note(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 11. Client portal. Access = the project's existing share token (clients have
--     no accounts in this app). Every function re-validates token -> project ->
--     cut -> exact released version, and never returns Drive ids, raw
--     submissions, internal notes or other clients' data.
-- ---------------------------------------------------------------------------
create or replace function public._client_project(p_token text)
returns uuid
language sql
security definer
set search_path = public
stable
as $$
  select id from projects where share_token = p_token and share_enabled = true and p_token is not null and p_token <> '';
$$;
revoke all on function public._client_project(text) from public, anon, authenticated;

create or replace function public.get_client_cuts(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_project uuid := _client_project(p_token);
begin
  if v_project is null then return null; end if;

  return coalesce((
    select jsonb_agg(cut order by cut->>'title')
    from (
      select jsonb_build_object(
        'shotId', s.id,
        'title', s.title,
        'clientStatus', case
            when rel.id is null then 'in_production'
            when rv.decision = 'approved' then 'client_approved'
            when rv.decision = 'revisions_requested' then 'client_revisions_requested'
            else 'client_review' end,
        'release', case when rel.id is null then null else jsonb_build_object(
            'versionId', rel.id, 'version', rel.version, 'fileName', rel.file_name,
            'sizeBytes', rel.size_bytes, 'mimeType', rel.mime_type,
            'releasedAt', rel.released_at, 'notes', rel.release_notes,
            'decision', rv.decision, 'decidedAt', rv.created_at) end,
        'downloadEnabled', rel.id is not null,
        'history', coalesce((
            select jsonb_agg(jsonb_build_object(
              'versionId', h.id, 'version', h.version, 'releasedAt', h.released_at,
              'current', h.delivery_state = 'released',
              'decision', hr.decision, 'decidedAt', hr.created_at) order by h.released_at desc)
            from cut_final_versions h
            left join cut_client_reviews hr on hr.final_version_id = h.id
            where h.shot_id = s.id and h.released_at is not null and h.delivery_state in ('released', 'superseded')
          ), '[]'::jsonb),
        'comments', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', c.id, 'versionId', c.final_version_id, 'author', c.author_name,
              'authorKind', c.author_kind, 'kind', c.kind, 'body', c.body,
              'seconds', c.video_seconds, 'createdAt', c.created_at) order by c.created_at)
            from cut_comments c where c.shot_id = s.id and c.audience = 'client'
          ), '[]'::jsonb)
      ) as cut
      from shots s
      left join cut_final_versions rel on rel.shot_id = s.id and rel.delivery_state = 'released'
      left join cut_client_reviews rv on rv.final_version_id = rel.id
      where s.project_id = v_project
    ) q
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.get_client_cuts(text) from public;
grant execute on function public.get_client_cuts(text) to anon, authenticated;

-- Shared guard for the three client write actions: token -> project -> cut ->
-- the exact version that is currently released for that cut.
create or replace function public._client_released_version(p_token text, p_shot_id uuid, p_version_id uuid)
returns cut_final_versions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project uuid := _client_project(p_token);
  v cut_final_versions%rowtype;
begin
  if v_project is null then raise exception 'invalid_link' using errcode = 'P0002'; end if;
  perform 1 from shots where id = p_shot_id and project_id = v_project for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  select * into v from cut_final_versions
   where id = p_version_id and shot_id = p_shot_id and project_id = v_project and delivery_state = 'released';
  if not found then raise exception 'version_not_available' using errcode = 'P0001'; end if;
  return v;
end;
$$;
revoke all on function public._client_released_version(text, uuid, uuid) from public, anon, authenticated;

create or replace function public.client_add_comment(
  p_token text, p_shot_id uuid, p_version_id uuid, p_author text, p_body text, p_seconds numeric default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v cut_final_versions%rowtype;
  v_title text;
  v_id uuid;
begin
  if length(btrim(coalesce(p_author, ''))) not between 1 and 80 then raise exception 'author_required' using errcode = 'P0001'; end if;
  if length(btrim(coalesce(p_body, ''))) not between 1 and 4000 then raise exception 'body_invalid' using errcode = 'P0001'; end if;
  v := _client_released_version(p_token, p_shot_id, p_version_id);
  select title into v_title from shots where id = p_shot_id;

  insert into cut_comments (user_id, project_id, shot_id, final_version_id, audience, kind, author_kind, author_name, body, video_seconds)
  values (v.user_id, v.project_id, v.shot_id, v.id, 'client', 'note', 'client', btrim(p_author), btrim(p_body), p_seconds)
  returning id into v_id;

  perform _cut_log(v.user_id, v.project_id, v.shot_id, 'client_comment',
    btrim(p_author) || ' commented on v' || v.version || ' of ' || v_title, 'client',
    jsonb_build_object('versionId', v.id, 'version', v.version, 'commentId', v_id));
  return v_id;
end;
$$;
revoke all on function public.client_add_comment(text, uuid, uuid, text, text, numeric) from public;
grant execute on function public.client_add_comment(text, uuid, uuid, text, text, numeric) to anon, authenticated;

create or replace function public.client_request_revisions(
  p_token text, p_shot_id uuid, p_version_id uuid, p_author text, p_notes text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v cut_final_versions%rowtype;
  v_existing cut_client_reviews%rowtype;
  v_title text;
begin
  if length(btrim(coalesce(p_author, ''))) not between 1 and 80 then raise exception 'author_required' using errcode = 'P0001'; end if;
  if length(btrim(coalesce(p_notes, ''))) < 10 then raise exception 'revision_notes_required' using errcode = 'P0001'; end if;
  v := _client_released_version(p_token, p_shot_id, p_version_id);

  select * into v_existing from cut_client_reviews where final_version_id = v.id;
  if found then
    if v_existing.decision = 'revisions_requested' then
      return jsonb_build_object('decision', 'revisions_requested', 'duplicate', true);
    end if;
    raise exception 'already_approved' using errcode = 'P0001';
  end if;

  select title into v_title from shots where id = p_shot_id;
  insert into cut_client_reviews (user_id, project_id, shot_id, final_version_id, decision, reviewer_name, notes)
  values (v.user_id, v.project_id, v.shot_id, v.id, 'revisions_requested', btrim(p_author), btrim(p_notes));
  insert into cut_comments (user_id, project_id, shot_id, final_version_id, audience, kind, author_kind, author_name, body)
  values (v.user_id, v.project_id, v.shot_id, v.id, 'client', 'revision_request', 'client', btrim(p_author), btrim(p_notes));

  perform _cut_enable_write();
  -- Existing studio-side fields: review_status + the revisions list the cut editor already shows.
  update shots
     set review_status = 'revisions',
         revisions = coalesce(revisions, '[]'::jsonb) || to_jsonb(btrim(p_notes)),
         revision_version = coalesce(revision_version, 1) + 1
   where id = p_shot_id;

  perform _cut_log(v.user_id, v.project_id, v.shot_id, 'client_revisions_requested',
    btrim(p_author) || ' requested revisions on v' || v.version || ' of ' || v_title, 'client',
    jsonb_build_object('versionId', v.id, 'version', v.version));
  return jsonb_build_object('decision', 'revisions_requested', 'duplicate', false);
end;
$$;
revoke all on function public.client_request_revisions(text, uuid, uuid, text, text) from public;
grant execute on function public.client_request_revisions(text, uuid, uuid, text, text) to anon, authenticated;

create or replace function public.client_approve_cut(
  p_token text, p_shot_id uuid, p_version_id uuid, p_author text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v cut_final_versions%rowtype;
  v_existing cut_client_reviews%rowtype;
  v_title text;
begin
  if length(btrim(coalesce(p_author, ''))) not between 1 and 80 then raise exception 'author_required' using errcode = 'P0001'; end if;
  v := _client_released_version(p_token, p_shot_id, p_version_id);

  select * into v_existing from cut_client_reviews where final_version_id = v.id;
  if found then
    if v_existing.decision = 'approved' then
      return jsonb_build_object('decision', 'approved', 'duplicate', true);
    end if;
    raise exception 'revisions_already_requested' using errcode = 'P0001';
  end if;

  select title into v_title from shots where id = p_shot_id;
  insert into cut_client_reviews (user_id, project_id, shot_id, final_version_id, decision, reviewer_name)
  values (v.user_id, v.project_id, v.shot_id, v.id, 'approved', btrim(p_author));

  perform _cut_enable_write();
  -- Only the cut's review status. Stage, project completion, invoices and finance are untouched.
  update shots set review_status = 'approved' where id = p_shot_id;

  perform _cut_log(v.user_id, v.project_id, v.shot_id, 'client_approved',
    btrim(p_author) || ' approved v' || v.version || ' of ' || v_title, 'client',
    jsonb_build_object('versionId', v.id, 'version', v.version));
  return jsonb_build_object('decision', 'approved', 'duplicate', false);
end;
$$;
revoke all on function public.client_approve_cut(text, uuid, uuid, text) from public;
grant execute on function public.client_approve_cut(text, uuid, uuid, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 12. Download authorization (service role only; used by the
--     client-final-download Edge Function). Re-checked on EVERY request, so
--     withdrawal / supersession / sharing-off take effect immediately.
-- ---------------------------------------------------------------------------
create or replace function public.authorize_client_download(p_token text, p_shot_id uuid, p_version_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_project uuid := _client_project(p_token);
  v cut_final_versions%rowtype;
begin
  if v_project is null then raise exception 'invalid_link' using errcode = 'P0002'; end if;
  select * into v from cut_final_versions
   where id = p_version_id and shot_id = p_shot_id and project_id = v_project
     and delivery_state = 'released' and validation_status = 'valid' and drive_file_id is not null;
  if not found then raise exception 'not_available' using errcode = 'P0001'; end if;
  return jsonb_build_object('versionId', v.id, 'shotId', v.shot_id, 'projectId', v.project_id,
    'userId', v.user_id, 'driveFileId', v.drive_file_id, 'fileName', v.file_name,
    'mimeType', v.mime_type, 'version', v.version);
end;
$$;
revoke all on function public.authorize_client_download(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.authorize_client_download(text, uuid, uuid) to service_role;

create or replace function public.authorize_released_file(p_version_id uuid, p_shot_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v cut_final_versions%rowtype;
begin
  select v2.* into v from cut_final_versions v2
    join projects p on p.id = v2.project_id and p.share_enabled = true
   where v2.id = p_version_id and v2.shot_id = p_shot_id
     and v2.delivery_state = 'released' and v2.validation_status = 'valid' and v2.drive_file_id is not null;
  if not found then raise exception 'not_available' using errcode = 'P0001'; end if;
  return jsonb_build_object('versionId', v.id, 'shotId', v.shot_id, 'projectId', v.project_id,
    'userId', v.user_id, 'driveFileId', v.drive_file_id, 'fileName', v.file_name,
    'mimeType', v.mime_type, 'version', v.version);
end;
$$;
revoke all on function public.authorize_released_file(uuid, uuid) from public, anon, authenticated;
grant execute on function public.authorize_released_file(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 13. Freelancer portal (additive; get_shared_shot is NOT redefined - see the
--     note in migration_activity_uploads.sql). Returns only what the studio
--     chose to share: workflow state, own submission status, and
--     freelancer-audience feedback.
-- ---------------------------------------------------------------------------
create or replace function public.get_shared_shot_review(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_shot shots%rowtype;
begin
  select * into v_shot from shots where share_token = p_token;
  if not found then return null; end if;
  return jsonb_build_object(
    'workflowState', v_shot.workflow_state,
    'acceptingSubmissions', v_shot.workflow_state in ('in_progress', 'pending_review'),
    'latestSubmission', (
      select jsonb_build_object('version', s.version, 'status', s.status, 'fileName', s.file_name, 'submittedAt', s.submitted_at)
      from cut_submissions s where s.shot_id = v_shot.id order by s.version desc limit 1),
    'feedback', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'body', c.body, 'createdAt', c.created_at)
                       order by c.created_at desc)
      from cut_comments c where c.shot_id = v_shot.id and c.audience = 'freelancer'
    ), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.get_shared_shot_review(text) from public;
grant execute on function public.get_shared_shot_review(text) to anon, authenticated;
