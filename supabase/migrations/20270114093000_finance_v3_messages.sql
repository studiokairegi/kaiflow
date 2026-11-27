-- Finance V3, Phase 3 (migration 4 of 6): Finance transactional messages (outbound email through Resend).
--
-- Finance owns the intent, the content snapshot, the status, the attempts and the audit trail of every Finance email. Resend only
-- transports. The Resend message id is stored for correlation and is never used as an invoice or transaction identifier.
-- Queueing writes only finance_v3 rows: it never posts a journal entry and never changes an amount. A Resend outage can therefore
-- never invalidate an invoice or a payment (docs/finance-v3/FINANCE_V3_RESEND_INTEGRATION_SPEC.md, 4.6).
-- Reuse: this does not touch the Inbox tables, the Inbox webhook claim table or the Intelligence tables.
-- Rollback: supabase/rollback/20270114093000_finance_v3_messages.rollback.sql
--
-- NOT EXECUTED: written in a sandbox without PostgreSQL; statically checked only. See PHASE_3_HANDOFF.md.

begin;

insert into finance_v3.schema_version (version, notes)
values ('20270114093000', 'phase 3 migration 4: Finance email messages, attempts, events, queue and delivery-event RPCs')
on conflict (version) do nothing;

create table if not exists finance_v3.email_messages (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references finance_v3.org_settings(organization_id) on delete restrict,
  invoice_id         uuid,
  payment_id         uuid,
  receipt_id         uuid,
  refund_id          uuid,
  financial_event_id uuid,
  client_id          uuid not null,
  email_type         text not null check (email_type in ('invoice', 'invoice_reminder', 'overdue_notice', 'payment_receipt', 'invoice_update', 'refund_notice')),
  recipient          text not null check (char_length(recipient) <= 254 and recipient ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$'),
  sender             text not null check (char_length(sender) <= 400),
  reply_to           text,
  subject            text check (subject is null or char_length(subject) <= 998),
  body_html          text check (body_html is null or char_length(body_html) <= 200000),
  body_text          text check (body_text is null or char_length(body_text) <= 200000),
  rendered_at        timestamptz,
  template_key       text not null,
  template_version   integer not null default 1,
  payload            jsonb not null default '{}'::jsonb,
  attachments        jsonb not null default '[]'::jsonb,
  status             text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'delivered', 'bounced', 'failed')),
  delivery_flags     text[] not null default '{}'::text[],
  provider           text not null default 'resend',
  provider_message_id text,
  idempotency_key    text not null check (char_length(idempotency_key) between 1 and 200 and idempotency_key ~ '^[A-Za-z0-9_.:-]+$'),
  attempt_count      integer not null default 0,
  next_attempt_at    timestamptz,
  lease_until        timestamptz,
  unknown_outcome    boolean not null default false,
  resend_of          uuid,
  trigger_name       text not null default 'user',
  created_by         uuid,
  created_at         timestamptz not null default now(),
  queued_at          timestamptz not null default now(),
  sent_at            timestamptz,
  delivered_at       timestamptz,
  failed_at          timestamptz,
  failure_code       text check (failure_code is null or char_length(failure_code) <= 80),
  failure_detail     text check (failure_detail is null or char_length(failure_detail) <= 400),
  constraint uq_email_org_id unique (organization_id, id),
  constraint uq_email_key unique (organization_id, idempotency_key),
  constraint fk_email_client foreign key (organization_id, client_id) references finance_v3.contacts_v3 (organization_id, id) on delete restrict,
  constraint fk_email_invoice foreign key (organization_id, invoice_id) references finance_v3.receivables (organization_id, id) on delete restrict,
  constraint fk_email_payment foreign key (organization_id, payment_id) references finance_v3.payments (organization_id, id) on delete restrict,
  constraint fk_email_receipt foreign key (organization_id, receipt_id) references finance_v3.receipts (organization_id, id) on delete restrict,
  constraint fk_email_refund foreign key (organization_id, refund_id) references finance_v3.refunds (organization_id, id) on delete restrict,
  constraint fk_email_resend foreign key (organization_id, resend_of) references finance_v3.email_messages (organization_id, id) on delete restrict,
  constraint ck_email_sent_has_id check (status not in ('sent', 'delivered') or sent_at is not null)
);
create unique index if not exists uq_email_provider_id on finance_v3.email_messages (provider, provider_message_id) where provider_message_id is not null;
create index if not exists ix_email_due on finance_v3.email_messages (status, next_attempt_at, lease_until);
create index if not exists ix_email_invoice on finance_v3.email_messages (organization_id, invoice_id, created_at desc);

create table if not exists finance_v3.email_attempts (
  id                  bigint generated always as identity primary key,
  organization_id     uuid not null,
  message_id          uuid not null,
  attempt_no          integer not null,
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  outcome             text check (outcome is null or outcome in ('accepted', 'rejected', 'retryable', 'unknown')),
  http_status         integer,
  provider_message_id text,
  error_detail        text check (error_detail is null or char_length(error_detail) <= 400),
  constraint uq_attempt unique (message_id, attempt_no),
  constraint fk_attempt_msg foreign key (organization_id, message_id) references finance_v3.email_messages (organization_id, id) on delete restrict
);

create table if not exists finance_v3.email_events (
  id                  bigint generated always as identity primary key,
  organization_id     uuid,
  message_id          uuid,
  provider            text not null default 'resend',
  provider_event_id   text not null check (char_length(provider_event_id) between 1 and 200),
  event_type          text not null check (char_length(event_type) between 1 and 80),
  provider_message_id text,
  bounce_type         text,
  occurred_at         timestamptz,
  applied             boolean not null default false,
  apply_error         text check (apply_error is null or char_length(apply_error) <= 300),
  received_at         timestamptz not null default now(),
  constraint uq_email_event unique (provider, provider_event_id)
);
create index if not exists ix_email_events_unapplied on finance_v3.email_events (applied, received_at) where applied = false;
create index if not exists ix_email_events_msg on finance_v3.email_events (message_id, received_at);

