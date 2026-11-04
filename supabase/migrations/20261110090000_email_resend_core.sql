-- KairFlow Email (Resend): conversations, messages, attachments, events, webhook log, provider flags.
-- Additive and re-runnable. Creates new objects only: it does NOT alter, drop or delete any Gmail/Zoho/Intelligence
-- table, row or credential. Nothing is sent by applying this migration.
--
-- Access rule: the same people who may use Intelligence (admin AND active Master User, intel_is_authorized).
-- It is wrapped in ONE function, public.email_can_access(org), so widening it later is a one-line change.
--
-- Writes from the browser go through email_* RPCs; webhook and send work runs in Edge Functions with the service role
-- and uses the service-only functions at the bottom (email_ingest_inbound, email_create_outbound, email_apply_delivery_event).
begin;

do $$ begin
  if to_regprocedure('public.intel_is_authorized(uuid)') is null
     or to_regprocedure('public.intel_admin_org()') is null
     or to_regprocedure('public.intel_agent_org()') is null then
    raise exception 'Apply the Intelligence migrations (20261109*) first';
  end if;
end $$;

-- 1. Access helpers --------------------------------------------------------------------------------
create or replace function public.email_can_access(p_organization_id uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select public.intel_is_authorized(p_organization_id)
$$;
revoke all on function public.email_can_access(uuid) from public, anon;
grant execute on function public.email_can_access(uuid) to authenticated;

create or replace function public.email_has_access() returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select public.intel_is_authorized()
$$;
revoke all on function public.email_has_access() from public, anon;
grant execute on function public.email_has_access() to authenticated;

-- Raises for anyone not allowed; returns the studio the caller works in.
create or replace function public.email_require_access() returns uuid
language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
  return public.intel_admin_org();
end $$;
revoke all on function public.email_require_access() from public, anon;
grant execute on function public.email_require_access() to authenticated;

-- 2. Provider flags: which email providers are active. Resend on; Gmail and Zoho off (temporary, nothing deleted). ----
-- Changed only with SQL by the project owner; no client can write it.
create table if not exists public.email_provider_flags (
  provider text primary key check (provider in ('resend', 'gmail', 'zoho')),
  enabled boolean not null default false,
  note text not null default '',
  updated_at timestamptz not null default now()
);
alter table public.email_provider_flags enable row level security;
revoke all on public.email_provider_flags from public, anon, authenticated;
insert into public.email_provider_flags (provider, enabled, note) values
  ('resend', true,  'Active email provider'),
  ('gmail',  false, 'Paused. Code, tokens and history are kept. Set enabled = true to resume.'),
  ('zoho',   false, 'Paused. Code, tokens and history are kept. Set enabled = true to resume.')
on conflict (provider) do nothing;     -- never flips a value someone changed later

create or replace function public.email_provider_enabled(p_provider text) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select coalesce((select enabled from public.email_provider_flags where provider = p_provider), false)
$$;
revoke all on function public.email_provider_enabled(text) from public, anon;
grant execute on function public.email_provider_enabled(text) to authenticated, service_role;

create or replace function public.email_provider_flags_get() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
  perform public.email_require_access();
  return coalesce((select jsonb_object_agg(provider, enabled) from public.email_provider_flags), '{}'::jsonb);
end $$;
revoke all on function public.email_provider_flags_get() from public, anon;
grant execute on function public.email_provider_flags_get() to authenticated;

-- 3. Tables ----------------------------------------------------------------------------------------
create table if not exists public.email_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  provider text not null default 'resend' check (provider = 'resend'),
  address text not null check (address = lower(address) and address ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  display_name text not null default '',
  is_default boolean not null default false,
  status text not null default 'active' check (status in ('active', 'paused')),
  created_at timestamptz not null default now()
);
create unique index if not exists email_accounts_address_uidx on public.email_accounts(organization_id, address);
create unique index if not exists email_accounts_default_uidx on public.email_accounts(organization_id) where is_default;

create table if not exists public.email_conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  account_id uuid not null references public.email_accounts(id) on delete cascade,
  subject text not null default '',
  normalized_subject text not null default '',
  lead_id uuid references public.leads(id) on delete set null,
  status text not null default 'open' check (status in ('open', 'archived')),
  message_count int not null default 0,
  unread_count int not null default 0,
  last_message_at timestamptz,
  last_direction text check (last_direction in ('inbound', 'outbound')),
  snippet text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists email_conversations_list_idx on public.email_conversations(organization_id, status, last_message_at desc nulls last);
create index if not exists email_conversations_lead_idx on public.email_conversations(lead_id) where lead_id is not null;
create index if not exists email_conversations_subject_idx on public.email_conversations(organization_id, normalized_subject);
create index if not exists email_conversations_token_idx on public.email_conversations(organization_id, (replace(id::text, '-', '')) text_pattern_ops);

create table if not exists public.email_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  conversation_id uuid not null references public.email_conversations(id) on delete cascade,
  account_id uuid not null references public.email_accounts(id) on delete cascade,
  direction text not null check (direction in ('inbound', 'outbound')),
  provider text not null default 'resend',
  provider_message_id text,                       -- Resend email id (sent or received)
  rfc_message_id text,                            -- RFC 5322 Message-ID header, with angle brackets
  in_reply_to text,
  references_ids text,
  from_email text not null default '',
  from_name text not null default '',
  to_emails text[] not null default '{}',
  cc_emails text[] not null default '{}',
  bcc_emails text[] not null default '{}',
  reply_to text not null default '',
  subject text not null default '',
  body_text text not null default '',
  body_html text not null default '',
  status text not null check (status in ('draft','queued','sending','sent','delivery_delayed','delivered','bounced','complained','failed','rejected','received')),
  error text not null default '',
  is_read boolean not null default false,
  ai_generated boolean not null default false,    -- drafted by Intelligence: never sent without the person pressing Send
  idempotency_key text,
  headers jsonb not null default '{}'::jsonb,
  auth_results jsonb,
  sent_at timestamptz,
  received_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);
