-- Fixes from a further CRM/leads audit. Run after every other migration,
-- including migration_audit_fixes_7.sql.

-- =========================================================================
-- 1. DB-level guard on leads.stage and leads.priority
-- =========================================================================
-- Nothing below the client enforced these. The frontend's LEAD_STAGES /
-- LEAD_TERMINAL_STAGES / LEAD_PRIORITIES lists are the only thing keeping
-- these columns to known values - a direct API write (or a future bug)
-- could otherwise leave a lead with a stage/priority the UI has no label
-- for and no code path expects, including in the Kanban board's
-- `data-stage` column lookup and computeFollowupStatus's terminal check.
--
-- `not valid` (as used elsewhere in this project, e.g.
-- migration_audit_fixes_3.sql) so this doesn't fail out over any existing
-- row with a stray value; it only stops new violations. Run `validate
-- constraint` later once existing data is confirmed clean, if desired.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'leads_stage_valid'
  ) then
    alter table leads add constraint leads_stage_valid check (
      stage in (
        'pool', 'cold_email', 'responded', 'qualified', 'proposal', 'negotiation', 'won',
        'no_response', 'lost', 'disqualified', 'closed'
      )
    ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'leads_priority_valid'
  ) then
    alter table leads add constraint leads_priority_valid check (
      priority in ('hot', 'warm', 'cold')
    ) not valid;
  end if;
end $$;
