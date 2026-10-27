-- Freelancer chat on the existing per-shot freelancer link (no new login, no new link to hand out).
-- One private thread per shot; the shot's share_token is the credential, resolved only by the Edge Function.
begin;

alter table public.portal_threads add column if not exists shot_id uuid references public.shots(id) on delete cascade;
create unique index if not exists portal_threads_one_shot_thread_idx
  on public.portal_threads(shot_id) where kind = 'freelancer' and shot_id is not null;

create or replace function public.portal_freelancer_resolve(p_share_token text)
returns table (thread_id uuid, organization_id uuid, project_id uuid, project_name text, shot_title text)
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_shot public.shots%rowtype; v_project public.projects%rowtype; v_org uuid; v_thread uuid;
begin
  if p_share_token is null or char_length(p_share_token) < 16 or char_length(p_share_token) > 200 then return; end if;
  select * into v_shot from public.shots s where s.share_token = p_share_token;
  if not found then return; end if;
  select * into v_project from public.projects p where p.id = v_shot.project_id;
  if not found then return; end if;
  v_org := public.portal_project_organization(v_project.id);
  if v_org is null then return; end if;
  select t.id into v_thread from public.portal_threads t where t.shot_id = v_shot.id and t.kind = 'freelancer';
  if v_thread is null then
    insert into public.portal_threads(organization_id, project_id, kind, title, shot_id)
    values (v_org, v_project.id, 'freelancer',
      left(coalesce(nullif(btrim(v_shot.title),''),'Shot') || ' · ' || coalesce(nullif(btrim(v_project.name),''),'Project'), 120), v_shot.id)
    on conflict do nothing;
    select t.id into v_thread from public.portal_threads t where t.shot_id = v_shot.id and t.kind = 'freelancer';
  end if;
  if exists (select 1 from public.portal_threads t where t.id = v_thread and t.archived_at is not null) then return; end if;
  return query select v_thread, v_org, v_project.id, v_project.name::text, v_shot.title::text;
end;
$$;

-- Shot-link freelancers have no guest session; every other guest still must present one.
create or replace function public.portal_post_message(
  p_thread_id uuid, p_sender_kind text, p_guest_session_id uuid, p_label text, p_body text,
  p_idempotency_key text, p_attachments jsonb default '[]'::jsonb
) returns uuid language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_thread public.portal_threads%rowtype; v_body text; v_id uuid; v_label text; v_att jsonb; v_recent integer;
begin
  if p_sender_kind not in ('client','guest') then raise exception 'invalid_sender' using errcode='22023'; end if;
  select * into v_thread from public.portal_threads where id = p_thread_id and archived_at is null;
  if not found then raise exception 'thread_not_found' using errcode='42501'; end if;
  if (p_sender_kind = 'client') <> (v_thread.kind = 'client') then raise exception 'thread_kind_mismatch' using errcode='42501'; end if;
  if p_sender_kind = 'guest' and p_guest_session_id is null and v_thread.shot_id is null then raise exception 'session_required' using errcode='42501'; end if;
  v_body := public.portal_clean_text(p_body, 4000);
  if char_length(coalesce(p_body,'')) > 4000 then raise exception 'message_too_long' using errcode='22023'; end if;
  if v_body = '' and jsonb_array_length(coalesce(p_attachments,'[]'::jsonb)) = 0 then raise exception 'empty_message' using errcode='22023'; end if;
  if jsonb_array_length(coalesce(p_attachments,'[]'::jsonb)) > 5 then raise exception 'too_many_attachments' using errcode='22023'; end if;
  v_label := public.portal_clean_label(p_label, 80, case when p_sender_kind = 'client' then 'Client' else 'Freelancer' end);
  select count(*) into v_recent from public.portal_messages m
    where m.thread_id = p_thread_id and m.sender_kind = p_sender_kind and m.created_at > now() - interval '1 minute';
  if v_recent >= 30 then raise exception 'rate_limited' using errcode='54000'; end if;
  insert into public.portal_messages(thread_id, organization_id, sender_kind, guest_session_id, sender_label, body, idempotency_key)
  values (p_thread_id, v_thread.organization_id, p_sender_kind, p_guest_session_id, v_label, v_body, nullif(p_idempotency_key,''))
  on conflict do nothing returning id into v_id;
  if v_id is null then
    select m.id into v_id from public.portal_messages m
     where m.thread_id = p_thread_id and m.sender_kind = p_sender_kind and m.idempotency_key = p_idempotency_key
       and coalesce(m.guest_session_id::text,'client') = coalesce(p_guest_session_id::text,'client');
    return v_id;
  end if;
  for v_att in select * from jsonb_array_elements(coalesce(p_attachments,'[]'::jsonb)) loop
    insert into public.portal_attachments(thread_id, message_id, uploader_kind, object_path, file_name, content_type, size_bytes)
    values (p_thread_id, v_id, p_sender_kind, v_att->>'object_path', left(v_att->>'file_name',255),
      v_att->>'content_type', (v_att->>'size_bytes')::bigint);
  end loop;
  update public.portal_threads set last_message_at = now(), updated_at = now() where id = p_thread_id;
  return v_id;
end;
$$;

revoke all on function public.portal_freelancer_resolve(text) from public, anon, authenticated;
grant execute on function public.portal_freelancer_resolve(text) to service_role;
revoke all on function public.portal_post_message(uuid,text,uuid,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.portal_post_message(uuid,text,uuid,text,text,text,jsonb) to service_role;

commit;
