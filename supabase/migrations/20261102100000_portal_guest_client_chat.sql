-- KairFlow access hardening, part 2 of 2: Client Portal chat and freelancer guest chat.
--
-- A separate authorization boundary from internal studio chat. Nothing here widens
-- chat_conversations / chat_messages (their RLS, realtime topics and storage policies are
-- untouched). Clients and freelancer guests have no Supabase login, so they never touch these
-- tables directly: they call the `portal-chat` Edge Function, which validates a credential and
-- calls the service-role-only functions below with a thread id it resolved itself.
--
--   client      credential = the project's existing Client Portal share link (share_token,
--               share_enabled). Turning sharing off or rotating the token ends chat access.
--   freelancer  credential = a one-time invite (SHA-256 stored, 7-day claim window) exchanged for a
--               revocable 30-day session (SHA-256 stored). The invite cannot be replayed.
--   staff       authenticated KairFlow members; every call re-checks membership and project access.
--
-- Internal notes live in their own table and are never selected by any client/guest function.
-- Additive and re-runnable. Depends on 20261102090000_access_overrides_directory_privacy.sql.

begin;

-- ---------------------------------------------------------------------------------------------
-- Tables (RLS on, no policies, no direct grants: access is only through the functions below)
-- ---------------------------------------------------------------------------------------------
create table if not exists public.portal_threads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  kind text not null check (kind in ('client','freelancer')),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz,
  archived_at timestamptz
);
create unique index if not exists portal_threads_one_client_thread_idx
  on public.portal_threads(project_id) where kind = 'client';
create index if not exists portal_threads_org_activity_idx
  on public.portal_threads(organization_id, last_message_at desc nulls last, id);

create table if not exists public.portal_guest_invites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  thread_id uuid not null references public.portal_threads(id) on delete cascade,
  label text not null check (char_length(btrim(label)) between 1 and 80),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending','claimed','revoked','expired')),
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  claimed_user_id uuid references auth.users(id) on delete set null,
  guest_display_name text,
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null
);
create index if not exists portal_guest_invites_org_idx
  on public.portal_guest_invites(organization_id, project_id, status, created_at desc);
create index if not exists portal_guest_invites_thread_idx on public.portal_guest_invites(thread_id);

create table if not exists public.portal_guest_sessions (
  id uuid primary key default gen_random_uuid(),
  invite_id uuid not null references public.portal_guest_invites(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 60),
  expires_at timestamptz not null,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists portal_guest_sessions_invite_idx on public.portal_guest_sessions(invite_id, revoked_at);

create table if not exists public.portal_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.portal_threads(id) on delete cascade,
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  sender_kind text not null check (sender_kind in ('staff','client','guest')),
  sender_user_id uuid references auth.users(id) on delete set null,
  guest_session_id uuid references public.portal_guest_sessions(id) on delete set null,
  sender_label text not null check (char_length(btrim(sender_label)) between 1 and 80),
  body text not null default '' check (char_length(body) <= 4000),
  idempotency_key text check (idempotency_key is null or char_length(idempotency_key) between 8 and 64),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  check ((sender_kind = 'staff') = (sender_user_id is not null))
);
create index if not exists portal_messages_thread_created_idx on public.portal_messages(thread_id, created_at, id);
create unique index if not exists portal_messages_idempotency_idx
  on public.portal_messages(thread_id, sender_kind, coalesce(sender_user_id::text, guest_session_id::text, 'client'), idempotency_key)
  where idempotency_key is not null;

create table if not exists public.portal_attachments (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.portal_threads(id) on delete cascade,
  message_id uuid references public.portal_messages(id) on delete cascade,
  uploader_kind text not null check (uploader_kind in ('staff','client','guest')),
  object_path text not null unique check (char_length(object_path) <= 400),
  file_name text not null check (char_length(file_name) between 1 and 255),
  content_type text not null,
  size_bytes bigint not null check (size_bytes between 1 and 10485760),
  created_at timestamptz not null default now()
);
create index if not exists portal_attachments_message_idx on public.portal_attachments(message_id);
create index if not exists portal_attachments_thread_idx on public.portal_attachments(thread_id);

