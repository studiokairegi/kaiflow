import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync('supabase/migrations/20261128100000_intelligence_phase8_final_send_boundary.sql', 'utf8');
const worker = readFileSync('intelligence-worker/kairflow_intel/mailops.py', 'utf8');
const finalGate = migration.split('create or replace function public.intel_agent_mark_sending')[1]?.split('revoke all on function public.intel_agent_mark_sending')[0] ?? '';

test('Phase 8 final gate is the database-owned reserved-to-sending transition', () => {
  assert.match(finalGate, /m\.state <> 'reserved'/);
  assert.match(finalGate, /for update/);
  assert.match(finalGate, /set state = 'sending'/);
  assert.match(finalGate, /return true/);
});

test('Phase 8 requires explicit human approval and the live kill switch', () => {
  assert.match(finalGate, /coalesce\(m\.auto_sent, false\)/);
  assert.match(finalGate, /state = 'pending_approval'/);
  assert.match(finalGate, /if s\.kill_switch then/);
});

test('Phase 8 rechecks suppression, unsubscribe/permission and contactability', () => {
  assert.match(finalGate, /intel_suppressions/);
  assert.match(finalGate, /intel_contact_permissions/);
  assert.match(migration, /intel_phase8_suppression_lock/);
  assert.match(migration, /intel_phase8_contact_permission_lock/);
  assert.match(migration, /intel_phase8_release_pre_send_quota/);
  assert.match(finalGate, /pg_advisory_xact_lock/);
  assert.match(finalGate, /revoked_at is null/);
  assert.match(finalGate, /contactability,status/);
  assert.match(finalGate, /v_contactability <> 'pass'/);
  assert.match(finalGate, /p\.facts #>> '\{verified,contactability,status\}'/);
  assert.doesNotMatch(finalGate, /estimates,contactability,status/);
  assert.match(finalGate, /intel_norm_email\(p\.contact_email\) <> public\.intel_norm_email\(m\.to_email\)/);
});

test('estimated contactability can never authorize the final send transition', () => {
  assert.doesNotMatch(finalGate, /coalesce\([\s\S]{0,180}estimates,contactability,status/);
  assert.match(finalGate, /coalesce\(p\.facts #>> '\{verified,contactability,status\}', 'needs_review'\)/);
});

test('Phase 8 rechecks prospect, campaign, conversation and CRM ownership', () => {
  for (const token of ['intel_prospects', 'intel_campaigns', 'intel_lead_history', 'inbound', 'origin_detail', 'takeover']) {
    assert.ok(finalGate.includes(token), `missing final-boundary check: ${token}`);
  }
  assert.match(finalGate, /outside send window at final send boundary/);
  assert.match(finalGate, /_intel_effective_initial_cap/);
  assert.match(finalGate, /daily_followup_cap/);
});

test('Phase 8 requires exact provider account, registry capability and quota reservation', () => {
  for (const token of ['provider_account_id', 'intel_provider_accounts', 'intel_email_provider_registry', 'email_provider_enabled', 'intel_provider_account_usage', 'daily_send_limit', 'hourly_send_limit', 'minute_send_limit']) {
    assert.ok(finalGate.includes(token), `missing provider boundary check: ${token}`);
  }
  assert.match(finalGate, /m\.provider_account_id is null/);
  assert.match(finalGate, /for share/);
});

test('worker calls the final boundary immediately before provider submission', () => {
  const mark = worker.indexOf('rpc("intel_agent_mark_sending"');
  const send = worker.indexOf('provider.send(', mark);
  assert.ok(mark >= 0 && send > mark);
  const afterFinalRpc = worker.slice(worker.indexOf('\n', mark) + 1, send);
  assert.doesNotMatch(afterFinalRpc, /rpc\(/);
});

test('unknown outcomes remain non-retryable and are not reset by the unknown transition', () => {
  const unknown = migration.split('create or replace function public.intel_agent_mark_unknown')[1]?.split('revoke all on function public.intel_agent_mark_unknown')[0] ?? '';
  assert.match(unknown, /state = 'sending'/);
  assert.doesNotMatch(unknown, /state\s*=\s*'approved'/);
  const opsTests = readFileSync('intelligence-worker/tests/test_ops.py', 'utf8');
  assert.match(opsTests, /needs_reconcile/);
  assert.match(worker, /manual resolution required/);
});

test('inbound recording locks the same prospect row as final send eligibility', () => {
  const inbound = migration.split('create or replace function public.intel_agent_record_inbound')[1]?.split('revoke all on function public.intel_agent_record_inbound')[0] ?? '';
  assert.match(inbound, /from public\.intel_prospects[\s\S]*for update/);
  assert.match(finalGate, /from public\.intel_prospects[\s\S]*for update/);
});

test('send confirmation cannot promote a merely reserved message', () => {
  const confirm = migration.split('create or replace function public.intel_agent_confirm_send')[1]?.split('revoke all on function public.intel_agent_confirm_send')[0] ?? '';
  assert.match(confirm, /m\.state not in \('sending','unknown'\)/);
  assert.doesNotMatch(confirm, /m\.state not in \('reserved','sending','unknown'\)/);
});
