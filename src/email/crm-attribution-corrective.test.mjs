import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const sql = fs.readFileSync(new URL("../../supabase/migrations/20261209100000_email_crm_conversation_attribution.sql", import.meta.url), "utf8");
const fn = sql.slice(sql.indexOf("create or replace function public.email_create_outbound"), sql.indexOf("revoke all on function public.email_create_outbound"));

test("outbound creation locks draft and conversation before resolving CRM attribution", () => {
  assert.match(fn, /from public\.email_messages[\s\S]*?for update/);
  assert.match(fn, /from public\.email_conversations[\s\S]*?for update/);
  assert.ok(fn.indexOf("for update") < fn.indexOf("v_fingerprint :="));
});

test("new and existing conversations persist one authoritative CRM lead", () => {
  assert.match(fn, /v_conv_lead is not null and v_lead is not null and v_conv_lead <> v_lead/);
  assert.match(fn, /update public\.email_conversations set lead_id = v_lead/);
  assert.match(fn, /normalized_subject, lead_id/);
  assert.match(fn, /crm_lead_id = v_lead/);
});

test("concurrent submissions serialize by organization-scoped idempotency key", () => {
  assert.match(fn, /pg_advisory_xact_lock\(hashtextextended\(v_org::text \\|\\|.*v_key/);
});

test("lead ownership is checked in the database after authoritative resolution", () => {
  assert.match(fn, /select user_id into v_lead_owner from public\.leads where id = v_lead for share/);
  assert.match(fn, /v_lead_owner is distinct from v_crm_user/);
  assert.match(sql, /grant execute on function public\.email_create_outbound\(jsonb\) to service_role/);
});

test("corrective migration is transactional and documents rollback", () => {
  assert.match(sql.trim(), /^--[\s\S]*?begin;/);
  assert.match(sql, /commit;/);
  assert.match(sql, /Rollback: restore public\.email_create_outbound/);
});
