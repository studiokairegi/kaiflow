import test from 'node:test';
import assert from 'node:assert/strict';
import { runMailboxSync, secretMatches } from './email_mailbox_sync_runner.ts';

const acct = (id, provider = 'zoho') => ({ id, organization_id: 'org', provider, address: `${id}@x.test`, display_name: id, status: 'active', connection_status: 'connected' });
const row = (provider) => ({ provider_key: provider, adapter_key: `${provider}_adapter`, display_name: provider, enabled: true, capabilities: { send: true, remote_sync: true } });
const adapter = (provider, sync) => ({ providerKey: provider, adapterKey: `${provider}_adapter`, displayName: provider, operations: sync ? ['send', 'sync'] : ['send'], legacyFlagKey: null, configurationProblem: () => null, send: async () => ({}), sync });
const store = (log) => ({
  async claimSync(id) { log.push(`claim:${id}`); return { claimed: true, leaseToken: 't', checkpoint: {} }; },
  async persistMessage() { return { inserted: true, updated: false }; },
  async renewSync() { return true; }, async commitCheckpoint() { return true; }, async finishSync() { return true; }, async failSync(id) { log.push(`fail:${id}`); },
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
