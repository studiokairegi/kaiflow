-- NDA e-signing for freelancers (Teams). Run once in the Supabase SQL editor.
-- Design: the owner creates a request through an RPC; the freelancer opens a
-- tokenised link (no account) that calls the public RPCs below. Only a SHA-256
-- hash of the token is stored. The NDA text is frozen on the request at send
-- time, so later template edits never change a document someone already got.

create extension if not exists pgcrypto with schema extensions;

create table if not exists nda_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'Freelancer NDA',
  body text not null,
  governing_law text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

create table if not exists nda_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  team_member_id uuid not null references team_members(id) on delete cascade,
  title text not null default 'Non-Disclosure Agreement',
  body text not null,
  body_hash text not null,
  token_hash text not null unique,
  studio_name text not null default '',
  signer_name text not null,
  signer_email text not null default '',
  status text not null default 'sent'
    check (status in ('sent','viewed','signed','declined','voided','expired')),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  viewed_at timestamptz,
  signed_at timestamptz,
  declined_at timestamptz,
  voided_at timestamptz,
  typed_name text,
  signature_png text,
  signature_method text check (signature_method in ('draw','type')),
  consent_text text,
  signer_ip text,
  signer_user_agent text,
  decline_reason text
);
create index if not exists nda_requests_member_idx on nda_requests (team_member_id, created_at desc);

create table if not exists nda_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references nda_requests(id) on delete cascade,
  user_id uuid not null,
  event text not null,
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);

alter table nda_templates enable row level security;
alter table nda_requests  enable row level security;
alter table nda_events    enable row level security;

create policy nda_templates_owner on nda_templates for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- Requests and events are read-only to the owner; every write goes through the RPCs.
create policy nda_requests_owner_read on nda_requests for select using (user_id = auth.uid());
create policy nda_events_owner_read   on nda_events   for select using (user_id = auth.uid());

-- helpers ------------------------------------------------------------------
create or replace function _nda_hash(p text) returns text
language sql immutable as $$ select encode(extensions.digest(p, 'sha256'), 'hex') $$;

create or replace function _nda_req_header(p_name text) returns text
language plpgsql stable as $$
declare h json;
begin
  begin
    h := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    return null;
  end;
  return h ->> p_name;
end $$;

create or replace function _nda_ip() returns text
language sql stable as $$
  select nullif(btrim(split_part(coalesce(_nda_req_header('x-forwarded-for'), ''), ',', 1)), '')
$$;

create or replace function _nda_public_json(r nda_requests) returns json
language sql stable as $$
  select json_build_object(
    'id', r.id, 'status', r.status, 'title', r.title, 'body', r.body,
    'body_hash', r.body_hash, 'studio_name', r.studio_name,
    'signer_name', r.signer_name, 'signer_email', r.signer_email,
    'expires_at', r.expires_at, 'created_at', r.created_at,
    'signed_at', r.signed_at, 'typed_name', r.typed_name,
    'signature_png', r.signature_png, 'signature_method', r.signature_method,
    'consent_text', r.consent_text, 'signer_ip', r.signer_ip)
$$;

-- owner RPCs -----------------------------------------------------------------
create or replace function create_nda_request(
  p_team_member_id uuid, p_title text, p_body text, p_signer_name text,
  p_signer_email text, p_studio_name text, p_expires_days int default 30
) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare v_token text; v_id uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not exists (select 1 from team_members where id = p_team_member_id and user_id = auth.uid()) then
    raise exception 'Team member not found';
  end if;
  if coalesce(btrim(p_body), '') = '' then raise exception 'NDA text is empty'; end if;

  -- one open request per person: a new link replaces any unsigned one
  update nda_requests set status = 'voided', voided_at = now()
   where team_member_id = p_team_member_id and user_id = auth.uid()
     and status in ('sent','viewed');

  v_token := encode(gen_random_bytes(32), 'hex');
  insert into nda_requests (user_id, team_member_id, title, body, body_hash, token_hash,
                            studio_name, signer_name, signer_email, expires_at)
  values (auth.uid(), p_team_member_id, coalesce(nullif(btrim(p_title), ''), 'Non-Disclosure Agreement'),
          p_body, _nda_hash(p_body), _nda_hash(v_token), coalesce(p_studio_name, ''),
          btrim(p_signer_name), coalesce(btrim(p_signer_email), ''),
          now() + make_interval(days => greatest(1, least(coalesce(p_expires_days, 30), 365))))
  returning id into v_id;

  insert into nda_events (request_id, user_id, event) values (v_id, auth.uid(), 'created');
  return json_build_object('id', v_id, 'token', v_token);