-- Staff-only discussion about a thread. Structurally separate from portal_messages so that no
-- client/guest query can ever select it.
create table if not exists public.portal_internal_notes (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.portal_threads(id) on delete cascade,
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  author_user_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index if not exists portal_internal_notes_thread_idx on public.portal_internal_notes(thread_id, created_at);

create table if not exists public.portal_read_state (
  thread_id uuid not null references public.portal_threads(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (thread_id, user_id)
);

-- Rate-limit ledger and security audit trail (subjects are hashes; no raw tokens or IPs).
create table if not exists public.portal_access_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  scope text not null check (char_length(scope) between 1 and 60),
  subject_hash text not null check (char_length(subject_hash) between 1 and 128),
  ok boolean not null default true,
  detail jsonb not null default '{}'::jsonb
);
create index if not exists portal_access_events_lookup_idx on public.portal_access_events(scope, subject_hash, created_at desc);
create index if not exists portal_access_events_created_idx on public.portal_access_events(created_at);

do $$
declare t text;
begin
  foreach t in array array['portal_threads','portal_guest_invites','portal_guest_sessions','portal_messages',
    'portal_attachments','portal_internal_notes','portal_read_state','portal_access_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
end $$;

-- Private bucket with NO storage.objects policies: only the Edge Function (service role) can read
-- or write, and it hands out 60-second signed URLs after checking the credential.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('portal-attachments', 'portal-attachments', false, 10485760,
  array['image/png','image/jpeg','image/gif','image/webp','application/pdf','text/plain'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------
create or replace function public.portal_clean_text(p_value text, p_max integer)
returns text language sql immutable set search_path = pg_catalog
as $$
  select left(btrim(regexp_replace(replace(replace(coalesce(p_value,''), E'\r\n', E'\n'), E'\r', E'\n'),
    E'[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]', '', 'g')), p_max);
$$;

create or replace function public.portal_clean_label(p_value text, p_max integer, p_fallback text)
returns text language sql immutable set search_path = pg_catalog
as $$
  select coalesce(nullif(btrim(regexp_replace(coalesce(p_value,''), E'[\\x00-\\x1f\\x7f]+', ' ', 'g')), ''), p_fallback);
$$;

create or replace function public.portal_staff_can_manage(p_organization_id uuid, p_project_id uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public
as $$
  select auth.uid() is not null and exists (
    select 1 from public.studio_memberships m
    where m.organization_id = p_organization_id and m.user_id = auth.uid() and m.status = 'active'
      and m.role in ('master_user','staff','department_admin')
      and (m.role = 'master_user'
           or public.chat_user_can_access_project(p_organization_id, p_project_id, auth.uid())));
$$;

-- The studio a project belongs to: its owner's mapped workspace, else the owner's own studio.
create or replace function public.portal_project_organization(p_project_id uuid)
returns uuid language sql stable security definer set search_path = pg_catalog, public
as $$
  select coalesce(
    (select o.organization_id from public.studio_data_owners o where o.user_id = p.user_id),
    (select m.organization_id from public.studio_memberships m
       where m.user_id = p.user_id and m.role = 'master_user' and m.status = 'active' limit 1))
  from public.projects p where p.id = p_project_id;
$$;

revoke all on function public.portal_clean_text(text, integer) from public, anon, authenticated;
revoke all on function public.portal_clean_label(text, integer, text) from public, anon, authenticated;
revoke all on function public.portal_staff_can_manage(uuid, uuid) from public, anon, authenticated;
revoke all on function public.portal_project_organization(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Service-role functions (called only by the portal-chat Edge Function)
-- ---------------------------------------------------------------------------------------------
-- Sliding-window limiter. Returns false once the bucket is full; successful hits are recorded.
create or replace function public.portal_rate_limit(
  p_scope text, p_subject_hash text, p_limit integer, p_window_seconds integer
) returns boolean language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_count integer;
begin
  if p_scope is null or p_subject_hash is null or p_limit < 1 or p_window_seconds < 1 then return false; end if;
  if random() < 0.02 then
    delete from public.portal_access_events where created_at < now() - interval '2 days';
  end if;
  select count(*) into v_count from public.portal_access_events e
    where e.scope = p_scope and e.subject_hash = p_subject_hash
      and e.created_at > now() - make_interval(secs => p_window_seconds);
  if v_count >= p_limit then return false; end if;
  insert into public.portal_access_events(scope, subject_hash) values (p_scope, p_subject_hash);
  return true;
end;
$$;

-- Read-only companion: true once the bucket is full (used to stop guessing before any lookup).
create or replace function public.portal_rate_exceeded(
  p_scope text, p_subject_hash text, p_limit integer, p_window_seconds integer
) returns boolean language sql stable security definer set search_path = pg_catalog, public
as $$
  select (select count(*) from public.portal_access_events e
    where e.scope = p_scope and e.subject_hash = p_subject_hash
      and e.created_at > now() - make_interval(secs => p_window_seconds)) >= p_limit;
$$;

create or replace function public.portal_record_event(p_scope text, p_subject_hash text, p_ok boolean, p_detail jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = pg_catalog, public
as $$
  insert into public.portal_access_events(scope, subject_hash, ok, detail)
  values (left(coalesce(p_scope,'unknown'),60), left(coalesce(p_subject_hash,'none'),128), coalesce(p_ok,false), coalesce(p_detail,'{}'::jsonb));
$$;

-- Exchanges a one-time invite for a session. Every failure mode (unknown, malformed, expired,
-- already used, revoked) returns null so the caller cannot tell which one it was.
create or replace function public.portal_guest_claim(
  p_invite_hash text, p_session_hash text, p_display_name text, p_user_id uuid default null,
  p_session_ttl_seconds integer default 2592000
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_inv public.portal_guest_invites%rowtype; v_name text; v_session uuid; v_expires timestamptz; v_project text;
begin
  if p_invite_hash is null or p_invite_hash !~ '^[0-9a-f]{64}$' or p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$' then
    return null;
  end if;
  select * into v_inv from public.portal_guest_invites where token_hash = p_invite_hash for update;
  if not found then return null; end if;
  if v_inv.status = 'pending' and v_inv.expires_at <= now() then
    update public.portal_guest_invites set status = 'expired' where id = v_inv.id;
    return null;
  end if;
  if v_inv.status <> 'pending' then return null; end if;
  v_name := public.portal_clean_label(p_display_name, 60, 'Freelancer');
  v_expires := now() + make_interval(secs => least(greatest(coalesce(p_session_ttl_seconds, 2592000), 3600), 2592000));
  update public.portal_guest_invites set status = 'claimed', claimed_at = now(),
    claimed_user_id = p_user_id, guest_display_name = v_name where id = v_inv.id;
  insert into public.portal_guest_sessions(invite_id, token_hash, display_name, expires_at, last_seen_at)
  values (v_inv.id, p_session_hash, v_name, v_expires, now()) returning id into v_session;
  select p.name into v_project from public.projects p where p.id = v_inv.project_id;
  return jsonb_build_object('session_id', v_session, 'thread_id', v_inv.thread_id, 'project_name', v_project,
    'display_name', v_name, 'expires_at', v_expires, 'organization_id', v_inv.organization_id);
end;
$$;

-- Resolves a session credential. Revoked invites/sessions, expired sessions and archived threads fail.
create or replace function public.portal_guest_resolve(p_session_hash text)
returns table (session_id uuid, thread_id uuid, organization_id uuid, project_id uuid, project_name text,
               display_name text, expires_at timestamptz)
language plpgsql security definer set search_path = pg_catalog, public
as $$
begin
  if p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$' then return; end if;
  update public.portal_guest_sessions s set last_seen_at = now()
    where s.token_hash = p_session_hash and (s.last_seen_at is null or s.last_seen_at < now() - interval '1 minute');
  return query
  select s.id, i.thread_id, i.organization_id, i.project_id, p.name, s.display_name, s.expires_at
  from public.portal_guest_sessions s
  join public.portal_guest_invites i on i.id = s.invite_id
  join public.portal_threads t on t.id = i.thread_id
  join public.projects p on p.id = i.project_id
  where s.token_hash = p_session_hash and s.revoked_at is null and s.expires_at > now()
    and i.status = 'claimed' and t.archived_at is null and t.kind = 'freelancer';
end;
$$;

-- Resolves a Client Portal share link to its chat thread (created on first use).
create or replace function public.portal_client_resolve(p_share_token text)
returns table (thread_id uuid, organization_id uuid, project_id uuid, project_name text, client_name text)
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_project public.projects%rowtype; v_org uuid; v_thread uuid;
begin
  if p_share_token is null or char_length(p_share_token) < 16 or char_length(p_share_token) > 200 then return; end if;
  select * into v_project from public.projects p where p.share_token = p_share_token and p.share_enabled = true;
  if not found then return; end if;
  v_org := public.portal_project_organization(v_project.id);
  if v_org is null then return; end if;
  select t.id into v_thread from public.portal_threads t where t.project_id = v_project.id and t.kind = 'client';
  if v_thread is null then
    insert into public.portal_threads(organization_id, project_id, kind, title)
    values (v_org, v_project.id, 'client', left(coalesce(nullif(btrim(v_project.name),''),'Project'), 100) || ' · Client')
    on conflict do nothing; -- no target: OUT parameter names would make a column list ambiguous
    select t.id into v_thread from public.portal_threads t where t.project_id = v_project.id and t.kind = 'client';
  end if;
  if exists (select 1 from public.portal_threads t where t.id = v_thread and t.archived_at is not null) then return; end if;
  return query select v_thread, v_org, v_project.id, v_project.name::text, coalesce(v_project.client,'')::text;
end;
$$;

-- Messages a client/guest may see: the thread's public messages only. Notes are a different table.
create or replace function public.portal_thread_messages(p_thread_id uuid, p_after timestamptz default null, p_limit integer default 100)
returns table (id uuid, sender_kind text, sender_label text, body text, created_at timestamptz, attachments jsonb)
language sql stable security definer set search_path = pg_catalog, public
as $$
  select m.id, m.sender_kind, m.sender_label, case when m.deleted_at is null then m.body else '' end, m.created_at,
    case when m.deleted_at is null then coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'file_name', a.file_name, 'content_type', a.content_type,
        'size_bytes', a.size_bytes) order by a.created_at)
      from public.portal_attachments a where a.message_id = m.id), '[]'::jsonb) else '[]'::jsonb end
  from (select * from public.portal_messages x where x.thread_id = p_thread_id
          and (p_after is null or x.created_at > p_after)
        order by x.created_at desc, x.id desc limit greatest(1, least(coalesce(p_limit,100), 200))) m
  order by m.created_at, m.id;
$$;

-- Appends a message from a client or guest. The thread id comes from a resolved credential.
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
  if p_sender_kind = 'guest' and p_guest_session_id is null then raise exception 'session_required' using errcode='42501'; end if;
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

create or replace function public.portal_get_attachment(p_thread_id uuid, p_attachment_id uuid)
returns table (object_path text, file_name text, content_type text)
language sql stable security definer set search_path = pg_catalog, public
as $$
  select a.object_path, a.file_name, a.content_type
  from public.portal_attachments a
  join public.portal_messages m on m.id = a.message_id and m.deleted_at is null
  where a.id = p_attachment_id and a.thread_id = p_thread_id;
$$;

-- ---------------------------------------------------------------------------------------------
-- Staff functions (authenticated; identity is always auth.uid())
-- ---------------------------------------------------------------------------------------------
create or replace function public.portal_staff_assert_thread(p_thread_id uuid)
returns table (thread_id uuid, organization_id uuid, project_id uuid, kind text)
language plpgsql stable security definer set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode='28000'; end if;
  return query select t.id, t.organization_id, t.project_id, t.kind from public.portal_threads t
    where t.id = p_thread_id and t.archived_at is null and public.portal_staff_can_manage(t.organization_id, t.project_id);
  if not found then raise exception 'not_authorized' using errcode='42501'; end if;
end;
$$;

create or replace function public.portal_staff_list_threads(p_organization_id uuid)
returns table (thread_id uuid, kind text, title text, project_id uuid, project_name text, client_name text,
               last_message_body text, last_message_at timestamptz, last_sender_kind text, unread_count bigint,
               active_guests bigint)
language plpgsql stable security definer set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null or not public.chat_is_internal_member(p_organization_id) then
    raise exception 'not_authorized' using errcode='42501';
  end if;
  return query
  select t.id, t.kind, t.title, t.project_id, p.name::text, coalesce(p.client,'')::text,
    left(lm.body, 160), t.last_message_at, lm.sender_kind,
    (select count(*) from public.portal_messages m
       left join public.portal_read_state rs on rs.thread_id = t.id and rs.user_id = auth.uid()
      where m.thread_id = t.id and m.sender_kind in ('client','guest') and m.deleted_at is null
        and (rs.last_read_at is null or m.created_at > rs.last_read_at)),
    (select count(*) from public.portal_guest_sessions s join public.portal_guest_invites i on i.id = s.invite_id
      where i.thread_id = t.id and i.status = 'claimed' and s.revoked_at is null and s.expires_at > now())
  from public.portal_threads t
  join public.projects p on p.id = t.project_id
  left join lateral (select m.body, m.sender_kind from public.portal_messages m
    where m.thread_id = t.id and m.deleted_at is null order by m.created_at desc, m.id desc limit 1) lm on true
  where t.organization_id = p_organization_id and t.archived_at is null
    and public.portal_staff_can_manage(t.organization_id, t.project_id)
  order by t.last_message_at desc nulls last, t.created_at desc
  limit 200;
end;
$$;

create or replace function public.portal_staff_messages(p_thread_id uuid, p_limit integer default 100)
returns table (id uuid, sender_kind text, sender_label text, sender_user_id uuid, body text,
               created_at timestamptz, attachments jsonb)
language plpgsql stable security definer set search_path = pg_catalog, public
as $$
begin
  perform 1 from public.portal_staff_assert_thread(p_thread_id);
  return query
  select m.id, m.sender_kind, m.sender_label, m.sender_user_id, m.body, m.created_at,
    coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'file_name', a.file_name, 'content_type', a.content_type,
      'size_bytes', a.size_bytes) order by a.created_at) from public.portal_attachments a where a.message_id = m.id), '[]'::jsonb)
  from (select * from public.portal_messages x where x.thread_id = p_thread_id and x.deleted_at is null
        order by x.created_at desc, x.id desc limit greatest(1, least(coalesce(p_limit,100), 200))) m
  order by m.created_at, m.id;
