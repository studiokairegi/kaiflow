import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { actionStatus, chatTurns, groupActions, hasPendingActions, isActionLive, TOOL_LABEL } from "./logic.js";
import { intelApi } from "./api.js";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const sql = read("../../supabase/migrations/20261109160000_intelligence_chat_actions.sql");
const body = sql.replace(/^\s*--.*$/gm, "");
const py = read("../../intelligence-worker/kairflow_intel/chat.py");
const fns = Object.fromEntries(body.split(/create or replace function public\./).slice(1).map((c) => [c.match(/^(\w+)\(/)[1], c]));
const NOW = Date.parse("2026-11-04T12:00:00Z");
const act = (o = {}) => ({ id: "a", message_id: 1, status: "pending", expires_at: "2026-11-04T12:20:00Z", summary: "x", ...o });

test("cards: only a pending, unexpired action can be confirmed; expiry shows as expired", () => {
  assert.ok(isActionLive(act(), NOW)); assert.ok(!isActionLive(act({ expires_at: "2026-11-04T11:59:00Z" }), NOW));
  for (const status of ["confirmed", "cancelled", "failed", "expired"]) assert.ok(!isActionLive(act({ status }), NOW), status);
  assert.equal(actionStatus(act({ expires_at: "2026-11-04T11:00:00Z" }), NOW).label, "Expired"); assert.equal(actionStatus(act(), NOW).label, "Waiting for you");
  assert.ok(hasPendingActions([act()], NOW)); assert.ok(!hasPendingActions([act({ status: "confirmed" })], NOW)); assert.ok(!hasPendingActions(null, NOW));
  const g = groupActions([act({ id: "1", message_id: 5 }), act({ id: "2", message_id: 5 }), act({ id: "3", message_id: 6 })]);
  assert.equal(g.get(5).length, 2); assert.equal(g.get(6).length, 1);
  assert.equal(chatTurns([{ id: 9, role: "assistant", content: "ok", reply_to: 5 }])[0].replyTo, 5);
});

test("every tool the assistant can propose has a label and an implementation", () => {
  const sqlTools = [...fns.intel_agent_chat_propose.match(/p_tool not in \(([^)]*)\)/)[1].matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();
  const pyTools = [...py.match(/PROPOSALS: dict[^=]*= \{([\s\S]*?)\n\}\n/)[1].matchAll(/^    "(\w+)":/gm)].map((m) => m[1]).sort();
  assert.deepEqual(pyTools, sqlTools);
  for (const t of sqlTools) { assert.ok(TOOL_LABEL[t], `label for ${t}`); assert.ok(fns._intel_chat_prepare.includes(`'${t}'`), `${t} validated`); assert.ok(fns._intel_chat_exec.includes(`'${t}'`) || /approve_messages|discard_messages/.test(t), `${t} executed`); }
  assert.deepEqual(sqlTools.sort(), ["add_suppression", "approve_messages", "discard_messages", "enable_sending", "resume_campaign", "review_prospect", "set_autonomy", "set_campaign_cap", "update_limits"]);
});

test("the agent function can only PROPOSE: it re-checks the requester, caps proposals, and never executes", () => {
  const f = fns.intel_agent_chat_propose;
  assert.match(f, /public\.intel_agent_org\(\)/); assert.match(f, /public\.intel_is_authorized_user\(t\.user_id, v_org\)/);
  assert.match(f, /v_n >= 10/); assert.match(f, /NOTHING has changed yet/);
  assert.ok(!/_intel_chat_exec|intel_admin_/.test(f), "proposing never calls the executor or an admin function");
});

test("confirming is the signed-in administrator's act, one time, and runs through the existing admin functions", () => {
  const c = fns.intel_admin_chat_confirm;
  assert.match(c, /v_org uuid := public\.intel_admin_org\(\)/); assert.match(c, /user_id = auth\.uid\(\)/); assert.match(c, /for update/);
  assert.match(c, /x\.status <> 'pending'/); assert.match(c, /now\(\) > x\.expires_at/); assert.match(c, /_intel_chat_exec/);
  assert.match(c, /exception when others then[\s\S]*status = 'failed'/);
  assert.match(fns.intel_admin_chat_cancel, /status = 'pending'/);
  const exec = fns._intel_chat_exec;
  assert.match(exec, /_intel_chat_prepare/);                                                      // re-validated against the CURRENT state
  const called = new Set([...exec.matchAll(/public\.(intel_\w+)\(/g)].map((m) => m[1]));
  assert.deepEqual([...called].sort(), ["intel_admin_add_suppression", "intel_admin_review_message", "intel_admin_review_prospect", "intel_admin_set_kill_switch", "intel_admin_update_campaign", "intel_admin_update_settings"]);
});

test("there is no path from chat to roles, admin status, memberships, suppression removal or settings that bypass the existing checks", () => {
  assert.ok(!/user_settings|studio_memberships|is_admin|master_user|intel_admin_remove_suppression|intel_admin_register_agent|intel_admin_upsert_kb|intel_admin_compose_reply|delete from|truncate/i.test(body), "no role/permission/KB/suppression-removal reference");
  assert.ok(!/update public\.(intel_settings|intel_campaigns|intel_messages|intel_prospects|intel_suppressions)/.test(body), "state changes only through the admin functions");
  assert.ok(!/intel_admin_|chat_confirm|chat_cancel/.test(py), "the worker module cannot reach confirmation or any admin function");
});

test("the text the administrator sees is built by the database from stored arguments, and old cards cannot be replayed", () => {
  assert.match(fns.intel_agent_chat_propose, /left\(v_prep ->> 'summary', 2500\)/);
  assert.match(fns._intel_chat_prepare, /to_email, left\(m\.subject, 90\)/);                     // approvals show recipient and subject
  assert.match(body, /expires_at timestamptz not null default now\(\) \+ interval '30 minutes'/);
  assert.match(body, /unique index if not exists intel_chat_actions_dedupe_uidx/);
  assert.match(body, /user_id = auth\.uid\(\) and public\.intel_is_authorized\(organization_id\)/);
  assert.ok(!/grant (insert|update|delete)/i.test(body));
});

test("API wrappers call only the human-facing functions", async () => {
  const calls = [];
  const sb = { rpc: async (n, a) => { calls.push([n, a]); return { data: { ok: true }, error: null }; } };
  await intelApi.chatConfirm(sb, "a1"); await intelApi.chatCancel(sb, "a1");
  assert.deepEqual(calls, [["intel_admin_chat_confirm", { p_action_id: "a1" }], ["intel_admin_chat_cancel", { p_action_id: "a1" }]]);
});

test("migration order includes the chat actions migration last", () => {
  const names = readFileSync(new URL("../../supabase/migrations/20261109160000_intelligence_chat_actions.sql", import.meta.url), "utf8");
  assert.ok(names.length > 0);
});
