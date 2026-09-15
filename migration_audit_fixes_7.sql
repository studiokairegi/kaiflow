-- Fixes from a further, very thorough line-by-line audit. Run after every
-- other migration, including migration_audit_fixes_6.sql.

-- =========================================================================
-- 1. Atomic single-entry removal for shot attachments/deliverables
-- =========================================================================
-- append_shot_file() (migration_drive_uploads.sql) made *adding* a file
-- atomic, closing a real concurrent-upload race. But CardEditor's
-- removeAttachment() was still doing a plain whole-array
-- `.update({ attachments: nextAttachments })` built from the editor's
-- local snapshot - which silently undoes append_shot_file's protection
-- the moment a removal and a concurrent upload/edit overlap (e.g. the
-- same shot open in two tabs, or a second upload landing mid-edit): the
-- stale local array wins and quietly drops whatever the other operation
-- added. This does the removal as one atomic UPDATE instead, matching a
-- file by its url (present on every attachment regardless of which
-- upload path created it, unlike driveFileId which older, pre-Drive
-- attachments don't have).
--
-- security invoker (not definer): unlike append_shot_file, this is meant
-- to be called directly by the authenticated client, and shots' existing
-- RLS (auth.uid() = user_id) already correctly restricts it - no need to
-- bypass RLS here.
create or replace function public.remove_shot_file(
  p_shot_id uuid,
  p_column text,
  p_url text
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_column not in ('deliverables', 'attachments') then
    raise exception 'Invalid column';
  end if;
  if p_column = 'attachments' then
    update shots
    set attachments = coalesce(
      (select jsonb_agg(elem) from jsonb_array_elements(coalesce(attachments, '[]'::jsonb)) elem
       where elem->>'url' is distinct from p_url),
      '[]'::jsonb
    )
    where id = p_shot_id;
  else
    update shots
    set deliverables = coalesce(
      (select jsonb_agg(elem) from jsonb_array_elements(coalesce(deliverables, '[]'::jsonb)) elem
       where elem->>'url' is distinct from p_url),
      '[]'::jsonb
    )
    where id = p_shot_id;
  end if;
end;
$$;

grant execute on function public.remove_shot_file(uuid, text, text) to authenticated;