-- Attempts are append-only evidence; messages are never deleted; events may only flip applied/apply_error/message link.
drop trigger if exists tg_append_only on finance_v3.email_attempts;
create or replace function finance_v3.tg_guard_email_attempts()
returns trigger language plpgsql set search_path = pg_catalog, finance_v3 as $$
begin
  if tg_op = 'DELETE' then raise exception 'Email attempts are never deleted.' using errcode = 'V3002'; end if;
  if new.message_id <> old.message_id or new.attempt_no <> old.attempt_no or old.finished_at is not null then
    raise exception 'A finished email attempt cannot be changed.' using errcode = 'V3002';
  end if;
  return new;
end; $$;
drop trigger if exists tg_guard_email_attempts on finance_v3.email_attempts;
create trigger tg_guard_email_attempts before update or delete on finance_v3.email_attempts for each row execute function finance_v3.tg_guard_email_attempts();

create or replace function finance_v3.tg_guard_email_events()
returns trigger language plpgsql set search_path = pg_catalog, finance_v3 as $$
begin
  if tg_op = 'DELETE' then raise exception 'Email events are never deleted.' using errcode = 'V3002'; end if;
  if new.provider_event_id <> old.provider_event_id or new.event_type <> old.event_type or new.provider_message_id is distinct from old.provider_message_id then
    raise exception 'The identity of an email event cannot change.' using errcode = 'V3002';
  end if;
  return new;
end; $$;
drop trigger if exists tg_guard_email_events on finance_v3.email_events;
create trigger tg_guard_email_events before update or delete on finance_v3.email_events for each row execute function finance_v3.tg_guard_email_events();

create or replace function finance_v3.tg_guard_email_messages()
returns trigger language plpgsql set search_path = pg_catalog, finance_v3 as $$
begin
  if tg_op = 'DELETE' then raise exception 'Email messages are never deleted.' using errcode = 'V3002'; end if;
  if new.organization_id <> old.organization_id or new.recipient <> old.recipient or new.idempotency_key <> old.idempotency_key
     or new.email_type <> old.email_type or new.client_id <> old.client_id then
    raise exception 'The identity of an email message cannot change.' using errcode = 'V3002';
  end if;
  if old.rendered_at is not null and (new.subject is distinct from old.subject or new.body_html is distinct from old.body_html
                                      or new.body_text is distinct from old.body_text) then
    raise exception 'A rendered email keeps its content; retries send exactly the same message.' using errcode = 'V3002';
  end if;
  if old.status = 'delivered' and new.status <> 'delivered' then
    raise exception 'A delivered email cannot go backwards.' using errcode = 'V3002';
  end if;
  return new;
end; $$;
drop trigger if exists tg_guard_email_messages on finance_v3.email_messages;
create trigger tg_guard_email_messages before update or delete on finance_v3.email_messages for each row execute function finance_v3.tg_guard_email_messages();

alter table finance_v3.email_messages enable row level security;
alter table finance_v3.email_attempts enable row level security;
alter table finance_v3.email_events   enable row level security;
drop policy if exists fin3_select_email_messages on finance_v3.email_messages;
create policy fin3_select_email_messages on finance_v3.email_messages for select to authenticated using (finance_v3.has_permission(organization_id, 'finance.read'));
drop policy if exists fin3_select_email_attempts on finance_v3.email_attempts;
create policy fin3_select_email_attempts on finance_v3.email_attempts for select to authenticated using (finance_v3.has_permission(organization_id, 'finance.view_integrations'));
drop policy if exists fin3_select_email_events on finance_v3.email_events;
create policy fin3_select_email_events on finance_v3.email_events for select to authenticated
  using (organization_id is not null and finance_v3.has_permission(organization_id, 'finance.view_integrations'));
revoke all on finance_v3.email_messages, finance_v3.email_attempts, finance_v3.email_events from public, anon, authenticated, service_role;
grant select on finance_v3.email_messages, finance_v3.email_attempts, finance_v3.email_events to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.valid_email(p_email text)
returns boolean language sql immutable set search_path = pg_catalog, finance_v3 as $$
  select p_email is not null and char_length(p_email) <= 254 and p_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$' $$;

-- Mint a link token (stored hashed). Internal; returns the plaintext once.
create or replace function finance_v3.mint_link(p_org uuid, p_invoice uuid, p_kind text, p_days integer, p_actor uuid)
returns text
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  -- Earlier links stay valid (an earlier email must keep working); explicit regeneration (fin3_create_payment_link) revokes.
  insert into finance_v3.public_links (organization_id, invoice_id, kind, token_hash, expires_at, created_by)
  values (p_org, p_invoice, p_kind, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), now() + make_interval(days => p_days), p_actor);
  return v_token;
end;
$$;

create or replace function finance_v3.email_json(m finance_v3.email_messages)
returns jsonb language sql stable set search_path = pg_catalog, finance_v3 as $$
  select jsonb_build_object('id', m.id, 'invoice_id', m.invoice_id, 'payment_id', m.payment_id, 'receipt_id', m.receipt_id,
    'refund_id', m.refund_id, 'client_id', m.client_id, 'email_type', m.email_type, 'recipient', m.recipient, 'subject', m.subject,
    'status', m.status, 'delivery_flags', to_jsonb(m.delivery_flags), 'attempt_count', m.attempt_count, 'unknown_outcome', m.unknown_outcome,
    'created_at', m.created_at, 'sent_at', m.sent_at, 'delivered_at', m.delivered_at, 'failed_at', m.failed_at,
    'failure_code', m.failure_code, 'failure_detail', m.failure_detail, 'resend_of', m.resend_of);
