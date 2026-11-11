import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

test("forward sender-safety migration restores the PostgreSQL regex escape before the domain dot", () => {
  const corrective = read("supabase/migrations/20261224100000_email_crm_confirmed_production_bugfixes.sql");
  const expected = "v_addr !~ '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'";
  assert.ok(corrective.includes(expected), "the PostgreSQL regex must contain one escaped literal dot");
  assert.ok(!corrective.includes("\\\\."), "the PostgreSQL regex must not contain a doubled backslash before the dot");
});

test("forward migration reconciles structured CRM activities for relink and unlink", () => {
  const sql = read("supabase/migrations/20261224100000_email_crm_confirmed_production_bugfixes.sql");
  assert.match(sql, /alter table public\.email_crm_activities alter column lead_id drop not null/);
  assert.match(sql, /update public\.email_crm_activities a[\s\S]*set lead_id = c\.lead_id[\s\S]*left join public\.email_conversations c[\s\S]*a\.lead_id is distinct from c\.lead_id/);
  assert.match(sql, /update public\.email_crm_activities[\s\S]*set lead_id = v_lead[\s\S]*where message_id = m\.id[\s\S]*lead_id is distinct from v_lead/);
  assert.match(sql, /if v_lead is null then return; end if/);
  assert.match(sql, /security definer set search_path = pg_catalog, public/);
  assert.match(sql, /revoke all on function public\._email_sync_message_crm_timeline\(uuid\) from public, anon, authenticated/);
});


test("SQL regression fixtures cover valid sender registration and CRM activity relinking", () => {
  const senderTest = read("supabase/tests/email_sender_regex.test.sql");
  const activityTest = read("supabase/tests/email_crm_activity_relink.test.sql");
  assert.match(senderTest, /email_upsert_account\('Found-A@StudioKairegi\.com'/);
  assert.match(senderTest, /standard_conforming_strings=on/);
  assert.match(activityTest, /set lead_id = v_lead_b/);
  assert.match(activityTest, /set lead_id = null/);
  assert.match(activityTest, /set conversation_id = v_conv_b/);
  const runner = read("supabase/tests/run_intelligence_auth.sh");
  assert.match(runner, /email_sender_regex\.test\.sql/);
  assert.match(runner, /email_crm_activity_relink\.test\.sql/);
});
