import test from 'node:test';
import assert from 'node:assert/strict';
import { synchronizeMailbox } from './email_mailbox_sync.ts';

const account = { id: 'account-1', organization_id: 'org-1', provider: 'zoho', address: 'studio@example.com', display_name: 'Studio', status: 'active', connection_status: 'connected' };
const context = { env: () => undefined, fetch: globalThis.fetch, now: () => 1_800_000_000_000, getCredentials: async () => ({ access_token: "test" }) };
const message = (id) => ({ provider_message_id: id, direction: 'inbound', from_email: 'client@example.com', to_emails: ['studio@example.com'], subject: 'Project', is_read: false });

function makeStore(overrides = {}) {
  const state = { checkpoint: { cursor: 'start' }, persisted: [], commits: [], failures: [] };
  return {
    state,
    async claimSync() { return { claimed: true, leaseToken: 'lease-1', checkpoint: state.checkpoint }; },
    async renewSync() { return true; },
    async persistMessage(_account, m) { state.persisted.push(m.provider_message_id); return { inserted: true, updated: false }; },
    async commitCheckpoint(_id, _lease, checkpoint) { state.commits.push(checkpoint); state.checkpoint = checkpoint; return true; },
    async finishSync() { return true; },
    async failSync(_id, _lease, error, retryAt) { state.failures.push({ error, retryAt }); },
    ...overrides,
  };
}

test('sync commits each checkpoint only after all page messages persist', async () => {
  const store = makeStore();
  let call = 0;
  const adapter = { providerKey: 'zoho', operations: ['sync'], async sync() { call++; return call === 1
    ? { messages: [message('m1'), message('m2')], next_checkpoint: { cursor: '2' }, has_more: true, complete: false }
    : { messages: [message('m3')], next_checkpoint: { cursor: '3' }, has_more: false, complete: true }; } };
  const result = await synchronizeMailbox({ account, adapter, context, store });
  assert.equal(result.ok, true);
  assert.equal(result.pages, 2);
  assert.deepEqual(store.state.persisted, ['m1', 'm2', 'm3']);
  assert.deepEqual(store.state.commits, [{ cursor: '2' }, { cursor: '3' }]);
  assert.equal(result.has_more, false);
});

test('sync does not commit a page checkpoint when a message persistence fails', async () => {
  const store = makeStore({ async persistMessage() { throw new Error('database write failed'); } });
  const adapter = { providerKey: 'zoho', operations: ['sync'], async sync() { return { messages: [message('m1')], next_checkpoint: { cursor: 'after-m1' }, has_more: false, complete: true }; } };
  const result = await synchronizeMailbox({ account, adapter, context, store });
  assert.equal(result.ok, false);
  assert.equal(result.checkpoint_committed, false);
  assert.deepEqual(store.state.commits, []);
  assert.equal(store.state.failures.length, 1);
  assert.equal(store.state.failures[0].error, 'Mailbox synchronization failed; retry is required');
});

test('sync refuses to run when adapter does not advertise sync', async () => {
  const adapter = { providerKey: 'resend', operations: ['send'] };
  await assert.rejects(() => synchronizeMailbox({ account: { ...account, provider: 'resend' }, adapter, context, store: makeStore() }), /does not support/);
});

test('sync collapses duplicate provider IDs within one page', async () => {
  const store = makeStore();
  const adapter = { providerKey: 'zoho', operations: ['sync'], async sync() { return { messages: [message('same'), message('same')], next_checkpoint: { cursor: 'x' }, has_more: false, complete: true }; } };
  const result = await synchronizeMailbox({ account, adapter, context, store });
  assert.equal(result.messages_seen, 1);
  assert.deepEqual(store.state.persisted, ['same']);
});


test('sync renews the lease before provider page fetches', async () => {
  let renewals = 0;
  const store = makeStore({ async renewSync() { renewals++; return true; } });
  const adapter = { providerKey: 'zoho', operations: ['sync'], async sync() { return { messages: [], next_checkpoint: { cursor: 'done' }, has_more: false, complete: true }; } };
  const result = await synchronizeMailbox({ account, adapter, context, store });
  assert.equal(result.status, 'completed');
  assert.equal(renewals, 1);
});

test('sync fails safely when lease renewal reports lease loss', async () => {
  const store = makeStore({ async renewSync() { return false; } });
  let fetched = false;
  const adapter = { providerKey: 'zoho', operations: ['sync'], async sync() { fetched = true; return { messages: [], next_checkpoint: {}, has_more: false, complete: true }; } };
  const result = await synchronizeMailbox({ account, adapter, context, store });
  assert.equal(result.status, 'failed');
  assert.equal(fetched, false);
  assert.equal(store.state.failures.length, 1);
});

test('a failure while recording a sync failure still returns a failed result', async () => {
  const store = makeStore({ async failSync() { throw new Error('database unavailable'); } });
  const adapter = { providerKey: 'zoho', operations: ['sync'], async sync() { throw new Error('boom'); } };
  const result = await synchronizeMailbox({ account, adapter, context, store });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
});
