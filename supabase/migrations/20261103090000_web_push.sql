-- Web Push: alerts that arrive when no KairFlow tab is open.
--
-- Model
--   push_subscriptions  one row per browser that opted in. Belongs to a staff user OR to one portal
--                       thread (client / freelancer / guest visitors have no account).
--   push_jobs           a queue of alerts. Database triggers add rows for chat messages, portal
--                       messages, freelancer uploads and client cut reviews; the app adds timed rows
--                       (focus timer, morning digest) through the `push` Edge Function.
--   The Edge Function `push` claims due jobs and sends them. Nothing here is readable or writable
--   by a browser role: both tables are RLS-enabled with no policies and no grants except service_role.
--
-- Safe to run twice.

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  endpoint text not null unique check (char_length(endpoint) between 20 and 2048 and endpoint like 'https://%'),
  p256dh text not null check (char_length(p256dh) between 20 and 200),
  auth_secret text not null check (char_length(auth_secret) between 8 and 100),
  user_id uuid references auth.users(id) on delete cascade,
  portal_thread_id uuid references public.portal_threads(id) on delete cascade,
  open_url text check (open_url is null or char_length(open_url) <= 500),
  prefs jsonb not null default '{}'::jsonb,
  user_agent text check (user_agent is null or char_length(user_agent) <= 300),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  fail_count integer not null default 0,
  check ((user_id is not null)::int + (portal_thread_id is not null)::int = 1)
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions(user_id) where user_id is not null;
create index if not exists push_subscriptions_thread_idx on public.push_subscriptions(portal_thread_id) where portal_thread_id is not null;

create table if not exists public.push_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  portal_thread_id uuid references public.portal_threads(id) on delete cascade,
  category text not null default 'general' check (char_length(category) between 1 and 40),
  title text not null check (char_length(title) between 1 and 120),
  body text not null default '' check (char_length(body) <= 240),
  tag text check (tag is null or char_length(tag) <= 80),
  url text check (url is null or char_length(url) <= 500),
  due_at timestamptz not null default now(),
  dedupe_key text check (dedupe_key is null or char_length(dedupe_key) <= 120),
  claimed_at timestamptz,
  sent_at timestamptz,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  check ((user_id is not null)::int + (portal_thread_id is not null)::int = 1)
);
create unique index if not exists push_jobs_dedupe_idx on public.push_jobs(dedupe_key)
  where dedupe_key is not null and sent_at is null;
create index if not exists push_jobs_due_idx on public.push_jobs(due_at) where sent_at is null;

-- One row: where the database should poke the dispatcher so alerts are not delayed.
create table if not exists public.push_config (
  singleton boolean primary key default true check (singleton),
  dispatch_url text not null,
  dispatch_secret text not null check (char_length(dispatch_secret) >= 24)
);

alter table public.push_subscriptions enable row level security;
alter table public.push_jobs enable row level security;
alter table public.push_config enable row level security;
revoke all on table public.push_subscriptions, public.push_jobs, public.push_config from public, anon, authenticated;
grant select, insert, update, delete on table public.push_subscriptions, public.push_jobs, public.push_config to service_role;

-- ---------------------------------------------------------------------------------------------
-- Enqueue helpers (internal; never callable from a browser role)
-- ---------------------------------------------------------------------------------------------
create or replace function public.push_clean(p_value text, p_max integer)
returns text language sql immutable set search_path = pg_catalog, public
as $$ select left(btrim(regexp_replace(coalesce(p_value, ''), '[[:cntrl:]]+', ' ', 'g')), p_max) $$;

create or replace function public.push_enqueue_user(
  p_user_id uuid, p_category text, p_title text, p_body text, p_tag text, p_url text,
  p_due_at timestamptz default now(), p_dedupe_key text default null
) returns void language plpgsql security definer set search_path = pg_catalog, public
as $$
begin
  if p_user_id is null then return; end if;
  insert into public.push_jobs(user_id, category, title, body, tag, url, due_at, dedupe_key)
  values (p_user_id, public.push_clean(p_category, 40), coalesce(nullif(public.push_clean(p_title, 120), ''), 'KairFlow'),
          public.push_clean(p_body, 240), nullif(public.push_clean(p_tag, 80), ''), nullif(public.push_clean(p_url, 500), ''),
          coalesce(p_due_at, now()), nullif(p_dedupe_key, ''))
  on conflict (dedupe_key) where dedupe_key is not null and sent_at is null
  do update set due_at = excluded.due_at, title = excluded.title, body = excluded.body, tag = excluded.tag,
                url = excluded.url, category = excluded.category, claimed_at = null, attempts = 0;
