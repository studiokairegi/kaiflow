-- =========================================================================
-- Teams Module — Phase 2, slice 1: Freelancer info, rate history, and
-- payment security (brief §7 freelancer fields, §9, §12, §13)
-- =========================================================================
-- Additive only. Safe to run after migration_teams_phase1_safety.sql and
-- migration_teams_payment_atomicity.sql.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. Freelancer / external-reputation fields (§7, §15's "keep separate")
-- -------------------------------------------------------------------------
-- These stay on team_members itself: they're not sensitive, they're shown
-- on the roster card, and every existing bulk roster query already needs
-- them. Contrast with payment details below, which are deliberately moved
-- OUT of team_members for exactly the opposite reason.
alter table team_members add column if not exists member_type text not null default 'freelancer';
alter table team_members add column if not exists upwork_rating numeric;
alter table team_members add column if not exists upwork_review_count integer;
alter table team_members add column if not exists upwork_profile_url text default '';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'team_members_member_type_valid') then
    alter table team_members
      add constraint team_members_member_type_valid check (member_type in ('freelancer', 'internal'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'team_members_upwork_rating_valid') then
    alter table team_members
      add constraint team_members_upwork_rating_valid check (upwork_rating is null or (upwork_rating >= 0 and upwork_rating <= 5));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'team_members_upwork_review_count_valid') then
    alter table team_members
      add constraint team_members_upwork_review_count_valid check (upwork_review_count is null or upwork_review_count >= 0);
  end if;
end $$;

-- Non-sensitive payment metadata also stays on team_members. Only the
-- actual account/phone/IBAN details move out (below) — payment_method,
-- payment_currency, and payment_country are needed for the roster's
-- payment-method filter (brief §18) and aren't sensitive on their own.
alter table team_members add column if not exists payment_method text default '';
alter table team_members add column if not exists payment_currency text default '';
alter table team_members add column if not exists payment_country text default '';

-- -------------------------------------------------------------------------
-- 2. Configurable payment methods (§13)
-- -------------------------------------------------------------------------
-- A per-studio list instead of a hardcoded one, so an option can be added
-- (or an unused one dropped) from Settings without a code change.
alter table user_settings add column if not exists payment_method_options text[]
  not null default array['Bank transfer', 'PayPal', 'Payoneer', 'M-Pesa', 'Wise', 'Cash', 'Other'];

-- -------------------------------------------------------------------------
-- 3. Payment details — moved to their own table (§12)
-- -------------------------------------------------------------------------
-- The account holder name and the actual account/phone/IBAN details are
-- the sensitive part, and previously would have lived as plain columns on
-- team_members — meaning every ordinary roster-list SELECT * would pull
-- them over the wire even though the roster UI never displays them. Moving
-- them to their own table with the same ownership RLS means a normal
-- roster fetch simply never touches this data at all; it's only queried
-- when a member's own Payments section is explicitly opened. Client code
-- must mask this in the UI (e.g. "•••• 1234") whenever it's shown outside
-- of the direct edit field — see teamMemberPaymentToRow/FromRow and
-- maskPaymentDetails() in App.jsx.
--
-- This is exposure control, not encryption-at-rest: Supabase/Postgres
-- already encrypts data at rest at the storage layer, same as the rest of
-- this schema. If a studio needs the payment details unreadable even to
-- someone with direct database access, that needs an application-level
-- encryption pipeline through an Edge Function — the same pattern this
-- repo already uses for refresh_token_encrypted in migration_patreon.sql
-- — which is a separate, larger piece of work than this migration covers.
create table if not exists team_member_payment_details (
  team_member_id uuid primary key references team_members(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  account_holder_name text default '',
  payment_details text default '', -- free-text account/phone/IBAN number, whatever the payment method needs
  updated_at timestamptz not null default now()
);

alter table team_member_payment_details enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'team_member_payment_details'
      and policyname = 'Users manage their own team member payment details'
  ) then
    create policy "Users manage their own team member payment details"
      on team_member_payment_details for all
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end $$;

