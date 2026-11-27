-- Finance V3, Phase 6 (migration 1 of 1): reporting, notifications, scheduled processing, Emma read access, exports, project links.
--
--   * Reports (read-only, STABLE): expense breakdown, animator obligations, reserves, owner compensation, invoice status, payment history,
--     payment reconciliation, email delivery, report integrity (every total tied back to the ledger), the dashboard summary.
--   * Notifications: finance_v3.notifications (internal to KairFlow staff; never an email to a client). Every notification has a dedupe key
--     and a unique index on (organization, key), so a retried provider event, a re-run sweep or a double trigger can never make a second one.
--     Created by triggers on the records that change (email status, payments, payment attempts, provider events, refunds, protection events)
--     and by an idempotent sweep for time-based conditions (overdue, due soon, budgets, reserves, cash).
--   * Background processing: finance_v3.run_scheduled (one function; every step is idempotent), the cron wiring, a run log.
--     Client reminders and automatic receipt emails are OFF until an administrator switches them on.
--   * Emma: fin3_emma_snapshot (read-only facts + ready-made sentences) and intel_agent_finance_read (the Intelligence agent's read path,
--     which re-checks that the person who asked still holds finance.read). Emma has no write path into Finance.
--   * Exports: fin3_export_rows (permission-checked, row-capped, audited). CSV text is built in the app with formula-injection protection.
--   * Project links: fin3_set_record_link / fin3_project_finance_detail tie financial records to existing project, shot and stage ids
--     WITHOUT a new entity and without writing any legacy table.
-- Rollback: supabase/rollback/20270117090000_finance_v3_reporting_alerts.rollback.sql

begin;

insert into finance_v3.schema_version (version, notes)
values ('20270117090000', 'phase 6: reports, dashboard, notifications, scheduled processing, Emma read access, exports, project links')
on conflict (version) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- Settings: when the system may email CLIENTS on its own. Both switches default to OFF.
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists finance_v3.alert_settings (
  organization_id          uuid primary key references finance_v3.org_settings(organization_id) on delete restrict,
  due_soon_days            smallint not null default 3 check (due_soon_days between 0 and 30),
  reminders_enabled        boolean not null default false,
  reminder_first_after_days smallint not null default 3 check (reminder_first_after_days between 0 and 60),
  reminder_repeat_days     smallint not null default 7 check (reminder_repeat_days between 1 and 60),
  max_reminders            smallint not null default 3 check (max_reminders between 0 and 6),
  auto_receipts            boolean not null default false,
  budget_warn_percent      smallint not null default 90 check (budget_warn_percent between 50 and 99),
  pending_payment_minutes  smallint not null default 30 check (pending_payment_minutes between 5 and 1440),
  updated_by               uuid,
  updated_at               timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------------------------
-- Notifications (internal). Append-only apart from resolved_at.
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists finance_v3.notifications (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references finance_v3.org_settings(organization_id) on delete restrict,
  kind            text not null check (kind ~ '^[a-z][a-z0-9_]{2,60}$'),
  category        text not null check (category in ('invoice', 'payment', 'email', 'project', 'reserve', 'payables', 'safety', 'integration', 'reconciliation', 'cash')),
  severity        text not null check (severity in ('info', 'warning', 'critical')),
  title           text not null check (char_length(title) between 1 and 160),
  body            text not null check (char_length(body) <= 600),
  object_type     text check (object_type is null or char_length(object_type) <= 40),
  object_id       text check (object_id is null or char_length(object_id) <= 80),
  audience        text not null default 'finance.read' check (audience in ('finance.read', 'finance.admin', 'finance.send_email', 'finance.verify_payment', 'finance.view_integrations', 'finance.refund', 'finance.pay')),
  dedupe_key      text not null check (char_length(dedupe_key) between 1 and 200),
  data            jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz,
  constraint uq_notifications_key unique (organization_id, dedupe_key)
);
create index if not exists ix_notifications_feed on finance_v3.notifications (organization_id, created_at desc);
create index if not exists ix_notifications_open on finance_v3.notifications (organization_id, category) where resolved_at is null;

create table if not exists finance_v3.notification_reads (
  organization_id uuid not null,
  notification_id uuid not null references finance_v3.notifications(id) on delete cascade,
  user_id         uuid not null,
  read_at         timestamptz not null default now(),
  primary key (notification_id, user_id)
);

create or replace function finance_v3.tg_guard_notifications()
returns trigger
language plpgsql
set search_path = pg_catalog, finance_v3
as $$
begin
  if tg_op = 'DELETE' then raise exception 'Notifications cannot be deleted.' using errcode = 'V3002'; end if;
  if new.id is distinct from old.id or new.organization_id is distinct from old.organization_id or new.kind is distinct from old.kind
     or new.category is distinct from old.category or new.severity is distinct from old.severity or new.title is distinct from old.title
     or new.body is distinct from old.body or new.object_id is distinct from old.object_id or new.dedupe_key is distinct from old.dedupe_key
     or new.audience is distinct from old.audience or new.data is distinct from old.data or new.created_at is distinct from old.created_at then
    raise exception 'A notification can only be marked resolved.' using errcode = 'V3002';
  end if;
  return new;
end;
$$;
drop trigger if exists tg_guard_notifications on finance_v3.notifications;
create trigger tg_guard_notifications before update or delete on finance_v3.notifications for each row execute function finance_v3.tg_guard_notifications();

-- ---------------------------------------------------------------------------------------------------------------
-- Links from financial records to the app's existing project / shot / production stage ids (soft references: no new entity,
-- no foreign key to a legacy table, no write to one). One link per financial record.
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists finance_v3.record_links (
  organization_id uuid not null references finance_v3.org_settings(organization_id) on delete restrict,
  object_type     text not null check (object_type in ('work_item', 'invoice', 'expense', 'bill')),
  object_id       uuid not null,
  project_id      uuid not null,
  shot_id         uuid,
  stage_key       text check (stage_key is null or char_length(stage_key) between 1 and 60),
  updated_by      uuid,
  updated_at      timestamptz not null default now(),
  primary key (organization_id, object_type, object_id)
);
create index if not exists ix_record_links_project on finance_v3.record_links (organization_id, project_id);

-- ---------------------------------------------------------------------------------------------------------------
-- Scheduler: connection settings (set by an administrator in the SQL editor) and a run log for monitoring.
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists finance_v3.scheduler_config (
  id           boolean primary key default true check (id),
  dispatch_url  text check (dispatch_url is null or dispatch_url ~ '^https://'),    -- finance-email-dispatch (Phase 3)
  scheduler_url text check (scheduler_url is null or scheduler_url ~ '^https://'),   -- finance-scheduler (Phase 6, Paystack reconciliation)
  secret       text check (secret is null or char_length(secret) >= 16),
  updated_at   timestamptz not null default now()
);
create table if not exists finance_v3.scheduler_runs (
  id          bigint generated always as identity primary key,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  organizations integer not null default 0,
  summary     jsonb not null default '{}'::jsonb,
  error       text check (error is null or char_length(error) <= 500)
);

do $$
declare t text;
begin
  foreach t in array array['alert_settings', 'notifications', 'notification_reads', 'record_links', 'scheduler_config', 'scheduler_runs'] loop
    execute format('alter table finance_v3.%I enable row level security', t);
    execute format('revoke all on finance_v3.%I from public, anon, authenticated, service_role', t);
  end loop;
end $$;
revoke all on sequence finance_v3.scheduler_runs_id_seq from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- notify(): the only way a notification is created. Idempotent by (organization, dedupe key).
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.notify(
  p_org uuid, p_kind text, p_category text, p_severity text, p_key text, p_title text, p_body text,
  p_type text default null, p_id text default null, p_data jsonb default '{}'::jsonb, p_audience text default 'finance.read')
returns boolean
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare v_id uuid;
begin
  if p_org is null then return false; end if;
  insert into finance_v3.notifications (organization_id, kind, category, severity, title, body, object_type, object_id, audience, dedupe_key, data)
  values (p_org, p_kind, p_category, p_severity, left(p_title, 160), left(coalesce(p_body, ''), 600), p_type, left(p_id, 80), p_audience, left(p_key, 200), coalesce(p_data, '{}'::jsonb))
  on conflict (organization_id, dedupe_key) do nothing
  returning id into v_id;
  return v_id is not null;
end;
$$;

create or replace function finance_v3.inv_label(p_org uuid, p_invoice uuid)
returns text
language sql stable security definer
set search_path = pg_catalog, finance_v3
as $$
  select coalesce((select r.invoice_no from finance_v3.receivables r where r.organization_id = p_org and r.id = p_invoice), 'an invoice');
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Event triggers. Each notification key contains the id of the record (and the status it moved to), so a repeated
-- delivery, a retry or a second trigger firing for the same fact is silently absorbed by notify().
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.tg_notify_email()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_inv text := finance_v3.inv_label(new.organization_id, new.invoice_id);
  v_what text;
  v_k text;
begin
  -- Only transitions into a new status matter (INSERT counts as 'queued', which is not announced).
  if tg_op = 'UPDATE' and new.status is not distinct from old.status
     and new.unknown_outcome is not distinct from old.unknown_outcome and new.attempt_count is not distinct from old.attempt_count then
    return new;
  end if;
  v_what := case new.email_type
    when 'invoice' then 'Invoice email'
    when 'invoice_reminder' then 'Reminder email'
    when 'overdue_notice' then 'Overdue notice'
    when 'payment_receipt' then 'Receipt email'
    when 'refund_notice' then 'Refund email'
    else 'Invoice update email' end;
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if new.status = 'delivered' and new.email_type in ('invoice', 'payment_receipt') then
      perform finance_v3.notify(new.organization_id, case new.email_type when 'invoice' then 'invoice_email_delivered' else 'receipt_email_delivered' end,
        'email', 'info', 'email:' || new.id || ':delivered', v_what || ' delivered', v_what || ' for ' || v_inv || ' reached ' || new.recipient || '.',
        'email', new.id::text, jsonb_build_object('invoice_id', new.invoice_id, 'email_type', new.email_type), 'finance.send_email');
    elsif new.status = 'sent' and new.email_type in ('invoice_reminder', 'overdue_notice') then
      perform finance_v3.notify(new.organization_id, 'reminder_sent', 'email', 'info', 'email:' || new.id || ':sent',
        v_what || ' sent', v_what || ' for ' || v_inv || ' was sent to ' || new.recipient || '.', 'email', new.id::text,
        jsonb_build_object('invoice_id', new.invoice_id, 'email_type', new.email_type), 'finance.send_email');
    elsif new.status = 'bounced' then
      perform finance_v3.notify(new.organization_id, case new.email_type when 'payment_receipt' then 'receipt_email_failed' else 'invoice_email_bounced' end,
        'email', 'critical', 'email:' || new.id || ':bounced', v_what || ' bounced',
        v_what || ' for ' || v_inv || ' to ' || new.recipient || ' bounced. Check the address before sending again.', 'email', new.id::text,
        jsonb_build_object('invoice_id', new.invoice_id, 'email_type', new.email_type), 'finance.send_email');
    elsif new.status = 'failed' then
      perform finance_v3.notify(new.organization_id, case new.email_type when 'payment_receipt' then 'receipt_email_failed' else 'invoice_email_failed' end,
        'email', 'critical', 'email:' || new.id || ':failed', v_what || ' failed',
        v_what || ' for ' || v_inv || ' could not be sent' || coalesce(' (' || new.failure_code || ')', '') || '.', 'email', new.id::text,
        jsonb_build_object('invoice_id', new.invoice_id, 'email_type', new.email_type), 'finance.send_email');
    end if;
  end if;
  -- Retry required: a send attempt failed but the message is still queued for another go (once per attempt number).
  if tg_op = 'UPDATE' and new.status = 'queued' and new.attempt_count > coalesce(old.attempt_count, 0) and new.failure_code is not null then
    perform finance_v3.notify(new.organization_id, 'email_retry_required', 'email', 'warning', 'email:' || new.id || ':retry:' || new.attempt_count,
      v_what || ' will be retried', v_what || ' for ' || v_inv || ' did not go through and is queued for another attempt.', 'email', new.id::text,
      jsonb_build_object('invoice_id', new.invoice_id), 'finance.send_email');
  end if;
  if new.unknown_outcome and (tg_op = 'INSERT' or not old.unknown_outcome) then
    perform finance_v3.notify(new.organization_id, 'email_unknown_outcome', 'email', 'warning', 'email:' || new.id || ':unknown',
      v_what || ' needs checking', 'We could not confirm whether the ' || lower(v_what) || ' for ' || v_inv || ' was sent. It will not be sent again automatically.',
      'email', new.id::text, jsonb_build_object('invoice_id', new.invoice_id), 'finance.send_email');
  end if;
  return new;
