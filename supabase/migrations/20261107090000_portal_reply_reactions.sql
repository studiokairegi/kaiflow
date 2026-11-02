-- Client / guest / freelancer chat: reply-quoting and reactions, matching what direct chat offers.
-- Additive: one nullable column, one new table, two helper functions, and replacements for the portal
-- send/list functions (dropped and recreated because their parameter / result shapes grow).
-- Nothing here changes who can read or write: every function keeps its existing audience, the table has
-- RLS enabled with no policies, and all access still goes through the portal-chat gateway or the staff RPCs.
begin;

alter table public.portal_messages
  add column if not exists reply_to_id uuid references public.portal_messages(id) on delete set null;

create table if not exists public.portal_reactions (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.portal_messages(id) on delete cascade,
  thread_id uuid not null references public.portal_threads(id) on delete cascade,
  reactor_key text not null check (char_length(reactor_key) between 1 and 120),
  reactor_label text not null check (char_length(btrim(reactor_label)) between 1 and 80),
  reaction text not null check (char_length(reaction) between 1 and 16),
  created_at timestamptz not null default now(),
  unique (message_id, reactor_key, reaction)
);
create index if not exists portal_reactions_message_idx on public.portal_reactions(message_id);
alter table public.portal_reactions enable row level security;
revoke all on public.portal_reactions from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Helpers (internal; only called from the security-definer functions below)
-- ---------------------------------------------------------------------------------------------
create or replace function public.portal_reply_preview(p_reply_to_id uuid)
returns jsonb language sql stable security definer set search_path = pg_catalog, public
as $$
  select case when r.id is null then null else jsonb_build_object(
    'id', r.id, 'label', r.sender_label, 'deleted', r.deleted_at is not null,
    'preview', case when r.deleted_at is not null then 'Deleted message'
                    when btrim(r.body) <> '' then left(r.body, 140) else 'Attachment' end) end
  from (select 1) s left join public.portal_messages r on r.id = p_reply_to_id;
$$;

create or replace function public.portal_reaction_groups(p_message_id uuid, p_viewer_key text)
returns jsonb language sql stable security definer set search_path = pg_catalog, public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('reaction', g.reaction, 'count', g.n, 'mine', g.mine, 'names', to_jsonb(g.names))
                            order by g.first_at, g.reaction), '[]'::jsonb)
  from (select x.reaction, count(*)::int as n,
               bool_or(p_viewer_key is not null and x.reactor_key = p_viewer_key) as mine,
               (array_agg(x.reactor_label order by x.created_at))[1:10] as names,
               min(x.created_at) as first_at
          from public.portal_reactions x where x.message_id = p_message_id group by x.reaction) g;
$$;

-- Adds or removes one reaction. The thread and message are checked together, so a message id from
-- another thread is rejected.
create or replace function public.portal_apply_reaction(
  p_thread_id uuid, p_message_id uuid, p_reactor_key text, p_label text, p_reaction text, p_active boolean
) returns void language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_reaction text := btrim(coalesce(p_reaction, '')); v_label text; v_mine integer; v_total integer;
begin
  if v_reaction = '' or char_length(v_reaction) > 16 or v_reaction ~ '[[:cntrl:]]' then
    raise exception 'invalid_reaction' using errcode = '22023';
  end if;
  perform 1 from public.portal_messages m
    where m.id = p_message_id and m.thread_id = p_thread_id and m.deleted_at is null;
  if not found then raise exception 'message_not_found' using errcode = '42501'; end if;

  -- Serialize reaction changes per message to enforce limits under concurrency.
  perform pg_advisory_xact_lock(hashtextextended(p_message_id::text, 0));
  if coalesce(p_active, false) is not true then
    delete from public.portal_reactions where message_id = p_message_id and reactor_key = p_reactor_key and reaction = v_reaction;
    return;
  end if;
  if exists (select 1 from public.portal_reactions where message_id = p_message_id and reactor_key = p_reactor_key and reaction = v_reaction) then
    return;
  end if;
  select count(*) into v_mine from public.portal_reactions where message_id = p_message_id and reactor_key = p_reactor_key;
  if v_mine >= 5 then raise exception 'too_many_reactions' using errcode = '22023'; end if;
  select count(distinct reaction) into v_total from public.portal_reactions where message_id = p_message_id;
  if v_total >= 20 then raise exception 'too_many_reactions' using errcode = '22023'; end if;
  v_label := public.portal_clean_label(p_label, 80, 'Guest');
  insert into public.portal_reactions(message_id, thread_id, reactor_key, reactor_label, reaction)
  values (p_message_id, p_thread_id, p_reactor_key, v_label, v_reaction)
  on conflict do nothing;
end;
$$;

-- Client / guest / freelancer: the gateway has already resolved the credential and passes the thread it found.
create or replace function public.portal_set_reaction(
  p_thread_id uuid, p_message_id uuid, p_reactor_key text, p_label text, p_reaction text, p_active boolean
) returns void language plpgsql security definer set search_path = pg_catalog, public
as $$
begin
  perform 1 from public.portal_threads t where t.id = p_thread_id and t.archived_at is null;
  if not found then raise exception 'thread_not_found' using errcode = '42501'; end if;
  perform public.portal_apply_reaction(p_thread_id, p_message_id, p_reactor_key, p_label, p_reaction, p_active);
