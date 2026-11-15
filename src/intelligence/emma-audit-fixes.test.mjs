import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { intelApi } from "./api.js";

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const sql = read("../../supabase/migrations/20270103100000_intelligence_emma_actions.sql");
const fn = (name) => sql.split(/create or replace function public\./).slice(1).map((c) => [c.match(/^(\w+)\(/)[1], c.split(/^end \$\$;/m)[0]]).find(([n]) => n === name)[1];

test("C1: send_email is refused while the emergency stop is on, at prepare and (through prepare) at claim", () => {
  const prep = fn("_intel_chat_prepare");
  const branch = prep.slice(prep.indexOf("elsif p_tool = 'send_email'"));
  assert.match(branch, /if s\.kill_switch then return jsonb_build_object\('ok', false, 'reason', 'sending_is_stopped_emergency_stop_is_on'\)/);
  assert.ok(branch.indexOf("s.kill_switch") < branch.indexOf("v_to :="), "checked before anything else");
  assert.match(fn("intel_admin_chat_claim"), /v_prep := public\._intel_chat_prepare\(v_org, x\.tool, x\.args\)/);
  assert.match(fn("intel_admin_chat_claim"), /if not coalesce\(\(v_prep ->> 'ok'\)::boolean, false\) then/);
});

test("C2/C7: sender name, send window, warm-up and limits are protected in the database", () => {
  const cat = fn("_intel_chat_category");
  for (const s of ["sender_name", "send_start_hour", "send_end_hour", "warmup_enabled", "daily_followup_cap", "timezone"]) assert.ok(cat.includes(`'${s}'`), s);
  assert.match(cat, /p_tool in \('update_limits', 'set_campaign_cap'\) then 'protected'/);
});

test("C9: the blanket grant loop never re-grants the two service-role-only functions", () => {
  const loop = sql.slice(sql.indexOf("-- 8. Grants"));
  assert.match(loop, /intel_resend_record_inbound', 'intel_agent_apply_delivery_event'\) then\s+execute format\('revoke all on function %s from authenticated'/);
});

test("C6: a database without the newer migrations does not blank the chat tab or loop the recovery call", async () => {
  const missing = { code: "42703", message: "column intel_chat_messages.ai_provider does not exist" };
  const seen = [];
  const q = (cols) => { const o = { select: (c) => { seen.push(c); return o; }, eq: () => o, order: () => o, limit: () => o,
    then: (ok) => ok(/ai_provider|category/.test(seen[seen.length - 1]) ? { data: null, error: missing } : { data: [{ id: 2 }, { id: 1 }], error: null }) }; return o; };
  const s = { from: () => q(), rpc: async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function public.intel_admin_chat_recover_stuck in the schema cache" } }) };
  assert.deepEqual((await intelApi.chatMessages(s, "t")).map((m) => m.id), [1, 2]);
  assert.deepEqual((await intelApi.chatActions(s, "t")).map((m) => m.id), [1, 2]);
  assert.deepEqual(await intelApi.chatRecoverStuck(s), { ok: false, unavailable: true });
  const boom = { rpc: async () => ({ data: null, error: { message: "network down" } }) };
  await assert.rejects(() => intelApi.chatRecoverStuck(boom), /network down/);
});

test("N5: stopped sending is explained in words and the claim leaves the card pending", async () => {
  const { friendlyError, resultLine } = await import("./emma.js");
  assert.match(friendlyError("no longer valid: sending_is_stopped_emergency_stop_is_on"), /emergency stop is on/);
  assert.match(friendlyError("sending_is_stopped"), /press Send again/);
  assert.equal(friendlyError("some_new_reason_code"), "Some new reason code.");
  assert.equal(friendlyError("Could not send: timeout"), "Could not send: timeout");
  assert.match(resultLine({ status: "failed", result: { error: "no longer valid: recipient_is_on_the_do_not_contact_list" } }), /do-not-contact/);
  const claim = fn("intel_admin_chat_claim");
  assert.match(claim, /x\.tool = 'send_email' and exists \(select 1 from public\.intel_settings s where s\.organization_id = v_org and s\.kill_switch\)[\s\S]*'status', 'pending', 'error', 'sending_is_stopped'/);
  assert.ok(claim.indexOf("sending_is_stopped") < claim.indexOf("_intel_chat_prepare"), "checked before the card is claimed or failed");
});

test("N6/N9: Confirm-all note names email; the reserved-tag filter catches a space before the slash", () => {
  assert.match(read("./ChatView.jsx"), /Skips emails and anything that always needs its own tap/);
  assert.match(fn("_intel_chat_prepare"), /\[\[:space:\]\]\*\/\?\[\[:space:\]\]\*\(approved_knowledge\|untrusted\)/);
});

test("N7: the qualification migration has balanced parentheses on the evidence check", () => {
  const sqlText = read("../../supabase/migrations/20261112200258_indie_project_qualification_v2.sql");
  const line = sqlText.split("\n").find((l) => l.includes("(anime|manga)')"));
  assert.ok(line.trim().endsWith("(anime|manga)') then"), line);
});