$$;

-- Core queue function. Idempotent by (organization, key): a replay returns the existing message. Never touches money.
create or replace function finance_v3.queue_email(
  p_org uuid, p_type text, p_template text, p_invoice uuid, p_payment uuid, p_receipt uuid, p_refund uuid, p_client uuid,
  p_recipient text, p_key text, p_payload jsonb, p_actor uuid, p_resend_of uuid, p_trigger text)
returns finance_v3.email_messages
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  s finance_v3.org_settings;
  m finance_v3.email_messages;
  v_to text := lower(btrim(coalesce(p_recipient, '')));
  v_sender text;
begin
  select * into m from finance_v3.email_messages x where x.organization_id = p_org and x.idempotency_key = p_key;
  if found then return m; end if;
  if not finance_v3.valid_email(v_to) then
    raise exception 'There is no valid recipient email address.' using errcode = 'V3018';
  end if;
  select * into s from finance_v3.org_settings where organization_id = p_org;
  if s.email_from_address is null then
    raise exception 'Set the studio email sender in the Finance settings before sending email.' using errcode = 'V3018';
  end if;
  v_sender := case when s.email_from_name is null then s.email_from_address
                   else replace(replace(s.email_from_name, '"', ''), '<', '') || ' <' || s.email_from_address || '>' end;
  insert into finance_v3.email_messages (organization_id, invoice_id, payment_id, receipt_id, refund_id, client_id, email_type, recipient,
    sender, reply_to, template_key, payload, idempotency_key, next_attempt_at, resend_of, trigger_name, created_by)
  values (p_org, p_invoice, p_payment, p_receipt, p_refund, p_client, p_type, v_to, v_sender, coalesce(s.email_reply_to, s.studio_email),
    p_template, coalesce(p_payload, '{}'::jsonb), p_key, now(), p_resend_of, p_trigger, p_actor)
  returning * into m;
  perform finance_v3.write_audit(p_org, p_actor, 'queue_email', 'email_message', m.id::text, null,
    jsonb_build_object('type', p_type, 'invoice_id', p_invoice, 'status', 'queued'), null);
  return m;
end;
$$;

