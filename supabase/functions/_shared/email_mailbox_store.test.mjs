import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { makeMailboxSyncStore, saveEmailCredentials, loadEmailCredentials, loadSharedIntelligenceCredentials } from './email_mailbox_store.ts';
import { encryptText } from './crypto.ts';

globalThis.crypto ??= webcrypto;
const key = Buffer.alloc(32, 3).toString('base64');

function credentialService() {
  const state = { row: null, calls: [] };
  return {
    state,
    from(table) {
      assert.equal(table, 'email_provider_credentials');
      return {
        upsert: async (row) => { state.row = row; state.calls.push('upsert'); return { data: null, error: null }; },
        select: () => ({ eq: function () { return this; }, maybeSingle: async () => ({ data: state.row, error: null }) }),
      };
    },
  };
}

test('credential store persists only encrypted envelope fields and decrypts for exact account/provider', async () => {
  const service = credentialService();
  const credentials = { access_token: 'secret-access', refresh_token: 'secret-refresh' };
  await saveEmailCredentials(service, { accountId: 'a1', organizationId: 'o1', provider: 'zoho', credentials, encryptionKey: key, scopes: ['ZohoMail.messages.READ'] });
  assert.equal(service.state.row.provider_key, 'zoho');
  assert.equal(service.state.row.ciphertext.includes('secret-refresh'), false);
  assert.deepEqual(await loadEmailCredentials(service, { accountId: 'a1', organizationId: 'o1', provider: 'zoho', encryptionKey: key }), credentials);
});

test('mailbox sync store uses service RPCs for lease lifecycle', async () => {
  const calls = [];
  const service = { rpc: async (name, args) => {
    calls.push([name, args]);
    if (name === 'email_claim_sync') return { data: { claimed: true, lease_token: 'lease-1', checkpoint: { history: '1' } }, error: null };
    if (name === 'email_renew_sync' || name === 'email_commit_sync_checkpoint' || name === 'email_finish_sync') return { data: true, error: null };
    if (name === 'email_fail_sync') return { data: true, error: null };
    if (name === 'email_release_sync_ineligible') return { data: true, error: null };
    throw new Error(`unexpected RPC ${name}`);
  } };
  const store = makeMailboxSyncStore(service);
  assert.deepEqual(await store.claimSync('a1', 180), { claimed: true, leaseToken: 'lease-1', checkpoint: { history: '1' } });
  assert.equal(await store.renewSync('a1', 'lease-1', 180), true);
  assert.equal(await store.commitCheckpoint('a1', 'lease-1', { history: '2' }, 1, 3), true);
  assert.equal(await store.finishSync('a1', 'lease-1', { pages: 2, messages: 3, inserted: 2, updated: 1, partial: false }), true);
  await store.failSync('a1', 'lease-1', 'safe failure', new Date().toISOString());
  assert.equal(await store.releaseIneligibleSync('a1', 'lease-1'), true);
  assert.deepEqual(calls.map(([name]) => name), ['email_claim_sync', 'email_renew_sync', 'email_commit_sync_checkpoint', 'email_finish_sync', 'email_fail_sync', 'email_release_sync_ineligible']);
  assert.deepEqual(calls[5][1], { p_account_id: 'a1', p_lease_token: 'lease-1' });
});

test('mailbox persistence reconciles provider folder, deletion and update state for both directions', async () => {
  const calls = [];
  const service = { rpc: async (name, args) => {
    calls.push([name, args]);
    if (name === 'email_ingest_inbound' || name === 'email_ingest_synced_outbound') return { data: { message_id: `${args.p ? 'in' : 'out'}-message`, duplicate: false }, error: null };
    if (name === 'email_reconcile_synced_message_state') return { data: true, error: null };
    throw new Error(`unexpected RPC ${name}`);
  } };
  const store = makeMailboxSyncStore(service);
  const account = { id: 'a1', organization_id: 'o1', provider: 'zoho' };
  for (const direction of ['inbound', 'outbound']) {
    await store.persistMessage(account, {
      provider_message_id: `provider-${direction}`, direction, from_email: 'sender@example.com', to_emails: ['studio@example.com'],
      subject: 'Provider state', is_read: false, folder_ids: ['INBOX', 'Important'], is_deleted: direction === 'inbound',
      provider_updated_at: '2026-11-10T10:00:00.000Z',
    });
  }
  const reconciliations = calls.filter(([name]) => name === 'email_reconcile_synced_message_state').map(([, args]) => args);
  assert.equal(reconciliations.length, 2);
  assert.deepEqual(reconciliations.map((x) => x.p_direction), ['inbound', 'outbound']);
  assert.deepEqual(reconciliations[0].p_folder_ids, ['INBOX', 'Important']);
  assert.equal(reconciliations[0].p_is_deleted, true);
  assert.equal(reconciliations[1].p_is_deleted, false);
  assert.equal(reconciliations[0].p_provider, 'zoho');
});

test('mailbox persistence fails if provider state cannot be reconciled', async () => {
  const service = { rpc: async (name) => {
    if (name === 'email_ingest_inbound') return { data: { message_id: 'm1', duplicate: false }, error: null };
    if (name === 'email_reconcile_synced_message_state') return { data: false, error: null };
    throw new Error(`unexpected RPC ${name}`);
  } };
  const store = makeMailboxSyncStore(service);
  await assert.rejects(() => store.persistMessage({ id: 'a1', organization_id: 'o1', provider: 'zoho' }, {
    provider_message_id: 'provider-1', direction: 'inbound', from_email: 'sender@example.com', to_emails: [], subject: 'x', is_read: false,
  }), /could not be reconciled/);
});


test('shared Inbox credential lookup reads the same Intelligence account ID and decrypts only the authoritative ciphertext', async () => {
  const credentials = { refresh_token: 'intel-refresh-secret', data_center: 'eu' };
  const ciphertext = await encryptText(JSON.stringify(credentials), key);
  const state = { query: [] };
  const service = {
    from(table) {
      assert.equal(table, 'intel_provider_accounts');
      const query = {
        eq(column, value) { state.query.push([column, value]); return this; },
        async maybeSingle() {
          return { data: {
            id: 'same-account-id', organization_id: 'org-1', provider_key: 'zoho',
            credentials_ciphertext: ciphertext, status: 'connected', auth_method: 'oauth2', data_center: 'eu',
          }, error: null };
        },
      };
      return { select() { return query; } };
    },
  };
  const loaded = await loadSharedIntelligenceCredentials(service, {
    accountId: 'same-account-id', organizationId: 'org-1', provider: 'zoho', encryptionKey: key,
  });
  assert.deepEqual(loaded, credentials);
  assert.deepEqual(state.query, [
    ['id', 'same-account-id'], ['organization_id', 'org-1'], ['provider_key', 'zoho'],
  ]);
});

test('shared Inbox credential lookup fails closed for unreadable Intelligence ciphertext', async () => {
  const service = {
    from() {
      const query = { eq() { return this; }, async maybeSingle() {
        return { data: { id: 'a', organization_id: 'o', provider_key: 'gmail', credentials_ciphertext: 'not-valid', status: 'connected' }, error: null };
      } };
      return { select() { return query; } };
    },
  };
  await assert.rejects(() => loadSharedIntelligenceCredentials(service, {
    accountId: 'a', organizationId: 'o', provider: 'gmail', encryptionKey: key,
  }), /could not be decrypted/);
});
