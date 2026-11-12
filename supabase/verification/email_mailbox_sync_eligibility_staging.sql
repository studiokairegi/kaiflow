-- Round 7 / 7.1 / 7.2 STAGING RELEASE GATE: mailbox sync eligibility truth table and ineligible-release behavior.
-- Run on STAGING ONLY, after applying 20261229100000, 20261229110000 and 20261229120000, with:
--   psql "$STAGING_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/verification/email_mailbox_sync_eligibility_staging.sql
-- The whole script runs inside one transaction that ALWAYS ends in ROLLBACK, so nothing persists.
-- Inside that transaction it enables provider capability flags and disables other organizations'
-- Intelligence accounts so the 25-row selector limit cannot hide the fixtures. Those changes roll back too.
-- Requirements: at least one row in auth.users. If a fixture insert fails on a check constraint, fix the
-- fixture, never the migration, and re-run. A non-zero exit status means the gate FAILED.
begin;

create temp table ctx(org uuid) on commit drop;
create temp table truth(section text, scenario text, expected text, actual text, pass boolean) on commit drop;

create function pg_temp.check_eq(p_section text, p_scenario text, p_expected text, p_actual text) returns void
language sql as $$ insert into truth values (p_section, p_scenario, p_expected, p_actual, p_expected is not distinct from p_actual) $$;

do $$
declare v_user uuid; v_org uuid;
begin
  select id into v_user from auth.users order by created_at limit 1;
  if v_user is null then raise exception 'staging needs at least one auth.users row for the fixture organization'; end if;
  insert into public.studio_organizations(name, slug, created_by)
    values ('r7-1 staging gate', 'r7-1-gate-' || substr(replace(gen_random_uuid()::text,'-',''),1,12), v_user) returning id into v_org;
  insert into ctx values (v_org);
  -- Isolate fixtures from real data: no other account may compete for selector slots.
  update public.intel_provider_accounts set is_enabled = false where organization_id <> v_org and is_enabled;
  -- Open every gate; each scenario then closes exactly one.
  insert into public.intel_email_provider_registry(provider_key, adapter_key, display_name, enabled)
    values ('smtp','smtp','SMTP / IMAP',true)
    on conflict (provider_key) do update set enabled = true;
  update public.intel_email_provider_registry set enabled = true where provider_key in ('gmail','zoho');
  update public.email_provider_registry
     set enabled = true, capabilities = capabilities || '{"remote_sync":true}'::jsonb
   where provider_key in ('gmail','zoho','smtp');
end $$;

-- Fixture factory. The projection trigger creates the matching public.email_accounts row.
create function pg_temp.mk(p_provider text, p_tag text) returns uuid
language plpgsql as $$
declare v_id uuid;
begin
  insert into public.intel_provider_accounts(organization_id, provider_key, mailbox, auth_method, credentials_ciphertext, status, is_enabled)
    values ((select org from ctx), p_provider, p_tag || '-' || substr(replace(gen_random_uuid()::text,'-',''),1,8) || '@staging-gate.test',
            'oauth2', 'staging-fixture', 'connected', true) returning id into v_id;
  return v_id;
end $$;
create function pg_temp.elig(p_id uuid) returns text language sql as $$ select public.email_mailbox_sync_account_eligible(p_id)::text $$;
create function pg_temp.listed(p_id uuid) returns text language sql as $$
  select exists(select 1 from public.email_list_sync_accounts(25) l where l.id = p_id)::text $$;

