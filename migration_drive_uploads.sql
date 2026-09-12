-- Moves file storage fully onto Google Drive, closing the gap where both
-- the studio's shot-attachment upload and the freelancer-upload fallback
-- were writing files into the public "attachments" Supabase Storage
-- bucket instead of the project's Drive folder. Run after every other
-- migration.

-- google-drive-create-folders already creates a "References" subfolder
-- per project (alongside Cuts and Deliverables) but was never saving its
-- id anywhere - it only persisted drive_deliverables_folder_id. That id
-- is what studio-side attachment uploads now target.
alter table projects add column if not exists drive_references_folder_id text;

-- Atomic append for shot deliverables/attachments, replacing the
-- read-array -> modify-in-JS -> write-whole-array pattern in the upload
-- Edge Functions. That pattern has a TOCTOU race: two uploads that both
-- read the array before either writes can silently drop one deliverable.
-- `deliverables = coalesce(deliverables, '[]'::jsonb) || $2` is a single
-- UPDATE statement - Postgres serializes concurrent updates to the same
-- row, so there's no window for one upload's append to be lost under the
-- other's.
create or replace function public.append_shot_file(
  p_shot_id uuid,
  p_column text,
  p_entry jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_column not in ('deliverables', 'attachments') then
    raise exception 'Invalid column';
  end if;
  if p_column = 'deliverables' then
    update shots set deliverables = coalesce(deliverables, '[]'::jsonb) || p_entry where id = p_shot_id;
  else
    update shots set attachments = coalesce(attachments, '[]'::jsonb) || p_entry where id = p_shot_id;
  end if;
end;
$$;

-- Only the service-role Edge Functions call this (freelancer-drive-upload
-- has already authenticated the caller via the share token before it
-- gets here; studio-drive-upload via the user's own session) - no reason
-- to expose it to the browser directly.
revoke all on function public.append_shot_file(uuid, text, jsonb) from public, anon, authenticated;

-- add_shot_deliverable() is superseded by the Drive-only upload path
-- below (SharedViews.jsx no longer falls back to Supabase Storage), so
-- it's dead code from the frontend's perspective now - but it was
-- reachable by anyone holding a shot's share token, accepting an
-- arbitrary p_path/p_url with no verification those came from a real
-- upload. Revoke rather than delete, in case any already-deployed client
-- is mid-session still calling it.
revoke execute on function add_shot_deliverable(text, text, text, text) from anon, authenticated;
