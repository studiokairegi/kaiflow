import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../../supabase/migrations/20261115110000_intelligence_sync_crm_email_status.sql', import.meta.url), 'utf8');

test('confirmed Intelligence sends materialize and mark the matching CRM email slot', () => {
  assert.match(migration, /create or replace function public\.intel_agent_confirm_send/i);
  assert.match(migration, /if m\.state = 'sent' then return[\s\S]*?idempotent/i);
  assert.match(migration, /if m\.state not in \('reserved','sending','unknown'\) then/i);
  assert.match(migration, /while jsonb_array_length\(v_emails\) <= m\.step loop/i);
  assert.match(migration, /'sent', true/i);
  assert.match(migration, /'dateSent', to_char\(v_when, 'YYYY-MM-DD'\)/i);
  assert.match(migration, /'message', m\.body_text/i);
  assert.match(migration, /last_contacted_at = v_when/i);
  assert.match(migration, /stage = case when m\.kind = 'initial' and stage = 'pool' then 'cold_email'/i);
});

test('CRM email synchronization is performed only after confirmed delivery and keeps worker-only RPC access', () => {
  const sendUpdate = migration.indexOf("update public.intel_messages\n     set state = 'sent'");
  const crmUpdate = migration.indexOf('update public.leads', sendUpdate);
  assert.ok(sendUpdate >= 0 && crmUpdate > sendUpdate);
  assert.match(migration, /revoke all on function public\.intel_agent_confirm_send\(uuid,text,text,text,timestamptz\) from public, anon/i);
  assert.match(migration, /grant execute on function public\.intel_agent_confirm_send\(uuid,text,text,text,timestamptz\) to authenticated/i);
});
