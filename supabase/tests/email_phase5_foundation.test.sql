-- Phase 5 foundation: encrypted general Email credentials, OAuth state isolation, thread identity and sync lease semantics.
-- Run after 20261214100000_email_mailbox_phase5_foundation.sql using the same fixtures as email_provider_foundation.test.sql.
do $$
declare
  ADMIN uuid := '00000000-0000-0000-0000-0000000000e1';
  orgA uuid := '20000000-0000-0000-0000-00000000000a';
  acc uuid; r jsonb; lease1 uuid; lease2 uuid; conv1 uuid; conv2 uuid; out1 jsonb; out2 jsonb;
begin
  perform ti.as_super();
  perform ti.ok(to_regclass('public.email_provider_credentials') is not null, 'general Email encrypted credential table exists');
  perform ti.ok(to_regclass('public.email_oauth_states') is not null, 'general Email OAuth state table exists');
  perform ti.ok((select relrowsecurity from pg_class where oid='public.email_provider_credentials'::regclass), 'credential table has RLS enabled');
  perform ti.ok((select relrowsecurity from pg_class where oid='public.email_oauth_states'::regclass), 'OAuth state table has RLS enabled');
  perform ti.ok(to_regprocedure('public.email_consume_oauth_state(text,text,text)') is not null, 'single-use OAuth state consume RPC exists');
  perform ti.ok(to_regprocedure('public.email_claim_sync(uuid,integer)') is not null, 'sync lease claim RPC exists');
  perform ti.ok(to_regprocedure('public.email_commit_sync_checkpoint(uuid,uuid,jsonb,integer,integer)') is not null, 'checkpoint commit RPC exists');
  perform ti.ok(to_regprocedure('public.email_finish_sync(uuid,uuid)') is not null, 'sync finish RPC exists');
  perform ti.ok(to_regprocedure('public.email_get_or_create_synced_conversation(uuid,uuid,text,text,text,text)') is not null, 'provider thread resolver exists');
  perform ti.ok(to_regprocedure('public.email_ingest_synced_outbound(jsonb)') is not null, 'outbound sync import RPC exists');

  perform ti.as_user(ADMIN);
  r := public.email_upsert_account('phase5@studiokairegi.com','Phase 5','resend');
  acc := (r ->> 'id')::uuid;
  perform ti.throws(format($q$select count(*) from public.email_provider_credentials where account_id=%L$q$,acc), 'permission denied', 'authenticated users cannot read encrypted credentials');
  perform ti.throws($q$select count(*) from public.email_oauth_states$q$, 'permission denied', 'authenticated users cannot read OAuth state');

  perform ti.as_super();
  update public.email_accounts set connection_status='connected',connected_at=now() where id=acc;
  insert into public.email_oauth_states(state_hash,provider_key,user_id,organization_id,redirect_uri,expires_at)
  values(repeat('a',64),'resend',ADMIN,orgA,'https://app.example.com/email/callback',now()+interval '10 minutes');
  r := public.email_consume_oauth_state(repeat('a',64),'resend','https://app.example.com/email/callback');
  perform ti.ok(r ->> 'user_id'=ADMIN::text and r ->> 'organization_id'=orgA::text, 'valid OAuth state returns its bound user and organization once');
  perform ti.ok(public.email_consume_oauth_state(repeat('a',64),'resend','https://app.example.com/email/callback') is null, 'OAuth state cannot be consumed twice');

  insert into public.email_provider_credentials(account_id,organization_id,provider_key,algorithm,nonce,ciphertext)
  values(acc,orgA,'resend','A256GCM','bm9uY2U=','Y2lwaGVydGV4dA==');
  perform ti.ok((select count(*)=1 from public.email_provider_credentials where account_id=acc), 'service role can persist an encrypted envelope');
  perform ti.throws(format($q$insert into public.email_provider_credentials(account_id,organization_id,provider_key,algorithm,nonce,ciphertext) values (%L,%L,'gmail','A256GCM','n','c')$q$,acc,orgA), 'foreign key', 'credentials cannot be attached to a different provider');

  r := public.email_claim_sync(acc,180);
  perform ti.ok((r ->> 'claimed')::boolean, 'first sync worker claims the mailbox lease');
  lease1 := (r ->> 'lease_token')::uuid;
  r := public.email_claim_sync(acc,180);
  perform ti.ok(not (r ->> 'claimed')::boolean and r ->> 'reason'='sync_in_progress', 'concurrent worker cannot claim an active lease');
  perform ti.ok(public.email_commit_sync_checkpoint(acc,lease1,jsonb_build_object('history_id','42'),1,3), 'checkpoint is committed by the lease owner');
  perform ti.ok(public.email_finish_sync(acc,lease1), 'first sync releases its lease after committing its checkpoint');
  r := public.email_claim_sync(acc,180);
  perform ti.ok((r ->> 'claimed')::boolean and r -> 'checkpoint' ->> 'history_id'='42', 'next run resumes from the committed checkpoint');
  lease2 := (r ->> 'lease_token')::uuid;
  perform ti.ok(public.email_finish_sync(acc,lease2), 'successful sync releases its lease');
  perform ti.ok(not public.email_finish_sync(acc,lease2), 'a released lease cannot be released twice');

  conv1 := public.email_get_or_create_synced_conversation(orgA,acc,'resend','thread-abc','Client thread','client thread');
  conv2 := public.email_get_or_create_synced_conversation(orgA,acc,'resend','thread-abc','Client thread','client thread');
  perform ti.ok(conv1=conv2, 'provider thread id maps to one account-scoped conversation');
  perform ti.ok((select provider_thread_id='thread-abc' from public.email_conversations where id=conv1), 'provider thread identity is stored separately from RFC Message-ID');

  out1 := public.email_ingest_synced_outbound(jsonb_build_object(
    'organization_id',orgA,'account_id',acc,'provider','resend','conversation_id',conv1,
    'provider_message_id','phase5-out-1','rfc_message_id','<phase5-out-1@example.com>',
    'from_email','phase5@studiokairegi.com','to_emails',jsonb_build_array('client@example.com'),
    'subject','Client update','body_text','Update','sent_at',now()));
  out2 := public.email_ingest_synced_outbound(jsonb_build_object(
    'organization_id',orgA,'account_id',acc,'provider','resend','conversation_id',conv1,
    'provider_message_id','phase5-out-1','rfc_message_id','<phase5-out-1@example.com>',
    'from_email','phase5@studiokairegi.com','to_emails',jsonb_build_array('client@example.com'),
    'subject','Client update','body_text','Update','sent_at',now()));
  perform ti.ok(not (out1 ->> 'duplicate')::boolean and (out2 ->> 'duplicate')::boolean, 'outbound sync import is idempotent and never sends mail');
  perform ti.ok((select direction='outbound' and status='sent' and provider='resend' from public.email_messages where id=(out1 ->> 'message_id')::uuid), 'synced outbound message is normalized into shared message model');

  delete from public.email_accounts where id=acc;
  delete from public.email_oauth_states where state_hash=repeat('a',64);
  perform ti.ok(not exists(select 1 from public.email_provider_credentials where account_id=acc), 'deleting an account cascades its encrypted credentials');
  raise notice 'PASS email_phase5_foundation.test.sql complete';
end $$;
