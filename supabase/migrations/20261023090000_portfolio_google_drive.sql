-- =============================================================================
-- Portfolio media moves from the Supabase 'portfolio' bucket to a dedicated Google Drive folder
-- =============================================================================
--  * portfolio_items gains drive_file_id (the media reference). storage_path stays, nullable, ONLY so
--    items uploaded before this migration keep working until they are moved to Drive.
--  * portfolio_settings remembers the dedicated Drive folder per studio.
--  * All media mutations now go through Edge Functions (which verify the file in Drive and trash it on
--    delete). The browser can no longer insert/delete rows or point an item at an arbitrary file id:
--    it may only edit title, caption and order.
--  * Media is served through portfolio-media, which re-checks the link on every request.
-- Idempotent.
-- =============================================================================

alter table portfolio_items add column if not exists drive_file_id text;
alter table portfolio_items alter column storage_path drop not null;
alter table portfolio_items drop constraint if exists portfolio_items_media_ref_chk;
alter table portfolio_items add constraint portfolio_items_media_ref_chk check (drive_file_id is not null or storage_path is not null);
create unique index if not exists portfolio_items_drive_file_uidx on portfolio_items(drive_file_id) where drive_file_id is not null;

create table if not exists portfolio_settings (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  drive_folder_id text,
  updated_at timestamptz not null default now()
);
alter table portfolio_settings enable row level security;
drop policy if exists "Owner reads portfolio settings" on portfolio_settings;
create policy "Owner reads portfolio settings" on portfolio_settings for select using (auth.uid() = user_id);
revoke all on portfolio_settings from anon;
revoke insert, update, delete, truncate on portfolio_settings from authenticated;
grant select on portfolio_settings to authenticated;

-- Browser: read + edit title/caption/order only.
drop policy if exists "Owner manages portfolio items" on portfolio_items;
drop policy if exists "Owner reads portfolio items" on portfolio_items;
drop policy if exists "Owner edits portfolio items" on portfolio_items;
create policy "Owner reads portfolio items" on portfolio_items for select using (auth.uid() = user_id);
create policy "Owner edits portfolio items" on portfolio_items for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
revoke insert, delete, truncate on portfolio_items from authenticated;
revoke update on portfolio_items from authenticated;
grant update (title, caption, sort_order, updated_at) on portfolio_items to authenticated;

-- Public viewer data (service role only, used by portfolio-view). Returns NO file references.
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
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'kind', i.kind, 'title', i.title, 'caption', i.caption, 'mime_type', i.mime_type)
                            order by i.sort_order, i.created_at), '[]'::jsonb)
    into v_items from portfolio_items i where i.user_id = l.user_id;
  return jsonb_build_object('link_id', l.id, 'studio_name', coalesce(v_studio, ''), 'items', v_items);
end
$$;

-- Live authorization for every media request (service role only).
--   p_link set  -> public viewer: the link must still be active and belong to the item's owner
--   p_link null -> owner preview: the item must belong to p_user
create or replace function public.portfolio_authorize_media(p_item uuid, p_link uuid, p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare i portfolio_items%rowtype; l portfolio_links%rowtype;
begin
  select * into i from portfolio_items where id = p_item;
  if not found then return null; end if;
  if p_link is not null then
    select * into l from portfolio_links where id = p_link;
    if not found or l.user_id <> i.user_id or l.revoked_at is not null or (l.expires_at is not null and l.expires_at <= now()) then return null; end if;
  elsif p_user is null or i.user_id <> p_user then
    return null;
  end if;
  return jsonb_build_object('user_id', i.user_id, 'kind', i.kind, 'mime_type', i.mime_type, 'size_bytes', i.size_bytes,
                            'drive_file_id', i.drive_file_id, 'storage_path', i.storage_path);
end
$$;

revoke all on function public.portfolio_public_get(text) from public, anon, authenticated;
revoke all on function public.portfolio_authorize_media(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.portfolio_public_get(text) to service_role;
grant execute on function public.portfolio_authorize_media(uuid, uuid, uuid) to service_role;