end;
$$;
drop trigger if exists tg_notify_email on finance_v3.email_messages;
create trigger tg_notify_email after insert or update on finance_v3.email_messages for each row execute function finance_v3.tg_notify_email();

create or replace function finance_v3.tg_notify_payment()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  r finance_v3.receivables%rowtype;
  v_paid numeric(19,4);
  v_amt text := finance_v3.money_text(new.amount, new.currency) || ' ' || new.currency;
  v_prov boolean := new.provider is not null;
begin
  if tg_op = 'UPDATE' and new.verification_status is not distinct from old.verification_status then return new; end if;
  select * into r from finance_v3.receivables where organization_id = new.organization_id and id = new.invoice_id;
  if new.verification_status = 'pending_verification' then
    perform finance_v3.notify(new.organization_id, 'payment_pending_verification', 'payment', 'warning', 'pay:' || new.id || ':pending',
      'Payment waiting for verification', v_amt || ' on ' || coalesce(r.invoice_no, 'an invoice') || ' needs to be verified before it counts.',
      'payment', new.id::text, jsonb_build_object('invoice_id', new.invoice_id), 'finance.verify_payment');
  elsif new.verification_status = 'rejected' then
    perform finance_v3.notify(new.organization_id, 'payment_rejected', 'payment', 'warning', 'pay:' || new.id || ':rejected',
      'Payment rejected', v_amt || ' on ' || coalesce(r.invoice_no, 'an invoice') || ' was rejected and does not count.',
      'payment', new.id::text, jsonb_build_object('invoice_id', new.invoice_id), 'finance.verify_payment');
  elsif new.verification_status = 'verified' then
    select coalesce(sum(p.amount), 0) into v_paid from finance_v3.payments p
     where p.organization_id = new.organization_id and p.invoice_id = new.invoice_id and p.verification_status = 'verified' and p.status <> 'reversed';
    if v_paid < r.total - r.credit_total then
      perform finance_v3.notify(new.organization_id, 'payment_partial', 'payment', 'info', 'pay:' || new.id || ':partial',
        'Part payment received', v_amt || ' received on ' || coalesce(r.invoice_no, 'an invoice') || '. ' ||
        finance_v3.money_text(r.total - r.credit_total - v_paid, r.currency) || ' ' || r.currency || ' is still owed.',
        'payment', new.id::text, jsonb_build_object('invoice_id', new.invoice_id));
    end if;
    perform finance_v3.notify(new.organization_id, case when v_prov then 'paystack_payment_confirmed' else 'payment_confirmed' end,
      'payment', 'info', 'pay:' || new.id || ':confirmed', case when v_prov then 'Card payment confirmed' else 'Payment confirmed' end,
      v_amt || ' received on ' || coalesce(r.invoice_no, 'an invoice') || '.', 'payment', new.id::text,
      jsonb_build_object('invoice_id', new.invoice_id, 'provider', new.provider));
  end if;
  return new;
end;
$$;
drop trigger if exists tg_notify_payment on finance_v3.payments;
create trigger tg_notify_payment after insert or update of verification_status on finance_v3.payments for each row execute function finance_v3.tg_notify_payment();

create or replace function finance_v3.tg_notify_intent()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare v_inv text := finance_v3.inv_label(new.organization_id, new.invoice_id); v_reason text := coalesce(new.review_reason, ''); v_kind text;
begin
  if new.status is not distinct from old.status then return new; end if;
  if new.status = 'failed' then
    perform finance_v3.notify(new.organization_id, 'payment_failed', 'payment', 'warning', 'intent:' || new.id || ':failed', 'Card payment failed',
      'A card payment on ' || v_inv || ' failed. The invoice is unchanged.', 'payment_intent', new.id::text, jsonb_build_object('invoice_id', new.invoice_id));
  elsif new.status = 'needs_review' then
    -- Classified from the verified facts themselves, not from the wording of the reason text.
    v_kind := case when new.verified_currency is not null and new.verified_currency <> new.charge_currency then 'paystack_currency_mismatch'
                   when new.verified_amount_minor is not null and new.verified_amount_minor <> new.charge_amount_minor then 'paystack_amount_mismatch'
                   else 'paystack_needs_review' end;
    perform finance_v3.notify(new.organization_id, v_kind, 'payment', 'critical', 'intent:' || new.id || ':review:' || v_kind,
      case v_kind when 'paystack_currency_mismatch' then 'Payment currency does not match' when 'paystack_amount_mismatch' then 'Payment amount does not match' else 'Card payment needs review' end,
      'The card payment on ' || v_inv || ' was not recorded because it needs a person to check it.' || case when v_reason <> '' then ' ' || left(v_reason, 300) else '' end,
      'payment_intent', new.id::text, jsonb_build_object('invoice_id', new.invoice_id), 'finance.verify_payment');
  elsif new.status = 'succeeded' and new.payment_id is null then
    perform finance_v3.notify(new.organization_id, 'paystack_verified', 'payment', 'info', 'intent:' || new.id || ':verified', 'Card payment verified',
      'Paystack confirmed a card payment on ' || v_inv || '.', 'payment_intent', new.id::text, jsonb_build_object('invoice_id', new.invoice_id));
  end if;
  return new;
end;
$$;
drop trigger if exists tg_notify_intent on finance_v3.payment_intents;
create trigger tg_notify_intent after update of status on finance_v3.payment_intents for each row execute function finance_v3.tg_notify_intent();

create or replace function finance_v3.tg_notify_provider_event()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  if new.organization_id is null then return new; end if;   -- an event with no matching payment cannot be assigned to an organisation; see "unassociated" in the sweep
  if tg_op = 'UPDATE' and new.attempts > old.attempts then
    perform finance_v3.notify(new.organization_id, 'paystack_duplicate_webhook', 'integration', 'info', 'pe:' || new.id || ':dup',
      'Duplicate Paystack message ignored', 'Paystack sent the "' || new.event_type || '" message again. It was not applied twice.', 'provider_event', new.id::text,
      '{}'::jsonb, 'finance.view_integrations');
  end if;
  if new.status in ('needs_review', 'failed', 'exhausted') and (tg_op = 'INSERT' or new.status is distinct from old.status) then
    perform finance_v3.notify(new.organization_id, case new.status when 'needs_review' then 'webhook_needs_review' else 'webhook_failed' end, 'integration',
      case new.status when 'exhausted' then 'critical' when 'needs_review' then 'critical' else 'warning' end, 'pe:' || new.id || ':' || new.status,
      case new.status when 'needs_review' then 'Paystack message needs manual review' when 'exhausted' then 'Paystack message could not be processed' else 'Paystack message failed' end,
      'The "' || new.event_type || '" message was not applied automatically' || coalesce(': ' || left(new.error, 200), '.'), 'provider_event', new.id::text,
      '{}'::jsonb, 'finance.view_integrations');
  end if;
  return new;
end;
$$;
drop trigger if exists tg_notify_provider_event on finance_v3.provider_events;
create trigger tg_notify_provider_event after insert or update on finance_v3.provider_events for each row execute function finance_v3.tg_notify_provider_event();

create or replace function finance_v3.tg_notify_refund()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare v_amt text := finance_v3.money_text(new.amount, new.currency) || ' ' || new.currency; v_inv text := finance_v3.inv_label(new.organization_id, new.invoice_id);
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then return new; end if;
  if new.status = 'requested' then
    perform finance_v3.notify(new.organization_id, 'refund_requested', 'payment', 'info', 'refund:' || new.id || ':requested', 'Refund requested',
      v_amt || ' refund requested on ' || v_inv || '.', 'refund', new.id::text, jsonb_build_object('invoice_id', new.invoice_id), 'finance.refund');
  elsif new.status = 'processed' then
    perform finance_v3.notify(new.organization_id, 'refund_confirmed', 'payment', 'info', 'refund:' || new.id || ':processed', 'Refund confirmed',
      v_amt || ' refunded on ' || v_inv || '.', 'refund', new.id::text, jsonb_build_object('invoice_id', new.invoice_id));
  elsif new.status = 'failed' then
    perform finance_v3.notify(new.organization_id, 'refund_failed', 'payment', 'critical', 'refund:' || new.id || ':failed', 'Refund failed',
      v_amt || ' refund on ' || v_inv || ' failed and needs attention.', 'refund', new.id::text, jsonb_build_object('invoice_id', new.invoice_id), 'finance.refund');
  end if;
  return new;
end;
$$;
drop trigger if exists tg_notify_refund on finance_v3.refunds;
create trigger tg_notify_refund after insert or update of status on finance_v3.refunds for each row execute function finance_v3.tg_notify_refund();

create or replace function finance_v3.tg_notify_protection()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  perform finance_v3.notify(new.organization_id, 'unsafe_withdrawal', 'safety', case new.outcome when 'overridden' then 'critical' else 'warning' end,
    'prot:' || new.id, case new.outcome when 'overridden' then 'A safety check was overridden' else 'A safety check blocked a payment' end,
    finance_v3.money_text(new.amount, new.currency) || ' ' || new.currency || ' ' ||
    case new.rule when 'insufficient_cash' then 'was more than the cash available' when 'exceeds_safe_to_spend' then 'was more than safe-to-spend' else 'would take the reserve below its minimum' end || '.',
    'protection_event', new.id::text, jsonb_build_object('rule', new.rule, 'outcome', new.outcome), 'finance.admin');
  return new;
end;
$$;
drop trigger if exists tg_notify_protection on finance_v3.protection_events;
create trigger tg_notify_protection after insert on finance_v3.protection_events for each row execute function finance_v3.tg_notify_protection();

