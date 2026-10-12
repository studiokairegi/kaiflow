-- Tasks, daily/weekly planning and recurring tasks.
--
-- Additive and idempotent. Nothing existing is altered, dropped or rewritten:
-- two new tables (studio_tasks, studio_task_series), their RLS policies, a
-- guard trigger and four functions. The names are prefixed "studio_" so they
-- cannot collide with any table the app already has.
-- Run after every existing migration. Dates are DATE columns (no timezone):
-- the client decides what "today" is (the app's configured zone) and sends it.

-- ---------------------------------------------------------------------------
-- 1. Recurring definitions
-- ---------------------------------------------------------------------------
create table if not exists public.studio_task_series (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title             text not null check (length(btrim(title)) between 1 and 200),
  notes             text check (notes is null or length(notes) <= 5000),
  category          text not null default 'general'
                    check (category in ('general', 'outreach', 'crm', 'production', 'administration', 'finance')),
  priority          text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  est_minutes       integer check (est_minutes is null or est_minutes between 1 and 1440),
  start_time        time,
  link_type         text check (link_type is null or link_type in ('lead', 'contact', 'project', 'shot')),
  link_id           uuid,
  link_label        text check (link_label is null or length(link_label) <= 200),
  recurrence        text not null check (recurrence in ('daily', 'weekdays', 'weekly', 'monthly', 'interval')),
  weekdays          smallint[] not null default '{}',              -- ISO: 1 = Monday ... 7 = Sunday
  month_day         smallint check (month_day is null or month_day between 1 and 31),
  interval_days     smallint check (interval_days is null or interval_days between 2 and 365),
  start_date        date not null,
  end_date          date,
  status            text not null default 'active' check (status in ('active', 'paused', 'ended')),
  -- Occurrences up to this date have been materialized; used only to decide
  -- whether a catch-up occurrence is still needed.
  materialized_through date,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint studio_task_series_weekly_days check (recurrence <> 'weekly' or cardinality(weekdays) > 0),
  constraint studio_task_series_weekday_range check (weekdays <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  constraint studio_task_series_monthly_day check (recurrence <> 'monthly' or month_day is not null),
  constraint studio_task_series_interval check (recurrence <> 'interval' or interval_days is not null),
  constraint studio_task_series_dates check (end_date is null or end_date >= start_date)
);
create index if not exists studio_task_series_user_idx on public.studio_task_series (user_id, status);

-- ---------------------------------------------------------------------------
-- 2. Tasks (one-off tasks and materialized occurrences share this table)
-- ---------------------------------------------------------------------------
create table if not exists public.studio_tasks (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title            text not null check (length(btrim(title)) between 1 and 200),
  notes            text check (notes is null or length(notes) <= 5000),
  due_date         date,                                   -- null = unscheduled
  start_time       time,
  est_minutes      integer check (est_minutes is null or est_minutes between 1 and 1440),
  priority         text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  status           text not null default 'todo' check (status in ('todo', 'in_progress', 'completed', 'cancelled')),
  category         text not null default 'general'
                   check (category in ('general', 'outreach', 'crm', 'production', 'administration', 'finance')),
  -- Optional pointer to a source record. Polymorphic, so no foreign key: the
  -- guard trigger checks ownership on write, and the UI copes with a record
  -- that was deleted later (link_label keeps the name).
  link_type        text check (link_type is null or link_type in ('lead', 'contact', 'project', 'shot')),
  link_id          uuid,
  link_label       text check (link_label is null or length(link_label) <= 200),
  is_priority      boolean not null default false,         -- "today's priorities" star
  sort_order       bigint not null default (extract(epoch from clock_timestamp()) * 1000)::bigint,
  completed_at     timestamptz,
  completed_on     date,                                   -- completion day in the user's zone (client-supplied)
  series_id        uuid references public.studio_task_series(id) on delete cascade,
  occurrence_date  date,                                   -- the date the series scheduled; never changes on reschedule
  series_override  boolean not null default false,         -- edited/moved on its own: series edits leave it alone
  auto_skipped     boolean not null default false,         -- cancelled by the catch-up sweep, not by the user
  source_key       text check (source_key is null or length(source_key) <= 200),
  request_key      text check (request_key is null or length(request_key) between 8 and 64),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint studio_tasks_link_pair check ((link_type is null) = (link_id is null)),
  constraint studio_tasks_series_pair check ((series_id is null) = (occurrence_date is null))
);

-- Duplicate guards. NULLs are distinct in a unique index, so one-off tasks never conflict.
create unique index if not exists studio_tasks_series_occurrence_uidx on public.studio_tasks (series_id, occurrence_date);
create unique index if not exists studio_tasks_request_key_uidx       on public.studio_tasks (user_id, request_key);
create unique index if not exists studio_tasks_source_key_uidx        on public.studio_tasks (user_id, source_key);
create index if not exists studio_tasks_user_due_idx    on public.studio_tasks (user_id, due_date) where status in ('todo', 'in_progress');
create index if not exists studio_tasks_user_done_idx   on public.studio_tasks (user_id, completed_on) where status = 'completed';
create index if not exists studio_tasks_link_idx        on public.studio_tasks (link_type, link_id) where link_id is not null;

alter table public.studio_task_series enable row level security;
drop policy if exists "Users manage their own task series" on public.studio_task_series;
create policy "Users manage their own task series" on public.studio_task_series
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table public.studio_tasks enable row level security;
drop policy if exists "Users manage their own tasks" on public.studio_tasks;
create policy "Users manage their own tasks" on public.studio_tasks
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 3. Guard trigger
-- ---------------------------------------------------------------------------
-- * links and series must belong to the same user (RLS alone doesn't check a
--   foreign target);
-- * completed_at / completed_on follow the status, so reopening clears them;
-- * editing a series occurrence's content or date marks it as an override, so a
--   later "edit the series" leaves it alone. The series sync function sets
--   studio.series_sync to bypass that.
create or replace function public.studio_task_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    new.user_id := old.user_id;
  end if;

  if new.link_id is not null and (tg_op = 'INSERT' or new.link_id is distinct from old.link_id or new.link_type is distinct from old.link_type) then
    if not (
      case new.link_type
        when 'lead'    then exists (select 1 from leads l where l.id = new.link_id and l.user_id = new.user_id)
        when 'contact' then exists (select 1 from contacts c where c.id = new.link_id and c.user_id = new.user_id)
        when 'project' then exists (select 1 from projects p where p.id = new.link_id and p.user_id = new.user_id)
        when 'shot'    then exists (select 1 from shots s join projects p on p.id = s.project_id where s.id = new.link_id and p.user_id = new.user_id)
        else false
      end
    ) then
      raise exception 'task_link_not_found' using errcode = 'P0002';
    end if;
  end if;

  if new.series_id is not null and (tg_op = 'INSERT' or new.series_id is distinct from old.series_id) then
    if not exists (select 1 from studio_task_series s where s.id = new.series_id and s.user_id = new.user_id) then
      raise exception 'series_not_found' using errcode = 'P0002';
    end if;
  end if;

  if new.status = 'completed' then
    if new.completed_at is null then new.completed_at := now(); end if;
    if new.completed_on is null then new.completed_on := (new.completed_at at time zone 'UTC')::date; end if;
  else
    new.completed_at := null;
    new.completed_on := null;
  end if;

  if tg_op = 'UPDATE' and old.series_id is not null
     and coalesce(current_setting('studio.series_sync', true), '') <> '1'
     and (new.title is distinct from old.title or new.notes is distinct from old.notes
          or new.category is distinct from old.category or new.priority is distinct from old.priority
          or new.est_minutes is distinct from old.est_minutes or new.start_time is distinct from old.start_time
          or new.due_date is distinct from old.due_date) then
    new.series_override := true;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists studio_tasks_guard on public.studio_tasks;
create trigger studio_tasks_guard before insert or update on public.studio_tasks
  for each row execute function public.studio_task_guard();

create or replace function public.studio_task_series_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then new.user_id := old.user_id; end if;
  if new.link_id is not null and (tg_op = 'INSERT' or new.link_id is distinct from old.link_id or new.link_type is distinct from old.link_type) then
    if new.link_type is null or not (
      case new.link_type
        when 'lead'    then exists (select 1 from leads l where l.id = new.link_id and l.user_id = new.user_id)
        when 'contact' then exists (select 1 from contacts c where c.id = new.link_id and c.user_id = new.user_id)
        when 'project' then exists (select 1 from projects p where p.id = new.link_id and p.user_id = new.user_id)
        when 'shot'    then exists (select 1 from shots s join projects p on p.id = s.project_id where s.id = new.link_id and p.user_id = new.user_id)
        else false
      end
    ) then
      raise exception 'task_link_not_found' using errcode = 'P0002';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists studio_task_series_guard on public.studio_task_series;
create trigger studio_task_series_guard before insert or update on public.studio_task_series
  for each row execute function public.studio_task_series_guard();

-- ---------------------------------------------------------------------------
-- 4. Functions (SECURITY INVOKER: every statement runs under the caller's RLS)
-- ---------------------------------------------------------------------------

-- Materialize the given occurrence dates (computed by the client) for one
-- series. Idempotent: the unique index on (series_id, occurrence_date) turns a
-- repeat call, a second tab or a refresh into a no-op.
--
-- Catch-up sweep: older, untouched, unstarted occurrences before today are
-- auto-skipped except the most recent one, so a long absence leaves at most one
-- overdue instance per series instead of a pile. Anything the user touched
-- (edited, moved, starred, started, completed) is never swept.
create or replace function public.studio_task_materialize(p_series_id uuid, p_dates date[], p_through date, p_today date)
returns integer
language plpgsql
as $$
declare
  s studio_task_series;
  n integer := 0;
  keep uuid;
begin
  select * into s from studio_task_series where id = p_series_id for update;
  if not found then
    raise exception 'series_not_found' using errcode = 'P0002';
  end if;
  if s.status <> 'active' then
    return 0;
  end if;
  if coalesce(array_length(p_dates, 1), 0) > 62 then
    raise exception 'too_many_occurrences' using errcode = '22023';
  end if;

  with ins as (
    insert into studio_tasks (user_id, title, notes, due_date, start_time, est_minutes, priority, status, category,
                              link_type, link_id, link_label, series_id, occurrence_date)
    select s.user_id, s.title, s.notes, d, s.start_time, s.est_minutes, s.priority, 'todo', s.category,
           s.link_type, s.link_id, s.link_label, s.id, d
      from unnest(p_dates) as d
     where d >= s.start_date and (s.end_date is null or d <= s.end_date)
    on conflict (series_id, occurrence_date) do nothing
    returning 1
  )
  select count(*) into n from ins;

  select id into keep from studio_tasks
   where series_id = s.id and due_date < p_today and status = 'todo'
     and not series_override and not is_priority and not auto_skipped
   order by due_date desc, occurrence_date desc limit 1;
  if keep is not null then
    update studio_tasks set status = 'cancelled', auto_skipped = true
     where series_id = s.id and due_date < p_today and status = 'todo'
       and not series_override and not is_priority and id <> keep;
  end if;

  update studio_task_series
     set materialized_through = greatest(coalesce(materialized_through, p_through), p_through)
   where id = s.id;
  return n;
end;
$$;

-- After the client updated a series row: push its current content to the
-- untouched, still-open occurrences from today on. With p_regenerate (schedule
-- changed) those occurrences are removed instead and the caller re-materializes.
create or replace function public.studio_task_series_sync(p_series_id uuid, p_today date, p_regenerate boolean)
returns integer
language plpgsql
as $$
declare
  s studio_task_series;
  n integer := 0;
begin
  select * into s from studio_task_series where id = p_series_id for update;
  if not found then
    raise exception 'series_not_found' using errcode = 'P0002';
  end if;

  if p_regenerate then
    delete from studio_tasks
     where series_id = s.id and due_date >= p_today and status = 'todo' and not series_override and not is_priority;
    get diagnostics n = row_count;
    update studio_task_series set materialized_through = p_today - 1 where id = s.id;
  else
    perform set_config('studio.series_sync', '1', true);
    update studio_tasks
       set title = s.title, notes = s.notes, category = s.category, priority = s.priority,
           est_minutes = s.est_minutes, start_time = s.start_time,
           link_type = s.link_type, link_id = s.link_id, link_label = s.link_label
     where series_id = s.id and due_date >= p_today and status = 'todo' and not series_override;
    get diagnostics n = row_count;
    perform set_config('studio.series_sync', '0', true);
  end if;
  return n;
end;
$$;

-- Pause / resume / end. Pausing and ending drop untouched future occurrences;
-- resuming never back-fills the paused period. Ended is final.
create or replace function public.studio_task_series_set_status(p_series_id uuid, p_status text, p_today date)
returns void
language plpgsql
as $$
declare
  s studio_task_series;
begin
  if p_status not in ('active', 'paused', 'ended') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  select * into s from studio_task_series where id = p_series_id for update;
  if not found then
    raise exception 'series_not_found' using errcode = 'P0002';
  end if;
  if s.status = 'ended' and p_status <> 'ended' then
    raise exception 'series_ended' using errcode = '22023';
  end if;
  if s.status = p_status then
    return;
  end if;

  if p_status = 'paused' then
    delete from studio_tasks
     where series_id = s.id and due_date > p_today and status = 'todo' and not series_override and not is_priority;
    update studio_task_series set status = 'paused' where id = s.id;
  elsif p_status = 'active' then
    update studio_task_series set status = 'active', materialized_through = p_today - 1 where id = s.id;
  else
    delete from studio_tasks
     where series_id = s.id and due_date > p_today and status = 'todo' and not series_override and not is_priority;
    update studio_task_series
       set status = 'ended',
           end_date = greatest(start_date, least(coalesce(end_date, p_today), p_today))
     where id = s.id;
  end if;
end;
$$;

-- Persist a drag/arrow reorder in one statement.
create or replace function public.studio_tasks_reorder(p_ids uuid[])
returns void
language sql
as $$
  update studio_tasks t set sort_order = o.ord
    from unnest(p_ids) with ordinality as o(id, ord)
   where t.id = o.id;
$$;

grant execute on function public.studio_task_materialize(uuid, date[], date, date) to authenticated;
grant execute on function public.studio_task_series_sync(uuid, date, boolean) to authenticated;
grant execute on function public.studio_task_series_set_status(uuid, text, date) to authenticated;
grant execute on function public.studio_tasks_reorder(uuid[]) to authenticated;
