-- KairFlow Email (Resend) hardening. NEW, ADDITIVE corrective migration on top of 20261110090000_email_resend_core.sql.
-- It does not edit that file (it may already be applied) and does not touch Gmail/Zoho/Intelligence objects, rows or credentials.
--
-- What it does:
--   1. Database-enforced ownership: composite keys so a conversation can only point at an account of the SAME organization and a
--      message only at a conversation of the SAME organization AND account. Added NOT VALID: enforced for every new row, existing
--      rows are not scanned (see the VALIDATE note at the end).
--   2. email_ingest_inbound(): validates org / account (exists, same org, active, provider resend) / conversation (same org, same
--      account) BEFORE inserting anything, and raises instead of silently creating a different conversation.
--   3. email_apply_delivery_event(): resend + outbound only, refuses ambiguous ids, allow-lists statuses, moves status strictly
--      forward, and never lets a duplicate event id change anything.
--   4. Atomic webhook processing: a claim/lease with an ownership token (email_webhook_claim / email_webhook_finish).
--   5. email_find_conversation_by_token(org, account, token): thread token lookup scoped to the account as well.
-- Service-role functions are not executable by browsers. Re-runnable.
begin;

do $$ begin
  if to_regclass('public.email_webhook_events') is null or to_regprocedure('public.email_ingest_inbound(jsonb)') is null then
    raise exception 'Apply 20261110090000_email_resend_core.sql first';
  end if;
end $$;

-- 1. Ownership constraints ---------------------------------------------------------------------------------------------------
create unique index if not exists email_accounts_id_org_uidx on public.email_accounts(id, organization_id);
create unique index if not exists email_conversations_id_org_acc_uidx on public.email_conversations(id, organization_id, account_id);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'email_conversations_account_org_fk') then
    alter table public.email_conversations add constraint email_conversations_account_org_fk
      foreign key (account_id, organization_id) references public.email_accounts(id, organization_id) on delete cascade not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'email_messages_conversation_org_acc_fk') then
    alter table public.email_messages add constraint email_messages_conversation_org_acc_fk
      foreign key (conversation_id, organization_id, account_id) references public.email_conversations(id, organization_id, account_id) on delete cascade not valid;
  end if;
end $$;

-- 2. Webhook claim columns ---------------------------------------------------------------------------------------------------
alter table public.email_webhook_events add column if not exists claim_token uuid;
alter table public.email_webhook_events add column if not exists claimed_at timestamptz;
alter table public.email_webhook_events add column if not exists lease_expires_at timestamptz;
alter table public.email_webhook_events drop constraint if exists email_webhook_events_status_check;
alter table public.email_webhook_events add constraint email_webhook_events_status_check
  check (status in ('received', 'processing', 'processed', 'failed', 'ignored'));

-- Claim state machine (one row per Svix delivery id):
--   (no row) --claim--> processing(token T1, lease until now+lease)
--   processing, lease valid        --claim--> BUSY (caller answers 409 so the sender retries later)
--   processing, lease expired      --claim--> processing(new token T2, attempts+1)      (crashed worker recovered)
--   failed | received(legacy)      --claim--> processing(new token, attempts+1)         (retry)
--   processed | ignored            --claim--> DONE (idempotent success, nothing runs)
--   attempts >= max, not finished  --claim--> EXHAUSTED (status failed; acknowledged so the sender stops; owner can reset attempts)
--   finish(token, status) only succeeds while that token still owns the row: an old worker can never overwrite a newer claim.
create or replace function public.email_webhook_claim(p_svix_id text, p_type text, p_payload jsonb, p_lease_seconds int default 300, p_max_attempts int default 12)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare r public.email_webhook_events; v_lease interval := make_interval(secs => least(greatest(coalesce(p_lease_seconds, 300), 30), 900));
begin
  if nullif(btrim(coalesce(p_svix_id, '')), '') is null then raise exception 'Missing webhook id' using errcode = '22023'; end if;
  insert into public.email_webhook_events (svix_id, event_type, status, attempts, payload, claim_token, claimed_at, lease_expires_at)
  values (p_svix_id, left(coalesce(p_type, ''), 100), 'processing', 1, coalesce(p_payload, '{}'::jsonb), gen_random_uuid(), now(), now() + v_lease)
  on conflict (svix_id) do nothing
  returning * into r;
  if found then
    return jsonb_build_object('state', 'claimed', 'token', r.claim_token, 'attempts', 1);
  end if;

  select * into r from public.email_webhook_events where svix_id = p_svix_id for update;     -- serialises concurrent claimers on this row
  if r.status in ('processed', 'ignored') then
    return jsonb_build_object('state', 'done', 'status', r.status);
  end if;
  if r.status = 'processing' and r.lease_expires_at is not null and r.lease_expires_at > now() then
    return jsonb_build_object('state', 'busy');
  end if;
  if r.attempts >= greatest(coalesce(p_max_attempts, 12), 1) then
    update public.email_webhook_events set status = 'failed', claim_token = null, lease_expires_at = null,
           error = case when error = '' then 'Retry limit reached' else error end where svix_id = p_svix_id;
    return jsonb_build_object('state', 'exhausted', 'attempts', r.attempts);
  end if;
  update public.email_webhook_events
     set status = 'processing', attempts = attempts + 1, claim_token = gen_random_uuid(), claimed_at = now(), lease_expires_at = now() + v_lease
   where svix_id = p_svix_id
   returning * into r;
  return jsonb_build_object('state', 'claimed', 'token', r.claim_token, 'attempts', r.attempts);
