-- Stable portal participant identity for message ownership.
-- Client/freelancer ownership is tied to the browser-local participant UUID, never a display name.
begin;

alter table public.portal_messages
  add column if not exists sender_participant_id uuid;

-- Preserve idempotency while distinguishing multiple participants using the same share link.
drop index if exists public.portal_messages_idempotency_idx;
create unique index portal_messages_idempotency_idx
  on public.portal_messages(
    thread_id,
    sender_kind,
    coalesce(sender_user_id::text, guest_session_id::text, sender_participant_id::text, 'client'),
    idempotency_key
  )
  where idempotency_key is not null;

-- Recreate the portal reader because its result now includes message-level ownership.
drop function if exists public.portal_thread_messages(uuid, timestamptz, integer, text);
create function public.portal_thread_messages(
  p_thread_id uuid,
  p_after timestamptz default null,
  p_limit integer default 100,
  p_viewer_key text default null,
  p_viewer_participant_id uuid default null
) returns table (
  id uuid,
  sender_kind text,
  sender_label text,
  body text,
  created_at timestamptz,
  mine boolean,
  attachments jsonb,
  reply_to jsonb,
  reactions jsonb
)
language sql stable security definer set search_path = pg_catalog, public
as $$
  select
    m.id,
    m.sender_kind,
    m.sender_label,
    case when m.deleted_at is null then m.body else '' end,
    m.created_at,
    (
      p_viewer_participant_id is not null
      and m.sender_participant_id = p_viewer_participant_id
    ),
    case when m.deleted_at is null then coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'file_name', a.file_name, 'content_type', a.content_type, 'size_bytes', a.size_bytes
      ) order by a.created_at)
      from public.portal_attachments a where a.message_id = m.id
    ), '[]'::jsonb) else '[]'::jsonb end,
    public.portal_reply_preview(m.reply_to_id),
    case when m.deleted_at is null
      then public.portal_reaction_groups(m.id, p_viewer_key)
      else '[]'::jsonb end
  from (
    select *
    from public.portal_messages x
    where x.thread_id = p_thread_id
      and (p_after is null or x.created_at > p_after)
    order by x.created_at desc, x.id desc
    limit greatest(1, least(coalesce(p_limit, 100), 200))
  ) m
  order by m.created_at, m.id;
$$;

-- Replace the writer with an additional optional participant identity.
drop function if exists public.portal_post_message(uuid, text, uuid, text, text, text, jsonb, uuid);
create function public.portal_post_message(
  p_thread_id uuid,
  p_sender_kind text,
  p_guest_session_id uuid,
  p_label text,
  p_body text,
  p_idempotency_key text,
  p_attachments jsonb default '[]'::jsonb,
  p_reply_to_id uuid default null,
  p_sender_participant_id uuid default null
) returns uuid
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_thread public.portal_threads%rowtype;
  v_body text;
  v_id uuid;
  v_label text;
  v_att jsonb;
  v_recent integer;
begin
  if p_sender_kind not in ('client','guest') then
    raise exception 'invalid_sender' using errcode = '22023';
  end if;

  select * into v_thread
  from public.portal_threads
  where id = p_thread_id and archived_at is null;
  if not found then raise exception 'thread_not_found' using errcode = '42501'; end if;

  if (p_sender_kind = 'client') <> (v_thread.kind = 'client') then
    raise exception 'thread_kind_mismatch' using errcode = '42501';
  end if;

  if p_sender_kind = 'client' and (p_sender_participant_id is null or p_guest_session_id is not null) then
    raise exception 'participant_required' using errcode = '22023';
  end if;

  if p_sender_kind = 'guest' and p_guest_session_id is null
     and (v_thread.shot_id is null or p_sender_participant_id is null) then
    raise exception 'participant_required' using errcode = '22023';
  end if;

  if p_sender_kind = 'guest' and p_guest_session_id is not null
     and p_sender_participant_id is not null then
    raise exception 'invalid_participant_identity' using errcode = '22023';
  end if;

  if p_sender_kind = 'guest' and p_guest_session_id is null and v_thread.shot_id is null then
    raise exception 'session_required' using errcode = '42501';
  end if;

  v_body := public.portal_clean_text(p_body, 4000);
  if char_length(coalesce(p_body,'')) > 4000 then raise exception 'message_too_long' using errcode = '22023'; end if;
  if v_body = '' and jsonb_array_length(coalesce(p_attachments,'[]'::jsonb)) = 0 then
    raise exception 'empty_message' using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(p_attachments,'[]'::jsonb)) > 5 then
    raise exception 'too_many_attachments' using errcode = '22023';
  end if;
  if p_reply_to_id is not null and not exists (
    select 1 from public.portal_messages r where r.id = p_reply_to_id and r.thread_id = p_thread_id
  ) then
    raise exception 'reply_target_not_in_thread' using errcode = '22023';
  end if;

  v_label := public.portal_clean_label(
    p_label, 80, case when p_sender_kind = 'client' then 'Client' else 'Freelancer' end
  );

  select count(*) into v_recent
  from public.portal_messages m
  where m.thread_id = p_thread_id
    and m.sender_kind = p_sender_kind
    and m.created_at > now() - interval '1 minute';
  if v_recent >= 30 then raise exception 'rate_limited' using errcode = '54000'; end if;

  insert into public.portal_messages(
    thread_id, organization_id, sender_kind, guest_session_id, sender_participant_id,
    sender_label, body, idempotency_key, reply_to_id
  )
  values (
    p_thread_id, v_thread.organization_id, p_sender_kind, p_guest_session_id, p_sender_participant_id,
    v_label, v_body, nullif(p_idempotency_key,''), p_reply_to_id
  )
  on conflict do nothing returning id into v_id;

  if v_id is null then
    select m.id into v_id
    from public.portal_messages m
    where m.thread_id = p_thread_id
      and m.sender_kind = p_sender_kind
      and m.idempotency_key = p_idempotency_key
      and coalesce(m.guest_session_id::text, m.sender_participant_id::text, 'client')
          = coalesce(p_guest_session_id::text, p_sender_participant_id::text, 'client');
    return v_id;
  end if;

  for v_att in select * from jsonb_array_elements(coalesce(p_attachments,'[]'::jsonb)) loop
    insert into public.portal_attachments(
      thread_id, message_id, uploader_kind, object_path, file_name, content_type, size_bytes
    )
    values (
      p_thread_id, v_id, p_sender_kind, v_att->>'object_path', left(v_att->>'file_name',255),
      v_att->>'content_type', (v_att->>'size_bytes')::bigint
    );
  end loop;

  update public.portal_threads set last_message_at = now(), updated_at = now() where id = p_thread_id;
  return v_id;
end;
$$;

revoke all on function public.portal_thread_messages(uuid, timestamptz, integer, text, uuid)
  from public, anon, authenticated;
grant execute on function public.portal_thread_messages(uuid, timestamptz, integer, text, uuid)
  to service_role;

revoke all on function public.portal_post_message(uuid, text, uuid, text, text, text, jsonb, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.portal_post_message(uuid, text, uuid, text, text, text, jsonb, uuid, uuid)
  to service_role;

commit;
