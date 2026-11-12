import test from 'node:test';
import assert from 'node:assert/strict';
import { runMailboxSync, secretMatches } from './email_mailbox_sync_runner.ts';

const acct = (id, provider = 'zoho') => ({ id, organization_id: 'org', provider, address: `${id}@x.test`, display_name: id, status: 'active', connection_status: 'connected' });
const row = (provider) => ({ provider_key: provider, adapter_key: `${provider}_adapter`, display_name: provider, enabled: true, capabilities: { send: true, remote_sync: true } });
const adapter = (provider, sync) => ({ providerKey: provider, adapterKey: `${provider}_adapter`, displayName: provider, operations: sync ? ['send', 'sync'] : ['send'], legacyFlagKey: null, configurationProblem: () => null, send: async () => ({}), sync });
const store = (log) => ({
  async claimSync(id) { log.push(`claim:${id}`); return { claimed: true, leaseToken: 't', checkpoint: {} }; },
  async persistMessage() { return { inserted: true, updated: false }; },
  async renewSync() { return true; }, async commitCheckpoint() { return true; }, async finishSync() { return true; }, async failSync(id) { log.push(`fail:${id}`); }, async releaseIneligibleSync(id) { log.push(`release:${id}`); return false; },
});
const ctx = { env: () => undefined, fetch: globalThis.fetch, now: () => 1_800_000_000_000, getCredentials: async () => ({ t: 1 }) };
const okSync = async () => ({ messages: [], next_checkpoint: {}, has_more: false, complete: true });

test('a failing account does not stop the others and unsupported providers are skipped', async () => {
  const log = [];
  const adapters = { zoho_adapter: adapter('zoho', okSync), gmail_adapter: adapter('gmail', async () => { throw new Error('revoked'); }), resend_adapter: adapter('resend', undefined) };
  const summary = await runMailboxSync({
    listAccounts: async () => [acct('bad', 'gmail'), acct('good', 'zoho'), acct('none', 'resend')],
    getRegistryRow: async (p) => (p === 'resend' ? { ...row('resend'), capabilities: { send: true } } : row(p)),
    makeContext: () => ctx, store: store(log), adapters,
  });
  assert.deepEqual([summary.synced, summary.failed, summary.skipped], [1, 1, 1]);
  assert.ok(log.includes('claim:good') && log.includes('fail:bad'));
});

test('an unregistered provider counts as failed, not as a crash', async () => {
  const summary = await runMailboxSync({ listAccounts: async () => [acct('x', 'imap')], getRegistryRow: async () => null, makeContext: () => ctx, store: store([]), adapters: {} });
  assert.equal(summary.failed, 1);
});

test('shared secret check is strict', () => {
  assert.equal(secretMatches('0123456789abcdef', '0123456789abcdef'), true);
  assert.equal(secretMatches('0123456789abcdef', '0123456789abcdeX'), false);
  assert.equal(secretMatches('', ''), false);
  assert.equal(secretMatches('short', 'short'), false);
  assert.equal(secretMatches('0123456789abcdef', null), false);
});

test('runner supplies a bounded per-account deadline to adapters', async () => {
  const seen = [];
  const ctx = { env: () => undefined, fetch: globalThis.fetch, now: () => Date.now() };
  const summary = await runMailboxSync({
    listAccounts: async () => [acct('deadline')],
    getRegistryRow: async () => row('zoho'),
    makeContext: () => ctx,
    store: store([]),
    adapters: { zoho_adapter: adapter('zoho', async (received) => {
      seen.push(received.deadlineAt);
      return okSync();
    }) },
  });
  assert.equal(summary.synced, 1);
  assert.equal(seen.length, 1);
  assert.ok(seen[0] >= Date.now() && seen[0] <= Date.now() + 40_000);
});


test("runner defers an account when fewer than five seconds remain in the run budget", async () => {
  const originalNow = Date.now;
  let calls = 0;
  Date.now = () => { calls++; return calls === 1 ? 0 : 96_000; };
  try {
    let registryLookups = 0;
    const summary = await runMailboxSync({
      listAccounts: async () => [acct('late')],
      getRegistryRow: async () => { registryLookups++; return row('zoho'); },
      makeContext: () => ctx, store: store([]), adapters: { zoho_adapter: adapter('zoho', okSync) },
    });
    assert.equal(summary.skipped, 1);
    assert.equal(summary.synced, 0);
    assert.equal(registryLookups, 0);
    assert.equal(summary.results[0].status, 'deferred:insufficient_run_budget');
  } finally { Date.now = originalNow; }
});


test('provider registry capability remains a second gate even if an account is returned', async () => {
  const log = [];
  const summary = await runMailboxSync({
    listAccounts: async () => [acct('gmail-disabled', 'gmail')],
    getRegistryRow: async () => ({ ...row('gmail'), capabilities: { send: true, remote_sync: false } }),
    makeContext: () => ctx, store: store(log),
    adapters: { gmail_adapter: adapter('gmail', okSync) },
  });
  assert.equal(summary.skipped, 1);
  assert.equal(summary.results[0].status, 'no_sync_capability');
  assert.deepEqual(log, [], 'an adapter without remote_sync must never claim a mailbox');
});

test('a mailbox that becomes ineligible loses its lease before adapter work and is not counted as a failure', async () => {
  const log = [];
  const unavailableStore = {
    ...store(log),
    async renewSync() { return false; },
    async releaseIneligibleSync(id) { log.push(`release:${id}`); return true; },
  };
  let providerCalls = 0;
  const summary = await runMailboxSync({
    listAccounts: async () => [acct('disabled-mid-run', 'zoho')],
    getRegistryRow: async () => row('zoho'),
    makeContext: () => ctx, store: unavailableStore,
    adapters: { zoho_adapter: adapter('zoho', async () => { providerCalls++; return okSync(); }) },
  });
  assert.equal(summary.failed, 0);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.results[0].status, 'skipped:account_ineligible');
  assert.equal(providerCalls, 0, 'provider work must stop when the eligibility-backed lease cannot renew');
  assert.ok(log.includes('release:disabled-mid-run'));
  assert.equal(log.includes('fail:disabled-mid-run'), false, 'eligibility loss must not record a failure');
});

test('a lease that cannot renew on a still-eligible mailbox remains a genuine failure', async () => {
  const log = [];
  const summary = await runMailboxSync({
    listAccounts: async () => [acct('lease-expired', 'zoho')],
    getRegistryRow: async () => row('zoho'),
    makeContext: () => ctx, store: { ...store(log), async renewSync() { return false; } },
    adapters: { zoho_adapter: adapter('zoho', okSync) },
  });
  assert.equal(summary.failed, 1);
  assert.ok(log.includes('fail:lease-expired'));
});