-- ---------------------------------------------------------------------------------------------------------------
-- Settings + notification RPCs (public, authenticated).
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fin3_get_alert_settings(p_org uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare s finance_v3.alert_settings%rowtype;
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  select * into s from finance_v3.alert_settings where organization_id = p_org;
  if not found then s.organization_id := p_org; s.due_soon_days := 3; s.reminders_enabled := false; s.reminder_first_after_days := 3; s.reminder_repeat_days := 7;
    s.max_reminders := 3; s.auto_receipts := false; s.budget_warn_percent := 90; s.pending_payment_minutes := 30; end if;
  return jsonb_build_object('due_soon_days', s.due_soon_days, 'reminders_enabled', s.reminders_enabled, 'reminder_first_after_days', s.reminder_first_after_days,
    'reminder_repeat_days', s.reminder_repeat_days, 'max_reminders', s.max_reminders, 'auto_receipts', s.auto_receipts,
    'budget_warn_percent', s.budget_warn_percent, 'pending_payment_minutes', s.pending_payment_minutes);
end;
$$;

create or replace function public.fin3_set_alert_settings(p_org uuid, p_settings jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, finance_v3
as $$
declare uid uuid; b jsonb; s finance_v3.alert_settings%rowtype;
begin
  uid := finance_v3.assert_permission(p_org, 'finance.admin');
  perform finance_v3.assert_org_ready(p_org);
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then raise exception 'Settings are required.' using errcode = 'V3011'; end if;
  b := public.fin3_get_alert_settings(p_org);
  begin
    insert into finance_v3.alert_settings (organization_id, due_soon_days, reminders_enabled, reminder_first_after_days, reminder_repeat_days, max_reminders, auto_receipts, budget_warn_percent, pending_payment_minutes, updated_by)
    values (p_org,
      coalesce((p_settings ->> 'due_soon_days')::int, (b ->> 'due_soon_days')::int),
      coalesce((p_settings ->> 'reminders_enabled')::boolean, (b ->> 'reminders_enabled')::boolean),
      coalesce((p_settings ->> 'reminder_first_after_days')::int, (b ->> 'reminder_first_after_days')::int),
      coalesce((p_settings ->> 'reminder_repeat_days')::int, (b ->> 'reminder_repeat_days')::int),
      coalesce((p_settings ->> 'max_reminders')::int, (b ->> 'max_reminders')::int),
      coalesce((p_settings ->> 'auto_receipts')::boolean, (b ->> 'auto_receipts')::boolean),
      coalesce((p_settings ->> 'budget_warn_percent')::int, (b ->> 'budget_warn_percent')::int),
      coalesce((p_settings ->> 'pending_payment_minutes')::int, (b ->> 'pending_payment_minutes')::int), uid)
    on conflict (organization_id) do update set due_soon_days = excluded.due_soon_days, reminders_enabled = excluded.reminders_enabled,
      reminder_first_after_days = excluded.reminder_first_after_days, reminder_repeat_days = excluded.reminder_repeat_days, max_reminders = excluded.max_reminders,
      auto_receipts = excluded.auto_receipts, budget_warn_percent = excluded.budget_warn_percent, pending_payment_minutes = excluded.pending_payment_minutes,
      updated_by = uid, updated_at = now();
  exception when check_violation or invalid_text_representation or numeric_value_out_of_range then
    raise exception 'One of the settings is out of range.' using errcode = 'V3011';
  end;
  perform finance_v3.write_audit(p_org, uid, 'alert_settings.updated', 'alert_settings', p_org::text, b, public.fin3_get_alert_settings(p_org), null);
  return public.fin3_get_alert_settings(p_org);
end;
$$;

-- Notifications the caller may see: audience permission is checked per row, so a person without payment-verification rights
-- does not see payment review notices.
create or replace function public.fin3_list_notifications(p_org uuid, p_unread_only boolean default false, p_category text default null, p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare uid uuid; v jsonb;
begin
  uid := finance_v3.assert_permission(p_org, 'finance.read');
  p_limit := least(greatest(coalesce(p_limit, 50), 1), 200); p_offset := greatest(coalesce(p_offset, 0), 0);
  with perms as (select pp.perm from unnest(array['finance.read','finance.admin','finance.send_email','finance.verify_payment','finance.view_integrations','finance.refund','finance.pay']) pp(perm)
                  where finance_v3.has_permission_for(uid, p_org, pp.perm)),
  rows as (
    select n.*, (nr.user_id is not null) as is_read
      from finance_v3.notifications n
      left join finance_v3.notification_reads nr on nr.notification_id = n.id and nr.user_id = uid
     where n.organization_id = p_org and n.audience in (select perm from perms)
       and (p_category is null or n.category = p_category) and (not coalesce(p_unread_only, false) or nr.user_id is null)
     order by n.created_at desc, n.id limit p_limit offset p_offset)
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'category', category, 'severity', severity, 'title', title, 'body', body,
    'object_type', object_type, 'object_id', object_id, 'created_at', created_at, 'resolved', resolved_at is not null, 'read', is_read, 'data', data)
    order by created_at desc, id), '[]'::jsonb) into v from rows;
  return jsonb_build_object('items', v);
end;
$$;

create or replace function public.fin3_notification_counts(p_org uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare uid uuid; v jsonb;
begin
  uid := finance_v3.assert_permission(p_org, 'finance.read');
  select jsonb_build_object('unread', count(*) filter (where nr.user_id is null), 'critical_unread', count(*) filter (where nr.user_id is null and n.severity = 'critical'),
    'total', count(*)) into v
    from finance_v3.notifications n left join finance_v3.notification_reads nr on nr.notification_id = n.id and nr.user_id = uid
   where n.organization_id = p_org and finance_v3.has_permission_for(uid, p_org, n.audience);
  return v;
end;
$$;

-- Writes only the caller's own read marker. No financial record is touched.
create or replace function public.fin3_mark_notifications_read(p_org uuid, p_ids uuid[] default null)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, finance_v3
as $$
declare uid uuid; n integer;
begin
  uid := finance_v3.assert_permission(p_org, 'finance.read');
  insert into finance_v3.notification_reads (organization_id, notification_id, user_id)
  select p_org, x.id, uid from finance_v3.notifications x
   where x.organization_id = p_org and (p_ids is null or x.id = any (p_ids)) and finance_v3.has_permission_for(uid, p_org, x.audience)
  on conflict do nothing;
  get diagnostics n = row_count;
  return jsonb_build_object('marked', n);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Reports. All read-only. Money is reported per currency in the record's own currency (exact); the ledger-based reports
-- from Phase 5 stay the authority for totals, and fin3_report_integrity proves these sub-ledger reports agree with them.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.chk_period(p_from date, p_to date)
returns void
language plpgsql immutable
set search_path = pg_catalog
as $$
begin
  if p_from is null or p_to is null or p_from > p_to then raise exception 'Choose a valid period (from must not be after to).' using errcode = 'V3011'; end if;
  if p_to - p_from > 3660 then raise exception 'The period is too long (at most 10 years).' using errcode = 'V3011'; end if;
end;
$$;

create or replace function public.fin3_report_expense_breakdown(p_org uuid, p_from date, p_to date, p_currency text default null)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare v_ccy text;
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.chk_period(p_from, p_to);
  v_ccy := finance_v3.rpt_ccy(p_org, p_currency);
  return jsonb_build_object('currency', v_ccy, 'from', p_from, 'to', p_to,
    'by_category', (select coalesce(jsonb_agg(jsonb_build_object('category_id', t.category_id, 'category', t.name, 'count', t.n, 'amount', finance_v3.money_text(t.amt, v_ccy)) order by t.amt desc, t.name), '[]'::jsonb)
        from (select e.category_id, coalesce(c.name, 'Uncategorised') as name, count(*) n, sum(e.amount) amt
                from finance_v3.expense_records e left join finance_v3.expense_categories c on c.organization_id = e.organization_id and c.id = e.category_id
               where e.organization_id = p_org and e.currency = v_ccy and e.reversal_entry_id is null and e.expense_date between p_from and p_to
               group by e.category_id, c.name) t),
    'by_project', (select coalesce(jsonb_agg(jsonb_build_object('project_id', t.project_id, 'count', t.n, 'amount', finance_v3.money_text(t.amt, v_ccy)) order by t.amt desc), '[]'::jsonb)
        from (select e.project_id, count(*) n, sum(e.amount) amt from finance_v3.expense_records e
               where e.organization_id = p_org and e.currency = v_ccy and e.reversal_entry_id is null and e.expense_date between p_from and p_to
               group by e.project_id) t),
    'total', finance_v3.money_text((select coalesce(sum(e.amount), 0) from finance_v3.expense_records e
               where e.organization_id = p_org and e.currency = v_ccy and e.reversal_entry_id is null and e.expense_date between p_from and p_to), v_ccy),
    'basis', 'native');
end;
$$;

create or replace function public.fin3_report_animator_obligations(p_org uuid, p_currency text default null)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare v_ccy text;
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  v_ccy := finance_v3.rpt_ccy(p_org, p_currency);
  return jsonb_build_object('currency', v_ccy,
    'by_animator', (select coalesce(jsonb_agg(jsonb_build_object('animator_id', t.animator_id, 'animator', t.name, 'items', t.n, 'approved', finance_v3.money_text(t.appr, v_ccy),
          'paid', finance_v3.money_text(t.paid, v_ccy), 'outstanding', finance_v3.money_text(t.outst, v_ccy), 'oldest_due', t.oldest) order by t.outst desc, t.name), '[]'::jsonb)
        from (select a.animator_id, coalesce(c.name, 'Unknown') as name, count(*) n, sum(w.approved_amount) appr, sum(w.amount_paid) paid, sum(w.outstanding) outst, min(w.due_date) oldest
                from finance_v3.animator_work_items w
                join finance_v3.animator_assignments a on a.organization_id = w.organization_id and a.id = w.assignment_id
                left join finance_v3.contacts_v3 c on c.organization_id = a.organization_id and c.id = a.animator_id
               where w.organization_id = p_org and w.currency = v_ccy and w.status = 'approved' and w.outstanding > 0
               group by a.animator_id, c.name) t),
    'by_project', (select coalesce(jsonb_agg(jsonb_build_object('project_id', t.project_id, 'items', t.n, 'outstanding', finance_v3.money_text(t.outst, v_ccy)) order by t.outst desc), '[]'::jsonb)
        from (select a.project_id, count(*) n, sum(w.outstanding) outst
                from finance_v3.animator_work_items w join finance_v3.animator_assignments a on a.organization_id = w.organization_id and a.id = w.assignment_id
               where w.organization_id = p_org and w.currency = v_ccy and w.status = 'approved' and w.outstanding > 0 group by a.project_id) t),
    'overdue', (select coalesce(sum(w.outstanding), 0)::text from finance_v3.animator_work_items w
                 where w.organization_id = p_org and w.currency = v_ccy and w.status = 'approved' and w.outstanding > 0 and w.due_date < current_date),
    'total_outstanding', finance_v3.money_text((select coalesce(sum(w.outstanding), 0) from finance_v3.animator_work_items w
                 where w.organization_id = p_org and w.currency = v_ccy and w.status = 'approved'), v_ccy));
end;
$$;

create or replace function public.fin3_report_reserves(p_org uuid, p_as_of date default null)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  return jsonb_build_object('items', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'purpose', r.purpose, 'currency', r.currency, 'mode', r.mode,
      'balance', finance_v3.money_text(finance_v3.reserve_balance(p_org, r.id), r.currency), 'target', finance_v3.money_text(r.target_amount, r.currency),
      'minimum', finance_v3.money_text(r.minimum_amount, r.currency),
      'below_minimum', r.minimum_amount > 0 and finance_v3.reserve_balance(p_org, r.id) < r.minimum_amount,
      'below_target', r.target_amount > 0 and finance_v3.reserve_balance(p_org, r.id) < r.target_amount) order by r.name), '[]'::jsonb)
      from finance_v3.reserves r where r.organization_id = p_org and r.is_active));
end;
$$;

create or replace function public.fin3_report_owner_compensation(p_org uuid, p_from date, p_to date)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.chk_period(p_from, p_to);
  return jsonb_build_object('summary', public.fin3_owner_summary(p_org, p_from, p_to),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'kind', o.kind, 'status', o.status, 'amount', finance_v3.money_text(o.amount, o.currency), 'currency', o.currency,
        'date', coalesce(o.paid_on, o.scheduled_for)) order by coalesce(o.paid_on, o.scheduled_for) desc, o.id), '[]'::jsonb)
        from finance_v3.owner_payments o where o.organization_id = p_org and o.status in ('recorded', 'scheduled') and coalesce(o.paid_on, o.scheduled_for) between p_from and p_to));
end;
$$;