end;
$$;

create or replace function public.portal_staff_send(
  p_thread_id uuid, p_body text, p_idempotency_key text, p_attachments jsonb default '[]'::jsonb
) returns uuid language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_t record; v_body text; v_id uuid; v_label text; v_att jsonb;
begin
  select * into v_t from public.portal_staff_assert_thread(p_thread_id);
  v_body := public.portal_clean_text(p_body, 4000);
  if char_length(coalesce(p_body,'')) > 4000 then raise exception 'message_too_long' using errcode='22023'; end if;
  if v_body = '' and jsonb_array_length(coalesce(p_attachments,'[]'::jsonb)) = 0 then raise exception 'empty_message' using errcode='22023'; end if;
  if jsonb_array_length(coalesce(p_attachments,'[]'::jsonb)) > 5 then raise exception 'too_many_attachments' using errcode='22023'; end if;
  select m.display_name into v_label from public.studio_memberships m
    where m.organization_id = v_t.organization_id and m.user_id = auth.uid() and m.status = 'active';
  insert into public.portal_messages(thread_id, organization_id, sender_kind, sender_user_id, sender_label, body, idempotency_key)
  values (p_thread_id, v_t.organization_id, 'staff', auth.uid(), public.portal_clean_label(v_label, 80, 'Studio'), v_body, nullif(p_idempotency_key,''))
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

