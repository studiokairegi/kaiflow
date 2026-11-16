-- Re-arming a pending job (same dedupe_key, e.g. a re-snoozed reminder) must also forget which
-- devices already received the previous send; otherwise those devices skip the new reminder.
-- Same function as in 20261103090000_web_push.sql plus `delivered_sub_ids = '{}'`. Safe to run twice.
-- Requires 20270109090000_notifications_realtime_and_push_delivery.sql (adds the column).

create or replace function public.push_enqueue_user(
  p_user_id uuid, p_category text, p_title text, p_body text, p_tag text, p_url text,
  p_due_at timestamptz default now(), p_dedupe_key text default null
) returns void language plpgsql security definer set search_path = pg_catalog, public
as $$
begin
  if p_user_id is null then return; end if;
  insert into public.push_jobs(user_id, category, title, body, tag, url, due_at, dedupe_key)
  values (p_user_id, public.push_clean(p_category, 40), coalesce(nullif(public.push_clean(p_title, 120), ''), 'KairFlow'),
          public.push_clean(p_body, 240), nullif(public.push_clean(p_tag, 80), ''), nullif(public.push_clean(p_url, 500), ''),
          coalesce(p_due_at, now()), nullif(p_dedupe_key, ''))
  on conflict (dedupe_key) where dedupe_key is not null and sent_at is null
  do update set due_at = excluded.due_at, title = excluded.title, body = excluded.body, tag = excluded.tag,
                url = excluded.url, category = excluded.category, claimed_at = null, attempts = 0,
                delivered_sub_ids = '{}';
end;
$$;

revoke all on function public.push_enqueue_user(uuid, text, text, text, text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.push_enqueue_user(uuid, text, text, text, text, text, timestamptz, text) to service_role;
