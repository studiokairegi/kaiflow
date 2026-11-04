import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  CRM_BUCKETS, CRM_ORDER, MAX_ADOPT, awaitingAnswer, canAdopt, chatTurns, countAiGeneratedLeads, isAiGeneratedLead, toggleSelection, TOOL_LABEL, newClientKey,
} from "./logic.js";
import { intelApi } from "./api.js";

const sql = readFileSync(new URL("../../supabase/migrations/20261109140000_intelligence_v1_completion.sql", import.meta.url), "utf8");
const py = readFileSync(new URL("../../intelligence-worker/kairflow_intel/chat.py", import.meta.url), "utf8");
const strip = (s) => s.replace(/--.*$/gm, "");
const body = strip(sql);
const fns = body.split(/create or replace function public\./).slice(1).map((chunk) => ({ name: chunk.match(/^(\w+)\(/)[1], text: chunk }));

// ---- UI logic -----------------------------------------------------------------------------------------------------------
test("only contacted, un-replied, untracked leads can be selected, and never more than the cap", () => {
  const due = { lead_id: "a", bucket: "follow_up_due", tracked: false };
  assert.ok(canAdopt(due)); assert.ok(canAdopt({ ...due, bucket: "waiting" }));
  for (const bucket of ["replied", "do_not_contact", "no_email", "not_contacted", "needs_review"]) assert.ok(!canAdopt({ ...due, bucket }), bucket);
  assert.ok(!canAdopt({ ...due, tracked: true })); assert.ok(!canAdopt(null));
  assert.equal(toggleSelection(new Set(), { ...due, bucket: "replied" }).size, 0);
  let sel = new Set();
  for (let i = 0; i < 40; i++) sel = toggleSelection(sel, { ...due, lead_id: `l${i}` });
  assert.equal(sel.size, MAX_ADOPT);
  assert.equal(toggleSelection(sel, { ...due, lead_id: "l0" }).size, MAX_ADOPT - 1);   // unselect still works at the cap
});

test("every bucket the database can produce has a label, in a stable order", () => {
  const dbBuckets = [...body.matchAll(/then '(\w+)\|/g)].map((m) => m[1]);
  for (const b of new Set(dbBuckets)) assert.ok(CRM_BUCKETS[b], `no label for ${b}`);
  assert.deepEqual([...CRM_ORDER].sort(), Object.keys(CRM_BUCKETS).sort());
});

test("chat turns show user and assistant messages with the tools used, and detect a pending answer", () => {
  const msgs = [
    { id: 1, role: "user", content: "stats?" },
    { id: 2, role: "tool", tool_name: "stats", reply_to: 1 },
    { id: 3, role: "assistant", content: "12 replies", reply_to: 1, status: "done" },
    { id: 4, role: "user", content: "pause" },
  ];
  const turns = chatTurns(msgs);
  assert.deepEqual(turns.map((t) => t.role), ["user", "assistant", "user"]);
  assert.deepEqual(turns[1].tools, [TOOL_LABEL.stats]);
  assert.ok(awaitingAnswer(msgs)); assert.ok(!awaitingAnswer(msgs.slice(0, 3))); assert.ok(!awaitingAnswer([]));
  assert.equal(chatTurns([{ id: 9, role: "assistant", content: "x", reply_to: 5, status: "error" }])[0].error, true);
  assert.notEqual(newClientKey(), newClientKey());
});

test("AI Generated count and filter come only from the immutable source_kind", () => {
  const leads = [{ sourceKind: "ai_intelligence" }, { sourceKind: "manual" }, {}, { sourceKind: "AI_INTELLIGENCE" }];
  assert.equal(countAiGeneratedLeads(leads), 1); assert.ok(isAiGeneratedLead(leads[0])); assert.ok(!isAiGeneratedLead(leads[3]));
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(app, /aiGeneratedLeadsCount/); assert.match(app, /leadSourceFilter === "ai" && !isAiGeneratedLead\(l\)/);
  assert.match(app, /onGoToLeads\(\{ source: "ai" \}\)/);
});

test("the new API wrappers call only Intelligence functions and tables", async () => {
  const calls = [];
  const sb = { rpc: async (n, a) => { calls.push([n, a]); return { data: {}, error: null }; } };
  await intelApi.crmReview(sb); await intelApi.crmAdopt(sb, ["a"], "indie_game_developer"); await intelApi.chatNewThread(sb, "t"); await intelApi.chatSend(sb, "th", "hi", "k");
  assert.deepEqual(calls.map((c) => c[0]), ["intel_admin_crm_review", "intel_admin_crm_adopt", "intel_admin_chat_new_thread", "intel_admin_chat_send"]);
  assert.deepEqual(calls[3][1], { p_thread_id: "th", p_text: "hi", p_client_key: "k" });
});

// ---- SQL contract (static: the migration has not been executed in this environment) -------------------------------------------
test("every user-facing function in the V1 migration authorizes first; every agent function proves it is the agent", () => {
  const admin = fns.filter((f) => f.name.startsWith("intel_admin_")), agent = fns.filter((f) => f.name.startsWith("intel_agent_"));
  assert.ok(admin.length === 4 && agent.length >= 5, `${admin.length} admin / ${agent.length} agent`);
  for (const f of admin) assert.match(f.text, /public\.intel_admin_org\(\)/, f.name);
  for (const f of agent) assert.match(f.text, /public\.intel_agent_org\(\)/, f.name);
});

test("the duplicate lookup can no longer be pointed at another user's leads", () => {
  const f = fns.find((x) => x.name === "crm_find_lead_duplicates").text;
  assert.match(f, /auth\.uid\(\) is null or p_owner is null/);
  assert.match(f, /s\.owner_user_id = p_owner/); assert.match(f, /s\.agent_user_id = auth\.uid\(\) or public\.intel_is_authorized\(s\.organization_id\)/);
  assert.ok(!/intel_is_agent\(\)/.test(f), "no unscoped agent bypass");
});

test("the chat dispatcher re-checks the requester, enforces the allowlist and a call cap, and audits", () => {
  const f = fns.find((x) => x.name === "intel_agent_chat_tool").text;
  assert.match(f, /public\.intel_is_authorized_user\(t\.user_id, v_org\)/);
  assert.match(f, /not \(p_tool = any \(v_tools\)\)/); assert.match(f, /v_n >= 8/); assert.match(f, /'chat_tool'/);
  assert.match(f, /exception when others then\s+return public\._intel_deny/);
  // it can never reach email sending, approval, settings or suppressions
  for (const forbidden of [/intel_agent_reserve_send/, /intel_agent_confirm_send/, /intel_admin_review_message/, /intel_admin_update_settings/, /intel_admin_set_kill_switch/, /intel_suppressions/, /state = 'approved'/, /kill_switch = false/])
    assert.ok(!forbidden.test(f), `dispatcher must not touch ${forbidden}`);
});

test("SQL and Python agree on exactly which chat tools exist", () => {
  const sqlTools = [...body.match(/v_tools text\[\] := array\[([\s\S]*?)\];/)[1].matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();
  const pyTools = [...py.match(/TOOLS: dict[^=]*= \{([\s\S]*?)\n\}\n/)[1].matchAll(/^    "(\w+)":/gm)].map((m) => m[1]).sort();
  assert.deepEqual(pyTools, sqlTools);
  for (const t of sqlTools) assert.ok(body.includes(`p_tool = '${t}'`), `${t} has an implementation`);
});

test("adopted CRM leads always wait for approval, and adopting sends nothing", () => {
  const draft = fns.find((x) => x.name === "intel_agent_upsert_draft").text;
  assert.match(draft, /when p\.origin = 'crm_existing' then 'pending_approval'/);
  assert.ok(draft.indexOf("crm_existing") < draft.indexOf("s.autonomy = 'autonomous'"), "checked before any autonomy rule");
  const adopt = fns.find((x) => x.name === "_intel_crm_adopt").text;
  assert.match(adopt, /'follow_up_due', 'waiting'/); assert.match(adopt, /array_length\(v_ids, 1\) > 25/);
  assert.match(adopt, /'Imported from CRM history'/); assert.ok(!/state\) values|, 'approved'|'pending_approval'/.test(adopt.replace(/'sent'/g, "")), "creates no sendable message");
  assert.ok(!/update public\.leads/.test(adopt), "the lead row is untouched");
});

test("new tables are protected and the new client-callable surface is limited to intel_* functions", () => {
  assert.match(body, /alter table public\.intel_chat_threads enable row level security/);
  assert.match(body, /revoke all on public\.intel_chat_threads, public\.intel_chat_messages from public, anon, authenticated/);
  assert.ok(!/grant (insert|update|delete)[^;]*to authenticated/i.test(body));
  assert.match(body, /user_id = auth\.uid\(\) and public\.intel_is_authorized\(organization_id\)/);
  assert.match(body, /elsif r\.proname = 'intel_is_authorized_user'/);
  for (const f of fns.filter((x) => x.name.startsWith("_intel_"))) assert.ok(!/grant execute/.test(f.text));
});

test("migration order: Intelligence follows the newest pre-existing migration, strictly increasing, no duplicate timestamps", () => {
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  const names = readdirSync(dir).filter((n) => n.endsWith(".sql"));
  const stamp = (n) => n.split("_")[0];
  const intel = names.filter((n) => n.startsWith("20261109") && n.includes("_intelligence_")).sort();
  assert.equal(intel.length, 9);
  // The Resend email migration (20261110*) deliberately comes AFTER Intelligence: it extends it and is checked in src/email.
  const others = names.filter((n) => !n.includes("_intelligence_") && !n.includes("_email_resend_")).map(stamp).sort();
  assert.ok(stamp(intel[0]) > others[others.length - 1], "Intelligence migrations come after every other migration");
  assert.deepEqual(intel.map(stamp), [...new Set(intel.map(stamp))]);
  assert.deepEqual(intel.map((n) => n.replace(/^\d+_/, "")), ["intelligence_authorization.sql", "intelligence_core_tables.sql", "intelligence_crm_notifications.sql", "intelligence_rpcs.sql", "intelligence_zoho_oauth.sql", "intelligence_v1_completion.sql", "intelligence_gmail_provider.sql", "intelligence_chat_actions.sql", "intelligence_discovery.sql"]);
});
