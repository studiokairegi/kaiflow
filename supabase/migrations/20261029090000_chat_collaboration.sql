-- KairFlow authenticated internal chat, with additive organization/membership primitives.
-- This migration intentionally does NOT create client-facing chat: the existing client portal
-- includes token-based guest access, which is not an authenticated client identity. Internal chat
-- is therefore always internal, and clients cannot join these conversations.
--
-- IMPORTANT BOOTSTRAP: after reviewing this migration, a trusted Supabase administrator must run
-- the one-time owner provisioning SQL documented in docs/chat-collaboration-rollout.md. This
-- migration never guesses which existing account should become Master User and never promotes
-- accounts based on user-editable profile fields or user_settings.is_admin.

begin;

create table if not exists public.studio_organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$'),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.studio_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete restrict,
  role text not null check (role in ('master_user','department_admin','staff','freelancer','client')),
  status text not null default 'active' check (status in ('active','suspended')),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 80),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id),
  unique (organization_id, id)
);
create unique index if not exists studio_memberships_one_master_per_org_idx
  on public.studio_memberships(organization_id) where role = 'master_user' and status = 'active';
create index if not exists studio_memberships_user_status_idx
  on public.studio_memberships(user_id, status, organization_id);

create table if not exists public.studio_departments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (organization_id, id)
);
create unique index if not exists studio_departments_name_ci_idx
  on public.studio_departments(organization_id, lower(name));

create table if not exists public.studio_department_memberships (
  organization_id uuid not null,
  department_id uuid not null,
  user_id uuid not null,
  department_role text not null default 'member' check (department_role in ('admin','member')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (department_id, user_id),
  foreign key (organization_id, department_id)
    references public.studio_departments(organization_id, id) on delete cascade,
  foreign key (organization_id, user_id)
    references public.studio_memberships(organization_id, user_id) on delete cascade
);
create index if not exists studio_department_memberships_user_idx
  on public.studio_department_memberships(organization_id, user_id, department_id);

create table if not exists public.chat_conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  kind text not null check (kind in ('direct','group','project')),
  audience text not null default 'internal' check (audience = 'internal'),
  title text,
  project_id uuid references public.projects(id) on delete set null,
  project_name text,
  department_id uuid,
  direct_pair_key text,
  created_by uuid not null references auth.users(id) on delete restrict,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, department_id)
    references public.studio_departments(organization_id, id) on delete restrict,
  check (
    (kind = 'direct' and direct_pair_key is not null and project_id is null and department_id is null and title is null)
    or (kind = 'group' and direct_pair_key is null and project_id is null and char_length(btrim(coalesce(title,''))) between 1 and 100)
    or (kind = 'project' and direct_pair_key is null and project_id is not null and department_id is null)
  )
);
create unique index if not exists chat_conversations_direct_pair_unique_idx
  on public.chat_conversations(organization_id, direct_pair_key) where kind = 'direct';
create index if not exists chat_conversations_org_updated_idx
  on public.chat_conversations(organization_id, updated_at desc, id desc) where archived_at is null;
create index if not exists chat_conversations_project_idx
  on public.chat_conversations(project_id) where project_id is not null;

create table if not exists public.chat_conversation_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete restrict,
  role text not null default 'member' check (role in ('owner','admin','member')),
  status text not null default 'active' check (status in ('active','left','removed')),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  removed_at timestamptz,
  unique (conversation_id, user_id),
  foreign key (organization_id, user_id)
    references public.studio_memberships(organization_id, user_id) on delete restrict
);
create index if not exists chat_conversation_members_user_idx
  on public.chat_conversation_members(organization_id, user_id, status, conversation_id);
create index if not exists chat_conversation_members_conversation_idx
  on public.chat_conversation_members(conversation_id, status, user_id);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  sender_user_id uuid not null references auth.users(id) on delete restrict,
  body text not null default '',
  reply_to_id uuid references public.chat_messages(id) on delete set null,
  idempotency_key uuid not null,
  request_fingerprint text not null,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id) on delete set null,
  search_vector tsvector generated always as (to_tsvector('simple', coalesce(body, ''))) stored,
  check (char_length(body) <= 10000),
  unique (conversation_id, sender_user_id, idempotency_key)
);
create index if not exists chat_messages_conversation_page_idx
  on public.chat_messages(conversation_id, created_at desc, id desc);
create index if not exists chat_messages_search_idx on public.chat_messages using gin(search_vector);
create index if not exists chat_messages_sender_idx on public.chat_messages(sender_user_id, created_at desc);

