-- KairFlow Intelligence - Phase 7 shadow-mode metrics pack (READ-ONLY).
--
-- STATUS: NOT EXECUTED against a live database (Phase 7 session had no database). Every query below is a plain SELECT. A repository test
-- (test_phase7_production_validation.py) checks that this file contains no write/DDL statement and that every table and column named in a
-- "-- uses:" line exists in the migrations. It cannot prove the SQL parses on your Postgres version, so run the queries one at a time.
--
-- HOW TO RUN: Supabase dashboard -> SQL editor, as the project owner. The editor runs as the postgres role, so row-level security does not
-- hide rows; Studio Kairegi has one Intelligence organization, so the numbers are not mixed across tenants. Change the interval in each
-- query to widen or narrow the window.
--
-- WHAT THESE CANNOT TELL YOU: qualification accuracy, draft quality, research accuracy and inbound-classification accuracy need a human
-- judgement. Queries 9, 12 and 13 export random samples for you to label; the labelling method is in PRODUCTION_READINESS_REPORT.md.
-- AI "cost" is a request count: the worker is configured for the free tier and has no billing path, so there is no money figure to read.

-- 1. Successful vs failed vs dead jobs, by kind (last 7 days)
-- uses: intel_jobs(kind, state, created_at)
select kind, state, count(*) as jobs
  from public.intel_jobs
 where created_at >= now() - interval '7 days'
 group by kind, state
 order by kind, state;

-- 2. Job processing time per kind, successful jobs only (the worker stores duration_ms in result._run)
-- uses: intel_jobs(kind, state, result, finished_at)
select kind,
       count(*) as jobs,
       round(percentile_cont(0.5)  within group (order by (result -> '_run' ->> 'duration_ms')::numeric)) as p50_ms,
       round(percentile_cont(0.95) within group (order by (result -> '_run' ->> 'duration_ms')::numeric)) as p95_ms,
       max((result -> '_run' ->> 'duration_ms')::numeric) as max_ms
  from public.intel_jobs
 where state = 'succeeded'
   and finished_at >= now() - interval '7 days'
   and (result -> '_run' ->> 'duration_ms') is not null
 group by kind
 order by kind;

-- 3. Model calls served per provider, and how many Ollama calls were fallbacks although Gemini was intended (from the same _run block)
-- uses: intel_jobs(kind, state, result, finished_at)
select kind,
       count(*) as jobs_with_model_calls,
       sum(coalesce((result -> '_run' -> 'ai_calls' ->> 'gemini')::int, 0))    as gemini_calls,
       sum(coalesce((result -> '_run' -> 'ai_calls' ->> 'ollama')::int, 0))    as ollama_calls,
       sum(coalesce((result -> '_run' -> 'ai_calls' ->> 'fallbacks')::int, 0)) as fallback_calls
  from public.intel_jobs
 where finished_at >= now() - interval '7 days'
   and (result -> '_run' -> 'ai_calls') is not null
 group by kind
 order by kind;

-- 4. Stuck work: queued long past its run time, running with an expired lease, and dead jobs (each needs a person or a requeue)
-- uses: intel_jobs(id, kind, state, run_after, lease_until, attempts, max_attempts, last_error, updated_at)
select id, kind, state, run_after, lease_until, attempts, max_attempts, left(coalesce(last_error, ''), 160) as last_error, updated_at
  from public.intel_jobs
 where (state = 'queued'  and run_after < now() - interval '30 minutes')
    or (state = 'running' and lease_until is not null and lease_until < now())
    or (state in ('dead', 'failed'))
 order by updated_at desc
 limit 100;

-- 5. Retry behaviour: how many jobs needed more than one attempt (last 7 days)
-- uses: intel_jobs(kind, state, attempts, created_at)
select kind, attempts, state, count(*) as jobs
  from public.intel_jobs
 where created_at >= now() - interval '7 days' and attempts > 1
 group by kind, attempts, state
 order by kind, attempts;

