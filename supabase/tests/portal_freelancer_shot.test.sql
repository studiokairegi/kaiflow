-- Freelancer chat on the per-shot link. Runs after the other portal tests (same database).
do $$
declare p1 uuid; owner uuid; sh uuid; sh2 uuid; th uuid; th2 uuid; msg uuid; th_other uuid;
begin
  select id, user_id into p1, owner from projects where name='Project One';
  insert into shots(project_id, user_id, title, share_token) values (p1, owner, 'Opening aerial', 'shottoken-opening-aerial-0001') returning id into sh;
  insert into shots(project_id, user_id, title, share_token) values (p1, owner, 'Beach grade', 'shottoken-beach-grade-000002') returning id into sh2;

  select thread_id into th from portal_freelancer_resolve('shottoken-opening-aerial-0001');
  perform t.ok(th is not null, 'A shot share link resolves to a freelancer thread');
  select thread_id into th2 from portal_freelancer_resolve('shottoken-opening-aerial-0001');
  perform t.ok(th = th2, 'The shot thread is created once');
  select thread_id into th_other from portal_freelancer_resolve('shottoken-beach-grade-000002');
  perform t.ok(th_other <> th, 'Each shot has its own private thread');
  perform t.ok((select kind from portal_threads where id = th) = 'freelancer', 'The thread is a freelancer thread');
  perform t.ok((select count(*) from portal_freelancer_resolve('nonexistent-shot-token-xx')) = 0, 'An unknown shot token resolves to nothing');
  perform t.ok((select count(*) from portal_freelancer_resolve('short')) = 0, 'A malformed token resolves to nothing');

  msg := portal_post_message(th, 'guest', null, 'Amina (colour)', 'Grade uploaded', 'shot-key-0001', '[]');
  perform t.ok(msg is not null, 'A shot-link freelancer can post without a session');
  perform t.ok(portal_post_message(th, 'guest', null, 'Amina', 'Grade uploaded', 'shot-key-0001', '[]') = msg, 'A retried send returns the first message');
  perform t.ok((select count(*) from portal_thread_messages(th)) = 1 and (select count(*) from portal_thread_messages(th_other)) = 0, 'Messages never leak between shot threads');
  perform t.throws(format('select portal_post_message(%L,%L,null,%L,%L,%L,%L)', th, 'client', 'x', 'hi', 'shot-key-0002', '[]'), 'thread_kind_mismatch', 'A client cannot post into a freelancer thread');
  -- A project-level guest thread still demands a real session.
  perform t.throws(format('select portal_post_message(%L,%L,null,%L,%L,%L,%L)', (select id from portal_threads where kind='freelancer' and shot_id is null limit 1), 'guest', 'x', 'hi', 'shot-key-0003', '[]'), 'session_required', 'Project guest threads still require a session');
end $$;

begin;
set local role anon;
do $$ begin
  perform t.throws('select portal_freelancer_resolve(''shottoken-opening-aerial-0001'')', 'permission denied', 'Shot-link resolution is service-only');
end $$;
rollback;
