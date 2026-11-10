import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../../supabase/migrations/20261127100000_intelligence_delivery_events.sql', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../../intelligence-worker/kairflow_intel/delivery_events.py', import.meta.url), 'utf8');

test('Phase 7 records provider-scoped delivery events idempotently and only for exact assigned accounts', () => {
  assert.match(migration, /create table if not exists public\.intel_delivery_events/i);
  assert.match(migration, /unique \(organization_id, provider_key, provider_account_id, provider_event_id\)/i);
  assert.match(migration, /provider_account_id = p_provider_account_id/i);
  assert.match(migration, /provider_message_id = p_provider_message_id/i);
  assert.match(migration, /a\.provider_key = p_provider_key/i);
  assert.match(migration, /direction = 'outbound'/i);
  assert.match(migration, /on conflict \(organization_id, provider_key, provider_account_id, provider_event_id\) do nothing/i);
  assert.match(migration, /if v_inserted = 0 then[\s\S]*?duplicate/i);
  assert.match(migration, /provider event id collision/i);
});

test('delivery progression is monotonic; terminal bounce and complaint cannot be undone by delayed events', () => {
  assert.match(migration, /when 'accepted' then 10 when 'delayed' then 20 when 'delivered' then 30/i);
  assert.match(migration, /when 'failed' then 40 when 'bounced' then 50 when 'complained' then 60/i);
  assert.match(migration, /if v_rank > v_current_rank then/i);
  assert.match(migration, /values \(m\.organization_id,'email',public\.intel_norm_email\(m\.to_email\),[\s\S]*?then 'complaint' else 'bounce'/i);
});

test('delivery events synchronize CRM metadata and contactability suppressions without conflating sent with delivered', () => {
  assert.match(migration, /delivery_status text not null default 'pending'/i);
  assert.match(migration, /provider_message_id = coalesce\(provider_message_id, nullif\(p_zoho_message_id,''\)\)/i);
  assert.match(migration, /set provider_message_id = m\.zoho_message_id[\s\S]*?m\.provider_account_id is not null/i);
  assert.match(migration, /update public\.intel_messages[\s\S]*?delivery_status = 'accepted'[\s\S]*?state = 'sent'/i);
  assert.match(migration, /new\.state = 'sent'[\s\S]*?new\.delivery_status = 'pending'[\s\S]*?new\.delivery_status := 'accepted'/i);
  assert.match(migration, /'deliveryStatus',v_status/i);
  assert.match(migration, /'deliveryUpdatedAt',v_event_at/i);
  assert.match(migration, /if v_status in \('bounced','complained'\) then/i);
  assert.match(migration, /grant execute on function public\.intel_agent_apply_delivery_event[\s\S]*?to service_role/i);
});

test('worker requires a stable event id and sends only reduced, non-content diagnostics', () => {
  assert.match(worker, /missing stable provider event id/i);
  assert.match(worker, /p_provider_event_id/);
  assert.match(worker, /never persist arbitrary provider payloads/i);
  assert.match(worker, /intel_agent_apply_delivery_event/);
});


test('event receipts are namespaced by provider account and unmatched events are not acknowledged', () => {
  assert.match(migration, /unique \(organization_id, provider_key, provider_account_id, provider_event_id\)/i);
  assert.match(migration, /where organization_id = m\.organization_id[\s\S]*?and provider_key = p_provider_key[\s\S]*?and provider_account_id = p_provider_account_id[\s\S]*?and provider_event_id = p_provider_event_id/i);
  assert.match(migration, /ok', false, 'found', false, 'retryable', false, 'reason', 'message_not_matched'/i);
  assert.match(migration, /ok', false, 'found', false, 'retryable', false, 'reason', 'recipient_mismatch'/i);
  assert.match(worker, /result\.get\("found"\) is not True/i);
  assert.match(worker, /durable processing outcome/i);
});

test('legacy provider-message uniqueness is replaced with account-scoped uniqueness', () => {
  assert.match(migration, /drop index if exists public\.intel_messages_provider_uidx/i);
  assert.match(migration, /drop index if exists public\.intel_messages_zoho_uidx/i);
  assert.match(migration, /on public\.intel_messages\(organization_id, provider_key, provider_account_id, provider_message_id\)/i);
  assert.match(migration, /create index if not exists intel_messages_legacy_zoho_message_idx/i);
});

test('complaint does not overwrite administrator or independent suppression provenance', () => {
  assert.match(migration, /lower\(btrim\(public\.intel_suppressions\.reason\)\) in \('bounce','complaint'\)/i);
  assert.match(migration, /public\.intel_suppressions\.source in \('agent'\)/i);
  assert.match(migration, /else public\.intel_suppressions\.reason end/i);
  assert.match(migration, /else public\.intel_suppressions\.source end/i);
});

test('Resend signed delivery webhook is wired to Intelligence RPC with exact account/message identity', () => {
  const logic = readFileSync(new URL('../../supabase/functions/_shared/email_resend_logic.ts', import.meta.url), 'utf8');
  const store = readFileSync(new URL('../../supabase/functions/_shared/intel_resend_delivery_sink.ts', import.meta.url), 'utf8');   // Intelligence-owned sink plugged in by resend-webhook/index.ts
  assert.match(logic, /applyIntelDeliveryEvent/);
  assert.match(logic, /out\.found \|\| intel\.found/);
  assert.match(store, /from\("intel_messages"\)[\s\S]*?eq\("provider_key", "resend"\)[\s\S]*?eq\("provider_message_id", a\.provider_message_id\)/);
  assert.match(store, /intel_agent_apply_delivery_event/);
  assert.match(store, /p_provider_account_id: row\.provider_account_id/);
  assert.match(logic, /Intelligence provider message id is ambiguous/);
});
