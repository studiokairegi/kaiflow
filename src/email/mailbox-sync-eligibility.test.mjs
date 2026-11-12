import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const migrationName = '20261229100000_email_mailbox_sync_eligibility.sql';
const migration = fs.readFileSync(new URL(`../../supabase/migrations/${migrationName}`, import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../../supabase/functions/email-mailbox-sync/index.ts', import.meta.url), 'utf8');
const executable = (s) => s.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
const sql = executable(migration);

test('Round 7 migration is additive, transactional, and chronologically unique', () => {
  assert.match(sql.trim(), /^begin;/i);
  assert.match(sql.trim(), /commit;$/i);
  assert.equal((sql.match(/\$\$/g) || []).length % 2, 0);
  assert.match(migration, /Rollback:/i);
  assert.equal(/\b(delete\s+from|truncate|drop\s+table|drop\s+column)\b/i.test(sql), false);
  const names = fs.readdirSync(new URL('../../supabase/migrations/', import.meta.url)).filter((n) => n.endsWith('.sql'));
  assert.equal(names.filter((n) => n.startsWith('20261229100000_')).length, 1);
});

test('eligibility requires both account opt-in and both provider registries/capabilities', () => {
  assert.match(sql, /ia\.is_enabled\s+is\s+true/i);
  assert.match(sql, /ia\.status\s*=\s*'connected'/i);
  assert.match(sql, /ir\.enabled\s+is\s+true/i);
  assert.match(sql, /er\.enabled\s+is\s+true/i);
  assert.match(sql, /er\.capabilities\s+@>\s+'\{"remote_sync":true\}'::jsonb/i);
  assert.match(sql, /a\.source_provider_account_id\s+is\s+not\s+null/i);
  assert.match(sql, /a\.provider\s+in\s*\('gmail','zoho'\)/i);
  assert.match(sql, /lower\(btrim\(a\.address\)\)\s*=\s*lower\(btrim\(ia\.mailbox\)\)/i);
  assert.equal(/update\s+public\.email_provider_registry/i.test(sql), false, 'Round 7 must not enable a provider');
  assert.equal(/update\s+public\.intel_provider_accounts/i.test(sql), false, 'Round 7 must not opt accounts in');
});

test('account listing is bounded, deterministic, retry-aware, and excludes active leases', () => {
  assert.match(sql, /create or replace function public\.email_list_sync_accounts\(p_limit integer default 25\)/i);
  assert.match(sql, /public\.email_mailbox_sync_account_eligible\(a\.id\)/i);
  assert.match(sql, /s\.next_retry_at is null or s\.next_retry_at <= now\(\)/i);
  assert.match(sql, /s\.lease_expires_at is null or s\.lease_expires_at <= now\(\)/i);
  assert.match(sql, /order by coalesce\(s\.last_attempt_at, '-infinity'::timestamptz\), a\.id/i);
  assert.match(sql, /limit least\(greatest\(coalesce\(p_limit,25\),1\),25\)/i);
  assert.match(sql, /grant execute on function public\.email_list_sync_accounts\(integer\) to service_role/i);
  assert.match(sql, /revoke all on function public\.email_list_sync_accounts\(integer\) from public, anon, authenticated/i);
});

test('claim, heartbeat, checkpoint and finish all re-check current eligibility', () => {
  for (const fn of ['email_claim_sync', 'email_renew_sync', 'email_commit_sync_checkpoint', 'email_finish_sync']) {
    const start = sql.indexOf(`function public.${fn}`);
    assert.ok(start >= 0, `${fn} is replaced`);
    const next = sql.indexOf('$$;', start);
    const body = sql.slice(start, next);
    assert.match(body, /email_mailbox_sync_account_eligible/i, `${fn} must re-check eligibility`);
  }
  assert.match(sql, /'account_ineligible'/);
});

test('scheduled worker uses the authoritative SQL selector rather than listing all connected accounts', () => {
  assert.match(worker, /service\.rpc\("email_list_sync_accounts",\s*\{\s*p_limit:\s*limit\s*\}\)/);
  assert.doesNotMatch(worker, /from\("email_accounts"\)[\s\S]{0,300}\.eq\("status",\s*"active"\)/);
});