end;
$$;

create or replace function public.push_enqueue_thread(
  p_thread_id uuid, p_category text, p_title text, p_body text, p_tag text
) returns void language plpgsql security definer set search_path = pg_catalog, public
as $$
begin
  if p_thread_id is null then return; end if;
  insert into public.push_jobs(portal_thread_id, category, title, body, tag)
  values (p_thread_id, public.push_clean(p_category, 40), coalesce(nullif(public.push_clean(p_title, 120), ''), 'New message'),
          public.push_clean(p_body, 240), nullif(public.push_clean(p_tag, 80), ''));
end;
$$;

-- Kicks the dispatcher through pg_net when it is installed and configured. Never raises: a missed
-- kick only delays delivery until the next scheduled tick.
create or replace function public.push_kick_dispatch()
returns void language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_cfg public.push_config%rowtype;
begin
  select * into v_cfg from public.push_config limit 1;
  if not found then return; end if;
  if to_regnamespace('net') is null then return; end if;
  execute format(
    'select net.http_post(url := %L, headers := %L::jsonb, body := %L::jsonb)',
    v_cfg.dispatch_url,
    jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', v_cfg.dispatch_secret)::text,
    '{"action":"dispatch"}');
exception when others then
  null;
end;
$$;

create or replace function public.push_jobs_after_insert()
returns trigger language plpgsql security definer set search_path = pg_catalog, public
as $$
begin
  perform public.push_kick_dispatch();
  return null;
end;
$$;
drop trigger if exists push_jobs_kick on public.push_jobs;
create trigger push_jobs_kick after insert on public.push_jobs
  for each statement execute function public.push_jobs_after_insert();

-- ---------------------------------------------------------------------------------------------
-- Claim / finish (service role only)
-- ---------------------------------------------------------------------------------------------
create or replace function public.push_claim_jobs(p_limit integer default 50)
returns setof public.push_jobs language plpgsql security definer set search_path = pg_catalog, public
as $$
begin
  delete from public.push_jobs where sent_at is not null and sent_at < now() - interval '7 days';
  delete from public.push_jobs where sent_at is null and (attempts >= 5 or due_at < now() - interval '2 days');
  return query
    update public.push_jobs j set claimed_at = now(), attempts = j.attempts + 1
     where j.id in (
       select x.id from public.push_jobs x
        where x.sent_at is null and x.due_at <= now() and x.attempts < 5
          and (x.claimed_at is null or x.claimed_at < now() - interval '2 minutes')
        order by x.due_at limit greatest(1, least(coalesce(p_limit, 50), 200))
        for update skip locked)
    returning j.*;
end;
$$;

create or replace function public.push_finish_job(p_job_id uuid)
returns void language sql security definer set search_path = pg_catalog, public
as $$ update public.push_jobs set sent_at = now() where id = p_job_id and sent_at is null $$;

create or replace function public.push_configure(p_url text, p_secret text)
returns void language plpgsql security definer set search_path = pg_catalog, public
as $$
begin
  if p_url is null or p_url !~ '^https://' then raise exception 'invalid_url' using errcode = '22023'; end if;
  if p_secret is null or char_length(p_secret) < 24 then raise exception 'secret_too_short' using errcode = '22023'; end if;
  insert into public.push_config(singleton, dispatch_url, dispatch_secret) values (true, p_url, p_secret)
  on conflict (singleton) do update set dispatch_url = excluded.dispatch_url, dispatch_secret = excluded.dispatch_secret;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Triggers: one per alert source