create or replace function finance_v3.invoice_email_payload(r finance_v3.receivables, p_view_token text, p_pay_token text)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, finance_v3 as $$
begin
  return jsonb_build_object('invoice_id', r.id, 'invoice_no', r.invoice_no, 'currency', r.currency,
    'total', finance_v3.money_text(r.total, r.currency), 'outstanding', finance_v3.money_text(r.outstanding, r.currency),
    'issue_date', r.issue_date, 'due_date', r.due_date, 'studio', coalesce(r.snapshot -> 'studio', '{}'::jsonb),
    'client', coalesce(r.snapshot -> 'client', '{}'::jsonb), 'view_token', p_view_token, 'pay_token', p_pay_token,
    'attachments_plan', jsonb_build_array(jsonb_build_object('kind', 'invoice_pdf', 'entity_id', r.id)));
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Queue RPCs (the eight Resend service contracts of the Phase 1 specification)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fin3_queue_invoice_email(p_org uuid, p_invoice uuid, p_recipient text default null, p_options jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid  uuid := finance_v3.assert_permission(p_org, 'finance.send_email');
  s      finance_v3.org_settings;
  r      finance_v3.receivables;
  c      finance_v3.contacts_v3;
  m      finance_v3.email_messages;
  v_to   text;
  v_view text;
  v_pay  text;
  v_days integer := coalesce((p_options ->> 'link_expires_days')::integer, 30);
begin
  s := finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  select * into r from finance_v3.receivables x where x.organization_id = p_org and x.id = p_invoice for update;
  if not found then raise exception 'Invoice not found.' using errcode = 'V3010'; end if;
  if r.status not in ('issued', 'partially_paid') then raise exception 'Only an issued invoice with a balance can be emailed.' using errcode = 'V3017'; end if;
  select * into c from finance_v3.contacts_v3 x where x.organization_id = p_org and x.id = r.client_id;
  v_to := lower(btrim(coalesce(p_recipient, c.email, '')));
  if not finance_v3.valid_email(v_to) then raise exception 'There is no valid recipient email address.' using errcode = 'V3018'; end if;
  select * into m from finance_v3.email_messages x where x.organization_id = p_org and x.idempotency_key =
    'fin3:email:invoice:' || r.id::text || ':' || r.revision::text || ':' || substr(encode(sha256(convert_to(v_to, 'UTF8')), 'hex'), 1, 8);
  if found then return finance_v3.email_json(m); end if;
  v_view := finance_v3.mint_link(p_org, r.id, 'view', v_days, v_uid);
  if coalesce((p_options ->> 'include_payment_link')::boolean, true) and r.currency = any (s.collect_currencies) then
    v_pay := finance_v3.mint_link(p_org, r.id, 'pay', v_days, v_uid);
  end if;
  m := finance_v3.queue_email(p_org, 'invoice', 'invoice', r.id, null, null, null, r.client_id, v_to,
    'fin3:email:invoice:' || r.id::text || ':' || r.revision::text || ':' || substr(encode(sha256(convert_to(v_to, 'UTF8')), 'hex'), 1, 8),
    finance_v3.invoice_email_payload(r, v_view, v_pay), v_uid, null, 'user');
  return finance_v3.email_json(m);
end;
$$;

-- Issue and email in ONE transaction: if queueing fails the invoice is not issued (the user is told why); once committed, a
-- later Resend outage cannot undo the issued invoice.
create or replace function public.fin3_issue_and_send_invoice(p_org uuid, p_invoice uuid, p_options jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.post');
  r     finance_v3.receivables;
  v_msg jsonb;
begin
  perform finance_v3.assert_permission(p_org, 'finance.send_email');
  perform finance_v3.assert_org_ready(p_org);
  r := finance_v3.issue_invoice_internal(p_org, p_invoice, v_uid);
  v_msg := public.fin3_queue_invoice_email(p_org, r.id, p_options ->> 'recipient', p_options);
  return jsonb_build_object('invoice', finance_v3.invoice_json(r, false), 'email', v_msg);
end;
$$;

create or replace function public.fin3_queue_invoice_reminder(p_org uuid, p_invoice uuid, p_slot integer default 1)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.send_email');
  s finance_v3.org_settings;
  r finance_v3.receivables;
  c finance_v3.contacts_v3;
  m finance_v3.email_messages;
  v_pay text;
begin
  s := finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  select * into r from finance_v3.receivables x where x.organization_id = p_org and x.id = p_invoice for update;
  if not found then raise exception 'Invoice not found.' using errcode = 'V3010'; end if;
  if r.status not in ('issued', 'partially_paid') or r.outstanding <= 0 then raise exception 'Nothing is outstanding on this invoice.' using errcode = 'V3017'; end if;
  select * into c from finance_v3.contacts_v3 x where x.organization_id = p_org and x.id = r.client_id;
  if r.currency = any (s.collect_currencies) then v_pay := finance_v3.mint_link(p_org, r.id, 'pay', 30, v_uid); end if;
  m := finance_v3.queue_email(p_org, 'invoice_reminder', 'invoice_reminder', r.id, null, null, null, r.client_id, c.email,
    'fin3:email:reminder:' || r.id::text || ':' || to_char(current_date, 'YYYYMMDD') || ':' || coalesce(p_slot, 1)::text,
    finance_v3.invoice_email_payload(r, finance_v3.mint_link(p_org, r.id, 'view', 30, v_uid), v_pay), v_uid, null, 'user');
  return finance_v3.email_json(m);
end;
$$;

create or replace function public.fin3_queue_overdue_notice(p_org uuid, p_invoice uuid, p_date date default current_date)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.send_email');
  s finance_v3.org_settings;
  r finance_v3.receivables;
  c finance_v3.contacts_v3;
  m finance_v3.email_messages;
  v_pay text;
begin
  s := finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  select * into r from finance_v3.receivables x where x.organization_id = p_org and x.id = p_invoice for update;
  if not found then raise exception 'Invoice not found.' using errcode = 'V3010'; end if;
  if r.status not in ('issued', 'partially_paid') or r.outstanding <= 0 or r.due_date is null or r.due_date >= coalesce(p_date, current_date) then
    raise exception 'The invoice is not overdue or has nothing outstanding.' using errcode = 'V3017';
  end if;
  select * into c from finance_v3.contacts_v3 x where x.organization_id = p_org and x.id = r.client_id;
  if r.currency = any (s.collect_currencies) then v_pay := finance_v3.mint_link(p_org, r.id, 'pay', 30, v_uid); end if;
  m := finance_v3.queue_email(p_org, 'overdue_notice', 'overdue_notice', r.id, null, null, null, r.client_id, c.email,
    'fin3:email:overdue:' || r.id::text || ':' || to_char(coalesce(p_date, current_date), 'YYYYMMDD'),
    finance_v3.invoice_email_payload(r, finance_v3.mint_link(p_org, r.id, 'view', 30, v_uid), v_pay)
      || jsonb_build_object('days_overdue', coalesce(p_date, current_date) - r.due_date), v_uid, null, 'user');
  return finance_v3.email_json(m);
end;
$$;

create or replace function public.fin3_queue_invoice_update(p_org uuid, p_invoice uuid, p_note text default null)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.send_email');
  r finance_v3.receivables;
  c finance_v3.contacts_v3;
  m finance_v3.email_messages;
  v_n integer;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  select * into r from finance_v3.receivables x where x.organization_id = p_org and x.id = p_invoice for update;
  if not found then raise exception 'Invoice not found.' using errcode = 'V3010'; end if;
  if r.status in ('draft', 'approved') then raise exception 'The invoice has not been issued.' using errcode = 'V3017'; end if;
  select count(*) into v_n from finance_v3.receivable_credits x where x.organization_id = p_org and x.receivable_id = r.id;
  if v_n = 0 and r.status <> 'void' then raise exception 'There is no credit adjustment or revision to report.' using errcode = 'V3017'; end if;
  select * into c from finance_v3.contacts_v3 x where x.organization_id = p_org and x.id = r.client_id;
  m := finance_v3.queue_email(p_org, 'invoice_update', 'invoice_update', r.id, null, null, null, r.client_id, c.email,
    'fin3:email:update:' || r.id::text || ':' || r.revision::text || '-' || v_n::text || '-' || r.status,
    finance_v3.invoice_email_payload(r, null, null) || jsonb_build_object('note', left(coalesce(p_note, ''), 500), 'invoice_status', r.status, 'credit_total', finance_v3.money_text(r.credit_total, r.currency)),
    v_uid, null, 'user');
  return finance_v3.email_json(m);
end;
$$;

-- Internal: called by payment settlement inside the same transaction as the payment (failure is swallowed by the caller).
create or replace function finance_v3.queue_receipt_email(p_org uuid, p_payment uuid)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  rc finance_v3.receipts;
  pay finance_v3.payments;
  c finance_v3.contacts_v3;
  m finance_v3.email_messages;
begin
  select * into pay from finance_v3.payments x where x.organization_id = p_org and x.id = p_payment;
  select * into rc from finance_v3.receipts x where x.organization_id = p_org and x.payment_id = p_payment;
  if pay.id is null or rc.id is null then raise exception 'A receipt needs a recorded payment.' using errcode = 'V3015'; end if;
  select * into c from finance_v3.contacts_v3 x where x.organization_id = p_org and x.id = pay.client_id;
  m := finance_v3.queue_email(p_org, 'payment_receipt', 'payment_receipt', pay.invoice_id, pay.id, rc.id, null, pay.client_id, c.email,
    'fin3:email:receipt:' || rc.id::text,
    jsonb_build_object('receipt_id', rc.id, 'receipt_no', rc.receipt_no, 'invoice_id', pay.invoice_id, 'receipt', rc.snapshot,
      'attachments_plan', jsonb_build_array(jsonb_build_object('kind', 'receipt_pdf', 'entity_id', rc.id))),
    pay.verified_by, null, case when pay.provider is null then 'user' else 'payment_webhook' end);
  return m.id;
end;
$$;

create or replace function finance_v3.queue_refund_email(p_org uuid, p_refund uuid)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  f finance_v3.refunds;
  pay finance_v3.payments;
  r finance_v3.receivables;
  c finance_v3.contacts_v3;
  m finance_v3.email_messages;
begin
  select * into f from finance_v3.refunds x where x.organization_id = p_org and x.id = p_refund;
  select * into pay from finance_v3.payments x where x.organization_id = p_org and x.id = f.payment_id;
  select * into r from finance_v3.receivables x where x.organization_id = p_org and x.id = f.invoice_id;
  select * into c from finance_v3.contacts_v3 x where x.organization_id = p_org and x.id = pay.client_id;
  m := finance_v3.queue_email(p_org, 'refund_notice', 'refund_notice', r.id, pay.id, null, f.id, pay.client_id, c.email,
    'fin3:email:refund:' || f.id::text,
    jsonb_build_object('invoice_id', r.id, 'invoice_no', r.invoice_no, 'refund_no', f.refund_no, 'currency', f.currency,
      'refund_amount', finance_v3.money_text(f.amount, f.currency), 'studio', coalesce(r.snapshot -> 'studio', '{}'::jsonb),
      'client', coalesce(r.snapshot -> 'client', '{}'::jsonb)), f.processed_by, null, 'refund');
  return m.id;
end;
$$;

-- Authorized (re)queue of a receipt email, for example after a failed automatic queue.
create or replace function public.fin3_queue_receipt_email(p_org uuid, p_receipt uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  rc finance_v3.receipts;
  m finance_v3.email_messages;
  v_id uuid;
begin
  perform finance_v3.assert_permission(p_org, 'finance.send_email');
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  select * into rc from finance_v3.receipts x where x.organization_id = p_org and x.id = p_receipt;
  if not found then raise exception 'Receipt not found.' using errcode = 'V3010'; end if;
  v_id := finance_v3.queue_receipt_email(p_org, rc.payment_id);
  select * into m from finance_v3.email_messages x where x.id = v_id;
  return finance_v3.email_json(m);
end;
$$;

create or replace function public.fin3_retry_email(p_org uuid, p_message uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.send_email');
  m finance_v3.email_messages;
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  select * into m from finance_v3.email_messages x where x.organization_id = p_org and x.id = p_message for update;
  if not found then raise exception 'Email not found.' using errcode = 'V3010'; end if;
  if m.status = 'queued' then return finance_v3.email_json(m); end if;
  if m.status <> 'failed' or m.unknown_outcome or m.failure_code = 'outcome_unknown' then
    raise exception 'Only a failed email with a known outcome can be retried. Use resend for the others.' using errcode = 'V3017';
  end if;
  update finance_v3.email_messages x set status = 'queued', next_attempt_at = now(), lease_until = null, failed_at = null,
         failure_code = null, failure_detail = null where x.id = m.id returning * into m;
  perform finance_v3.write_audit(p_org, v_uid, 'retry_email', 'email_message', m.id::text, null, null, null);
  return finance_v3.email_json(m);
end;
$$;

-- Manual resend: a NEW message linked to the original (a duplicate is possible if the original actually arrived).
create or replace function public.fin3_resend_email(p_org uuid, p_message uuid, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_uid uuid := finance_v3.assert_permission(p_org, 'finance.send_email');
  o finance_v3.email_messages;
  m finance_v3.email_messages;
  v_n integer;
  v_reason text := nullif(btrim(p_reason), '');
begin
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.lock_org(p_org);
  if v_reason is null or char_length(v_reason) > 500 then raise exception 'A reason is required to resend an email.' using errcode = 'V3011'; end if;
  select * into o from finance_v3.email_messages x where x.organization_id = p_org and x.id = p_message;
  if not found then raise exception 'Email not found.' using errcode = 'V3010'; end if;
  if o.status in ('queued', 'sending') and not o.unknown_outcome then raise exception 'This email is still being sent.' using errcode = 'V3017'; end if;
  select count(*) + 1 into v_n from finance_v3.email_messages x where x.organization_id = p_org and x.resend_of = o.id;
  m := finance_v3.queue_email(p_org, o.email_type, o.template_key, o.invoice_id, o.payment_id, o.receipt_id, o.refund_id, o.client_id, o.recipient,
    'fin3:email:resend:' || o.id::text || ':' || v_n::text, o.payload, v_uid, o.id, 'user');
  perform finance_v3.write_audit(p_org, v_uid, 'resend_email', 'email_message', m.id::text, null, jsonb_build_object('original', o.id), v_reason);
  return finance_v3.email_json(m);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Communication history: one timeline of emails and financial events for an invoice (kinds keep them distinguishable).
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fin3_list_invoice_communications(p_org uuid, p_invoice uuid, p_before timestamptz default null, p_limit integer default 100)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 300); v_out jsonb;
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  if not exists (select 1 from finance_v3.receivables r where r.organization_id = p_org and r.id = p_invoice) then
    raise exception 'Invoice not found.' using errcode = 'V3010';
  end if;
  select coalesce(jsonb_agg(t.item order by t.at desc, t.sort_id desc), '[]'::jsonb) into v_out from (
    select * from (
      select m.created_at as at, m.id::text as sort_id, jsonb_build_object('kind', 'email', 'at', m.created_at, 'email', finance_v3.email_json(m),
               'provider_message_id', m.provider_message_id) as item
        from finance_v3.email_messages m where m.organization_id = p_org and m.invoice_id = p_invoice
      union all
      select p.created_at, p.id::text, jsonb_build_object('kind', 'payment', 'at', p.created_at, 'payment', finance_v3.payment_json(p))
        from finance_v3.payments p where p.organization_id = p_org and p.invoice_id = p_invoice
      union all
      select rc.issued_at, rc.id::text, jsonb_build_object('kind', 'receipt', 'at', rc.issued_at, 'receipt_id', rc.id, 'receipt_no', rc.receipt_no, 'status', rc.status)
        from finance_v3.receipts rc where rc.organization_id = p_org and rc.invoice_id = p_invoice
      union all
      select f.created_at, f.id::text, jsonb_build_object('kind', 'refund', 'at', f.created_at, 'refund', finance_v3.refund_json(f))
        from finance_v3.refunds f where f.organization_id = p_org and f.invoice_id = p_invoice
      union all
      select i.created_at, i.id::text, jsonb_build_object('kind', 'payment_attempt', 'at', i.created_at, 'status', i.status, 'reference', i.provider_reference,
               'environment', i.environment, 'review_reason', i.review_reason)
        from finance_v3.payment_intents i where i.organization_id = p_org and i.invoice_id = p_invoice
      union all
      select c.created_at, c.id::text, jsonb_build_object('kind', 'credit', 'at', c.created_at, 'credit_no', c.credit_no,
               'amount', finance_v3.money_text(c.amount, c.currency), 'reason', c.reason)
        from finance_v3.receivable_credits c where c.organization_id = p_org and c.receivable_id = p_invoice
      union all
      select a.at, a.id::text, jsonb_build_object('kind', 'invoice_event', 'at', a.at, 'action', a.action)
        from finance_v3.audit_log a where a.organization_id = p_org and a.object_type = 'receivable' and a.object_id = p_invoice::text
         and a.action in ('issue_invoice', 'approve_invoice', 'void_invoice', 'credit_invoice', 'create_invoice_draft')
    ) u where p_before is null or u.at < p_before
    order by u.at desc, u.sort_id desc limit v_limit) t;
  return v_out;
end;
$$;

create or replace function public.fin3_list_emails(p_org uuid, p_status text default null, p_limit integer default 100)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  perform finance_v3.assert_permission(p_org, 'finance.view_integrations');
  perform finance_v3.assert_org_ready(p_org);
  return coalesce((select jsonb_agg(finance_v3.email_json(m) order by m.created_at desc, m.id desc)
    from (select * from finance_v3.email_messages x where x.organization_id = p_org and (p_status is null or x.status = p_status)
           order by x.created_at desc, x.id desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) m), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- SERVICE functions for the dispatcher Edge Function and the Resend webhook sink
-- ---------------------------------------------------------------------------------------------------------------
-- Claim due messages with a lease. A message whose lease expired while 'sending' is ambiguous: it is retried with the SAME
-- idempotency key only (never a fresh one), and flagged unknown_outcome.
create or replace function public.fin3svc_claim_emails(p_limit integer default 10, p_lease_seconds integer default 120)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_ids uuid[];
  r record;
begin
  v_ids := array(
    select m.id from finance_v3.email_messages m
     where (m.status = 'queued' and (m.next_attempt_at is null or m.next_attempt_at <= now()))
        or (m.status = 'sending' and m.lease_until is not null and m.lease_until < now())
     order by m.next_attempt_at nulls first, m.created_at
     limit least(greatest(coalesce(p_limit, 10), 1), 50)
     for update skip locked);
  if coalesce(array_length(v_ids, 1), 0) = 0 then return '[]'::jsonb; end if;
  for r in select m.id, m.organization_id, m.status, m.attempt_count from finance_v3.email_messages m where m.id = any (v_ids) loop
    if r.attempt_count >= 5 then
      update finance_v3.email_messages m set status = 'failed', failed_at = now(), failure_code = case when m.unknown_outcome then 'outcome_unknown' else 'retries_exhausted' end,
             failure_detail = 'Automatic delivery attempts were exhausted.', lease_until = null where m.id = r.id;
    else
      update finance_v3.email_messages m set unknown_outcome = m.unknown_outcome or (r.status = 'sending'), status = 'sending',
             attempt_count = m.attempt_count + 1, lease_until = now() + make_interval(secs => p_lease_seconds) where m.id = r.id;
      insert into finance_v3.email_attempts (organization_id, message_id, attempt_no) values (r.organization_id, r.id, r.attempt_count + 1);
    end if;
  end loop;
  return coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'organization_id', m.organization_id, 'attempt_no', m.attempt_count)
                    order by m.created_at) from finance_v3.email_messages m where m.id = any (v_ids) and m.status = 'sending'), '[]'::jsonb);
end;
$$;

create or replace function public.fin3svc_get_email(p_message uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare m finance_v3.email_messages;
begin
  select * into m from finance_v3.email_messages x where x.id = p_message;
  if not found then return null; end if;
  return jsonb_build_object('id', m.id, 'organization_id', m.organization_id, 'invoice_id', m.invoice_id, 'email_type', m.email_type,
    'template_key', m.template_key, 'template_version', m.template_version, 'recipient', m.recipient, 'sender', m.sender, 'reply_to', m.reply_to,
    'payload', m.payload, 'subject', m.subject, 'body_html', m.body_html, 'body_text', m.body_text, 'rendered_at', m.rendered_at,
    'attachments', m.attachments, 'status', m.status, 'attempt_count', m.attempt_count, 'unknown_outcome', m.unknown_outcome,
    'idempotency_key', m.idempotency_key);
end;
$$;

-- First writer wins: a retry sends exactly the content that was first rendered.
create or replace function public.fin3svc_save_rendered(p_message uuid, p_subject text, p_html text, p_text text, p_attachments jsonb)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare m finance_v3.email_messages;
begin
  update finance_v3.email_messages x set subject = p_subject, body_html = p_html, body_text = p_text,
         attachments = coalesce(p_attachments, '[]'::jsonb), rendered_at = now()
   where x.id = p_message and x.rendered_at is null returning * into m;
  if m.id is null then select * into m from finance_v3.email_messages x where x.id = p_message; end if;
  return jsonb_build_object('subject', m.subject, 'body_html', m.body_html, 'body_text', m.body_text, 'attachments', m.attachments);
end;
$$;

create or replace function public.fin3svc_finish_attempt(
  p_message uuid, p_attempt integer, p_outcome text, p_http_status integer, p_provider_message_id text, p_error text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  m finance_v3.email_messages;
  v_backoff integer[] := array[60, 300, 1800, 7200, 43200];
  v_wait integer;
begin
  if p_outcome not in ('accepted', 'rejected', 'retryable', 'unknown') then raise exception 'Unknown outcome.' using errcode = 'V3011'; end if;
  select * into m from finance_v3.email_messages x where x.id = p_message for update;
  if not found then raise exception 'Email not found.' using errcode = 'V3010'; end if;
  update finance_v3.email_attempts a set finished_at = now(), outcome = p_outcome, http_status = p_http_status,
         provider_message_id = p_provider_message_id, error_detail = left(p_error, 400)
   where a.message_id = p_message and a.attempt_no = p_attempt and a.finished_at is null;
  v_wait := v_backoff[least(greatest(m.attempt_count, 1), 5)];
  if p_outcome = 'accepted' then
    update finance_v3.email_messages x set provider_message_id = coalesce(x.provider_message_id, p_provider_message_id),
           status = case when x.status = 'delivered' then 'delivered' else 'sent' end, sent_at = coalesce(x.sent_at, now()),
           next_attempt_at = null, lease_until = null, unknown_outcome = false, failure_code = null, failure_detail = null
     where x.id = m.id returning * into m;
  elsif p_outcome = 'rejected' then
    update finance_v3.email_messages x set status = 'failed', failed_at = now(), failure_code = 'provider_rejected',
           failure_detail = left(p_error, 400), lease_until = null, next_attempt_at = null
     where x.id = m.id and x.status not in ('sent', 'delivered') returning * into m;
  elsif m.attempt_count >= 5 then
    update finance_v3.email_messages x set status = 'failed', failed_at = now(), lease_until = null, next_attempt_at = null,
           failure_code = case when p_outcome = 'unknown' or x.unknown_outcome then 'outcome_unknown' else 'retries_exhausted' end,
           failure_detail = left(p_error, 400)
     where x.id = m.id and x.status not in ('sent', 'delivered') returning * into m;
  elsif p_outcome = 'unknown' then
    update finance_v3.email_messages x set status = 'sending', unknown_outcome = true, lease_until = now() + make_interval(secs => v_wait),
           failure_detail = left(p_error, 400)
     where x.id = m.id and x.status not in ('sent', 'delivered') returning * into m;
  else
    update finance_v3.email_messages x set status = 'queued', next_attempt_at = now() + make_interval(secs => v_wait), lease_until = null,
           failure_detail = left(p_error, 400)
     where x.id = m.id and x.status not in ('sent', 'delivered') returning * into m;
  end if;
  select * into m from finance_v3.email_messages x where x.id = p_message;
  return jsonb_build_object('status', m.status, 'attempt_count', m.attempt_count);
end;
$$;

-- Messages whose ambiguous outcome was never confirmed inside the idempotency window become failed (manual resend only).
-- p_hours must come from Resend's current documentation; the dispatcher passes its configured value (default 24).
create or replace function public.fin3svc_expire_unknown_emails(p_hours integer default 24)
returns integer
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare n integer;
begin
  update finance_v3.email_messages m set status = 'failed', failed_at = now(), failure_code = 'outcome_unknown', lease_until = null, next_attempt_at = null,
         failure_detail = 'No proof that the provider accepted the message within the retry window.'
   where m.status = 'sending' and m.unknown_outcome and m.created_at < now() - make_interval(hours => greatest(coalesce(p_hours, 24), 1));
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Delivery events. Phase 1 (record) is the idempotency point; phase 2 (apply) moves the status forward by rank only.
create or replace function public.fin3svc_record_email_event(
  p_provider_event_id text, p_event_type text, p_provider_message_id text, p_message_id uuid, p_occurred_at timestamptz, p_bounce_type text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  m finance_v3.email_messages;
  e finance_v3.email_events;
begin
  if p_message_id is not null then
    select * into m from finance_v3.email_messages x where x.id = p_message_id;
  end if;
  if m.id is null and p_provider_message_id is not null then
    select * into m from finance_v3.email_messages x where x.provider = 'resend' and x.provider_message_id = p_provider_message_id;
  end if;
  -- An event for a message that is not ours (Inbox / Intelligence) and carries no Finance tag is not recorded at all.
  if m.id is null and p_message_id is null then
    return jsonb_build_object('id', null, 'duplicate', false, 'applied', false, 'found', false, 'ignored', true);
  end if;
  -- message_id keeps the tag value when the message row is not visible yet, so the reconcile pass can still match it.
  insert into finance_v3.email_events (organization_id, message_id, provider_event_id, event_type, provider_message_id, bounce_type, occurred_at)
  values (m.organization_id, coalesce(m.id, p_message_id), p_provider_event_id, p_event_type, p_provider_message_id, p_bounce_type, p_occurred_at)
  on conflict (provider, provider_event_id) do nothing
  returning * into e;
  if e.id is null then
    select * into e from finance_v3.email_events x where x.provider = 'resend' and x.provider_event_id = p_provider_event_id;
    return jsonb_build_object('id', e.id, 'duplicate', true, 'applied', e.applied, 'found', m.id is not null or e.applied);
  end if;
  return jsonb_build_object('id', e.id, 'duplicate', false, 'applied', false, 'found', m.id is not null);
end;
$$;

create or replace function public.fin3svc_apply_email_event(p_event bigint)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  e finance_v3.email_events;
  m finance_v3.email_messages;
  v_status text;
  v_flag text;
  v_rank_old integer;
  v_rank_new integer;
begin
  select * into e from finance_v3.email_events x where x.id = p_event for update;
  if not found then raise exception 'Event not found.' using errcode = 'V3010'; end if;
  if e.applied then return jsonb_build_object('applied', true, 'duplicate', true); end if;
  select * into m from finance_v3.email_messages x
   where (e.message_id is not null and x.id = e.message_id)
      or (e.message_id is null and e.provider_message_id is not null and x.provider = 'resend' and x.provider_message_id = e.provider_message_id)
   limit 1 for update;
  if not found then
    return jsonb_build_object('applied', false, 'found', false);        -- awaiting the send write; the reconciler retries
  end if;
  -- Map the provider event (same rules as financeEmailOutcomeForResendEvent in src/finance-v3/contracts).
  v_status := null; v_flag := null;
  case e.event_type
    when 'email.sent' then v_status := 'sent';
    when 'email.delivered' then v_status := 'delivered';
    when 'email.delivery_delayed' then v_flag := 'delayed';
    when 'email.bounced' then
      if coalesce(e.bounce_type, '') ~* 'temporary|transient|soft' then v_flag := 'delayed'; else v_status := 'bounced'; end if;
    when 'email.complained' then v_flag := 'complained';
    when 'email.failed' then v_status := 'failed';
    when 'email.suppressed' then v_status := 'failed'; v_flag := 'suppressed';
    when 'email.rejected' then v_status := 'failed'; v_flag := 'suppressed';
    else null;
  end case;
  v_rank_old := case m.status when 'queued' then 0 when 'sending' then 1 when 'sent' then 2 when 'delivered' then 3 else 4 end;
  v_rank_new := case v_status when 'queued' then 0 when 'sending' then 1 when 'sent' then 2 when 'delivered' then 3 when 'bounced' then 4 when 'failed' then 4 else -1 end;
  if v_status is not null and m.status not in ('bounced', 'failed') and v_rank_new > v_rank_old
     and not (m.status = 'delivered' and v_rank_new = 4) then      -- a delivered message is never downgraded
    update finance_v3.email_messages x set status = v_status,
           provider_message_id = coalesce(x.provider_message_id, e.provider_message_id),
           sent_at = case when v_status in ('sent', 'delivered') then coalesce(x.sent_at, e.occurred_at, now()) else x.sent_at end,
           delivered_at = case when v_status = 'delivered' then coalesce(x.delivered_at, e.occurred_at, now()) else x.delivered_at end,
           failed_at = case when v_status in ('failed', 'bounced') then coalesce(x.failed_at, now()) else x.failed_at end,
           failure_code = case when v_status in ('failed', 'bounced') then left(e.event_type, 80) else x.failure_code end,
           unknown_outcome = case when v_status in ('sent', 'delivered') then false else x.unknown_outcome end,
           lease_until = case when v_status in ('sent', 'delivered') then null else x.lease_until end,
           next_attempt_at = case when v_status in ('sent', 'delivered') then null else x.next_attempt_at end
     where x.id = m.id;
  elsif v_status is not null and m.status in ('queued', 'sending') and v_rank_new < 0 then
    null;
  end if;
  if v_flag is not null then
    update finance_v3.email_messages x set delivery_flags = array(select distinct f from unnest(x.delivery_flags || v_flag) f order by f) where x.id = m.id;
  end if;
  update finance_v3.email_events x set applied = true, apply_error = null, message_id = m.id where x.id = e.id;
  return jsonb_build_object('applied', true, 'found', true, 'message_id', m.id);
end;
$$;

create or replace function public.fin3svc_list_unapplied_email_events(p_limit integer default 50)
returns jsonb
language sql stable security definer
set search_path = pg_catalog, finance_v3
as $$
  select coalesce(jsonb_agg(e.id order by e.received_at), '[]'::jsonb)
    from (select x.id, x.received_at from finance_v3.email_events x where not x.applied order by x.received_at limit least(greatest(coalesce(p_limit, 50), 1), 200)) e;
$$;

create or replace function public.fin3svc_mark_email_event_error(p_event bigint, p_error text)
returns void
language sql security definer
set search_path = pg_catalog, finance_v3
as $$ update finance_v3.email_events e set apply_error = left(p_error, 300) where e.id = p_event and not e.applied $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'fin3\_%' loop
    execute format('revoke all on function %s from public, anon, service_role', r.sig);
    execute format('grant execute on function %s to authenticated', r.sig);
  end loop;
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'fin3svc\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'finance_v3' loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', r.sig);
  end loop;
end $$;
grant execute on function finance_v3.has_permission(uuid, text) to authenticated;

commit;
