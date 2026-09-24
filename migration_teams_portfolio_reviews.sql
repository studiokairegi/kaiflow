-- =========================================================================
-- Teams Module — Phase 2, slice 2: Portfolio and internal reviews
-- (brief §14, §15)
-- =========================================================================
-- Additive only. Safe to run after the other migration_teams_*.sql files.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. Portfolio (§14)
-- -------------------------------------------------------------------------
-- An internal professional portfolio, not an Upwork-style public gallery:
-- RLS is the same owner-only pattern as team_members, so nothing here is
-- exposed outside the studio's own account. thumbnail_url/external_url are
-- expected to point at the studio's existing Drive/asset storage (or any
-- external link) - this table doesn't introduce a new file-hosting path
-- of its own.
create table if not exists team_member_portfolio_items (
  id uuid primary key default gen_random_uuid(),
  team_member_id uuid not null references team_members(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null default '',
  description text default '',
  thumbnail_url text default '',
  external_url text default '',
  role_performed text default '',
  skills_demonstrated text[] not null default '{}',
  project_category text default '',
  item_date date,
  client_name text default '',
  created_at timestamptz not null default now()
);

alter table team_member_portfolio_items enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'team_member_portfolio_items'
      and policyname = 'Users manage their own team member portfolio items'
  ) then
    create policy "Users manage their own team member portfolio items"
      on team_member_portfolio_items for all
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end $$;

create index if not exists team_member_portfolio_items_member_idx
  on team_member_portfolio_items(team_member_id);

create or replace function public.enforce_portfolio_item_ownership()
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
  if not public.user_has_pro_access(new.user_id) then
    raise exception 'Portfolio items require Pro access';
  end if;
  select user_id into member_owner from team_members where id = new.team_member_id;
  if member_owner is null then
    raise exception 'team_member_id does not reference an existing team member';
  end if;
  if member_owner <> new.user_id then
    raise exception 'Portfolio item must belong to the same user as the team member';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_portfolio_item_ownership on team_member_portfolio_items;
create trigger trg_enforce_portfolio_item_ownership
before insert or update on team_member_portfolio_items
for each row execute function public.enforce_portfolio_item_ownership();

-- -------------------------------------------------------------------------
-- 2. Internal reviews (§15)
-- -------------------------------------------------------------------------
-- Deliberately a separate table/concept from upwork_rating on team_members
-- (external reputation) - see the brief's "do not combine" / "do not
-- calculate a blended score" rule. Category ratings are intentionally NOT
-- modeled here (kept to a single 1-5 rating + free text), per "do not
-- overbuild them in v1".
create table if not exists team_member_reviews (
  id uuid primary key default gen_random_uuid(),
  team_member_id uuid not null references team_members(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  rating integer not null,
  review_text text default '',
  reviewer text default '',
  review_date date not null default current_date,
  project_id uuid references projects(id) on delete set null,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'team_member_reviews_rating_valid') then
    alter table team_member_reviews
      add constraint team_member_reviews_rating_valid check (rating between 1 and 5);
  end if;
end $$;

alter table team_member_reviews enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'team_member_reviews' and policyname = 'Users manage their own team member reviews'
  ) then
    create policy "Users manage their own team member reviews"
      on team_member_reviews for all
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end $$;

create index if not exists team_member_reviews_member_idx
  on team_member_reviews(team_member_id, review_date desc);

create or replace function public.enforce_review_ownership()
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
  if not public.user_has_pro_access(new.user_id) then
    raise exception 'Reviews require Pro access';
  end if;
  select user_id into member_owner from team_members where id = new.team_member_id;
  if member_owner is null then
    raise exception 'team_member_id does not reference an existing team member';
  end if;
  if member_owner <> new.user_id then
    raise exception 'Review must belong to the same user as the team member';
  end if;
  if new.project_id is not null and not exists (
    select 1 from projects where id = new.project_id and user_id = new.user_id
  ) then
    raise exception 'project_id must reference a project owned by the same user';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_review_ownership on team_member_reviews;
create trigger trg_enforce_review_ownership
before insert or update on team_member_reviews
for each row execute function public.enforce_review_ownership();
