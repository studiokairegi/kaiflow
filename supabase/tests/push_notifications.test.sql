-- Web Push queue, triggers and lockdown (real Postgres). Runs after the portal tests (same database).
delete from push_jobs;

do $$
declare m uuid := '00000000-0000-0000-0000-0000000000a1'; s uuid := '00000000-0000-0000-0000-0000000000a2';
        f uuid := '00000000-0000-0000-0000-0000000000a4'; c uuid := '00000000-0000-0000-0000-0000000000a5';
        conv uuid; sender uuid; others int; n int; p1 uuid; owner uuid; th uuid; r record;
begin
  -- Chat message -> one job per other active member, none for the sender.
  select cm.conversation_id into conv from chat_conversation_members cm where cm.status = 'active'
    group by cm.conversation_id having count(*) >= 2 limit 1;
  perform t.ok(conv is not null, 'fixture has a conversation with two members');
  select user_id into sender from chat_conversation_members where conversation_id = conv and status = 'active' limit 1;
  select count(*) into others from chat_conversation_members where conversation_id = conv and status = 'active' and user_id <> sender;
  insert into chat_messages(conversation_id, sender_user_id, body, idempotency_key, request_fingerprint)
    values (conv, sender, 'hello from the push test', gen_random_uuid(), 'x');
  select count(*) into n from push_jobs where category = 'messages' and tag = 'chat-' || conv::text;
  perform t.ok(n = others, 'a chat message queues one alert per other member');
  perform t.ok(not exists (select 1 from push_jobs where user_id = sender), 'the sender is not alerted about their own message');
  perform t.ok((select body from push_jobs where tag = 'chat-' || conv::text limit 1) = 'hello from the push test', 'the alert carries the message preview');

  -- Portal: a client message alerts staff who can manage the project, not freelancers/clients.
  select id, user_id into p1, owner from projects where name = 'Project One';
  select thread_id into th from portal_client_resolve('clienttoken-project-one-0001');
  delete from push_jobs;
  perform portal_post_message(th, 'client', null, 'Cleo', 'Can we see the new cut?', 'push-key-0001', '[]');
  perform t.ok(exists (select 1 from push_jobs where user_id = m and category = 'messages'), 'a client message alerts the studio master');
  perform t.ok(not exists (select 1 from push_jobs where user_id in (f, c)), 'freelancer and client accounts are not alerted about client chat');
  perform t.ok(not exists (select 1 from push_jobs where portal_thread_id is not null), 'a client message does not alert the portal side');

  -- Portal: a staff reply alerts the portal thread's subscribers.
  delete from push_jobs;
  perform set_config('request.jwt.claim.sub', m::text, true);
  perform t.as_user(m);
  perform portal_staff_send(th, 'Yes, uploading now', 'push-key-staff1', '[]');
  perform t.ok((select count(*) from push_jobs where portal_thread_id = th and category = 'messages') = 1, 'a staff reply queues one alert for the portal thread');
  perform t.ok(not exists (select 1 from push_jobs where user_id is not null), 'a staff reply does not alert other staff');

  -- Activity events.
  delete from push_jobs;
  insert into activity_log(user_id, project_id, event_type, description, audience, meta)
    values (owner, p1, 'freelancer_upload', 'Amina uploaded grade.mov', 'internal', '{}'::jsonb);
  insert into activity_log(user_id, project_id, event_type, description, audience, meta)
    values (owner, p1, 'client_approved', 'Approved v2', 'internal', '{}'::jsonb);
  insert into activity_log(user_id, project_id, event_type, description, audience, meta)
    values (owner, p1, 'something_else', 'Ignored', 'internal', '{}'::jsonb);
  perform t.ok((select count(*) from push_jobs where user_id = owner) = 2, 'only upload and cut-review events queue alerts');
  perform t.ok(exists (select 1 from push_jobs where category = 'freelancerUploads' and title = 'New freelancer upload'), 'freelancer uploads use their own category');
  perform t.ok(exists (select 1 from push_jobs where category = 'cutReview' and title = 'Client approved a cut'), 'cut reviews use their own category');
end $$;

