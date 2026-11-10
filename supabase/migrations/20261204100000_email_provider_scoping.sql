-- KairFlow Email, multi-provider plan, PHASE 2 (2 of 2): provider-scoped accounts, messages and drafts.
-- NEW, ADDITIVE migration after 20261204090000_email_provider_registry.sql. It does not edit earlier files.
-- Rollback: restore the prior email provider account/message RPC definitions from the preceding migration. Nothing here deletes messages.
--
-- What it does
--   1. Provider identity: email_accounts.provider and email_messages.provider reference the registry; the Resend-only CHECK on
--      email_accounts is replaced by that reference. A message's provider is ALWAYS its account's provider (filled by a trigger when
--      omitted, refused when it disagrees, and enforced by a composite foreign key), so it cannot drift. email_accounts.provider keeps
--      its 'resend' column default for old callers; the account RPC now passes the provider explicitly.
--   2. Account uniqueness: (organization_id, provider, address) replaces (organization_id, address). The same address can now be
--      connected through two different providers; it still cannot be added twice through the same one.
--   3. Message deduplication per ACCOUNT (decision D5): (account_id, direction, provider_message_id) and (account_id, rfc_message_id)
--      replace the organisation-wide indexes. Provider ids are not assumed globally unique across providers or mailboxes.
--   4. Ownership is immutable: account/organisation/provider of an account, and organisation/account/conversation/provider of a
--      message, cannot be changed by UPDATE.
--   5. Drafts: email_save_draft and email_create_outbound REFUSE a draft or conversation that belongs to a different sender account,
--      instead of silently re-identifying it.
--   6. email_upsert_account takes an explicit provider, validated against the registry (never trusted from the browser alone).
--   7. email_ingest_inbound: duplicate checks are scoped to the account; the account's provider must match the expected provider.
--
-- Deliberately NOT changed (see PHASE_2_HANDOFF_REPORT.md)
--   * email_provider_flags / email_provider_enabled / provider_guard.ts / every intel_* object.
--   * email_apply_delivery_event, email_webhook_claim, email_replay_delivery_events_for_message and the email_events unique index
--     (their latest definitions live in 20261203100000 and carry Intelligence suppression logic).
--   * intel_agent_email_save_draft (its drafts get the right provider from the trigger in section 3, so it needs no edit).
-- Nothing is sent by applying this. Re-runnable. Existing rows are never deleted or rewritten.
begin;

do $$ begin
  if to_regclass('public.email_provider_registry') is null then
    raise exception 'Apply 20261204090000_email_provider_registry.sql first';
  end if;
  if to_regprocedure('public.email_webhook_claim(text,text,jsonb,int,int)') is null
     or to_regprocedure('public.email_find_conversation_by_token(uuid,uuid,text)') is null then
    raise exception 'Apply 20261111090000_email_resend_hardening.sql first';
  end if;
end $$;

-- 1. Provider identity ---------------------------------------------------------------------------------------------------------------
create unique index if not exists email_accounts_id_provider_uidx on public.email_accounts(id, provider);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'email_accounts_provider_registry_fk') then
    alter table public.email_accounts add constraint email_accounts_provider_registry_fk
      foreign key (provider) references public.email_provider_registry(provider_key) on update restrict on delete restrict not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'email_messages_provider_registry_fk') then
    alter table public.email_messages add constraint email_messages_provider_registry_fk
      foreign key (provider) references public.email_provider_registry(provider_key) on update restrict on delete restrict not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'email_messages_account_provider_fk') then
    alter table public.email_messages add constraint email_messages_account_provider_fk
      foreign key (account_id, provider) references public.email_accounts(id, provider) on delete cascade not valid;
  end if;
end $$;

-- Existing rows are all 'resend', so validation normally succeeds here. If it ever does not, the constraint stays NOT VALID (still
-- enforced for new rows) and a warning says which one; the migration does not fail.
do $$
declare c record;
begin
  for c in select * from (values ('email_accounts', 'email_accounts_provider_registry_fk'),
                                 ('email_messages', 'email_messages_provider_registry_fk'),
                                 ('email_messages', 'email_messages_account_provider_fk')) v(t, n) loop
    begin
      execute format('alter table public.%I validate constraint %I', c.t, c.n);
    exception when foreign_key_violation then
      raise warning 'Constraint % on % left NOT VALID: existing rows violate it. Fix them, then validate it by hand.', c.n, c.t;
    end;
  end loop;
