-- Refreshable checkout FX snapshots, separate from Finance's accounting snapshots.
-- Checkout quotes use provider timestamps, never the time we happened to fetch a stale payload.
create table if not exists public.payment_fx_snapshots (
  user_id uuid not null references auth.users(id) on delete cascade,
  currency text not null check (currency ~ '^[A-Z]{3}$' and currency <> 'USD'),
  per_usd numeric not null check (per_usd > 0),
  rate_date date not null,
  fetched_at timestamptz not null,
  source text not null default 'open.er-api.com',
  updated_at timestamptz not null default now(),
  primary key (user_id, currency)
);

alter table public.payment_fx_snapshots enable row level security;
revoke all on public.payment_fx_snapshots from anon, authenticated;
grant select, insert, update, delete on public.payment_fx_snapshots to service_role;

-- Only the service-role Edge Function can refresh a rate. The token is validated against a live,
-- unexpired checkout session, and the owner is derived from that session (never from browser input).
create or replace function public.payments_checkout_fx_snapshot_save(
  p_token text, p_rates jsonb, p_rate_date date, p_fetched_at timestamptz
) returns boolean
language plpgsql security definer set search_path = public as $$
declare s payment_checkout_sessions%rowtype; v_currency text; v_rate numeric;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return false; end if;
  if p_fetched_at is null or p_rate_date is null or p_fetched_at > now() + interval '5 minutes'
     or p_fetched_at < now() - interval '36 hours' then return false; end if;
  if jsonb_typeof(p_rates) <> 'object' then return false; end if;

  select * into s from payment_checkout_sessions
   where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
   for update;
  if not found or s.environment <> 'live' or s.status <> 'open' or s.expires_at <= now() then return false; end if;

  for v_currency, v_rate in
    select key, value::numeric from jsonb_each_text(p_rates)
     where key in ('EUR', 'GBP', 'JPY', 'KES')
  loop
    if v_rate is null or v_rate <= 0 then continue; end if;
    insert into payment_fx_snapshots (user_id, currency, per_usd, rate_date, fetched_at, source, updated_at)
    values (s.user_id, v_currency, v_rate, p_rate_date, p_fetched_at, 'open.er-api.com', now())
    on conflict (user_id, currency) do update set
      per_usd = excluded.per_usd,
      rate_date = excluded.rate_date,
      fetched_at = excluded.fetched_at,
      source = excluded.source,
      updated_at = now()
    where excluded.fetched_at > payment_fx_snapshots.fetched_at;
  end loop;
  return true;
end
$$;

revoke all on function public.payments_checkout_fx_snapshot_save(text, jsonb, date, timestamptz) from public, anon, authenticated;
grant execute on function public.payments_checkout_fx_snapshot_save(text, jsonb, date, timestamptz) to service_role;

-- Prefer fresh checkout-provider snapshots. Finance snapshots remain a compatibility fallback, so
-- manually entered rates and already-configured installations continue to work if the provider is down.
create or replace function public.payments_fx_quote_rate(p_user uuid, p_from text, p_to text)
returns table (rate numeric, rate_date date, fetched_at timestamptz, source text)
language plpgsql stable security definer set search_path = public as $$
declare
  v_f numeric; v_t numeric; v_fd date; v_td date; v_ff timestamptz; v_tf timestamptz; v_fs text; v_ts text;
begin
  if p_from = p_to then return; end if;

  if upper(p_from) = 'USD' then
    v_f := 1; v_fd := current_date; v_ff := now(); v_fs := 'USD';
  else
    select x.per_usd, x.rate_date, x.fetched_at, x.source
      into v_f, v_fd, v_ff, v_fs
    from (
      select p.per_usd, p.rate_date, p.fetched_at, p.source, 0 as priority
        from payment_fx_snapshots p where p.user_id = p_user and p.currency = upper(p_from)
          and p.fetched_at >= now() - interval '36 hours'
      union all
      select f.per_usd, f.rate_date, f.created_at, f.source, 1 as priority
        from fx_rates f where f.user_id = p_user and f.currency = upper(p_from)
          and f.created_at >= now() - interval '36 hours'
    ) x order by x.priority, x.fetched_at desc limit 1;
    if not found then return; end if;
  end if;

  if upper(p_to) = 'USD' then
    v_t := 1; v_td := current_date; v_tf := now(); v_ts := 'USD';
  else
    select x.per_usd, x.rate_date, x.fetched_at, x.source
      into v_t, v_td, v_tf, v_ts
    from (
      select p.per_usd, p.rate_date, p.fetched_at, p.source, 0 as priority
        from payment_fx_snapshots p where p.user_id = p_user and p.currency = upper(p_to)
          and p.fetched_at >= now() - interval '36 hours'
      union all
      select f.per_usd, f.rate_date, f.created_at, f.source, 1 as priority
        from fx_rates f where f.user_id = p_user and f.currency = upper(p_to)
          and f.created_at >= now() - interval '36 hours'
    ) x order by x.priority, x.fetched_at desc limit 1;
    if not found then return; end if;
  end if;

  if v_f is null or v_t is null or v_f <= 0 or v_t <= 0 then return; end if;
  return query select round(v_t / v_f, 10), least(v_fd, v_td), least(v_ff, v_tf),
    case when v_fs = v_ts then v_fs else coalesce(nullif(v_fs, 'USD'), nullif(v_ts, 'USD'), 'mixed FX snapshots') end;
end
$$;

revoke all on function public.payments_fx_quote_rate(uuid, text, text) from public, anon, authenticated;
grant execute on function public.payments_fx_quote_rate(uuid, text, text) to service_role;
