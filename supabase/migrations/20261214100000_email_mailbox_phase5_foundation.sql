-- KairFlow Email Phase 5 foundation: independent credential vault and durable sync leases.
-- Additive only. Nothing is sent by applying this migration. Does not read, alter, or reuse any intel_* table, token, OAuth state or RPC.
-- Rollback (only before provider accounts are connected): drop the new email_* tables/RPCs, remove the added email_accounts/email_sync_state columns and the email_accounts_id_org_uidx index. No existing messages are deleted.
-- Apply only after reviewing the Phase 4F migrations in timestamp order.
begin;

do $$ begin
  if to_regclass('public.email_accounts') is null
     or to_regclass('public.email_provider_registry') is null
     or to_regclass('public.email_sync_state') is null then
    raise exception 'Email Phase 5 prerequisites missing: apply Email core, provider registry/scoping and Phase 4F migrations first';
  end if;
end $$;

-- Connection lifecycle is separate from account enabled/paused state. Secrets never enter this table.
alter table public.email_accounts
  add column if not exists connection_status text not null default 'not_connected'
    check (connection_status in ('not_connected','connecting','connected','reauthorization_required','disconnected','error')),
  add column if not exists connected_at timestamptz,
  add column if not exists last_validated_at timestamptz,
  add column if not exists last_connection_error text not null default '';

-- Encrypted credential envelope only. The encryption key is held in Edge Function secrets, never in Postgres.
create table if not exists public.email_provider_credentials (
  account_id uuid primary key references public.email_accounts(id) on delete cascade,
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  provider_key text not null references public.email_provider_registry(provider_key) on update restrict on delete restrict,
  key_version smallint not null default 1 check (key_version > 0),
  algorithm text not null check (algorithm = 'A256GCM'),
  nonce text not null,
  ciphertext text not null,
  token_expires_at timestamptz,
  scopes text[] not null default '{}',
  updated_at timestamptz not null default now(),
  unique (account_id, organization_id, provider_key)
);
create index if not exists email_provider_credentials_org_idx on public.email_provider_credentials(organization_id, provider_key);
alter table public.email_provider_credentials enable row level security;
revoke all on public.email_provider_credentials from public, anon, authenticated;
grant all on public.email_provider_credentials to service_role;

-- Single-use, short-lived OAuth state. Only a SHA-256 state hash is stored; PKCE verifier is encrypted.
create table if not exists public.email_oauth_states (
  id uuid primary key default gen_random_uuid(),
  state_hash text not null unique check (state_hash ~ '^[a-f0-9]{64}$'),
  provider_key text not null references public.email_provider_registry(provider_key) on update restrict on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  redirect_uri text not null,
  pkce_nonce text,
  pkce_ciphertext text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  check (expires_at > created_at and expires_at <= created_at + interval '15 minutes')
);
create index if not exists email_oauth_states_expiry_idx on public.email_oauth_states(expires_at) where consumed_at is null;
alter table public.email_oauth_states enable row level security;
revoke all on public.email_oauth_states from public, anon, authenticated;
grant all on public.email_oauth_states to service_role;


