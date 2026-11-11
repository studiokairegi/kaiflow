import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const migration = read("supabase/migrations/20261222100000_email_composer_send_crm_fixes.sql");

test("CRM lead association survives save, edit and later draft send", () => {
  const api = read("src/email/lib/api.js");
  const compose = read("src/email/components/ComposeDialog.jsx");
  const inbox = read("src/email/InboxModule.jsx");
  assert.match(api, /p_crm_lead_id: d\.crmLeadId \|\| null/);
  assert.match(compose, /crmLeadId: initial\.crmLeadId \|\| null/);
  assert.match(inbox, /crmLeadId: m\.crm_lead_id \|\| null/);
  assert.match(migration, /p_crm_lead_id uuid/);
  assert.match(migration, /crm_lead_id=v_lead/);
  assert.match(migration, /lead_id\)\s*values/);
});

test("queued retry claim is atomic and service-role only", () => {
  assert.match(migration, /update public\.email_messages set status='sending'[\s\S]*where id=p_message_id[\s\S]*status='queued'/);
  assert.match(migration, /grant execute on function public\.email_claim_outbound\(uuid,text\) to service_role/);
  assert.match(read("supabase/functions/_shared/email_resend_store.ts"), /rpc\("email_claim_outbound"/);
});

test("duplicate lookup precedes rate limiting and reply headers are excluded from immutable fingerprint", () => {
  const logic = read("supabase/functions/_shared/email_resend_logic.ts");
  assert.match(logic, /if \(created\.rate_limited\)/);
  const create = migration.slice(migration.indexOf("create or replace function public.email_create_outbound"), migration.indexOf("revoke all on function public.email_create_outbound"));
  const fingerprint = create.slice(create.indexOf("v_fingerprint :="), create.indexOf("if v_key is not null", create.indexOf("v_fingerprint :=")));
  assert.doesNotMatch(fingerprint, /in_reply_to|references_ids/);
  assert.ok(create.indexOf("if v_key is not null") < create.indexOf("-- Rate checks run only after the duplicate lookup"));
  assert.match(create, /Rate checks run only after the duplicate lookup/);
  assert.match(create, /pg_advisory_xact_lock\(hashtextextended\(v_org::text \|\| ':email-rate-limit'/);
  assert.match(create, /rate_limited', 'minute'/);
});

test("shared lead-linked conversations allow a colleague reply without taking CRM ownership", () => {
  const logic = read("supabase/functions/_shared/email_resend_logic.ts");
  assert.match(logic, /shared across the studio/);
  assert.match(migration, /v_lead_owner = nullif\(p ->> 'user_id'/);
  assert.match(migration, /if v_lead is null and v_conv_lead is not null then/);
});

test("CRM recovery is fair and permanently failing rows are bounded", () => {
  assert.match(migration, /crm_recovery_attempts integer not null default 0/);
  assert.match(migration, /crm_recovery_attempts < 10/);
  assert.match(migration, /order by m\.crm_recovery_last_attempt_at nulls first/);
  assert.match(migration, /for update skip locked/);
});

test("available sender is preferred for a new composer", () => {
  assert.match(read("src/email/components/ComposeDialog.jsx"), /accounts\.find\(\(a\) => accountCanSend\(a, providers\)\)/);
});

test("database integration runner applies the new migration and executes its regression SQL", () => {
  const runner = read("supabase/tests/run_intelligence_auth.sh");
  assert.match(runner, /20261222100000_email_composer_send_crm_fixes/);
  assert.match(runner, /email_composer_send_crm_fixes/);
  assert.ok(fs.existsSync(path.join(root, "supabase/tests/email_composer_send_crm_fixes.test.sql")));
});


test("ComposeDialog computes CRM link state before the aggregate problem reads it", () => {
  const compose = read("src/email/components/ComposeDialog.jsx");
  const crmProblem = compose.indexOf("const crmLinkProblem =");
  const aggregateProblem = compose.indexOf("const problem =");
  assert.ok(crmProblem >= 0 && aggregateProblem > crmProblem, "crmLinkProblem must be initialized before problem reads it");
  assert.match(compose, /const crmRecipientMatches[\s\S]*?const crmLeadLinkId[\s\S]*?const crmLinkProblem[\s\S]*?const problem/);
});
