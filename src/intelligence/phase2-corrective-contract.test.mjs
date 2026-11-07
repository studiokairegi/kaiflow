import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("Resend inbound webhook uses the documented shared secret name", () => {
  const src = read("../../supabase/functions/intel-resend-webhook/index.ts");
  assert.match(src, /Deno\.env\.get\("RESEND_WEBHOOK_SECRET"\)/);
  assert.doesNotMatch(src, /INTEL_RESEND_WEBHOOK_SECRET/);
});

test("Windows scheduled task uses the venv beside the worker package", () => {
  const src = read("../../intelligence-worker/windows/install-task.ps1");
  assert.match(src, /Join-Path \$PSScriptRoot "\.\.\\.venv\\Scripts\\python\.exe"/);
  assert.doesNotMatch(src, /ProgramData\\\\KairFlowIntelligence\\\\\.venv/);
});

test("Resend-only kill-switch migration preserves compliance and registered-agent gates without requiring a mailbox row", () => {
  const src = read("../../supabase/migrations/20261118090000_intelligence_resend_kill_switch.sql");
  assert.match(src, /intel_admin_org\(\)/);
  assert.match(src, /sender_email/); assert.match(src, /physical_address/); assert.match(src, /opt_out_text/);
  assert.match(src, /agent_user_id is null/);
  assert.doesNotMatch(src, /intel_mail_account/);
  assert.match(src, /kill_switch = p_on/);
  assert.match(src, /revoke all on function public\.intel_admin_set_kill_switch\(boolean\) from public, anon/);
});

test("mail status RPC failures are surfaced as check failures, not false disconnections", () => {
  const src = read("./IntelligenceModule.jsx");
  assert.match(src, /mail\.error \? \{/);
  assert.match(src, /status: "check_failed"/);
  assert.match(src, /mail=\{mailStatus\}/);
});