create unique index if not exists email_messages_provider_uidx on public.email_messages(organization_id, direction, provider_message_id) where provider_message_id is not null;
create unique index if not exists email_messages_rfc_uidx on public.email_messages(organization_id, rfc_message_id) where rfc_message_id is not null;
create unique index if not exists email_messages_idem_uidx on public.email_messages(organization_id, idempotency_key) where idempotency_key is not null;
create index if not exists email_messages_conv_idx on public.email_messages(conversation_id, coalesce(received_at, sent_at, created_at));
create index if not exists email_messages_status_idx on public.email_messages(organization_id, status) where direction = 'outbound';
create index if not exists email_messages_provider_lookup_idx on public.email_messages(provider_message_id) where provider_message_id is not null;

create table if not exists public.email_attachments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  message_id uuid not null references public.email_messages(id) on delete cascade,
  provider_attachment_id text,
  filename text not null default 'attachment',
  content_type text not null default 'application/octet-stream',
  size_bytes bigint not null default 0,
  content_id text,
  is_inline boolean not null default false,
  storage_path text,                              -- path inside the private "email-attachments" bucket
  created_at timestamptz not null default now()
);
create unique index if not exists email_attachments_provider_uidx on public.email_attachments(message_id, provider_attachment_id) where provider_attachment_id is not null;
create index if not exists email_attachments_message_idx on public.email_attachments(message_id);

create table if not exists public.email_participants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  conversation_id uuid not null references public.email_conversations(id) on delete cascade,
  email text not null,
  name text not null default '',
  first_seen_at timestamptz not null default now(),
  unique (conversation_id, email)
);

create table if not exists public.email_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  message_id uuid not null references public.email_messages(id) on delete cascade,
  event_type text not null,
  provider_event_id text,
  occurred_at timestamptz not null default now(),
  detail jsonb not null default '{}'::jsonb
);
create unique index if not exists email_events_provider_uidx on public.email_events(provider_event_id) where provider_event_id is not null;
create index if not exists email_events_message_idx on public.email_events(message_id, occurred_at);