-- Same cross-user-ownership and entitlement protection as team_members
-- itself (this table is meaningless without a team_members row, but a
-- direct client insert could otherwise still target another user's
-- member id or slip past the Pro gate).
create or replace function public.enforce_payment_details_ownership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  member_owner uuid;
begin
  if auth.role() = 'service_role' then
    return new;
  end if;
  select user_id into member_owner from team_members where id = new.team_member_id;
  if member_owner is null then
    raise exception 'team_member_id does not reference an existing team member';
  end if;
  if member_owner <> new.user_id then
    raise exception 'Payment details must belong to the same user as the team member';
  end if;
  if not public.user_has_pro_access(new.user_id) then
    raise exception 'Teams is a Pro feature. Upgrade to manage payment details.' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_enforce_payment_details_ownership on team_member_payment_details;
create trigger trg_enforce_payment_details_ownership
before insert or update on team_member_payment_details
for each row execute function public.enforce_payment_details_ownership();

-- -------------------------------------------------------------------------
-- 4. Rate history (§9, §31)
-- -------------------------------------------------------------------------
-- A member's CURRENT rate lives on team_members (rate_amount/rate_type,
-- already existing columns) and is only ever a default for *new*
-- assignments — shots.assigned_pay is its own stored value and is never
-- recomputed from this, so a later rate change already can't rewrite an
-- existing assignment's pay (see migration note in App.jsx's assignment
-- handler). This table is the other half: a record of what the rate WAS
-- and when it changed, for the member's own history / reporting, not for
-- reaching backward into past transactions.
create table if not exists team_member_rate_history (
  id uuid primary key default gen_random_uuid(),
  team_member_id uuid not null references team_members(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  rate_amount numeric not null,
  rate_type text not null,
  rate_currency text not null default '$',
  effective_date date not null default current_date,
  created_at timestamptz not null default now()
);

alter table team_member_rate_history enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'team_member_rate_history' and policyname = 'Users view their own team member rate history'
  ) then
    create policy "Users view their own team member rate history"
      on team_member_rate_history for select
      using (auth.uid() = user_id);
  end if;
end $$;

-- Rate history is written only by the trigger below (server-side, on an
-- actual rate/type/currency change), never directly by the client — so
-- there's no insert/update/delete policy for authenticated users. This
-- keeps the history tamper-proof from the client's point of view: nobody
-- can edit or backdate what the rate "used to be".
create index if not exists team_member_rate_history_member_idx
  on team_member_rate_history(team_member_id, effective_date desc);

create or replace function public.record_team_member_rate_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.rate_amount > 0 then
      insert into team_member_rate_history (team_member_id, user_id, rate_amount, rate_type, rate_currency)
      values (new.id, new.user_id, new.rate_amount, new.rate_type, coalesce(new.rate_currency, '$'));
    end if;
    return new;
  end if;

  if new.rate_amount is distinct from old.rate_amount
     or new.rate_type is distinct from old.rate_type
     or new.rate_currency is distinct from old.rate_currency then
    if new.rate_amount > 0 then
      insert into team_member_rate_history (team_member_id, user_id, rate_amount, rate_type, rate_currency)
      values (new.id, new.user_id, new.rate_amount, new.rate_type, coalesce(new.rate_currency, '$'));
    end if;
  end if;
  return new;
end;
$$;

-- team_members doesn't have a rate_currency column yet (rates have always
-- been in the studio's single global currency); add one so a rate change
-- can actually specify what it's a change TO, and so a freelancer paid in
-- a different currency than the studio default can be represented.
alter table team_members add column if not exists rate_currency text not null default '$';

drop trigger if exists trg_record_team_member_rate_change on team_members;
create trigger trg_record_team_member_rate_change
after insert or update of rate_amount, rate_type, rate_currency on team_members
for each row execute function public.record_team_member_rate_change();