end $$;

-- The Resend-only CHECK on email_accounts.provider is replaced by the registry reference above.
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.email_accounts'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) like '%provider = ''resend''%' loop
    execute format('alter table public.email_accounts drop constraint %I', c.conname);
  end loop;
end $$;

-- 2. Account uniqueness per provider ---------------------------------------------------------------------------------------------------
create unique index if not exists email_accounts_provider_address_uidx on public.email_accounts(organization_id, provider, address);
drop index if exists public.email_accounts_address_uidx;      -- superseded; email_upsert_account below no longer names it

-- 3. Message provider is derived from the account; deduplication is per account -------------------------------------------------------------
create or replace function public._email_message_provider_from_account() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_provider text;
begin
  select a.provider into v_provider from public.email_accounts a where a.id = new.account_id;
  if v_provider is null then return new; end if;                  -- no such account: the foreign key refuses the row
  if new.provider is null then
    new.provider := v_provider;                                    -- omitted: take the account's provider
  elsif new.provider <> v_provider then
    raise exception 'A message must use the provider of its account' using errcode = '23514';   -- stated, but different: refuse, never silently relabel
  end if;
  return new;
end $$;
-- The column default ('resend') is dropped so that an omitted provider is filled from the account by the trigger below, while an explicit
-- provider that disagrees with the account is refused. Every existing insert path omits it (they go through the RPCs).
alter table public.email_messages alter column provider drop default;
revoke all on function public._email_message_provider_from_account() from public, anon, authenticated;
drop trigger if exists email_messages_provider_from_account on public.email_messages;
create trigger email_messages_provider_from_account before insert on public.email_messages
  for each row execute function public._email_message_provider_from_account();

create unique index if not exists email_messages_account_provider_uidx
  on public.email_messages(account_id, direction, provider_message_id) where provider_message_id is not null;
create unique index if not exists email_messages_account_rfc_uidx
  on public.email_messages(account_id, rfc_message_id) where rfc_message_id is not null;
-- The new indexes are strictly narrower than the old ones, so they cannot fail on data the old ones accepted.
drop index if exists public.email_messages_provider_uidx;
drop index if exists public.email_messages_rfc_uidx;
-- email_messages_idem_uidx (organization_id, idempotency_key) is kept as is.

-- 4. Ownership cannot be changed after the fact ---------------------------------------------------------------------------------------------
create or replace function public._email_owner_immutable() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if tg_table_name = 'email_accounts' then
    if new.organization_id is distinct from old.organization_id or new.provider is distinct from old.provider then
      raise exception 'An email account cannot change organization or provider' using errcode = '42501';
    end if;
  elsif tg_table_name = 'email_conversations' then
    if new.organization_id is distinct from old.organization_id or new.account_id is distinct from old.account_id then
      raise exception 'A conversation cannot move to another account or organization' using errcode = '42501';
    end if;
  elsif tg_table_name = 'email_messages' then
    if new.organization_id is distinct from old.organization_id or new.account_id is distinct from old.account_id
       or new.conversation_id is distinct from old.conversation_id or new.provider is distinct from old.provider then
      raise exception 'A message cannot move to another account, conversation, organization or provider' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function public._email_owner_immutable() from public, anon, authenticated;

drop trigger if exists email_accounts_owner_immutable on public.email_accounts;
create trigger email_accounts_owner_immutable before update of organization_id, provider on public.email_accounts
  for each row execute function public._email_owner_immutable();
drop trigger if exists email_conversations_owner_immutable on public.email_conversations;
create trigger email_conversations_owner_immutable before update of organization_id, account_id on public.email_conversations
  for each row execute function public._email_owner_immutable();
drop trigger if exists email_messages_owner_immutable on public.email_messages;
create trigger email_messages_owner_immutable before update of organization_id, account_id, conversation_id, provider on public.email_messages
  for each row execute function public._email_owner_immutable();