-- ---------------------------------------------------------------------------------------------
create or replace function public.push_on_chat_message()
returns trigger language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_conv public.chat_conversations%rowtype; v_sender text; v_title text; v_body text; r record;
begin
  if new.deleted_at is not null then return null; end if;
  select * into v_conv from public.chat_conversations where id = new.conversation_id;
  if not found then return null; end if;
  select m.display_name into v_sender from public.studio_memberships m
   where m.organization_id = v_conv.organization_id and m.user_id = new.sender_user_id limit 1;
  v_sender := coalesce(nullif(v_sender, ''), 'A teammate');
  v_title := case when v_conv.kind = 'direct' then v_sender
                  else v_sender || ' in ' || coalesce(nullif(v_conv.title, ''), nullif(v_conv.project_name, ''), 'a chat') end;
  v_body := coalesce(nullif(btrim(new.body), ''), 'Sent an attachment');
  for r in
    select cm.user_id from public.chat_conversation_members cm
     where cm.conversation_id = new.conversation_id and cm.status = 'active' and cm.user_id <> new.sender_user_id
  loop
    perform public.push_enqueue_user(r.user_id, 'messages', v_title, v_body, 'chat-' || new.conversation_id::text, '/');
  end loop;
  return null;
end;
$$;
drop trigger if exists push_chat_message on public.chat_messages;
create trigger push_chat_message after insert on public.chat_messages
  for each row execute function public.push_on_chat_message();

create or replace function public.push_on_portal_message()
returns trigger language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_thread public.portal_threads%rowtype; v_title text; v_body text; r record;
begin
  select * into v_thread from public.portal_threads where id = new.thread_id;
  if not found then return null; end if;
  v_body := coalesce(nullif(btrim(new.body), ''), 'Sent an attachment');
  if new.sender_kind = 'staff' then
    perform public.push_enqueue_thread(new.thread_id, 'messages', coalesce(nullif(new.sender_label, ''), 'Studio') || ' · new message', v_body, 'portal-' || new.thread_id::text);
    return null;
  end if;
  v_title := coalesce(nullif(new.sender_label, ''), 'A visitor') || ' · ' || v_thread.title;
  for r in
    select m.user_id from public.studio_memberships m
     where m.organization_id = v_thread.organization_id and m.status = 'active'
       and m.role in ('master_user', 'staff', 'department_admin')
       and (m.role = 'master_user' or public.chat_user_can_access_project(v_thread.organization_id, v_thread.project_id, m.user_id))
  loop
    perform public.push_enqueue_user(r.user_id, 'messages', v_title, v_body, 'portal-' || new.thread_id::text, '/');
  end loop;
  return null;
end;
$$;
drop trigger if exists push_portal_message on public.portal_messages;
create trigger push_portal_message after insert on public.portal_messages
  for each row execute function public.push_on_portal_message();

create or replace function public.push_on_activity()
returns trigger language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_type text := lower(btrim(coalesce(new.event_type, ''))); v_title text; v_cat text;
begin
  if v_type = 'freelancer_upload' then v_title := 'New freelancer upload'; v_cat := 'freelancerUploads';
  elsif v_type = 'client_revisions_requested' then v_title := 'Client requested revisions'; v_cat := 'cutReview';
  elsif v_type = 'client_approved' then v_title := 'Client approved a cut'; v_cat := 'cutReview';
  elsif v_type = 'client_comment' then v_title := 'New client comment'; v_cat := 'cutReview';
  else return null; end if;
  perform public.push_enqueue_user(new.user_id, v_cat, v_title, coalesce(new.description, ''), v_type || '-' || new.id::text, '/');
  return null;
end;
$$;
drop trigger if exists push_activity on public.activity_log;
create trigger push_activity after insert on public.activity_log
  for each row execute function public.push_on_activity();

-- Lock down every function above.
do $$
declare f text;
begin
  foreach f in array array[
    'push_clean(text,integer)', 'push_enqueue_user(uuid,text,text,text,text,text,timestamptz,text)',
    'push_enqueue_thread(uuid,text,text,text,text)', 'push_kick_dispatch()', 'push_jobs_after_insert()',
    'push_claim_jobs(integer)', 'push_finish_job(uuid)', 'push_configure(text,text)',
    'push_on_chat_message()', 'push_on_portal_message()', 'push_on_activity()'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'push_enqueue_user(uuid,text,text,text,text,text,timestamptz,text)', 'push_claim_jobs(integer)',
    'push_finish_job(uuid)', 'push_configure(text,text)', 'push_kick_dispatch()'
  ] loop
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