-- ===== Section A: eligibility truth table =====
do $$
declare a uuid;
begin
  -- A1 either registry disabled
  a := pg_temp.mk('gmail','a1');
  update public.intel_email_provider_registry set enabled = false where provider_key = 'gmail';
  perform pg_temp.check_eq('A','Intelligence provider registry disabled -> ineligible','false',pg_temp.elig(a));
  update public.intel_email_provider_registry set enabled = true where provider_key = 'gmail';
  update public.email_provider_registry set enabled = false where provider_key = 'gmail';
  perform pg_temp.check_eq('A','Email provider registry disabled -> ineligible','false',pg_temp.elig(a));
  update public.email_provider_registry set enabled = true where provider_key = 'gmail';
  update public.email_provider_registry set capabilities = capabilities || '{"remote_sync":false}'::jsonb where provider_key = 'gmail';
  perform pg_temp.check_eq('A','remote_sync capability false -> ineligible','false',pg_temp.elig(a));
  update public.email_provider_registry set capabilities = capabilities || '{"remote_sync":true}'::jsonb where provider_key = 'gmail';
  perform pg_temp.check_eq('A','control: gates restored -> eligible','true',pg_temp.elig(a));

  -- A2 Intelligence account disabled
  a := pg_temp.mk('gmail','a2');
  update public.intel_provider_accounts set is_enabled = false where id = a;
  perform pg_temp.check_eq('A','Intelligence account disabled -> ineligible','false',pg_temp.elig(a));

  -- A3 account disconnected (through the Intelligence row, which projects to the Email row, then directly)
  a := pg_temp.mk('zoho','a3');
  update public.intel_provider_accounts set status = 'disconnected' where id = a;
  perform pg_temp.check_eq('A','Account disconnected via Intelligence status -> ineligible','false',pg_temp.elig(a));
  a := pg_temp.mk('gmail','a3b');
  update public.email_accounts set connection_status = 'disconnected' where id = a;
  perform pg_temp.check_eq('A','Account disconnected on Email row -> ineligible','false',pg_temp.elig(a));

  -- A4 mailbox addresses mismatch
  a := pg_temp.mk('gmail','a4');
  update public.email_accounts set address = 'someone-else@staging-gate.test' where id = a;
  perform pg_temp.check_eq('A','Mailbox addresses mismatch -> ineligible','false',pg_temp.elig(a));

  -- A5 SMTP account, every gate otherwise open
  a := pg_temp.mk('smtp','a5');
  perform pg_temp.check_eq('A','SMTP account -> ineligible','false',pg_temp.elig(a));

  -- A6 live lease
  a := pg_temp.mk('gmail','a6');
  insert into public.email_sync_state(account_id, organization_id, lease_token, lease_expires_at)
    values (a, (select org from ctx), gen_random_uuid(), now() + interval '1 hour');
  perform pg_temp.check_eq('A','Live lease -> still eligible','true',pg_temp.elig(a));
  perform pg_temp.check_eq('A','Live lease -> not selectable','false',pg_temp.listed(a));

  -- A7 expired lease
  a := pg_temp.mk('gmail','a7');
  insert into public.email_sync_state(account_id, organization_id, lease_token, lease_expires_at)
    values (a, (select org from ctx), gen_random_uuid(), now() - interval '1 minute');
  perform pg_temp.check_eq('A','Expired lease -> selectable','true',pg_temp.listed(a));

  -- A8 future retry
  a := pg_temp.mk('gmail','a8');
  insert into public.email_sync_state(account_id, organization_id, next_retry_at)
    values (a, (select org from ctx), now() + interval '1 hour');
  perform pg_temp.check_eq('A','Future retry time -> not selectable','false',pg_temp.listed(a));

  -- A9 everything satisfied
  a := pg_temp.mk('gmail','a9');
  perform pg_temp.check_eq('A','All eligibility gates satisfied -> eligible','true',pg_temp.elig(a));
  perform pg_temp.check_eq('A','All eligibility gates satisfied -> selectable','true',pg_temp.listed(a));
end $$;

