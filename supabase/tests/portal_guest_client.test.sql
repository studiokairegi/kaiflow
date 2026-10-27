-- Client Portal chat + freelancer guest chat tests (real Postgres). Reuses the fixture created by
-- access_directory_groups.test.sql (same database, run second by run_access_chat.sh).

do $$
declare m uuid := '00000000-0000-0000-0000-0000000000a1'; orgA uuid := '10000000-0000-0000-0000-00000000000a';
        p1 uuid; p2 uuid;
begin
  select id into p1 from projects where name='Project One';
  select id into p2 from projects where name='Project Two';
  update projects set share_token='clienttoken-project-one-0001', share_enabled=true where id=p1;
  update projects set share_token='clienttoken-project-two-0002', share_enabled=false where id=p2;
end $$;

-- ---------------- Client portal ----------------
do $$
declare th uuid; th2 uuid; n int; r record; msg uuid; cnt int;
begin
  select thread_id into th from portal_client_resolve('clienttoken-project-one-0001');
  perform t.ok(th is not null, 'A valid share link resolves to a client thread');
  perform t.ok((select count(*) from portal_client_resolve('clienttoken-project-two-0002')) = 0, 'A project with sharing disabled has no chat');
  perform t.ok((select count(*) from portal_client_resolve('nonexistent-token-value-xx')) = 0, 'An unknown token resolves to nothing');
  perform t.ok((select count(*) from portal_client_resolve('short')) = 0, 'A malformed token resolves to nothing');
  select thread_id into th2 from portal_client_resolve('clienttoken-project-one-0001');
  perform t.ok(th = th2, 'The client thread is created once per project');
  msg := portal_post_message(th, 'client', null, 'Cleo from Acme', E'  Hello studio\r\nsecond line  ', 'idem-0001-aaaa', '[]');
  perform t.ok(msg is not null, 'A client can post a message');
  perform t.ok(portal_post_message(th, 'client', null, 'Cleo', 'Hello studio', 'idem-0001-aaaa', '[]') = msg, 'A retried send with the same key returns the first message');
  perform t.ok((select body from portal_thread_messages(th) limit 1) = E'Hello studio\nsecond line', 'Body is normalized and trimmed');
  perform t.throws(format('select portal_post_message(%L,%L,null,%L,%L,%L,%L)', th, 'client', 'x', repeat('a',4001), 'idem-0002-bbbb', '[]'), 'message_too_long', 'Over-long messages are rejected');
  perform t.throws(format('select portal_post_message(%L,%L,null,%L,%L,%L,%L)', th, 'client', 'x', '   ', 'idem-0003-cccc', '[]'), 'empty_message', 'Empty messages are rejected');
  perform t.throws(format('select portal_post_message(%L,%L,gen_random_uuid(),%L,%L,%L,%L)', th, 'guest', 'x', 'hi', 'idem-0004-dddd', '[]'), 'thread_kind_mismatch', 'A guest cannot post into a client thread');
end $$;

-- ---------------- Staff side ----------------
do $$
declare m uuid := '00000000-0000-0000-0000-0000000000a1'; s uuid := '00000000-0000-0000-0000-0000000000a2';
        f uuid := '00000000-0000-0000-0000-0000000000a4'; c uuid := '00000000-0000-0000-0000-0000000000a5';
        b uuid := '00000000-0000-0000-0000-0000000000b1'; orgA uuid := '10000000-0000-0000-0000-00000000000a';
        th uuid; p1 uuid; n int; note uuid;