end;
$$;

-- Staff: authorized under the caller's own JWT through the existing thread check.
create or replace function public.portal_staff_set_reaction(p_message_id uuid, p_reaction text, p_active boolean)
returns void language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_thread uuid; v_org uuid; v_label text;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select m.thread_id into v_thread from public.portal_messages m where m.id = p_message_id;
  if v_thread is null then raise exception 'message_not_found' using errcode = '42501'; end if;
  select t.organization_id into v_org from public.portal_staff_assert_thread(v_thread) t;
  select m.display_name into v_label from public.studio_memberships m
    where m.organization_id = v_org and m.user_id = auth.uid() and m.status = 'active';
  perform public.portal_apply_reaction(v_thread, p_message_id, 'staff:' || auth.uid()::text, coalesce(v_label, 'Studio'), p_reaction, p_active);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Readers: same rows as before plus reply_to and reactions
-- ---------------------------------------------------------------------------------------------
drop function if exists public.portal_thread_messages(uuid, timestamptz, integer);
create or replace function public.portal_thread_messages(
  p_thread_id uuid, p_after timestamptz default null, p_limit integer default 100, p_viewer_key text default null
) returns table (id uuid, sender_kind text, sender_label text, body text, created_at timestamptz, attachments jsonb,
                 reply_to jsonb, reactions jsonb)
language sql stable security definer set search_path = pg_catalog, public
as $$
  select m.id, m.sender_kind, m.sender_label, case when m.deleted_at is null then m.body else '' end, m.created_at,
    case when m.deleted_at is null then coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'file_name', a.file_name, 'content_type', a.content_type,
        'size_bytes', a.size_bytes) order by a.created_at)
      from public.portal_attachments a where a.message_id = m.id), '[]'::jsonb) else '[]'::jsonb end,
    public.portal_reply_preview(m.reply_to_id),
    case when m.deleted_at is null then public.portal_reaction_groups(m.id, p_viewer_key) else '[]'::jsonb end
  from (select * from public.portal_messages x where x.thread_id = p_thread_id
          and (p_after is null or x.created_at > p_after)
        order by x.created_at desc, x.id desc limit greatest(1, least(coalesce(p_limit,100), 200))) m
  order by m.created_at, m.id;
$$;

drop function if exists public.portal_guest_messages(uuid, uuid, timestamptz, integer);
create or replace function public.portal_guest_messages(
  p_thread_id uuid, p_session_id uuid, p_after timestamptz default null, p_limit integer default 100
) returns table (id uuid, sender_kind text, sender_label text, body text, created_at timestamptz, attachments jsonb,
                 mine boolean, reply_to jsonb, reactions jsonb)
language sql stable security definer set search_path = pg_catalog, public
as $$
  select m.id, m.sender_kind, m.sender_label,
    case when m.deleted_at is null then m.body else '' end, m.created_at,
    case when m.deleted_at is null then coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'file_name', a.file_name, 'content_type', a.content_type,
        'size_bytes', a.size_bytes) order by a.created_at)
      from public.portal_attachments a where a.message_id = m.id), '[]'::jsonb) else '[]'::jsonb end,
    (m.sender_kind = 'guest' and m.guest_session_id is not null and m.guest_session_id = p_session_id),
    public.portal_reply_preview(m.reply_to_id),
    case when m.deleted_at is null then public.portal_reaction_groups(m.id, 'guest:' || p_session_id::text) else '[]'::jsonb end
  from (select * from public.portal_messages x where x.thread_id = p_thread_id
          and (p_after is null or x.created_at > p_after)
        order by x.created_at desc, x.id desc limit greatest(1, least(coalesce(p_limit,100), 200))) m
  order by m.created_at, m.id;
$$;

drop function if exists public.portal_staff_messages(uuid, integer);
create or replace function public.portal_staff_messages(p_thread_id uuid, p_limit integer default 100)
returns table (id uuid, sender_kind text, sender_label text, sender_user_id uuid, body text,
               created_at timestamptz, attachments jsonb, reply_to jsonb, reactions jsonb)
language plpgsql stable security definer set search_path = pg_catalog, public
as $$
begin
  perform 1 from public.portal_staff_assert_thread(p_thread_id);
  return query
  select m.id, m.sender_kind, m.sender_label, m.sender_user_id, m.body, m.created_at,
    coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'file_name', a.file_name, 'content_type', a.content_type,
      'size_bytes', a.size_bytes) order by a.created_at) from public.portal_attachments a where a.message_id = m.id), '[]'::jsonb),
    public.portal_reply_preview(m.reply_to_id),
    public.portal_reaction_groups(m.id, 'staff:' || auth.uid()::text)
  from (select * from public.portal_messages x where x.thread_id = p_thread_id and x.deleted_at is null
        order by x.created_at desc, x.id desc limit greatest(1, least(coalesce(p_limit,100), 200))) m
  order by m.created_at, m.id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Writers: optional reply target, which must be a message in the same thread
