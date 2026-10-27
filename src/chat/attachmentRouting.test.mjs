import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../../', import.meta.url));

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

test("attachment selection is a non-submitting file input inside the composer", () => {
  const composer = read("Composer.jsx");
  assert.match(composer, /<form[^>]+onSubmit=\{\(event\) => \{ event\.preventDefault\(\)/);
  assert.match(composer, /<button type="button"[^>]+aria-label="Attach a file"/);
  assert.match(composer, /type="file"[^>]+multiple/);
  assert.doesNotMatch(composer, /location\.(reload|assign)|window\.location\.(reload|assign|replace)/);
});

test("internal chat attachment contents no longer use Supabase Storage", () => {
  const api = read("api.js");
  assert.doesNotMatch(api, /supabase\.storage/);
  assert.match(api, /functionUrl\("chat-attachments"\)/);
  assert.match(api, /action: "download"/);
});

test("portal chat attachment gateway uses Drive and never Supabase Storage", () => {
  const gateway = fs.readFileSync(path.join(here, "../../supabase/functions/portal-chat/index.ts"), "utf8");
  assert.doesNotMatch(gateway, /\.storage\.from\(/);
  assert.match(gateway, /uploadFileToDrive/);
  assert.match(gateway, /KairFlow/);
  assert.match(gateway, /Chat Attachments/);
  assert.match(gateway, /drive:\\\/\\\//);
});

test("internal chat gateway keeps Drive files private and streams authorized downloads", () => {
  const gateway = fs.readFileSync(path.join(here, "../../supabase/functions/chat-attachments/index.ts"), "utf8");
  assert.doesNotMatch(gateway, /\.storage\.from\(/);
  assert.match(gateway, /uploadFileToDrive\([\s\S]*false/);
  assert.match(gateway, /from\("chat_attachments"\)/);
  assert.match(gateway, /alt=media/);
  assert.match(gateway, /chat_can_read_conversation|from\("chat_conversations"\)/);
});

test("idle auto-refresh has no document navigation and cleans up its listeners", () => {
  const refresh = fs.readFileSync(path.join(here, "../autoRefresh.js"), "utf8");
  assert.doesNotMatch(refresh, /location\.(reload|assign|replace|href)/);
  assert.match(refresh, /clearIntervalFn\(timer\)/);
  assert.match(refresh, /removeEventListener/);
});