begin
  select id into p1 from projects where name='Project One';
  select id into th from portal_threads where project_id=p1 and kind='client';

  perform t.as_user(m); set local role authenticated;
  select count(*) into n from portal_staff_list_threads(orgA); perform t.ok(n = 1, 'Master sees the client thread with its project');
  perform t.ok((select unread_count from portal_staff_list_threads(orgA) limit 1) = 1, 'Unread count reflects the client message');
  perform portal_staff_send(th, 'Thanks Cleo', 'staff-idem-0001', '[]');
  perform portal_staff_add_note(th, 'Budget is tight, do not mention rush fee');
  perform portal_staff_mark_read(th);
  perform t.ok((select unread_count from portal_staff_list_threads(orgA) limit 1) = 0, 'Marking read clears the unread count');
  perform t.ok((select count(*) from portal_staff_notes(th)) = 1, 'Staff can read internal notes');
  reset role;

  -- What the client can see never includes notes.
  perform t.ok((select count(*) from portal_thread_messages(th) where body like '%rush fee%') = 0, 'Internal notes never appear in the client message feed');
  perform t.ok((select count(*) from portal_thread_messages(th)) = 2, 'Client feed has the client and staff messages');
  perform t.ok(not exists (select 1 from information_schema.columns where table_name='portal_messages' and column_name like '%note%'), 'Notes are structurally separate from messages');

  -- Sales member without project access
  perform t.as_user(s); set local role authenticated;
  select count(*) into n from portal_staff_list_threads(orgA); perform t.ok(n = 0, 'A member without project access sees no client threads');
  perform t.throws(format('select * from portal_staff_messages(%L)', th), 'not_authorized', 'A member without project access cannot read a client thread');
  perform t.throws(format('select portal_staff_send(%L,%L,%L)', th, 'sneaky', 'sneaky-key-0001'), 'not_authorized', 'A member without project access cannot reply');
  perform t.throws(format('select portal_staff_notes(%L)', th), 'not_authorized', 'A member without project access cannot read notes');
  perform t.throws(format('select * from portal_staff_create_guest_invite(%L,%L,%L,%L)', orgA, p1, 'X', repeat('a',64)), 'not_authorized', 'A member without project access cannot invite guests');
  reset role;
  perform t.as_user(m); set local role authenticated; perform studio_assign_project_access(orgA, p1, s, 'contributor'); reset role;
  perform t.as_user(s); set local role authenticated;
  select count(*) into n from portal_staff_list_threads(orgA); perform t.ok(n = 1, 'After assignment the member sees the thread');
  perform portal_staff_send(th, 'Reply from sales', 'sales-key-0001', '[]');
  reset role;
  perform t.as_user(m); set local role authenticated; perform studio_revoke_project_access(orgA, p1, s); reset role;
  perform t.as_user(s); set local role authenticated;
  select count(*) into n from portal_staff_list_threads(orgA); perform t.ok(n = 0, 'Revoking project access removes thread access');
  reset role;

  -- Freelancer role, client role and other studio
  perform t.as_user(f); set local role authenticated;
  perform t.throws(format('select * from portal_staff_create_guest_invite(%L,%L,%L,%L)', orgA, p1, 'X', repeat('b',64)), 'not_authorized', 'A freelancer account cannot invite other guests');
  reset role;
  perform t.as_user(c); set local role authenticated;
  perform t.throws(format('select portal_staff_list_threads(%L)', orgA), 'not_authorized', 'A client-role account cannot use the staff inbox');
  reset role;
  perform t.as_user(b); set local role authenticated;
  perform t.throws(format('select portal_staff_list_threads(%L)', orgA), 'not_authorized', 'Another studio cannot list this inbox');
  perform t.throws(format('select * from portal_staff_messages(%L)', th), 'not_authorized', 'Another studio cannot read this thread');
  reset role;
end $$;

-- ---------------- Freelancer guest ----------------
do $$
declare m uuid := '00000000-0000-0000-0000-0000000000a1'; orgA uuid := '10000000-0000-0000-0000-00000000000a';
        p1 uuid; p2 uuid; inv record; tok text := repeat('ab',32); sess text := repeat('cd',32); sess2 text := repeat('ef',32);
        claim jsonb; gth uuid; sid uuid; res record; msg uuid; clientth uuid;
begin
  select id into p1 from projects where name='Project One';
  select id into clientth from portal_threads where project_id=p1 and kind='client' limit 1;
  select id into p2 from projects where name='Project Two';
  perform t.as_user(m); set local role authenticated;
  select * into inv from portal_staff_create_guest_invite(orgA, p1, 'Fumi (animator)', tok);
  perform t.ok(inv.invite_id is not null, 'Staff can create a guest invite');
  perform t.throws(format('select * from portal_staff_create_guest_invite(%L,%L,%L,%L)', orgA, p1, 'bad', 'not-a-token'), 'invalid_invite_token', 'Malformed tokens are refused');
  reset role;
  perform t.ok((select token_hash from portal_guest_invites where id=inv.invite_id) = studio_hash_invite_token(tok), 'Only the SHA-256 of the token is stored');
  perform t.ok(not exists (select 1 from portal_guest_invites where token_hash = tok), 'The raw token is never stored');

  perform t.ok(portal_guest_claim('nothex', sess, 'x') is null, 'Malformed invite hash fails');
  perform t.ok(portal_guest_claim(repeat('0',64), sess, 'x') is null, 'Unknown invite fails');
  claim := portal_guest_claim(studio_hash_invite_token(tok), sess, E'Fumi\n<script>', null);
  perform t.ok(claim is not null, 'A valid invite is claimed once');
  perform t.ok(portal_guest_claim(studio_hash_invite_token(tok), sess2, 'Replay') is null, 'A claimed invite cannot be replayed');
  perform t.ok((claim->>'display_name') not like E'%\n%', 'Control characters are stripped from the display name');

  select * into res from portal_guest_resolve(sess);
  perform t.ok(res.thread_id is not null and res.project_id = p1, 'The session resolves to exactly its project thread');
  perform t.ok((select count(*) from portal_guest_resolve(sess2)) = 0, 'Unknown sessions resolve to nothing');
  perform t.ok((select count(*) from portal_guest_resolve('zz')) = 0, 'Malformed sessions resolve to nothing');
  gth := res.thread_id;
  perform t.ok(gth <> clientth, 'The guest thread is distinct from the client thread');
  msg := portal_post_message(gth, 'guest', res.session_id, res.display_name, 'Pages uploaded', 'guest-key-0001', '[]');
  perform t.ok(msg is not null, 'A guest can post in its thread');
  perform t.throws(format('select portal_post_message(%L,%L,%L,%L,%L,%L)', clientth, 'guest', res.session_id, 'x', 'leak?', 'guest-key-0002'), 'thread_kind_mismatch', 'A guest cannot post into the client thread');
  perform t.ok((select count(*) from portal_thread_messages(gth)) = 1, 'The guest feed holds only its own thread');

  -- Revocation takes effect immediately
  perform t.as_user(m); set local role authenticated;
  perform portal_staff_revoke_guest_invite(inv.invite_id);
  reset role;
  perform t.ok((select count(*) from portal_guest_resolve(sess)) = 0, 'Revoking the invite ends the guest session at once');
  perform t.throws(format('select portal_staff_revoke_guest_invite(%L)', gen_random_uuid()), 'not_authorized', 'Unknown invites cannot be revoked');

  -- Expiry
  perform t.as_user(m); set local role authenticated;
  select * into inv from portal_staff_create_guest_invite(orgA, p1, 'Late guest', repeat('12',32));
  reset role;
  update portal_guest_invites set expires_at = now() - interval '1 minute' where id = inv.invite_id;
  perform t.ok(portal_guest_claim(studio_hash_invite_token(repeat('12',32)), repeat('34',32), 'Late') is null, 'An expired invite cannot be claimed');
  perform t.ok((select status from portal_guest_invites where id=inv.invite_id) = 'expired', 'The expired invite is marked expired');

  -- Session expiry
  perform t.as_user(m); set local role authenticated;
  select * into inv from portal_staff_create_guest_invite(orgA, p1, 'Short session', repeat('56',32));
  reset role;
  claim := portal_guest_claim(studio_hash_invite_token(repeat('56',32)), repeat('78',32), 'Short');
  update portal_guest_sessions set expires_at = now() - interval '1 second' where token_hash = repeat('78',32);
  perform t.ok((select count(*) from portal_guest_resolve(repeat('78',32))) = 0, 'An expired session no longer resolves');
