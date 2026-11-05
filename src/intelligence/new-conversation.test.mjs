import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const api = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const view = readFileSync(new URL('./OutreachView.jsx', import.meta.url), 'utf8');
const sql = readFileSync(new URL('../../supabase/migrations/20261114090000_intelligence_new_lead_conversations.sql', import.meta.url), 'utf8');

test('new lead conversation uses an admin RPC and starts pending approval', () => {
  assert.match(api, /composeLeadMessage:[\s\S]*intel_admin_compose_lead_message/);
  assert.match(view, /New conversation/);
  assert.match(view, /Create for review/);
  assert.match(sql, /'outbound', 'initial', 0, 'pending_approval'/);
  assert.match(sql, /auto_sent\s*\)\s*values[\s\S]*false/);
});

test('new lead conversation RPC validates linked prospect, recipient and suppressions', () => {
  assert.match(sql, /p\.lead_id is distinct from l\.id/);
  assert.match(sql, /v_to is distinct from public\.intel_norm_email\(p\.contact_email\)/);
  assert.match(sql, /from public\.intel_suppressions/);
  assert.match(sql, /'rejected','closed','suppressed','replied'/);
});
