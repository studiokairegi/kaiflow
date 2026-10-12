-- Contacts & Clients.
--
-- Additive and idempotent. Nothing is dropped, renamed or rewritten:
--   * projects.client (legacy text) stays exactly as it is and keeps being
--     written; projects.contact_id is the new stable link.
--   * leads keep company_name / contact_person / email as they are; leads.contact_id
--     is the new stable link.
--   * create_project_with_shots() is NOT touched (it has a 15-arg overload that
--     other code depends on); the client links the new project with a follow-up update.
-- Run after every existing migration.

-- ---------------------------------------------------------------------------
-- 1. contacts
-- ---------------------------------------------------------------------------
create table if not exists public.contacts (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name             text not null check (length(btrim(name)) between 1 and 200),
  email            text check (email is null or length(email) <= 320),
  -- Normalized form used ONLY for duplicate detection. Generated, so it can't drift.
  email_normalized text generated always as (nullif(lower(btrim(email)), '')) stored,
  phone            text check (phone is null or length(phone) <= 60),
  company          text check (company is null or length(company) <= 200),
  role_title       text check (role_title is null or length(role_title) <= 120),
  website          text check (website is null or length(website) <= 500),
  notes            text check (notes is null or length(notes) <= 5000),
  relationship     text not null default 'prospect' check (relationship in ('prospect', 'client')),
  client_since     timestamptz,
  -- Client-generated key per create attempt: a double submit returns the first row.
  request_key      text check (request_key is null or length(request_key) between 8 and 64),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Hard duplicate guard: one contact per normalized email per owner.
create unique index if not exists contacts_user_email_uidx
  on public.contacts (user_id, email_normalized) where email_normalized is not null;
create unique index if not exists contacts_user_request_key_uidx
  on public.contacts (user_id, request_key) where request_key is not null;
create index if not exists contacts_user_name_idx on public.contacts (user_id, lower(name));
create index if not exists contacts_user_company_idx on public.contacts (user_id, lower(company));

alter table public.contacts enable row level security;
drop policy if exists "Users manage their own contacts" on public.contacts;
create policy "Users manage their own contacts" on public.contacts
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create or replace function public.contacts_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  -- A contact only becomes a client through an explicit action; keep client_since
  -- consistent with the relationship, and never clear history when demoted.
  if new.relationship = 'client' and new.client_since is null then
    new.client_since := now();
  end if;
  return new;
end;
$$;
drop trigger if exists contacts_touch on public.contacts;
create trigger contacts_touch before insert or update on public.contacts
  for each row execute function public.contacts_touch();

-- ---------------------------------------------------------------------------
-- 2. Stable links from projects and leads (nullable; ON DELETE SET NULL so
--    deleting a contact never deletes a project or deal).
-- ---------------------------------------------------------------------------
alter table public.projects add column if not exists contact_id uuid references public.contacts(id) on delete set null;
alter table public.leads    add column if not exists contact_id uuid references public.contacts(id) on delete set null;
create index if not exists projects_contact_idx on public.projects (contact_id) where contact_id is not null;
create index if not exists leads_contact_idx    on public.leads (contact_id) where contact_id is not null;

-- A row may only point at a contact owned by the same user (RLS alone doesn't
-- check the FK target). Also: attaching a contact to a project makes them a client.
create or replace function public.link_contact_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.contact_id is null then
    return new;
  end if;
  if not exists (select 1 from contacts c where c.id = new.contact_id and c.user_id = new.user_id) then
    raise exception 'contact_not_found' using errcode = 'P0002';
  end if;
  if tg_table_name = 'projects' then
    update contacts set relationship = 'client'
     where id = new.contact_id and relationship <> 'client';
  end if;
  return new;
end;
$$;

drop trigger if exists projects_contact_guard on public.projects;
create trigger projects_contact_guard before insert or update of contact_id on public.projects
  for each row execute function public.link_contact_guard();
drop trigger if exists leads_contact_guard on public.leads;
create trigger leads_contact_guard before insert or update of contact_id on public.leads
  for each row execute function public.link_contact_guard();

-- ---------------------------------------------------------------------------
-- 3. Create with duplicate prevention
-- ---------------------------------------------------------------------------
-- Possible duplicates for the UI's pre-check. Email is an exact (normalized)
-- match; name/company are only "possible" signals and never merge anything.
create or replace function public.find_contact_matches(p_name text, p_email text, p_company text)
returns table (id uuid, name text, email text, company text, relationship text, reason text)
language sql
stable
security invoker
set search_path = public
as $$
  select c.id, c.name, c.email, c.company, c.relationship,
         case
           when nullif(lower(btrim(p_email)), '') is not null and c.email_normalized = lower(btrim(p_email)) then 'same_email'
           when lower(btrim(c.name)) = lower(btrim(p_name))
                and coalesce(lower(btrim(c.company)), '') = coalesce(lower(btrim(p_company)), '') then 'same_name_and_company'
           else 'same_name'
         end as reason
  from contacts c
  where c.user_id = auth.uid()
    and (
      (nullif(lower(btrim(p_email)), '') is not null and c.email_normalized = lower(btrim(p_email)))
      or lower(btrim(c.name)) = lower(btrim(p_name))
    )
  order by (c.email_normalized = lower(btrim(p_email))) desc nulls last, c.name
  limit 10;
$$;
revoke all on function public.find_contact_matches(text, text, text) from public, anon;
grant execute on function public.find_contact_matches(text, text, text) to authenticated;

-- Idempotent create. Returns {contact, created, duplicate}:
--   same request_key  -> the original row, created=false
--   same email        -> the existing contact, created=false, duplicate=true (never a second row)
--   otherwise         -> a new row. Name-only look-alikes are NOT blocked here: the UI shows them
--                        via find_contact_matches and the user decides.
create or replace function public.create_contact(
  p_name text,
  p_email text default null,
  p_phone text default null,
  p_company text default null,
  p_role_title text default null,
  p_website text default null,
  p_notes text default null,
  p_relationship text default 'prospect',
  p_request_key text default null
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_email text := nullif(btrim(coalesce(p_email, '')), '');
  v_row contacts%rowtype;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if length(v_name) < 1 or length(v_name) > 200 then
    raise exception 'name_required' using errcode = 'P0001';
  end if;
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'email_invalid' using errcode = 'P0001';
  end if;
  if p_relationship not in ('prospect', 'client') then
    raise exception 'relationship_invalid' using errcode = 'P0001';
  end if;

  if p_request_key is not null then
    select * into v_row from contacts where user_id = v_uid and request_key = p_request_key;
    if found then
      return jsonb_build_object('contact', to_jsonb(v_row), 'created', false, 'duplicate', false);
    end if;
  end if;

  if v_email is not null then
    select * into v_row from contacts where user_id = v_uid and email_normalized = lower(v_email);
    if found then
      return jsonb_build_object('contact', to_jsonb(v_row), 'created', false, 'duplicate', true);
    end if;
  end if;

  begin
    insert into contacts (user_id, name, email, phone, company, role_title, website, notes, relationship, request_key)
    values (v_uid, v_name, v_email, nullif(btrim(coalesce(p_phone, '')), ''), nullif(btrim(coalesce(p_company, '')), ''),
            nullif(btrim(coalesce(p_role_title, '')), ''), nullif(btrim(coalesce(p_website, '')), ''),
            nullif(btrim(coalesce(p_notes, '')), ''), p_relationship, p_request_key)
    returning * into v_row;
  exception when unique_violation then
    -- A concurrent request won the race: return its row instead of failing.
    select * into v_row from contacts
     where user_id = v_uid
       and ((p_request_key is not null and request_key = p_request_key)
            or (v_email is not null and email_normalized = lower(v_email)))
     limit 1;
    if not found then raise; end if;
    return jsonb_build_object('contact', to_jsonb(v_row), 'created', false, 'duplicate', true);
  end;

  return jsonb_build_object('contact', to_jsonb(v_row), 'created', true, 'duplicate', false);
end;
$$;
revoke all on function public.create_contact(text, text, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.create_contact(text, text, text, text, text, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Won deals -> client. Shared by the trigger and the backfill.
--    Order: (1) the lead's already-linked contact, (2) an existing contact with
--    the same normalized email, (3) a new contact built from the deal.
--    Never matches on name alone; never overwrites an existing contact's details.
-- ---------------------------------------------------------------------------
create or replace function public._client_contact_for_lead(
  p_user uuid, p_contact_id uuid, p_name text, p_email text, p_company text, p_website text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_email text := nullif(btrim(coalesce(p_email, '')), '');
  v_name text := coalesce(nullif(btrim(coalesce(p_name, '')), ''), nullif(btrim(coalesce(p_company, '')), ''), 'Unnamed client');
begin
  if p_contact_id is not null then
    update contacts set relationship = 'client'
     where id = p_contact_id and user_id = p_user
     returning id into v_id;
    if v_id is not null then return v_id; end if;
  end if;

  if v_email is not null and v_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    update contacts set relationship = 'client'
     where user_id = p_user and email_normalized = lower(v_email)
     returning id into v_id;
    if v_id is not null then return v_id; end if;
  else
    v_email := null;  -- malformed email on a lead: don't fail the stage change over it
  end if;

  begin
    insert into contacts (user_id, name, email, company, website, relationship)
    values (p_user, left(v_name, 200), v_email, nullif(left(btrim(coalesce(p_company, '')), 200), ''),
            nullif(left(btrim(coalesce(p_website, '')), 500), ''), 'client')
    returning id into v_id;
  exception when unique_violation then
    select id into v_id from contacts where user_id = p_user and email_normalized = lower(v_email);
    update contacts set relationship = 'client' where id = v_id;
  end;
  return v_id;
end;
$$;
revoke all on function public._client_contact_for_lead(uuid, uuid, text, text, text, text) from public, anon, authenticated;

-- Fires on the transition INTO 'won' (and on inserting a lead already won). A
-- repeated save of an already-won lead does nothing, so it can't create duplicates.
-- This sits on the table, so every path (drag on the board, lead editor, Mark won)
-- behaves identically and atomically with the stage change. Stage definitions and
-- the existing pipeline are untouched.
create or replace function public.leads_won_creates_client()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.stage = 'won' and (tg_op = 'INSERT' or old.stage is distinct from 'won') then
    new.contact_id := public._client_contact_for_lead(
      new.user_id, new.contact_id, new.contact_person, new.email, new.company_name, new.website);
  end if;
  return new;
end;
$$;
drop trigger if exists leads_won_creates_client on public.leads;
create trigger leads_won_creates_client before insert or update of stage on public.leads
  for each row execute function public.leads_won_creates_client();

-- ---------------------------------------------------------------------------
-- 5. Conservative backfill for deals that were already Won before this feature.
--    Explicit relationships only: a won lead gets a contact, and its
--    linked_project_id project is linked ONLY if that project has no contact yet.
--    No matching on names. Run on demand from the Contacts page; safe to repeat.
-- ---------------------------------------------------------------------------
create or replace function public.backfill_contacts_from_won_leads()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  r record;
  v_contact uuid;
  v_leads int := 0;
  v_projects int := 0;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;

  for r in select * from leads where user_id = v_uid and stage = 'won' and contact_id is null loop
    v_contact := _client_contact_for_lead(v_uid, null, r.contact_person, r.email, r.company_name, r.website);
    update leads set contact_id = v_contact where id = r.id;
    v_leads := v_leads + 1;
  end loop;

  update projects p set contact_id = l.contact_id
    from leads l
   where l.user_id = v_uid and p.user_id = v_uid
     and l.stage = 'won' and l.contact_id is not null
     and l.linked_project_id = p.id and p.contact_id is null;
  get diagnostics v_projects = row_count;

  return jsonb_build_object('leadsLinked', v_leads, 'projectsLinked', v_projects);
end;
$$;
revoke all on function public.backfill_contacts_from_won_leads() from public, anon;
grant execute on function public.backfill_contacts_from_won_leads() to authenticated;