end $$;

-- ---------------- Direct access is closed ----------------
do $$
declare m uuid := '00000000-0000-0000-0000-0000000000a1'; orgA uuid := '10000000-0000-0000-0000-00000000000a'; th uuid;
begin
  select id into th from portal_threads limit 1;
  perform t.as_user(m); set local role authenticated;
  perform t.throws('select * from portal_messages', 'permission denied', 'Even the Master cannot read portal tables directly');
  perform t.throws('select * from portal_internal_notes', 'permission denied', 'Internal notes are not directly readable');
  perform t.throws('select * from portal_guest_invites', 'permission denied', 'Invite hashes are not directly readable');
  perform t.throws('select * from portal_guest_sessions', 'permission denied', 'Session hashes are not directly readable');
  perform t.throws(format('select * from portal_thread_messages(%L)', th), 'permission denied', 'Service-only functions are closed to signed-in users');
  perform t.throws(format('select portal_guest_resolve(%L)', repeat('0',64)), 'permission denied', 'Session resolution is service-only');
  perform t.throws(format('select portal_client_resolve(%L)', 'clienttoken-project-one-0001'), 'permission denied', 'Client resolution is service-only');
  reset role;
  set local role anon;
  perform t.throws(format('select portal_client_resolve(%L)', 'clienttoken-project-one-0001'), 'permission denied', 'Anonymous callers cannot resolve share links through the database');
  perform t.throws(format('select portal_post_message(%L,%L,null,%L,%L,%L)', th, 'client', 'x', 'hi', 'anon-key-0001'), 'permission denied', 'Anonymous callers cannot post');
  perform t.throws('select * from portal_staff_list_threads(''10000000-0000-0000-0000-00000000000a'')', 'permission denied', 'Anonymous callers cannot use staff functions');
  reset role;
end $$;

-- ---------------- Rate limiting, attachments ----------------
do $$
declare th uuid; i int; ok_count int := 0; att uuid; msg uuid; other uuid;
begin
  for i in 1..7 loop if portal_rate_limit('test', 'subject-1', 5, 60) then ok_count := ok_count + 1; end if; end loop;
  perform t.ok(ok_count = 5, 'The rate limiter allows exactly the configured number of hits');
  perform t.ok(portal_rate_limit('test', 'subject-2', 5, 60), 'Limits are per subject');

  select id into th from portal_threads where kind='client' limit 1;
  select id into other from portal_threads where kind='freelancer' limit 1;
  msg := portal_post_message(th, 'client', null, 'Cleo', 'see file', 'att-key-0001', jsonb_build_array(jsonb_build_object(
    'object_path', th::text || '/u1/file.pdf', 'file_name', 'brief.pdf', 'content_type', 'application/pdf', 'size_bytes', 1234)));
  select a.id into att from portal_attachments a where a.message_id = msg;
  perform t.ok((select count(*) from portal_get_attachment(th, att)) = 1, 'An attachment resolves inside its own thread');
  perform t.ok((select count(*) from portal_get_attachment(other, att)) = 0, 'An attachment does not resolve from another thread');
  perform t.ok((select count(*) from storage.objects) >= 0 and not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and qual like '%portal-attachments%'), 'The portal bucket has no storage policies (service role only)');
  perform t.ok((select public from storage.buckets where id='portal-attachments') = false, 'The portal bucket is private');
end $$;
