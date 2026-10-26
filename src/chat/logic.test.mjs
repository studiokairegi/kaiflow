import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_ATTACHMENT_TYPES,
  CHAT_PAGE_SIZE,
  MAX_MESSAGE_LENGTH,
  formatChatTime,
  groupReactions,
  mergeMessages,
  messageCursor,
  normalizeMessageBody,
  safeDisplayName,
  safeObjectFileName,
  sortMessagesAscending,
  unreadCountFromMessages,
  validateMessage,
} from './logic.js';

test('message normalization removes NULs, normalizes line endings and trims edges', () => {
  assert.equal(normalizeMessageBody('  hello\r\nworld\0  '), 'hello\nworld');
});

test('display names strip control characters and apply a bounded fallback', () => {
  assert.equal(safeDisplayName('  Ada\nLovelace\t'), 'Ada Lovelace');
  assert.equal(safeDisplayName('\u0000\u0001'), 'Team member');
  assert.equal(safeDisplayName('x'.repeat(100)).length, 80);
});

test('message validation rejects empty and oversized messages but allows attachment-only messages', () => {
  assert.deepEqual(validateMessage('  '), { ok: false, error: 'Write a message or attach a file.' });
  assert.equal(validateMessage('x'.repeat(MAX_MESSAGE_LENGTH + 1)).ok, false);
  assert.equal(validateMessage('', [{ size: 10, type: 'image/png', name: 'a.png' }]).ok, true);
  assert.equal(validateMessage('', [{ size: 0, type: 'image/png', name: 'empty.png' }]).ok, false);
  assert.equal(validateMessage('', [{ size: 1, type: 'application/x-msdownload', name: 'a.exe' }]).ok, false);
});

test('attachment allowlist and size bounds are intentional and enforced', () => {
  assert.equal(ALLOWED_ATTACHMENT_TYPES.has('application/pdf'), true);
  assert.equal(ALLOWED_ATTACHMENT_TYPES.has('application/x-msdownload'), false);
  assert.equal(validateMessage('hi', Array.from({ length: 11 }, () => ({ size: 1, type: 'text/plain', name: 'x.txt' }))).ok, false);
  assert.equal(validateMessage('hi', [{ size: 20 * 1024 * 1024 + 1, type: 'text/plain', name: 'x.txt' }]).ok, false);
});

test('message history sorts by timestamp and stable id while deduplicating repeated realtime events', () => {
  const older = { id: 'a', created_at: '2026-01-01T00:00:00Z', body: 'older' };
  const newer = { id: 'b', created_at: '2026-01-01T00:00:01Z', body: 'newer' };
  assert.deepEqual(sortMessagesAscending([newer, older]).map((x) => x.id), ['a', 'b']);
  assert.deepEqual(mergeMessages([older], [{ ...older, body: 'edited' }, newer]).map((x) => x.id), ['a', 'b']);
  assert.equal(mergeMessages([older], [{ ...older, body: 'edited' }])[0].body, 'edited');
});

test('unread count excludes own and deleted messages and respects timestamp/id read cursor', () => {
  const messages = [
    { id: 'a', sender_user_id: 'other', created_at: '2026-01-01T00:00:00Z' },
    { id: 'b', sender_user_id: 'other', created_at: '2026-01-01T00:00:00Z' },
    { id: 'c', sender_user_id: 'me', created_at: '2026-01-01T00:00:02Z' },
    { id: 'd', sender_user_id: 'other', created_at: '2026-01-01T00:00:03Z', deleted_at: '2026-01-01T00:00:04Z' },
    { id: 'e', sender_user_id: 'other', created_at: '2026-01-01T00:00:05Z' },
  ];
  assert.equal(unreadCountFromMessages(messages, 'me', '2026-01-01T00:00:00Z', 'a'), 2);
  assert.equal(unreadCountFromMessages(messages, 'me', '2026-01-01T00:00:04Z', 'd'), 1);
  assert.equal(unreadCountFromMessages(messages, 'me', null, null), 3);
});

test("reactions aggregate per emoji and flag the current user's reaction", () => {
  assert.deepEqual(groupReactions([
    { user_id: 'me', reaction: '👍' },
    { user_id: 'other', reaction: '👍' },
    { user_id: 'other', reaction: '❤️' },
  ], 'me'), [
    { reaction: '❤️', count: 1, reactedByMe: false, users: ['other'] },
    { reaction: '👍', count: 2, reactedByMe: true, users: ['me', 'other'] },
  ]);
});

test('attachment paths cannot preserve user-supplied directories', () => {
  assert.equal(safeObjectFileName('../../unsafe name.png'), 'unsafe_name.png');
  assert.equal(safeObjectFileName('C:\\Users\\Alice\\picture.webp'), 'picture.webp');
  assert.ok(messageCursor({ id: 'id', created_at: '2026-01-01T00:00:00Z' }));
  assert.equal(messageCursor({ id: 'id' }), null);
});

test('chat formatting and pagination defaults remain bounded', () => {
  assert.equal(CHAT_PAGE_SIZE, 50);
  assert.equal(formatChatTime('not-a-date'), '');
  assert.ok(formatChatTime('2026-01-01T00:00:00Z', Date.parse('2026-01-01T00:00:00Z')));
});


test('unread count does not suppress same-timestamp messages when the read cursor has no message ID', () => {
  const rows = [{ id: 'm-1', sender_user_id: 'other', created_at: '2026-10-24T10:00:00.000Z' }];
  assert.equal(unreadCountFromMessages(rows, 'me', '2026-10-24T10:00:00.000Z', null), 1);
});
