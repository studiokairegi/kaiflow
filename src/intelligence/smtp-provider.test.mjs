import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const registry = fs.readFileSync(new URL('../../intelligence-worker/kairflow_intel/providers/registry.py', import.meta.url), 'utf8');
const smtpConnect = fs.readFileSync(new URL('../../supabase/functions/intel-provider-smtp-connect/index.ts', import.meta.url), 'utf8');
const smtpAdapter = fs.readFileSync(new URL('../../intelligence-worker/kairflow_intel/providers/smtp.py', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../../supabase/migrations/20261125100000_intelligence_smtp_adapter.sql', import.meta.url), 'utf8');

test('SMTP is a reviewed send-only installed adapter, not a database-executable plugin', () => {
  assert.match(registry, /provider_key="smtp"/);
  assert.match(registry, /create_smtp_adapter/);
  assert.match(smtpAdapter, /SMTP_SSL/);
  assert.match(smtpAdapter, /starttls/);
  assert.match(smtpAdapter, /_validate_public_host/);
  assert.doesNotMatch(smtpAdapter, /def\s+(?:iter_messages|list_messages|find_sent)\s*\(/);
});

test('SMTP credentials are admin-authenticated, encrypted and accounts start disabled', () => {
  assert.match(smtpConnect, /requireIntelligenceAdmin/);
  assert.match(smtpConnect, /encryptText/);
  assert.match(smtpConnect, /send_enabled:\s*false/);
  assert.match(smtpConnect, /is_enabled:\s*false/);
  assert.match(smtpConnect, /smtp_password/);
  assert.match(migration, /sending_enabled\)/);
  assert.match(migration, /true, false\)/);
});
