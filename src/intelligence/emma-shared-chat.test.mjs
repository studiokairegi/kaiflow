import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const view = () => readFile(new URL("./ChatView.jsx", import.meta.url), "utf8");

test("Emma is built on the shared chat system", async () => {
  const src = await view();
  assert.match(src, /import "\.\.\/chat\/chat\.css"/);
  assert.match(src, /import MessageList from "\.\.\/chat\/MessageList\.jsx"/);
  assert.match(src, /import Composer from "\.\.\/chat\/Composer\.jsx"/);
  assert.match(src, /chat-root chat-theme-\$\{theme\}/);
});

test("loaded messages and actions are ignored when they belong to another thread", async () => {
  const src = await view();
  assert.match(src, /Object\.assign\(rows, \{ threadId: id \}\)/);
  assert.match(src, /const list = own\(msgs\.data\) \|\| \[\]/);
  assert.match(src, /groupActions\(actRows\)/);
});

test("a retry of the same message reuses its client key", async () => {
  const src = await view();
  assert.match(src, /pendingKey\.current\.key/);
  assert.match(src, /pendingKey\.current = null/);
  assert.doesNotMatch(src, /chatSend\([^\n]*newClientKey\(\)\)/);
});

test("New chat on a phone returns to the conversation even when the current chat is empty", async () => {
  assert.match(await view(), /onClick=\{\(\) => \{ setShowList\(false\); fresh\(\); \}\}/);
});

test("Confirm/Cancel does not spin the Send button", async () => {
  assert.match(await view(), /sending=\{sending\}/);
});

test("while Emma answers, a typing bubble with animated dots is shown (no 'Working on it')", async () => {
  const src = await view();
  assert.match(src, /typingStyle="bubble"/);
  assert.doesNotMatch(src, /Working on it/);
  const list = await readFile(new URL("../chat/MessageList.jsx", import.meta.url), "utf8");
  assert.match(list, /chat-typing-bubble/);
  assert.match(list, /chat-typing-dots/);
});

test("a failed load shows an error instead of loading forever", async () => {
  const src = await view();
  assert.match(src, /const loadError = msgs\.error \|\| acts\.error \|\| threads\.error/);
  assert.match(src, /Could not load the chat: \{loadError\}/);
  assert.match(src, /!own\(msgs\.data\) && !msgs\.error/);
});
