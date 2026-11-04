-- Hardening migration 20261111090000, against real Postgres. Run by run_intelligence_auth.sh after email_resend.test.sql.
-- Reuses the Intelligence fixture: orgA ...0a (ADMIN ...e1 is its admin Master), orgB ...0b (a different studio).
-- NOT EXECUTED where this file was written (no PostgreSQL available there): run it before trusting the migration.
-- Real concurrency (two sessions claiming at once) cannot be shown inside one session: see docs/RESEND_EMAIL_SETUP.md "Concurrency check".
do $$
declare
  ADMIN uuid := '00000000-0000-0000-0000-0000000000e1';
  orgA uuid := '20000000-0000-0000-0000-00000000000a'; orgB uuid := '20000000-0000-0000-0000-00000000000b';
  accA uuid := '31000000-0000-0000-0000-0000000000a1'; accA2 uuid := '31000000-0000-0000-0000-0000000000a2'; accP uuid := '31000000-0000-0000-0000-0000000000a3';
  accB uuid := '31000000-0000-0000-0000-0000000000b1';
  cA uuid := '32000000-0000-0000-0000-0000000000a1'; cA2 uuid := '32000000-0000-0000-0000-0000000000a2'; cB uuid := '32000000-0000-0000-0000-0000000000b1';
  r jsonb; tok uuid; tok2 uuid; n int; mid uuid;
  payload constant jsonb := jsonb_build_object('from_email', 'ada@client.com', 'subject', 'Hi', 'body_text', 'Hello', 'received_at', now());
