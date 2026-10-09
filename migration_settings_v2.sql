-- =============================================================================
-- Settings v2
-- Evolves user_settings additively. Safe to re-run. Existing RLS/triggers untouched
-- (protect_privileged_user_settings still pins plan/is_admin for non-service roles).
-- =============================================================================

alter table user_settings add column if not exists timezone text not null default '';
alter table user_settings add column if not exists date_format text not null default '';
alter table user_settings add column if not exists workweek jsonb not null default '{"days":[1,2,3,4,5],"hoursPerDay":8}'::jsonb;
alter table user_settings add column if not exists auto_no_response boolean not null default true;
alter table user_settings add column if not exists archive_days jsonb not null default '{"won":30,"lost":60,"no_response":60,"disqualified":30,"closed":30}'::jsonb;
alter table user_settings add column if not exists outcome_reasons jsonb not null default '{"lost":{"hidden":[],"custom":[]},"disqualified":{"hidden":[],"custom":[]}}'::jsonb;
alter table user_settings add column if not exists default_pipeline_preset text not null default 'full';
alter table user_settings add column if not exists default_pipeline_stage_keys jsonb not null default '[]'::jsonb;
alter table user_settings add column if not exists planner_defaults jsonb not null default '{"profitPercent":25,"contingencyPercent":7,"fps":24}'::jsonb;
alter table user_settings add column if not exists invoice_prefixes jsonb not null default '{"proforma":"PRO","invoice":"INV","receipt":"REC"}'::jsonb;
alter table user_settings add column if not exists default_payment_terms_days int not null default 0;
alter table user_settings add column if not exists user_prefs jsonb not null default '{}'::jsonb;

-- Value checks. NOT VALID = enforced for new writes without failing on any odd legacy row.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'user_settings_pipeline_preset_chk') then
    alter table user_settings add constraint user_settings_pipeline_preset_chk check (default_pipeline_preset in ('full','custom')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'user_settings_terms_chk') then
    alter table user_settings add constraint user_settings_terms_chk check (default_payment_terms_days between 0 and 365) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'user_settings_followup_len_chk') then
    -- Initial + 1..6 follow-ups
    alter table user_settings add constraint user_settings_followup_len_chk
      check (jsonb_typeof(followup_schedule) = 'array' and jsonb_array_length(followup_schedule) between 2 and 7) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'user_settings_prefs_keys_chk') then
    -- only known keys may live in user_prefs, so it can't become a junk drawer
    alter table user_settings add constraint user_settings_prefs_keys_chk
      check (jsonb_typeof(user_prefs) = 'object' and (user_prefs - array['dashboardPeriod','notifyCategories','sound','focusTimer']) = '{}'::jsonb) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'user_settings_invoice_prefixes_chk') then
    alter table user_settings add constraint user_settings_invoice_prefixes_chk
      check (jsonb_typeof(invoice_prefixes) = 'object'
        and coalesce(invoice_prefixes->>'invoice','') ~ '^[A-Z0-9]{1,6}$'
        and coalesce(invoice_prefixes->>'proforma','') ~ '^[A-Z0-9]{1,6}$'
        and coalesce(invoice_prefixes->>'receipt','') ~ '^[A-Z0-9]{1,6}$') not valid;
  end if;
end $$;

-- New default cadence is Initial + 2 follow-ups (days 0/3/7).
alter table user_settings alter column followup_schedule
  set default '[{"label":"Initial email","dayOffset":0},{"label":"Follow-up #1","dayOffset":3},{"label":"Follow-up #2","dayOffset":7}]'::jsonb;

-- Move studios that never customised the old 5-step default onto the new default.
-- A studio that changed any day offset keeps its own schedule untouched.
update user_settings
set followup_schedule = '[{"label":"Initial email","dayOffset":0},{"label":"Follow-up #1","dayOffset":3},{"label":"Follow-up #2","dayOffset":7}]'::jsonb
where jsonb_array_length(followup_schedule) = 5
  and (select array_agg((e->>'dayOffset')::int order by o) from jsonb_array_elements(followup_schedule) with ordinality as t(e, o)) = array[0,3,7,14,21];

-- Archive windows now come from each studio's own settings (was a fixed 30/60/60/30/30).
create or replace function public.archive_stale_leads()
returns void
language sql
security definer
set search_path = public
as $$
  update leads l
  set archived_at = now()
  where l.archived_at is null
    and l.stage in ('won','lost','no_response','disqualified','closed')
    and now() - l.stage_changed_at > make_interval(days => coalesce(
          (select (s.archive_days ->> l.stage)::int from user_settings s where s.user_id = l.user_id),
          case l.stage when 'won' then 30 when 'lost' then 60 when 'no_response' then 60 else 30 end));
$$;
revoke all on function public.archive_stale_leads() from public, anon, authenticated;

-- Invoice numbers must be unique per user. Created only if no duplicates exist, so
-- the migration never fails on old data; if duplicates exist you get a notice to fix them.
do $$
declare dupes int;
begin
  select count(*) into dupes from (
    select user_id, invoice_number from invoices where coalesce(invoice_number, '') <> ''
    group by user_id, invoice_number having count(*) > 1) d;
  if dupes = 0 then
    create unique index if not exists invoices_user_number_uniq on invoices(user_id, invoice_number) where coalesce(invoice_number, '') <> '';
  else
    raise notice 'invoices_user_number_uniq NOT created: % duplicate invoice number(s) exist. Renumber them, then re-run this migration.', dupes;
  end if;
end $$;
