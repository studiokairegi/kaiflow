-- Phase 13 READ-ONLY diagnostics. Run in Supabase SQL editor as an authorized
-- database operator. This script contains SELECTs only; it does not delete,
-- update, vacuum, reindex, or change retention settings.

-- 1) Approximate table and index footprint for Intelligence tables.
select n.nspname as schema_name, c.relname as table_name,
       pg_size_pretty(pg_relation_size(c.oid)) as heap_size,
       pg_size_pretty(pg_indexes_size(c.oid)) as indexes_size,
       pg_size_pretty(pg_total_relation_size(c.oid)) as total_size,
       coalesce(s.n_live_tup, 0) as estimated_live_rows,
       coalesce(s.n_dead_tup, 0) as estimated_dead_rows,
       s.last_vacuum, s.last_autovacuum, s.last_analyze, s.last_autoanalyze
from pg_class c join pg_namespace n on n.oid = c.relnamespace
left join pg_stat_user_tables s on s.relid = c.oid
where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'intel_%'
order by pg_total_relation_size(c.oid) desc;

-- 2) Evidence age distribution. No rows or snippets are exported.
select date_trunc('month', fetched_at) as evidence_month, count(*) as rows,
       count(*) filter (where verified) as verified_rows,
       count(*) filter (where not verified) as unverified_rows
from public.intel_evidence
group by 1 order by 1;

-- 3) Evidence associated with prospect status; the existing 45-day prune
-- routine targets rejected/suppressed prospects. This is diagnostic only.
select p.status, count(*) as evidence_rows,
       min(e.fetched_at) as oldest_evidence, max(e.fetched_at) as newest_evidence
from public.intel_evidence e join public.intel_prospects p on p.id = e.prospect_id
group by p.status order by evidence_rows desc;

-- 4) Message age/state distribution. Message bodies and addresses are omitted.
select direction, state, kind, date_trunc('month', created_at) as created_month, count(*) as rows
from public.intel_messages
group by direction, state, kind, date_trunc('month', created_at)
order by created_month, direction, state, kind;

-- 5) Job lifecycle distribution. Includes terminal jobs subject to the current
-- 14-day cleanup in intel_agent_prune; diagnostic only.
select state, kind, date_trunc('month', created_at) as created_month, count(*) as rows,
       min(finished_at) as oldest_finished, max(finished_at) as newest_finished
from public.intel_jobs
group by state, kind, date_trunc('month', created_at)
order by created_month, state, kind;

-- 6) Index usage for Intelligence tables; low scans alone do not justify drops.
select schemaname, relname as table_name, indexrelname as index_name,
       idx_scan, idx_tup_read, idx_tup_fetch,
       pg_size_pretty(pg_relation_size(indexrelid)) as index_size
from pg_stat_user_indexes
where schemaname = 'public' and relname like 'intel_%'
order by pg_relation_size(indexrelid) desc;