create or replace function public.portal_staff_mark_read(p_thread_id uuid)
returns boolean language plpgsql security definer set search_path = pg_catalog, public
as $$
begin
  perform 1 from public.portal_staff_assert_thread(p_thread_id);
  insert into public.portal_read_state(thread_id, user_id, last_read_at) values (p_thread_id, auth.uid(), now())
    on conflict (thread_id, user_id) do update set last_read_at = excluded.last_read_at;
  return true;
end;
$$;

create or replace function public.portal_staff_ensure_client_thread(p_organization_id uuid, p_project_id uuid)
returns uuid language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_project public.projects%rowtype; v_id uuid;
begin
  if auth.uid() is null or not public.portal_staff_can_manage(p_organization_id, p_project_id) then
    raise exception 'not_authorized' using errcode='42501';
  end if;
  select * into v_project from public.projects p where p.id = p_project_id;
  if not found or public.portal_project_organization(p_project_id) is distinct from p_organization_id then
    raise exception 'project_not_in_studio' using errcode='42501';
  end if;
  insert into public.portal_threads(organization_id, project_id, kind, title, created_by)
  values (p_organization_id, p_project_id, 'client', left(coalesce(nullif(btrim(v_project.name),''),'Project'), 100) || ' · Client', auth.uid())
  on conflict (project_id) where kind = 'client' do nothing;
  select t.id into v_id from public.portal_threads t where t.project_id = p_project_id and t.kind = 'client';
  return v_id;
