import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { availableMailProviders, providerForAccount, accountCanSend, accountConnectionLabel, trustedProviderRows, accountListView } from "./lib/logic.js";
import { emailApi as canonicalEmailApi } from "./lib/api.js";
import { emailApi as compatibilityEmailApi } from "./api.js";

const resend = { provider_key: "resend", display_name: "Resend", enabled: true, capabilities: { send: true, oauth: false, remote_sync: false, remote_search: false, remote_folders: false } };
const account = { id: "a1", provider: "resend", address: "studio@example.test", status: "active", connection_status: "not_connected" };

test("Phase 6 provider catalog exposes only enabled send-capable registry rows", () => {
  assert.deepEqual(availableMailProviders([resend, { ...resend, provider_key: "disabled", enabled: false }, { ...resend, provider_key: "receive_only", capabilities: { send: false } }]), [resend]);
  assert.deepEqual(availableMailProviders(null), []);
});

test("Phase 6 sender eligibility follows provider capabilities and account state", () => {
  assert.equal(providerForAccount(account, [resend]), resend);
  assert.equal(accountCanSend(account, [resend]), true, "non-OAuth Resend sender does not require OAuth connection_status");
  assert.equal(accountCanSend({ ...account, status: "paused" }, [resend]), false);
  assert.equal(accountCanSend(account, [{ ...resend, enabled: false }]), false);
  const oauth = { ...resend, provider_key: "oauth_mail", capabilities: { send: true, oauth: true } };
  assert.equal(accountCanSend({ ...account, provider: "oauth_mail", connection_status: "not_connected" }, [oauth]), false);
  assert.equal(accountCanSend({ ...account, provider: "oauth_mail", connection_status: "connected" }, [oauth]), true);
});

test("Phase 6 connection labels do not misreport Resend as OAuth-connected", () => {
  assert.equal(accountConnectionLabel(account, [resend]), "Sending address configured");
  assert.equal(accountConnectionLabel({ ...account, provider: "oauth_mail", connection_status: "reauthorization_required" }, [{ ...resend, provider_key: "oauth_mail", capabilities: { send: true, oauth: true } }]), "Reauthorization required");
});

test("Phase 6 UI uses the registry and does not hardcode fake mailbox providers", () => {
  const inbox = fs.readFileSync(new URL("./InboxModule.jsx", import.meta.url), "utf8");
  const compose = fs.readFileSync(new URL("./components/ComposeDialog.jsx", import.meta.url), "utf8");
  const api = fs.readFileSync(new URL("./lib/api.js", import.meta.url), "utf8");
  assert.match(inbox, /emailApi\.providers\(supabase\)/);
  assert.match(inbox, /accountCanSend\(accts\.find\(\(a\) => a\.id === convo\.account_id\)/);
  assert.doesNotMatch(inbox, /SetupAccount|emailApi\.addAccount|showAddAccount/);
  assert.match(inbox, /Settings → Intelligence → Email accounts/);
  assert.match(compose, /disabled=\{Boolean\(draftId \|\| conversationId\)\}/);
  assert.match(compose, /accountCanSend\(selectedAccount, providers\)/);
  assert.match(api, /email_provider_registry_list/);
});


test("provider registry failures discard stale rows and fail closed", () => {
  assert.deepEqual(trustedProviderRows([resend], "network unavailable"), []);
  assert.deepEqual(trustedProviderRows([resend], ""), [resend]);
  assert.equal(accountCanSend(account, trustedProviderRows([resend], "registry failed")), false);
});

test("account loading distinguishes failure from a successfully empty list", () => {
  assert.equal(accountListView({ loading: true, error: "", data: null }), "loading");
  assert.equal(accountListView({ loading: false, error: "permission denied", data: null }), "error");
  assert.equal(accountListView({ loading: false, error: "", data: [] }), "empty");
  assert.equal(accountListView({ loading: false, error: "", data: [account] }), "ready");
});

test("legacy Email API entry point is the canonical implementation", () => {
  assert.equal(compatibilityEmailApi, canonicalEmailApi);
  assert.equal(typeof compatibilityEmailApi.send, "function");
  assert.equal("addAccount" in compatibilityEmailApi, false);
});

test("Inbox has no independent mailbox connection or account-creation workflow", () => {
  const inbox = fs.readFileSync(new URL("./InboxModule.jsx", import.meta.url), "utf8");
  const api = fs.readFileSync(new URL("./lib/api.js", import.meta.url), "utf8");
  assert.match(inbox, /trustedProviderRows\(providers\.data, providers\.error\)/);
  assert.match(inbox, /accountView === "error"/);
  assert.match(inbox, /accounts\.reload\(\)/);
  assert.match(inbox, /providers\.reload\(\)/);
  assert.doesNotMatch(inbox, /Add account|showAddAccount|SetupAccount/);
  assert.doesNotMatch(api, /email_upsert_account|addAccount:/);
});
