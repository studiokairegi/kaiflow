-- READ-ONLY checks for your live Supabase database. Only SELECTs: nothing is created, changed or deleted.
-- Run in the Supabase SQL editor BEFORE applying the Intelligence migrations. Every row should say OK.
select 'is_admin self-escalation guard' as check,
       case when exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
                         where c.relname = 'user_settings' and t.tgname = 'trg_protect_privileged_user_settings' and not t.tgisinternal)
            then 'OK' else 'MISSING: apply migration_security_hardening.sql first' end as result
union all
select 'studio_memberships has role/status values the rule needs',
       case when exists (select 1 from studio_memberships where role = 'master_user' and status = 'active') then 'OK (at least one active master_user)'
            else 'CHECK: no active master_user rows found' end
union all
select 'at least one user is admin AND an active master_user',
       case when exists (select 1 from user_settings us join studio_memberships m on m.user_id = us.user_id
                         where us.is_admin = true and m.role = 'master_user' and m.status = 'active') then 'OK' else 'CHECK: nobody would be authorized' end
union all
select 'leads columns Intelligence uses: ' || c.col,
       case when exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'leads' and column_name = c.col) then 'OK' else 'MISSING' end
  from (values ('user_id'),('company_name'),('contact_person'),('email'),('website'),('country'),('stage'),('priority'),('channel'),('emails'),
               ('last_contacted_at'),('stage_changed_at'),('archived_at'),('needs_followup')) as c(col)
union all
select 'activity_log columns: ' || c.col,
       case when exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'activity_log' and column_name = c.col) then 'OK' else 'MISSING' end
  from (values ('user_id'),('event_type'),('meta'),('audience'),('description')) as c(col)
union all
select 'newest existing migration (Intelligence must sort after it)',
       coalesce((select max(version) from supabase_migrations.schema_migrations), 'unknown (history table not readable)')
union all
select 'Intelligence already applied?',
       case when to_regclass('public.intel_settings') is null then 'no (expected before applying)' else 'YES: tables exist already' end
union all
select 'existing leads that would be reviewed', (select count(*)::text from leads where archived_at is null);