create or replace function public.fin3_report_invoice_status(p_org uuid, p_from date, p_to date, p_currency text default null)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare v_ccy text;
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.chk_period(p_from, p_to);
  v_ccy := finance_v3.rpt_ccy(p_org, p_currency);
  return jsonb_build_object('currency', v_ccy, 'from', p_from, 'to', p_to,
    'by_status', (select coalesce(jsonb_agg(jsonb_build_object('status', t.status, 'count', t.n, 'total', finance_v3.money_text(t.tot, v_ccy), 'outstanding', finance_v3.money_text(t.outst, v_ccy)) order by t.status), '[]'::jsonb)
        from (select r.status, count(*) n, sum(r.total) tot, sum(r.outstanding) outst from finance_v3.receivables r
               where r.organization_id = p_org and r.currency = v_ccy and coalesce(r.issue_date, r.created_at::date) between p_from and p_to group by r.status) t),
    'overdue_count', (select count(*) from finance_v3.receivables r where r.organization_id = p_org and r.currency = v_ccy and r.status in ('issued', 'partially_paid') and r.due_date < current_date),
    'overdue_amount', finance_v3.money_text((select coalesce(sum(r.outstanding), 0) from finance_v3.receivables r where r.organization_id = p_org and r.currency = v_ccy
        and r.status in ('issued', 'partially_paid') and r.due_date < current_date), v_ccy));
end;
$$;

create or replace function public.fin3_report_payment_history(p_org uuid, p_from date, p_to date, p_currency text default null, p_limit integer default 200)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare v_ccy text; v_lim integer := least(greatest(coalesce(p_limit, 200), 1), 1000);
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.chk_period(p_from, p_to);
  v_ccy := finance_v3.rpt_ccy(p_org, p_currency);
  return jsonb_build_object('currency', v_ccy, 'from', p_from, 'to', p_to,
    'total_verified', finance_v3.money_text((select coalesce(sum(p.amount - p.refunded_amount), 0) from finance_v3.payments p where p.organization_id = p_org and p.currency = v_ccy
        and p.verification_status = 'verified' and p.status <> 'reversed' and p.accounting_date between p_from and p_to), v_ccy),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'date', x.accounting_date, 'invoice_id', x.invoice_id, 'invoice_no', x.invoice_no, 'client', x.client, 'method', x.method,
        'provider', x.provider, 'amount', finance_v3.money_text(x.amount, x.currency), 'refunded', finance_v3.money_text(x.refunded_amount, x.currency),
        'status', x.status, 'verification', x.verification_status, 'reference', x.reference) order by x.accounting_date desc, x.id), '[]'::jsonb)
        from (select p.*, i.invoice_no, c.name as client from finance_v3.payments p join finance_v3.receivables i on i.organization_id = p.organization_id and i.id = p.invoice_id
                left join finance_v3.contacts_v3 c on c.organization_id = p.organization_id and c.id = p.client_id
               where p.organization_id = p_org and p.currency = v_ccy and p.accounting_date between p_from and p_to
               order by p.accounting_date desc, p.id limit v_lim) x));
end;
$$;

-- Online payment reconciliation: every payment attempt, what the provider said, and whether it ended up as a recorded payment.
create or replace function public.fin3_report_payment_reconciliation(p_org uuid, p_from date, p_to date)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.chk_period(p_from, p_to);
  return jsonb_build_object('from', p_from, 'to', p_to,
    'counts', (select jsonb_object_agg(s.status, s.n) from (select i.status, count(*) n from finance_v3.payment_intents i
        where i.organization_id = p_org and i.created_at::date between p_from and p_to group by i.status) s),
    'unmatched_succeeded', (select count(*) from finance_v3.payment_intents i where i.organization_id = p_org and i.status = 'succeeded' and i.payment_id is null
        and i.created_at::date between p_from and p_to),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('intent_id', x.id, 'reference', x.provider_reference, 'invoice_no', x.invoice_no, 'status', x.status,
        'expected', finance_v3.money_text(x.invoice_amount, x.invoice_currency), 'currency', x.invoice_currency,
        'verified_minor', x.verified_amount_minor, 'charge_minor', x.charge_amount_minor, 'verified_currency', x.verified_currency,
        'amount_matches', x.verified_amount_minor is null or x.verified_amount_minor = x.charge_amount_minor,
        'currency_matches', x.verified_currency is null or x.verified_currency = x.charge_currency,
        'payment_id', x.payment_id, 'review_reason', x.review_reason, 'created_at', x.created_at) order by x.created_at desc, x.id), '[]'::jsonb)
        from (select i.*, r.invoice_no from finance_v3.payment_intents i join finance_v3.receivables r on r.organization_id = i.organization_id and r.id = i.invoice_id
               where i.organization_id = p_org and i.created_at::date between p_from and p_to order by i.created_at desc, i.id limit 500) x));
end;
$$;

