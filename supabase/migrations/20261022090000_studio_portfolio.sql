-- =============================================================================
-- Studio portfolio: private media + secure no-login share links
-- =============================================================================
--   portfolio_items  videos/images the studio curates (files live in the PRIVATE 'portfolio' bucket)
--   portfolio_links  one link per recipient: revocable, optional expiry, view tracking
--
-- A recipient opens /portfolio/{token}. The page calls the `portfolio-view` Edge Function, which
-- validates the token (portfolio_public_get, service role only) and returns short-lived signed
-- media URLs. Nothing is public: the bucket is private, tokens are 244 random bits and only their
-- SHA-256 is stored. Idempotent.
-- =============================================================================

-- ---- private bucket + owner-folder policies (guarded: the local test DB has no storage schema) --------
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('portfolio', 'portfolio', false, 524288000,
            array['video/mp4', 'video/webm', 'video/quicktime', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
                                   allowed_mime_types = excluded.allowed_mime_types;

    drop policy if exists "portfolio owner read" on storage.objects;
    drop policy if exists "portfolio owner insert" on storage.objects;
    drop policy if exists "portfolio owner update" on storage.objects;
    drop policy if exists "portfolio owner delete" on storage.objects;
    -- Objects are stored under "<user_id>/...": a user can only touch their own folder.
    create policy "portfolio owner read" on storage.objects for select to authenticated
      using (bucket_id = 'portfolio' and (storage.foldername(name))[1] = auth.uid()::text);
    create policy "portfolio owner insert" on storage.objects for insert to authenticated
      with check (bucket_id = 'portfolio' and (storage.foldername(name))[1] = auth.uid()::text);
    create policy "portfolio owner update" on storage.objects for update to authenticated
      using (bucket_id = 'portfolio' and (storage.foldername(name))[1] = auth.uid()::text);
    create policy "portfolio owner delete" on storage.objects for delete to authenticated
      using (bucket_id = 'portfolio' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
end
$$;

-- ---- items ---------------------------------------------------------------------------------------
create table if not exists portfolio_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null check (kind in ('video', 'image')),
  title text not null default '' check (char_length(title) <= 120),
  caption text not null default '' check (char_length(caption) <= 500),
  storage_path text not null unique check (storage_path like user_id::text || '/%'),
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 524288000),
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists portfolio_items_user_idx on portfolio_items(user_id, sort_order);

create or replace function public.portfolio_items_limit() returns trigger language plpgsql as $$
begin
  if (select count(*) from portfolio_items where user_id = new.user_id) >= 50 then
    raise exception 'A portfolio can hold up to 50 items.' using errcode = 'P0001';
  end if;
  return new;
end
$$;
drop trigger if exists portfolio_items_limit_trg on portfolio_items;
create trigger portfolio_items_limit_trg before insert on portfolio_items for each row execute function public.portfolio_items_limit();

alter table portfolio_items enable row level security;
drop policy if exists "Owner manages portfolio items" on portfolio_items;
create policy "Owner manages portfolio items" on portfolio_items for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
revoke all on portfolio_items from anon;
grant select, insert, update, delete on portfolio_items to authenticated;

-- ---- links ---------------------------------------------------------------------------------------
create table if not exists portfolio_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  token_hash text not null unique,                    -- sha256 hex; the token itself is never stored
  token_hint text not null default '',
  recipient_label text not null default '' check (char_length(recipient_label) <= 120),
  expires_at timestamptz,
  revoked_at timestamptz,
  view_count int not null default 0,
  first_viewed_at timestamptz,
  last_viewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists portfolio_links_user_idx on portfolio_links(user_id, created_at desc);

alter table portfolio_links enable row level security;
drop policy if exists "Owner reads portfolio links" on portfolio_links;
create policy "Owner reads portfolio links" on portfolio_links for select using (auth.uid() = user_id);
revoke all on portfolio_links from anon;
revoke insert, update, delete, truncate on portfolio_links from authenticated;
grant select on portfolio_links to authenticated;

create or replace function public.portfolio_create_link(p_label text default '', p_expires_days int default 30)
returns table (link_id uuid, token text, expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); v_token text; v_id uuid; v_exp timestamptz;
begin
  if uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if not exists (select 1 from portfolio_items where user_id = uid) then
    raise exception 'Add at least one video or image before creating a link.' using errcode = 'P0001';
  end if;
  if p_expires_days is not null and (p_expires_days < 1 or p_expires_days > 365) then
    raise exception 'Link expiry must be between 1 and 365 days.' using errcode = 'P0001';
  end if;
  v_exp := case when p_expires_days is null then null else now() + make_interval(days => p_expires_days) end;
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');   -- 64 hex chars
  insert into portfolio_links (user_id, token_hash, token_hint, recipient_label, expires_at)
  values (uid, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), right(v_token, 4), left(coalesce(p_label, ''), 120), v_exp)
  returning id into v_id;
  return query select v_id, v_token, v_exp;
end
$$;

create or replace function public.portfolio_revoke_link(p_link uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update portfolio_links set revoked_at = coalesce(revoked_at, now()) where id = p_link and user_id = auth.uid();
  if not found then raise exception 'Link not found.' using errcode = 'P0001'; end if;
end
$$;

-- Used ONLY by the portfolio-view Edge Function (service role). Returns storage paths, so it is
-- never granted to anon/authenticated. Records the view. Bad/expired/revoked tokens all return null.
create or replace function public.portfolio_public_get(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare l portfolio_links%rowtype; v_studio text; v_items jsonb;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return null; end if;
  select * into l from portfolio_links where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex') for update;
  if not found or l.revoked_at is not null or (l.expires_at is not null and l.expires_at <= now()) then return null; end if;
  update portfolio_links set view_count = view_count + 1, last_viewed_at = now(),
    first_viewed_at = coalesce(first_viewed_at, now()) where id = l.id;
  select coalesce(nullif(studio_name, ''), '') into v_studio from user_settings where user_id = l.user_id;
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'kind', i.kind, 'title', i.title, 'caption', i.caption,
                                               'mime_type', i.mime_type, 'storage_path', i.storage_path)
                            order by i.sort_order, i.created_at), '[]'::jsonb)
    into v_items from portfolio_items i where i.user_id = l.user_id;
  return jsonb_build_object('studio_name', coalesce(v_studio, ''), 'items', v_items);
end
$$;

revoke all on function public.portfolio_create_link(text, int) from public, anon;
revoke all on function public.portfolio_revoke_link(uuid) from public, anon;
revoke all on function public.portfolio_public_get(text) from public, anon, authenticated;
grant execute on function public.portfolio_create_link(text, int) to authenticated;
grant execute on function public.portfolio_revoke_link(uuid) to authenticated;
grant execute on function public.portfolio_public_get(text) to service_role;