end $$;

create or replace function public.email_webhook_finish(p_svix_id text, p_token uuid, p_status text, p_error text default '')
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_id uuid;
begin
  if p_status not in ('processed', 'failed', 'ignored') then raise exception 'Unsupported webhook status' using errcode = '22023'; end if;
  update public.email_webhook_events
     set status = p_status, error = left(coalesce(p_error, ''), 500), processed_at = now(), claim_token = null, lease_expires_at = null
   where svix_id = p_svix_id and claim_token is not distinct from p_token and p_token is not null and status = 'processing'
   returning id into v_id;
  return jsonb_build_object('ok', v_id is not null);       -- false = this worker no longer owns the claim; its result is discarded
end $$;

-- 3. Thread token lookup scoped to organization AND account ------------------------------------------------------------------
create or replace function public.email_find_conversation_by_token(p_organization_id uuid, p_account_id uuid, p_token text) returns uuid
language sql stable security definer set search_path = pg_catalog, public as $$
  select id from public.email_conversations
   where organization_id = p_organization_id and account_id = p_account_id and p_token ~ '^[0-9a-f]{12}$'
     and replace(id::text, '-', '') like p_token || '%'
   order by created_at desc limit 1
$$;

-- 4. Inbound ingest with independent ownership validation --------------------------------------------------------------------
create or replace function public.email_ingest_inbound(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid; v_acc uuid; v_conv uuid; v_pmid text; v_rfc text;
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
  if v_org is null or v_acc is null or v_pmid is null then raise exception 'Invalid inbound payload' using errcode = '22023'; end if;

  -- ownership, checked here regardless of what the caller already checked
  select * into a from public.email_accounts where id = v_acc;
  if not found or a.organization_id <> v_org then raise exception 'Inbound account does not belong to this organization' using errcode = '42501'; end if;
  if a.status <> 'active' then raise exception 'Inbound account is not active' using errcode = '42501'; end if;
  if a.provider <> 'resend' then raise exception 'Inbound account is not a Resend account' using errcode = '42501'; end if;
  if v_conv is not null then
    select * into c from public.email_conversations where id = v_conv;
    if not found or c.organization_id <> v_org then raise exception 'Conversation does not belong to this organization' using errcode = '42501'; end if;
    if c.account_id <> v_acc then raise exception 'Conversation belongs to a different sender address' using errcode = '42501'; end if;
  end if;

  select id into v_existing from public.email_messages
   where organization_id = v_org and ((direction = 'inbound' and provider_message_id = v_pmid) or (v_rfc is not null and rfc_message_id = v_rfc))
   limit 1;
  if v_existing is not null then
    return jsonb_build_object('duplicate', true, 'message_id', v_existing);
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
            'received', false, coalesce(p -> 'headers', '{}'::jsonb), p -> 'auth_results', coalesce((p ->> 'received_at')::timestamptz, now()))
    returning id into v_msg;
  exception when unique_violation then
    select id into v_existing from public.email_messages
     where organization_id = v_org and ((direction = 'inbound' and provider_message_id = v_pmid) or (v_rfc is not null and rfc_message_id = v_rfc)) limit 1;
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

