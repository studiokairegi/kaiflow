import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const migration = read("../../supabase/migrations/20261112090000_email_resend_intelligence.sql");
const sendEdge = read("../../supabase/functions/intel-resend-send/index.ts");
const webhook = read("../../supabase/functions/intel-resend-webhook/index.ts");
const inboundLogic = read("../../supabase/functions/_shared/intel_resend_logic.ts");
const worker = read("../../intelligence-worker/kairflow_intel/resend.py");
const main = read("../../intelligence-worker/kairflow_intel/main.py");
const mailops = read("../../intelligence-worker/kairflow_intel/mailops.py");

test("Resend provider is opt-in and worker never receives a Resend API key", () => {
  assert.match(main, /cfg\.mail_provider == "resend"/);
  assert.match(read("../../intelligence-worker/kairflow_intel/config.py"), /mail_provider: str = "none"/);
  assert.doesNotMatch(worker, /RESEND_API_KEY/);
  assert.match(worker, /functions\/v1\/intel-resend-send/);
});

test("server-side send proxy loads only a database-authorized sending message and keeps kill-switch check", () => {
  assert.match(sendEdge, /intel_agent_resend_send_context/);
  assert.match(sendEdge, /RESEND_API_KEY/);
  assert.match(migration, /kill_switch is true[\s\S]*return false/);
  assert.match(migration, /state = 'sending'/);
  assert.match(migration, /intel_agent_record_resend_acceptance/);
  assert.match(migration, /add column if not exists provider_message_id/);
});

test("Resend inbound webhook verifies raw Svix signature and only routes exact Intelligence tokens", () => {
  assert.match(webhook, /verifySvixSignature/);
  assert.match(webhook, /event\?\.type !== "email\.received"/);
  assert.match(inboundLogic, /kf\[0-9a-f\]\{32\}/i);
  assert.match(webhook, /intel_resend_record_inbound/);
  assert.match(migration, /public\.intel_norm_email\(p\.contact_email\) = v_from/);
});

test("inbound storage and classification job are idempotent by Resend provider id", () => {
  assert.match(migration, /'in:resend:' \|\| p_provider_message_id/);
  assert.match(migration, /'classify:resend:' \|\| p_provider_message_id/);
  assert.match(migration, /on conflict \(organization_id, idempotency_key\) do nothing/);
});

test("Resend reconciliation never assumes a Sent folder or marks unknown absent", () => {
  assert.match(worker, /def find_sent[\s\S]*return None/);
  assert.match(worker, /def verify_sent/);
  assert.match(mailops, /provider_id = m\.get\("provider_message_id"\)/);
  assert.match(mailops, /elif getattr\(zoho, "provider", ""\) == "resend"/);
});