-- Atomically consume a short-lived OAuth state exactly once. The callback must still verify the user/org/provider tuple.
create or replace function public.email_consume_oauth_state(p_state_hash text,p_provider text,p_redirect_uri text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare r public.email_oauth_states;
begin
  if coalesce(p_state_hash,'') !~ '^[a-f0-9]{64}$' then return null; end if;
  update public.email_oauth_states set consumed_at=now()
   where state_hash=p_state_hash and provider_key=p_provider and redirect_uri=p_redirect_uri
     and consumed_at is null and expires_at>now()
   returning * into r;
  if not found then return null; end if;
  return jsonb_build_object('user_id',r.user_id,'organization_id',r.organization_id,'provider_key',r.provider_key,
    'redirect_uri',r.redirect_uri,'pkce_nonce',r.pkce_nonce,'pkce_ciphertext',r.pkce_ciphertext);
end $$;
revoke all on function public.email_consume_oauth_state(text,text,text) from public, anon, authenticated;
grant execute on function public.email_consume_oauth_state(text,text,text) to service_role;

-- Extend the existing per-account sync checkpoint with lease and operational health fields.
alter table public.email_sync_state
  add column if not exists last_attempt_at timestamptz,
  add column if not exists last_success_at timestamptz,
  add column if not exists next_retry_at timestamptz,
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  add column if not exists last_page_count integer not null default 0 check (last_page_count >= 0),
  add column if not exists last_message_count integer not null default 0 check (last_message_count >= 0);

create table if not exists public.email_sync_runs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.email_accounts(id) on delete cascade,
  organization_id uuid not null references public.studio_organizations(id) on delete cascade,
  provider_key text not null references public.email_provider_registry(provider_key) on update restrict on delete restrict,
  status text not null check (status in ('running','succeeded','partial','failed','skipped')),
  pages_processed integer not null default 0 check (pages_processed >= 0),
  messages_seen integer not null default 0 check (messages_seen >= 0),
  messages_inserted integer not null default 0 check (messages_inserted >= 0),
  messages_updated integer not null default 0 check (messages_updated >= 0),
  safe_error text not null default '',
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists email_sync_runs_account_idx on public.email_sync_runs(account_id, started_at desc);
alter table public.email_sync_runs enable row level security;
revoke all on public.email_sync_runs from public, anon, authenticated;
grant all on public.email_sync_runs to service_role;

-- Atomically claim a per-account sync lease. Service role only.
create or replace function public.email_claim_sync(p_account_id uuid, p_lease_seconds integer default 180)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare a public.email_accounts; s public.email_sync_state; v_token uuid := gen_random_uuid(); v_lease integer := least(greatest(coalesce(p_lease_seconds,180),30),600);
begin
  select * into a from public.email_accounts where id = p_account_id;
  if not found or a.status <> 'active' then return jsonb_build_object('claimed',false,'reason','account_not_active'); end if;
  if a.connection_status <> 'connected' then return jsonb_build_object('claimed',false,'reason','account_not_connected'); end if;
  insert into public.email_sync_state(account_id,organization_id) values(a.id,a.organization_id)
  on conflict(account_id) do nothing;
  select * into s from public.email_sync_state where account_id = a.id for update;
  if s.next_retry_at is not null and s.next_retry_at > now() then
    return jsonb_build_object('claimed',false,'reason','retry_not_due','retry_at',s.next_retry_at,'checkpoint',s.cursor);
  end if;
  if s.lease_expires_at is not null and s.lease_expires_at > now() then
    return jsonb_build_object('claimed',false,'reason','sync_in_progress','checkpoint',s.cursor);
  end if;
  update public.email_sync_state set lease_token=v_token, lease_expires_at=now()+make_interval(secs=>v_lease),
    last_attempt_at=now(), last_error=''
  where account_id=a.id;
  insert into public.email_sync_runs(account_id,organization_id,provider_key,status) values(a.id,a.organization_id,a.provider,'running');
  return jsonb_build_object('claimed',true,'lease_token',v_token,'checkpoint',s.cursor,'consecutive_failures',s.consecutive_failures);
end $$;
revoke all on function public.email_claim_sync(uuid,integer) from public, anon, authenticated;
grant execute on function public.email_claim_sync(uuid,integer) to service_role;

-- Checkpoint commits only when the caller still owns the live lease.
create or replace function public.email_commit_sync_checkpoint(p_account_id uuid,p_lease_token uuid,p_checkpoint jsonb,p_pages integer default 0,p_messages integer default 0)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
declare n integer;
begin
  update public.email_sync_state set cursor=coalesce(p_checkpoint,'{}'::jsonb), last_error='',
    last_page_count=greatest(coalesce(p_pages,0),0),
    last_message_count=greatest(coalesce(p_messages,0),0)
  where account_id=p_account_id and lease_token=p_lease_token and lease_expires_at > now();
  get diagnostics n = row_count;
  return n=1;
end $$;
revoke all on function public.email_commit_sync_checkpoint(uuid,uuid,jsonb,integer,integer) from public, anon, authenticated;
grant execute on function public.email_commit_sync_checkpoint(uuid,uuid,jsonb,integer,integer) to service_role;


create or replace function public.email_finish_sync(p_account_id uuid,p_lease_token uuid,p_pages integer default 0,p_messages integer default 0,p_inserted integer default 0,p_updated integer default 0,p_partial boolean default false)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
declare n integer; v_run uuid;
begin
  update public.email_sync_state set lease_token=null, lease_expires_at=null, last_success_at=case when not p_partial then now() else last_success_at end,
    last_page_count=greatest(coalesce(p_pages,0),0),last_message_count=greatest(coalesce(p_messages,0),0),
    consecutive_failures=case when not p_partial then 0 else consecutive_failures end, next_retry_at=null
  where account_id=p_account_id and lease_token=p_lease_token and lease_expires_at > now();
  get diagnostics n = row_count;
  if n=1 then
    update public.email_sync_runs set status=case when p_partial then 'partial' else 'succeeded' end,
      pages_processed=greatest(coalesce(p_pages,0),0),messages_seen=greatest(coalesce(p_messages,0),0),
      messages_inserted=greatest(coalesce(p_inserted,0),0),messages_updated=greatest(coalesce(p_updated,0),0),finished_at=now()
    where account_id=p_account_id and status='running' and finished_at is null and started_at=(select max(started_at) from public.email_sync_runs where account_id=p_account_id and status='running');
  end if;
  return n=1;
end $$;
revoke all on function public.email_finish_sync(uuid,uuid,integer,integer,integer,integer,boolean) from public, anon, authenticated;
grant execute on function public.email_finish_sync(uuid,uuid,integer,integer,integer,integer,boolean) to service_role;

-- Backward-compatible service-only wrapper for existing operational SQL callers.
create or replace function public.email_finish_sync(p_account_id uuid,p_lease_token uuid) returns boolean
language sql security definer set search_path = pg_catalog, public as $$
  select public.email_finish_sync(p_account_id,p_lease_token,0,0,0,0,false)
$$;
revoke all on function public.email_finish_sync(uuid,uuid) from public, anon, authenticated;
grant execute on function public.email_finish_sync(uuid,uuid) to service_role;

create or replace function public.email_fail_sync(p_account_id uuid,p_lease_token uuid,p_safe_error text,p_retry_at timestamptz)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
declare n integer;
begin
  update public.email_sync_state set last_error=left(coalesce(p_safe_error,'Mailbox synchronization failed'),500),
    consecutive_failures=consecutive_failures+1, next_retry_at=greatest(coalesce(p_retry_at,now()+make_interval(secs=>least(21600,60 * power(2,least(consecutive_failures,8))::integer))),now()),
    lease_token=null, lease_expires_at=null
  where account_id=p_account_id and lease_token=p_lease_token;
  get diagnostics n = row_count;
  if n=1 then update public.email_sync_runs set status='failed',safe_error=left(coalesce(p_safe_error,''),500),finished_at=now()
    where account_id=p_account_id and status='running' and started_at=(select max(started_at) from public.email_sync_runs where account_id=p_account_id and status='running'); end if;
  return n=1;
end $$;
revoke all on function public.email_fail_sync(uuid,uuid,text,timestamptz) from public, anon, authenticated;
grant execute on function public.email_fail_sync(uuid,uuid,text,timestamptz) to service_role;



-- Provider thread identity is account-scoped. It is not interchangeable with RFC Message-ID.
alter table public.email_conversations add column if not exists provider_thread_id text;
create unique index if not exists email_conversations_provider_thread_uidx
  on public.email_conversations(account_id, provider_thread_id) where provider_thread_id is not null;

create or replace function public.email_get_or_create_synced_conversation(
  p_organization_id uuid,p_account_id uuid,p_provider text,p_provider_thread_id text,p_subject text,p_normalized_subject text
) returns uuid language plpgsql security definer set search_path = pg_catalog, public as $$
declare a public.email_accounts; v_id uuid;
begin
  if nullif(btrim(coalesce(p_provider_thread_id,'')),'') is null or length(p_provider_thread_id)>500 then raise exception 'Provider thread id is invalid'; end if;
  select * into a from public.email_accounts where id=p_account_id and organization_id=p_organization_id and provider=p_provider and status='active';
  if not found then raise exception 'Mailbox account is not authorized' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtext(p_account_id::text),hashtext(p_provider||':'||p_provider_thread_id));
  select id into v_id from public.email_conversations where account_id=p_account_id and provider_thread_id=p_provider_thread_id;
  if v_id is not null then return v_id; end if;
  insert into public.email_conversations(organization_id,account_id,provider_thread_id,subject,normalized_subject)
  values(p_organization_id,p_account_id,left(coalesce(p_subject,''),998),left(coalesce(p_normalized_subject,''),998))
  on conflict(account_id,provider_thread_id) where provider_thread_id is not null do update
    set subject=case when public.email_conversations.subject='' then excluded.subject else public.email_conversations.subject end
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.email_get_or_create_synced_conversation(uuid,uuid,text,text,text,text) from public, anon, authenticated;
grant execute on function public.email_get_or_create_synced_conversation(uuid,uuid,text,text,text,text) to service_role;

