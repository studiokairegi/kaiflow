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

import { parseMessageBody, parseInline, safeHttpUrl, isGroupedWith, composerHeight, isNearBottom, chatErrorText, dayLabel } from "./logic.js";

test("message bodies become a safe tree: html stays text, only http(s) links become anchors", () => {
  const blocks = parseMessageBody('<img src=x onerror=alert(1)> see https://example.com/a?b=1, and javascript:alert(1)');
  const flat = JSON.stringify(blocks);
  assert.ok(flat.includes("<img src=x onerror=alert(1)>"), "markup is kept as literal text");
  const tokens = blocks[0].lines[0];
  assert.deepEqual(tokens.filter((t) => t.t === "link").map((t) => t.href), ["https://example.com/a?b=1"]);
  assert.equal(safeHttpUrl("javascript:alert(1)"), null);
  assert.equal(safeHttpUrl("data:text/html,hi"), null);
});

test("trailing punctuation is not part of a link and long URLs stay one token", () => {
  const long = `https://example.com/${"a".repeat(300)}`;
  const tokens = parseInline(`(${long}).`);
  assert.equal(tokens.filter((t) => t.t === "link").length, 1);
  assert.equal(tokens.find((t) => t.t === "link").v, long);
});

test("paragraphs, line breaks, lists and fenced code are preserved", () => {
  const blocks = parseMessageBody("First line\nsecond line\n\nNext paragraph\n- one\n- two\n1. a\n2. b\n```\nconst x = 1;\n```");
  assert.deepEqual(blocks.map((b) => b.type), ["p", "p", "ul", "ol", "code"]);
  assert.equal(blocks[0].lines.length, 2, "an intentional line break stays inside the paragraph");
  assert.equal(blocks[2].items.length, 2);
  assert.equal(blocks[4].text, "const x = 1;");
});

test("inline emphasis and code are recognized without swallowing snake_case words", () => {
  const types = parseInline("a **bold** and *it* and `code` and snake_case_word").map((t) => t.t);
  assert.deepEqual(types, ["text", "bold", "text", "em", "text", "code", "text"]);
  assert.equal(parseInline("snake_case_word").length, 1);
});

test("grouping, composer height, scroll proximity and day labels", () => {
  const a = { sender_user_id: "u1", created_at: "2026-10-27T08:00:00Z" };
  assert.equal(isGroupedWith(a, { sender_user_id: "u1", created_at: "2026-10-27T08:02:00Z" }), true);
  assert.equal(isGroupedWith(a, { sender_user_id: "u2", created_at: "2026-10-27T08:02:00Z" }), false);
  assert.equal(isGroupedWith(a, { sender_user_id: "u1", created_at: "2026-10-27T08:10:00Z" }), false);
  assert.equal(composerHeight(500), 160);
  assert.equal(composerHeight(10), 40);
  assert.equal(isNearBottom({ scrollHeight: 1000, scrollTop: 800, clientHeight: 150 }), true);
  assert.equal(isNearBottom({ scrollHeight: 1000, scrollTop: 100, clientHeight: 150 }), false);
  assert.equal(dayLabel("2026-10-27T08:00:00Z", Date.parse("2026-10-27T12:00:00Z")), "Today");
});

test("permission errors explain how to get access instead of showing database codes", () => {
  assert.match(chatErrorText({ message: "group_creation_not_permitted" }), /studio owner/);
  assert.match(chatErrorText({ message: "target_not_visible" }), /already chat with/);
});
