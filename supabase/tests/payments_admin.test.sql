-- Admin-only + provider-neutral checks. Runs after payments.test.sql (same scratch DB, _t helpers
-- are created again in a fresh schema name to stay independent).
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

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000c1', 'admin2@example.com'), ('00000000-0000-0000-0000-0000000000c2', 'member@example.com');
insert into user_settings (user_id, is_admin) values ('00000000-0000-0000-0000-0000000000c1', true), ('00000000-0000-0000-0000-0000000000c2', false)
  on conflict (user_id) do update set is_admin = excluded.is_admin;

do $$
declare adm uuid := '00000000-0000-0000-0000-0000000000c1'; mem uuid := '00000000-0000-0000-0000-0000000000c2';
        v_proj uuid; v_inv uuid; v_tok text; v_sess uuid; v_pub jsonb; r record;
begin
  -- Admin gate ------------------------------------------------------------------------------
  perform _t.as_user(adm);
  perform _t.chk('admin: payments_is_admin() is true', payments_is_admin());
  perform _t.as_user(mem);
  perform _t.chk('member: payments_is_admin() is false', not payments_is_admin());
  perform _t.chk('member: cannot list providers', _t.err('select * from payments_list_providers()') ilike '%administrators only%');
  perform _t.chk('member: cannot create a payment link', _t.err('select * from payments_create_checkout_session(gen_random_uuid(), null, 14)') ilike '%administrators only%');
  perform _t.chk('member: legacy prepare_charge is admin-gated', _t.err('select * from payments_prepare_charge(gen_random_uuid(), null, ''a@b.co'')') ilike '%administrators only%');
  perform _t.chk('member: legacy payout request is admin-gated', _t.err('select payments_create_payout_request(gen_random_uuid(), 1, '''')') ilike '%administrators only%');
  perform _t.chk('member: *_impl functions are not callable', _t.err('select payments_retry_apply_impl(gen_random_uuid())') ilike '%permission denied%');
  perform _t.chk('member: cannot write payment_providers directly', _t.err('insert into payment_providers (provider, display_name) values (''wise'', ''Wise'')') ilike '%permission denied%');
  perform _t.chk('member: reads zero rows from every payments table',
    (select count(*) from payment_providers) + (select count(*) from payment_checkout_sessions) + (select count(*) from payment_transactions)
    + (select count(*) from payment_events) + (select count(*) from paystack_transactions) + (select count(*) from freelancer_payout_requests) = 0);
  perform _t.as_anon();
  perform _t.chk('anon: cannot call admin RPCs', _t.err('select * from payments_list_providers()') ilike '%permission denied%');
  perform _t.chk('anon: cannot read sessions table', _t.err('select * from payment_checkout_sessions') ilike '%permission denied%');

  -- Providers: Wise enabled + primary + not connected; the rest Coming Soon ---------------------
  perform _t.as_user(adm);
  perform _t.chk('admin: 5 providers seeded', (select count(*) from payments_list_providers()) = 5);
  perform _t.chk('admin: Wise is enabled, primary, not connected',
    exists (select 1 from payment_providers where user_id = adm and provider = 'wise' and is_enabled and is_primary and status = 'not_connected'));
  perform _t.chk('admin: other providers are coming_soon and disabled',
    (select count(*) from payment_providers where user_id = adm and provider <> 'wise' and status = 'coming_soon' and not is_enabled and not is_primary) = 4);
  perform _t.chk('admin: cannot enable a coming_soon provider', _t.err('select payments_set_provider_enabled(''paypal'', true)') ilike '%not available yet%');
  perform _t.chk('admin: cannot make a coming_soon provider primary', _t.err('select payments_set_primary_provider(''paystack'')') ilike '%not available yet%');

  -- Checkout sessions ------------------------------------------------------------------------
  insert into projects (name, client, currency) values ('PX', 'Acme', '$') returning id into v_proj;
  insert into invoices (project_id, invoice_number, amount, currency, issue_date) values (v_proj, 'INV-W1', 800, '$', '2026-10-01') returning id into v_inv;
  select token, session_id into v_tok, v_sess from payments_create_checkout_session(v_inv, null, 14);
  perform _t.chk('session: token is 64 hex chars', v_tok ~ '^[0-9a-f]{64}$');
  perform _t.chk('session: only the hash is stored (token appears nowhere)', not exists (select 1 from payment_checkout_sessions where token_hash = v_tok or token_hash like '%' || v_tok || '%'));
  perform _t.chk('session: amount derived from invoice', (select amount from payment_checkout_sessions where id = v_sess) = 800);
  perform _t.chk('session: over-collection refused', _t.err(format('select * from payments_create_checkout_session(%L, 900, 14)', v_inv)) ilike '%exceeds%');
  perform _t.chk('session: bad expiry refused', _t.err(format('select * from payments_create_checkout_session(%L, null, 0)', v_inv)) ilike '%between 1 and 90%');

  -- Public checkout (anon) -------------------------------------------------------------------
  perform _t.as_anon();
  v_pub := payments_public_checkout(v_tok);
  perform _t.chk('public: valid token returns the invoice view', (v_pub->>'found')::boolean and v_pub->>'invoice_number' = 'INV-W1' and (v_pub->>'amount')::numeric = 800 and v_pub->>'status' = 'open');
  perform _t.chk('public: exposes no internal ids', not (v_pub ? 'user_id') and not (v_pub ? 'invoice_id') and not (v_pub ? 'id'));
  perform _t.chk('public: Wise not offered while not connected', jsonb_array_length(v_pub->'methods') = 0);
  perform _t.chk('public: unknown, malformed and invoice-id-like tokens all look the same',
    payments_public_checkout(repeat('0', 64)) = '{"found": false}'::jsonb and payments_public_checkout('abc') = '{"found": false}'::jsonb
    and payments_public_checkout(v_inv::text) = '{"found": false}'::jsonb and payments_public_checkout(null) = '{"found": false}'::jsonb);

  -- Connected + enabled provider is offered, primary first (simulates the future state) ----------
  perform _t.as_super();
  update payment_providers set status = 'connected' where user_id = adm and provider = 'wise';
  perform _t.as_anon();
  perform _t.chk('public: connected+enabled Wise is offered as primary',
    payments_public_checkout(v_tok)->'methods'->0->>'provider' = 'wise' and (payments_public_checkout(v_tok)->'methods'->0->>'primary')::boolean);

  -- Cancel / expiry ---------------------------------------------------------------------------
  perform _t.as_user(adm);
  perform payments_cancel_checkout_session(v_sess);
  perform _t.as_anon();
  perform _t.chk('public: cancelled link is not payable', payments_public_checkout(v_tok)->>'status' = 'cancelled' and jsonb_array_length(payments_public_checkout(v_tok)->'methods') = 0);
  perform _t.as_super();
  insert into payment_checkout_sessions (user_id, invoice_id, token_hash, amount, currency, expires_at)
  values (adm, v_inv, encode(sha256(convert_to(repeat('b', 64), 'UTF8')), 'hex'), 10, 'USD', now() - interval '1 day');
  perform _t.as_anon();
  perform _t.chk('public: expired link reports expired', payments_public_checkout(repeat('b', 64))->>'status' = 'expired');

  -- Tenant isolation --------------------------------------------------------------------------
  perform _t.as_user(mem);
  perform _t.chk('member: cannot see the admin''s sessions', (select count(*) from payment_checkout_sessions) = 0);
end $$;

do $$
declare v_fail int;
begin
  select count(*) into v_fail from _t.results where not ok;
  raise notice 'SUMMARY: % checks, % failed', (select count(*) from _t.results), v_fail;
  if v_fail > 0 then raise exception 'FAILED CHECKS: %', v_fail; end if;
end $$;
