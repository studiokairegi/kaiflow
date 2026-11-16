import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

const migration = read("../../supabase/migrations/20270101090000_intelligence_phase7_reply_approval_safety.sql");
const outreach = read("./OutreachView.jsx");

test("manual replies remain pending approval until an explicit review action", () => {
  assert.match(migration, /'pending_approval',\s*false/);
  assert.match(migration, /approval_required',\s*true/);
  assert.doesNotMatch(migration, /'approved'/);
});

test("manual reply RPC rejects closed or suppressed prospects and suppressed recipient addresses", () => {
  assert.match(migration, /p\.status in \('closed', 'suppressed'\)/);
  assert.match(migration, /x\.kind = 'email' and x\.value = v_to/);
  assert.match(migration, /x\.kind = 'domain' and split_part\(v_to, '@', 2\) = x\.value/);
  assert.match(migration, /recipient is suppressed; reply was not created/);
});

test("reply composer is hidden for terminal or opt-out conversations", () => {
  assert.match(outreach, /const replyBlocked = Boolean\(/);
  assert.match(outreach, /\['closed', 'suppressed'\]\.includes\(p\.status\)/);
  assert.match(outreach, /\['unsubscribe', 'complaint'\]\.includes\(m\.classification\)/);
  assert.match(outreach, /conv\.inbound && p && !replyBlocked/);
});