-- ===== Section B: Round 7.1 ineligible release =====
do $$
declare a uuid; c jsonb; tok uuid; st public.email_sync_state; run_status text;
begin
  a := pg_temp.mk('gmail','b1');
  c := public.email_claim_sync(a, 180);
  tok := (c->>'lease_token')::uuid;
  perform pg_temp.check_eq('B','claim succeeds while eligible','true',c->>'claimed');
  -- Existing failure history and an unrelated retry state that must survive the release.
  update public.email_sync_state set consecutive_failures = 3, last_error = 'prior provider error',
         cursor = '{"history":"42"}'::jsonb where account_id = a;
  update public.intel_provider_accounts set is_enabled = false where id = a;

  perform pg_temp.check_eq('B','renew refused after eligibility loss','false',public.email_renew_sync(a, tok, 180)::text);
  perform pg_temp.check_eq('B','checkpoint commit refused after eligibility loss','false',public.email_commit_sync_checkpoint(a, tok, '{"history":"99"}'::jsonb, 1, 1)::text);
  perform pg_temp.check_eq('B','finish refused after eligibility loss','false',public.email_finish_sync(a, tok, 1, 1, 1, 0, false)::text);
  select * into st from public.email_sync_state where account_id = a;
  perform pg_temp.check_eq('B','refused checkpoint did not advance cursor','{"history": "42"}',st.cursor::text);
  perform pg_temp.check_eq('B','lease still held until explicit release','true',(st.lease_token = tok)::text);

  perform pg_temp.check_eq('B','wrong token cannot release','false',public.email_release_sync_ineligible(a, gen_random_uuid())::text);
  perform pg_temp.check_eq('B','release succeeds for holder of an ineligible account','true',public.email_release_sync_ineligible(a, tok)::text);
  select * into st from public.email_sync_state where account_id = a;
  perform pg_temp.check_eq('B','lease cleared','true',(st.lease_token is null and st.lease_expires_at is null)::text);
  perform pg_temp.check_eq('B','consecutive_failures preserved','3',st.consecutive_failures::text);
  perform pg_temp.check_eq('B','no retry delay introduced','true',(st.next_retry_at is null)::text);
  perform pg_temp.check_eq('B','last_error preserved','prior provider error',st.last_error);
  perform pg_temp.check_eq('B','cursor preserved','{"history": "42"}',st.cursor::text);
  select status into run_status from public.email_sync_runs where account_id = a order by started_at desc limit 1;
  perform pg_temp.check_eq('B','run row closed as skipped, not failed','skipped',run_status);
  perform pg_temp.check_eq('B','second release is a no-op','false',public.email_release_sync_ineligible(a, tok)::text);

  -- Re-enable: normal selection per existing retry state; failure history still intact.
  update public.intel_provider_accounts set is_enabled = true where id = a;
  perform pg_temp.check_eq('B','re-enabled account is selectable immediately','true',pg_temp.listed(a));
  c := public.email_claim_sync(a, 180);
  perform pg_temp.check_eq('B','re-enabled account can be claimed','true',c->>'claimed');
  perform pg_temp.check_eq('B','claim still reports preserved failure count','3',c->>'consecutive_failures');

  -- Release must not act on an eligible account.
  a := pg_temp.mk('gmail','b2');
  c := public.email_claim_sync(a, 180);
  tok := (c->>'lease_token')::uuid;
  perform pg_temp.check_eq('B','release is a no-op on an eligible account','false',public.email_release_sync_ineligible(a, tok)::text);
  perform pg_temp.check_eq('B','eligible account keeps its lease','true',((select lease_token from public.email_sync_state where account_id = a) = tok)::text);

  -- Existing unrelated retry state survives: a future retry stays in force after release and re-enable.
  a := pg_temp.mk('gmail','b3');
  c := public.email_claim_sync(a, 180);
  tok := (c->>'lease_token')::uuid;
  update public.email_sync_state set next_retry_at = now() + interval '2 hours' where account_id = a;
  update public.intel_provider_accounts set is_enabled = false where id = a;
  perform pg_temp.check_eq('B','release succeeds with unrelated retry state','true',public.email_release_sync_ineligible(a, tok)::text);
  update public.intel_provider_accounts set is_enabled = true where id = a;
  perform pg_temp.check_eq('B','unrelated future retry still blocks selection after re-enable','false',pg_temp.listed(a));
  perform pg_temp.check_eq('B','unrelated future retry unchanged by release','true',((select next_retry_at from public.email_sync_state where account_id = a) > now() + interval '1 hour')::text);

  -- Genuine failures still use email_fail_sync and still back off.
  a := pg_temp.mk('gmail','b4');
  c := public.email_claim_sync(a, 180);
  tok := (c->>'lease_token')::uuid;
  perform pg_temp.check_eq('B','email_fail_sync still records genuine failures','true',public.email_fail_sync(a, tok, 'provider outage', null)::text);
  select * into st from public.email_sync_state where account_id = a;
  perform pg_temp.check_eq('B','genuine failure increments counter','1',st.consecutive_failures::text);
  perform pg_temp.check_eq('B','genuine failure sets backoff','true',(st.next_retry_at > now())::text);
end $$;

