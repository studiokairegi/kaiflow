import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MAIL_PROVIDERS, OAUTH_RESULTS, mailProviderName, mailStatusLabel, oauthResult } from "./logic.js";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const sql = read("../../supabase/migrations/20261109150000_intelligence_gmail_provider.sql");
const providerOauth = read("../../supabase/functions/_shared/intel_provider_oauth.ts");
const worker = read("../../intelligence-worker/kairflow_intel/gmail.py");

test("every result flag the Edge functions can redirect with has a message for the person", () => {
  for (const src of [providerOauth]) {
    const flags = [...src.matchAll(/back\("(\w+)"\)/g)].map((m) => m[1]);
    assert.ok(flags.length >= 4);
    for (const f of flags) assert.ok(OAUTH_RESULTS[f], `no message for ?intelligence=${f}`);
  }
  assert.equal(oauthResult("something_else"), null); assert.equal(oauthResult(null), null);
  for (const r of Object.values(OAUTH_RESULTS)) assert.ok(["ok", "warn", "bad"].includes(r.tone));
  for (const f of Object.keys(OAUTH_RESULTS).filter((k) => !/connected$/.test(k))) assert.match(OAUTH_RESULTS[f].text, /Nothing was saved|saved/, f);
});

test("provider labels", () => {
  assert.deepEqual(Object.keys(MAIL_PROVIDERS), ["gmail", "zoho"]);
  assert.equal(mailProviderName({ provider: "gmail" }), "Gmail"); assert.equal(mailProviderName({}), "Zoho Mail");
  assert.equal(mailStatusLabel({ status: "connected", provider: "gmail", mailbox: "a@gmail.com" }), "Gmail connected (a@gmail.com)");
  assert.equal(mailStatusLabel({ status: "error", provider: "gmail" }), "Gmail status check failed"); assert.equal(mailStatusLabel(null), "Mail not connected");
});

test("migration allows exactly gmail and zoho, keeps OAuth states provider-tagged, and does not weaken anything", () => {
  assert.match(sql, /intel_mail_account_provider_check check \(provider in \('zoho', 'gmail'\)\)/);
  assert.match(sql, /intel_oauth_states_provider_check check \(provider in \('zoho', 'gmail'\)\)/);
  assert.match(sql, /'google'\)/);
  assert.match(sql, /'provider', a\.provider/);                              // the UI can tell which mailbox is connected
  assert.match(sql, /Gmail or Zoho Mail/);                                    // kill-switch message is provider neutral
  assert.match(sql, /intel_admin_set_kill_switch/); assert.match(sql, /v_org uuid := public\.intel_admin_org\(\)/);   // the guard that requires admin AND active Master User
  assert.ok(!/grant |disable row level|drop policy/i.test(sql.replace(/^\s*--.*$/gm, "")), "adds no grants and removes no protections");
  assert.equal((sql.match(/\$\$/g) || []).length % 2, 0);
});

test("the kill switch still refuses to enable sending without a connected mailbox and registered agent", () => {
  const f = sql.slice(sql.indexOf("intel_admin_set_kill_switch"));
  assert.match(f, /intel_mail_account/); assert.match(f, /connected/); assert.match(f, /agent_user_id/);
});

test("worker Gmail client never sends from a different address, never retries a send, and refuses header injection", () => {
  assert.match(worker, /from_addr\.strip\(\)\.lower\(\) != mailbox/);
  assert.match(worker, /header injection/);
  const send = worker.slice(worker.indexOf("def send("), worker.indexOf("def _headers_of"));
  assert.ok(!/for attempt|retry|sleep/.test(send), "no retry loop around the send call");
  assert.match(worker, /429 or r\.status_code >= 500/);
});

test("mail status distinguishes a provider check failure from a disconnected mailbox", () => {
  assert.equal(mailStatusLabel({ status: "check_failed", provider: "zoho" }), "Zoho Mail status check failed");
  assert.equal(mailStatusLabel({ status: "disconnected", provider: "zoho" }), "Mail not connected");
});

test("dynamic provider account status does not imply a single configured mailbox", async () => {
  assert.equal(mailStatusLabel({ status: "connected", provider: "multiple", accounts: [
    { provider_key: "gmail", status: "connected" },
    { provider_key: "zoho", status: "disconnected" },
    { provider_key: "smtp", status: "connected" },
  ] }), "2 of 3 provider accounts connected");
});

test("OAuth success messaging no longer tells operators to select a global worker provider", () => {
  assert.match(OAUTH_RESULTS.provider_connected.text, /durable account assignment/);
  assert.doesNotMatch(OAUTH_RESULTS.provider_connected.text, /KAIRFLOW_MAIL_PROVIDER/);
});
