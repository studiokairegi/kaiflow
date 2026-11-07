import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const baseMigration = readFileSync(new URL("../../supabase/migrations/20261119090000_intelligence_phase2_global_send_pacing.sql", import.meta.url), "utf8");
const enforcementMigration = readFileSync(new URL("../../supabase/migrations/20261120090000_intelligence_phase2_send_slot_enforcement.sql", import.meta.url), "utf8");
const migration = `${baseMigration}\n${enforcementMigration}`;
const worker = readFileSync(new URL("../../intelligence-worker/kairflow_intel/mailops.py", import.meta.url), "utf8");
const jobs = readFileSync(new URL("../../intelligence-worker/kairflow_intel/jobs.py", import.meta.url), "utf8");

test("global send pacing serializes on the organization settings row", () => {
  assert.match(migration, /add column if not exists send_slot_until timestamptz/);
  assert.match(migration, /add column if not exists send_slot_message_id uuid/);
  assert.match(migration, /intel_agent_org\(\)/);
  assert.match(migration, /from public\.intel_settings[\s\S]*?for update/);
  assert.match(migration, /v_gap_seconds := 45 \+ floor\(random\(\) \* 76\)::int/);
  assert.match(migration, /'send_spacing'[\s\S]*?'retry_after'/);
  assert.match(migration, /send_slot_message_id = p_message_id/);
});

test("the send-slot RPC and final sending transition both recheck the emergency stop", () => {
  assert.match(migration, /if s\.kill_switch then[\s\S]*?state = 'approved'[\s\S]*?send_slot_message_id = null[\s\S]*?return public\._intel_deny\('kill_switch'\)/);
  const finalMark = enforcementMigration.split("create or replace function public.intel_agent_mark_sending")[1];
  assert.match(finalMark, /if s\.kill_switch then[\s\S]*?state = 'approved'[\s\S]*?send_slot_message_id = null[\s\S]*?send_slot_until = null[\s\S]*?send_slot_message_id is distinct from p_message_id[\s\S]*?send_slot_until <= clock_timestamp\(\)[\s\S]*?set state = 'sending'/);
  assert.match(migration, /revoke all on function public\.intel_agent_acquire_send_slot\(uuid\) from public, anon/);
  assert.match(migration, /grant execute on function public\.intel_agent_acquire_send_slot\(uuid\) to authenticated/);
});

test("worker completes reply preflight before slot acquisition and keeps the final guard adjacent to send", () => {
  const parent = worker.indexOf("parent = parent_zoho_id(rpc, m)");
  const slot = worker.indexOf("intel_agent_acquire_send_slot");
  const sending = worker.indexOf("intel_agent_mark_sending");
  const provider = worker.indexOf("out = zoho.send(");
  assert.ok(parent >= 0 && slot > parent && sending > slot && provider > sending);
  assert.ok(provider - sending < 500, "no extra network preflight should be inserted between final DB guard and provider send");
  assert.match(jobs, /r\.get\("reason"\) == "send_spacing"[\s\S]*?_enq\(d, "send"/);
  assert.doesNotMatch(jobs, /_last_send/);
});


test("duplicate detection reads bounded persisted outbound history for the whole organization", () => {
  assert.match(migration, /create or replace function public\.intel_agent_recent_outbound\(p_limit int default 500\)/);
  assert.match(migration, /v_org uuid := public\.intel_agent_org\(\)/);
  assert.match(migration, /direction = 'outbound'[\s\S]*?created_at >= now\(\) - interval '180 days'/);
  assert.match(migration, /limit v_limit/);
  assert.match(migration, /revoke all on function public\.intel_agent_recent_outbound\(int\) from public, anon/);
  assert.match(migration, /grant execute on function public\.intel_agent_recent_outbound\(int\) to authenticated/);
  assert.match(jobs, /intel_agent_recent_outbound", \{\"p_limit\": 500\}\)/);
});


test("mark_sending enforces current slot ownership and an unexpired slot in the database", () => {
  const fn = enforcementMigration.split("create or replace function public.intel_agent_mark_sending")[1];
  assert.match(fn, /for update/);
  assert.match(fn, /send_slot_message_id is distinct from p_message_id/);
  assert.match(fn, /send_slot_until is null/);
  assert.match(fn, /send_slot_until <= clock_timestamp\(\)/);
  assert.match(fn, /send slot expired before provider submission/);
  assert.match(fn, /state = 'approved', send_day = null, reserved_at = null/);
  const acquire = enforcementMigration.split("create or replace function public.intel_agent_acquire_send_slot")[1].split("create or replace function public.intel_agent_mark_sending")[0];
  assert.match(acquire, /send_slot_until > clock_timestamp\(\)/);
  assert.match(acquire, /send_slot_until = clock_timestamp\(\) \+ make_interval/);
});