-- Bind credential rows to both the account identity and its immutable provider/organization.
create unique index if not exists email_accounts_id_org_uidx on public.email_accounts(id, organization_id);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'email_provider_credentials_account_provider_fk') then
    alter table public.email_provider_credentials add constraint email_provider_credentials_account_provider_fk
      foreign key (account_id, provider_key) references public.email_accounts(id, provider) on delete cascade not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'email_provider_credentials_account_org_fk') then
    alter table public.email_provider_credentials add constraint email_provider_credentials_account_org_fk
      foreign key (account_id, organization_id) references public.email_accounts(id, organization_id) on delete cascade not valid;
  end if;
end $$;

-- Import provider-synced outbound messages without invoking any send endpoint.
-- This is intentionally a persistence-only RPC; it cannot cause an email to be sent.
create or replace function public.email_ingest_synced_outbound(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid; v_acc uuid; v_pmid text; v_rfc text; v_provider text; v_conv uuid; v_msg uuid; v_existing uuid;
  a public.email_accounts; part jsonb; att jsonb; v_addr text; v_subject text;
begin
  begin
    v_org := (p ->> 'organization_id')::uuid;
    v_acc := (p ->> 'account_id')::uuid;
  exception when others then
    raise exception 'Invalid synchronized message payload' using errcode = '22023';
  end;
  v_pmid := nullif(btrim(coalesce(p ->> 'provider_message_id','')), '');
  v_rfc := nullif(btrim(coalesce(p ->> 'rfc_message_id','')), '');
  v_provider := lower(coalesce(nullif(btrim(coalesce(p ->> 'provider','')),''),'resend'));
  if v_org is null or v_acc is null or v_pmid is null then raise exception 'Invalid synchronized message payload' using errcode='22023'; end if;
  select * into a from public.email_accounts where id=v_acc;
  if not found or a.organization_id<>v_org or a.provider<>v_provider or a.status<>'active' then
    raise exception 'Synchronized message account is not authorized' using errcode='42501';
  end if;
  select id into v_existing from public.email_messages where account_id=v_acc and direction='outbound'
    and (provider_message_id=v_pmid or (v_rfc is not null and rfc_message_id=v_rfc)) limit 1;
  if v_existing is not null then
    update public.email_messages set rfc_message_id=coalesce(v_rfc,rfc_message_id),in_reply_to=nullif(p ->> 'in_reply_to',''),
      references_ids=nullif(p ->> 'references_ids',''),from_email=lower(coalesce(p ->> 'from_email',from_email)),
      from_name=left(coalesce(p ->> 'from_name',from_name),200),to_emails=coalesce(array(select jsonb_array_elements_text(p -> 'to_emails')),to_emails),
      cc_emails=coalesce(array(select jsonb_array_elements_text(p -> 'cc_emails')),cc_emails),bcc_emails=coalesce(array(select jsonb_array_elements_text(p -> 'bcc_emails')),bcc_emails),
      reply_to=left(coalesce(p ->> 'reply_to',reply_to),500),subject=left(coalesce(p ->> 'subject',subject),998),
      body_text=left(coalesce(p ->> 'body_text',body_text),400000),body_html=left(coalesce(p ->> 'body_html',body_html),800000),
      headers=coalesce(p -> 'headers',headers),sent_at=coalesce((p ->> 'sent_at')::timestamptz,sent_at)
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

  v_conv := nullif(p ->> 'conversation_id','')::uuid;
  if v_conv is not null and not exists(select 1 from public.email_conversations where id=v_conv and organization_id=v_org and account_id=v_acc) then
    raise exception 'Conversation belongs to a different account' using errcode='42501';
  end if;
  v_subject := left(coalesce(p ->> 'subject',''),998);
  if v_conv is null then
    insert into public.email_conversations(organization_id,account_id,subject,normalized_subject)
    values(v_org,v_acc,v_subject,coalesce(p ->> 'normalized_subject','')) returning id into v_conv;
  end if;
  begin
    insert into public.email_messages(organization_id,conversation_id,account_id,direction,provider_message_id,rfc_message_id,in_reply_to,references_ids,
      from_email,from_name,to_emails,cc_emails,bcc_emails,reply_to,subject,body_text,body_html,status,is_read,headers,sent_at)
    values(v_org,v_conv,v_acc,'outbound',v_pmid,v_rfc,nullif(p ->> 'in_reply_to',''),nullif(p ->> 'references_ids',''),
      lower(coalesce(p ->> 'from_email',a.address)),left(coalesce(p ->> 'from_name',a.display_name),200),
      coalesce(array(select jsonb_array_elements_text(p -> 'to_emails')),'{}'),
      coalesce(array(select jsonb_array_elements_text(p -> 'cc_emails')),'{}'),
      coalesce(array(select jsonb_array_elements_text(p -> 'bcc_emails')),'{}'),left(coalesce(p ->> 'reply_to',''),500),
      v_subject,left(coalesce(p ->> 'body_text',''),400000),left(coalesce(p ->> 'body_html',''),800000),'sent',coalesce((p ->> 'is_read')::boolean,true),
      coalesce(p -> 'headers','{}'::jsonb),coalesce((p ->> 'sent_at')::timestamptz,now())) returning id into v_msg;
  exception when unique_violation then
    select id into v_existing from public.email_messages where account_id=v_acc and direction='outbound'
      and (provider_message_id=v_pmid or (v_rfc is not null and rfc_message_id=v_rfc)) limit 1;
    if v_existing is null then raise; end if;
    return jsonb_build_object('duplicate',true,'message_id',v_existing);
  end;
  insert into public.email_participants(organization_id,conversation_id,email,name)
  values(v_org,v_conv,a.address,a.display_name) on conflict(conversation_id,email) do nothing;
  for part in select * from jsonb_array_elements(coalesce(p -> 'participants','[]'::jsonb)) loop
    v_addr := lower(btrim(coalesce(part ->> 'email','')));
    if v_addr<>'' then
      insert into public.email_participants(organization_id,conversation_id,email,name)
      values(v_org,v_conv,v_addr,left(coalesce(part ->> 'name',''),200))
      on conflict(conversation_id,email) do update set name=case when public.email_participants.name='' then excluded.name else public.email_participants.name end;
    end if;
  end loop;
  for att in select * from jsonb_array_elements(coalesce(p -> 'attachments','[]'::jsonb)) loop
    insert into public.email_attachments(organization_id,message_id,provider_attachment_id,filename,content_type,size_bytes,content_id,is_inline,storage_path)
    values(v_org,v_msg,att ->> 'provider_attachment_id',left(coalesce(att ->> 'filename','attachment'),300),coalesce(att ->> 'content_type','application/octet-stream'),
      greatest(coalesce((att ->> 'size_bytes')::bigint,0),0),nullif(att ->> 'content_id',''),coalesce((att ->> 'is_inline')::boolean,false),nullif(att ->> 'storage_path',''))
    on conflict do nothing;
  end loop;
  insert into public.email_events(organization_id,message_id,event_type,detail)
  values(v_org,v_msg,'mailbox_sync_imported',jsonb_build_object('provider',v_provider));
  return jsonb_build_object('duplicate',false,'message_id',v_msg,'conversation_id',v_conv);
end $$;
revoke all on function public.email_ingest_synced_outbound(jsonb) from public, anon, authenticated;
grant execute on function public.email_ingest_synced_outbound(jsonb) to service_role;

commit;
