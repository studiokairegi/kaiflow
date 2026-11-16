import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TOOL_LABEL, ACTION_STATUS } from "./logic.js";
import { intelApi } from "./api.js";
import { DEFAULT_AUTHORITY, EMMA_CATEGORIES, authorityOf, autoRunQueue, canAutoRun, categoryOf, confirmAllCandidates, emailFields, executorOf, hasInFlight, pickSendAccount, resultLine, runEmmaAction } from "./emma.js";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const sql = read("../../supabase/migrations/20270103100000_intelligence_emma_actions.sql").replace(/^\s*--.*$/gm, "");
const fns = Object.fromEntries(sql.split(/create or replace function public\./).slice(1).map((c) => [c.match(/^(\w+)\(/)[1], c.split(/^end \$\$;/m)[0]]));
const py = read("../../intelligence-worker/kairflow_intel/chat.py");
const NOW = Date.parse("2026-11-13T12:00:00Z");
const act = (o = {}) => ({ id: "a", tool: "save_knowledge", args: {}, status: "pending", expires_at: "2026-11-13T12:20:00Z", ...o });
const ALL_AUTO = { knowledge: "auto", settings: "auto", messages: "auto", prospects: "auto", email: "auto" };

test("categories in the browser match the database function for every tool", () => {
  const dbCases = fns._intel_chat_category;
  for (const [tool, cat] of [["save_knowledge", "knowledge"], ["retire_knowledge", "knowledge"], ["update_limits", "protected"], ["set_campaign_cap", "protected"], ["approve_messages", "messages"], ["discard_messages", "messages"],
    ["edit_message", "messages"], ["review_prospect", "prospects"], ["resume_campaign", "prospects"], ["send_email", "email"], ["enable_sending", "protected"], ["set_autonomy", "protected"], ["add_suppression", "protected"], ["nonsense", "protected"]]) {
    assert.equal(categoryOf(tool), cat, tool);
    if (cat !== "protected") assert.match(dbCases, new RegExp(`'${tool}'[^\\n]*then '${cat}'|then '${cat}'`), tool);
  }
  for (const s of ["sender_name", "sender_email", "physical_address", "opt_out_text", "timezone", "send_start_hour", "send_end_hour", "send_weekdays_only", "warmup_enabled", "allow_cap_shift", "daily_followup_cap", "max_auto_replies_per_thread"]) { assert.equal(categoryOf("change_setting", { setting: s }), "protected"); assert.ok(dbCases.includes(`'${s}'`)); }
});

test("protected actions can never run by themselves, even if every category is auto", () => {
  for (const tool of ["enable_sending", "set_autonomy", "add_suppression"]) assert.equal(canAutoRun(act({ tool }), ALL_AUTO, NOW), false, tool);
  assert.equal(canAutoRun(act({ tool: "change_setting", args: { setting: "sender_email" } }), ALL_AUTO, NOW), false);
  for (const setting of ["timezone", "sender_name", "warmup_enabled", "send_start_hour", "daily_followup_cap"]) assert.equal(canAutoRun(act({ tool: "change_setting", args: { setting } }), ALL_AUTO, NOW), false, setting);
  for (const tool of ["update_limits", "set_campaign_cap"]) assert.equal(canAutoRun(act({ tool }), ALL_AUTO, NOW), false, tool);
  assert.equal(canAutoRun({ ...act({ tool: "enable_sending" }), category: "knowledge" }, ALL_AUTO, NOW), false, "a wrong stored category cannot unlock a protected tool");
  assert.ok(!EMMA_CATEGORIES.some((c) => c.key === "protected"));
  assert.match(fns._intel_chat_may_auto, /p_category in \('knowledge', 'settings', 'messages', 'prospects', 'email'\)/);
  assert.match(fns.intel_admin_set_emma_authority, /k not in \('knowledge', 'settings', 'messages', 'prospects', 'email'\)/);
});

test("permissions: defaults, merge, and anything but 'auto' means ask", () => {
  assert.deepEqual(authorityOf(null), DEFAULT_AUTHORITY);
  assert.equal(authorityOf({ emma_authority: { email: "auto", messages: "yes", knowledge: "ask" } }).email, "auto");
  assert.equal(authorityOf({ emma_authority: { messages: "yes" } }).messages, "ask");
  assert.equal(authorityOf({ emma_authority: { knowledge: "ask" } }).knowledge, "ask");
  assert.equal(DEFAULT_AUTHORITY.email, "ask"); assert.equal(DEFAULT_AUTHORITY.messages, "ask");
  assert.match(sql, /emma_authority jsonb not null default '\{"knowledge": "ask", "settings": "ask"\}'/);
  assert.ok(Object.values(authorityOf(null)).every((v) => v === "ask"), "a fresh install auto-runs nothing");
});

test("only live, allowed, NEW cards run by themselves; old pending cards wait for a tap", () => {
  const a = act({ id: "new" }); const old = act({ id: "old" });
  const q = autoRunQueue([a, old], ALL_AUTO, new Set(["old"]), new Set(), NOW);
  assert.deepEqual(q.map((x) => x.id), ["new"]);
  assert.deepEqual(autoRunQueue([a], ALL_AUTO, new Set(), new Set(["new"]), NOW), [], "never twice");
  assert.deepEqual(autoRunQueue([a], { ...ALL_AUTO, knowledge: "ask" }, new Set(), new Set(), NOW), []);
  assert.deepEqual(autoRunQueue([act({ expires_at: "2026-11-13T11:00:00Z" })], ALL_AUTO, new Set(), new Set(), NOW), []);
  assert.deepEqual(autoRunQueue([act({ status: "running" }), act({ id: "b", status: "confirmed" })], ALL_AUTO, new Set(), new Set(), NOW), []);
});

test("confirm-all skips protected cards and outgoing email; polling stays quick while something runs", () => {
  const cards = [act({ id: "1" }), act({ id: "2", tool: "enable_sending" }), act({ id: "3", tool: "send_email" }), act({ id: "4", status: "cancelled" })];
  assert.deepEqual(confirmAllCandidates(cards, NOW).map((c) => c.id), ["1"], "an email card needs its own tap");
  assert.ok(hasInFlight([act({ status: "running" })], NOW)); assert.ok(!hasInFlight([act({ status: "confirmed" })], NOW));
  assert.equal(ACTION_STATUS.running.label, "Working");
});

test("every new tool has a label; the browser runs only email", () => {
  for (const t of ["settings_overview", "knowledge_list", "knowledge_get", "list_drafts", "check_recipient", "save_knowledge", "retire_knowledge", "change_setting", "edit_message", "send_email"]) assert.ok(TOOL_LABEL[t], t);
  assert.equal(executorOf("send_email"), "browser");
  for (const t of ["save_knowledge", "change_setting", "approve_messages", "edit_message"]) assert.equal(executorOf(t), "database");
  assert.match(fns._intel_chat_executor, /p_tool = 'send_email' then 'browser'/);
});

test("pickSendAccount prefers Zoho, then the default, and never an account that cannot send", () => {
  const providers = [{ provider_key: "zoho", enabled: true, capabilities: { send: true, oauth: true } }, { provider_key: "gmail", enabled: true, capabilities: { send: true, oauth: true } }];
  const acct = (id, provider, o = {}) => ({ id, provider, status: "active", connection_status: "connected", ...o });
  assert.equal(pickSendAccount([acct("g", "gmail", { is_default: true }), acct("z", "zoho")], providers).id, "z");
  assert.equal(pickSendAccount([acct("g", "gmail", { is_default: true }), acct("g2", "gmail")], providers).id, "g");
  assert.equal(pickSendAccount([acct("z", "zoho", { connection_status: "disconnected" }), acct("g", "gmail")], providers).id, "g");
  assert.equal(pickSendAccount([acct("z", "zoho", { status: "paused" })], providers), null);
  assert.equal(pickSendAccount(null, providers), null);
});

const apiFake = (over = {}) => {
  const calls = [];
  return { calls, chatConfirm: async (...a) => { calls.push(["confirm", a[1], a[2]]); return over.confirm ?? { ok: true, status: "confirmed" }; },
    chatClaim: async (...a) => { calls.push(["claim", a[1], a[2]]); return over.claim ?? { ok: true, status: "running", args: { to: "jane@pixelmoon.jp", subject: "Thanks", body: "Hi Jane,\n\nThanks." } }; },
    chatFinish: async (_s, id, ok, r) => { calls.push(["finish", id, ok, r]); } };
};
const sender = { id: "acc-1", address: "studio@x.com" };

test("database actions run through confirm, pass the auto flag, and report refusals", async () => {
  const api = apiFake();
  await runEmmaAction({ supabase: {}, action: act({ id: "k1" }), auto: true, sender, api, mail: {} });
  assert.deepEqual(api.calls, [["confirm", "k1", true]]);
  const refused = apiFake({ confirm: { ok: false, status: "pending", error: "auto_not_allowed" } });
  assert.deepEqual(await runEmmaAction({ supabase: {}, action: act(), auto: true, sender, api: refused, mail: {} }), { skipped: true });
  await assert.rejects(runEmmaAction({ supabase: {}, action: act(), api: apiFake({ confirm: { ok: false, status: "failed", error: "no longer valid: x" } }), mail: {} }), /no longer valid/);
  await assert.rejects(runEmmaAction({ supabase: {}, action: act(), api: apiFake({ confirm: { ok: false, status: "expired" } }), mail: {} }), /expired/);
});

test("email: claimed once, sent with a key derived from the card, then reported", async () => {
  const api = apiFake(); const sent = [];
  const mail = { send: async (_s, m) => { sent.push(m); return { ok: true, message_id: "m1" }; } };
  const out = await runEmmaAction({ supabase: {}, action: act({ id: "e1", tool: "send_email" }), sender, api, mail });
  assert.deepEqual(out, { ok: true, sent: true });
  assert.deepEqual(api.calls.map((c) => c[0]), ["claim", "finish"]);
  assert.equal(sent.length, 1); assert.equal(sent[0].key, "emma-e1"); assert.deepEqual(sent[0].to, ["jane@pixelmoon.jp"]); assert.deepEqual(sent[0].cc, []);
  assert.equal(sent[0].accountId, "acc-1"); assert.equal(sent[0].crmLeadId, null); assert.match(sent[0].html, /Hi Jane/);
  assert.equal(api.calls[1][2], true); assert.equal(api.calls[1][3].edited, false); assert.equal(api.calls[1][3].message_id, "m1");
});

test("email: the administrator's edit is what is sent; the recipient cannot be edited", async () => {
  const api = apiFake(); const sent = [];
  const mail = { send: async (_s, m) => { sent.push(m); return { ok: true }; } };
  await runEmmaAction({ supabase: {}, action: act({ id: "e2", tool: "send_email" }), edits: { subject: " New subject ", body: "Shorter.", to: "attacker@x.com" }, sender, api, mail });
  assert.equal(sent[0].subject, "New subject"); assert.equal(sent[0].text, "Shorter."); assert.deepEqual(sent[0].to, ["jane@pixelmoon.jp"]);
  assert.equal(api.calls[1][3].edited, true);
});

test("email: a failed send is reported as failed, never as done; nothing is sent without an account or a claim", async () => {
  const api = apiFake();
  const boom = { send: async () => { const e = new Error("Provider said no"); e.outcome = "rejected"; throw e; } };
  await assert.rejects(runEmmaAction({ supabase: {}, action: act({ id: "e3", tool: "send_email" }), sender, api, mail: boom }), /Provider said no/);
  const fin = api.calls.find((c) => c[0] === "finish"); assert.equal(fin[2], false); assert.equal(fin[3].outcome, "rejected");
  const none = apiFake(); let called = false;
  await assert.rejects(runEmmaAction({ supabase: {}, action: act({ tool: "send_email" }), sender: null, api: none, mail: { send: async () => { called = true; } } }), /No connected sending account/);
  assert.deepEqual(none.calls, []); assert.equal(called, false, "no claim, so no send");
  for (const claim of [{ ok: false, status: "running" }, { ok: false, status: "expired" }, { ok: false, status: "failed", error: "no longer valid: recipient_is_on_the_do_not_contact_list" }]) {
    called = false;
    await assert.rejects(runEmmaAction({ supabase: {}, action: act({ tool: "send_email" }), sender, api: apiFake({ claim }), mail: { send: async () => { called = true; } } }));
    assert.equal(called, false);
  }
  const bad = apiFake({ claim: { ok: true, args: { to: "jane@pixelmoon.jp", subject: "", body: "x" } } }); called = false;
  await assert.rejects(runEmmaAction({ supabase: {}, action: act({ tool: "send_email" }), sender, api: bad, mail: { send: async () => { called = true; } } }), /subject/i);
  assert.equal(called, false);
});

test("email: a sent-but-bookkeeping warning still counts as sent and says so", async () => {
  const api = apiFake();
  await runEmmaAction({ supabase: {}, action: act({ tool: "send_email" }), sender, api, mail: { send: async () => ({ ok: true, warning: "crm_activity_pending" }) } });
  const fin = api.calls.find((c) => c[0] === "finish"); assert.equal(fin[2], true); assert.match(fin[3].note, /Sent/);
});

test("card text", () => {
  assert.deepEqual(emailFields(act({ args: { to: "a@b.co", subject: "S", body: "B" } })), { to: "a@b.co", subject: "S", body: "B" });
  assert.match(resultLine(act({ status: "confirmed", tool: "send_email", auto: true, result: { edited: true } })), /Done automatically: email sent.*edited/);
  assert.match(resultLine(act({ status: "failed", result: { error: "boom" } })), /boom/);
  assert.equal(resultLine(act({ status: "pending" })), "");
});

test("API wrappers use only human-facing functions and pass the auto flag", async () => {
  const calls = []; const sb = { rpc: async (n, a) => { calls.push([n, a]); return { data: { ok: true }, error: null }; } };
  await intelApi.chatConfirm(sb, "a", true); await intelApi.chatClaim(sb, "a"); await intelApi.chatFinish(sb, "a", true, { message_id: "m" }); await intelApi.setEmmaAuthority(sb, { email: "auto" });
  assert.deepEqual(calls, [["intel_admin_chat_confirm", { p_action_id: "a", p_auto: true }], ["intel_admin_chat_claim", { p_action_id: "a", p_auto: false }],
    ["intel_admin_chat_finish", { p_action_id: "a", p_ok: true, p_result: { message_id: "m" } }], ["intel_admin_set_emma_authority", { p_patch: { email: "auto" } }]]);
});

test("SQL: execution stays with the signed-in administrator; the worker can only propose or read", () => {
  for (const f of ["intel_admin_chat_confirm", "intel_admin_chat_claim", "intel_admin_chat_finish", "intel_admin_set_emma_authority"]) {
    assert.match(fns[f], /public\.intel_admin_org\(\)/, f);
  }
  for (const f of ["intel_admin_chat_confirm", "intel_admin_chat_claim", "intel_admin_chat_finish"]) assert.match(fns[f], /user_id = auth\.uid\(\)[^;]*for update/, f);
  for (const f of ["intel_agent_chat_propose", "intel_agent_chat_read"]) {
    assert.match(fns[f], /public\.intel_agent_org\(\)/); assert.match(fns[f], /public\.intel_is_authorized_user\(t\.user_id, v_org\)/);
    assert.ok(!/_intel_chat_exec|intel_admin_|update public\.|delete from|insert into public\.intel_(settings|kb|messages|suppressions)/.test(fns[f]), `${f} changes nothing`);
  }
  assert.match(fns.intel_agent_chat_propose, /NOTHING has changed yet/);
  assert.ok(!/intel_admin_|chat_confirm|chat_claim|chat_finish|_exec/.test(py), "the worker module cannot reach any of them");
});

test("SQL: one claim means one send; auto needs the category; a stale card is re-validated", () => {
  const c = fns.intel_admin_chat_claim;
  assert.match(c, /x\.status <> 'pending' then return/); assert.match(c, /now\(\) > x\.expires_at/); assert.match(c, /_intel_chat_may_auto\(v_org,/);
  assert.match(c, /_intel_chat_prepare\(v_org, x\.tool, x\.args\)/); assert.match(c, /status = 'running'/);
  assert.match(fns.intel_admin_chat_finish, /x\.status <> 'running' then return/);
  assert.match(fns.intel_admin_chat_confirm, /_intel_chat_executor\(x\.tool\) <> 'database'/);
  assert.match(fns.intel_admin_chat_confirm, /auto_not_allowed/);
  assert.match(sql, /drop function if exists public\.intel_admin_chat_confirm\(uuid\)/);
  assert.match(fns._intel_chat_exec, /send_email runs in the browser/);
});

test("SQL: send_email refuses do-not-contact recipients and bad input; knowledge cannot carry reserved tags", () => {
  const p = fns._intel_chat_prepare;
  assert.match(p, /recipient_is_on_the_do_not_contact_list/); assert.match(p, /x\.kind = 'domain' and x\.value = split_part\(v_to, '@', 2\)/);
  assert.match(p, /recipient_must_be_one_valid_email_address/); assert.match(p, /subject_too_long_or_has_line_breaks/);
  assert.match(p, /body_contains_reserved_tags/); assert.match(p, /unknown_time_zone/);
  assert.match(p, /start_hour_must_be_0_to_23_and_before_the_end_hour/); assert.match(p, /already_set_to_that_value/);
  assert.match(fns._intel_chat_exec, /intel_admin_upsert_kb[\s\S]*intel_admin_approve_kb\(a ->> 'key', true\)/);
});

test("SQL: no path to roles, memberships, permissions, kill switch from a setting, or suppression removal", () => {
  assert.ok(!/user_settings|studio_memberships|is_admin|master_user|intel_admin_remove_suppression|intel_admin_register_agent|intel_admin_set_kill_switch\(true|truncate/i.test(sql.replace(/intel_admin_set_kill_switch\(false\)/g, "")));
  const settingList = fns._intel_chat_prepare.match(/v_set not in \(([^)]*)\)/)[1];
  assert.ok(!/autonomy|kill_switch|daily_initial_cap|agent_user_id|owner_user_id/.test(settingList), "no dangerous setting is changeable through change_setting");
  assert.match(sql, /status in \('pending', 'running', 'confirmed', 'cancelled', 'failed', 'expired'\)/);
});
