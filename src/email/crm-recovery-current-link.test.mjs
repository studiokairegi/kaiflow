import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const migration = fs.readFileSync(new URL("../../supabase/migrations/20261225100000_email_crm_recovery_current_link.sql", import.meta.url), "utf8");
const sqlRegression = fs.readFileSync(new URL("../../supabase/tests/email_crm_activity_relink.test.sql", import.meta.url), "utf8");
const runner = fs.readFileSync(new URL("../../supabase/tests/run_intelligence_auth.sh", import.meta.url), "utf8");

test("delayed CRM activity recording resolves the conversation's current lead", () => {
  assert.match(migration, /select c\.lead_id into v_lead[\s\S]*?c\.organization_id = m\.organization_id[\s\S]*?for share;/);
  assert.match(migration, /if v_lead is null then[\s\S]*?reason', 'conversation_unlinked'/);
  assert.match(migration, /values \([\s\S]*?m\.id, m\.organization_id, v_lead,/);
  assert.match(migration, /where id = v_lead and user_id = m\.created_by/);
});

test("CRM recovery excludes unlinked conversations and retains service-role-only execution", () => {
  assert.match(migration, /join public\.email_conversations c[\s\S]*?c\.id = m\.conversation_id and c\.organization_id = m\.organization_id/);
  assert.match(migration, /and c\.lead_id is not null/);
  assert.match(migration, /v_result := public\.email_record_crm_activity\(v\.id\)/);
  assert.match(migration, /'skipped',v_skipped/);
  assert.match(migration, /for update of m skip locked/);
  assert.match(migration, /revoke all on function public\.email_recover_crm_activities\(integer\) from public, anon, authenticated;/);
  assert.match(migration, /grant execute on function public\.email_recover_crm_activities\(integer\) to service_role;/);
});

test("SQL regression fixture covers relink-before-recovery and unlink-before-recovery", () => {
  assert.match(sqlRegression, /Delayed relink recovery/);
  assert.match(sqlRegression, /delayed recovery did not use the conversation current lead after relink/);
  assert.match(sqlRegression, /Delayed unlink recovery/);
  assert.match(sqlRegression, /recovery recreated a CRM activity while the conversation was unlinked/);
  assert.match(sqlRegression, /did not record against the lead after a later relink/);
  assert.match(runner, /20261225100000_email_crm_recovery_current_link/);
  assert.match(runner, /email_crm_activity_relink\.test\.sql/);
});