end;
$$;

create or replace function public.portal_staff_add_note(p_thread_id uuid, p_body text)
returns uuid language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_t record; v_id uuid; v_body text := public.portal_clean_text(p_body, 4000);
begin
  select * into v_t from public.portal_staff_assert_thread(p_thread_id);
  if v_body = '' then raise exception 'empty_note' using errcode='22023'; end if;
  insert into public.portal_internal_notes(thread_id, organization_id, author_user_id, body)
  values (p_thread_id, v_t.organization_id, auth.uid(), v_body) returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.portal_staff_notes(p_thread_id uuid)
returns table (id uuid, author_user_id uuid, author_name text, body text, created_at timestamptz)
language plpgsql stable security definer set search_path = pg_catalog, public
as $$
declare v_t record;
begin
  select * into v_t from public.portal_staff_assert_thread(p_thread_id);
  return query select n.id, n.author_user_id, coalesce(m.display_name,'Team member')::text, n.body, n.created_at
    from public.portal_internal_notes n
    left join public.studio_memberships m on m.organization_id = n.organization_id and m.user_id = n.author_user_id
    where n.thread_id = p_thread_id order by n.created_at desc limit 100;
end;
$$;

-- The browser generates the 256-bit token (like Teams invites); only its hash is stored.
create or replace function public.portal_staff_create_guest_invite(
  p_organization_id uuid, p_project_id uuid, p_label text, p_token text, p_thread_id uuid default null
) returns table (invite_id uuid, thread_id uuid, expires_at timestamptz)
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_label text := public.portal_clean_label(p_label, 80, 'Freelancer'); v_hash text; v_thread uuid; v_invite uuid; v_exp timestamptz;
        v_project public.projects%rowtype;
