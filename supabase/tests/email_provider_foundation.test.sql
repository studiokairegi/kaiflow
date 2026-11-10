-- Multi-provider Email, PHASE 2 (migrations 20261204090000 + 20261204100000), against real Postgres.
-- Run by run_intelligence_auth.sh after email_resend.test.sql and email_resend_hardening.test.sql; reuses the Intelligence fixture:
-- ADMIN ...e1 (admin + Master of orgA), MASTER ...e2 (Master only), AGENT ...f0 (registered agent), orgA ...0a, orgB ...0b.
-- NOT EXECUTED where this file was written (no PostgreSQL available there): run it before trusting the migrations.
-- It adds ONE throw-away registry row ('testprov') to prove that a second provider works through the same tables, and removes it at the end.
do $$
declare
  ADMIN uuid := '00000000-0000-0000-0000-0000000000e1'; MASTER uuid := '00000000-0000-0000-0000-0000000000e2'; AGENT uuid := '00000000-0000-0000-0000-0000000000f0';
  orgA uuid := '20000000-0000-0000-0000-00000000000a'; orgB uuid := '20000000-0000-0000-0000-00000000000b';
  accR uuid; accT uuid; accB uuid; convR uuid; convT uuid; msgR uuid; msgT uuid; draftR uuid;
  r jsonb; d jsonb; n int;
  payload constant jsonb := jsonb_build_object('from_email', 'ada@client.com', 'subject', 'Hi', 'body_text', 'Hello', 'received_at', now());