-- 5. Accounts: explicit, registry-validated provider ----------------------------------------------------------------------------------------
drop function if exists public.email_upsert_account(text, text);
create or replace function public.email_upsert_account(p_address text, p_display_name text default '', p_provider text default 'resend') returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.email_require_access(); v_addr text := lower(btrim(coalesce(p_address, ''))); v_prov text := lower(btrim(coalesce(p_provider, ''))); r public.email_accounts;
begin
  if v_addr !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email address'; end if;
  if not exists (select 1 from public.email_provider_registry where provider_key = v_prov and enabled) then
    raise exception 'Unknown or disabled email provider';           -- decided here, from the registry, never from the browser's word alone
  end if;
  insert into public.email_accounts (organization_id, provider, address, display_name, is_default)
  values (v_org, v_prov, v_addr, left(btrim(coalesce(p_display_name, '')), 120), not exists (select 1 from public.email_accounts where organization_id = v_org))
  on conflict (organization_id, provider, address) do update set display_name = excluded.display_name
  returning * into r;
  return to_jsonb(r);
end $$;
revoke all on function public.email_upsert_account(text, text, text) from public, anon;
grant execute on function public.email_upsert_account(text, text, text) to authenticated;

-- 6. Drafts and outbound: never silently re-identified -------------------------------------------------------------------------------------
create or replace function public.email_save_draft(
  p_draft_id uuid, p_conversation_id uuid, p_account_id uuid,
  p_to text[], p_cc text[], p_bcc text[], p_subject text, p_body_text text, p_body_html text default ''
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.email_require_access(); v_conv uuid := p_conversation_id; v_acc public.email_accounts; m public.email_messages; v_conv_acc uuid;
begin
  select * into v_acc from public.email_accounts where id = p_account_id and organization_id = v_org;
  if not found then raise exception 'Sender address not found'; end if;
  if p_draft_id is not null then
    select * into m from public.email_messages where id = p_draft_id and organization_id = v_org and status = 'draft' for update;
    if not found then raise exception 'Draft not found'; end if;
    if m.account_id <> v_acc.id then raise exception 'This draft belongs to a different sender account'; end if;
    update public.email_messages
       set to_emails = coalesce(p_to, '{}'), cc_emails = coalesce(p_cc, '{}'), bcc_emails = coalesce(p_bcc, '{}'),
           subject = left(coalesce(p_subject, ''), 998), body_text = left(coalesce(p_body_text, ''), 200000), body_html = left(coalesce(p_body_html, ''), 400000), ai_generated = false
     where id = p_draft_id
     returning * into m;
    return jsonb_build_object('draft_id', m.id, 'conversation_id', m.conversation_id);
  end if;
  if v_conv is null then
    insert into public.email_conversations (organization_id, account_id, subject, normalized_subject)
    values (v_org, v_acc.id, left(coalesce(p_subject, ''), 998), '') returning id into v_conv;
  else
    select account_id into v_conv_acc from public.email_conversations where id = v_conv and organization_id = v_org;
    if not found then raise exception 'Conversation not found'; end if;
    if v_conv_acc <> v_acc.id then raise exception 'This conversation belongs to a different sender account'; end if;
  end if;
  insert into public.email_messages (organization_id, conversation_id, account_id, direction, status, from_email, from_name, to_emails, cc_emails, bcc_emails, subject, body_text, body_html, is_read, created_by)
  values (v_org, v_conv, v_acc.id, 'outbound', 'draft', v_acc.address, v_acc.display_name, coalesce(p_to, '{}'), coalesce(p_cc, '{}'), coalesce(p_bcc, '{}'),
          left(coalesce(p_subject, ''), 998), left(coalesce(p_body_text, ''), 200000), left(coalesce(p_body_html, ''), 400000), true, auth.uid())
  returning * into m;
  return jsonb_build_object('draft_id', m.id, 'conversation_id', m.conversation_id);
end $$;
revoke all on function public.email_save_draft(uuid,uuid,uuid,text[],text[],text[],text,text,text) from public, anon;
grant execute on function public.email_save_draft(uuid,uuid,uuid,text[],text[],text[],text,text,text) to authenticated;

create or replace function public.email_create_outbound(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := (p ->> 'organization_id')::uuid; v_acc public.email_accounts; v_conv uuid := nullif(p ->> 'conversation_id', '')::uuid; v_conv_acc uuid; v_draft_acc uuid;
  v_draft uuid := nullif(p ->> 'draft_id', '')::uuid; v_key text := nullif(p ->> 'idempotency_key', ''); m public.email_messages; v_addr text; r text;
begin
  select * into v_acc from public.email_accounts where id = (p ->> 'account_id')::uuid and organization_id = v_org;
  if not found then raise exception 'Sender address not found'; end if;
  if v_key is not null then
    select * into m from public.email_messages where organization_id = v_org and idempotency_key = v_key;
    if found then return jsonb_build_object('duplicate', true, 'message_id', m.id, 'conversation_id', m.conversation_id, 'status', m.status, 'provider_message_id', m.provider_message_id); end if;
  end if;
  if v_conv is not null then
    select account_id into v_conv_acc from public.email_conversations where id = v_conv and organization_id = v_org;
    if not found then raise exception 'Conversation not found'; end if;
    if v_conv_acc <> v_acc.id then raise exception 'This conversation belongs to a different sender account'; end if;
  end if;
  if v_draft is not null then
    select conversation_id, account_id into v_conv, v_draft_acc from public.email_messages where id = v_draft and organization_id = v_org and status = 'draft' for update;
    if not found then raise exception 'Draft not found'; end if;
    if v_draft_acc <> v_acc.id then raise exception 'This draft belongs to a different sender account'; end if;
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
revoke all on function public.email_create_outbound(jsonb) from public, anon, authenticated;
grant execute on function public.email_create_outbound(jsonb) to service_role;

-- 7. Inbound: duplicates are per account; the account's provider must be the expected one ----------------------------------------------------
-- Starts from the 20261111090000 definition (the latest one). The optional 'provider' key defaults to 'resend', which is what the
-- existing resend-webhook sends (it sends nothing), so current behaviour is unchanged.
create or replace function public.email_ingest_inbound(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid; v_acc uuid; v_conv uuid; v_pmid text; v_rfc text; v_provider text;
  a public.email_accounts; c public.email_conversations;
  v_msg uuid; v_existing uuid; part jsonb; att jsonb; v_addr text; v_new_conv boolean := false;
begin
  begin
    v_org := (p ->> 'organization_id')::uuid; v_acc := (p ->> 'account_id')::uuid; v_conv := nullif(p ->> 'conversation_id', '')::uuid;
  exception when others then
    raise exception 'Invalid inbound payload' using errcode = '22023';
  end;
  v_pmid := nullif(btrim(coalesce(p ->> 'provider_message_id', '')), '');
  v_rfc := nullif(btrim(coalesce(p ->> 'rfc_message_id', '')), '');
  v_provider := lower(coalesce(nullif(btrim(coalesce(p ->> 'provider', '')), ''), 'resend'));
  if v_org is null or v_acc is null or v_pmid is null then raise exception 'Invalid inbound payload' using errcode = '22023'; end if;

  -- ownership, checked here regardless of what the caller already checked
  select * into a from public.email_accounts where id = v_acc;
  if not found or a.organization_id <> v_org then raise exception 'Inbound account does not belong to this organization' using errcode = '42501'; end if;
  if a.status <> 'active' then raise exception 'Inbound account is not active' using errcode = '42501'; end if;
  if a.provider <> v_provider then
    raise exception 'Inbound account is not a % account', coalesce((select r.display_name from public.email_provider_registry r where r.provider_key = v_provider), v_provider) using errcode = '42501';
  end if;
  if v_conv is not null then
    select * into c from public.email_conversations where id = v_conv;
    if not found or c.organization_id <> v_org then raise exception 'Conversation does not belong to this organization' using errcode = '42501'; end if;
    if c.account_id <> v_acc then raise exception 'Conversation belongs to a different sender address' using errcode = '42501'; end if;
  end if;

  select id into v_existing from public.email_messages
   where account_id = v_acc and ((direction = 'inbound' and provider_message_id = v_pmid) or (v_rfc is not null and rfc_message_id = v_rfc))
   limit 1;
  if v_existing is not null then
    update public.email_messages set conversation_id=coalesce(v_conv,conversation_id),rfc_message_id=coalesce(v_rfc,rfc_message_id),
      in_reply_to=nullif(p ->> 'in_reply_to',''),references_ids=nullif(p ->> 'references_ids',''),
      from_email=lower(coalesce(p ->> 'from_email',from_email)),from_name=left(coalesce(p ->> 'from_name',from_name),200),
      to_emails=coalesce(array(select jsonb_array_elements_text(p -> 'to_emails')),to_emails),
      cc_emails=coalesce(array(select jsonb_array_elements_text(p -> 'cc_emails')),cc_emails),
      bcc_emails=coalesce(array(select jsonb_array_elements_text(p -> 'bcc_emails')),bcc_emails),
      reply_to=left(coalesce(p ->> 'reply_to',reply_to),500),subject=left(coalesce(p ->> 'subject',subject),998),
      body_text=left(coalesce(p ->> 'body_text',body_text),400000),body_html=left(coalesce(p ->> 'body_html',body_html),800000),
      headers=coalesce(p -> 'headers',headers),is_read=coalesce((p ->> 'is_read')::boolean,is_read),
      received_at=coalesce((p ->> 'received_at')::timestamptz,received_at)
    where id=v_existing and account_id=v_acc and organization_id=v_org;
    for att in select * from jsonb_array_elements(coalesce(p -> 'attachments','[]'::jsonb)) loop
      update public.email_attachments set filename=left(coalesce(att ->> 'filename',filename),300),content_type=coalesce(att ->> 'content_type',content_type),
        size_bytes=greatest(coalesce((att ->> 'size_bytes')::bigint,size_bytes),0),content_id=nullif(att ->> 'content_id',''),
        is_inline=coalesce((att ->> 'is_inline')::boolean,is_inline)
      where message_id=v_existing and provider_attachment_id=att ->> 'provider_attachment_id';
      if not exists(select 1 from public.email_attachments where message_id=v_existing and provider_attachment_id=att ->> 'provider_attachment_id') then
        insert into public.email_attachments(organization_id,message_id,provider_attachment_id,filename,content_type,size_bytes,content_id,is_inline,storage_path)
        values(v_org,v_existing,att ->> 'provider_attachment_id',left(coalesce(att ->> 'filename','attachment'),300),coalesce(att ->> 'content_type','application/octet-stream'),
          greatest(coalesce((att ->> 'size_bytes')::bigint,0),0),nullif(att ->> 'content_id',''),coalesce((att ->> 'is_inline')::boolean,false),nullif(att ->> 'storage_path',''));
      end if;
    end loop;
    return jsonb_build_object('duplicate',true,'updated',true,'message_id',v_existing);
  end if;

  begin     -- sub-transaction: a lost race on the unique indexes rolls the new conversation back with it
    if v_conv is null then
      insert into public.email_conversations (organization_id, account_id, subject, normalized_subject)
      values (v_org, v_acc, left(coalesce(p ->> 'subject', ''), 998), coalesce(p ->> 'normalized_subject', '')) returning id into v_conv;
      v_new_conv := true;
    end if;
    insert into public.email_messages (organization_id, conversation_id, account_id, direction, provider_message_id, rfc_message_id, in_reply_to, references_ids,
           from_email, from_name, to_emails, cc_emails, bcc_emails, reply_to, subject, body_text, body_html, status, is_read, headers, auth_results, received_at)
    values (v_org, v_conv, v_acc, 'inbound', v_pmid, v_rfc, nullif(p ->> 'in_reply_to', ''), nullif(p ->> 'references_ids', ''),
            lower(coalesce(p ->> 'from_email', '')), left(coalesce(p ->> 'from_name', ''), 200),
            coalesce(array(select jsonb_array_elements_text(p -> 'to_emails')), '{}'), coalesce(array(select jsonb_array_elements_text(p -> 'cc_emails')), '{}'),
            coalesce(array(select jsonb_array_elements_text(p -> 'bcc_emails')), '{}'), left(coalesce(p ->> 'reply_to', ''), 500),
            left(coalesce(p ->> 'subject', ''), 998), left(coalesce(p ->> 'body_text', ''), 400000), left(coalesce(p ->> 'body_html', ''), 800000),
            'received', coalesce((p ->> 'is_read')::boolean,false), coalesce(p -> 'headers', '{}'::jsonb), p -> 'auth_results', coalesce((p ->> 'received_at')::timestamptz, now()))
    returning id into v_msg;
  exception when unique_violation then
    select id into v_existing from public.email_messages
     where account_id = v_acc and ((direction = 'inbound' and provider_message_id = v_pmid) or (v_rfc is not null and rfc_message_id = v_rfc)) limit 1;
    if v_existing is null then raise; end if;
    return jsonb_build_object('duplicate', true, 'message_id', v_existing);
  end;

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
revoke all on function public.email_ingest_inbound(jsonb) from public, anon, authenticated;
grant execute on function public.email_ingest_inbound(jsonb) to service_role;

commit;
