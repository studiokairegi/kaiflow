import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const api = readFileSync(new URL('./lib/api.js', import.meta.url), 'utf8');
const inbox = readFileSync(new URL('./InboxModule.jsx', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../../supabase/migrations/20261111150000_email_inbox_account_provider_filters.sql', import.meta.url), 'utf8');

test('existing Inbox passes account and provider filters to its conversation query', () => {
  assert.match(api, /p_account_id:\s*accountId\s*\|\|\s*null/);
  assert.match(api, /p_provider:\s*provider\s*\|\|\s*null/);
  assert.match(inbox, /All accounts/);
  assert.match(inbox, /All providers/);
  assert.match(inbox, /setAccountFilter/);
  assert.match(inbox, /setProviderFilter/);
});

test('conversation filtering is organization-scoped and preserves the existing folder/search semantics', () => {
  assert.match(migration, /public\.email_require_access\(\)/);
  assert.match(migration, /c\.organization_id\s*=\s*v_org/);
  assert.match(migration, /c\.account_id\s*=\s*p_account_id/);
  assert.match(migration, /a\.provider\s*=\s*v_provider/);
  for (const folder of ['inbox', 'unread', 'sent', 'drafts', 'archived']) assert.ok(migration.includes(`when '${folder}'`));
});
