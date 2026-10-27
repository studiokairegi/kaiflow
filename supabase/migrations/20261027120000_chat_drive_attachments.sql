-- Chat attachments are stored in the configured Google Drive account, never in Supabase Storage.
-- Existing attachment rows are left intact; new Drive-backed rows use object_path = drive://<file id>
-- so older clients/migrations remain distinguishable and deletion metadata stays backwards compatible.

create or replace function public.chat_register_drive_attachment_upload(
  p_conversation_id uuid,
  p_drive_file_id text,
  p_file_name text,
  p_content_type text,
  p_size_bytes bigint
) returns uuid language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_org uuid; v_id uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode='28000'; end if;
  if not public.chat_can_read_conversation(p_conversation_id) then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_drive_file_id is null or p_drive_file_id !~ '^[A-Za-z0-9_-]{10,200}$' then raise exception 'invalid_drive_file_id' using errcode='22023'; end if;
  if nullif(btrim(p_file_name),'') is null or char_length(p_file_name)>255 then raise exception 'invalid_file_name' using errcode='22023'; end if;
  if p_size_bytes < 1 or p_size_bytes > 20971520 then raise exception 'file_too_large' using errcode='22023'; end if;
  if p_content_type not in ('image/png','image/jpeg','image/gif','image/webp','application/pdf','text/plain','application/zip','video/mp4','video/webm','audio/mpeg','audio/mp4','audio/wav') then
    raise exception 'file_type_not_allowed' using errcode='22023';
  end if;
  select organization_id into v_org from public.chat_conversations where id=p_conversation_id;
  insert into public.chat_attachments(conversation_id,object_path,file_name,content_type,size_bytes,uploaded_by)
    values(p_conversation_id,'drive://' || p_drive_file_id,p_file_name,p_content_type,p_size_bytes,auth.uid())
    returning id into v_id;
  perform public.chat_write_audit(v_org,p_conversation_id,auth.uid(),'attachment_uploaded',v_id,
    jsonb_build_object('fileName',p_file_name,'contentType',p_content_type,'sizeBytes',p_size_bytes,'storage','google_drive'));
  return v_id;
end;
$$;

grant execute on function public.chat_register_drive_attachment_upload(uuid,text,text,text,bigint) to authenticated;

create table if not exists public.chat_drive_folders (
  user_id uuid primary key references auth.users(id) on delete cascade,
  kairflow_root_folder_id text,
  chat_attachments_folder_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.chat_drive_folders enable row level security;
drop policy if exists chat_drive_folders_none on public.chat_drive_folders;
create policy chat_drive_folders_none on public.chat_drive_folders for all to authenticated using (false) with check (false);
