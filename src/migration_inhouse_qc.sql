-- In-house cuts: let the studio pass its OWN work through internal QC so the final
-- upload and "Release to client" unlock without a freelancer submission.
-- Run after the cut review migration (cut_review_final_delivery). Additive and idempotent.
--
-- How it works: qc_mark_in_house() records one APPROVED row in cut_submissions that is
-- clearly marked as in-house (drive_file_id starts with 'inhouse:') and moves the cut to
-- 'qc_adjustments'. register_final_version(), release_final_version() and the final-qc-upload
-- Edge Function already require exactly that (an approved submission), so they keep working
-- unchanged and every other safeguard stays: the final file must still be uploaded, validated
-- and explicitly released.

create or replace function public.qc_mark_in_house(p_shot_id uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shot shots%rowtype;
  v_version integer;
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;

  select * into v_shot from shots where id = p_shot_id and user_id = auth.uid() for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;

  if v_shot.workflow_state <> 'in_progress' then
    -- double click / already unlocked in-house: nothing to do
    if exists (select 1 from cut_submissions
                where shot_id = p_shot_id and status = 'approved' and drive_file_id like 'inhouse:%') then
      return jsonb_build_object('duplicate', true);
    end if;
    raise exception 'in_house_not_available' using errcode = 'P0001';
  end if;

  select coalesce(max(version), 0) + 1 into v_version from cut_submissions where shot_id = p_shot_id;

  insert into cut_submissions (user_id, project_id, shot_id, version, drive_file_id, file_name,
                               submitted_by, status, reviewed_at, reviewed_by)
  values (v_shot.user_id, v_shot.project_id, v_shot.id, v_version,
          'inhouse:' || gen_random_uuid()::text, 'In-house work (no freelancer submission)',
          'Studio (in-house)', 'approved', now(), auth.uid())
  returning id into v_id;

  perform _cut_enable_write();
  update shots set workflow_state = 'qc_adjustments' where id = v_shot.id;

  if nullif(btrim(coalesce(p_note, '')), '') is not null then
    insert into cut_comments (user_id, project_id, shot_id, submission_id, audience, kind, author_kind, author_name, body)
    values (v_shot.user_id, v_shot.project_id, v_shot.id, v_id, 'internal', 'note', 'studio', 'Studio QC', btrim(p_note));
  end if;

  perform _cut_log(v_shot.user_id, v_shot.project_id, v_shot.id, 'qc_in_house',
    v_shot.title || ' was marked as in-house work and moved to QC adjustments', 'internal',
    jsonb_build_object('submissionId', v_id, 'version', v_version));
  return jsonb_build_object('duplicate', false, 'submissionId', v_id, 'version', v_version);
end;
$$;
revoke all on function public.qc_mark_in_house(uuid, text) from public, anon;
grant execute on function public.qc_mark_in_house(uuid, text) to authenticated;

-- The freelancer portal must not show the studio's in-house record as "their" upload.
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
      from cut_submissions s
      where s.shot_id = v_shot.id and s.drive_file_id not like 'inhouse:%'
      order by s.version desc limit 1),
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