-- ===== Section C: Round 7.2 orphaned run rows =====
do $$
declare a uuid; c jsonb; old_run uuid; st public.email_sync_state; r public.email_sync_runs; running_n integer;
begin
  a := pg_temp.mk('gmail','c1');
  c := public.email_claim_sync(a, 180);
  select id into old_run from public.email_sync_runs where account_id = a and status = 'running';
  -- Simulate a crashed worker: the lease dies, no finish/fail/release ever runs.
  update public.email_sync_state set lease_expires_at = now() - interval '1 minute' where account_id = a;
  c := public.email_claim_sync(a, 180);
  perform pg_temp.check_eq('C','new claim succeeds after a crashed run','true',c->>'claimed');
  select * into r from public.email_sync_runs where id = old_run;
  perform pg_temp.check_eq('C','orphaned run closed as failed','failed',r.status);
  perform pg_temp.check_eq('C','orphaned run has a fixed safe message','Run was interrupted before completion',r.safe_error);
  perform pg_temp.check_eq('C','orphaned run has a finish time','true',(r.finished_at is not null)::text);
  select count(*) into running_n from public.email_sync_runs where account_id = a and status = 'running' and finished_at is null;
  perform pg_temp.check_eq('C','exactly one run is running after the new claim','1',running_n::text);
  select * into st from public.email_sync_state where account_id = a;
  perform pg_temp.check_eq('C','closing an orphan does not touch the failure counter','0',st.consecutive_failures::text);
  perform pg_temp.check_eq('C','closing an orphan does not set a retry delay','true',(st.next_retry_at is null)::text);

  -- A live lease must never have its run closed by a refused claim.
  c := public.email_claim_sync(a, 180);
  perform pg_temp.check_eq('C','claim refused while a live lease exists','sync_in_progress',c->>'reason');
  select count(*) into running_n from public.email_sync_runs where account_id = a and status = 'running' and finished_at is null;
  perform pg_temp.check_eq('C','refused claim leaves the live run untouched','1',running_n::text);
end $$;

-- Section C2: cleanup boundaries. Other accounts, checkpoint data and already-closed runs are untouched.
do $$
declare a uuid; b uuid; c jsonb; b_run uuid; a_old uuid; a_cur uuid; r public.email_sync_runs; st public.email_sync_state; n integer;
begin
  a := pg_temp.mk('gmail','c2a');
  b := pg_temp.mk('gmail','c2b');
  -- Account B holds a live lease and a running run that account A's cleanup must never touch.
  c := public.email_claim_sync(b, 180);
  select id into b_run from public.email_sync_runs where account_id = b and status = 'running';
  -- Account A crashes once, with a checkpoint already committed.
  c := public.email_claim_sync(a, 180);
  select id into a_old from public.email_sync_runs where account_id = a and status = 'running';
  update public.email_sync_state set cursor = '{"history":"77"}'::jsonb, lease_expires_at = now() - interval '1 minute' where account_id = a;
  c := public.email_claim_sync(a, 180);
  select id into a_cur from public.email_sync_runs where account_id = a and status = 'running';
  perform pg_temp.check_eq('C2','other account run is not closed','running',(select status from public.email_sync_runs where id = b_run));
  perform pg_temp.check_eq('C2','other account run keeps no finish time','true',((select finished_at from public.email_sync_runs where id = b_run) is null)::text);
  perform pg_temp.check_eq('C2','current run is a new run, not the closed one','true',(a_cur is not null and a_cur <> a_old)::text);
  perform pg_temp.check_eq('C2','current run stays running','running',(select status from public.email_sync_runs where id = a_cur));
  perform pg_temp.check_eq('C2','checkpoint data unchanged by cleanup','{"history": "77"}',(select cursor::text from public.email_sync_state where account_id = a));
  -- Mark the closed run, crash again, claim again: the already-closed row must not be modified a second time.
  update public.email_sync_runs set safe_error = 'marker-set-after-close' where id = a_old;
  update public.email_sync_state set lease_expires_at = now() - interval '1 minute' where account_id = a;
  c := public.email_claim_sync(a, 180);
  perform pg_temp.check_eq('C2','already-closed run is not modified by a later claim','marker-set-after-close',(select safe_error from public.email_sync_runs where id = a_old));
  perform pg_temp.check_eq('C2','second orphan closed too','failed',(select status from public.email_sync_runs where id = a_cur));
  select count(*) into n from public.email_sync_runs where account_id = a and status = 'running' and finished_at is null;
  perform pg_temp.check_eq('C2','still exactly one running run','1',n::text);
end $$;

-- ===== Report and gate =====
select section, scenario, expected, actual, case when pass then 'PASS' else 'FAIL' end as result from truth order by section, ctid;

do $$
declare failed integer; total integer;
begin
  select count(*) filter (where not pass), count(*) into failed, total from truth;
  if total < 30 then raise exception 'gate incomplete: only % checks were recorded', total; end if;
  if failed > 0 then raise exception 'STAGING GATE FAILED: % of % checks did not match', failed, total; end if;
  raise notice 'STAGING GATE PASSED: % of % checks matched', total - failed, total;
end $$;

rollback;