begin
  if auth.uid() is null or not public.portal_staff_can_manage(p_organization_id, p_project_id) then
    raise exception 'not_authorized' using errcode='42501';
  end if;
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception 'invalid_invite_token' using errcode='22023'; end if;
  select * into v_project from public.projects p where p.id = p_project_id;
  if not found or public.portal_project_organization(p_project_id) is distinct from p_organization_id then
    raise exception 'project_not_in_studio' using errcode='42501';
  end if;
  if p_thread_id is not null then
    select t.id into v_thread from public.portal_threads t
      where t.id = p_thread_id and t.organization_id = p_organization_id and t.project_id = p_project_id
        and t.kind = 'freelancer' and t.archived_at is null;
    if v_thread is null then raise exception 'thread_not_found' using errcode='42501'; end if;
  else
    insert into public.portal_threads(organization_id, project_id, kind, title, created_by)
    values (p_organization_id, p_project_id, 'freelancer', left(v_label || ' · ' || coalesce(nullif(btrim(v_project.name),''),'Project'), 120), auth.uid())
    returning id into v_thread;
  end if;
  v_hash := public.studio_hash_invite_token(p_token);
  insert into public.portal_guest_invites(organization_id, project_id, thread_id, label, token_hash, created_by)
  values (p_organization_id, p_project_id, v_thread, v_label, v_hash, auth.uid())
  returning id, portal_guest_invites.expires_at into v_invite, v_exp;
  insert into public.studio_audit_events(organization_id, actor_user_id, owner_user_id, entity_type, entity_id, project_id, action, metadata)
  values (p_organization_id, auth.uid(), v_project.user_id, 'portal_guest_invite', v_invite, p_project_id, 'created',
    jsonb_build_object('label', v_label, 'threadId', v_thread));
  return query select v_invite, v_thread, v_exp;
end;
$$;