-- ---------------------------------------------------------------------------------------------
drop function if exists public.portal_post_message(uuid, text, uuid, text, text, text, jsonb);
create or replace function public.portal_post_message(
  p_thread_id uuid, p_sender_kind text, p_guest_session_id uuid, p_label text, p_body text,
  p_idempotency_key text, p_attachments jsonb default '[]'::jsonb, p_reply_to_id uuid default null
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
  if p_reply_to_id is not null and not exists (
    select 1 from public.portal_messages r where r.id = p_reply_to_id and r.thread_id = p_thread_id
  ) then raise exception 'reply_target_not_in_thread' using errcode='22023'; end if;
  v_label := public.portal_clean_label(p_label, 80, case when p_sender_kind = 'client' then 'Client' else 'Freelancer' end);
  select count(*) into v_recent from public.portal_messages m
    where m.thread_id = p_thread_id and m.sender_kind = p_sender_kind and m.created_at > now() - interval '1 minute';
  if v_recent >= 30 then raise exception 'rate_limited' using errcode='54000'; end if;
  insert into public.portal_messages(thread_id, organization_id, sender_kind, guest_session_id, sender_label, body, idempotency_key, reply_to_id)
  values (p_thread_id, v_thread.organization_id, p_sender_kind, p_guest_session_id, v_label, v_body, nullif(p_idempotency_key,''), p_reply_to_id)
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

drop function if exists public.portal_staff_send(uuid, text, text, jsonb);
create or replace function public.portal_staff_send(
  p_thread_id uuid, p_body text, p_idempotency_key text, p_attachments jsonb default '[]'::jsonb, p_reply_to_id uuid default null
) returns uuid language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_t record; v_body text; v_id uuid; v_label text; v_att jsonb;
begin
  select * into v_t from public.portal_staff_assert_thread(p_thread_id);
  v_body := public.portal_clean_text(p_body, 4000);
  if char_length(coalesce(p_body,'')) > 4000 then raise exception 'message_too_long' using errcode='22023'; end if;
  if v_body = '' and jsonb_array_length(coalesce(p_attachments,'[]'::jsonb)) = 0 then raise exception 'empty_message' using errcode='22023'; end if;
  if jsonb_array_length(coalesce(p_attachments,'[]'::jsonb)) > 5 then raise exception 'too_many_attachments' using errcode='22023'; end if;
  if p_reply_to_id is not null and not exists (
    select 1 from public.portal_messages r where r.id = p_reply_to_id and r.thread_id = p_thread_id
  ) then raise exception 'reply_target_not_in_thread' using errcode='22023'; end if;
  select m.display_name into v_label from public.studio_memberships m
    where m.organization_id = v_t.organization_id and m.user_id = auth.uid() and m.status = 'active';
  insert into public.portal_messages(thread_id, organization_id, sender_kind, sender_user_id, sender_label, body, idempotency_key, reply_to_id)
  values (p_thread_id, v_t.organization_id, 'staff', auth.uid(), public.portal_clean_label(v_label, 80, 'Studio'), v_body, nullif(p_idempotency_key,''), p_reply_to_id)
  on conflict do nothing returning id into v_id;
  if v_id is null then
    select m.id into v_id from public.portal_messages m
      where m.thread_id = p_thread_id and m.sender_kind = 'staff' and m.sender_user_id = auth.uid() and m.idempotency_key = p_idempotency_key;
    return v_id;
  end if;
  for v_att in select * from jsonb_array_elements(coalesce(p_attachments,'[]'::jsonb)) loop
    insert into public.portal_attachments(thread_id, message_id, uploader_kind, object_path, file_name, content_type, size_bytes)
    values (p_thread_id, v_id, 'staff', v_att->>'object_path', left(v_att->>'file_name',255), v_att->>'content_type', (v_att->>'size_bytes')::bigint);
  end loop;
  update public.portal_threads set last_message_at = now(), updated_at = now() where id = p_thread_id;
  insert into public.portal_read_state(thread_id, user_id, last_read_at) values (p_thread_id, auth.uid(), now())
    on conflict (thread_id, user_id) do update set last_read_at = excluded.last_read_at;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Grants. Gateway-only functions: service role. Staff functions: signed-in users (each re-checks access).
-- Helpers are reachable only through the definer functions above.
-- ---------------------------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'portal_reply_preview(uuid)','portal_reaction_groups(uuid,text)','portal_apply_reaction(uuid,uuid,text,text,text,boolean)',
    'portal_set_reaction(uuid,uuid,text,text,text,boolean)',
    'portal_thread_messages(uuid,timestamptz,integer,text)','portal_guest_messages(uuid,uuid,timestamptz,integer)',
    'portal_post_message(uuid,text,uuid,text,text,text,jsonb,uuid)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array[
    'portal_staff_messages(uuid,integer)','portal_staff_send(uuid,text,text,jsonb,uuid)','portal_staff_set_reaction(uuid,text,boolean)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;

commit;