-- 6. Prospects discovered per day and campaign (the denominator for every quality ratio)
-- uses: intel_prospects(type, status, created_at)
select date_trunc('day', created_at)::date as day, type, count(*) as prospects
  from public.intel_prospects
 where created_at >= now() - interval '14 days'
 group by 1, type
 order by 1 desc, type;

-- 7. Where prospects sit now, by campaign and status
-- uses: intel_prospects(type, status)
select type, status, count(*) as prospects
  from public.intel_prospects
 group by type, status
 order by type, status;

-- 8. Duplicate rate: prospects that share a website domain with another prospect (indie developers with several games are expected here;
--    review the rows before treating them as errors)
-- uses: intel_prospects(domain, type, name, canonical_key, status)
with d as (
  select domain, count(*) as n from public.intel_prospects where coalesce(domain, '') <> '' group by domain having count(*) > 1
)
select p.domain, p.type, p.name, p.canonical_key, p.status
  from public.intel_prospects p join d on d.domain = p.domain
 order by p.domain, p.name
 limit 200;

-- 8b. The duplicate-rate figure itself (a join, not a subquery inside FILTER: PostgreSQL rejects subqueries in an aggregate FILTER clause)
-- uses: intel_prospects(domain)
with p as (
  select domain from public.intel_prospects where coalesce(domain, '') <> ''
), shared as (
  select domain from p group by domain having count(*) > 1
)
select count(*) filter (where shared.domain is not null)::numeric / nullif(count(*), 0) as share_of_prospects_in_a_shared_domain
  from p left join shared on shared.domain = p.domain;

-- 9. Research completeness, plus a random sample of 20 reports for a human accuracy review (compare each against its source URLs)
-- uses: intel_prospects(id, type, name, website, status, facts)
select count(*) as researched,
       count(*) filter (where facts -> 'verified' -> 'research_report' ->> 'error' is not null) as report_failed,
       count(*) filter (where jsonb_array_length(coalesce(facts -> 'verified' -> 'research_report' -> 'confirmed_facts', '[]'::jsonb)) = 0) as no_confirmed_facts,
       count(*) filter (where jsonb_array_length(coalesce(facts -> 'verified' -> 'research_report' -> 'sources', '[]'::jsonb)) = 0) as no_sources
  from public.intel_prospects
 where facts -> 'verified' -> 'research_report' is not null;

-- 9b. Sample for human review
-- uses: intel_prospects(id, type, name, website, status, facts)
select id, type, name, website, status,
       facts -> 'verified' -> 'research_report' ->> 'summary' as summary,
       facts -> 'verified' -> 'research_report' -> 'gaps' as gaps
  from public.intel_prospects
 where facts -> 'verified' -> 'research_report' is not null
 order by random()
 limit 20;

-- 10. Drafts and messages by kind and state (shadow mode expects drafts and pending_approval, and NO sent rows)
-- uses: intel_messages(direction, kind, state, created_at)
select direction, kind, state, count(*) as messages
  from public.intel_messages
 where created_at >= now() - interval '14 days'
 group by direction, kind, state
 order by direction, kind, state;

-- 11. SAFETY: any outbound message that reached reserved/sending/sent/unknown. During shadow mode and draft-only tests this must return no rows.
-- uses: intel_messages(id, direction, kind, state, to_email, sent_at, reserved_at, auto_sent, provider_key)
select id, kind, state, to_email, reserved_at, sent_at, auto_sent, provider_key
  from public.intel_messages
 where direction = 'outbound' and (state in ('reserved', 'sending', 'sent', 'unknown') or sent_at is not null)
 order by coalesce(sent_at, reserved_at) desc
 limit 100;

-- 12. Inbound classification mix, and a random sample of 30 for a human accuracy review
-- uses: intel_messages(direction, classification, classification_confidence, created_at)
select coalesce(classification, '(unclassified)') as classification, count(*) as inbound, round(avg(classification_confidence)::numeric, 2) as avg_confidence
  from public.intel_messages
 where direction = 'inbound' and created_at >= now() - interval '30 days'
 group by 1
 order by 2 desc;