-- Scheduling, dedupe, claim and finish.
do $$
declare owner uuid; id1 uuid; id2 uuid; n int; due1 timestamptz;
begin
  select user_id into owner from projects where name = 'Project One';
  delete from push_jobs;
  perform push_enqueue_user(owner, 'focus', 'Break time', 'Round 1 done', 'kairil-pomodoro', '/', now() + interval '25 minutes', 'pomo:' || owner::text);
  perform push_enqueue_user(owner, 'focus', 'Break time', 'Round 2 done', 'kairil-pomodoro', '/', now() + interval '50 minutes', 'pomo:' || owner::text);
  perform t.ok((select count(*) from push_jobs where dedupe_key = 'pomo:' || owner::text) = 1, 'a repeated dedupe key replaces the pending alert');
  perform t.ok((select body from push_jobs where dedupe_key = 'pomo:' || owner::text) = 'Round 2 done', 'the replacement carries the newest text');
  perform t.ok((select count(*) from push_claim_jobs(10)) = 0, 'future alerts are not claimed early');
  update push_jobs set due_at = now() - interval '1 second';
  perform t.ok((select count(*) from push_claim_jobs(10)) = 1, 'a due alert is claimed');
  perform t.ok((select count(*) from push_claim_jobs(10)) = 0, 'a claimed alert is not handed out twice');
  select id into id1 from push_jobs limit 1;
  perform push_finish_job(id1);
  perform t.ok((select sent_at from push_jobs where id = id1) is not null, 'finish marks the alert sent');
  update push_jobs set claimed_at = now() - interval '5 minutes', sent_at = null where id = id1;
  perform t.ok((select count(*) from push_claim_jobs(10)) = 1, 'an abandoned claim is retried');
  perform t.ok((select attempts from push_jobs where id = id1) = 2, 'retries are counted');
  update push_jobs set claimed_at = now() - interval '5 minutes', attempts = 5 where id = id1;
  perform t.ok((select count(*) from push_claim_jobs(10)) = 0, 'alerts that keep failing stop being retried');
  perform t.ok(push_clean(E'a\x01b\nc', 20) = 'a b c', 'control characters are stripped from alert text');
  perform push_kick_dispatch();
  perform t.ok(true, 'kicking the dispatcher without pg_net or config never raises');
  perform t.throws($q$select push_configure('http://insecure.example', 'abcdefghijklmnopqrstuvwxyz')$q$, 'invalid_url', 'the dispatcher URL must be https');
  perform t.throws($q$select push_configure('https://x.example/fn', 'short')$q$, 'secret_too_short', 'the dispatcher secret must be long');
  perform push_configure('https://x.example/functions/v1/push', 'abcdefghijklmnopqrstuvwxyz0123');
  perform t.ok((select count(*) from push_config) = 1, 'configuration is a single row');
end $$;

-- Subscription constraints.
do $$
declare owner uuid; th uuid;
begin
  select user_id into owner from projects where name = 'Project One';
  select thread_id into th from portal_client_resolve('clienttoken-project-one-0001');
  insert into push_subscriptions(endpoint, p256dh, auth_secret, user_id) values ('https://push.example/abcdefghijklmnop', repeat('p', 40), repeat('a', 16), owner);
  perform t.throws(format($q$insert into push_subscriptions(endpoint,p256dh,auth_secret,user_id,portal_thread_id) values ('https://push.example/zzzzzzzzzzzzzzzz','%s','%s','%s','%s')$q$, repeat('p', 40), repeat('a', 16), owner, th), 'check', 'a subscription belongs to a user or a thread, never both');
  perform t.throws($q$insert into push_subscriptions(endpoint,p256dh,auth_secret) values ('https://push.example/yyyyyyyyyyyyyyyy','aaaaaaaaaaaaaaaaaaaaaaaaaaaa','aaaaaaaaaa')$q$, 'check', 'a subscription needs an owner');
  perform t.throws(format($q$insert into push_subscriptions(endpoint,p256dh,auth_secret,user_id) values ('http://push.example/insecure-endpoint-xx','%s','%s','%s')$q$, repeat('p', 40), repeat('a', 16), owner), 'check', 'endpoints must be https');
  perform t.throws(format($q$insert into push_subscriptions(endpoint,p256dh,auth_secret,user_id) values ('https://push.example/abcdefghijklmnop','%s','%s','%s')$q$, repeat('p', 40), repeat('a', 16), owner), 'duplicate key', 'an endpoint is stored once');
end $$;

-- Browser roles reach nothing.
begin;
set local role anon;
do $$ begin
  perform t.throws('select * from push_jobs', 'permission denied', 'anon cannot read the alert queue');
  perform t.throws('select * from push_subscriptions', 'permission denied', 'anon cannot read subscriptions');
  perform t.throws('select push_claim_jobs(5)', 'permission denied', 'anon cannot claim alerts');
end $$;
rollback;
begin;
set local role authenticated;
do $$ begin
  perform t.throws('select * from push_jobs', 'permission denied', 'a signed-in user cannot read the alert queue');
  perform t.throws('select * from push_subscriptions', 'permission denied', 'a signed-in user cannot read subscriptions');
  perform t.throws('select push_enqueue_user(gen_random_uuid(), ''x'', ''t'', ''b'', null, null)', 'permission denied', 'a signed-in user cannot enqueue alerts directly');
  perform t.throws('select push_configure(''https://x.example'', ''abcdefghijklmnopqrstuvwxyz0123'')', 'permission denied', 'a signed-in user cannot change dispatcher config');
end $$;
rollback;
