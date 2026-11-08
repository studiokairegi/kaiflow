import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const api = fs.readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const settings = fs.readFileSync(new URL('./SettingsView.jsx', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../../supabase/migrations/20261124100000_intelligence_provider_account_management.sql', import.meta.url), 'utf8');

test('provider account API exposes catalogue, inventory, scoped update and disconnect RPCs', () => {
  for (const name of ['intel_admin_provider_catalog', 'intel_admin_provider_accounts', 'intel_admin_update_provider_account', 'intel_admin_disconnect_provider_account']) assert.ok(api.includes(name));
});

test('account UI only offers reviewed multi-account Gmail OAuth and keeps sending behind explicit layered gates', () => {
  assert.match(settings, /supports_multiple_accounts === true/);
  assert.match(settings, /intel-provider-connect/);
  assert.match(settings, /send_enabled \? "Configured on" : "OFF"/);
  assert.doesNotMatch(settings, /setProviderSendingEnabled/);
  assert.match(settings, /Deployment-owner controlled/);
  assert.match(settings, /send_enabled: !r\.send_enabled/);
  assert.match(settings, /Recipient-specific consent is still mandatory/);
});

test('account management SQL is organization-scoped and disconnect clears only selected credentials', () => {
  assert.match(migration, /a\.organization_id = v_org/);
  assert.match(migration, /credentials_ciphertext = ''/);
  assert.match(migration, /send_enabled = false/);
  assert.match(migration, /revoke all on function public\.intel_admin_disconnect_provider_account/);
});
