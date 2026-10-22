-- Studio portfolio (Google Drive edition): access rules, link lifecycle, live media authorization.
drop schema if exists _t cascade;
create schema _t; grant usage on schema _t to public;
create table _t.results (name text, ok boolean); grant all on _t.results to public;
create function _t.chk(p_name text, p_ok boolean) returns void language plpgsql as $$
begin insert into _t.results values (p_name, coalesce(p_ok, false)); raise notice '%: %', case when coalesce(p_ok, false) then 'PASS' else 'FAIL' end, p_name; end $$;
create function _t.err(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null; exception when others then return sqlerrm; end $$;
create function _t.as_user(u uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', coalesce(u::text, ''), false); execute 'reset role'; execute 'set role authenticated'; end $$;
create function _t.as_anon() returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', '', false); execute 'reset role'; execute 'set role anon'; end $$;
create function _t.as_super() returns void language plpgsql as $$ begin execute 'reset role'; end $$;

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000d1', 'owner@example.com'), ('00000000-0000-0000-0000-0000000000d2', 'other@example.com');
insert into user_settings (user_id, studio_name) values ('00000000-0000-0000-0000-0000000000d1', 'Studio D1') on conflict (user_id) do update set studio_name = 'Studio D1';

do $$
declare o uuid := '00000000-0000-0000-0000-0000000000d1'; x uuid := '00000000-0000-0000-0000-0000000000d2';
        v_item uuid; v_item2 uuid; v_legacy uuid; v_xlink uuid; v_tok text; v_link uuid; v_pub jsonb; v_auth jsonb;
begin
  -- Seed as the service role (this is what the portfolio-drive Edge Function does).
  perform _t.as_super();
  insert into portfolio_items (user_id, kind, title, drive_file_id, mime_type, size_bytes, sort_order) values (o, 'image', 'Poster', 'drive-file-aaaaaaaa', 'image/png', 1000, 1) returning id into v_item;
  insert into portfolio_items (user_id, kind, title, drive_file_id, mime_type, size_bytes, sort_order) values (o, 'video', 'Reel', 'drive-file-bbbbbbbb', 'video/mp4', 9000, 0) returning id into v_item2;
  perform _t.chk('db: an item needs a media reference', _t.err(format('insert into portfolio_items (user_id, kind, mime_type, size_bytes) values (%L, ''image'', ''image/png'', 5)', o)) ilike '%media_ref_chk%'
                 or _t.err(format('insert into portfolio_items (user_id, kind, storage_path, mime_type, size_bytes) values (%L, ''image'', null, ''image/png'', 5)', o)) ilike '%media_ref_chk%');
  perform _t.chk('db: the same Drive file cannot back two items', _t.err(format('insert into portfolio_items (user_id, kind, drive_file_id, mime_type, size_bytes) values (%L, ''image'', ''drive-file-aaaaaaaa'', ''image/png'', 5)', o)) ilike '%duplicate%');

  -- Owner: read + edit title/caption/order only.
  perform _t.as_user(o);
  perform _t.chk('owner: sees own items', (select count(*) from portfolio_items) = 2);
  update portfolio_items set title = 'Poster v2', sort_order = 5 where id = v_item;
  perform _t.chk('owner: can edit title and order', (select title from portfolio_items where id = v_item) = 'Poster v2');
  perform _t.chk('owner: cannot repoint an item at another Drive file', _t.err(format('update portfolio_items set drive_file_id = ''evil-file-id-12345'' where id = %L', v_item)) ilike '%permission denied%');
  perform _t.chk('owner: cannot insert rows directly', _t.err(format('insert into portfolio_items (kind, drive_file_id, mime_type, size_bytes) values (''image'', ''x-file-id-1234567'', ''image/png'', 5)')) ilike '%permission denied%');
  perform _t.chk('owner: cannot delete rows directly (deletion must trash the Drive file)', _t.err(format('delete from portfolio_items where id = %L', v_item)) ilike '%permission denied%');
  perform _t.chk('owner: cannot write the Drive folder setting', _t.err(format('insert into portfolio_settings (user_id, drive_folder_id) values (%L, ''f'')', o)) ilike '%permission denied%');

  -- Other user / anon see and touch nothing.
  perform _t.as_user(x);
  perform _t.chk('other user: sees no items', (select count(*) from portfolio_items) = 0);
  perform _t.chk('other user: cannot edit someone else''s item', (with u as (update portfolio_items set title = 'hax' where id = v_item returning 1) select count(*) from u) = 0);
  perform _t.as_anon();
  perform _t.chk('anon: cannot read items', _t.err('select * from portfolio_items') ilike '%permission denied%');

  -- Links
  perform _t.as_user(o);
  select token, link_id into v_tok, v_link from portfolio_create_link('Acme', 30);
  perform _t.chk('link: token is 64 hex chars and only its hash is stored', v_tok ~ '^[0-9a-f]{64}$' and not exists (select 1 from portfolio_links where token_hash = v_tok));
  perform _t.as_user(x);
  perform _t.chk('link: other user cannot create one without items', _t.err('select * from portfolio_create_link(''x'', 30)') ilike '%at least one%');
  perform _t.chk('link: other user cannot revoke it', _t.err(format('select portfolio_revoke_link(%L)', v_link)) ilike '%not found%');

  -- Public viewer data: service role only; no file references leak.
  perform _t.as_user(o);
  perform _t.chk('public_get: not callable by a signed-in user', _t.err(format('select portfolio_public_get(%L)', v_tok)) ilike '%permission denied%');
  perform _t.as_anon();
  perform _t.chk('public_get: not callable by anon', _t.err(format('select portfolio_public_get(%L)', v_tok)) ilike '%permission denied%');
  perform _t.as_super();
  -- A legacy (pre-Drive) item: storage_path only. Must stay listed and authorized, and must not leak its path.
  insert into portfolio_items (user_id, kind, title, storage_path, mime_type, size_bytes, sort_order) values (o, 'image', 'Legacy', o::text || '/legacy.png', 'image/png', 500, 2) returning id into v_legacy;
  v_pub := portfolio_public_get(v_tok);
  perform _t.chk('public_get: returns studio name, link id and ordered items (legacy items included)', v_pub->>'studio_name' = 'Studio D1' and (v_pub->>'link_id')::uuid = v_link and jsonb_array_length(v_pub->'items') = 3 and v_pub->'items'->0->>'title' = 'Reel');
  perform _t.chk('public_get: exposes no Drive ids or storage paths', v_pub::text not like '%drive-file-%' and v_pub::text not like '%storage_path%' and v_pub::text not like '%drive_file_id%' and v_pub::text not like '%legacy.png%');
  perform _t.chk('public_get: bad / unknown tokens return null', portfolio_public_get(repeat('0', 64)) is null and portfolio_public_get('abc') is null and portfolio_public_get(null) is null);
  perform _t.chk('public_get: counts the view', (select view_count from portfolio_links where id = v_link) = 1);

  -- Live media authorization (called on EVERY media request)
  v_auth := portfolio_authorize_media(v_item, v_link, null);
  perform _t.chk('authorize: public link may fetch its owner''s item', v_auth->>'drive_file_id' = 'drive-file-aaaaaaaa' and (v_auth->>'user_id')::uuid = o);
  perform _t.chk('authorize: owner preview works for own item', portfolio_authorize_media(v_item, null, o) is not null);
  perform _t.chk('authorize: another user''s preview is refused', portfolio_authorize_media(v_item, null, x) is null);
  perform _t.chk('authorize: neither link nor user is refused', portfolio_authorize_media(v_item, null, null) is null);
  v_auth := portfolio_authorize_media(v_legacy, v_link, null);
  perform _t.chk('authorize: legacy item yields its storage path and no Drive id (the media function streams it; no signed URL)', v_auth->>'storage_path' = o::text || '/legacy.png' and v_auth->>'drive_file_id' is null and (v_auth->>'user_id')::uuid = o);
  perform _t.chk('authorize: a legacy item is refused to another user''s preview', portfolio_authorize_media(v_legacy, null, x) is null);
  insert into portfolio_links (user_id, token_hash) values (x, repeat('e', 64)) returning id into v_xlink;      -- an ACTIVE link, but owned by someone else
  perform _t.chk('authorize: an active link of ANOTHER owner cannot fetch the item', portfolio_authorize_media(v_item, v_xlink, null) is null and portfolio_authorize_media(v_legacy, v_xlink, null) is null);
  perform _t.chk('authorize: unknown item is refused', portfolio_authorize_media(gen_random_uuid(), v_link, null) is null);
  perform _t.as_user(o);
  perform _t.chk('authorize: not callable from the browser', _t.err(format('select portfolio_authorize_media(%L, null, %L)', v_item, o)) ilike '%permission denied%');
  perform portfolio_revoke_link(v_link);
  perform _t.as_super();
  perform _t.chk('revoked link: public_get returns null', portfolio_public_get(v_tok) is null);
  perform _t.chk('revoked link: media stops IMMEDIATELY (outstanding tickets die)', portfolio_authorize_media(v_item, v_link, null) is null);
  perform _t.chk('revoked link: legacy media stops IMMEDIATELY too', portfolio_authorize_media(v_legacy, v_link, null) is null);
  perform _t.chk('revoked link: the owner''s own preview of the legacy item still works', portfolio_authorize_media(v_legacy, null, o) is not null);
  update portfolio_links set revoked_at = null, expires_at = now() - interval '1 minute' where id = v_link;
  perform _t.chk('expired link: public_get and media refused', portfolio_public_get(v_tok) is null and portfolio_authorize_media(v_item, v_link, null) is null);
  perform _t.chk('expired link: legacy media refused', portfolio_authorize_media(v_legacy, v_link, null) is null);
end $$;

do $$
declare v_fail int;
begin
  select count(*) into v_fail from _t.results where not ok;
  raise notice 'SUMMARY: % checks, % failed', (select count(*) from _t.results), v_fail;
  if v_fail > 0 then raise exception 'FAILED CHECKS: %', v_fail; end if;
end $$;
