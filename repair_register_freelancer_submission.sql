-- TARGETED REPAIR ONLY: register_freelancer_submission
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
