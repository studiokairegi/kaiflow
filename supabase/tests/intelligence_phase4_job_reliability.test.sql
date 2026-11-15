-- Phase 4 job settlement (20270103090000) against real Postgres. Same fixture conventions as intelligence_phase3_chat_provenance.test.sql
-- (AGENT ...f0, orgA, helpers ti.as_user / ti.as_super / ti.ok).
-- NOT EXECUTED where this file was written (no PostgreSQL available there): run it, after the full migration chain, before trusting the migration.
-- REQUIRES the fixtures and the ti.* helpers created by intelligence_authorization.test.sql (run_intelligence_auth.sh builds that database); it is
-- not yet wired into that script (a Phase 7 task). run_intelligence_phase4.sh is a thin wrapper for a database that already has them.
do $$
declare
  AGENT uuid := '00000000-0000-0000-0000-0000000000f0';
  j uuid; r text; b boolean; s text;
begin
  perform ti.as_user(AGENT);
  j := intel_agent_enqueue_job('retention', '{}'::jsonb, 'phase4-test-1', now(), 0);
  perform ti.ok(j is not null, 'job enqueued');
  perform ti.ok((intel_agent_claim_job('w-test', null, 300) ->> 'id')::uuid = j, 'job claimed by w-test');

  -- completion: first call true, repeat by the same worker true (idempotent), by another worker false
  b := intel_agent_complete_job(j, 'w-test', '{"ok":true}'::jsonb);
  perform ti.ok(b is true, 'first completion returns true');
  b := intel_agent_complete_job(j, 'w-test', '{"ok":true}'::jsonb);
  perform ti.ok(b is true, 'repeat completion by the same worker is idempotent (true)');
  b := intel_agent_complete_job(j, 'w-other', '{"ok":true}'::jsonb);
  perform ti.ok(b is false, 'completion by a different worker is refused');

  -- THE BUG: a late failure report must not resurrect a succeeded job
  r := intel_agent_fail_job(j, 'w-test', 'transient: late report', 60);
  perform ti.ok(r = 'not_owner', 'fail_job on a succeeded job returns not_owner');
  perform ti.as_super();
  select state into s from intel_jobs where id = j;
  perform ti.ok(s = 'succeeded', 'the succeeded job stays succeeded (was: reset to queued and re-run)');

  -- normal failure path still works and still goes dead at max_attempts
  perform ti.as_user(AGENT);
  j := intel_agent_enqueue_job('retention', '{}'::jsonb, 'phase4-test-2', now(), 0);
  perform intel_agent_claim_job('w-test', null, 300);
  r := intel_agent_fail_job(j, 'w-test', 'transient: x', 30);
  perform ti.ok(r = 'queued', 'first failure re-queues');
  perform ti.as_super();
  update intel_jobs set run_after = now(), max_attempts = 1 where id = j;
  perform ti.as_user(AGENT);
  perform intel_agent_claim_job('w-test', null, 300);
  r := intel_agent_fail_job(j, 'w-test', 'transient: y', 30);
  perform ti.ok(r = 'dead', 'failure at max_attempts is dead');
  r := intel_agent_fail_job(j, 'w-test', 'transient: y again', 30);
  perform ti.ok(r = 'not_owner', 'a second failure report on a dead job changes nothing');

  -- ownership is still required
  j := intel_agent_enqueue_job('retention', '{}'::jsonb, 'phase4-test-3', now(), 0);
  perform intel_agent_claim_job('w-test', null, 300);
  r := intel_agent_fail_job(j, 'w-intruder', 'x', 30);
  perform ti.ok(r = 'not_owner', 'another worker cannot fail a job it does not own');
end $$;
