// Source-level guard for api.js (it imports the Supabase client, which the test runner can't load).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "api.js"), "utf8");

test("the feed only reads the signed-in user's own activity (ack/snooze reject anyone else's rows)", () => {
  const fetchPage = src.slice(src.indexOf("async fetchPage"), src.indexOf("async fetchStates"));
  assert.match(fetchPage, /\.from\("activity_log"\)[\s\S]*\.eq\("user_id", userId\)[\s\S]*\.in\("event_type"/);
});
