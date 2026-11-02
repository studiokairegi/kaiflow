-- Guest chat: tell each guest which messages are theirs. Until now the browser guessed from the
-- display name, so two guests with the same name in one thread saw each other's messages as their
-- own. This returns an explicit `mine` flag computed from the guest's session (the session id is
-- never sent to the browser). Additive; portal_thread_messages is unchanged and still serves clients.
create or replace function public.portal_guest_messages(
  p_thread_id uuid, p_session_id uuid, p_after timestamptz default null, p_limit integer default 100
) returns table (id uuid, sender_kind text, sender_label text, body text, created_at timestamptz, attachments jsonb, mine boolean)
language sql stable security definer set search_path = pg_catalog, public
as $$
  select m.id, m.sender_kind, m.sender_label,
    case when m.deleted_at is null then m.body else '' end, m.created_at,
    case when m.deleted_at is null then coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'file_name', a.file_name, 'content_type', a.content_type,
        'size_bytes', a.size_bytes) order by a.created_at)
      from public.portal_attachments a where a.message_id = m.id), '[]'::jsonb) else '[]'::jsonb end,
    (m.sender_kind = 'guest' and m.guest_session_id is not null and m.guest_session_id = p_session_id)
  from (select * from public.portal_messages x where x.thread_id = p_thread_id
          and (p_after is null or x.created_at > p_after)
        order by x.created_at desc, x.id desc limit greatest(1, least(coalesce(p_limit,100), 200))) m
  order by m.created_at, m.id;
$$;
revoke all on function public.portal_guest_messages(uuid, uuid, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.portal_guest_messages(uuid, uuid, timestamptz, integer) to service_role;