create table if not exists public.chat_read_state (
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  last_read_message_id uuid references public.chat_messages(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create table if not exists public.chat_reactions (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete restrict,
  reaction text not null check (char_length(reaction) between 1 and 32),
  created_at timestamptz not null default now(),
  unique (message_id, user_id, reaction)
);
create index if not exists chat_reactions_conversation_idx on public.chat_reactions(conversation_id, message_id);

create table if not exists public.chat_attachments (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  message_id uuid references public.chat_messages(id) on delete set null,
  object_path text not null unique,
  file_name text not null check (char_length(file_name) between 1 and 255),
  content_type text not null,
  size_bytes bigint not null check (size_bytes between 1 and 20971520),
  uploaded_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);
create index if not exists chat_attachments_message_idx on public.chat_attachments(message_id);
create index if not exists chat_attachments_conversation_idx on public.chat_attachments(conversation_id, created_at);

create table if not exists public.chat_pins (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  pinned_by uuid not null references auth.users(id) on delete restrict,
  pinned_at timestamptz not null default now(),
  unique (conversation_id, message_id)
);

create table if not exists public.chat_message_edits (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  editor_user_id uuid not null references auth.users(id) on delete restrict,
  old_body text not null,
  new_body text not null,
  changed_at timestamptz not null default now()
);
create index if not exists chat_message_edits_message_idx on public.chat_message_edits(message_id, changed_at desc);

create table if not exists public.chat_audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  conversation_id uuid references public.chat_conversations(id) on delete set null,
  actor_user_id uuid references auth.users(id) on delete set null,
  event_type text not null check (event_type in (
    'conversation_created','conversation_updated','member_added','member_removed','member_left',
    'message_sent','message_edited','message_deleted','reaction_added','reaction_removed',
    'message_pinned','message_unpinned','attachment_uploaded','message_read',
    'studio_member_added','studio_member_suspended','studio_member_activated',
    'department_created','department_member_assigned','member_role_changed'
  )),
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists chat_audit_org_created_idx on public.chat_audit_events(organization_id, created_at desc);
create index if not exists chat_audit_conversation_created_idx on public.chat_audit_events(conversation_id, created_at desc);

-- ----------------------------------------------------------------------------
-- Trusted authorization helpers. All use the caller's JWT identity, never an arbitrary user id.
-- ----------------------------------------------------------------------------
create or replace function public.chat_is_org_member(p_organization_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.studio_memberships m
    where m.organization_id = p_organization_id and m.user_id = auth.uid() and m.status = 'active'
  );
$$;

create or replace function public.chat_is_org_master(p_organization_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.studio_memberships m
    where m.organization_id = p_organization_id and m.user_id = auth.uid()
      and m.status = 'active' and m.role = 'master_user'
  );
$$;

create or replace function public.chat_is_department_admin(p_organization_id uuid, p_department_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.studio_department_memberships dm
    join public.studio_memberships m
      on m.organization_id = dm.organization_id and m.user_id = dm.user_id
    where dm.organization_id = p_organization_id and dm.department_id = p_department_id
      and dm.user_id = auth.uid() and dm.department_role = 'admin'
      and m.status = 'active' and m.role = 'department_admin'
  );
$$;

create or replace function public.chat_is_internal_member(p_organization_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.studio_memberships m
    where m.organization_id = p_organization_id and m.user_id = auth.uid()
      and m.status = 'active' and m.role <> 'client'
  );
$$;

-- Existing KairFlow projects are owner-scoped; there is no shared-project ACL yet.
-- Until that foundation exists, only the project owner and trusted Master User can read a project chat.
-- This deliberately avoids turning a project UUID or a chat invitation into project access.
create or replace function public.chat_user_can_access_project(
  p_organization_id uuid, p_project_id uuid, p_user_id uuid
) returns boolean language sql stable security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.projects p
    join public.studio_memberships actor
      on actor.organization_id = p_organization_id and actor.user_id = p_user_id
      and actor.status = 'active' and actor.role <> 'client'
    where p.id = p_project_id and (
      p.user_id = p_user_id
      or (actor.role = 'master_user' and exists (
        select 1 from public.studio_memberships project_owner
        where project_owner.organization_id = p_organization_id
          and project_owner.user_id = p.user_id and project_owner.status = 'active'
      ))
    )
  );
$$;

create or replace function public.chat_can_read_conversation(p_conversation_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.chat_conversations c
    join public.studio_memberships me
      on me.organization_id = c.organization_id and me.user_id = auth.uid()
      and me.status = 'active' and me.role <> 'client'
    where c.id = p_conversation_id and c.audience = 'internal'
      and c.archived_at is null
      and (c.kind <> 'project' or public.chat_user_can_access_project(c.organization_id,c.project_id,auth.uid()))
      and (
        exists (select 1 from public.chat_conversation_members cm
                where cm.conversation_id = c.id and cm.user_id = auth.uid() and cm.status = 'active')
        or (me.role = 'master_user' and c.kind in ('group','project'))
      )
  );
$$;

create or replace function public.chat_can_manage_conversation(p_conversation_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.chat_conversations c
    join public.studio_memberships me
      on me.organization_id = c.organization_id and me.user_id = auth.uid()
      and me.status = 'active' and me.role <> 'client'
    where c.id = p_conversation_id and c.archived_at is null
      and (c.kind <> 'project' or public.chat_user_can_access_project(c.organization_id,c.project_id,auth.uid()))
      and (
        (me.role = 'master_user' and c.kind in ('group','project'))
        or exists (select 1 from public.chat_conversation_members cm
                   where cm.conversation_id = c.id and cm.user_id = auth.uid()
                     and cm.status = 'active' and cm.role in ('owner','admin'))
        or (c.department_id is not null and me.role = 'department_admin'
            and public.chat_is_department_admin(c.organization_id, c.department_id))
      )
  );
$$;

create or replace function public.chat_realtime_topic_allowed(p_topic text)
returns boolean language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare v_id text;
begin
  if p_topic !~ '^kf-chat:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then return false; end if;
  v_id := split_part(p_topic, ':', 2);
  return public.chat_can_read_conversation(v_id::uuid);
exception when others then return false;
end;
$$;

-- ----------------------------------------------------------------------------
-- RLS and grants: users read only authorized records; all writes go through checked RPCs/triggers.
-- ----------------------------------------------------------------------------
alter table public.studio_organizations enable row level security;
alter table public.studio_memberships enable row level security;
alter table public.studio_departments enable row level security;
alter table public.studio_department_memberships enable row level security;
alter table public.chat_conversations enable row level security;
alter table public.chat_conversation_members enable row level security;
alter table public.chat_messages enable row level security;
alter table public.chat_read_state enable row level security;
alter table public.chat_reactions enable row level security;
alter table public.chat_attachments enable row level security;
alter table public.chat_pins enable row level security;
alter table public.chat_message_edits enable row level security;
alter table public.chat_audit_events enable row level security;

revoke all on public.studio_organizations, public.studio_memberships, public.studio_departments,
  public.studio_department_memberships, public.chat_conversations, public.chat_conversation_members,
  public.chat_messages, public.chat_read_state, public.chat_reactions, public.chat_attachments,
  public.chat_pins, public.chat_message_edits, public.chat_audit_events from public, anon, authenticated;
grant select on public.studio_organizations, public.studio_memberships, public.studio_departments,
  public.studio_department_memberships, public.chat_conversations, public.chat_conversation_members,
  public.chat_messages, public.chat_read_state, public.chat_reactions, public.chat_attachments,
  public.chat_pins, public.chat_message_edits, public.chat_audit_events to authenticated;

-- All policies are recreated under versioned names so rerunning this additive migration is safe.
drop policy if exists chat_org_select on public.studio_organizations;
create policy chat_org_select on public.studio_organizations for select to authenticated
  using (public.chat_is_org_member(id));
drop policy if exists chat_membership_select on public.studio_memberships;
create policy chat_membership_select on public.studio_memberships for select to authenticated
  using (user_id = auth.uid() or public.chat_is_org_master(organization_id));
drop policy if exists chat_department_select on public.studio_departments;
create policy chat_department_select on public.studio_departments for select to authenticated
  using (public.chat_is_org_member(organization_id));
drop policy if exists chat_department_member_select on public.studio_department_memberships;
create policy chat_department_member_select on public.studio_department_memberships for select to authenticated
  using (user_id = auth.uid() or public.chat_is_org_master(organization_id)
      or public.chat_is_department_admin(organization_id, department_id));
drop policy if exists chat_conversation_select on public.chat_conversations;
create policy chat_conversation_select on public.chat_conversations for select to authenticated
  using (public.chat_can_read_conversation(id));
drop policy if exists chat_conversation_update on public.chat_conversations;
create policy chat_conversation_update on public.chat_conversations for update to authenticated
  using (public.chat_can_manage_conversation(id)) with check (public.chat_can_manage_conversation(id));
drop policy if exists chat_conversation_member_select on public.chat_conversation_members;
create policy chat_conversation_member_select on public.chat_conversation_members for select to authenticated
  using (public.chat_can_read_conversation(conversation_id));
drop policy if exists chat_message_select on public.chat_messages;
create policy chat_message_select on public.chat_messages for select to authenticated
  using (public.chat_can_read_conversation(conversation_id));
drop policy if exists chat_read_state_select on public.chat_read_state;
create policy chat_read_state_select on public.chat_read_state for select to authenticated
  using (user_id = auth.uid() and public.chat_can_read_conversation(conversation_id));
drop policy if exists chat_reaction_select on public.chat_reactions;
create policy chat_reaction_select on public.chat_reactions for select to authenticated
  using (public.chat_can_read_conversation(conversation_id));
drop policy if exists chat_attachment_select on public.chat_attachments;
create policy chat_attachment_select on public.chat_attachments for select to authenticated
  using (public.chat_can_read_conversation(conversation_id)
    and message_id is not null and exists (select 1 from public.chat_messages m
      where m.id = message_id and m.deleted_at is null));
drop policy if exists chat_pin_select on public.chat_pins;
create policy chat_pin_select on public.chat_pins for select to authenticated
  using (public.chat_can_read_conversation(conversation_id));
drop policy if exists chat_message_edit_select on public.chat_message_edits;
create policy chat_message_edit_select on public.chat_message_edits for select to authenticated
  using (public.chat_can_read_conversation(conversation_id));
drop policy if exists chat_audit_select on public.chat_audit_events;
create policy chat_audit_select on public.chat_audit_events for select to authenticated
  using (public.chat_is_org_master(organization_id)
    or (conversation_id is not null and public.chat_can_read_conversation(conversation_id)));

-- ----------------------------------------------------------------------------
-- Audit helpers / triggers. Events contain metadata only, never the message body or attachment URLs.
-- ----------------------------------------------------------------------------
create or replace function public.chat_write_audit(
  p_organization_id uuid, p_conversation_id uuid, p_actor uuid, p_event text,
  p_entity_id uuid, p_metadata jsonb default '{}'::jsonb
) returns void language sql security definer
set search_path = pg_catalog, public
as $$
  insert into public.chat_audit_events(organization_id, conversation_id, actor_user_id, event_type, entity_id, metadata)
  values (p_organization_id, p_conversation_id, p_actor, p_event, p_entity_id, coalesce(p_metadata, '{}'::jsonb));
$$;

create or replace function public.chat_audit_message_trigger()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_org uuid; v_kind text;
begin
  select organization_id, kind into v_org, v_kind from public.chat_conversations where id = coalesce(new.conversation_id, old.conversation_id);
  if tg_op = 'INSERT' then
    perform public.chat_write_audit(v_org, new.conversation_id, new.sender_user_id, 'message_sent', new.id,
      jsonb_build_object('messageId', new.id, 'bodyLength', char_length(new.body)));
    -- Existing notification center is reused. Only recipient-owned metadata is inserted; no body,
    -- client text, attachment path, or private message preview is copied into the notification.
    insert into public.activity_log(user_id, project_id, shot_id, event_type, description, audience, meta)
    select cm.user_id, null, null, 'chat_message',
      'New message from ' || coalesce(sender.display_name, 'Team member') || ' in ' ||
        coalesce(c.title, c.project_name, 'direct message'),
      'internal', jsonb_build_object('conversationId', c.id, 'messageId', new.id)
    from public.chat_conversation_members cm
    join public.studio_memberships recipient
      on recipient.organization_id = cm.organization_id and recipient.user_id = cm.user_id
    join public.chat_conversations c on c.id = cm.conversation_id
    left join public.studio_memberships sender
      on sender.organization_id = c.organization_id and sender.user_id = new.sender_user_id
    where cm.conversation_id = new.conversation_id and cm.status = 'active'
      and cm.user_id <> new.sender_user_id and recipient.status = 'active'
      and recipient.role <> 'client';
    update public.chat_conversations set updated_at = new.created_at where id = new.conversation_id;
    return new;
  elsif tg_op = 'UPDATE' then
    if old.body is distinct from new.body and new.deleted_at is null then
      perform public.chat_write_audit(v_org, new.conversation_id, auth.uid(), 'message_edited', new.id,
        jsonb_build_object('messageId', new.id));
    end if;
    if old.deleted_at is null and new.deleted_at is not null then
      perform public.chat_write_audit(v_org, new.conversation_id, new.deleted_by, 'message_deleted', new.id,
        jsonb_build_object('messageId', new.id));
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;
drop trigger if exists chat_messages_audit_insert on public.chat_messages;
create trigger chat_messages_audit_insert after insert on public.chat_messages
for each row execute function public.chat_audit_message_trigger();
drop trigger if exists chat_messages_audit_update on public.chat_messages;
create trigger chat_messages_audit_update after update of body, deleted_at on public.chat_messages
for each row execute function public.chat_audit_message_trigger();

create or replace function public.chat_audit_membership_trigger()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_event text; v_actor uuid; v_org uuid;
begin
  v_org := coalesce(new.organization_id, old.organization_id);
  v_actor := auth.uid();
  if tg_op = 'INSERT' then
    v_event := 'member_added';
    perform public.chat_write_audit(v_org, new.conversation_id, v_actor, v_event, new.id,
      jsonb_build_object('targetUserId', new.user_id, 'role', new.role));
    return new;
  elsif tg_op = 'UPDATE' and old.status = 'active' and new.status in ('left','removed') then
    v_event := case when new.status = 'left' then 'member_left' else 'member_removed' end;
    perform public.chat_write_audit(v_org, new.conversation_id, v_actor, v_event, new.id,
      jsonb_build_object('targetUserId', new.user_id, 'status', new.status));
    return new;
  elsif tg_op = 'UPDATE' and old.role is distinct from new.role then
    perform public.chat_write_audit(v_org, new.conversation_id, v_actor, 'member_role_changed', new.id,
      jsonb_build_object('targetUserId',new.user_id,'oldRole',old.role,'newRole',new.role));
    return new;
  elsif tg_op = 'UPDATE' and old.status <> 'active' and new.status = 'active' then
    perform public.chat_write_audit(v_org, new.conversation_id, v_actor, 'member_added', new.id,
      jsonb_build_object('targetUserId',new.user_id,'role',new.role,'reactivated',true));
    return new;
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;
drop trigger if exists chat_members_audit_insert on public.chat_conversation_members;
create trigger chat_members_audit_insert after insert on public.chat_conversation_members
for each row execute function public.chat_audit_membership_trigger();
drop trigger if exists chat_members_audit_update on public.chat_conversation_members;
create trigger chat_members_audit_update after update of status, role on public.chat_conversation_members
for each row execute function public.chat_audit_membership_trigger();

create or replace function public.chat_audit_conversation_trigger()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_org uuid; v_actor uuid; v_event text;
begin
  v_org := coalesce(new.organization_id, old.organization_id);
  v_actor := coalesce(auth.uid(), new.created_by, old.created_by);
  v_event := case when tg_op = 'INSERT' then 'conversation_created' else 'conversation_updated' end;
  perform public.chat_write_audit(v_org, new.id, v_actor, v_event, new.id,
    jsonb_build_object('kind', new.kind, 'titleChanged', case when tg_op = 'UPDATE' then old.title is distinct from new.title else false end));
  return new;
end;
$$;
drop trigger if exists chat_conversations_audit on public.chat_conversations;
create trigger chat_conversations_audit after insert or update of title, archived_at on public.chat_conversations
for each row execute function public.chat_audit_conversation_trigger();

create or replace function public.chat_audit_reaction_trigger()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_org uuid; v_conv uuid; v_actor uuid; v_msg uuid; v_reaction text;
begin
  v_conv := coalesce(new.conversation_id, old.conversation_id);
  v_actor := coalesce(new.user_id, old.user_id);
  v_msg := coalesce(new.message_id, old.message_id);
  v_reaction := coalesce(new.reaction, old.reaction);
  select organization_id into v_org from public.chat_conversations where id = v_conv;
  perform public.chat_write_audit(v_org, v_conv, v_actor,
    case when tg_op = 'INSERT' then 'reaction_added' else 'reaction_removed' end, v_msg,
    jsonb_build_object('messageId', v_msg, 'reaction', v_reaction));
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;
drop trigger if exists chat_reactions_audit on public.chat_reactions;
create trigger chat_reactions_audit after insert or delete on public.chat_reactions
for each row execute function public.chat_audit_reaction_trigger();

create or replace function public.chat_audit_pin_trigger()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_org uuid; v_conv uuid; v_actor uuid; v_msg uuid;
begin
  v_conv := coalesce(new.conversation_id, old.conversation_id);
  v_actor := coalesce(new.pinned_by, auth.uid());
  v_msg := coalesce(new.message_id, old.message_id);
  select organization_id into v_org from public.chat_conversations where id = v_conv;
  perform public.chat_write_audit(v_org, v_conv, v_actor,
    case when tg_op = 'INSERT' then 'message_pinned' else 'message_unpinned' end, v_msg,
    jsonb_build_object('messageId', v_msg));
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;
drop trigger if exists chat_pins_audit on public.chat_pins;
create trigger chat_pins_audit after insert or delete on public.chat_pins
for each row execute function public.chat_audit_pin_trigger();

-- ----------------------------------------------------------------------------
-- RPCs: caller identity is always auth.uid(); participant and organization IDs are validated.
-- ----------------------------------------------------------------------------
create or replace function public.chat_get_my_memberships()
returns table (organization_id uuid, organization_name text, organization_slug text,
               membership_id uuid, user_id uuid, role text, display_name text)
language sql stable security definer set search_path = pg_catalog, public
as $$
  select m.organization_id, o.name, o.slug, m.id, m.user_id, m.role, m.display_name
  from public.studio_memberships m join public.studio_organizations o on o.id = m.organization_id
  where m.user_id = auth.uid() and m.status = 'active'
  order by o.name;
$$;

create or replace function public.chat_list_directory(p_organization_id uuid)
returns table (user_id uuid, display_name text, role text, department_names text[])
language plpgsql stable security definer set search_path = pg_catalog, public
as $$
begin
  if not public.chat_is_internal_member(p_organization_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return query
  select m.user_id, m.display_name, m.role,
    coalesce(array_agg(distinct d.name) filter (where d.name is not null), '{}'::text[])
  from public.studio_memberships m
  left join public.studio_department_memberships dm
    on dm.organization_id = m.organization_id and dm.user_id = m.user_id
  left join public.studio_departments d on d.organization_id = dm.organization_id and d.id = dm.department_id
  where m.organization_id = p_organization_id and m.status = 'active'
    and m.role <> 'client' and m.user_id <> auth.uid()
  group by m.user_id, m.display_name, m.role
  order by m.display_name;
end;
$$;

create or replace function public.chat_list_departments(p_organization_id uuid)
returns table (department_id uuid, name text, member_count bigint, is_admin boolean)
language plpgsql stable security definer set search_path = pg_catalog, public
as $$
begin
  if not public.chat_is_internal_member(p_organization_id) then raise exception 'not_authorized' using errcode = '42501'; end if;
  return query
  select d.id, d.name, count(dm.user_id),
    (public.chat_is_org_master(d.organization_id) or public.chat_is_department_admin(d.organization_id, d.id))
  from public.studio_departments d left join public.studio_department_memberships dm
    on dm.organization_id = d.organization_id and dm.department_id = d.id
  where d.organization_id = p_organization_id
  group by d.id, d.name, d.organization_id order by d.name;
end;
$$;

create or replace function public.chat_add_studio_member(
  p_organization_id uuid, p_email text, p_display_name text, p_role text default 'staff', p_department_id uuid default null
) returns uuid language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_uid uuid; v_membership_id uuid; v_name text; v_existing_role text; v_existing_status text;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not public.chat_is_org_master(p_organization_id) then raise exception 'master_user_required' using errcode = '42501'; end if;
  p_role := lower(btrim(coalesce(p_role,'')));
  if p_role not in ('staff','freelancer','department_admin','client') then
    raise exception 'invalid_role' using errcode = '22023';
  end if;
  if p_role = 'department_admin' and p_department_id is null then raise exception 'department_required' using errcode = '22023'; end if;
  if p_department_id is not null and not exists (
    select 1 from public.studio_departments d where d.id = p_department_id and d.organization_id = p_organization_id
  ) then raise exception 'department_not_found' using errcode = '22023'; end if;
  if nullif(btrim(p_email),'') is null or char_length(btrim(p_email)) > 254 then raise exception 'invalid_email' using errcode = '22023'; end if;
  select u.id into v_uid from auth.users u where lower(u.email) = lower(btrim(p_email)) limit 1;
  if v_uid is null then raise exception 'account_not_found: the person must have a KairFlow login first' using errcode = 'P0001'; end if;
  select role, status into v_existing_role, v_existing_status
    from public.studio_memberships where organization_id=p_organization_id and user_id=v_uid;
  if v_existing_role = 'master_user' then
    raise exception 'cannot_change_master_membership' using errcode='42501';
  end if;
  v_name := left(btrim(coalesce(nullif(p_display_name,''), split_part(p_email,'@',1))), 80);
  if v_name = '' then v_name := 'Team member'; end if;
  insert into public.studio_memberships(organization_id,user_id,role,status,display_name,created_by)
  values (p_organization_id,v_uid,p_role,'active',v_name,auth.uid())
  on conflict (organization_id,user_id) do update
    set role = excluded.role, status = 'active', display_name = excluded.display_name, updated_at = now()
  returning id into v_membership_id;
  if p_role <> 'department_admin' then
    update public.studio_department_memberships set department_role='member'
      where organization_id=p_organization_id and user_id=v_uid and department_role='admin';
  end if;
  if p_department_id is not null and p_role in ('department_admin','staff','freelancer') then
    insert into public.studio_department_memberships(organization_id,department_id,user_id,department_role,created_by)
    values (p_organization_id,p_department_id,v_uid,case when p_role='department_admin' then 'admin' else 'member' end,auth.uid())
    on conflict (department_id,user_id) do update set department_role=excluded.department_role, created_by=auth.uid();
  end if;
  if v_existing_role is null then
    perform public.chat_write_audit(p_organization_id,null,auth.uid(),'studio_member_added',v_membership_id,
      jsonb_build_object('targetUserId',v_uid,'role',p_role));
  else
    if v_existing_role is distinct from p_role then
      perform public.chat_write_audit(p_organization_id,null,auth.uid(),'member_role_changed',v_membership_id,
        jsonb_build_object('targetUserId',v_uid,'oldRole',v_existing_role,'newRole',p_role));
    end if;
    if v_existing_status = 'suspended' then
      perform public.chat_write_audit(p_organization_id,null,auth.uid(),'studio_member_activated',v_membership_id,
        jsonb_build_object('targetUserId',v_uid,'role',p_role));
    end if;
  end if;
  return v_membership_id;
end;
$$;

create or replace function public.chat_set_member_status(p_organization_id uuid, p_user_id uuid, p_status text)
returns boolean language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_target public.studio_memberships%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not public.chat_is_org_master(p_organization_id) then raise exception 'master_user_required' using errcode = '42501'; end if;
  if p_status not in ('active','suspended') then raise exception 'invalid_status' using errcode = '22023'; end if;
  select * into v_target from public.studio_memberships where organization_id=p_organization_id and user_id=p_user_id;
  if not found then return false; end if;
  if v_target.role='master_user' and p_status='suspended' then raise exception 'cannot_suspend_master_user' using errcode='P0001'; end if;
  update public.studio_memberships set status=p_status, updated_at=now() where id=v_target.id;
  if p_status='suspended' then
    update public.chat_conversation_members set status='removed', removed_at=now()
      where organization_id=p_organization_id and user_id=p_user_id and status='active';
    perform public.chat_write_audit(p_organization_id,null,auth.uid(),'studio_member_suspended',v_target.id,
      jsonb_build_object('targetUserId',p_user_id));
  else
    perform public.chat_write_audit(p_organization_id,null,auth.uid(),'studio_member_activated',v_target.id,
      jsonb_build_object('targetUserId',p_user_id));
  end if;
  return true;
end;
$$;

create or replace function public.chat_create_department(p_organization_id uuid, p_name text)
returns uuid language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode='28000'; end if;
  if not public.chat_is_org_master(p_organization_id) then raise exception 'master_user_required' using errcode='42501'; end if;
  if nullif(btrim(p_name),'') is null or char_length(btrim(p_name)) > 80 then raise exception 'invalid_department_name' using errcode='22023'; end if;
  insert into public.studio_departments(organization_id,name,created_by)
  values (p_organization_id,btrim(p_name),auth.uid()) returning id into v_id;
  perform public.chat_write_audit(p_organization_id,null,auth.uid(),'department_created',v_id,jsonb_build_object('name',btrim(p_name)));
  return v_id;
end;
$$;

create or replace function public.chat_assign_department_member(
  p_organization_id uuid, p_department_id uuid, p_user_id uuid, p_department_role text default 'member'
) returns boolean language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_actor_role text; v_target_role text;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode='28000'; end if;
  select role into v_actor_role from public.studio_memberships
   where organization_id=p_organization_id and user_id=auth.uid() and status='active';
  if v_actor_role is null or v_actor_role='client' then raise exception 'not_authorized' using errcode='42501'; end if;
  if not public.chat_is_org_master(p_organization_id)
    and not public.chat_is_department_admin(p_organization_id,p_department_id) then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_department_role not in ('member','admin') then raise exception 'invalid_department_role' using errcode='22023'; end if;
  if p_department_role='admin' and not public.chat_is_org_master(p_organization_id) then raise exception 'master_user_required' using errcode='42501'; end if;
  if not exists (select 1 from public.studio_departments d where d.id=p_department_id and d.organization_id=p_organization_id) then
    raise exception 'department_or_member_not_found' using errcode='P0001';
  end if;
  select role into v_target_role from public.studio_memberships
    where organization_id=p_organization_id and user_id=p_user_id and status='active' and role<>'client';
  if v_target_role is null then raise exception 'department_or_member_not_found' using errcode='P0001'; end if;
  if p_department_role='admin' and v_target_role<>'department_admin' then
    raise exception 'target_must_be_department_admin_role' using errcode='22023';
  end if;
  insert into public.studio_department_memberships(organization_id,department_id,user_id,department_role,created_by)
  values(p_organization_id,p_department_id,p_user_id,p_department_role,auth.uid())
  on conflict (department_id,user_id) do update set department_role=excluded.department_role, created_by=auth.uid();
  perform public.chat_write_audit(p_organization_id,null,auth.uid(),'department_member_assigned',null,
    jsonb_build_object('departmentId',p_department_id,'targetUserId',p_user_id,'departmentRole',p_department_role));
  return true;
end;
$$;

create or replace function public.chat_start_direct(p_organization_id uuid, p_target_user_id uuid)
returns uuid language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_pair text; v_id uuid; v_role text;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode='28000'; end if;
  if p_target_user_id=auth.uid() then raise exception 'cannot_message_self' using errcode='22023'; end if;
  if not public.chat_is_internal_member(p_organization_id) then raise exception 'not_authorized' using errcode='42501'; end if;
  select role into v_role from public.studio_memberships
    where organization_id=p_organization_id and user_id=p_target_user_id and status='active';
  if v_role is null or v_role='client' then raise exception 'target_not_chat_eligible' using errcode='42501'; end if;
  v_pair := least(auth.uid(),p_target_user_id)::text || ':' || greatest(auth.uid(),p_target_user_id)::text;
  insert into public.chat_conversations(organization_id,kind,audience,direct_pair_key,created_by)
  values(p_organization_id,'direct','internal',v_pair,auth.uid())
  on conflict (organization_id,direct_pair_key) where kind='direct'
  do update set updated_at=now()
  returning id into v_id;
  insert into public.chat_conversation_members(organization_id,conversation_id,user_id,role,status)
  values(p_organization_id,v_id,auth.uid(),'member','active'),(p_organization_id,v_id,p_target_user_id,'member','active')
  on conflict (conversation_id,user_id) do update set status='active', left_at=null, removed_at=null, joined_at=now();
  return v_id;
end;
$$;

create or replace function public.chat_create_conversation(
  p_organization_id uuid, p_kind text, p_title text, p_member_ids uuid[] default '{}',
  p_department_id uuid default null, p_project_id uuid default null
) returns uuid language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_id uuid; v_project_name text; v_project_owner uuid; v_master_user uuid; v_target_count integer; v_valid_count integer;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode='28000'; end if;
  if not public.chat_is_internal_member(p_organization_id) then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_kind not in ('group','project') then raise exception 'invalid_conversation_kind' using errcode='22023'; end if;
  if p_kind='group' and (nullif(btrim(p_title),'') is null or char_length(btrim(p_title))>100) then raise exception 'invalid_group_title' using errcode='22023'; end if;
  if p_kind='project' then
    if p_project_id is null then raise exception 'project_required' using errcode='22023'; end if;
    select p.name, p.user_id into v_project_name, v_project_owner from public.projects p
      where p.id=p_project_id and (
        p.user_id=auth.uid() or (public.chat_is_org_master(p_organization_id) and exists (
          select 1 from public.studio_memberships sm where sm.organization_id=p_organization_id and sm.user_id=p.user_id and sm.status='active'
        ))
      );
    if v_project_name is null then raise exception 'project_not_found_or_not_authorized' using errcode='42501'; end if;
    p_title := null;
  elsif p_project_id is not null then raise exception 'project_not_allowed_for_group' using errcode='22023';
  end if;
  if p_department_id is not null then
    if p_kind <> 'group' then raise exception 'department_only_for_groups' using errcode='22023'; end if;
    if not exists (select 1 from public.studio_departments d where d.id=p_department_id and d.organization_id=p_organization_id) then raise exception 'department_not_found' using errcode='22023'; end if;
    if not public.chat_is_org_master(p_organization_id) and not public.chat_is_department_admin(p_organization_id,p_department_id) then raise exception 'department_admin_required' using errcode='42501'; end if;
  end if;
  select count(*) into v_target_count from (select distinct x from unnest(coalesce(p_member_ids,'{}'::uuid[])) x where x is not null and x<>auth.uid()) s;
  if v_target_count > 49 then raise exception 'too_many_members' using errcode='22023'; end if;
  select count(*) into v_valid_count from (
    select distinct x from unnest(coalesce(p_member_ids,'{}'::uuid[])) x where x is not null and x<>auth.uid()
  ) t join public.studio_memberships m on m.organization_id=p_organization_id and m.user_id=t.x and m.status='active' and m.role<>'client';
  if v_valid_count<>v_target_count then raise exception 'one_or_more_members_not_eligible' using errcode='42501'; end if;
  if p_kind='project' and exists (
    select 1 from (select distinct x from unnest(coalesce(p_member_ids,'{}'::uuid[])) x where x is not null and x<>auth.uid()) t
    where not public.chat_user_can_access_project(p_organization_id,p_project_id,t.x)
  ) then raise exception 'project_access_required' using errcode='42501'; end if;
  if p_department_id is not null and exists (
    select 1 from (select distinct x from unnest(coalesce(p_member_ids,'{}'::uuid[])) x where x is not null and x<>auth.uid()) t
    where not exists (select 1 from public.studio_department_memberships dm where dm.organization_id=p_organization_id and dm.department_id=p_department_id and dm.user_id=t.x)
  ) then raise exception 'all_members_must_belong_to_department' using errcode='42501'; end if;
  insert into public.chat_conversations(organization_id,kind,audience,title,project_id,project_name,department_id,created_by)
  values(p_organization_id,p_kind,'internal',case when p_kind='group' then btrim(p_title) else null end,
    case when p_kind='project' then p_project_id else null end,
    case when p_kind='project' then v_project_name else null end,p_department_id,auth.uid()) returning id into v_id;
  insert into public.chat_conversation_members(organization_id,conversation_id,user_id,role,status)
  values(p_organization_id,v_id,auth.uid(),
    case when p_kind='project' and v_project_owner<>auth.uid() then 'admin' else 'owner' end,'active');
  if p_kind='project' then
    -- Until shared-project ACLs exist, make the two genuinely authorized people explicit members.
    -- This also lets the project owner see a project conversation created by the Master User.
    if v_project_owner<>auth.uid() then
      insert into public.chat_conversation_members(organization_id,conversation_id,user_id,role,status)
      values(p_organization_id,v_id,v_project_owner,'owner','active');
    end if;
    select user_id into v_master_user from public.studio_memberships
      where organization_id=p_organization_id and status='active' and role='master_user' limit 1;
    if v_master_user is not null and v_master_user<>auth.uid() and v_master_user<>v_project_owner then
      insert into public.chat_conversation_members(organization_id,conversation_id,user_id,role,status)
      values(p_organization_id,v_id,v_master_user,'admin','active');
    end if;
  end if;
  insert into public.chat_conversation_members(organization_id,conversation_id,user_id,role,status)
  select p_organization_id,v_id,t.x,'member','active'
  from (select distinct x from unnest(coalesce(p_member_ids,'{}'::uuid[])) x
        where x is not null and x<>auth.uid()
          and (v_project_owner is null or x<>v_project_owner)
          and (v_master_user is null or x<>v_master_user)) t;
  return v_id;
end;
$$;

create or replace function public.chat_add_conversation_member(p_conversation_id uuid, p_target_user_id uuid)
returns boolean language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_conv public.chat_conversations%rowtype; v_role text;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode='28000'; end if;
  select * into v_conv from public.chat_conversations where id=p_conversation_id and archived_at is null;
  if not found or not public.chat_can_manage_conversation(p_conversation_id) then raise exception 'not_authorized' using errcode='42501'; end if;
  if v_conv.kind='direct' then raise exception 'direct_membership_is_fixed' using errcode='22023'; end if;
  select role into v_role from public.studio_memberships where organization_id=v_conv.organization_id and user_id=p_target_user_id and status='active';
  if v_role is null or v_role='client' then raise exception 'target_not_chat_eligible' using errcode='42501'; end if;
  if v_conv.kind='project' and not public.chat_user_can_access_project(v_conv.organization_id,v_conv.project_id,p_target_user_id) then
    raise exception 'project_access_required' using errcode='42501';
  end if;
  if v_conv.department_id is not null and not exists (
    select 1 from public.studio_department_memberships dm where dm.organization_id=v_conv.organization_id and dm.department_id=v_conv.department_id and dm.user_id=p_target_user_id
  ) then raise exception 'target_not_in_department' using errcode='42501'; end if;
  insert into public.chat_conversation_members(organization_id,conversation_id,user_id,role,status)
  values(v_conv.organization_id,v_conv.id,p_target_user_id,'member','active')
  on conflict (conversation_id,user_id) do update set status='active', left_at=null, removed_at=null, joined_at=now();
  return true;
end;
$$;

create or replace function public.chat_remove_conversation_member(p_conversation_id uuid, p_target_user_id uuid)
returns boolean language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_conv public.chat_conversations%rowtype; v_target public.chat_conversation_members%rowtype; v_is_master boolean;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode='28000'; end if;
  select * into v_conv from public.chat_conversations where id=p_conversation_id and archived_at is null;
  if not found then return false; end if;
  v_is_master := public.chat_is_org_master(v_conv.organization_id);
  if p_target_user_id=auth.uid() then
    if v_conv.kind='direct' then raise exception 'cannot_leave_direct_conversation' using errcode='22023'; end if;
  elsif not public.chat_can_manage_conversation(p_conversation_id) then
    raise exception 'not_authorized' using errcode='42501';
  end if;
  select * into v_target from public.chat_conversation_members where conversation_id=p_conversation_id and user_id=p_target_user_id and status='active';
  if not found then return false; end if;
  if v_conv.kind='project' and exists (select 1 from public.projects p where p.id=v_conv.project_id and p.user_id=p_target_user_id) then
    raise exception 'project_owner_must_remain_in_project_conversation' using errcode='P0001';
  end if;
  if v_target.role='owner' and not v_is_master and p_target_user_id<>auth.uid() then raise exception 'owner_cannot_be_removed' using errcode='P0001'; end if;
  if v_target.role='owner' and p_target_user_id=auth.uid() and not exists (
    select 1 from public.chat_conversation_members cm where cm.conversation_id=p_conversation_id and cm.status='active' and cm.role in ('owner','admin') and cm.user_id<>auth.uid()
  ) then raise exception 'transfer_ownership_before_leaving' using errcode='P0001'; end if;
  update public.chat_conversation_members set status=case when p_target_user_id=auth.uid() then 'left' else 'removed' end,
    left_at=case when p_target_user_id=auth.uid() then now() else left_at end,
    removed_at=case when p_target_user_id<>auth.uid() then now() else removed_at end
   where id=v_target.id;
  return true;
end;
$$;

create or replace function public.chat_transfer_conversation_ownership(p_conversation_id uuid, p_target_user_id uuid)
returns boolean language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_conv public.chat_conversations%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode='28000'; end if;
  select * into v_conv from public.chat_conversations where id=p_conversation_id and archived_at is null;
  if not found or v_conv.kind='direct' then raise exception 'invalid_conversation' using errcode='22023'; end if;
  if not public.chat_is_org_master(v_conv.organization_id) and not exists (
    select 1 from public.chat_conversation_members cm where cm.conversation_id=p_conversation_id
      and cm.user_id=auth.uid() and cm.status='active' and cm.role='owner'
  ) then raise exception 'not_authorized' using errcode='42501'; end if;
  if not exists (select 1 from public.chat_conversation_members cm where cm.conversation_id=p_conversation_id
      and cm.user_id=p_target_user_id and cm.status='active') then
    raise exception 'target_must_be_active_member' using errcode='22023';
  end if;
  update public.chat_conversation_members set role='admin'
    where conversation_id=p_conversation_id and role='owner' and user_id<>p_target_user_id;
  update public.chat_conversation_members set role='owner'
    where conversation_id=p_conversation_id and user_id=p_target_user_id and status='active';
  return true;
end;
$$;

create or replace function public.chat_update_conversation_title(p_conversation_id uuid, p_title text)
returns boolean language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_conv public.chat_conversations%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode='28000'; end if;
  if nullif(btrim(p_title),'') is null or char_length(btrim(p_title))>100 then raise exception 'invalid_group_title' using errcode='22023'; end if;
  select * into v_conv from public.chat_conversations where id=p_conversation_id and archived_at is null;
  if not found or v_conv.kind<>'group' or not public.chat_can_manage_conversation(p_conversation_id) then raise exception 'not_authorized' using errcode='42501'; end if;
  update public.chat_conversations set title=btrim(p_title), updated_at=now() where id=p_conversation_id;
  return true;
end;
$$;

create or replace function public.chat_send_message(
  p_conversation_id uuid, p_body text, p_idempotency_key uuid,
  p_reply_to_id uuid default null, p_attachment_ids uuid[] default '{}'
) returns uuid language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_message_id uuid; v_body text := coalesce(p_body,''); v_fingerprint text; v_existing_fingerprint text; v_org uuid; v_sender_role text; v_count integer;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode='28000'; end if;
  if not public.chat_can_read_conversation(p_conversation_id) then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_idempotency_key is null then raise exception 'idempotency_key_required' using errcode='22023'; end if;
  if char_length(v_body)>10000 then raise exception 'message_too_long' using errcode='22023'; end if;
  if char_length(btrim(v_body))=0 and cardinality(coalesce(p_attachment_ids,'{}'::uuid[]))=0 then raise exception 'empty_message' using errcode='22023'; end if;
  if cardinality(coalesce(p_attachment_ids,'{}'::uuid[]))>10 then raise exception 'too_many_attachments' using errcode='22023'; end if;
  select organization_id into v_org from public.chat_conversations where id=p_conversation_id;
  select role into v_sender_role from public.studio_memberships where organization_id=v_org and user_id=auth.uid() and status='active';
  if v_sender_role is null or v_sender_role='client' then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_reply_to_id is not null and not exists (select 1 from public.chat_messages m where m.id=p_reply_to_id and m.conversation_id=p_conversation_id) then
    raise exception 'reply_target_not_in_conversation' using errcode='22023';
  end if;
  select count(*) into v_count from public.chat_attachments a
    where a.id=any(coalesce(p_attachment_ids,'{}'::uuid[])) and a.conversation_id=p_conversation_id
      and a.uploaded_by=auth.uid() and a.message_id is null;
  if v_count<>cardinality(coalesce(p_attachment_ids,'{}'::uuid[])) then raise exception 'attachment_upload_not_valid' using errcode='42501'; end if;
  v_fingerprint := md5(v_body || E'\x1f' || coalesce(p_reply_to_id::text,'') || E'\x1e' || coalesce((
    select string_agg(a.file_name || E'\x1f' || a.content_type || E'\x1f' || a.size_bytes::text, E'\x1e' order by input.ordinality)
    from unnest(coalesce(p_attachment_ids,'{}'::uuid[])) with ordinality as input(attachment_id, ordinality)
    join public.chat_attachments a on a.id=input.attachment_id
  ),''));
  insert into public.chat_messages(conversation_id,sender_user_id,body,reply_to_id,idempotency_key,request_fingerprint)
  values(p_conversation_id,auth.uid(),v_body,p_reply_to_id,p_idempotency_key,v_fingerprint)
  on conflict (conversation_id,sender_user_id,idempotency_key) do nothing returning id into v_message_id;
  if v_message_id is null then
    select id,request_fingerprint into v_message_id,v_existing_fingerprint from public.chat_messages
      where conversation_id=p_conversation_id and sender_user_id=auth.uid() and idempotency_key=p_idempotency_key;
    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception 'idempotency_key_reused' using errcode='22023';
    end if;
    return v_message_id;
  end if;
  if cardinality(coalesce(p_attachment_ids,'{}'::uuid[]))>0 then
    update public.chat_attachments set message_id=v_message_id
    where id=any(p_attachment_ids) and uploaded_by=auth.uid() and message_id is null;
  end if;
  return v_message_id;
end;
$$;

create or replace function public.chat_register_attachment_upload(
  p_conversation_id uuid, p_object_path text, p_file_name text, p_content_type text, p_size_bytes bigint
) returns uuid language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_org uuid; v_owner text; v_id uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode='28000'; end if;
  if not public.chat_can_read_conversation(p_conversation_id) then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_object_path !~ ('^' || p_conversation_id::text || '/[A-Za-z0-9_-]{8,80}/[A-Za-z0-9_.-]{1,255}$') then raise exception 'invalid_object_path' using errcode='22023'; end if;
  if nullif(btrim(p_file_name),'') is null or char_length(p_file_name)>255 then raise exception 'invalid_file_name' using errcode='22023'; end if;
  if p_size_bytes < 1 or p_size_bytes > 20971520 then raise exception 'file_too_large' using errcode='22023'; end if;
  if p_content_type not in ('image/png','image/jpeg','image/gif','image/webp','application/pdf','text/plain','application/zip','video/mp4','video/webm','audio/mpeg','audio/mp4','audio/wav') then raise exception 'file_type_not_allowed' using errcode='22023'; end if;
  select coalesce(to_jsonb(o)->>'owner_id',to_jsonb(o)->>'owner') into v_owner
    from storage.objects o where o.bucket_id='chat-attachments' and o.name=p_object_path;
  if not found or v_owner is distinct from auth.uid()::text then raise exception 'upload_not_found_or_not_owned' using errcode='42501'; end if;
  select organization_id into v_org from public.chat_conversations where id=p_conversation_id;
  insert into public.chat_attachments(conversation_id,object_path,file_name,content_type,size_bytes,uploaded_by)
    values(p_conversation_id,p_object_path,p_file_name,p_content_type,p_size_bytes,auth.uid()) returning id into v_id;
  perform public.chat_write_audit(v_org,p_conversation_id,auth.uid(),'attachment_uploaded',v_id,
    jsonb_build_object('fileName',p_file_name,'contentType',p_content_type,'sizeBytes',p_size_bytes));
  return v_id;
end;
$$;

create or replace function public.chat_cancel_attachment_upload(p_attachment_id uuid)
returns boolean language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_path text;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode='28000'; end if;
  delete from public.chat_attachments where id=p_attachment_id and uploaded_by=auth.uid() and message_id is null returning object_path into v_path;
  return v_path is not null;
end;
$$;

create or replace function public.chat_edit_message(p_message_id uuid, p_new_body text)
returns boolean language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_msg public.chat_messages%rowtype; v_conv public.chat_conversations%rowtype; v_is_admin boolean;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode='28000'; end if;
  if nullif(btrim(p_new_body),'') is null or char_length(p_new_body)>10000 then raise exception 'invalid_message_body' using errcode='22023'; end if;
  select * into v_msg from public.chat_messages where id=p_message_id and deleted_at is null;
  if not found then return false; end if;
  select * into v_conv from public.chat_conversations where id=v_msg.conversation_id;
  if not public.chat_can_read_conversation(v_conv.id) then raise exception 'not_authorized' using errcode='42501'; end if;
  v_is_admin := v_conv.kind <> 'direct' and public.chat_can_manage_conversation(v_conv.id);
  if v_msg.sender_user_id<>auth.uid() and not v_is_admin then raise exception 'cannot_edit_other_member_message' using errcode='42501'; end if;
  if v_msg.sender_user_id=auth.uid() and v_msg.created_at < now()-interval '15 minutes' then raise exception 'edit_window_expired' using errcode='P0001'; end if;
  if v_msg.body is distinct from p_new_body then
    insert into public.chat_message_edits(conversation_id,message_id,editor_user_id,old_body,new_body)
    values(v_msg.conversation_id,v_msg.id,auth.uid(),v_msg.body,p_new_body);
    update public.chat_messages set body=p_new_body, edited_at=now() where id=v_msg.id;
  end if;
  return true;
end;
$$;

create or replace function public.chat_delete_message(p_message_id uuid)
returns text[] language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_msg public.chat_messages%rowtype; v_conv public.chat_conversations%rowtype; v_paths text[] := '{}'::text[];
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode='28000'; end if;
  select * into v_msg from public.chat_messages where id=p_message_id;
  if not found then return '{}'::text[]; end if;
  select * into v_conv from public.chat_conversations where id=v_msg.conversation_id;
  if not public.chat_can_read_conversation(v_conv.id) then raise exception 'not_authorized' using errcode='42501'; end if;
  if v_msg.sender_user_id<>auth.uid() and not (v_conv.kind <> 'direct' and public.chat_can_manage_conversation(v_conv.id)) then
    raise exception 'cannot_delete_other_member_message' using errcode='42501';
  end if;
  if v_msg.deleted_at is null then
    select coalesce(array_agg(a.object_path), '{}'::text[]) into v_paths
      from public.chat_attachments a where a.message_id=v_msg.id;
    update public.chat_messages set body='', deleted_at=now(), deleted_by=auth.uid(), edited_at=now() where id=v_msg.id;
  else
    -- Idempotent cleanup retry: only the original deleter or a conversation moderator may
    -- retrieve paths for a previously deleted message.
    if v_msg.deleted_by is distinct from auth.uid() and not (v_conv.kind <> 'direct' and public.chat_can_manage_conversation(v_conv.id)) then
      return '{}'::text[];
    end if;
    select coalesce(array_agg(a.object_path), '{}'::text[]) into v_paths
      from public.chat_attachments a where a.message_id=v_msg.id;
  end if;
  return coalesce(v_paths, '{}'::text[]);
end;
$$;

create or replace function public.chat_finalize_deleted_attachments(p_message_id uuid, p_object_paths text[])
returns boolean language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_msg public.chat_messages%rowtype; v_conv public.chat_conversations%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode='28000'; end if;
  select * into v_msg from public.chat_messages where id=p_message_id and deleted_at is not null;
  if not found then raise exception 'deleted_message_not_found' using errcode='22023'; end if;
  select * into v_conv from public.chat_conversations where id=v_msg.conversation_id;
  if not public.chat_can_read_conversation(v_conv.id) then raise exception 'not_authorized' using errcode='42501'; end if;
  if v_msg.deleted_by is distinct from auth.uid() and not (v_conv.kind <> 'direct' and public.chat_can_manage_conversation(v_conv.id)) then
    raise exception 'not_authorized' using errcode='42501';
  end if;
  delete from public.chat_attachments a
    where a.message_id=p_message_id and a.object_path=any(coalesce(p_object_paths, '{}'::text[]));
  return true;
end;
$$;

create or replace function public.chat_set_reaction(p_message_id uuid, p_reaction text, p_active boolean)
returns boolean language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_conv uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode='28000'; end if;
  if char_length(coalesce(p_reaction,'')) not between 1 and 32 or p_reaction ~ '[[:cntrl:]]' then raise exception 'invalid_reaction' using errcode='22023'; end if;
  select conversation_id into v_conv from public.chat_messages where id=p_message_id and deleted_at is null;
  if v_conv is null or not public.chat_can_read_conversation(v_conv) then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_active then
    insert into public.chat_reactions(conversation_id,message_id,user_id,reaction)
    values(v_conv,p_message_id,auth.uid(),p_reaction) on conflict(message_id,user_id,reaction) do nothing;
  else
    delete from public.chat_reactions where message_id=p_message_id and user_id=auth.uid() and reaction=p_reaction;
  end if;
  return true;
end;
$$;

create or replace function public.chat_mark_read(p_conversation_id uuid, p_last_read_message_id uuid default null)
returns timestamptz language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_read_at timestamptz := now(); v_msg_at timestamptz;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode='28000'; end if;
  if not public.chat_can_read_conversation(p_conversation_id) then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_last_read_message_id is not null then
    select created_at into v_msg_at from public.chat_messages where id=p_last_read_message_id and conversation_id=p_conversation_id;
    if not found then raise exception 'read_cursor_not_in_conversation' using errcode='22023'; end if;
    v_read_at := v_msg_at;
  end if;
  insert into public.chat_read_state(conversation_id,user_id,last_read_at,last_read_message_id,updated_at)
  values(p_conversation_id,auth.uid(),v_read_at,p_last_read_message_id,now())
  on conflict(conversation_id,user_id) do update set
    last_read_at = greatest(chat_read_state.last_read_at, excluded.last_read_at),
    last_read_message_id = case
      when (excluded.last_read_at, coalesce(excluded.last_read_message_id::text,'')) >=
           (chat_read_state.last_read_at, coalesce(chat_read_state.last_read_message_id::text,''))
      then excluded.last_read_message_id else chat_read_state.last_read_message_id end,
    updated_at = now();
  perform public.chat_write_audit((select organization_id from public.chat_conversations where id=p_conversation_id),
    p_conversation_id,auth.uid(),'message_read',p_last_read_message_id,jsonb_build_object('lastReadMessageId',p_last_read_message_id));
  return v_read_at;
end;
$$;

create or replace function public.chat_toggle_pin(p_message_id uuid, p_active boolean)
returns boolean language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_conv uuid; v_role text; v_org uuid; v_pinner uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode='28000'; end if;
  select m.conversation_id,c.organization_id into v_conv,v_org from public.chat_messages m join public.chat_conversations c on c.id=m.conversation_id where m.id=p_message_id and m.deleted_at is null;
  if v_conv is null or not public.chat_can_read_conversation(v_conv) then raise exception 'not_authorized' using errcode='42501'; end if;
  if p_active then
    insert into public.chat_pins(conversation_id,message_id,pinned_by) values(v_conv,p_message_id,auth.uid()) on conflict(conversation_id,message_id) do nothing;
  else
    select pinned_by into v_pinner from public.chat_pins where conversation_id=v_conv and message_id=p_message_id;
    if v_pinner is not null and v_pinner<>auth.uid() and not public.chat_can_manage_conversation(v_conv) then raise exception 'not_authorized_to_unpin' using errcode='42501'; end if;
    delete from public.chat_pins where conversation_id=v_conv and message_id=p_message_id;
  end if;
  return true;
end;
$$;


create or replace function public.chat_list_studio_members(p_organization_id uuid)
returns table (user_id uuid, display_name text, role text, status text, email text, created_at timestamptz)
language plpgsql stable security definer set search_path = pg_catalog, public, auth
as $$
begin
  if auth.uid() is null or not public.chat_is_org_master(p_organization_id) then raise exception 'master_user_required' using errcode='42501'; end if;
  return query
  select m.user_id,m.display_name,m.role,m.status,u.email::text,m.created_at
  from public.studio_memberships m join auth.users u on u.id=m.user_id
  where m.organization_id=p_organization_id order by m.created_at,m.display_name;
end;
$$;

create or replace function public.chat_list_project_options(p_organization_id uuid)
returns table (id uuid, name text)
language plpgsql stable security definer set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null or not public.chat_is_internal_member(p_organization_id) then raise exception 'not_authorized' using errcode='42501'; end if;
  return query
  select p.id,p.name from public.projects p
  where p.user_id=auth.uid() or (public.chat_is_org_master(p_organization_id) and exists (
    select 1 from public.studio_memberships sm where sm.organization_id=p_organization_id
      and sm.user_id=p.user_id and sm.status='active'
  ))
  order by p.name limit 500;
end;
$$;

create or replace function public.chat_list_conversations(p_organization_id uuid)
returns table (
  conversation_id uuid, organization_id uuid, kind text, title text, project_id uuid,
  created_by uuid, created_at timestamptz, updated_at timestamptz, member_count bigint,
  unread_count bigint, is_admin boolean, last_message_id uuid, last_message_body text,
  last_message_at timestamptz, last_sender_user_id uuid
) language plpgsql stable security definer set search_path = pg_catalog, public
as $$
begin
  if not public.chat_is_internal_member(p_organization_id) then raise exception 'not_authorized' using errcode='42501'; end if;
  return query
  select c.id,c.organization_id,c.kind,
    case when c.kind='direct' then coalesce((select m.display_name from public.studio_memberships m
       join public.chat_conversation_members cm on cm.organization_id=m.organization_id and cm.user_id=m.user_id
       where cm.conversation_id=c.id and cm.user_id<>auth.uid() and cm.status='active' limit 1),'Direct message')
      when c.kind='project' then 'Project: '||coalesce(c.project_name,'Project conversation')
      else c.title end,
    c.project_id,c.created_by,c.created_at,c.updated_at,
    (select count(*) from public.chat_conversation_members cm where cm.conversation_id=c.id and cm.status='active'),
    (select count(*) from public.chat_messages m
      left join public.chat_read_state rs on rs.conversation_id=c.id and rs.user_id=auth.uid()
      where m.conversation_id=c.id and m.sender_user_id<>auth.uid() and m.deleted_at is null
        and (rs.last_read_at is null or m.created_at>rs.last_read_at or (m.created_at=rs.last_read_at and (rs.last_read_message_id is null or m.id>rs.last_read_message_id)))),
    public.chat_can_manage_conversation(c.id), lm.id,lm.body,lm.created_at,lm.sender_user_id
  from public.chat_conversations c
  left join lateral (select m.id,m.body,m.created_at,m.sender_user_id from public.chat_messages m
    where m.conversation_id=c.id order by m.created_at desc,m.id desc limit 1) lm on true
  where c.organization_id=p_organization_id and c.archived_at is null
    and public.chat_can_read_conversation(c.id)
  order by coalesce(lm.created_at,c.updated_at) desc,c.id desc;
end;
$$;

create or replace function public.chat_search_messages(
  p_organization_id uuid, p_query text, p_conversation_id uuid default null, p_limit integer default 50
) returns table (
  message_id uuid, conversation_id uuid, sender_user_id uuid, sender_name text,
  body text, created_at timestamptz, edited_at timestamptz, deleted_at timestamptz, reply_to_id uuid
) language plpgsql stable security definer set search_path = pg_catalog, public
as $$
declare v_query tsquery; v_limit integer;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode='28000'; end if;
  if not public.chat_is_internal_member(p_organization_id) then raise exception 'not_authorized' using errcode='42501'; end if;
  if char_length(btrim(coalesce(p_query,'')))<2 then return; end if;
  v_limit := least(greatest(coalesce(p_limit,50),1),100);
  v_query := plainto_tsquery('simple',left(btrim(p_query),200));
  if p_conversation_id is not null and not public.chat_can_read_conversation(p_conversation_id) then raise exception 'not_authorized' using errcode='42501'; end if;
  return query
  select m.id,m.conversation_id,m.sender_user_id,coalesce(sm.display_name,'Team member'),
    case when m.deleted_at is not null then '' else m.body end,m.created_at,m.edited_at,m.deleted_at,m.reply_to_id
  from public.chat_messages m
  join public.chat_conversations c on c.id=m.conversation_id and c.organization_id=p_organization_id
  left join public.studio_memberships sm on sm.organization_id=c.organization_id and sm.user_id=m.sender_user_id
  where (p_conversation_id is null or m.conversation_id=p_conversation_id)
    and public.chat_can_read_conversation(m.conversation_id)
    and m.deleted_at is null and m.search_vector @@ v_query
  order by m.created_at desc,m.id desc limit v_limit;
end;
$$;

-- User-visible history is intentionally not granted direct INSERT/UPDATE/DELETE; RPCs write using
-- the caller's verified identity. The audit table itself is immutable to authenticated clients.
revoke insert, update, delete, truncate, references, trigger on public.chat_audit_events from authenticated, anon;
revoke insert, update, delete, truncate, references, trigger on public.chat_message_edits from authenticated, anon;
revoke insert, update, delete, truncate, references, trigger on public.chat_conversations from authenticated, anon;
revoke insert, update, delete, truncate, references, trigger on public.chat_conversation_members from authenticated, anon;
revoke insert, update, delete, truncate, references, trigger on public.chat_messages from authenticated, anon;
revoke insert, update, delete, truncate, references, trigger on public.chat_read_state from authenticated, anon;
revoke insert, update, delete, truncate, references, trigger on public.chat_reactions from authenticated, anon;
revoke insert, update, delete, truncate, references, trigger on public.chat_attachments from authenticated, anon;
revoke insert, update, delete, truncate, references, trigger on public.chat_pins from authenticated, anon;
revoke insert, update, delete, truncate, references, trigger on public.studio_organizations from authenticated, anon;
revoke insert, update, delete, truncate, references, trigger on public.studio_memberships from authenticated, anon;
revoke insert, update, delete, truncate, references, trigger on public.studio_departments from authenticated, anon;
revoke insert, update, delete, truncate, references, trigger on public.studio_department_memberships from authenticated, anon;

revoke all on function public.chat_write_audit(uuid,uuid,uuid,text,uuid,jsonb) from public, anon, authenticated;
revoke all on function public.chat_audit_message_trigger() from public, anon, authenticated;
revoke all on function public.chat_audit_membership_trigger() from public, anon, authenticated;
revoke all on function public.chat_audit_conversation_trigger() from public, anon, authenticated;
revoke all on function public.chat_audit_reaction_trigger() from public, anon, authenticated;
revoke all on function public.chat_audit_pin_trigger() from public, anon, authenticated;

-- Helpers needed by RLS and realtime. Direct calls reveal only the current caller's own authority.
revoke all on function public.chat_is_org_member(uuid) from public, anon;
revoke all on function public.chat_is_org_master(uuid) from public, anon;
revoke all on function public.chat_is_department_admin(uuid,uuid) from public, anon;
revoke all on function public.chat_is_internal_member(uuid) from public, anon;
revoke all on function public.chat_can_read_conversation(uuid) from public, anon;
revoke all on function public.chat_can_manage_conversation(uuid) from public, anon;
revoke all on function public.chat_user_can_access_project(uuid,uuid,uuid) from public, anon, authenticated;
revoke all on function public.chat_realtime_topic_allowed(text) from public, anon;
grant execute on function public.chat_is_org_member(uuid), public.chat_is_org_master(uuid),
  public.chat_is_department_admin(uuid,uuid), public.chat_is_internal_member(uuid),
  public.chat_can_read_conversation(uuid), public.chat_can_manage_conversation(uuid),
  public.chat_realtime_topic_allowed(text) to authenticated;

revoke all on function public.chat_get_my_memberships() from public, anon;
revoke all on function public.chat_list_directory(uuid) from public, anon;
revoke all on function public.chat_list_departments(uuid) from public, anon;
revoke all on function public.chat_list_studio_members(uuid) from public, anon;
revoke all on function public.chat_list_project_options(uuid) from public, anon;
revoke all on function public.chat_add_studio_member(uuid,text,text,text,uuid) from public, anon;
revoke all on function public.chat_set_member_status(uuid,uuid,text) from public, anon;
revoke all on function public.chat_create_department(uuid,text) from public, anon;
revoke all on function public.chat_assign_department_member(uuid,uuid,uuid,text) from public, anon;
revoke all on function public.chat_start_direct(uuid,uuid) from public, anon;
revoke all on function public.chat_create_conversation(uuid,text,text,uuid[],uuid,uuid) from public, anon;
revoke all on function public.chat_add_conversation_member(uuid,uuid) from public, anon;
revoke all on function public.chat_remove_conversation_member(uuid,uuid) from public, anon;
revoke all on function public.chat_transfer_conversation_ownership(uuid,uuid) from public, anon;
revoke all on function public.chat_update_conversation_title(uuid,text) from public, anon;
revoke all on function public.chat_send_message(uuid,text,uuid,uuid,uuid[]) from public, anon;
revoke all on function public.chat_register_attachment_upload(uuid,text,text,text,bigint) from public, anon;
revoke all on function public.chat_cancel_attachment_upload(uuid) from public, anon;
revoke all on function public.chat_edit_message(uuid,text) from public, anon;
revoke all on function public.chat_delete_message(uuid) from public, anon;
revoke all on function public.chat_finalize_deleted_attachments(uuid,text[]) from public, anon;
revoke all on function public.chat_set_reaction(uuid,text,boolean) from public, anon;
revoke all on function public.chat_mark_read(uuid,uuid) from public, anon;
revoke all on function public.chat_toggle_pin(uuid,boolean) from public, anon;
revoke all on function public.chat_list_conversations(uuid) from public, anon;
revoke all on function public.chat_search_messages(uuid,text,uuid,integer) from public, anon;
grant execute on function public.chat_get_my_memberships(), public.chat_list_directory(uuid), public.chat_list_departments(uuid),
  public.chat_list_studio_members(uuid), public.chat_list_project_options(uuid), public.chat_add_studio_member(uuid,text,text,text,uuid), public.chat_set_member_status(uuid,uuid,text),
  public.chat_create_department(uuid,text), public.chat_assign_department_member(uuid,uuid,uuid,text),
  public.chat_start_direct(uuid,uuid), public.chat_create_conversation(uuid,text,text,uuid[],uuid,uuid),
  public.chat_add_conversation_member(uuid,uuid), public.chat_remove_conversation_member(uuid,uuid),
  public.chat_transfer_conversation_ownership(uuid,uuid), public.chat_update_conversation_title(uuid,text), public.chat_send_message(uuid,text,uuid,uuid,uuid[]),
  public.chat_register_attachment_upload(uuid,text,text,text,bigint), public.chat_cancel_attachment_upload(uuid), public.chat_edit_message(uuid,text),
  public.chat_delete_message(uuid), public.chat_finalize_deleted_attachments(uuid,text[]), public.chat_set_reaction(uuid,text,boolean), public.chat_mark_read(uuid,uuid),
  public.chat_toggle_pin(uuid,boolean), public.chat_list_conversations(uuid), public.chat_search_messages(uuid,text,uuid,integer)
  to authenticated;

-- Private attachment storage. Folder layout: <conversation UUID>/<random upload id>/<safe filename>.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('chat-attachments','chat-attachments',false,20971520,
  array['image/png','image/jpeg','image/gif','image/webp','application/pdf','text/plain','application/zip','video/mp4','video/webm','audio/mpeg','audio/mp4','audio/wav'])
on conflict (id) do update set public=false, file_size_limit=excluded.file_size_limit, allowed_mime_types=excluded.allowed_mime_types;
drop policy if exists chat_attachment_object_select on storage.objects;
create policy chat_attachment_object_select on storage.objects for select to authenticated
using (bucket_id='chat-attachments' and (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  and public.chat_can_read_conversation(((storage.foldername(name))[1])::uuid)
  and exists (select 1 from public.chat_attachments a where a.object_path=name
    and a.message_id is not null and exists (select 1 from public.chat_messages m where m.id=a.message_id and m.deleted_at is null)));
drop policy if exists chat_attachment_object_insert on storage.objects;
create policy chat_attachment_object_insert on storage.objects for insert to authenticated
with check (bucket_id='chat-attachments' and (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  and public.chat_can_read_conversation(((storage.foldername(name))[1])::uuid)
  and (storage.foldername(name))[2] ~ '^[A-Za-z0-9_-]{8,80}$');
drop policy if exists chat_attachment_object_delete on storage.objects;
create policy chat_attachment_object_delete on storage.objects for delete to authenticated
using (bucket_id='chat-attachments' and (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  and public.chat_can_read_conversation(((storage.foldername(name))[1])::uuid)
  and (
    owner_id = auth.uid()::text
    or exists (select 1 from public.chat_attachments a where a.object_path=name and a.uploaded_by=auth.uid() and a.message_id is null)
    or exists (select 1 from public.chat_attachments a join public.chat_messages m on m.id=a.message_id
      where a.object_path=name and m.deleted_at is not null
        and (a.uploaded_by=auth.uid() or public.chat_can_manage_conversation(a.conversation_id)))
  ));

-- Private realtime channels are authorized by topic + current conversation membership. Realtime is
-- transient; PostgreSQL remains the source of truth for messages and read cursors.
do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute 'drop policy if exists chat_private_channel_receive on realtime.messages';
    execute 'create policy chat_private_channel_receive on realtime.messages for select to authenticated using (public.chat_realtime_topic_allowed(topic))';
    execute 'drop policy if exists chat_private_channel_broadcast on realtime.messages';
    execute 'create policy chat_private_channel_broadcast on realtime.messages for insert to authenticated with check (public.chat_realtime_topic_allowed(topic))';
  end if;
  if exists (select 1 from pg_publication where pubname='supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='chat_messages') then execute 'alter publication supabase_realtime add table public.chat_messages'; end if;
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='chat_conversations') then execute 'alter publication supabase_realtime add table public.chat_conversations'; end if;
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='chat_conversation_members') then execute 'alter publication supabase_realtime add table public.chat_conversation_members'; end if;
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='chat_reactions') then execute 'alter publication supabase_realtime add table public.chat_reactions'; end if;
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='chat_attachments') then execute 'alter publication supabase_realtime add table public.chat_attachments'; end if;
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='chat_read_state') then execute 'alter publication supabase_realtime add table public.chat_read_state'; end if;
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='chat_pins') then execute 'alter publication supabase_realtime add table public.chat_pins'; end if;
  end if;
end;
$$;
alter table public.chat_messages replica identity full;
alter table public.chat_conversation_members replica identity full;

commit;