begin
  -- 1. registry -----------------------------------------------------------------------------------------------------------------------
  perform ti.as_super();
  perform ti.ok((select count(*) = 1 and bool_and(provider_key = 'resend' and enabled) from public.email_provider_registry), 'the registry holds Resend only, enabled');
  perform ti.ok(not exists (select 1 from public.email_provider_registry where provider_key in ('gmail', 'zoho')), 'Gmail and Zoho are not registry providers');
  perform ti.ok((select count(*) = 2 and not bool_or(enabled) from public.email_provider_flags where provider in ('gmail', 'zoho')), 'the Intelligence-owned Gmail/Zoho flag rows are untouched and still off');
  perform ti.ok(public.email_provider_enabled('resend') and not public.email_provider_enabled('gmail'), 'email_provider_enabled still answers as before');
  perform ti.as_user(ADMIN);
  perform ti.ok(public.email_provider_flags_get() = jsonb_build_object('resend', true), 'the browser reads the registry list, not the Gmail/Zoho flags');
  perform ti.ok(jsonb_array_length(public.email_provider_registry_list()) = 1 and (public.email_provider_registry_list() -> 0 ->> 'provider_key') = 'resend', 'registry list for the admin');
  perform ti.ok((public.email_provider_registry_list() -> 0 -> 'capabilities' ->> 'remote_sync')::boolean = false, 'capabilities are explicit: Resend has no remote sync');
  perform ti.throws($q$update public.email_provider_registry set enabled = false$q$, 'permission denied', 'no client can write the registry');
  perform ti.throws($q$insert into public.email_provider_registry (provider_key, adapter_key, display_name) values ('x1', 'x1', 'X')$q$, 'permission denied', 'no client can add a provider');
  perform ti.as_user(MASTER);
  perform ti.throws($q$select public.email_provider_registry_list()$q$, 'restricted', 'a Master User who is not admin cannot read the registry list');
  perform ti.ok((select count(*) = 0 from public.email_provider_registry), 'row-level security hides the registry from a non-admin Master User');
  perform ti.as_user(AGENT);
  perform ti.ok((select count(*) = 0 from public.email_provider_registry), 'and from the agent identity');

  -- 2. accounts: explicit provider, per-provider uniqueness ---------------------------------------------------------------------------------
  perform ti.as_super();
  insert into public.email_provider_registry (provider_key, adapter_key, display_name, capabilities, enabled) values ('testprov', 'testprov', 'Test Provider', '{}'::jsonb, true);
  perform ti.as_user(ADMIN);
  r := public.email_upsert_account('Found-A@StudioKairegi.com', 'Found A');
  accR := (r ->> 'id')::uuid;
  perform ti.ok(r ->> 'provider' = 'resend' and r ->> 'address' = 'found-a@studiokairegi.com', 'an account without a provider argument is a Resend account, stored explicitly');
  perform ti.ok((public.email_upsert_account('found-a@studiokairegi.com', 'Renamed') ->> 'id')::uuid = accR and (select count(*) = 1 from public.email_accounts where address = 'found-a@studiokairegi.com'), 'the same address through the same provider is one account');
  perform ti.throws($q$select public.email_upsert_account('x@studiokairegi.com', '', 'gmail')$q$, 'Unknown or disabled', 'Gmail cannot be chosen: it is not a registry provider');
  perform ti.throws($q$select public.email_upsert_account('x@studiokairegi.com', '', 'nonsense')$q$, 'Unknown or disabled', 'an unknown provider is refused by the server');
  perform ti.throws($q$select public.email_upsert_account('x@studiokairegi.com', '', '')$q$, 'Unknown or disabled', 'an empty provider is refused (no silent default from an empty string)');
  r := public.email_upsert_account('found-a@studiokairegi.com', 'Found A via test', 'testprov');
  accT := (r ->> 'id')::uuid;
  perform ti.ok(accT <> accR and r ->> 'provider' = 'testprov', 'the SAME address can be connected through a second provider as a separate account');
  perform ti.ok((select count(*) = 2 from public.email_accounts where address = 'found-a@studiokairegi.com'), 'two accounts, one per provider');
  perform ti.as_super();
  perform ti.throws(format($q$insert into public.email_accounts (organization_id, provider, address) values (%L, 'testprov', 'found-a@studiokairegi.com')$q$, orgA),
                    'duplicate key', 'the same provider cannot hold the same address twice');
  perform ti.throws(format($q$insert into public.email_accounts (organization_id, provider, address) values (%L, 'gmail', 'g@studiokairegi.com')$q$, orgA),
                    'foreign key', 'a direct insert with an unregistered provider is refused');
  perform ti.throws(format($q$update public.email_accounts set provider = 'testprov' where id = %L$q$, accR), 'cannot change organization or provider', 'an account cannot change provider');
  perform ti.throws(format($q$update public.email_accounts set organization_id = %L where id = %L$q$, orgB, accR), 'cannot change organization or provider', 'an account cannot change organization');
  insert into public.email_accounts (organization_id, provider, address, display_name) values (orgB, 'resend', 'found-b@studiokairegi.com', 'B') returning id into accB;

  -- 3. messages carry their account's provider ----------------------------------------------------------------------------------------------
  insert into public.email_conversations (organization_id, account_id, subject) values (orgA, accR, 'R thread') returning id into convR;
  insert into public.email_conversations (organization_id, account_id, subject) values (orgA, accT, 'T thread') returning id into convT;
  insert into public.email_messages (organization_id, conversation_id, account_id, direction, status) values (orgA, convR, accR, 'inbound', 'received') returning id into msgR;
  insert into public.email_messages (organization_id, conversation_id, account_id, direction, status) values (orgA, convT, accT, 'inbound', 'received') returning id into msgT;
  perform ti.ok((select provider = 'resend' from public.email_messages where id = msgR) and (select provider = 'testprov' from public.email_messages where id = msgT), 'an omitted provider is filled from the account');
  perform ti.throws(format($q$insert into public.email_messages (organization_id, conversation_id, account_id, direction, provider, status) values (%L, %L, %L, 'inbound', 'resend', 'received')$q$, orgA, convT, accT),
                    'must use the provider of its account', 'a stated provider that differs from the account is refused');
  perform ti.throws(format($q$update public.email_messages set provider = 'testprov' where id = %L$q$, msgR), 'cannot move', 'a message cannot change provider');
  perform ti.throws(format($q$update public.email_messages set account_id = %L where id = %L$q$, accT, msgR), 'cannot move', 'a message cannot change account');
  perform ti.throws(format($q$update public.email_messages set conversation_id = %L where id = %L$q$, convT, msgR), 'cannot move', 'a message cannot change conversation');
  perform ti.throws(format($q$update public.email_conversations set account_id = %L where id = %L$q$, accT, convR), 'cannot move', 'a conversation cannot change account');
  perform ti.ok((select count(*) = 0 from public.email_messages m join public.email_accounts a on a.id = m.account_id where m.provider <> a.provider), 'no message anywhere disagrees with its account');

  -- 4. deduplication is per account; provider ids are not globally unique -------------------------------------------------------------------------
  perform ti.throws(format($q$select public.email_ingest_inbound(%L::jsonb)$q$, (payload || jsonb_build_object('organization_id', orgA, 'account_id', accT, 'provider_message_id', 'f_1'))::text),
                    'not a Resend account', 'an account of another provider is refused when the expected provider is Resend');
  perform ti.throws(format($q$select public.email_ingest_inbound(%L::jsonb)$q$, (payload || jsonb_build_object('organization_id', orgA, 'account_id', accR, 'provider', 'testprov', 'provider_message_id', 'f_1'))::text),
                    'not a Test Provider account', 'and the other way round');
  r := public.email_ingest_inbound(payload || jsonb_build_object('organization_id', orgA, 'account_id', accR, 'provider_message_id', 'same_id', 'rfc_message_id', '<same@x>'));
  perform ti.ok(not (r ->> 'duplicate')::boolean, 'Resend account: first message with this provider id is stored');
  r := public.email_ingest_inbound(payload || jsonb_build_object('organization_id', orgA, 'account_id', accT, 'provider', 'testprov', 'provider_message_id', 'same_id', 'rfc_message_id', '<same@x>'));
  perform ti.ok(not (r ->> 'duplicate')::boolean, 'second provider, same organization, SAME provider id and RFC id: a separate message, not a duplicate');
  perform ti.ok((select count(*) = 2 from public.email_messages where provider_message_id = 'same_id'), 'two rows, one per account');
  r := public.email_ingest_inbound(payload || jsonb_build_object('organization_id', orgA, 'account_id', accR, 'provider_message_id', 'same_id', 'rfc_message_id', '<same@x>'));
  perform ti.ok((r ->> 'duplicate')::boolean, 'the same message again for the same account is still a duplicate');
  r := public.email_ingest_inbound(payload || jsonb_build_object('organization_id', orgA, 'account_id', accR, 'provider_message_id', 'same_id_2', 'rfc_message_id', '<same@x>'));
  perform ti.ok((r ->> 'duplicate')::boolean, 'the same RFC Message-ID under another provider id is still a duplicate for that account');
  perform ti.throws(format($q$insert into public.email_messages (organization_id, conversation_id, account_id, direction, provider_message_id, status) values (%L, %L, %L, 'inbound', 'same_id', 'received')$q$, orgA, convR, accR),
                    'duplicate key', 'the database itself refuses a second row for the same account + direction + provider id');

  -- 5. drafts and outbound are never silently re-identified --------------------------------------------------------------------------------------------
  perform ti.as_user(ADMIN);
  d := public.email_save_draft(null, null, accR, array['new@client.com'], '{}', '{}', 'Hello', 'Draft body', '');
  draftR := (d ->> 'draft_id')::uuid;
  perform ti.throws(format($q$select public.email_save_draft(%L, null, %L, array['new@client.com'], '{}', '{}', 's', 'b', '')$q$, draftR, accT),
                    'different sender account', 'saving an existing draft under another account is refused');
  perform ti.ok((select account_id = accR and provider = 'resend' and from_email = 'found-a@studiokairegi.com' and subject = 'Hello' from public.email_messages where id = draftR), 'the refused save changed nothing about the draft');
  perform ti.throws(format($q$select public.email_save_draft(null, %L, %L, array['n@client.com'], '{}', '{}', 's', 'b', '')$q$, convR, accT),
                    'conversation belongs to a different sender account', 'a new draft cannot be placed in another account''s conversation');
  perform ti.throws(format($q$select public.email_save_draft(null, %L, %L, array['n@client.com'], '{}', '{}', 's', 'b', '')$q$, convR, accB),
                    'Sender address not found', 'an account of another organization is not found');
  perform ti.as_super();
  perform ti.throws(format($q$select public.email_create_outbound(%L::jsonb)$q$, jsonb_build_object('organization_id', orgA, 'account_id', accT, 'draft_id', draftR, 'to_emails', jsonb_build_array('a@b.co'), 'subject', 's', 'body_text', 'b')::text),
                    'different sender account', 'sending a draft under another account is refused');
  perform ti.throws(format($q$select public.email_create_outbound(%L::jsonb)$q$, jsonb_build_object('organization_id', orgA, 'account_id', accT, 'conversation_id', convR, 'to_emails', jsonb_build_array('a@b.co'), 'subject', 's', 'body_text', 'b')::text),
                    'conversation belongs to a different sender account', 'sending into another account''s conversation is refused');
  perform ti.ok((select status = 'draft' and account_id = accR from public.email_messages where id = draftR), 'the refused sends left the draft as it was');
  r := public.email_create_outbound(jsonb_build_object('organization_id', orgA, 'account_id', accR, 'draft_id', draftR, 'idempotency_key', 'found-key-1', 'to_emails', jsonb_build_array('a@b.co'), 'subject', 'Hello', 'body_text', 'Draft body'));
  perform ti.ok(not (r ->> 'duplicate')::boolean and r ->> 'status' = 'queued' and (select account_id = accR and provider = 'resend' from public.email_messages where id = draftR), 'the same account can still send its own draft');
  r := public.email_create_outbound(jsonb_build_object('organization_id', orgA, 'account_id', accT, 'idempotency_key', 'found-key-2', 'to_emails', jsonb_build_array('a@b.co'), 'subject', 'T', 'body_text', 'T'));
  perform ti.ok((select provider = 'testprov' and account_id = accT from public.email_messages where id = (r ->> 'message_id')::uuid), 'an outbound message under the second provider''s account carries that provider');

  -- 6. Intelligence AI drafts still work and carry the account's provider (that function was not edited) -------------------------------------------
  perform ti.as_user(AGENT);
  d := public.intel_agent_email_save_draft(convR, 'Re: R thread', 'Suggested reply');
  perform ti.as_super();
  perform ti.ok((select status = 'draft' and ai_generated and provider = 'resend' and account_id = accR from public.email_messages where id = (d ->> 'draft_id')::uuid), 'an AI draft in a Resend conversation is a Resend draft');
  perform ti.as_user(AGENT);
  d := public.intel_agent_email_save_draft(convT, 'Re: T thread', 'Suggested reply');
  perform ti.as_super();
  perform ti.ok((select status = 'draft' and ai_generated and provider = 'testprov' and account_id = accT from public.email_messages where id = (d ->> 'draft_id')::uuid), 'an AI draft in another provider''s conversation takes that provider from the account');

  -- cleanup: this file's own rows only ----------------------------------------------------------------------------------------------------------------
  delete from public.email_accounts where id in (accR, accT, accB);
  delete from public.email_provider_registry where provider_key = 'testprov';
  perform ti.ok((select count(*) = 1 from public.email_provider_registry), 'cleanup left only the Resend registry row');
  raise notice 'PASS email_provider_foundation.test.sql complete';
end $$;
