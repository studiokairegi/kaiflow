import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { processDeliveryEvent, statusForEvent } from '../../supabase/functions/_shared/email_resend_logic.ts';

const migration = readFileSync(new URL('../../supabase/migrations/20261203100000_intelligence_phase7_delivery_event_corrective.sql', import.meta.url), 'utf8');
const storeSource = readFileSync(new URL('../../supabase/functions/_shared/intel_resend_delivery_sink.ts', import.meta.url), 'utf8');   // Intelligence-owned delivery sink

function deps({ crm = { found: false }, intel = { found: false } } = {}) {
  const calls = { crm: [], intel: [] };
  return {
    calls,
    value: {
      now: () => Date.parse('2026-12-04T00:00:00Z'),
      store: {
        applyDeliveryEvent: async (arg) => { calls.crm.push(arg); return crm; },
        applyIntelDeliveryEvent: async (arg) => { calls.intel.push(arg); return intel; },
      },
    },
  };
}

const evt = (type, data = {}) => ({
  type,
  created_at: '2026-11-01T00:00:00Z',
  data: { email_id: 're_123', to: ['person@example.test'], ...data },
});

test('temporary/transient/soft Resend bounces are delivery delays, not permanent bounces', () => {
  for (const bounceType of ['Temporary', 'Transient', 'Soft']) {
    assert.equal(statusForEvent('email.bounced', bounceType), 'delivery_delayed');
  }
  assert.equal(statusForEvent('email.bounced', 'Permanent'), 'bounced');
});

test('old unmatched signed delivery events are retained for reconciliation instead of age-discarded', async () => {
  const d = deps();
  const result = await processDeliveryEvent(d.value, 'svix-old-event', evt('email.bounced', { bounce: { type: 'Transient' } }));
  assert.deepEqual(result, { result: 'ignored', reason: 'awaiting provider message persistence; queued for reconciliation' });
  assert.equal(d.calls.crm[0].status, 'delivery_delayed');
  assert.equal(d.calls.intel[0].bounce_type, 'Transient');
  assert.equal(d.calls.intel[0].recipient, 'person@example.test');
});

test('provider suppression events route to both message stores with recipient evidence', async () => {
  const d = deps({ crm: { found: true }, intel: { found: true } });
  const result = await processDeliveryEvent(d.value, 'svix-suppressed', evt('email.suppressed', { suppressed: { message: 'provider suppression' } }));
  assert.equal(result.result, 'processed');
  assert.equal(d.calls.crm[0].status, 'rejected');
  assert.equal(d.calls.crm[0].detail.recipient, 'person@example.test');
  assert.equal(d.calls.intel[0].event_type, 'email.suppressed');
});

test('Resend Intelligence adapter maps temporary bounce to delayed and suppression to failed', () => {
  assert.match(storeSource, /a\.event_type === "email\.bounced" && \/temporary\|transient\|soft\/i\.test\(a\.bounce_type \|\| ""\)[\s\S]*?\? "delayed"/);
  assert.match(storeSource, /"email\.suppressed": "failed"/);
});

test('CRM-only bounces and provider suppressions create Intelligence suppression records', () => {
  assert.match(migration, /A CRM-only delivery record must still protect Intelligence contactability/);
  assert.match(migration, /if p_status in \('bounced','complained'\) or p_event_type = 'email\.suppressed' then/);
  assert.match(migration, /insert into public\.intel_suppressions\(organization_id,kind,value,reason,source\)/);
});

test('unmatched events replay when either CRM or Intelligence later persists its provider message id', () => {
  assert.match(migration, /create or replace function public\.email_replay_delivery_events_for_message\(\)/);
  assert.match(migration, /create or replace function public\.intel_replay_delivery_events_for_message\(\)/);
  assert.match(migration, /after insert or update of provider_message_id on public\.email_messages/);
  assert.match(migration, /after insert or update of provider_message_id on public\.intel_messages/);
  assert.match(migration, /email_webhook_events_provider_message_idx/);
});

test('complaint upgrades only delivery suppressions and cannot rewrite administrator or unrelated reasons', () => {
  assert.match(migration, /public\.intel_suppressions\.source = 'agent' or public\.intel_suppressions\.source like 'provider:%'/);
  assert.match(migration, /lower\(btrim\(public\.intel_suppressions\.reason\)\) in \('bounce','complaint','provider_suppressed'\)/);
  assert.match(migration, /else public\.intel_suppressions\.reason end/);
  assert.match(migration, /else public\.intel_suppressions\.source end/);
});
