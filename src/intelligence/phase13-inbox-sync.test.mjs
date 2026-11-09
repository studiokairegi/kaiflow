import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(path.join(root, p), "utf8");

test("multi-account inbound sync is account-scoped and agent-authorized", () => {
  const migration = read("supabase/migrations/20261203090000_intelligence_multi_account_inbox_sync.sql");
  assert.match(migration, /Apply the provider registry and Phase 10 schema-alignment migrations before Phase 13/);
  assert.match(migration, /public\.intel_agent_org\(\)/);
  assert.match(migration, /provider_key in \('gmail', 'zoho'\)/);
  assert.match(migration, /'receive_enabled', \(a\.status = 'connected' and a\.is_enabled is true and coalesce\(r\.enabled, false\)\)/);
  assert.match(migration, /a\.id = p_account_id/);
  assert.match(migration, /sync_cursor = p_set/);
  assert.match(migration, /revoke all on function public\.intel_agent_receive_sync_state\(uuid, jsonb\) from public, anon/);
  assert.match(migration, /grant execute on function public\.intel_agent_receive_accounts\(\) to authenticated/);
});

test("worker uses one cursor per mailbox and namespaces provider-local message ids", () => {
  const mailops = read("intelligence-worker/kairflow_intel/mailops.py");
  const jobs = read("intelligence-worker/kairflow_intel/jobs.py");
  assert.match(mailops, /receive_enabled.*False/);
  assert.match(mailops, /intel_agent_receive_sync_state/);
  assert.match(mailops, /in:\{provider_key\}:\{account_id\}:\{item\['id'\]\}/);
  assert.match(mailops, /router\.registry\.create/);
  assert.match(jobs, /mailops\.sync_provider_accounts/);
  assert.match(jobs, /SMTP is send-only/);
});
