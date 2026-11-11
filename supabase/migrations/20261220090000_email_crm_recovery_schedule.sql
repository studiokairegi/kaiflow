-- Phase 4: automatic recovery of CRM email activities.
-- email_recover_crm_activities() replays CRM recording for provider-accepted messages that have a lead but no activity row.
-- It never calls a provider and never changes send status. This migration only SCHEDULES it, and only where pg_cron is already enabled;
-- otherwise it does nothing (run the function manually or enable pg_cron, then re-run this file). Safe to re-run.
do $$
begin
  if to_regprocedure('public.email_recover_crm_activities(integer)') is null then
    raise notice 'email_recover_crm_activities missing; apply the Phase 4D migration first. Nothing scheduled.';
  elsif to_regnamespace('cron') is null then
    raise notice 'pg_cron is not enabled; CRM email recovery is not scheduled. Call select public.email_recover_crm_activities(100); manually or enable pg_cron.';
  else
    perform cron.unschedule(jobid) from cron.job where jobname = 'kairflow_email_crm_recovery';
    perform cron.schedule('kairflow_email_crm_recovery', '*/10 * * * *', 'select public.email_recover_crm_activities(100)');
  end if;
end $$;

-- Rollback (non-destructive; leaves all email and CRM data in place):
--   select cron.unschedule(jobid) from cron.job where jobname = 'kairflow_email_crm_recovery';