create or replace function public.fin3_report_email_delivery(p_org uuid, p_from date, p_to date)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
begin
  perform finance_v3.assert_permission(p_org, 'finance.view_integrations');
  perform finance_v3.assert_org_ready(p_org);
  perform finance_v3.chk_period(p_from, p_to);
  return jsonb_build_object('from', p_from, 'to', p_to,
    'by_status', (select coalesce(jsonb_object_agg(s.status, s.n), '{}'::jsonb) from (select m.status, count(*) n from finance_v3.email_messages m
        where m.organization_id = p_org and m.created_at::date between p_from and p_to group by m.status) s),
    'by_type', (select coalesce(jsonb_agg(jsonb_build_object('email_type', s.email_type, 'status', s.status, 'count', s.n) order by s.email_type, s.status), '[]'::jsonb)
        from (select m.email_type, m.status, count(*) n from finance_v3.email_messages m where m.organization_id = p_org and m.created_at::date between p_from and p_to group by m.email_type, m.status) s),
    'problems', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'email_type', x.email_type, 'status', x.status, 'invoice_no', x.invoice_no, 'recipient', x.recipient,
        'failure_code', x.failure_code, 'attempts', x.attempt_count, 'unknown_outcome', x.unknown_outcome, 'created_at', x.created_at) order by x.created_at desc, x.id), '[]'::jsonb)
        from (select m.*, r.invoice_no from finance_v3.email_messages m left join finance_v3.receivables r on r.organization_id = m.organization_id and r.id = m.invoice_id
               where m.organization_id = p_org and m.created_at::date between p_from and p_to and (m.status in ('bounced', 'failed') or m.unknown_outcome)
               order by m.created_at desc, m.id limit 200) x));
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Report integrity: proves that the sub-ledger reports (invoices, bills, animator work) agree with the ledger control accounts.
-- Nothing here changes data. A failed check is shown to the person and raises a notification; it never auto-corrects.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.integrity_checks(p_org uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  v_out jsonb := '[]'::jsonb; c record; v_exp numeric; v_act numeric; v_ar uuid; v_ap uuid; v_an uuid; v_d numeric; v_c numeric; v_asof date := current_date;
begin
  v_ar := finance_v3.system_account(p_org, 'accounts_receivable');
  v_ap := finance_v3.system_account(p_org, 'accounts_payable');
  v_an := finance_v3.system_account(p_org, 'animator_payables');
  select coalesce(sum(l.amount_base) filter (where l.side = 'debit'), 0), coalesce(sum(l.amount_base) filter (where l.side = 'credit'), 0) into v_d, v_c
    from finance_v3.journal_lines l join finance_v3.journal_entries e on e.id = l.entry_id
   where l.organization_id = p_org and e.status = 'posted' and e.fx_status <> 'missing';
  v_out := v_out || jsonb_build_object('code', 'trial_balance', 'label', 'Total debits equal total credits', 'ok', v_d = v_c, 'expected', v_d::text, 'actual', v_c::text, 'currency', null);
  for c in select distinct x.ccy from (
      select r.currency ccy from finance_v3.receivables r where r.organization_id = p_org
      union select b.currency from finance_v3.payables b where b.organization_id = p_org
      union select w.currency from finance_v3.animator_work_items w where w.organization_id = p_org) x order by 1 loop
    select coalesce(sum(r.outstanding), 0) into v_exp from finance_v3.receivables r
     where r.organization_id = p_org and r.currency = c.ccy and r.status in ('issued', 'partially_paid') and r.ledger_mode in ('full', 'opening_balance');
    v_act := finance_v3.account_native_balance(p_org, v_ar, c.ccy, v_asof);
    v_out := v_out || jsonb_build_object('code', 'ar_matches_ledger', 'label', 'Money clients owe matches the receivables account', 'ok', v_exp = v_act,
      'expected', finance_v3.money_text(v_exp, c.ccy), 'actual', finance_v3.money_text(v_act, c.ccy), 'currency', c.ccy);
    select coalesce(sum(b.outstanding), 0) into v_exp from finance_v3.payables b where b.organization_id = p_org and b.currency = c.ccy and b.status in ('approved', 'partially_paid');
    v_act := -finance_v3.account_native_balance(p_org, v_ap, c.ccy, v_asof);
    v_out := v_out || jsonb_build_object('code', 'ap_matches_ledger', 'label', 'Bills owed match the payables account', 'ok', v_exp = v_act,
      'expected', finance_v3.money_text(v_exp, c.ccy), 'actual', finance_v3.money_text(v_act, c.ccy), 'currency', c.ccy);
    select coalesce(sum(w.outstanding), 0) into v_exp from finance_v3.animator_work_items w where w.organization_id = p_org and w.currency = c.ccy and w.status = 'approved';
    v_act := -finance_v3.account_native_balance(p_org, v_an, c.ccy, v_asof);
    v_out := v_out || jsonb_build_object('code', 'animators_match_ledger', 'label', 'Money owed to animators matches the animator payables account', 'ok', v_exp = v_act,
      'expected', finance_v3.money_text(v_exp, c.ccy), 'actual', finance_v3.money_text(v_act, c.ccy), 'currency', c.ccy);
  end loop;
  return v_out;
end;
$$;

create or replace function public.fin3_report_integrity(p_org uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare v jsonb;
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  v := finance_v3.integrity_checks(p_org);
  return jsonb_build_object('checks', v, 'all_ok', not exists (select 1 from jsonb_array_elements(v) e where not (e ->> 'ok')::boolean), 'as_of', current_date);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Dashboard: the single authoritative summary. Revenue comes from the same ledger section the P&L uses; the dashboard never
-- calculates revenue, expenses or profit by itself. Sections follow permissions: the figures for animators / reserve / safe-to-spend
-- need finance.read (always true here); payment-verification counts need finance.verify_payment; email problems need finance.view_integrations.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fin3_dashboard(p_org uuid, p_currency text default null, p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  uid uuid; s finance_v3.org_settings; v_ccy text; v_from date; v_to date; ov jsonb; rev record; cos record; opx record; oin record; oex record;
  v_overdue_n integer; v_unread integer; v_integ jsonb;
begin
  uid := finance_v3.assert_permission(p_org, 'finance.read');
  s := finance_v3.assert_org_ready(p_org);
  v_ccy := finance_v3.rpt_ccy(p_org, p_currency);
  v_to := coalesce(p_to, current_date); v_from := coalesce(p_from, date_trunc('month', v_to)::date);
  perform finance_v3.chk_period(v_from, v_to);
  ov := public.fin3_overview(p_org, v_ccy);
  select * into rev from finance_v3.rpt_section(p_org, v_from, v_to, v_ccy, s.base_currency, array['revenue']);
  select * into cos from finance_v3.rpt_section(p_org, v_from, v_to, v_ccy, s.base_currency, array['cost_of_sales']);
  select * into opx from finance_v3.rpt_section(p_org, v_from, v_to, v_ccy, s.base_currency, array['operating_expense']);
  select * into oin from finance_v3.rpt_section(p_org, v_from, v_to, v_ccy, s.base_currency, array['other_income']);
  select * into oex from finance_v3.rpt_section(p_org, v_from, v_to, v_ccy, s.base_currency, array['other_expense']);
  select count(*) into v_overdue_n from finance_v3.receivables r where r.organization_id = p_org and r.currency = v_ccy and r.status in ('issued', 'partially_paid') and r.due_date < current_date;
  v_unread := (public.fin3_notification_counts(p_org) ->> 'unread')::int;
  return jsonb_build_object('currency', v_ccy, 'from', v_from, 'to', v_to, 'source', 'finance_v3.ledger',
    'revenue', finance_v3.money_text(rev.total, v_ccy),
    'expenses', finance_v3.money_text(cos.total + opx.total + oex.total, v_ccy),
    'profit', finance_v3.money_text(rev.total - cos.total - opx.total + oin.total - oex.total, v_ccy),
    'outstanding_invoices', ov ->> 'clients_owe_you', 'overdue_invoices', ov ->> 'clients_overdue', 'overdue_invoice_count', v_overdue_n,
    'received_payments', ov ->> 'money_received_last_30_days', 'received_payments_window', 'last_30_days',
    'animator_obligations', ov ->> 'owed_to_animators', 'business_reserve', ov ->> 'business_reserve',
    'safe_to_spend', ov ->> 'safe_to_spend', 'shortfall', ov ->> 'shortfall', 'money_in_bank', ov ->> 'money_in_bank',
    'warnings', ov -> 'warnings', 'unread_notifications', v_unread,
    'excluded_entries_missing_fx', case when v_ccy = s.base_currency then finance_v3.rpt_missing_fx(p_org, v_from, v_to) else 0 end);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Project integration. Financial records are tied to the app's EXISTING project / shot / production-stage ids by soft links.
-- No project, client, shot or animator entity is created here; contacts_v3 and project_finance (Phase 4) remain the only finance-side copies.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fin3_set_record_link(p_org uuid, p_object_type text, p_object_id uuid, p_project uuid, p_shot uuid default null, p_stage text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, finance_v3
as $$
declare uid uuid; v_ok boolean := false; v_stage text := nullif(btrim(p_stage), '');
begin
  uid := finance_v3.assert_permission(p_org, 'finance.post');
  perform finance_v3.assert_org_ready(p_org);
  if p_object_type not in ('work_item', 'invoice', 'expense', 'bill') or p_object_id is null then raise exception 'Unknown record type.' using errcode = 'V3011'; end if;
  if v_stage is not null and char_length(v_stage) > 60 then raise exception 'The stage name is too long.' using errcode = 'V3011'; end if;
  if p_project is null then
    delete from finance_v3.record_links where organization_id = p_org and object_type = p_object_type and object_id = p_object_id;
    perform finance_v3.write_audit(p_org, uid, 'record_link.removed', p_object_type, p_object_id::text, null, null, null);
    return jsonb_build_object('linked', false);
  end if;
  if not exists (select 1 from finance_v3.project_finance pf where pf.organization_id = p_org and pf.project_id = p_project) then
    raise exception 'Set up finance for this project first.' using errcode = 'V3010';
  end if;
  v_ok := case p_object_type
    when 'work_item' then exists (select 1 from finance_v3.animator_work_items x where x.organization_id = p_org and x.id = p_object_id)
    when 'invoice' then exists (select 1 from finance_v3.receivables x where x.organization_id = p_org and x.id = p_object_id)
    when 'expense' then exists (select 1 from finance_v3.expense_records x where x.organization_id = p_org and x.id = p_object_id)
    else exists (select 1 from finance_v3.payables x where x.organization_id = p_org and x.id = p_object_id) end;
  if not v_ok then raise exception 'Record not found.' using errcode = 'V3010'; end if;
  insert into finance_v3.record_links (organization_id, object_type, object_id, project_id, shot_id, stage_key, updated_by)
  values (p_org, p_object_type, p_object_id, p_project, p_shot, v_stage, uid)
  on conflict (organization_id, object_type, object_id) do update set project_id = excluded.project_id, shot_id = excluded.shot_id, stage_key = excluded.stage_key,
    updated_by = uid, updated_at = now();
  perform finance_v3.write_audit(p_org, uid, 'record_link.set', p_object_type, p_object_id::text, null,
    jsonb_build_object('project_id', p_project, 'shot_id', p_shot, 'stage', v_stage), null);
  return jsonb_build_object('linked', true, 'project_id', p_project, 'shot_id', p_shot, 'stage', v_stage);
end;
$$;

-- One project, everything finance knows about it: the Phase 4 figures plus invoices, bills, expenses, animator work and the links
-- grouped by shot / stage. Names of shots and stages stay in the app; this returns their ids.
create or replace function public.fin3_project_finance_detail(p_org uuid, p_project uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare pf finance_v3.project_finance%rowtype; c text;
begin
  perform finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  select * into pf from finance_v3.project_finance x where x.organization_id = p_org and x.project_id = p_project;
  if not found then return jsonb_build_object('project_id', p_project, 'configured', false); end if;
  c := pf.currency;
  return jsonb_build_object('project_id', p_project, 'configured', true, 'client_id', pf.client_id,
    'client_name', (select k.name from finance_v3.contacts_v3 k where k.organization_id = p_org and k.id = pf.client_id),
    'financials', finance_v3.project_financials(p_org, p_project),
    'invoices', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'invoice_no', r.invoice_no, 'status', r.status, 'total', finance_v3.money_text(r.total, r.currency),
        'outstanding', finance_v3.money_text(r.outstanding, r.currency), 'due_date', r.due_date, 'currency', r.currency) order by r.created_at desc), '[]'::jsonb)
        from finance_v3.receivables r where r.organization_id = p_org and r.project_id = p_project and r.status <> 'void'),
    'bills', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'bill_no', b.bill_no, 'status', b.status, 'total', finance_v3.money_text(b.total, b.currency),
        'outstanding', finance_v3.money_text(b.outstanding, b.currency), 'due_date', b.due_date) order by b.created_at desc), '[]'::jsonb)
        from finance_v3.payables b where b.organization_id = p_org and b.project_id = p_project and b.status <> 'void'),
    'expenses', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'expense_no', e.expense_no, 'description', e.description, 'amount', finance_v3.money_text(e.amount, e.currency),
        'date', e.expense_date) order by e.expense_date desc), '[]'::jsonb)
        from finance_v3.expense_records e where e.organization_id = p_org and e.project_id = p_project and e.reversal_entry_id is null),
    'animator_work', (select coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'work_ref', w.work_ref, 'animator_id', a.animator_id, 'status', w.status,
        'approved', finance_v3.money_text(w.approved_amount, w.currency), 'paid', finance_v3.money_text(w.amount_paid, w.currency),
        'outstanding', finance_v3.money_text(w.outstanding, w.currency), 'due_date', w.due_date) order by w.created_at desc), '[]'::jsonb)
        from finance_v3.animator_work_items w join finance_v3.animator_assignments a on a.organization_id = w.organization_id and a.id = w.assignment_id
       where w.organization_id = p_org and a.project_id = p_project and w.status <> 'void'),
    'links', (select coalesce(jsonb_agg(jsonb_build_object('object_type', l.object_type, 'object_id', l.object_id, 'shot_id', l.shot_id, 'stage', l.stage_key)), '[]'::jsonb)
        from finance_v3.record_links l where l.organization_id = p_org and l.project_id = p_project),
    'by_shot', (select coalesce(jsonb_agg(jsonb_build_object('shot_id', t.shot_id, 'stage', t.stage_key, 'records', t.n) order by t.n desc), '[]'::jsonb)
        from (select l.shot_id, l.stage_key, count(*) n from finance_v3.record_links l where l.organization_id = p_org and l.project_id = p_project and (l.shot_id is not null or l.stage_key is not null)
               group by l.shot_id, l.stage_key) t));
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Alert sweep: time-based conditions. Every notification key is derived from the record and the period it belongs to, so running
-- the sweep once a minute or ten times a day yields the same set of notifications.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.run_alerts(p_org uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  st finance_v3.alert_settings%rowtype; r record; c record; j jsonb; v_week text := to_char(current_date, 'IYYY-"W"IW'); v_new integer := 0; v_ok boolean;
  v_spent numeric; v_budget numeric; v_pct numeric; v_opx numeric; s finance_v3.org_settings; p record; v_hz integer;
begin
  select * into s from finance_v3.org_settings where organization_id = p_org;
  if not found then return jsonb_build_object('skipped', true); end if;   -- not initialised for Finance V3
  select * into st from finance_v3.alert_settings where organization_id = p_org;
  if not found then st.due_soon_days := 3; st.budget_warn_percent := 90; st.pending_payment_minutes := 30; end if;

  -- invoices
  for r in select i.id, i.invoice_no, i.due_date, i.outstanding, i.currency, (current_date - i.due_date) as late from finance_v3.receivables i
            where i.organization_id = p_org and i.status in ('issued', 'partially_paid') and i.outstanding > 0 and i.due_date is not null and i.due_date < current_date loop
    v_ok := finance_v3.notify(p_org, 'invoice_overdue', 'invoice', case when r.late > 30 then 'critical' else 'warning' end, 'inv:' || r.id || ':overdue',
      'Invoice ' || r.invoice_no || ' is overdue', finance_v3.money_text(r.outstanding, r.currency) || ' ' || r.currency || ' was due on ' || r.due_date || '.', 'invoice', r.id::text,
      jsonb_build_object('due_date', r.due_date));
    v_new := v_new + v_ok::int;
    if r.late > 30 then
      v_ok := finance_v3.notify(p_org, 'invoice_overdue_30', 'invoice', 'critical', 'inv:' || r.id || ':overdue30', 'Invoice ' || r.invoice_no || ' is over 30 days late',
        finance_v3.money_text(r.outstanding, r.currency) || ' ' || r.currency || ' is still unpaid.', 'invoice', r.id::text, '{}'::jsonb);
      v_new := v_new + v_ok::int;
    end if;
  end loop;
  for r in select i.id, i.invoice_no, i.due_date, i.outstanding, i.currency from finance_v3.receivables i
            where i.organization_id = p_org and i.status in ('issued', 'partially_paid') and i.outstanding > 0 and i.due_date between current_date and current_date + st.due_soon_days loop
    v_ok := finance_v3.notify(p_org, 'invoice_due_soon', 'invoice', 'info', 'inv:' || r.id || ':duesoon:' || r.due_date, 'Invoice ' || r.invoice_no || ' is due soon',
      finance_v3.money_text(r.outstanding, r.currency) || ' ' || r.currency || ' is due on ' || r.due_date || '.', 'invoice', r.id::text, jsonb_build_object('due_date', r.due_date));
    v_new := v_new + v_ok::int;
  end loop;

  -- supplier bills and animator payments
  for r in select b.id, b.bill_no, b.due_date, b.outstanding, b.currency from finance_v3.payables b
            where b.organization_id = p_org and b.status in ('approved', 'partially_paid') and b.outstanding > 0 and b.due_date is not null and b.due_date <= current_date + st.due_soon_days loop
    v_ok := finance_v3.notify(p_org, case when r.due_date < current_date then 'bill_overdue' else 'bill_due_soon' end, 'payables', case when r.due_date < current_date then 'warning' else 'info' end,
      'bill:' || r.id || ':' || case when r.due_date < current_date then 'overdue' else 'due:' || r.due_date end,
      case when r.due_date < current_date then 'Bill is overdue' else 'Bill is due soon' end,
      'Bill ' || coalesce(r.bill_no, '') || ': ' || finance_v3.money_text(r.outstanding, r.currency) || ' ' || r.currency || ' due ' || r.due_date || '.', 'bill', r.id::text, '{}'::jsonb, 'finance.pay');
    v_new := v_new + v_ok::int;
  end loop;
  for r in select w.id, w.work_ref, w.due_date, w.outstanding, w.currency from finance_v3.animator_work_items w
            where w.organization_id = p_org and w.status = 'approved' and w.outstanding > 0 and (w.due_date is null or w.due_date <= current_date + st.due_soon_days) loop
    v_ok := finance_v3.notify(p_org, 'animator_payment_due', 'payables', 'info', 'work:' || r.id || ':owed',
      'Animator payment owed', finance_v3.money_text(r.outstanding, r.currency) || ' ' || r.currency || ' is approved and unpaid' || coalesce(' (due ' || r.due_date || ')', '') || '.',
      'work_item', r.id::text, '{}'::jsonb, 'finance.pay');
    v_new := v_new + v_ok::int;
  end loop;

  -- project budgets
  for p in select pf.project_id, pf.budget_total from finance_v3.project_finance pf where pf.organization_id = p_org and pf.is_active and pf.budget_total > 0 loop
    j := finance_v3.project_financials(p_org, p.project_id);
    v_spent := (j -> 'costs' ->> 'actual_costs')::numeric + (j -> 'costs' ->> 'committed_costs')::numeric;
    v_pct := round(v_spent * 100 / p.budget_total, 1);
    if v_spent > p.budget_total then
      v_ok := finance_v3.notify(p_org, 'budget_overrun', 'project', 'critical', 'proj:' || p.project_id || ':overrun', 'Project is over budget',
        'Costs and commitments are ' || v_pct || '% of the budget.', 'project', p.project_id::text, jsonb_build_object('percent', v_pct));
      v_new := v_new + v_ok::int;
    elsif v_pct >= st.budget_warn_percent then
      v_ok := finance_v3.notify(p_org, 'budget_warning', 'project', 'warning', 'proj:' || p.project_id || ':budgetwarn', 'Project is close to its budget',
        'Costs and commitments are ' || v_pct || '% of the budget.', 'project', p.project_id::text, jsonb_build_object('percent', v_pct));
      v_new := v_new + v_ok::int;
    end if;
  end loop;

  -- reserves
  for r in select x.id, x.name, x.currency, x.minimum_amount, finance_v3.reserve_balance(p_org, x.id) as bal from finance_v3.reserves x
            where x.organization_id = p_org and x.is_active and x.minimum_amount > 0 loop
    if r.bal < r.minimum_amount then
      v_ok := finance_v3.notify(p_org, 'reserve_below_minimum', 'reserve', 'warning', 'reserve:' || r.id || ':min:' || v_week, 'Reserve "' || r.name || '" is below its minimum',
        'Balance ' || finance_v3.money_text(r.bal, r.currency) || ' ' || r.currency || ' is under the minimum of ' || finance_v3.money_text(r.minimum_amount, r.currency) || '.',
        'reserve', r.id::text, '{}'::jsonb, 'finance.read');
      v_new := v_new + v_ok::int;
    end if;
  end loop;

  -- cash and safe-to-spend, per currency that has any activity
  for c in select distinct x.ccy from (select i.currency ccy from finance_v3.receivables i where i.organization_id = p_org and i.status in ('issued', 'partially_paid')
                                       union select b.currency from finance_v3.payables b where b.organization_id = p_org and b.status in ('approved', 'partially_paid')
                                       union select w.currency from finance_v3.animator_work_items w where w.organization_id = p_org and w.status = 'approved'
                                       union select s.base_currency) x loop
    select * into p from finance_v3.safe_to_spend_parts(p_org, c.ccy);
    if p.raw < 0 then
      v_ok := finance_v3.notify(p_org, 'cash_shortfall', 'cash', 'critical', 'cash:' || c.ccy || ':' || v_week, 'Commitments are higher than cash (' || c.ccy || ')',
        'Short by ' || finance_v3.money_text(-p.raw, c.ccy) || ' ' || c.ccy || ' after animators, bills and reserves.', 'cash', c.ccy, jsonb_build_object('shortfall', (-p.raw)::text), 'finance.read');
      v_new := v_new + v_ok::int;
    else
      select coalesce(sum(t.total), 0) / 3 into v_opx from finance_v3.rpt_section(p_org, current_date - 90, current_date, c.ccy, s.base_currency, array['operating_expense']) t;
      if v_opx > 0 and p.raw < v_opx then
        v_ok := finance_v3.notify(p_org, 'safe_to_spend_low', 'cash', 'warning', 'sts:' || c.ccy || ':' || v_week, 'Safe-to-spend is below a normal month of running costs (' || c.ccy || ')',
          'Safe-to-spend is ' || finance_v3.money_text(p.raw, c.ccy) || ' ' || c.ccy || '; running costs average ' || finance_v3.money_text(v_opx, c.ccy) || ' a month.', 'cash', c.ccy, '{}'::jsonb);
        v_new := v_new + v_ok::int;
      end if;
    end if;
  end loop;

  -- reconciliation
  for r in select x.id, x.statement_date, x.difference, x.currency from finance_v3.reconciliations x where x.organization_id = p_org and x.status = 'completed' and x.difference <> 0 loop
    v_ok := finance_v3.notify(p_org, 'reconciliation_difference', 'reconciliation', 'warning', 'recon:' || r.id || ':diff', 'Reconciliation closed with a difference',
      'The statement of ' || r.statement_date || ' was closed with a difference of ' || finance_v3.money_text(r.difference, r.currency) || ' ' || r.currency || '.', 'reconciliation', r.id::text, '{}'::jsonb);
    v_new := v_new + v_ok::int;
  end loop;
  for r in select e ->> 'code' as code, e ->> 'currency' as ccy, e ->> 'label' as label from jsonb_array_elements(finance_v3.integrity_checks(p_org)) e where not (e ->> 'ok')::boolean loop
    v_ok := finance_v3.notify(p_org, 'integrity_check_failed', 'reconciliation', 'critical', 'integrity:' || r.code || ':' || coalesce(r.ccy, '-') || ':' || current_date,
      'A report check failed', r.label || ' no longer agrees' || coalesce(' (' || r.ccy || ')', '') || '. Nothing was changed; ask an accountant to look.', 'integrity', r.code, '{}'::jsonb, 'finance.admin');
    v_new := v_new + v_ok::int;
  end loop;

  -- online payments that have been "pending" at the provider for too long
  for r in select i.id, i.provider_reference, i.invoice_id from finance_v3.payment_intents i
            where i.organization_id = p_org and i.status = 'pending' and i.updated_at < now() - make_interval(mins => st.pending_payment_minutes) loop
    v_ok := finance_v3.notify(p_org, 'payment_pending_long', 'payment', 'warning', 'intent:' || r.id || ':stale', 'Card payment still pending',
      'A card payment on ' || finance_v3.inv_label(p_org, r.invoice_id) || ' has been pending for over ' || st.pending_payment_minutes || ' minutes. It will be checked with Paystack.',
      'payment_intent', r.id::text, '{}'::jsonb, 'finance.verify_payment');
    v_new := v_new + v_ok::int;
  end loop;

  -- receipts that no email was ever created for
  for r in select x.id, x.receipt_no from finance_v3.receipts x
            where x.organization_id = p_org and x.issued_at < now() - interval '10 minutes' and x.issued_at > now() - interval '14 days'
              and not exists (select 1 from finance_v3.email_messages m where m.organization_id = p_org and m.receipt_id = x.id) loop
    v_ok := finance_v3.notify(p_org, 'receipt_awaiting_email', 'email', 'info', 'receipt:' || r.id || ':noemail', 'Receipt ' || r.receipt_no || ' has not been emailed',
      'The client has not been sent this receipt yet.', 'receipt', r.id::text, '{}'::jsonb, 'finance.send_email');
    v_new := v_new + v_ok::int;
  end loop;

  -- integration health (once per day per kind)
  select count(*) into v_hz from finance_v3.provider_events e where e.organization_id = p_org and e.status in ('failed', 'exhausted') and e.received_at > now() - interval '24 hours';
  if v_hz > 0 then
    v_ok := finance_v3.notify(p_org, 'integration_errors', 'integration', 'warning', 'integ:paystack:' || current_date, 'Paystack messages failed in the last 24 hours',
      v_hz || ' Paystack message(s) were not processed.', 'integration', 'paystack', '{}'::jsonb, 'finance.view_integrations');
    v_new := v_new + v_ok::int;
  end if;
  select count(*) into v_hz from finance_v3.email_messages m where m.organization_id = p_org and m.status in ('failed', 'bounced') and m.created_at > now() - interval '24 hours';
  if v_hz > 0 then
    v_ok := finance_v3.notify(p_org, 'integration_errors', 'integration', 'warning', 'integ:resend:' || current_date, 'Emails failed in the last 24 hours',
      v_hz || ' email(s) bounced or failed.', 'integration', 'resend', '{}'::jsonb, 'finance.view_integrations');
    v_new := v_new + v_ok::int;
  end if;
  return jsonb_build_object('created', v_new);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Scheduled client emails. OFF unless an administrator enabled them in alert_settings. Bounded by max_reminders and the repeat
-- interval; idempotent by key; never emails an invalid address, a client whose last invoice email bounced, or an invoice with a
-- payment waiting for verification.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.run_reminders(p_org uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  st finance_v3.alert_settings%rowtype; s finance_v3.org_settings; r finance_v3.receivables%rowtype; c finance_v3.contacts_v3%rowtype; m finance_v3.email_messages%rowtype;
  v_auto integer; v_last timestamptz; v_queued integer := 0; v_skipped integer := 0; v_pay text; v_before integer;
begin
  select * into st from finance_v3.alert_settings where organization_id = p_org;
  if not found or not st.reminders_enabled or st.max_reminders = 0 then return jsonb_build_object('enabled', false, 'queued', 0, 'skipped', 0); end if;
  select * into s from finance_v3.org_settings where organization_id = p_org;
  for r in select * from finance_v3.receivables x
            where x.organization_id = p_org and x.status in ('issued', 'partially_paid') and x.outstanding > 0 and x.due_date is not null
              and x.due_date + st.reminder_first_after_days <= current_date order by x.due_date, x.id limit 200 loop
    select count(*) filter (where e.trigger_name = 'scheduler'), max(e.created_at) into v_auto, v_last from finance_v3.email_messages e
     where e.organization_id = p_org and e.invoice_id = r.id and e.email_type in ('invoice_reminder', 'overdue_notice');
    if v_auto >= st.max_reminders or (v_last is not null and v_last > now() - make_interval(days => st.reminder_repeat_days)) then v_skipped := v_skipped + 1; continue; end if;
    select * into c from finance_v3.contacts_v3 x where x.organization_id = p_org and x.id = r.client_id;
    if c.email is null or not finance_v3.valid_email(lower(btrim(c.email))) then v_skipped := v_skipped + 1; continue; end if;
    if exists (select 1 from finance_v3.email_messages e where e.organization_id = p_org and e.invoice_id = r.id and e.status = 'bounced' and lower(e.recipient) = lower(btrim(c.email)))
       or exists (select 1 from finance_v3.payments p where p.organization_id = p_org and p.invoice_id = r.id and p.verification_status = 'pending_verification') then
      v_skipped := v_skipped + 1; continue;
    end if;
    begin
      v_pay := null;
      if r.currency = any (s.collect_currencies) then v_pay := finance_v3.mint_link(p_org, r.id, 'pay', 30, null); end if;
      select count(*) into v_before from finance_v3.email_messages where organization_id = p_org and idempotency_key = 'fin3:email:reminder:' || r.id::text || ':auto' || (v_auto + 1);
      m := finance_v3.queue_email(p_org, 'invoice_reminder', 'invoice_reminder', r.id, null, null, null, r.client_id, lower(btrim(c.email)),
        'fin3:email:reminder:' || r.id::text || ':auto' || (v_auto + 1),
        finance_v3.invoice_email_payload(r, finance_v3.mint_link(p_org, r.id, 'view', 30, null), v_pay) || jsonb_build_object('days_overdue', greatest(current_date - r.due_date, 0)),
        null, null, 'scheduler');
      if v_before = 0 then v_queued := v_queued + 1; end if;
    exception when others then
      v_skipped := v_skipped + 1;
    end;
  end loop;
  return jsonb_build_object('enabled', true, 'queued', v_queued, 'skipped', v_skipped);
end;
$$;

-- Receipts with no email: queued only when auto_receipts is on, otherwise they stay a notification (run_alerts).
create or replace function finance_v3.run_receipts(p_org uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare st finance_v3.alert_settings%rowtype; r record; v_n integer := 0; v_skip integer := 0;
begin
  select * into st from finance_v3.alert_settings where organization_id = p_org;
  if not found or not st.auto_receipts then return jsonb_build_object('enabled', false, 'queued', 0); end if;
  for r in select x.id, x.payment_id from finance_v3.receipts x
            where x.organization_id = p_org and x.issued_at < now() - interval '10 minutes' and x.issued_at > now() - interval '14 days'
              and not exists (select 1 from finance_v3.email_messages m where m.organization_id = p_org and m.receipt_id = x.id) order by x.issued_at limit 200 loop
    begin
      perform finance_v3.queue_receipt_email(p_org, r.payment_id);
      v_n := v_n + 1;
    exception when others then v_skip := v_skip + 1;
    end;
  end loop;
  return jsonb_build_object('enabled', true, 'queued', v_n, 'skipped', v_skip);
end;
$$;

-- One pass over one or every V3 organisation. Safe to run as often as you like: a second run in the same minute creates nothing new.
create or replace function public.fin3svc_run_scheduled(p_org uuid default null)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, finance_v3
as $$
declare o record; v_run bigint; v_sum jsonb := '[]'::jsonb; v_n integer := 0; v_one jsonb; v_exp integer;
begin
  insert into finance_v3.scheduler_runs default values returning id into v_run;
  v_exp := public.fin3svc_expire_unknown_emails(24);
  for o in select x.organization_id from finance_v3.org_settings x where (p_org is null or x.organization_id = p_org) order by 1 loop
    if not pg_try_advisory_xact_lock(hashtextextended('fin3:scheduler:' || o.organization_id::text, 0)) then continue; end if;
    begin
      v_one := jsonb_build_object('organization_id', o.organization_id, 'alerts', finance_v3.run_alerts(o.organization_id),
        'reminders', finance_v3.run_reminders(o.organization_id), 'receipts', finance_v3.run_receipts(o.organization_id));
    exception when others then
      v_one := jsonb_build_object('organization_id', o.organization_id, 'error', left(sqlerrm, 200));
    end;
    v_sum := v_sum || v_one; v_n := v_n + 1;
  end loop;
  update finance_v3.scheduler_runs set finished_at = now(), organizations = v_n, summary = jsonb_build_object('expired_unknown_emails', v_exp, 'organizations', v_sum) where id = v_run;
  delete from finance_v3.scheduler_runs where started_at < now() - interval '60 days';
  return jsonb_build_object('run', v_run, 'organizations', v_n, 'expired_unknown_emails', v_exp, 'detail', v_sum);
end;
$$;

-- For the finance-scheduler edge function: card payments the provider has not finished reporting (it verifies each with Paystack).
create or replace function public.fin3svc_list_unsettled_intents(p_min_minutes integer default 15, p_max_days integer default 3, p_limit integer default 50)
returns jsonb
language sql stable security definer
set search_path = pg_catalog, finance_v3
as $$
  select coalesce(jsonb_agg(jsonb_build_object('organization_id', x.organization_id, 'intent_id', x.id, 'reference', x.provider_reference, 'environment', x.environment,
           'status', x.status, 'created_at', x.created_at) order by x.created_at), '[]'::jsonb)
    from (select i.* from finance_v3.payment_intents i
           where i.provider = 'paystack' and i.status in ('initialized', 'pending') and i.created_at < now() - make_interval(mins => greatest(coalesce(p_min_minutes, 15), 1))
             and i.created_at > now() - make_interval(days => least(greatest(coalesce(p_max_days, 3), 1), 14))
           order by i.created_at limit least(greatest(coalesce(p_limit, 50), 1), 200)) x
$$;

create or replace function public.fin3_scheduler_status(p_org uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare r finance_v3.scheduler_runs%rowtype;
begin
  perform finance_v3.assert_permission(p_org, 'finance.view_integrations');
  select * into r from finance_v3.scheduler_runs order by id desc limit 1;
  return jsonb_build_object('last_run_at', r.started_at, 'last_finished_at', r.finished_at, 'last_error', r.error,
    'configured', exists (select 1 from finance_v3.scheduler_config where dispatch_url is not null or scheduler_url is not null),
    'open_notifications', (select count(*) from finance_v3.notifications n where n.organization_id = p_org and n.resolved_at is null));
end;
$$;

-- pg_cron + pg_net wiring, same pattern as the mailbox sync. Without pg_cron / pg_net / a config row nothing is scheduled and nothing raises.
create or replace function finance_v3.kick_scheduler()
returns void
language plpgsql security definer
set search_path = pg_catalog, finance_v3
as $$
declare c finance_v3.scheduler_config%rowtype;
begin
  perform public.fin3svc_run_scheduled(null);
  select * into c from finance_v3.scheduler_config limit 1;
  if not found or c.secret is null or to_regnamespace('net') is null then return; end if;
  begin
    if c.dispatch_url is not null then
      execute format('select net.http_post(url := %L, headers := %L::jsonb, body := %L::jsonb)', c.dispatch_url,
        jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', c.secret)::text, '{}');
    end if;
    if c.scheduler_url is not null then
      execute format('select net.http_post(url := %L, headers := %L::jsonb, body := %L::jsonb)', c.scheduler_url,
        jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', c.secret)::text, '{}');
    end if;
  exception when others then null;
  end;
exception when others then
  begin
    update finance_v3.scheduler_runs set error = left(sqlerrm, 500) where id = (select max(id) from finance_v3.scheduler_runs);
  exception when others then null;
  end;
end;
$$;

do $$
begin
  if to_regnamespace('cron') is null then
    raise notice 'pg_cron is not enabled; Finance V3 scheduled processing is not scheduled. Enable pg_cron and re-run this file.';
  else
    perform cron.unschedule(jobid) from cron.job where jobname = 'kairflow_finance_v3_scheduler';
    perform cron.schedule('kairflow_finance_v3_scheduler', '*/5 * * * *', 'select finance_v3.kick_scheduler()');
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Emma (read-only). Insights are built here, with their sentences, so Emma quotes figures instead of computing them.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function finance_v3.emma_insights(p_org uuid, p_user uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  s finance_v3.org_settings; st finance_v3.alert_settings%rowtype; v jsonb := '[]'::jsonb; c record; r record; p record; j jsonb; v_n integer; v_amt numeric; v_week text;
  v_pct numeric; v_opx numeric; v_warn integer;
begin
  select * into s from finance_v3.org_settings where organization_id = p_org;
  select * into st from finance_v3.alert_settings where organization_id = p_org;
  v_warn := coalesce(st.budget_warn_percent, 90);
  for c in select distinct x.ccy from (select i.currency ccy from finance_v3.receivables i where i.organization_id = p_org and i.status in ('issued', 'partially_paid')
                                       union select w.currency from finance_v3.animator_work_items w where w.organization_id = p_org and w.status = 'approved'
                                       union select s.base_currency) x order by 1 loop
    select count(*), coalesce(sum(w.outstanding), 0) into v_n, v_amt from finance_v3.animator_work_items w where w.organization_id = p_org and w.currency = c.ccy and w.status = 'approved' and w.outstanding > 0;
    if v_n > 0 then v := v || jsonb_build_object('code', 'animator_payments_outstanding', 'severity', 'info', 'currency', c.ccy, 'count', v_n, 'amount', finance_v3.money_text(v_amt, c.ccy),
        'text', v_n || ' approved animator payment(s) are still unpaid, ' || finance_v3.money_text(v_amt, c.ccy) || ' ' || c.ccy || ' in total.'); end if;
    select count(*), coalesce(sum(i.outstanding), 0) into v_n, v_amt from finance_v3.receivables i where i.organization_id = p_org and i.currency = c.ccy
       and i.status in ('issued', 'partially_paid') and i.outstanding > 0 and i.due_date < current_date;
    if v_n > 0 then v := v || jsonb_build_object('code', 'overdue_invoices', 'severity', 'warning', 'currency', c.ccy, 'count', v_n, 'amount', finance_v3.money_text(v_amt, c.ccy),
        'text', v_n || ' invoice(s) are overdue, ' || finance_v3.money_text(v_amt, c.ccy) || ' ' || c.ccy || ' in total.'); end if;
    select * into p from finance_v3.safe_to_spend_parts(p_org, c.ccy);
    select coalesce(sum(t.total), 0) / 3 into v_opx from finance_v3.rpt_section(p_org, current_date - 90, current_date, c.ccy, s.base_currency, array['operating_expense']) t;
    if p.raw < 0 or (v_opx > 0 and p.raw < v_opx) then
      v := v || jsonb_build_object('code', 'safe_to_spend_low', 'severity', case when p.raw < 0 then 'critical' else 'warning' end, 'currency', c.ccy,
        'amount', finance_v3.money_text(p.raw, c.ccy), 'monthly_operating_expenses', finance_v3.money_text(v_opx, c.ccy),
        'text', 'Safe-to-spend is ' || finance_v3.money_text(p.raw, c.ccy) || ' ' || c.ccy || ', below the ' || finance_v3.money_text(v_opx, c.ccy) || ' a month it normally costs to run the studio.');
    end if;
  end loop;
  for r in select x.name, x.currency, x.target_amount, x.minimum_amount, finance_v3.reserve_balance(p_org, x.id) bal from finance_v3.reserves x
            where x.organization_id = p_org and x.is_active and ((x.target_amount > 0 and finance_v3.reserve_balance(p_org, x.id) < x.target_amount)) order by x.name loop
    v := v || jsonb_build_object('code', 'reserve_below_target', 'severity', case when r.minimum_amount > 0 and r.bal < r.minimum_amount then 'warning' else 'info' end, 'currency', r.currency,
      'text', 'Reserve "' || r.name || '" holds ' || finance_v3.money_text(r.bal, r.currency) || ' ' || r.currency || ', below its target of ' || finance_v3.money_text(r.target_amount, r.currency) || '.');
  end loop;
  for r in select pf.project_id, pf.budget_total, pf.currency from finance_v3.project_finance pf where pf.organization_id = p_org and pf.is_active and pf.budget_total > 0 loop
    j := finance_v3.project_financials(p_org, r.project_id);
    v_pct := round(((j -> 'costs' ->> 'actual_costs')::numeric + (j -> 'costs' ->> 'committed_costs')::numeric) * 100 / r.budget_total, 1);
    if v_pct >= v_warn then
      v := v || jsonb_build_object('code', 'project_budget', 'severity', case when v_pct > 100 then 'critical' else 'warning' end, 'project_id', r.project_id, 'percent', v_pct,
        'text', 'A project has used ' || v_pct || '% of its budget (project id ' || r.project_id || ').');
    end if;
  end loop;
  select count(*) into v_n from finance_v3.payments x where x.organization_id = p_org and x.provider = 'paystack' and x.verification_status = 'verified' and x.created_at > now() - interval '24 hours';
  if v_n > 0 then v := v || jsonb_build_object('code', 'paystack_payment_confirmed', 'severity', 'info', 'count', v_n, 'text', v_n || ' Paystack payment(s) were confirmed in the last 24 hours.'); end if;
  select count(*) into v_n from finance_v3.receipts x where x.organization_id = p_org and x.issued_at > now() - interval '14 days'
     and not exists (select 1 from finance_v3.email_messages m where m.organization_id = p_org and m.receipt_id = x.id);
  if v_n > 0 then v := v || jsonb_build_object('code', 'receipt_awaiting_email', 'severity', 'info', 'count', v_n, 'text', v_n || ' receipt(s) have not been emailed yet.'); end if;
  if finance_v3.has_permission_for(p_user, p_org, 'finance.view_integrations') then
    select count(*) into v_n from finance_v3.email_messages m where m.organization_id = p_org and m.email_type = 'invoice' and m.created_at > now() - interval '30 days'
       and (m.status in ('bounced', 'failed') or m.unknown_outcome);
    if v_n > 0 then v := v || jsonb_build_object('code', 'invoice_email_not_delivered', 'severity', 'warning', 'count', v_n, 'text', v_n || ' invoice email(s) were not delivered in the last 30 days.'); end if;
  end if;
  return v;
end;
$$;

create or replace function public.fin3_emma_snapshot(p_org uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, finance_v3
as $$
declare uid uuid;
begin
  uid := finance_v3.assert_permission(p_org, 'finance.read');
  perform finance_v3.assert_org_ready(p_org);
  return jsonb_build_object('generated_at', now(), 'read_only', true, 'insights', finance_v3.emma_insights(p_org, uid), 'overview', public.fin3_overview(p_org, null));
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Exports. Returns columns + rows (text); the browser builds the CSV with formula-injection protection. Never includes tokens,
-- payment links, message bodies, provider payloads or audit before/after snapshots. The export itself is audited.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.fin3_export_rows(p_org uuid, p_export text, p_from date default null, p_to date default null, p_currency text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, finance_v3
as $$
declare
  uid uuid; v_from date := coalesce(p_from, date '1990-01-01'); v_to date := coalesce(p_to, current_date + 1); v_cols jsonb; v_rows jsonb; v_n integer;
  v_cap constant integer := 20000; v_ccy text := upper(nullif(btrim(p_currency), '')); s finance_v3.org_settings; pj record;
begin
  if p_export not in ('invoices', 'payments', 'transactions', 'audit', 'project_profitability', 'email_delivery', 'expenses', 'report_profit_loss') then
    raise exception 'Unknown export "%".', left(coalesce(p_export, ''), 40) using errcode = 'V3011';
  end if;
  uid := finance_v3.assert_permission(p_org, case p_export when 'audit' then 'finance.admin' when 'email_delivery' then 'finance.view_integrations' else 'finance.read' end);
  s := finance_v3.assert_org_ready(p_org);
  if v_from > v_to then raise exception 'Choose a valid period (from must not be after to).' using errcode = 'V3011'; end if;

  if p_export = 'invoices' then
    v_cols := '["invoice_no","client","status","currency","issue_date","due_date","total","amount_paid","credit_total","outstanding","project_id"]'::jsonb;
    select coalesce(jsonb_agg(to_jsonb(x.row) order by x.k1, x.k2), '[]'::jsonb) into v_rows from (
      select jsonb_build_array(r.invoice_no, c.name, r.status, r.currency, r.issue_date, r.due_date, finance_v3.money_text(r.total, r.currency), finance_v3.money_text(r.amount_paid, r.currency),
               finance_v3.money_text(r.credit_total, r.currency), finance_v3.money_text(r.outstanding, r.currency), r.project_id) as row, r.issue_date as k1, r.invoice_no as k2
        from finance_v3.receivables r left join finance_v3.contacts_v3 c on c.organization_id = r.organization_id and c.id = r.client_id
       where r.organization_id = p_org and r.status <> 'draft' and coalesce(r.issue_date, r.created_at::date) between v_from and v_to and (v_ccy is null or r.currency = v_ccy)
       order by r.issue_date, r.invoice_no limit v_cap + 1) x;
  elsif p_export = 'payments' then
    v_cols := '["date","invoice_no","client","method","provider","currency","amount","refunded","status","verification","reference"]'::jsonb;
    select coalesce(jsonb_agg(x.row order by x.k1, x.k2), '[]'::jsonb) into v_rows from (
      select jsonb_build_array(p.accounting_date, i.invoice_no, c.name, p.method, p.provider, p.currency, finance_v3.money_text(p.amount, p.currency), finance_v3.money_text(p.refunded_amount, p.currency),
               p.status, p.verification_status, p.reference) as row, p.accounting_date as k1, p.id as k2
        from finance_v3.payments p join finance_v3.receivables i on i.organization_id = p.organization_id and i.id = p.invoice_id
        left join finance_v3.contacts_v3 c on c.organization_id = p.organization_id and c.id = p.client_id
       where p.organization_id = p_org and p.accounting_date between v_from and v_to and (v_ccy is null or p.currency = v_ccy) order by p.accounting_date, p.id limit v_cap + 1) x;
  elsif p_export = 'transactions' then
    v_cols := '["entry_no","date","memo","account_code","account_name","side","currency","amount","amount_base","base_currency"]'::jsonb;
    select coalesce(jsonb_agg(x.row order by x.k1, x.k2), '[]'::jsonb) into v_rows from (
      select jsonb_build_array(e.entry_no, e.accounting_date, e.memo, a.code, a.name, l.side, l.currency, finance_v3.money_text(l.amount_native, l.currency),
               case when l.amount_base is null then null else finance_v3.money_text(l.amount_base, e.base_currency) end, e.base_currency) as row, e.entry_no as k1, l.line_no as k2
        from finance_v3.journal_entries e join finance_v3.journal_lines l on l.entry_id = e.id join finance_v3.accounts a on a.organization_id = l.organization_id and a.id = l.account_id
       where e.organization_id = p_org and e.status = 'posted' and e.accounting_date between v_from and v_to and (v_ccy is null or l.currency = v_ccy)
       order by e.entry_no, l.line_no limit v_cap + 1) x;
  elsif p_export = 'audit' then
    v_cols := '["at","actor","action","object_type","object_id","reason"]'::jsonb;
    select coalesce(jsonb_agg(x.row order by x.k1 desc, x.k2 desc), '[]'::jsonb) into v_rows from (
      select jsonb_build_array(a.at, a.actor, a.action, a.object_type, a.object_id, a.reason) as row, a.at as k1, a.id as k2 from finance_v3.audit_log a
       where a.organization_id = p_org and a.at::date between v_from and v_to order by a.at desc, a.id desc limit v_cap + 1) x;
  elsif p_export = 'email_delivery' then
    v_cols := '["created_at","email_type","status","invoice_no","recipient","attempts","failure_code","sent_at","delivered_at"]'::jsonb;
    select coalesce(jsonb_agg(x.row order by x.k1, x.k2), '[]'::jsonb) into v_rows from (
      select jsonb_build_array(m.created_at, m.email_type, m.status, r.invoice_no, m.recipient, m.attempt_count, m.failure_code, m.sent_at, m.delivered_at) as row, m.created_at as k1, m.id as k2
        from finance_v3.email_messages m left join finance_v3.receivables r on r.organization_id = m.organization_id and r.id = m.invoice_id
       where m.organization_id = p_org and m.created_at::date between v_from and v_to order by m.created_at, m.id limit v_cap + 1) x;
  elsif p_export = 'expenses' then
    v_cols := '["expense_no","date","vendor","category","description","currency","amount","project_id"]'::jsonb;
    select coalesce(jsonb_agg(x.row order by x.k1, x.k2), '[]'::jsonb) into v_rows from (
      select jsonb_build_array(e.expense_no, e.expense_date, e.vendor_name, c.name, e.description, e.currency, finance_v3.money_text(e.amount, e.currency), e.project_id) as row, e.expense_date as k1, e.expense_no as k2
        from finance_v3.expense_records e left join finance_v3.expense_categories c on c.organization_id = e.organization_id and c.id = e.category_id
       where e.organization_id = p_org and e.reversal_entry_id is null and e.expense_date between v_from and v_to and (v_ccy is null or e.currency = v_ccy) order by e.expense_date, e.expense_no limit v_cap + 1) x;
  elsif p_export = 'project_profitability' then
    v_cols := '["project_id","currency","contract_value","invoiced","received","actual_costs","committed_costs","revenue","profit","margin_percent","budget_total","budget_remaining"]'::jsonb;
    v_rows := '[]'::jsonb;
    for pj in select pf.project_id from finance_v3.project_finance pf where pf.organization_id = p_org order by pf.project_id limit v_cap loop
      v_rows := v_rows || jsonb_build_array(jsonb_build_array(pj.project_id, finance_v3.project_financials(p_org, pj.project_id) ->> 'currency',
        finance_v3.project_financials(p_org, pj.project_id) -> 'contract' ->> 'contract_value', finance_v3.project_financials(p_org, pj.project_id) -> 'contract' ->> 'invoiced',
        finance_v3.project_financials(p_org, pj.project_id) -> 'contract' ->> 'client_payments_received', finance_v3.project_financials(p_org, pj.project_id) -> 'costs' ->> 'actual_costs',
        finance_v3.project_financials(p_org, pj.project_id) -> 'costs' ->> 'committed_costs', finance_v3.project_financials(p_org, pj.project_id) -> 'accounting' ->> 'revenue',
        finance_v3.project_financials(p_org, pj.project_id) -> 'accounting' ->> 'profit', finance_v3.project_financials(p_org, pj.project_id) -> 'accounting' ->> 'margin_percent',
        finance_v3.project_financials(p_org, pj.project_id) -> 'budget' ->> 'total', finance_v3.project_financials(p_org, pj.project_id) -> 'budget' ->> 'remaining'));
    end loop;
  else   -- report_profit_loss
    v_ccy := finance_v3.rpt_ccy(p_org, v_ccy);
    v_cols := '["section","code","name","amount","currency"]'::jsonb;
    v_rows := '[]'::jsonb;
    declare sec record; sx record; rw jsonb;
    begin
      for sec in select * from (values ('Revenue', array['revenue']), ('Cost of sales', array['cost_of_sales']), ('Operating expenses', array['operating_expense']),
                                       ('Other income', array['other_income']), ('Other expenses', array['other_expense'])) t(label, types) loop
        select * into sx from finance_v3.rpt_section(p_org, v_from, v_to, v_ccy, s.base_currency, sec.types);
        for rw in select * from jsonb_array_elements(sx.rows_json) loop
          v_rows := v_rows || jsonb_build_array(jsonb_build_array(sec.label, rw ->> 'code', rw ->> 'name', rw ->> 'amount', v_ccy));
        end loop;
        v_rows := v_rows || jsonb_build_array(jsonb_build_array(sec.label, null, 'Total', finance_v3.money_text(sx.total, v_ccy), v_ccy));
      end loop;
    end;
  end if;

  v_n := jsonb_array_length(v_rows);
  if v_n > v_cap then
    v_rows := (select jsonb_agg(e) from (select e from jsonb_array_elements(v_rows) with ordinality t(e, o) order by o limit v_cap) q);
    v_n := v_cap;
    perform finance_v3.write_audit(p_org, uid, 'export.created', 'export', p_export, null, jsonb_build_object('rows', v_n, 'truncated', true), null);
    return jsonb_build_object('kind', p_export, 'columns', v_cols, 'rows', v_rows, 'row_count', v_n, 'truncated', true);
  end if;
  perform finance_v3.write_audit(p_org, uid, 'export.created', 'export', p_export, null, jsonb_build_object('rows', v_n, 'truncated', false), null);
  return jsonb_build_object('kind', p_export, 'columns', v_cols, 'rows', v_rows, 'row_count', v_n, 'truncated', false);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Privileges (same footer as every Finance V3 migration)
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

notify pgrst, 'reload schema';

commit;