-- 12b. Sample for human review
-- uses: intel_messages(id, classification, classification_confidence, summary, subject, received_at, direction)
select id, classification, classification_confidence, summary, left(subject, 100) as subject, received_at
  from public.intel_messages
 where direction = 'inbound'
 order by random()
 limit 30;

-- 13. Follow-up progress: outbound follow-up drafts by step and state
-- uses: intel_messages(direction, kind, step, state)
select kind, step, state, count(*) as messages
  from public.intel_messages
 where direction = 'outbound' and kind <> 'initial'
 group by kind, step, state
 order by kind, step, state;

-- 14. Agent Chat provider attribution and latency (every assistant reply stores its provider, model, route reason and latency)
-- uses: intel_chat_messages(role, ai_provider, ai_route_reason, ai_latency_ms, created_at)
select coalesce(ai_provider, '(none recorded)') as provider,
       coalesce(ai_route_reason, '') as route_reason,
       count(*) as replies,
       round(percentile_cont(0.5)  within group (order by ai_latency_ms)) as p50_ms,
       round(percentile_cont(0.95) within group (order by ai_latency_ms)) as p95_ms
  from public.intel_chat_messages
 where role = 'assistant' and created_at >= now() - interval '7 days'
 group by 1, 2
 order by replies desc;

-- 15. Worker availability: last heartbeat and the counters the worker publishes (counters reset when the worker restarts)
-- uses: intel_worker_heartbeat(worker_id, last_seen, info)
select worker_id, last_seen, now() - last_seen as silent_for,
       info ->> 'jobs_succeeded' as jobs_succeeded, info ->> 'jobs_failed' as jobs_failed,
       info ->> 'started_at' as started_at, info ->> 'last_job_error' as last_job_error, info ->> 'scheduler_error' as scheduler_error
  from public.intel_worker_heartbeat
 order by last_seen desc;

-- 16. SAFETY STATE: sending must be off (kill_switch true) and autonomy 'shadow' until you approve a rollout stage
-- uses: intel_settings(kill_switch, autonomy, daily_initial_cap, daily_followup_cap, updated_at)
select kill_switch, autonomy, daily_initial_cap, daily_followup_cap, updated_at
  from public.intel_settings;

-- 17. SAFETY STATE: which provider accounts are allowed to send (none during shadow mode and draft-only tests)
-- uses: intel_provider_accounts(provider_key, mailbox, status, is_enabled, send_enabled, daily_send_limit)
select provider_key, mailbox, status, is_enabled, send_enabled, daily_send_limit
  from public.intel_provider_accounts
 order by provider_key, mailbox;

-- 17b. SAFETY STATE: the provider-level send gate (shared with the Email module; sending_enabled must be false until a rollout stage allows it)
-- uses: intel_email_provider_registry(provider_key, enabled, sending_enabled, updated_at)
select provider_key, enabled, sending_enabled, updated_at
  from public.intel_email_provider_registry
 order by provider_key;

-- 18. Suppression list size by kind (outreach must never reach these)
-- uses: intel_suppressions(kind, reason, created_at)
select kind, count(*) as suppressions, max(created_at) as latest
  from public.intel_suppressions
 group by kind
 order by kind;

-- 19. PRIVILEGES (live check of the model the repository tests replay from the migration files): Intelligence functions that anon or PUBLIC can
--     execute. Must return NO rows. has_function_privilege('anon', ...) also reports privileges inherited from PUBLIC.
-- uses: (system catalogs only; no application table)
select p.oid::regprocedure as function_signature
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and (p.proname like 'intel\_%' or p.proname like '\_intel\_%')
   and has_function_privilege('anon', p.oid, 'execute')
 order by 1;

-- 20. PRIVILEGES: private helpers and the two service-role-only functions that a signed-in user can still execute. Must return NO rows once
--     migration 20270105090000 is applied (before it, the two service-role-only functions are expected to appear here).
-- uses: (system catalogs only; no application table)
select p.oid::regprocedure as function_signature
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and (p.proname like '\_intel\_%' or p.proname in ('intel_resend_record_inbound', 'intel_agent_apply_delivery_event'))
   and has_function_privilege('authenticated', p.oid, 'execute')
 order by 1;
