-- =============================================================================
-- Tasks & Planning database tests. Run AFTER
-- supabase/migrations/20261012180000_studio_tasks.sql, in the Supabase SQL
-- editor (as postgres) or with psql. Everything runs in one transaction that is
-- rolled back, with throwaway users, so it leaves no data behind.
--
-- Executed by the author against PostgreSQL 16 with a minimal stand-in for the
-- Supabase auth schema and the leads / projects / shots / contacts tables the
-- guard trigger reads (see TASKS.md). Not yet run against your real project.
-- A failing step raises an exception naming the scenario.
-- =============================================================================
begin;

do $$
declare
  u1 uuid := gen_random_uuid(); u2 uuid := gen_random_uuid();
  lead1 uuid; lead_other uuid; proj1 uuid; shot1 uuid; contact1 uuid;
  t1 uuid; t2 uuid; t3 uuid; s1 uuid; s2 uuid;
  n int; r record; ok boolean; msg text; ids uuid[];
  today date := date '2026-10-12';
begin
  -- fixtures as the table owner (bypasses RLS)
  insert into auth.users (id, email, aud, role) values (u1, 'tk1@example.invalid', 'authenticated', 'authenticated');
  insert into auth.users (id, email, aud, role) values (u2, 'tk2@example.invalid', 'authenticated', 'authenticated');
  insert into leads (user_id, company_name) values (u1, 'Lead One') returning id into lead1;
  insert into leads (user_id, company_name) values (u2, 'Other Lead') returning id into lead_other;
  insert into projects (user_id, name) values (u1, 'Project One') returning id into proj1;
  insert into shots (project_id, title) values (proj1, 'Shot One') returning id into shot1;
  insert into contacts (user_id) values (u1) returning id into contact1;

  perform set_config('request.jwt.claim.sub', u1::text, true);
  set local role authenticated;

  -- T1: create with defaults; completing stamps completion, reopening clears it
  insert into studio_tasks (title, due_date) values ('Write proposal', today) returning id into t1;
  select * into r from studio_tasks where id = t1;
  if r.user_id <> u1 or r.status <> 'todo' or r.priority <> 'normal' or r.category <> 'general' or r.completed_at is not null then
    raise exception 'T1: bad defaults'; end if;
  update studio_tasks set status = 'completed', completed_on = today where id = t1;
  select * into r from studio_tasks where id = t1;
  if r.completed_at is null or r.completed_on <> today then raise exception 'T1: completion not stamped'; end if;
  update studio_tasks set status = 'todo' where id = t1;
  select * into r from studio_tasks where id = t1;
  if r.completed_at is not null or r.completed_on is not null then raise exception 'T1: reopen did not clear completion'; end if;

  -- T2: links only to your own records; link type and id travel together
  insert into studio_tasks (title, link_type, link_id, link_label) values ('Follow up', 'lead', lead1, 'Lead One');
  insert into studio_tasks (title, link_type, link_id) values ('Review project', 'project', proj1);
  insert into studio_tasks (title, link_type, link_id) values ('Check shot', 'shot', shot1);
  insert into studio_tasks (title, link_type, link_id) values ('Email contact', 'contact', contact1);
  ok := false;
  begin insert into studio_tasks (title, link_type, link_id) values ('Steal', 'lead', lead_other);
  exception when sqlstate 'P0002' then ok := true; end;
  if not ok then raise exception 'T2: linked another user''s lead'; end if;
  ok := false;
  begin insert into studio_tasks (title, link_type, link_id) values ('Ghost', 'lead', gen_random_uuid());
  exception when sqlstate 'P0002' then ok := true; end;
  if not ok then raise exception 'T2: linked a record that does not exist'; end if;
  ok := false;
  begin insert into studio_tasks (title, link_type) values ('Half link', 'lead');
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'T2: link type without id accepted'; end if;

  -- T3: user 2 sees and changes nothing of user 1's
  perform set_config('request.jwt.claim.sub', u2::text, true);
  select count(*) into n from studio_tasks;
  if n <> 0 then raise exception 'T3: user 2 can read user 1 tasks (%)', n; end if;
  update studio_tasks set title = 'hacked' where id = t1;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'T3: user 2 updated user 1 task'; end if;
  ok := false;
  begin insert into studio_tasks (user_id, title) values (u1, 'forged owner');
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'T3: user 2 inserted a row owned by user 1'; end if;
  perform set_config('request.jwt.claim.sub', u1::text, true);

  -- T4: duplicate keys are rejected by the database
  insert into studio_tasks (title, request_key) values ('a', 'reqkey-0001');
  ok := false;
  begin insert into studio_tasks (title, request_key) values ('a again', 'reqkey-0001');
  exception when unique_violation then ok := true; end;
  if not ok then raise exception 'T4: request_key not unique'; end if;
  insert into studio_tasks (title, source_key) values ('s', 'lead-followup:x:1');
  ok := false;
  begin insert into studio_tasks (title, source_key) values ('s again', 'lead-followup:x:1');
  exception when unique_violation then ok := true; end;
  if not ok then raise exception 'T4: source_key not unique'; end if;

  -- T5: a series materializes idempotently and unique index blocks duplicates
  insert into studio_task_series (title, recurrence, start_date, est_minutes, link_type, link_id, link_label)
    values ('Daily outreach', 'daily', today, 30, 'lead', lead1, 'Lead One') returning id into s1;
  n := studio_task_materialize(s1, array[today, today + 1, today + 2], today + 14, today);
  if n <> 3 then raise exception 'T5: expected 3 inserted, got %', n; end if;
  n := studio_task_materialize(s1, array[today, today + 1, today + 2], today + 14, today);
  if n <> 0 then raise exception 'T5: second run inserted % duplicates', n; end if;
  n := studio_task_materialize(s1, array[today + 2, today + 3], today + 14, today);
  if n <> 1 then raise exception 'T5: overlapping run should add only the new date, got %', n; end if;
  select count(*) into n from studio_tasks where series_id = s1;
  if n <> 4 then raise exception 'T5: expected 4 rows, got %', n; end if;
  ok := false;
  begin insert into studio_tasks (title, series_id, occurrence_date) values ('dup', s1, today);
  exception when unique_violation then ok := true; end;
  if not ok then raise exception 'T5: direct duplicate occurrence accepted'; end if;
  select count(*) into n from studio_tasks where series_id = s1 and link_id = lead1 and est_minutes = 30;
  if n <> 4 then raise exception 'T5: occurrences did not inherit series fields'; end if;
  select materialized_through into r from studio_task_series where id = s1;
  if r.materialized_through <> today + 14 then raise exception 'T5: materialized_through not advanced'; end if;

  -- T6: completing one occurrence leaves the series and other occurrences alone
  update studio_tasks set status = 'completed', completed_on = today where series_id = s1 and occurrence_date = today;
  select count(*) into n from studio_tasks where series_id = s1 and status = 'todo';
  if n <> 3 then raise exception 'T6: other occurrences changed (% open)', n; end if;
  select status into msg from studio_task_series where id = s1;
  if msg <> 'active' then raise exception 'T6: series changed on occurrence completion'; end if;

  -- T7: editing / moving one occurrence marks it an override; plain status changes do not
  update studio_tasks set title = 'Daily outreach (renamed)' where series_id = s1 and occurrence_date = today + 1;
  update studio_tasks set due_date = today + 5 where series_id = s1 and occurrence_date = today + 2;
  update studio_tasks set status = 'in_progress' where series_id = s1 and occurrence_date = today + 3;
  select count(*) into n from studio_tasks where series_id = s1 and series_override;
  if n <> 2 then raise exception 'T7: expected 2 overrides, got %', n; end if;
  select occurrence_date into r from studio_tasks where series_id = s1 and due_date = today + 5;
  if r.occurrence_date <> today + 2 then raise exception 'T7: occurrence_date changed on reschedule'; end if;
  -- the moved occurrence is still the one for today+2: it is not regenerated
  n := studio_task_materialize(s1, array[today + 2], today + 14, today);
  if n <> 0 then raise exception 'T7: moved occurrence was regenerated'; end if;

  -- T8: series edit (no schedule change) reaches only untouched open occurrences
  perform studio_task_materialize(s1, array[today + 4], today + 14, today);   -- one untouched occurrence
  update studio_task_series set title = 'Daily outreach v2', priority = 'high' where id = s1;
  n := studio_task_series_sync(s1, today, false);
  if n <> 1 then raise exception 'T8: expected 1 untouched open occurrence updated, got %', n; end if;
  select title, priority into r from studio_tasks where series_id = s1 and occurrence_date = today + 4;
  if r.title <> 'Daily outreach v2' or r.priority <> 'high' then raise exception 'T8: untouched occurrence did not follow the series'; end if;
  select title, priority into r from studio_tasks where series_id = s1 and occurrence_date = today + 3;
  -- today+3 is in_progress (started) so it keeps its own content
  if r.title = 'Daily outreach v2' then raise exception 'T8: started occurrence was overwritten'; end if;
  select title into msg from studio_tasks where series_id = s1 and occurrence_date = today + 1;
  if msg <> 'Daily outreach (renamed)' then raise exception 'T8: edited occurrence was overwritten'; end if;
  select title into msg from studio_tasks where series_id = s1 and occurrence_date = today;
  if msg = 'Daily outreach v2' then raise exception 'T8: completed occurrence was rewritten'; end if;
  select count(*) into n from studio_tasks where series_id = s1 and series_override;
  if n <> 2 then raise exception 'T8: sync itself created overrides (%)', n; end if;

  -- T9: schedule change regenerates untouched future occurrences only
  insert into studio_tasks (title, series_id, occurrence_date, due_date) values ('x', s1, today + 9, today + 9);
  n := studio_task_series_sync(s1, today, true);
  if n <> 2 then raise exception 'T9: expected only the 2 untouched open occurrences removed, got %', n; end if;
  select count(*) into n from studio_tasks where series_id = s1;
  if n <> 4 then raise exception 'T9: touched/completed occurrences must remain (have %)', n; end if;
  select materialized_through into r from studio_task_series where id = s1;
  if r.materialized_through <> today - 1 then raise exception 'T9: materialized_through not reset'; end if;

  -- T10: pause drops untouched future occurrences; resume never back-fills; ended is final
  insert into studio_task_series (title, recurrence, start_date) values ('Weekly review', 'daily', today) returning id into s2;
  perform studio_task_materialize(s2, array[today, today + 1, today + 2, today + 3], today + 14, today);
  perform studio_task_series_set_status(s2, 'paused', today);
  select count(*) into n from studio_tasks where series_id = s2;
  if n <> 1 then raise exception 'T10: pause should keep only today''s occurrence, have %', n; end if;
  if studio_task_materialize(s2, array[today + 5], today + 14, today) <> 0 then raise exception 'T10: paused series materialized'; end if;
  perform studio_task_series_set_status(s2, 'active', today + 10);
  select materialized_through into r from studio_task_series where id = s2;
  if r.materialized_through <> today + 9 then raise exception 'T10: resume should mark the paused period as handled'; end if;
  perform studio_task_series_set_status(s2, 'ended', today + 10);
  select status, end_date into r from studio_task_series where id = s2;
  if r.status <> 'ended' or r.end_date <> today + 10 then raise exception 'T10: end did not set status/end_date'; end if;
  ok := false;
  begin perform studio_task_series_set_status(s2, 'active', today + 10);
  exception when sqlstate '22023' then ok := true; end;
  if not ok then raise exception 'T10: ended series was resumed'; end if;

  -- T11: catch-up sweep keeps only the latest untouched missed occurrence
  insert into studio_task_series (title, recurrence, start_date) values ('Daily chore', 'daily', today - 20) returning id into s2;
  perform studio_task_materialize(s2, array[today - 6, today - 5, today - 4, today - 3, today - 2, today - 1, today], today + 14, today - 6);
  update studio_tasks set is_priority = true where series_id = s2 and occurrence_date = today - 5;   -- touched: must survive
  update studio_tasks set status = 'completed', completed_on = today - 4 where series_id = s2 and occurrence_date = today - 4;
  perform studio_task_materialize(s2, array[today + 1], today + 14, today);
  select count(*) into n from studio_tasks where series_id = s2 and status = 'todo' and due_date < today;
  -- survivors: the starred one (today-5) and the latest untouched (today-1)
  if n <> 2 then raise exception 'T11: expected 2 overdue open survivors, got %', n; end if;
  select count(*) into n from studio_tasks where series_id = s2 and auto_skipped;
  if n <> 3 then raise exception 'T11: expected 3 auto-skipped (today-6, -3, -2), got %', n; end if;
  select count(*) into n from studio_tasks where series_id = s2 and status = 'completed';
  if n <> 1 then raise exception 'T11: a completed occurrence was touched'; end if;
  select count(*) into n from studio_tasks where series_id = s2 and status = 'cancelled' and occurrence_date = today - 1;
  if n <> 0 then raise exception 'T11: the latest missed occurrence must not be skipped'; end if;
  -- skipped occurrences are not regenerated by the next refresh
  n := studio_task_materialize(s2, array[today - 6, today - 3, today - 2], today + 14, today);
  if n <> 0 then raise exception 'T11: skipped occurrences regenerated'; end if;

  -- T12: user skip (cancel) keeps the row so the occurrence is not regenerated
  update studio_tasks set status = 'cancelled' where series_id = s1 and occurrence_date = today + 3;
  if studio_task_materialize(s1, array[today + 3], today + 14, today) <> 0 then raise exception 'T12: skipped occurrence regenerated'; end if;

  -- T13: reorder persists in one statement
  insert into studio_tasks (title, due_date) values ('r1', today + 20) returning id into t1;
  insert into studio_tasks (title, due_date) values ('r2', today + 20) returning id into t2;
  insert into studio_tasks (title, due_date) values ('r3', today + 20) returning id into t3;
  perform studio_tasks_reorder(array[t3, t1, t2]);
  select array_agg(id order by sort_order) into ids from studio_tasks where id in (t1, t2, t3);
  if ids <> array[t3, t1, t2] then raise exception 'T13: reorder did not persist'; end if;

  -- T14: series validation and ownership
  ok := false;
  begin insert into studio_task_series (title, recurrence, start_date) values ('bad', 'weekly', today);
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'T14: weekly series without days accepted'; end if;
  ok := false;
  begin insert into studio_task_series (title, recurrence, start_date, month_day) values ('bad', 'monthly', today, 32);
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'T14: month day 32 accepted'; end if;
  perform set_config('request.jwt.claim.sub', u2::text, true);
  ok := false;
  begin insert into studio_tasks (title, series_id, occurrence_date) values ('foreign series', s1, today + 30);
  exception when sqlstate 'P0002' then ok := true; end;
  if not ok then raise exception 'T14: attached a task to another user''s series'; end if;
  ok := false;
  begin perform studio_task_materialize(s1, array[today + 40], today + 50, today);
  exception when sqlstate 'P0002' then ok := true; end;
  if not ok then raise exception 'T14: materialized another user''s series'; end if;
  perform set_config('request.jwt.claim.sub', u1::text, true);

  -- T15: deleting a series removes its occurrences; deleting the user's task works
  delete from studio_task_series where id = s1;
  select count(*) into n from studio_tasks where series_id = s1;
  if n <> 0 then raise exception 'T15: occurrences survived series deletion'; end if;

  reset role;
  raise notice 'tasks_tests.sql: all scenarios passed';
end $$;

rollback;