-- Webhook log: one row per Svix delivery id. The unique svix_id makes processing idempotent.
create table if not exists public.email_webhook_events (
  id uuid primary key default gen_random_uuid(),
  svix_id text not null unique,
  event_type text not null,
  status text not null default 'received' check (status in ('received', 'processed', 'failed', 'ignored')),
  attempts int not null default 1,
  error text not null default '',
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists email_webhook_events_status_idx on public.email_webhook_events(status, received_at desc);

create table if not exists public.email_sync_state (
  account_id uuid primary key references public.email_accounts(id) on delete cascade,
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  last_webhook_at timestamptz,
  last_received_at timestamptz,
  last_error text not null default '',
  cursor jsonb not null default '{}'::jsonb
);

-- 4. Row Level Security: read for the allowed people only; no direct client writes. ------------------
do $$
declare t text;
begin
  foreach t in array array['email_accounts','email_conversations','email_messages','email_attachments','email_participants','email_events','email_sync_state'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.email_can_access(organization_id))', t || '_select', t);
  end loop;
end $$;
alter table public.email_webhook_events enable row level security;      -- service role only: no policy, no grant
revoke all on public.email_webhook_events from public, anon, authenticated;

-- 5. Conversation counters follow the messages. ------------------------------------------------------
create or replace function public._email_message_counters() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_at timestamptz;
begin
  if (tg_op = 'INSERT' and new.status <> 'draft') or (tg_op = 'UPDATE' and old.status = 'draft' and new.status <> 'draft') then
    v_at := coalesce(new.received_at, new.sent_at, case when tg_op = 'UPDATE' then now() else new.created_at end);
    update public.email_conversations c
       set message_count = c.message_count + 1,
           unread_count = c.unread_count + case when new.direction = 'inbound' and not new.is_read then 1 else 0 end,
           last_message_at = greatest(coalesce(c.last_message_at, v_at), v_at),
           last_direction = case when c.last_message_at is null or v_at >= c.last_message_at then new.direction else c.last_direction end,
           snippet = case when c.last_message_at is null or v_at >= c.last_message_at then left(regexp_replace(new.body_text, '\s+', ' ', 'g'), 200) else c.snippet end,
           status = case when new.direction = 'inbound' then 'open' else c.status end
     where c.id = new.conversation_id;
  end if;
  return new;
end $$;
drop trigger if exists email_messages_counters on public.email_messages;
create trigger email_messages_counters after insert or update of status on public.email_messages
  for each row execute function public._email_message_counters();

-- 6. Browser-facing RPCs (each starts by requiring access) -------------------------------------------
create or replace function public.email_list_accounts() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.email_require_access();
begin
  return coalesce((select jsonb_agg(to_jsonb(a) order by a.is_default desc, a.created_at) from public.email_accounts a where a.organization_id = v_org), '[]'::jsonb);
end $$;

create or replace function public.email_upsert_account(p_address text, p_display_name text default '') returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.email_require_access(); v_addr text := lower(btrim(coalesce(p_address, ''))); r public.email_accounts;
begin
  if v_addr !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email address'; end if;
  insert into public.email_accounts (organization_id, address, display_name, is_default)
  values (v_org, v_addr, left(btrim(coalesce(p_display_name, '')), 120), not exists (select 1 from public.email_accounts where organization_id = v_org))
  on conflict (organization_id, address) do update set display_name = excluded.display_name
  returning * into r;
  return to_jsonb(r);
end $$;

create or replace function public.email_list_conversations(p_folder text default 'inbox', p_search text default null, p_limit int default 50, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.email_require_access(); v_q text := null; v_limit int := least(greatest(coalesce(p_limit, 50), 1), 100);
begin
  if p_folder not in ('inbox', 'unread', 'sent', 'drafts', 'archived', 'all') then raise exception 'Unknown folder'; end if;
  if nullif(btrim(coalesce(p_search, '')), '') is not null then
    v_q := '%' || replace(replace(replace(lower(btrim(p_search)), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;
  return coalesce((
    select jsonb_agg(s.x order by s.sort_at desc nulls last)
    from (
      select jsonb_build_object(
               'id', c.id, 'subject', c.subject, 'snippet', c.snippet, 'status', c.status, 'lead_id', c.lead_id,
               'message_count', c.message_count, 'unread_count', c.unread_count, 'last_message_at', c.last_message_at,
               'last_direction', c.last_direction, 'has_draft', exists (select 1 from public.email_messages d where d.conversation_id = c.id and d.status = 'draft'),
               'has_attachments', exists (select 1 from public.email_attachments a join public.email_messages m on m.id = a.message_id where m.conversation_id = c.id),
               'participants', coalesce((select jsonb_agg(jsonb_build_object('email', p.email, 'name', p.name) order by p.first_seen_at) from public.email_participants p where p.conversation_id = c.id), '[]'::jsonb)
             ) as x,
             coalesce(c.last_message_at, c.created_at) as sort_at
        from public.email_conversations c
       where c.organization_id = v_org
         and case p_folder
               when 'inbox'    then c.status = 'open' and exists (select 1 from public.email_messages m where m.conversation_id = c.id and m.direction = 'inbound')
               when 'unread'   then c.status = 'open' and c.unread_count > 0
               when 'sent'     then exists (select 1 from public.email_messages m where m.conversation_id = c.id and m.direction = 'outbound' and m.status <> 'draft')
               when 'drafts'   then exists (select 1 from public.email_messages m where m.conversation_id = c.id and m.status = 'draft')
               when 'archived' then c.status = 'archived'
               else true end
         and (v_q is null
              or lower(c.subject) like v_q escape '\'
              or lower(c.snippet) like v_q escape '\'
              or exists (select 1 from public.email_participants p where p.conversation_id = c.id and (lower(p.email) like v_q escape '\' or lower(p.name) like v_q escape '\'))
              or exists (select 1 from public.email_messages m where m.conversation_id = c.id and lower(m.body_text) like v_q escape '\'))
       order by sort_at desc nulls last
       limit v_limit offset greatest(coalesce(p_offset, 0), 0)
    ) s), '[]'::jsonb);
end $$;

create or replace function public.email_get_conversation(p_conversation_id uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.email_require_access(); c public.email_conversations;
begin
  select * into c from public.email_conversations where id = p_conversation_id and organization_id = v_org;
  if not found then raise exception 'Conversation not found'; end if;
  return jsonb_build_object(
    'conversation', to_jsonb(c),
    'participants', coalesce((select jsonb_agg(to_jsonb(p) order by p.first_seen_at) from public.email_participants p where p.conversation_id = c.id), '[]'::jsonb),
    'messages', coalesce((
      select jsonb_agg(
               (to_jsonb(m) - 'headers' - 'auth_results' - 'idempotency_key')
               || jsonb_build_object('attachments', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'filename', a.filename, 'content_type', a.content_type, 'size_bytes', a.size_bytes, 'is_inline', a.is_inline, 'storage_path', a.storage_path)
                                                                              order by a.created_at) from public.email_attachments a where a.message_id = m.id), '[]'::jsonb))
               order by coalesce(m.received_at, m.sent_at, m.created_at), m.created_at)
        from public.email_messages m where m.conversation_id = c.id), '[]'::jsonb));
end $$;

create or replace function public.email_mark_read(p_conversation_id uuid, p_read boolean default true) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.email_require_access(); v_unread int;
begin
  if not exists (select 1 from public.email_conversations where id = p_conversation_id and organization_id = v_org) then raise exception 'Conversation not found'; end if;
  if p_read is false then
    -- "mark unread" flags the newest incoming message only
    update public.email_messages set is_read = false
     where id = (select id from public.email_messages where conversation_id = p_conversation_id and direction = 'inbound' and status <> 'draft' order by coalesce(received_at, created_at) desc limit 1);
  else
    update public.email_messages set is_read = true where conversation_id = p_conversation_id and direction = 'inbound' and not is_read;
  end if;
  select count(*) into v_unread from public.email_messages where conversation_id = p_conversation_id and direction = 'inbound' and status <> 'draft' and not is_read;
  update public.email_conversations set unread_count = v_unread where id = p_conversation_id;
  return jsonb_build_object('unread_count', v_unread);
end $$;

create or replace function public.email_set_archived(p_conversation_id uuid, p_archived boolean) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.email_require_access();
begin
  update public.email_conversations set status = case when p_archived then 'archived' else 'open' end where id = p_conversation_id and organization_id = v_org;
  if not found then raise exception 'Conversation not found'; end if;
  return jsonb_build_object('archived', p_archived);
end $$;

-- Leads are owned per user in this app, so only a lead the caller owns can be linked.
create or replace function public.email_link_lead(p_conversation_id uuid, p_lead_id uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.email_require_access();
begin
  if p_lead_id is not null and not exists (select 1 from public.leads l where l.id = p_lead_id and l.user_id = auth.uid()) then
    raise exception 'Lead not found';
  end if;
  update public.email_conversations set lead_id = p_lead_id where id = p_conversation_id and organization_id = v_org;
  if not found then raise exception 'Conversation not found'; end if;
  return jsonb_build_object('lead_id', p_lead_id);
end $$;

create or replace function public.email_unread_total() returns int
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.email_require_access();
begin
  return coalesce((select sum(unread_count)::int from public.email_conversations where organization_id = v_org and status = 'open'), 0);
end $$;

create or replace function public.email_save_draft(
  p_draft_id uuid, p_conversation_id uuid, p_account_id uuid,
  p_to text[], p_cc text[], p_bcc text[], p_subject text, p_body_text text, p_body_html text default ''
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.email_require_access(); v_conv uuid := p_conversation_id; v_acc public.email_accounts; m public.email_messages;
begin
  select * into v_acc from public.email_accounts where id = p_account_id and organization_id = v_org;
  if not found then raise exception 'Sender address not found'; end if;
  if p_draft_id is not null then
    update public.email_messages
       set to_emails = coalesce(p_to, '{}'), cc_emails = coalesce(p_cc, '{}'), bcc_emails = coalesce(p_bcc, '{}'),
           subject = left(coalesce(p_subject, ''), 998), body_text = left(coalesce(p_body_text, ''), 200000), body_html = left(coalesce(p_body_html, ''), 400000), ai_generated = false
     where id = p_draft_id and organization_id = v_org and status = 'draft'
     returning * into m;
    if not found then raise exception 'Draft not found'; end if;
    return jsonb_build_object('draft_id', m.id, 'conversation_id', m.conversation_id);
  end if;
  if v_conv is null then
    insert into public.email_conversations (organization_id, account_id, subject, normalized_subject)
    values (v_org, v_acc.id, left(coalesce(p_subject, ''), 998), '') returning id into v_conv;
  elsif not exists (select 1 from public.email_conversations where id = v_conv and organization_id = v_org) then
    raise exception 'Conversation not found';
  end if;
  insert into public.email_messages (organization_id, conversation_id, account_id, direction, status, from_email, from_name, to_emails, cc_emails, bcc_emails, subject, body_text, body_html, is_read, created_by)
  values (v_org, v_conv, v_acc.id, 'outbound', 'draft', v_acc.address, v_acc.display_name, coalesce(p_to, '{}'), coalesce(p_cc, '{}'), coalesce(p_bcc, '{}'),
          left(coalesce(p_subject, ''), 998), left(coalesce(p_body_text, ''), 200000), left(coalesce(p_body_html, ''), 400000), true, auth.uid())
  returning * into m;
  return jsonb_build_object('draft_id', m.id, 'conversation_id', m.conversation_id);
end $$;

create or replace function public.email_delete_draft(p_draft_id uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.email_require_access(); v_conv uuid;
begin
  delete from public.email_messages where id = p_draft_id and organization_id = v_org and status = 'draft' returning conversation_id into v_conv;
  if not found then raise exception 'Draft not found'; end if;
  -- an empty conversation that only existed for this draft goes with it
  delete from public.email_conversations c where c.id = v_conv and not exists (select 1 from public.email_messages m where m.conversation_id = c.id);
  return jsonb_build_object('deleted', true);
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'email_list_accounts()', 'email_upsert_account(text,text)', 'email_list_conversations(text,text,int,int)', 'email_get_conversation(uuid)',
    'email_mark_read(uuid,boolean)', 'email_set_archived(uuid,boolean)', 'email_link_lead(uuid,uuid)', 'email_unread_total()',
    'email_save_draft(uuid,uuid,uuid,text[],text[],text[],text,text,text)', 'email_delete_draft(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- 7. Intelligence interface: read-only context for the worker's own identity, plus AI drafts that are never auto-sent. ----
create or replace function public.intel_agent_email_recent_inbound(p_limit int default 20) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org();
begin
  return coalesce((
    select jsonb_agg(x) from (
      select jsonb_build_object('message_id', m.id, 'conversation_id', m.conversation_id, 'lead_id', c.lead_id, 'subject', m.subject,
               'from_email', m.from_email, 'from_name', m.from_name, 'body_text', left(m.body_text, 20000), 'received_at', m.received_at) as x
        from public.email_messages m join public.email_conversations c on c.id = m.conversation_id
       where m.organization_id = v_org and m.direction = 'inbound' and m.received_at > now() - interval '14 days'
       order by m.received_at desc limit least(greatest(coalesce(p_limit, 20), 1), 50)) s), '[]'::jsonb);
end $$;

create or replace function public.intel_agent_email_thread(p_conversation_id uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org(); c public.email_conversations;
begin
  select * into c from public.email_conversations where id = p_conversation_id and organization_id = v_org;
  if not found then raise exception 'Conversation not found'; end if;
  return jsonb_build_object('conversation_id', c.id, 'subject', c.subject, 'lead_id', c.lead_id,
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'direction', m.direction, 'from_email', m.from_email, 'to_emails', m.to_emails,
                                                                'subject', m.subject, 'body_text', left(m.body_text, 20000), 'at', coalesce(m.received_at, m.sent_at, m.created_at))
                                           order by coalesce(m.received_at, m.sent_at, m.created_at))
                            from public.email_messages m where m.conversation_id = c.id and m.status <> 'draft'), '[]'::jsonb));   -- never bcc, headers or raw html
end $$;

-- The agent can only leave a DRAFT flagged ai_generated. Sending needs a person pressing Send in KairFlow.
create or replace function public.intel_agent_email_save_draft(p_conversation_id uuid, p_subject text, p_body_text text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org(); c public.email_conversations; a public.email_accounts; last_in public.email_messages; m public.email_messages;
begin
  select * into c from public.email_conversations where id = p_conversation_id and organization_id = v_org;
  if not found then raise exception 'Conversation not found'; end if;
  select * into a from public.email_accounts where id = c.account_id;
  select * into last_in from public.email_messages where conversation_id = c.id and direction = 'inbound' order by coalesce(received_at, created_at) desc limit 1;
  insert into public.email_messages (organization_id, conversation_id, account_id, direction, status, from_email, from_name, to_emails, subject, body_text, is_read, ai_generated)
  values (v_org, c.id, a.id, 'outbound', 'draft', a.address, a.display_name, case when last_in.id is null then '{}' else array[last_in.from_email] end,
          left(coalesce(p_subject, ''), 998), left(coalesce(p_body_text, ''), 200000), true, true)
  returning * into m;
  return jsonb_build_object('draft_id', m.id);
end $$;

revoke all on function public.intel_agent_email_recent_inbound(int) from public, anon;
revoke all on function public.intel_agent_email_thread(uuid) from public, anon;
revoke all on function public.intel_agent_email_save_draft(uuid,text,text) from public, anon;
grant execute on function public.intel_agent_email_recent_inbound(int) to authenticated;
grant execute on function public.intel_agent_email_thread(uuid) to authenticated;
grant execute on function public.intel_agent_email_save_draft(uuid,text,text) to authenticated;

-- 8. Service-only functions used by the Edge Functions (service role; never executable by clients) ------
create or replace function public.email_ingest_inbound(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := (p ->> 'organization_id')::uuid; v_acc uuid := (p ->> 'account_id')::uuid; v_conv uuid := nullif(p ->> 'conversation_id', '')::uuid;
  v_msg uuid; v_existing uuid; part jsonb; att jsonb; v_addr text;
begin
  select id into v_existing from public.email_messages
   where organization_id = v_org and ((direction = 'inbound' and provider_message_id = p ->> 'provider_message_id')
                                    or (nullif(p ->> 'rfc_message_id', '') is not null and rfc_message_id = p ->> 'rfc_message_id'));
  if v_existing is not null then
    return jsonb_build_object('duplicate', true, 'message_id', v_existing);
  end if;
  if v_conv is null or not exists (select 1 from public.email_conversations where id = v_conv and organization_id = v_org) then
    insert into public.email_conversations (organization_id, account_id, subject, normalized_subject)
    values (v_org, v_acc, left(coalesce(p ->> 'subject', ''), 998), coalesce(p ->> 'normalized_subject', '')) returning id into v_conv;
  end if;
  insert into public.email_messages (organization_id, conversation_id, account_id, direction, provider_message_id, rfc_message_id, in_reply_to, references_ids,
         from_email, from_name, to_emails, cc_emails, bcc_emails, reply_to, subject, body_text, body_html, status, is_read, headers, auth_results, received_at)
  values (v_org, v_conv, v_acc, 'inbound', p ->> 'provider_message_id', nullif(p ->> 'rfc_message_id', ''), nullif(p ->> 'in_reply_to', ''), nullif(p ->> 'references_ids', ''),
          lower(coalesce(p ->> 'from_email', '')), left(coalesce(p ->> 'from_name', ''), 200),
          coalesce(array(select jsonb_array_elements_text(p -> 'to_emails')), '{}'), coalesce(array(select jsonb_array_elements_text(p -> 'cc_emails')), '{}'),
          coalesce(array(select jsonb_array_elements_text(p -> 'bcc_emails')), '{}'), left(coalesce(p ->> 'reply_to', ''), 500),
          left(coalesce(p ->> 'subject', ''), 998), left(coalesce(p ->> 'body_text', ''), 400000), left(coalesce(p ->> 'body_html', ''), 800000),
          'received', false, coalesce(p -> 'headers', '{}'::jsonb), p -> 'auth_results', coalesce((p ->> 'received_at')::timestamptz, now()))
  returning id into v_msg;

  for part in select * from jsonb_array_elements(coalesce(p -> 'participants', '[]'::jsonb)) loop
    v_addr := lower(btrim(coalesce(part ->> 'email', '')));
    if v_addr <> '' then
      insert into public.email_participants (organization_id, conversation_id, email, name) values (v_org, v_conv, v_addr, left(coalesce(part ->> 'name', ''), 200))
      on conflict (conversation_id, email) do update set name = case when public.email_participants.name = '' then excluded.name else public.email_participants.name end;
    end if;
  end loop;

  for att in select * from jsonb_array_elements(coalesce(p -> 'attachments', '[]'::jsonb)) loop
    insert into public.email_attachments (organization_id, message_id, provider_attachment_id, filename, content_type, size_bytes, content_id, is_inline, storage_path)
    values (v_org, v_msg, att ->> 'provider_attachment_id', left(coalesce(att ->> 'filename', 'attachment'), 300), coalesce(att ->> 'content_type', 'application/octet-stream'),
            coalesce((att ->> 'size_bytes')::bigint, 0), nullif(att ->> 'content_id', ''), coalesce((att ->> 'is_inline')::boolean, false), nullif(att ->> 'storage_path', ''))
    on conflict do nothing;
  end loop;

  insert into public.email_events (organization_id, message_id, event_type, detail) values (v_org, v_msg, 'received', '{}'::jsonb);
  insert into public.email_sync_state (account_id, organization_id, last_webhook_at, last_received_at) values (v_acc, v_org, now(), now())
  on conflict (account_id) do update set last_webhook_at = now(), last_received_at = now(), last_error = '';
  return jsonb_build_object('duplicate', false, 'message_id', v_msg, 'conversation_id', v_conv);
end $$;

-- Creates (or reuses) the outbound row BEFORE calling Resend, so a retry or double click never creates two messages.
create or replace function public.email_create_outbound(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := (p ->> 'organization_id')::uuid; v_acc public.email_accounts; v_conv uuid := nullif(p ->> 'conversation_id', '')::uuid;
  v_draft uuid := nullif(p ->> 'draft_id', '')::uuid; v_key text := nullif(p ->> 'idempotency_key', ''); m public.email_messages; v_addr text; r text;
begin
  select * into v_acc from public.email_accounts where id = (p ->> 'account_id')::uuid and organization_id = v_org;
  if not found then raise exception 'Sender address not found'; end if;
  if v_key is not null then
    select * into m from public.email_messages where organization_id = v_org and idempotency_key = v_key;
    if found then return jsonb_build_object('duplicate', true, 'message_id', m.id, 'conversation_id', m.conversation_id, 'status', m.status, 'provider_message_id', m.provider_message_id); end if;
  end if;
  if v_conv is not null and not exists (select 1 from public.email_conversations where id = v_conv and organization_id = v_org) then raise exception 'Conversation not found'; end if;
  if v_draft is not null then
    select conversation_id into v_conv from public.email_messages where id = v_draft and organization_id = v_org and status = 'draft';
    if not found then raise exception 'Draft not found'; end if;
    update public.email_messages
       set status = 'queued', from_email = v_acc.address, from_name = v_acc.display_name,
           to_emails = coalesce(array(select jsonb_array_elements_text(p -> 'to_emails')), '{}'), cc_emails = coalesce(array(select jsonb_array_elements_text(p -> 'cc_emails')), '{}'),
           bcc_emails = coalesce(array(select jsonb_array_elements_text(p -> 'bcc_emails')), '{}'), reply_to = left(coalesce(p ->> 'reply_to', ''), 500),
           subject = left(coalesce(p ->> 'subject', ''), 998), body_text = left(coalesce(p ->> 'body_text', ''), 200000), body_html = left(coalesce(p ->> 'body_html', ''), 400000),
           in_reply_to = nullif(p ->> 'in_reply_to', ''), references_ids = nullif(p ->> 'references_ids', ''), idempotency_key = v_key, created_by = nullif(p ->> 'user_id', '')::uuid
     where id = v_draft returning * into m;
  else
    if v_conv is null then
      insert into public.email_conversations (organization_id, account_id, subject, normalized_subject)
      values (v_org, v_acc.id, left(coalesce(p ->> 'subject', ''), 998), coalesce(p ->> 'normalized_subject', '')) returning id into v_conv;
    end if;
    insert into public.email_messages (organization_id, conversation_id, account_id, direction, status, from_email, from_name, to_emails, cc_emails, bcc_emails, reply_to,
           subject, body_text, body_html, in_reply_to, references_ids, is_read, idempotency_key, created_by)
    values (v_org, v_conv, v_acc.id, 'outbound', 'queued', v_acc.address, v_acc.display_name,
            coalesce(array(select jsonb_array_elements_text(p -> 'to_emails')), '{}'), coalesce(array(select jsonb_array_elements_text(p -> 'cc_emails')), '{}'),
            coalesce(array(select jsonb_array_elements_text(p -> 'bcc_emails')), '{}'), left(coalesce(p ->> 'reply_to', ''), 500),
            left(coalesce(p ->> 'subject', ''), 998), left(coalesce(p ->> 'body_text', ''), 200000), left(coalesce(p ->> 'body_html', ''), 400000),
            nullif(p ->> 'in_reply_to', ''), nullif(p ->> 'references_ids', ''), true, v_key, nullif(p ->> 'user_id', '')::uuid)
    returning * into m;
  end if;
  -- everyone on the message becomes a participant of the conversation
  foreach r in array array['to_emails', 'cc_emails'] loop
    for v_addr in select lower(btrim(x)) from jsonb_array_elements_text(coalesce(p -> r, '[]'::jsonb)) x loop
      insert into public.email_participants (organization_id, conversation_id, email) values (v_org, m.conversation_id, v_addr) on conflict (conversation_id, email) do nothing;
    end loop;
  end loop;
  insert into public.email_participants (organization_id, conversation_id, email, name) values (v_org, m.conversation_id, v_acc.address, v_acc.display_name) on conflict (conversation_id, email) do nothing;
  return jsonb_build_object('duplicate', false, 'message_id', m.id, 'conversation_id', m.conversation_id, 'status', m.status);
end $$;

-- Delivery events only ever move a message forward (delivered never goes back to sent); bad outcomes always win.
create or replace function public._email_status_rank(p text) returns int language sql immutable as $$
  select case p when 'draft' then 0 when 'queued' then 10 when 'sending' then 20 when 'sent' then 30 when 'delivery_delayed' then 35
                when 'delivered' then 40 when 'failed' then 90 when 'rejected' then 90 when 'bounced' then 90 when 'complained' then 95 else 0 end
$$;

create or replace function public.email_apply_delivery_event(p_provider_message_id text, p_status text, p_event_type text, p_provider_event_id text, p_occurred_at timestamptz, p_detail jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare m public.email_messages;
begin
  select * into m from public.email_messages where direction = 'outbound' and provider_message_id = p_provider_message_id order by created_at desc limit 1;
  if not found then return jsonb_build_object('found', false); end if;
  insert into public.email_events (organization_id, message_id, event_type, provider_event_id, occurred_at, detail)
  values (m.organization_id, m.id, p_event_type, p_provider_event_id, coalesce(p_occurred_at, now()), coalesce(p_detail, '{}'::jsonb))
  on conflict (provider_event_id) where provider_event_id is not null do nothing;
  if public._email_status_rank(p_status) >= public._email_status_rank(m.status) then
    update public.email_messages
       set status = p_status,
           error = case when p_status in ('bounced', 'failed', 'rejected', 'complained') then left(coalesce(p_detail ->> 'reason', p_event_type), 500) else error end,
           sent_at = coalesce(sent_at, case when p_status = 'sent' then coalesce(p_occurred_at, now()) end)
     where id = m.id;
  end if;
  return jsonb_build_object('found', true, 'message_id', m.id);
end $$;

-- Finds the conversation a plus-address token (first 12 hex characters of the conversation id) points to.
create or replace function public.email_find_conversation_by_token(p_organization_id uuid, p_token text) returns uuid
language sql stable security definer set search_path = pg_catalog, public as $$
  select id from public.email_conversations
   where organization_id = p_organization_id and p_token ~ '^[0-9a-f]{12}$' and replace(id::text, '-', '') like p_token || '%'
   order by created_at desc limit 1
$$;

do $$
declare f text;
begin
  foreach f in array array['email_ingest_inbound(jsonb)', 'email_create_outbound(jsonb)', 'email_apply_delivery_event(text,text,text,text,timestamptz,jsonb)', 'email_find_conversation_by_token(uuid,text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
revoke all on function public._email_status_rank(text) from public, anon, authenticated;
revoke all on function public._email_message_counters() from public, anon, authenticated;

-- 9. Private attachment bucket, readable only by the allowed people (paths start with the studio id). -----
do $$ begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('email-attachments', 'email-attachments', false) on conflict (id) do nothing;
  end if;
end $$;
do $$ begin
  if to_regclass('storage.objects') is not null and to_regprocedure('storage.foldername(text)') is not null then
    drop policy if exists email_attachments_read on storage.objects;
    create policy email_attachments_read on storage.objects for select to authenticated
      using (bucket_id = 'email-attachments'
             and (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             and public.email_can_access(((storage.foldername(name))[1])::uuid));
  end if;
end $$;

commit;

-- Rollback (removes only what this file created; Gmail/Zoho/Intelligence objects are untouched):
--   drop function if exists public.intel_agent_email_save_draft(uuid,text,text), public.intel_agent_email_thread(uuid), public.intel_agent_email_recent_inbound(int);
--   drop table if exists public.email_sync_state, public.email_webhook_events, public.email_events, public.email_participants, public.email_attachments,
--                        public.email_messages, public.email_conversations, public.email_accounts, public.email_provider_flags cascade;