begin
  perform ti.as_super();
  insert into public.email_accounts (id, organization_id, address, display_name, is_default) values
    (accA, orgA, 'hard-a@studiokairegi.com', 'A', false), (accA2, orgA, 'hard-a2@studiokairegi.com', 'A2', false), (accB, orgB, 'hard-b@studiokairegi.com', 'B', false);
  insert into public.email_accounts (id, organization_id, address, display_name, is_default, status) values (accP, orgA, 'hard-paused@studiokairegi.com', 'P', false, 'paused');
  insert into public.email_conversations (id, organization_id, account_id, subject) values (cA, orgA, accA, 'A thread'), (cA2, orgA, accA2, 'A2 thread'), (cB, orgB, accB, 'B thread');

  -- 1. ownership is validated inside the database -------------------------------------------------------------------------------
  perform ti.throws(format($q$select public.email_ingest_inbound(%L::jsonb)$q$, (payload || jsonb_build_object('organization_id', orgB, 'account_id', accA, 'provider_message_id', 'h1'))::text),
                    'does not belong to this organization', 'an account of organization A cannot receive mail as organization B');
  perform ti.throws(format($q$select public.email_ingest_inbound(%L::jsonb)$q$, (payload || jsonb_build_object('organization_id', orgA, 'account_id', '99999999-9999-9999-9999-999999999999', 'provider_message_id', 'h2'))::text),
                    'does not belong to this organization', 'an unknown account is refused');
  perform ti.throws(format($q$select public.email_ingest_inbound(%L::jsonb)$q$, (payload || jsonb_build_object('organization_id', orgA, 'account_id', accP, 'provider_message_id', 'h3'))::text),
                    'not active', 'an inactive account cannot receive mail');
  perform ti.throws(format($q$select public.email_ingest_inbound(%L::jsonb)$q$, (payload || jsonb_build_object('organization_id', orgA, 'account_id', accA))::text),
                    'Invalid inbound payload', 'a payload without a provider message id is refused');
  perform ti.throws(format($q$select public.email_ingest_inbound(%L::jsonb)$q$, jsonb_build_object('organization_id', 'nope', 'account_id', accA, 'provider_message_id', 'h4')::text),
                    'Invalid inbound payload', 'malformed ids are refused');
  perform ti.throws(format($q$select public.email_ingest_inbound(%L::jsonb)$q$, (payload || jsonb_build_object('organization_id', orgA, 'account_id', accA, 'conversation_id', cB, 'provider_message_id', 'h5'))::text),
                    'Conversation does not belong to this organization', 'a conversation of organization B cannot be used under organization A');
  perform ti.throws(format($q$select public.email_ingest_inbound(%L::jsonb)$q$, (payload || jsonb_build_object('organization_id', orgA, 'account_id', accA, 'conversation_id', cA2, 'provider_message_id', 'h6'))::text),
                    'different sender address', 'a conversation of another account cannot be used');
  perform ti.throws(format($q$select public.email_ingest_inbound(%L::jsonb)$q$, (payload || jsonb_build_object('organization_id', orgA, 'account_id', accA, 'conversation_id', '99999999-9999-9999-9999-999999999999', 'provider_message_id', 'h7'))::text),
                    'Conversation does not belong', 'an unknown conversation id raises instead of silently creating another conversation');
  perform ti.ok((select count(*) from public.email_messages where provider_message_id in ('h1','h2','h3','h4','h5','h6','h7')) = 0
                and not exists (select 1 from public.email_conversations where subject = 'Hi' and organization_id in (orgA, orgB))
                and not exists (select 1 from public.email_sync_state where account_id in (accP, accB)), 'a refused ingest leaves no message, conversation, participant or sync record behind');
  r := public.email_ingest_inbound(payload || jsonb_build_object('organization_id', orgA, 'account_id', accA, 'conversation_id', cA, 'provider_message_id', 'h_ok', 'rfc_message_id', '<hard@x>',
          'participants', jsonb_build_array(jsonb_build_object('email', 'ada@client.com')), 'attachments', jsonb_build_array(jsonb_build_object('provider_attachment_id', 'a1', 'filename', 'f.pdf'))));
  perform ti.ok(not (r ->> 'duplicate')::boolean and (r ->> 'conversation_id')::uuid = cA, 'a valid account + conversation combination is accepted');
  r := public.email_ingest_inbound(payload || jsonb_build_object('organization_id', orgA, 'account_id', accA, 'conversation_id', cA, 'provider_message_id', 'h_ok'));
  perform ti.ok((r ->> 'duplicate')::boolean and (select count(*) from public.email_messages where provider_message_id = 'h_ok') = 1, 'the same message again is a duplicate');
  perform ti.as_user(ADMIN);
  perform ti.throws($q$select public.email_ingest_inbound('{}'::jsonb)$q$, 'permission denied', 'browsers still cannot call ingest');
  perform ti.as_super();

  -- 2. database constraints: mismatched ownership cannot be written even by a direct insert ---------------------------------------
  perform ti.throws(format($q$insert into public.email_messages (organization_id, conversation_id, account_id, direction, status) values (%L, %L, %L, 'inbound', 'received')$q$, orgB, cA, accA),
                    'foreign key', 'a message cannot name a conversation of another organization');
  perform ti.throws(format($q$insert into public.email_messages (organization_id, conversation_id, account_id, direction, status) values (%L, %L, %L, 'inbound', 'received')$q$, orgA, cA, accA2),
                    'foreign key', 'a message cannot use a different account than its conversation');
  perform ti.throws(format($q$insert into public.email_conversations (organization_id, account_id, subject) values (%L, %L, 'x')$q$, orgB, accA),
                    'foreign key', 'a conversation cannot point at an account of another organization');

  -- 3. delivery events ------------------------------------------------------------------------------------------------------------
  insert into public.email_messages (id, organization_id, conversation_id, account_id, direction, provider, provider_message_id, status, sent_at)
  values ('33000000-0000-0000-0000-000000000001', orgA, cA, accA, 'outbound', 'resend', 're_hard_1', 'sent', now()) returning id into mid;
  r := public.email_apply_delivery_event('re_hard_1', 'delivered', 'email.delivered', 'hev1', now(), '{}');
  perform ti.ok((r ->> 'applied')::boolean and (select status = 'delivered' from public.email_messages where id = mid), 'delivered is applied');
  r := public.email_apply_delivery_event('re_hard_1', 'sent', 'email.sent', 'hev2', now() - interval '1 minute', '{}');
  perform ti.ok(not (r ->> 'applied')::boolean and (select status = 'delivered' from public.email_messages where id = mid), 'a late sent event never moves delivered back to sent');
  r := public.email_apply_delivery_event('re_hard_1', 'delivered', 'email.delivered', 'hev1', now(), '{}');
  perform ti.ok((r ->> 'duplicate')::boolean and not (r ->> 'applied')::boolean and (select count(*) = 2 from public.email_events where message_id = mid), 'a duplicate event id changes nothing and is stored once');
  perform public.email_apply_delivery_event('re_hard_1', 'bounced', 'email.bounced', 'hev3', now(), '{"reason":"Mailbox full"}');
  perform ti.ok((select status = 'bounced' and error = 'Mailbox full' from public.email_messages where id = mid), 'a bounce overrides delivered and keeps its reason');
  perform public.email_apply_delivery_event('re_hard_1', 'failed', 'email.failed', 'hev4', now(), '{"reason":"other"}');
  perform ti.ok((select status = 'bounced' and error = 'Mailbox full' from public.email_messages where id = mid), 'a later failed event cannot replace a bounce');
  perform public.email_apply_delivery_event('re_hard_1', 'delivered', 'email.delivered', 'hev5', now(), '{}');
  perform ti.ok((select status = 'bounced' from public.email_messages where id = mid), 'delivered cannot undo a bounce');
  perform public.email_apply_delivery_event('re_hard_1', 'complained', 'email.complained', 'hev6', now(), '{}');
  perform ti.ok((select status = 'complained' from public.email_messages where id = mid), 'a complaint outranks a bounce');
  perform ti.throws($q$select public.email_apply_delivery_event('re_hard_1', 'opened', 'email.opened', 'hev7', now(), '{}')$q$, 'Unsupported delivery status', 'unsupported statuses are refused');
  perform ti.throws($q$select public.email_apply_delivery_event('re_hard_1', 'queued', 'x', 'hev8', now(), '{}')$q$, 'Unsupported delivery status', 'a status that is not a delivery outcome is refused');
  perform ti.throws($q$select public.email_apply_delivery_event('', 'sent', 'email.sent', 'hev9', now(), '{}')$q$, 'Missing provider message id', 'a missing id is refused');
  perform ti.ok(not (public.email_apply_delivery_event('re_never_seen', 'delivered', 'email.delivered', 'hev10', now(), '{}') ->> 'found')::boolean, 'an unknown id updates nothing');
  -- inbound rows and other providers are never touched, even with the same id
  insert into public.email_messages (organization_id, conversation_id, account_id, direction, provider, provider_message_id, status)
  values (orgA, cA, accA, 'inbound', 'resend', 're_hard_2', 'received'), (orgA, cA, accA, 'outbound', 'gmail', 're_hard_3', 'sent');
  perform ti.ok(not (public.email_apply_delivery_event('re_hard_2', 'delivered', 'email.delivered', 'hev11', now(), '{}') ->> 'found')::boolean, 'an inbound message is never updated by a delivery event');
  perform ti.ok(not (public.email_apply_delivery_event('re_hard_3', 'delivered', 'email.delivered', 'hev12', now(), '{}') ->> 'found')::boolean, 'a non-Resend message is never updated');
  -- the same provider id in two organizations is ambiguous: nothing is updated
  insert into public.email_messages (organization_id, conversation_id, account_id, direction, provider, provider_message_id, status)
  values (orgA, cA, accA, 'outbound', 'resend', 're_hard_dup', 'sent'), (orgB, cB, accB, 'outbound', 'resend', 're_hard_dup', 'sent');
  r := public.email_apply_delivery_event('re_hard_dup', 'delivered', 'email.delivered', 'hev13', now(), '{}');
  perform ti.ok((r ->> 'ambiguous')::boolean and not (r ->> 'found')::boolean and (select count(*) = 0 from public.email_messages where provider_message_id = 're_hard_dup' and status <> 'sent'), 'an ambiguous provider id updates neither message');
  perform ti.ok((select count(*) = 0 from public.email_events where provider_event_id = 'hev13'), 'and records no event');

  -- 4. webhook claims ------------------------------------------------------------------------------------------------------------
  r := public.email_webhook_claim('w1', 'email.received', '{"a":1}'::jsonb);
  tok := (r ->> 'token')::uuid;
  perform ti.ok(r ->> 'state' = 'claimed' and (r ->> 'attempts')::int = 1, 'a new event is claimed');
  perform ti.ok(public.email_webhook_claim('w1', 'email.received', '{"a":1}'::jsonb) ->> 'state' = 'busy', 'a second claim while the lease is valid is busy');
  perform ti.ok(not (public.email_webhook_finish('w1', '99999999-9999-9999-9999-999999999999', 'processed') ->> 'ok')::boolean, 'a wrong token cannot finish a claim');
  perform ti.ok(not (public.email_webhook_finish('w1', null, 'processed') ->> 'ok')::boolean, 'a null token cannot finish a claim');
  perform ti.throws(format($q$select public.email_webhook_finish('w1', %L, 'weird')$q$, tok), 'Unsupported webhook status', 'unknown finish statuses are refused');
  perform ti.ok((public.email_webhook_finish('w1', tok, 'processed') ->> 'ok')::boolean, 'the owner can finish');
  perform ti.ok(not (public.email_webhook_finish('w1', tok, 'failed') ->> 'ok')::boolean and (select status = 'processed' from public.email_webhook_events where svix_id = 'w1'), 'a finished claim cannot be finished again');
  perform ti.ok(public.email_webhook_claim('w1', 'email.received', '{}'::jsonb) ->> 'state' = 'done', 'a completed event is an idempotent success');
  -- failed events retry and keep their original payload
  r := public.email_webhook_claim('w2', 'email.received', '{"a":1}'::jsonb); perform public.email_webhook_finish('w2', (r ->> 'token')::uuid, 'failed', 'boom');
  r := public.email_webhook_claim('w2', 'email.delivered', '{"b":2}'::jsonb);
  perform ti.ok(r ->> 'state' = 'claimed' and (r ->> 'attempts')::int = 2 and (select payload = '{"a":1}'::jsonb and event_type = 'email.received' from public.email_webhook_events where svix_id = 'w2'), 'a failed event is retried, attempts count up, the original payload and type are kept');
  -- crashed worker: the lease expires and the claim is recovered; the old owner is locked out
  r := public.email_webhook_claim('w3', 'email.received', '{}'::jsonb); tok := (r ->> 'token')::uuid;
  update public.email_webhook_events set lease_expires_at = now() - interval '1 second' where svix_id = 'w3';
  r := public.email_webhook_claim('w3', 'email.received', '{}'::jsonb); tok2 := (r ->> 'token')::uuid;
  perform ti.ok(r ->> 'state' = 'claimed' and (r ->> 'attempts')::int = 2 and tok2 <> tok, 'an expired claim is recovered under a new token');
  perform ti.ok(not (public.email_webhook_finish('w3', tok, 'processed') ->> 'ok')::boolean and (select status = 'processing' from public.email_webhook_events where svix_id = 'w3'), 'the old owner cannot finish the newer claim');
  perform ti.ok((public.email_webhook_finish('w3', tok2, 'ignored', 'x') ->> 'ok')::boolean and (select status = 'ignored' from public.email_webhook_events where svix_id = 'w3'), 'the new owner can');
  -- bounded retries
  r := public.email_webhook_claim('w4', 'email.received', '{}'::jsonb); perform public.email_webhook_finish('w4', (r ->> 'token')::uuid, 'failed', 'boom');
  perform ti.ok(public.email_webhook_claim('w4', 'email.received', '{}'::jsonb, 300, 1) ->> 'state' = 'exhausted' and (select status = 'failed' from public.email_webhook_events where svix_id = 'w4'), 'attempts stop at the limit');
  perform ti.throws($q$select public.email_webhook_claim('', 'x', '{}'::jsonb)$q$, 'Missing webhook id', 'an empty id is refused');
  perform ti.as_user(ADMIN);
  perform ti.throws($q$select public.email_webhook_claim('w9', 'x', '{}'::jsonb)$q$, 'permission denied', 'browsers cannot claim webhooks');
  perform ti.throws($q$select public.email_webhook_finish('w1', null, 'processed')$q$, 'permission denied', 'browsers cannot finish webhooks');
  perform ti.throws($q$select count(*) from public.email_webhook_events$q$, 'permission denied', 'the webhook log is still service-role only');
  perform ti.as_super();

  -- 5. thread token lookup is scoped to organization and account ---------------------------------------------------------------
  perform ti.ok(public.email_find_conversation_by_token(orgA, accA, substr(replace(cA::text, '-', ''), 1, 12)) = cA, 'the token finds its conversation');
  perform ti.ok(public.email_find_conversation_by_token(orgA, accA2, substr(replace(cA::text, '-', ''), 1, 12)) is null, 'but not through another account');
  perform ti.ok(public.email_find_conversation_by_token(orgB, accB, substr(replace(cA::text, '-', ''), 1, 12)) is null, 'nor another organization');
  perform ti.ok(public.email_find_conversation_by_token(orgA, accA, 'not-a-token') is null, 'a malformed token matches nothing');

  -- cleanup of this file's own rows (the shared fixture is left as it was)
  delete from public.email_accounts where id in (accA, accA2, accP, accB);
  delete from public.email_webhook_events where svix_id in ('w1', 'w2', 'w3', 'w4');
  raise notice 'PASS email_resend_hardening.test.sql complete';
end $$;
