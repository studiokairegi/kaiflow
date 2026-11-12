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
    async releaseIneligibleSync() { state.releases = (state.releases || 0) + 1; return false; },
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


test('sync renews the lease before the provider fetch and again before saving the page', async () => {
  let renewals = 0;
  const store = makeStore({ async renewSync() { renewals++; return true; } });
  const adapter = { providerKey: 'zoho', operations: ['sync'], async sync() { return { messages: [], next_checkpoint: { cursor: 'done' }, has_more: false, complete: true }; } };
  const result = await synchronizeMailbox({ account, adapter, context, store });
  assert.equal(result.status, 'completed');
  assert.equal(renewals, 2);
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


test('deadline before any messages are recovered records bounded backoff instead of silently appearing healthy', async () => {
  const store = makeStore();
  const adapter = { providerKey: 'zoho', operations: ['sync'], async sync() {
    const { AdapterError } = await import('./email_adapter.ts');
    throw new AdapterError('sync_deadline', 'budget exhausted', { provider: 'zoho', operation: 'sync' });
  } };
  const result = await synchronizeMailbox({ account, adapter, context: { ...context, deadlineAt: Date.now() - 1 }, store });
  assert.equal(result.status, 'failed');
  assert.equal(store.state.failures.length, 1);
  assert.equal(store.state.commits.length, 0);
});

test('unreadable credentials are handled after lease claim so normal backoff is recorded', async () => {
  const calls = [];
  const store = makeStore({
    async claimSync() { calls.push('claim'); return { claimed: true, leaseToken: 'lease-1', checkpoint: { cursor: 'safe' } }; },
    async failSync() { calls.push('fail'); },
  });
  const adapter = { providerKey: 'zoho', operations: ['sync'], async sync(ctx) { return await ctx.getProviderAccessToken(account, 'sync'); } };
  const ctx = { ...context, getCredentials: async () => { calls.push('legacy-preflight'); throw new Error('unreadable'); }, getProviderAccessToken: async () => { calls.push('token-gateway'); throw new Error('unreadable'); } };
  const result = await synchronizeMailbox({ account, adapter, context: ctx, store });
  assert.equal(result.status, 'failed');
  assert.deepEqual(calls, ['claim', 'token-gateway', 'fail']);
});


test("deadline-interrupted page commits an in-page resume cursor and safely completes on the next run", async () => {
  const store = makeStore({
    async persistMessage(_account, m) {
      const exists = this.state.persisted.includes(m.provider_message_id);
      if (!exists) this.state.persisted.push(m.provider_message_id);
      return exists ? { inserted: false, updated: true } : { inserted: true, updated: false };
    },
  });
  let calls = 0;
  const adapter = { providerKey: 'zoho', operations: ['sync'], async sync(_ctx, _account, checkpoint) {
    calls++;
    if (calls === 1) return { messages: [message('m1')], next_checkpoint: { cursor: 'same-page', offset: 1 }, has_more: true, complete: false, partial: true };
    assert.deepEqual(checkpoint, { cursor: 'same-page', offset: 1 });
    return { messages: [message('m2')], next_checkpoint: { cursor: 'next-page' }, has_more: false, complete: true };
  } };
  const first = await synchronizeMailbox({ account, adapter, context, store });
  assert.equal(first.status, 'partial');
  assert.deepEqual(store.state.persisted, ['m1']);
  assert.deepEqual(store.state.commits, [{ cursor: 'same-page', offset: 1 }]);
  assert.equal(store.state.failures.length, 0);
  const second = await synchronizeMailbox({ account, adapter, context, store });
  assert.equal(second.status, 'completed');
  assert.deepEqual(store.state.persisted, ['m1', 'm2']);
  assert.deepEqual(store.state.commits, [{ cursor: 'same-page', offset: 1 }, { cursor: 'next-page' }]);
});

test("partial page with no resumable progress enters bounded failure backoff", async () => {
  const store = makeStore();
  const adapter = { providerKey: 'gmail', operations: ['sync'], async sync() {
    return { messages: [], next_checkpoint: { cursor: 'start' }, has_more: true, complete: false, partial: true };
  } };
  const result = await synchronizeMailbox({ account, adapter, context, store });
  assert.equal(result.status, 'failed');
  assert.equal(store.state.commits.length, 0);
  assert.equal(store.state.failures.length, 1);
});

test("a 60-second page resumes after a 40-second budget and eventually commits the complete page", async () => {
  const store = makeStore({
    async persistMessage(_account, m) {
      const exists = this.state.persisted.includes(m.provider_message_id);
      if (!exists) this.state.persisted.push(m.provider_message_id);
      return exists ? { inserted: false, updated: true } : { inserted: true, updated: false };
    },
  });
  const ids = Array.from({ length: 100 }, (_, i) => `msg-${i + 1}`);
  const adapter = { providerKey: 'gmail', operations: ['sync'], async sync(_ctx, _account, checkpoint) {
    const offset = Number(checkpoint?.offset || 0);
    const budgetCapacity = 66;
    const end = Math.min(ids.length, offset + budgetCapacity);
    return {
      messages: ids.slice(offset, end).map(message),
      next_checkpoint: end < ids.length ? { cursor: 'page-1', offset: end } : { cursor: 'page-2' },
      has_more: end < ids.length,
      complete: end === ids.length,
      ...(end < ids.length ? { partial: true } : {}),
    };
  } };
  // The provider budget has elapsed by the time the adapter returns its bounded
  // partial response. Local persistence must still finish that response so its
  // provider-row offset can be committed safely.
  const expiredProviderBudget = { ...context, deadlineAt: context.now() + 1, now: () => context.now() + 2 };
  const first = await synchronizeMailbox({ account, adapter, context: expiredProviderBudget, store });
  assert.equal(first.status, 'partial');
  assert.equal(store.state.persisted.length, 66);
  assert.deepEqual(store.state.commits[0], { cursor: 'page-1', offset: 66 });
  const second = await synchronizeMailbox({ account, adapter, context, store });
  assert.equal(second.status, 'completed');
  assert.equal(store.state.persisted.length, 100);
  assert.equal(new Set(store.state.persisted).size, 100);
  assert.deepEqual(store.state.commits[1], { cursor: 'page-2' });
});


// Round 7.1: eligibility loss releases the lease without recording a provider failure.
const ineligibleStore = (overrides = {}) => makeStore({ async releaseIneligibleSync() { return true; }, ...overrides });
const okAdapter = (sync) => ({ providerKey: 'zoho', operations: ['sync'], sync });
const page = (cursor, more = false) => ({ messages: [message(`m-${cursor}`)], next_checkpoint: { cursor }, has_more: more, complete: !more });

test('lost eligibility at renewal releases without failure or backoff', async () => {
  const store = ineligibleStore({ async renewSync() { return false; } });
  let fetched = false;
  const result = await synchronizeMailbox({ account, adapter: okAdapter(async () => { fetched = true; return page('1'); }), context, store });
  assert.equal(result.status, 'skipped');
  assert.equal(result.skip_reason, 'account_ineligible');
  assert.equal(fetched, false, 'provider work must stop');
  assert.equal(store.state.failures.length, 0, 'no failure and no retry delay may be recorded');
});

test('lost eligibility at checkpoint commit releases without failure and does not advance the checkpoint', async () => {
  const store = ineligibleStore({ async commitCheckpoint() { return false; } });
  const result = await synchronizeMailbox({ account, adapter: okAdapter(async () => page('1')), context, store });
  assert.equal(result.status, 'skipped');
  assert.equal(result.skip_reason, 'account_ineligible');
  assert.equal(store.state.failures.length, 0);
  assert.deepEqual(store.state.checkpoint, { cursor: 'start' });
});

test('lost eligibility at partial-page checkpoint commit releases without failure', async () => {
  const store = ineligibleStore({ async commitCheckpoint() { return false; } });
  const partialPage = async () => ({ messages: [message('p1')], next_checkpoint: { cursor: 'mid' }, has_more: true, complete: false, partial: true });
  const result = await synchronizeMailbox({ account, adapter: okAdapter(partialPage), context, store });
  assert.equal(result.skip_reason, 'account_ineligible');
  assert.equal(store.state.failures.length, 0);
});

test('lost eligibility at finish releases without failure', async () => {
  const store = ineligibleStore({ async finishSync() { return false; } });
  const result = await synchronizeMailbox({ account, adapter: okAdapter(async () => page('1')), context, store });
  assert.equal(result.status, 'skipped');
  assert.equal(result.skip_reason, 'account_ineligible');
  assert.equal(store.state.failures.length, 0);
});

test('a provider error after the account was disabled is also not penalized', async () => {
  const store = ineligibleStore();
  const result = await synchronizeMailbox({ account, adapter: okAdapter(async () => { throw new Error('401 after disconnect'); }), context, store });
  assert.equal(result.status, 'skipped');
  assert.equal(store.state.failures.length, 0);
});

test('genuine lease loss on an eligible account still records a failure', async () => {
  const store = makeStore({ async renewSync() { return false; } });
  const result = await synchronizeMailbox({ account, adapter: okAdapter(async () => page('1')), context, store });
  assert.equal(result.status, 'failed');
  assert.equal(store.state.failures.length, 1);
  assert.equal(store.state.releases, 1, 'eligibility is asked exactly once before falling back to failure');
});

test('genuine provider failure on an eligible account still records a failure with backoff', async () => {
  const store = makeStore();
  const result = await synchronizeMailbox({ account, adapter: okAdapter(async () => { throw new Error('boom'); }), context, store });
  assert.equal(result.status, 'failed');
  assert.equal(store.state.failures.length, 1);
  assert.ok(Date.parse(store.state.failures[0].retryAt) > context.now());
});

test('if the ineligibility release itself fails the normal failure path still runs', async () => {
  const store = makeStore({ async releaseIneligibleSync() { throw new Error('database unavailable'); }, async renewSync() { return false; } });
  const result = await synchronizeMailbox({ account, adapter: okAdapter(async () => page('1')), context, store });
  assert.equal(result.status, 'failed');
  assert.equal(store.state.failures.length, 1);
});

// Round 7.2: nothing from a fetched page is saved once eligibility is lost during the provider request.
test('account disabled during the provider fetch saves nothing and is released without failure', async () => {
  let renewals = 0;
  const store = ineligibleStore({ async renewSync() { renewals++; return renewals === 1; } });
  const result = await synchronizeMailbox({ account, adapter: okAdapter(async () => page('1')), context, store });
  assert.equal(result.status, 'skipped');
  assert.equal(result.skip_reason, 'account_ineligible');
  assert.deepEqual(store.state.persisted, [], 'no message from the fetched page may be persisted');
  assert.equal(store.state.commits.length, 0);
  assert.equal(store.state.failures.length, 0);
});

test('genuine lease loss between fetch and save on an eligible account is a failure and saves nothing', async () => {
  let renewals = 0;
  const store = makeStore({ async renewSync() { renewals++; return renewals === 1; } });
  const result = await synchronizeMailbox({ account, adapter: okAdapter(async () => page('1')), context, store });
  assert.equal(result.status, 'failed');
  assert.deepEqual(store.state.persisted, []);
  assert.equal(store.state.failures.length, 1);
});