-- 5. Delivery events: resend + outbound only, unambiguous, allow-listed, strictly forward ------------------------------------
create or replace function public.email_apply_delivery_event(p_provider_message_id text, p_status text, p_event_type text, p_provider_event_id text, p_occurred_at timestamptz, p_detail jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare m public.email_messages; v_n int; v_ins int; v_applied boolean := false;
begin
  if p_status is null or p_status not in ('sent', 'delivered', 'delivery_delayed', 'bounced', 'complained', 'failed', 'rejected') then
    raise exception 'Unsupported delivery status' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_provider_message_id, '')), '') is null then raise exception 'Missing provider message id' using errcode = '22023'; end if;

  select count(*) into v_n from public.email_messages where provider = 'resend' and direction = 'outbound' and provider_message_id = p_provider_message_id;
  if v_n = 0 then return jsonb_build_object('found', false); end if;
  if v_n > 1 then return jsonb_build_object('found', false, 'ambiguous', true); end if;          -- never update an arbitrary row

  select * into m from public.email_messages where provider = 'resend' and direction = 'outbound' and provider_message_id = p_provider_message_id for update;
  insert into public.email_events (organization_id, message_id, event_type, provider_event_id, occurred_at, detail)
  values (m.organization_id, m.id, left(coalesce(p_event_type, ''), 100), p_provider_event_id, coalesce(p_occurred_at, now()), coalesce(p_detail, '{}'::jsonb))
  on conflict (provider_event_id) where provider_event_id is not null do nothing;
  get diagnostics v_ins = row_count;
  if v_ins = 0 then
    return jsonb_build_object('found', true, 'duplicate', true, 'applied', false, 'message_id', m.id);   -- an event id is applied once
  end if;

  if public._email_status_rank(p_status) > public._email_status_rank(m.status) then      -- strictly forward: delivered never back to sent, bounced never replaced by failed
    update public.email_messages
       set status = p_status,
           error = case when p_status in ('bounced', 'failed', 'rejected', 'complained') then left(coalesce(p_detail ->> 'reason', p_event_type), 500) else error end,
           sent_at = coalesce(sent_at, case when p_status = 'sent' then coalesce(p_occurred_at, now()) end)
     where id = m.id;
    v_applied := true;
  end if;
  return jsonb_build_object('found', true, 'applied', v_applied, 'message_id', m.id);
end $$;

-- 6. Grants: service role only -----------------------------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['email_webhook_claim(text,text,jsonb,int,int)', 'email_webhook_finish(text,uuid,text,text)', 'email_find_conversation_by_token(uuid,uuid,text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

commit;

-- OWNER NOTES (not executed):
--   * The two foreign keys above are NOT VALID: they protect every new row but did not scan existing rows. After checking that this returns 0 rows
--       select m.id from public.email_messages m join public.email_conversations c on c.id = m.conversation_id
--        where c.organization_id <> m.organization_id or c.account_id <> m.account_id;
--     (and the same idea for conversations vs accounts), you may run:
--       alter table public.email_messages validate constraint email_messages_conversation_org_acc_fk;
--       alter table public.email_conversations validate constraint email_conversations_account_org_fk;
--   * To replay a webhook that reached its retry limit: update public.email_webhook_events set attempts = 0, status = 'failed' where svix_id = '<id>';
-- Rollback (restores nothing destructive; the 20261110 versions of the two functions come from re-running that file's function definitions):
--   alter table public.email_messages drop constraint if exists email_messages_conversation_org_acc_fk;
--   alter table public.email_conversations drop constraint if exists email_conversations_account_org_fk;
--   drop function if exists public.email_webhook_claim(text,text,jsonb,int,int), public.email_webhook_finish(text,uuid,text,text), public.email_find_conversation_by_token(uuid,uuid,text);
--   (the claim columns and the widened status check are harmless to leave in place)