end $$;

create or replace function void_nda_request(p_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  update nda_requests set status = 'voided', voided_at = now()
   where id = p_id and user_id = auth.uid() and status in ('sent','viewed');
  if found then
    insert into nda_events (request_id, user_id, event) values (p_id, auth.uid(), 'voided');
  end if;
end $$;

-- public RPCs (the freelancer has no account) --------------------------------
create or replace function nda_public_get(p_token text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare r nda_requests;
begin
  select * into r from nda_requests where token_hash = _nda_hash(coalesce(p_token, ''));
  if not found then return null; end if;

  if r.status in ('sent','viewed') and r.expires_at is not null and r.expires_at < now() then
    update nda_requests set status = 'expired' where id = r.id returning * into r;
    insert into nda_events (request_id, user_id, event) values (r.id, r.user_id, 'expired');
  elsif r.status = 'sent' then
    update nda_requests set status = 'viewed', viewed_at = now() where id = r.id returning * into r;
    insert into nda_events (request_id, user_id, event, ip, user_agent)
    values (r.id, r.user_id, 'viewed', _nda_ip(), _nda_req_header('user-agent'));
  end if;
  return _nda_public_json(r);
end $$;

create or replace function nda_public_sign(
  p_token text, p_typed_name text, p_signature_png text, p_method text, p_consent text
) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare r nda_requests;
begin
  select * into r from nda_requests where token_hash = _nda_hash(coalesce(p_token, '')) for update;
  if not found then raise exception 'This signing link is not valid'; end if;
  if r.status not in ('sent','viewed') then raise exception 'This NDA can no longer be signed (%).', r.status; end if;
  if r.expires_at is not null and r.expires_at < now() then
    update nda_requests set status = 'expired' where id = r.id;
    raise exception 'This signing link has expired';
  end if;
  if length(btrim(coalesce(p_typed_name, ''))) < 2 then raise exception 'Type your full name'; end if;
  if p_method not in ('draw','type') then raise exception 'Invalid signature method'; end if;
  if p_signature_png is null or p_signature_png not like 'data:image/png;base64,%'
     or length(p_signature_png) > 400000 then
    raise exception 'Invalid signature image';
  end if;
  if coalesce(btrim(p_consent), '') = '' then raise exception 'Consent is required'; end if;

  update nda_requests
     set status = 'signed', signed_at = now(), typed_name = btrim(p_typed_name),
         signature_png = p_signature_png, signature_method = p_method,
         consent_text = p_consent, signer_ip = _nda_ip(),
         signer_user_agent = left(coalesce(_nda_req_header('user-agent'), ''), 400)
   where id = r.id returning * into r;
  insert into nda_events (request_id, user_id, event, ip, user_agent)
  values (r.id, r.user_id, 'signed', r.signer_ip, r.signer_user_agent);
  return _nda_public_json(r);
end $$;

create or replace function nda_public_decline(p_token text, p_reason text default '') returns json
language plpgsql security definer set search_path = public, extensions as $$
declare r nda_requests;
begin
  update nda_requests set status = 'declined', declined_at = now(),
         decline_reason = left(coalesce(p_reason, ''), 500)
   where token_hash = _nda_hash(coalesce(p_token, '')) and status in ('sent','viewed')
   returning * into r;
  if not found then raise exception 'This NDA can no longer be declined'; end if;
  insert into nda_events (request_id, user_id, event, ip, user_agent)
  values (r.id, r.user_id, 'declined', _nda_ip(), _nda_req_header('user-agent'));
  return _nda_public_json(r);
end $$;

revoke all on function create_nda_request(uuid,text,text,text,text,text,int) from public;
revoke all on function void_nda_request(uuid) from public;
revoke all on function nda_public_get(text) from public;
revoke all on function nda_public_sign(text,text,text,text,text) from public;
revoke all on function nda_public_decline(text,text) from public;
grant execute on function create_nda_request(uuid,text,text,text,text,text,int) to authenticated;
grant execute on function void_nda_request(uuid) to authenticated;
grant execute on function nda_public_get(text) to anon, authenticated;
grant execute on function nda_public_sign(text,text,text,text,text) to anon, authenticated;
grant execute on function nda_public_decline(text,text) to anon, authenticated;