create or replace function public.portal_staff_list_guest_invites(p_organization_id uuid, p_project_id uuid default null)
returns table (invite_id uuid, thread_id uuid, project_id uuid, project_name text, label text, status text,
               expires_at timestamptz, created_at timestamptz, claimed_at timestamptz, guest_display_name text,
               last_seen_at timestamptz, active_sessions bigint)
language plpgsql stable security definer set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null or not public.chat_is_internal_member(p_organization_id) then
    raise exception 'not_authorized' using errcode='42501';
  end if;
  return query
  select i.id, i.thread_id, i.project_id, p.name::text, i.label,
    case when i.status = 'pending' and i.expires_at <= now() then 'expired' else i.status end,
    i.expires_at, i.created_at, i.claimed_at, i.guest_display_name,
    (select max(s.last_seen_at) from public.portal_guest_sessions s where s.invite_id = i.id),
    (select count(*) from public.portal_guest_sessions s where s.invite_id = i.id and s.revoked_at is null and s.expires_at > now())
  from public.portal_guest_invites i join public.projects p on p.id = i.project_id
  where i.organization_id = p_organization_id and (p_project_id is null or i.project_id = p_project_id)
    and public.portal_staff_can_manage(i.organization_id, i.project_id)
  order by i.created_at desc limit 200;
end;
$$;

create or replace function public.portal_staff_revoke_guest_invite(p_invite_id uuid)
returns boolean language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_inv public.portal_guest_invites%rowtype;
begin
  select * into v_inv from public.portal_guest_invites where id = p_invite_id for update;
  if not found or auth.uid() is null or not public.portal_staff_can_manage(v_inv.organization_id, v_inv.project_id) then
    raise exception 'not_authorized' using errcode='42501';
  end if;
  update public.portal_guest_invites set status = 'revoked', revoked_at = now(), revoked_by = auth.uid()
    where id = p_invite_id and status <> 'revoked';
  update public.portal_guest_sessions set revoked_at = now() where invite_id = p_invite_id and revoked_at is null;
  insert into public.studio_audit_events(organization_id, actor_user_id, entity_type, entity_id, project_id, action, metadata)
  values (v_inv.organization_id, auth.uid(), 'portal_guest_invite', p_invite_id, v_inv.project_id, 'updated',
    jsonb_build_object('status','revoked'));
  return true;
end;
$$;

-- Staff download: authorizes the caller, returns the storage path for the Edge Function to sign.
create or replace function public.portal_staff_attachment(p_attachment_id uuid)
returns table (thread_id uuid, object_path text, file_name text, content_type text)
language plpgsql stable security definer set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode='28000'; end if;
  return query select a.thread_id, a.object_path, a.file_name, a.content_type
    from public.portal_attachments a
    join public.portal_threads t on t.id = a.thread_id and t.archived_at is null
    join public.portal_messages m on m.id = a.message_id and m.deleted_at is null
    where a.id = p_attachment_id and public.portal_staff_can_manage(t.organization_id, t.project_id);
  if not found then raise exception 'not_authorized' using errcode='42501'; end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Grants: service functions are callable only by the service role (the Edge Function)
-- ---------------------------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'portal_rate_limit(text,text,integer,integer)','portal_rate_exceeded(text,text,integer,integer)','portal_record_event(text,text,boolean,jsonb)',
    'portal_guest_claim(text,text,text,uuid,integer)','portal_guest_resolve(text)','portal_client_resolve(text)',
    'portal_thread_messages(uuid,timestamptz,integer)','portal_post_message(uuid,text,uuid,text,text,text,jsonb)',
    'portal_get_attachment(uuid,uuid)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array[
    'portal_staff_assert_thread(uuid)','portal_staff_list_threads(uuid)','portal_staff_messages(uuid,integer)',
    'portal_staff_send(uuid,text,text,jsonb)','portal_staff_mark_read(uuid)','portal_staff_ensure_client_thread(uuid,uuid)',
    'portal_staff_add_note(uuid,text)','portal_staff_notes(uuid)','portal_staff_create_guest_invite(uuid,uuid,text,text,uuid)',
    'portal_staff_list_guest_invites(uuid,uuid)','portal_staff_revoke_guest_invite(uuid)','portal_staff_attachment(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;

commit;
