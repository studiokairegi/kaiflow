import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { encryptEmailCredentials, decryptEmailCredentials } from './email_token_vault.ts';

globalThis.crypto ??= webcrypto;
const key = Buffer.alloc(32, 7).toString('base64');

test('credential envelope encrypts and decrypts with account/provider binding', async () => {
  const value = { access_token: 'access-secret', refresh_token: 'refresh-secret', expires_at: 1234 };
  const envelope = await encryptEmailCredentials(value, key, 'org-1/account-1/zoho');
  assert.equal(envelope.algorithm, 'A256GCM');
  assert.deepEqual(await decryptEmailCredentials(envelope, key, 'org-1/account-1/zoho'), value);
  assert.notEqual(envelope.ciphertext, JSON.stringify(value));
});

test('credential envelope rejects a different account binding', async () => {
  const envelope = await encryptEmailCredentials({ refresh_token: 'secret' }, key, 'org-1/account-1/gmail');
  await assert.rejects(() => decryptEmailCredentials(envelope, key, 'org-1/account-2/gmail'));
});

test('credential envelope rejects a wrong encryption key', async () => {
  const envelope = await encryptEmailCredentials({ refresh_token: 'secret' }, key, 'org-1/account-1/gmail');
  const otherKey = Buffer.alloc(32, 8).toString('base64');
  await assert.rejects(() => decryptEmailCredentials(envelope, otherKey, 'org-1/account-1/gmail'));
});

test('credential vault rejects malformed key length', async () => {
  await assert.rejects(() => encryptEmailCredentials({ token: 'x' }, Buffer.alloc(16).toString('base64'), 'a/b/c'), /exactly 32 bytes/);
});
