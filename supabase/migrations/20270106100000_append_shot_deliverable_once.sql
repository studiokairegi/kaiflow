-- Atomic, idempotent deliverable append keyed on driveFileId.
-- A single UPDATE takes the row lock; a concurrent caller blocks, then re-evaluates the WHERE clause
-- against the committed row (READ COMMITTED), so two simultaneous finalizations can never both append.
-- Returns true when the entry was appended, false when that driveFileId was already present.
-- NOTE: assumes shots.id is uuid and shots.deliverables is jsonb (as used by append_shot_file); adjust the
-- p_shot_id type if your schema differs.
create or replace function public.append_shot_deliverable_once(p_shot_id uuid, p_entry jsonb)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  if p_entry is null or coalesce(p_entry->>'driveFileId', '') = '' then
    raise exception 'driveFileId_required';
  end if;
  update public.shots s
     set deliverables = coalesce(s.deliverables, '[]'::jsonb) || jsonb_build_array(p_entry)
   where s.id = p_shot_id
     and not exists (
       select 1
         from jsonb_array_elements(coalesce(s.deliverables, '[]'::jsonb)) e
        where e->>'driveFileId' = p_entry->>'driveFileId'
     );
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;
revoke all on function public.append_shot_deliverable_once(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.append_shot_deliverable_once(uuid, jsonb) to service_role;
