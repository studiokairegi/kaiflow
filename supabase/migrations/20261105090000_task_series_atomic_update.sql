-- Atomic series edit: the series row update and the sync/regenerate of its
-- future occurrences now happen in one transaction, so a failure partway can
-- no longer leave a changed series with stale (or deleted) occurrences.
-- Additive: studio_task_series_sync stays as is. Runs with the caller's rights (RLS applies).
create or replace function public.studio_task_series_update(
  p_series_id uuid, p_patch jsonb, p_today date, p_regenerate boolean
) returns public.studio_task_series
language plpgsql
as $$
declare
  s public.studio_task_series;
begin
  update public.studio_task_series set
    title         = p_patch->>'title',
    notes         = p_patch->>'notes',
    category      = p_patch->>'category',
    priority      = p_patch->>'priority',
    est_minutes   = (p_patch->>'est_minutes')::integer,
    start_time    = (p_patch->>'start_time')::time,
    link_type     = p_patch->>'link_type',
    link_id       = (p_patch->>'link_id')::uuid,
    link_label    = p_patch->>'link_label',
    recurrence    = p_patch->>'recurrence',
    weekdays      = coalesce(array(select jsonb_array_elements_text(p_patch->'weekdays'))::smallint[], '{}'),
    month_day     = (p_patch->>'month_day')::smallint,
    interval_days = (p_patch->>'interval_days')::smallint,
    start_date    = (p_patch->>'start_date')::date,
    end_date      = (p_patch->>'end_date')::date,
    updated_at    = now()
  where id = p_series_id
  returning * into s;
  if not found then
    raise exception 'series_not_found' using errcode = 'P0002';
  end if;
  perform public.studio_task_series_sync(p_series_id, p_today, p_regenerate);
  select * into s from public.studio_task_series where id = p_series_id;
  return s;
end;
$$;
grant execute on function public.studio_task_series_update(uuid, jsonb, date, boolean) to authenticated;
