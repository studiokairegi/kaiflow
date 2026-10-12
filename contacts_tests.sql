-- =============================================================================
-- Contacts & Clients database tests. Run AFTER
-- supabase/migrations/20261012120000_contacts_clients.sql, in the Supabase SQL
-- editor (as postgres). Runs in a transaction that is rolled back, with
-- throwaway users, so it leaves no data behind.
--
-- NOT EXECUTED BY THE AUTHOR: written without access to a Postgres instance.
-- A failing step raises an exception naming the scenario. Fix forward, don't skip.
-- =============================================================================
begin;

do $$
declare
  u1 uuid := gen_random_uuid(); u2 uuid := gen_random_uuid();
  r jsonb; c1 uuid; c2 uuid; other uuid; lead1 uuid; lead2 uuid; lead3 uuid; proj uuid; proj2 uuid;
  n int; ok boolean; s text; cid uuid;
begin
  insert into auth.users (id, email, aud, role) values (u1, 'ct1@example.invalid', 'authenticated', 'authenticated');
  insert into auth.users (id, email, aud, role) values (u2, 'ct2@example.invalid', 'authenticated', 'authenticated');
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', u2::text, true);
  other := (create_contact('Other Users Contact', 'shared@x.io')->'contact'->>'id')::uuid;

  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', u1::text, true);

  -- 1: create + validation
  r := create_contact('Vicente Carro', ' Vicente@Anime.IS ', '+354', 'Anime GenSys', 'Producer', null, 'n', 'prospect', 'reqkey-0001');
  c1 := (r->'contact'->>'id')::uuid;
  if not (r->>'created')::boolean then raise exception 'T1: expected created'; end if;
  if (select email_normalized from contacts where id = c1) <> 'vicente@anime.is' then raise exception 'T1: email not normalized'; end if;
  ok := false; begin perform create_contact('   '); exception when sqlstate 'P0001' then ok := true; end;
  if not ok then raise exception 'T9: blank name must be rejected'; end if;
  ok := false; begin perform create_contact('X', 'not-an-email'); exception when sqlstate 'P0001' then ok := true; end;
  if not ok then raise exception 'T9: bad email must be rejected'; end if;

  -- 7: repeated submission (same request key) and same email never duplicate
  r := create_contact('Vicente Carro', 'vicente@anime.is', null, null, null, null, null, 'prospect', 'reqkey-0001');
  if (r->>'created')::boolean or (r->'contact'->>'id')::uuid <> c1 then raise exception 'T7: same key must return the first row'; end if;
  r := create_contact('Vicente C.', 'VICENTE@anime.is', null, null, null, null, null, 'prospect', 'reqkey-0002');
  if (r->>'created')::boolean or not (r->>'duplicate')::boolean then raise exception 'T7: same email must reuse the existing contact'; end if;
  select count(*) into n from contacts where user_id = u1;
  if n <> 1 then raise exception 'T7: expected 1 contact, got %', n; end if;
  -- the hard guarantee holds even for direct inserts
  ok := false; begin insert into contacts (user_id, name, email) values (u1, 'Dup', 'vicente@anime.is'); exception when unique_violation then ok := true; end;
  if not ok then raise exception 'T7: unique email index missing'; end if;

  -- name alone is never merged: a same-name contact with a different email is a separate row
  r := create_contact('Vicente Carro', 'other@somewhere.com');
  if not (r->>'created')::boolean then raise exception 'T7b: same name, different email must create a separate contact'; end if;
  c2 := (r->'contact'->>'id')::uuid;
  if (select count(*) from find_contact_matches('Vicente Carro', null, null)) < 2 then raise exception 'T7b: look-alikes should be offered'; end if;

  -- 2/5: projects reference the contact by id; legacy client text preserved
  insert into projects (user_id, name, client, contact_id) values (u1, 'Trailer', 'Vicente Carro', c1) returning id into proj;
  if (select client from projects where id = proj) <> 'Vicente Carro' then raise exception 'T8: legacy client text lost'; end if;
  if (select relationship from contacts where id = c1) <> 'client' then raise exception 'T5: contact on a project should become a client'; end if;
  insert into projects (user_id, name, client, contact_id) values (u1, 'Second project', 'Vicente Carro', c1) returning id into proj2;
  select count(*) into n from projects where contact_id = c1;
  if n <> 2 then raise exception 'T1b: one contact must link to many projects'; end if;

  -- 9/ownership: another user's contact id cannot be attached
  ok := false; begin update projects set contact_id = other where id = proj; exception when sqlstate 'P0002' then ok := true; end;
  if not ok then raise exception 'T9: foreign contact must be rejected on projects'; end if;

  -- RLS isolation: u1 cannot see u2's contact
  -- (Run as postgres this bypasses RLS; verify isolation separately by running a select as an authenticated user.)

  -- 5: won deal with an existing LINKED contact reuses it (no new row)
  insert into leads (user_id, company_name, contact_person, email, stage, contact_id) values (u1, 'Anime GenSys', 'Vicente Carro', 'vicente@anime.is', 'negotiation', c1) returning id into lead1;
  update leads set stage = 'won' where id = lead1;
  if (select contact_id from leads where id = lead1) <> c1 then raise exception 'T5: won lead must keep its linked contact'; end if;
  select count(*) into n from contacts where user_id = u1;
  if n <> 2 then raise exception 'T5: no new contact expected, got %', n; end if;

  -- 5b: won deal with no link but a matching email links the existing contact
  insert into leads (user_id, company_name, contact_person, email, stage) values (u1, 'Anime GenSys', 'V. Carro', 'VICENTE@anime.is', 'proposal') returning id into lead2;
  update leads set stage = 'won' where id = lead2;
  if (select contact_id from leads where id = lead2) <> c1 then raise exception 'T5b: should link by normalized email'; end if;

  -- 6: won deal with no contact creates a client from the deal; repeated updates add nothing
  insert into leads (user_id, company_name, contact_person, email, website, stage) values (u1, 'Brand New Studio', 'Mia Chen', 'mia@brand.new', 'brand.new', 'proposal') returning id into lead3;
  update leads set stage = 'won' where id = lead3;
  cid := (select contact_id from leads where id = lead3);
  if cid is null then raise exception 'T6: contact should be created for the won deal'; end if;
  if (select relationship from contacts where id = cid) <> 'client' then raise exception 'T6: new contact should be a client'; end if;
  if (select name from contacts where id = cid) <> 'Mia Chen' or (select company from contacts where id = cid) <> 'Brand New Studio' then raise exception 'T6: contact details wrong'; end if;
  select count(*) into n from contacts where user_id = u1;
  update leads set stage = 'won', notes = 'edited again' where id = lead3;
  update leads set notes = 'and again' where id = lead3;
  update leads set stage = 'lost' where id = lead3;
  update leads set stage = 'won' where id = lead3;
  if (select count(*) from contacts where user_id = u1) <> n then raise exception 'T7: repeated won updates created duplicates'; end if;
  if (select contact_id from leads where id = lead3) <> cid then raise exception 'T7: lead link changed'; end if;

  -- 8: existing contact details are not overwritten by linking a won deal
  update contacts set phone = '+1 555' where id = cid;
  update leads set stage = 'closed' where id = lead3; update leads set stage = 'won' where id = lead3;
  if (select phone from contacts where id = cid) <> '+1 555' then raise exception 'T8: contact details overwritten'; end if;

  -- backfill: a pre-existing won lead (simulated by clearing its link) is repaired via explicit relationships only
  update leads set contact_id = null where id = lead3;
  update leads set linked_project_id = proj2 where id = lead1;
  update projects set contact_id = null where id = proj2;
  r := backfill_contacts_from_won_leads();
  if (r->>'leadsLinked')::int < 1 then raise exception 'backfill: expected leads linked'; end if;
  if (select contact_id from projects where id = proj2) is distinct from (select contact_id from leads where id = lead1) then raise exception 'backfill: project should link via linked_project_id'; end if;
  r := backfill_contacts_from_won_leads();
  if (r->>'leadsLinked')::int <> 0 then raise exception 'backfill: second run must be a no-op'; end if;

  -- deleting a contact never deletes projects or deals
  delete from contacts where id = c1;
  if not exists (select 1 from projects where id = proj) or not exists (select 1 from leads where id = lead1) then raise exception 'T8: delete cascaded into projects/leads'; end if;
  if (select contact_id from projects where id = proj) is not null then raise exception 'T8: link should be nulled'; end if;
end $$;

rollback;
select 'contacts_tests.sql finished (rolled back)' as result;
