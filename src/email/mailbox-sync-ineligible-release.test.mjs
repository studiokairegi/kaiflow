import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const name = '20261229110000_email_mailbox_sync_ineligible_release.sql';
const migration = fs.readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8');
const staging = fs.readFileSync(new URL('../../supabase/verification/email_mailbox_sync_eligibility_staging.sql', import.meta.url), 'utf8');
const coordinator = fs.readFileSync(new URL('../../supabase/functions/_shared/email_mailbox_sync.ts', import.meta.url), 'utf8');
const executable = (s) => s.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
const sql = executable(migration);
const fnBody = sql.slice(sql.indexOf('function public.email_release_sync_ineligible'), sql.indexOf('$$;', sql.indexOf('function public.email_release_sync_ineligible') + 40));

test('Round 7.1 migration is additive, ordered after Round 7, transactional and documents rollback', () => {
  assert.match(sql.trim(), /^begin;/i);
  assert.match(sql.trim(), /commit;$/i);
  assert.match(migration, /Rollback:/i);
  assert.equal(/\b(delete\s+from|truncate|drop\s+table|drop\s+column)\b/i.test(sql), false);
  assert.ok(name > '20261229100000_email_mailbox_sync_eligibility.sql');
  const names = fs.readdirSync(new URL('../../supabase/migrations/', import.meta.url)).filter((n) => n.endsWith('.sql'));
  assert.equal(names.filter((n) => n.startsWith('20261229110000_')).length, 1);
  assert.match(sql, /to_regprocedure\('public\.email_mailbox_sync_account_eligible\(uuid\)'\)/i, 'requires Round 7 to be applied first');
});

test('release function never touches failure counters, retry time, error text, cursor or success time', () => {
  assert.match(fnBody, /set lease_token = null, lease_expires_at = null/i);
  for (const column of ['consecutive_failures', 'next_retry_at', 'last_error', 'cursor', 'last_success_at', 'last_attempt_at']) {
    assert.equal(new RegExp(`\\b${column}\\b\\s*=`, 'i').test(fnBody), false, `${column} must not be assigned`);
  }
});

test('release acts only for the token holder of a currently ineligible account', () => {
  assert.match(fnBody, /s\.lease_token = p_lease_token/i);
  assert.match(fnBody, /not public\.email_mailbox_sync_account_eligible\(s\.account_id\)/i);
  assert.match(fnBody, /security definer set search_path = pg_catalog, public/i);
  assert.match(sql, /revoke all on function public\.email_release_sync_ineligible\(uuid,uuid\) from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.email_release_sync_ineligible\(uuid,uuid\) to service_role/i);
});

test('release closes the run as skipped, an already allowed status, with no failure message', () => {
  assert.match(fnBody, /set status = 'skipped', finished_at = now\(\)/i);
  assert.equal(/safe_error\s*=/i.test(fnBody), false);
});

test('Round 7.1 does not replace email_fail_sync, which stays the genuine-failure path', () => {
  assert.equal(/function public\.email_fail_sync/i.test(sql), false);
});

test('coordinator consults the release path before recording any failure', () => {
  const catchStart = coordinator.indexOf('} catch (error) {');
  const release = coordinator.indexOf('store.releaseIneligibleSync', catchStart);
  const fail = coordinator.indexOf('store.failSync', catchStart);
  assert.ok(release > catchStart && fail > release, 'release check must precede failSync');
  assert.match(coordinator, /skip_reason: "account_ineligible"/);
});

test('staging gate covers every required truth-table scenario, is rollback-only and fails closed', () => {
  for (const label of [
    'Intelligence provider registry disabled', 'Email provider registry disabled', 'Intelligence account disabled',
    'Account disconnected via Intelligence status', 'Mailbox addresses mismatch', 'SMTP account -> ineligible',
    'Live lease -> not selectable', 'Expired lease -> selectable', 'Future retry time -> not selectable',
    'All eligibility gates satisfied -> eligible',
  ]) assert.ok(staging.includes(label), `staging script covers: ${label}`);
  assert.match(staging, /consecutive_failures preserved/);
  assert.match(staging, /no retry delay introduced/);
  assert.match(staging, /email_fail_sync still records genuine failures/);
  const trimmed = executable(staging).trim();
  assert.match(trimmed, /^begin;/i);
  assert.match(trimmed, /rollback;$/i);
  assert.equal(/\bcommit\b\s*;/i.test(trimmed), false, 'the gate must never commit');
  assert.match(staging, /raise exception 'STAGING GATE FAILED/);
});

const orphanName = '20261229120000_email_mailbox_sync_orphan_runs.sql';
const orphan = executable(fs.readFileSync(new URL(`../../supabase/migrations/${orphanName}`, import.meta.url), 'utf8'));
const claimBody = orphan.slice(orphan.indexOf('function public.email_claim_sync'), orphan.indexOf('$$;', orphan.indexOf('function public.email_claim_sync') + 40));

test('Round 7.2 migration replaces only email_claim_sync and keeps every Round 7 guard', () => {
  assert.match(orphan.trim(), /^begin;/i);
  assert.match(orphan.trim(), /commit;$/i);
  assert.equal((orphan.match(/create or replace function/gi) || []).length, 1);
  assert.equal(/\b(delete\s+from|truncate|drop\s+table|drop\s+column)\b/i.test(orphan), false);
  assert.match(claimBody, /email_mailbox_sync_account_eligible\(p_account_id\)/);
  assert.match(claimBody, /'account_ineligible'/);
  assert.match(claimBody, /'retry_not_due'/);
  assert.match(claimBody, /'sync_in_progress'/);
  assert.match(claimBody, /for update/i);
  assert.match(orphan, /revoke all on function public\.email_claim_sync\(uuid,integer\) from public, anon, authenticated/i);
  assert.match(orphan, /grant execute on function public\.email_claim_sync\(uuid,integer\) to service_role/i);
});

test('orphaned runs are closed only after the retry and live-lease guards, never touching failure counters', () => {
  const closeAt = claimBody.indexOf("set status='failed'");
  assert.ok(closeAt > claimBody.indexOf("'sync_in_progress'"), 'close orphans only after the live-lease guard');
  assert.match(claimBody, /status = 'running' and finished_at is null/);
  assert.equal(/consecutive_failures\s*=/.test(claimBody), false);
  assert.equal(/next_retry_at\s*=/.test(claimBody), false);
});

test('coordinator re-checks the lease before the page persistence loop', () => {
  const fetchAt = coordinator.indexOf('adapter.sync(context, account, checkpoint)');
  const recheck = coordinator.indexOf('Round 7.2', fetchAt);
  const persist = coordinator.indexOf('store.persistMessage', fetchAt);
  assert.ok(recheck > fetchAt && persist > recheck);
});
