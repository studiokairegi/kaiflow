// Phase 4D CRM activity recording: fake providers and stores only; no live email or database.
import test from "node:test";
import assert from "node:assert/strict";
import { handleSend } from "../../supabase/functions/_shared/email_resend_logic.ts";
import { resendAdapter } from "../../supabase/functions/_shared/email_adapter_resend.ts";

const ORG = "20000000-0000-0000-0000-00000000000a";
const ACC = "30000000-0000-0000-0000-00000000000b";
const LEAD = "40000000-0000-0000-0000-0000000000a1";
const REG = { provider_key: "resend", adapter_key: "resend", display_name: "Resend", enabled: true, capabilities: { send: true } };
const req = (extra = {}) => new Request("https://x/functions/v1/email-send", { method: "POST", headers: { authorization: "Bearer good", "content-type": "application/json" }, body: JSON.stringify({ account_id: ACC, to: ["client@example.com"], cc: [], bcc: [], subject: "Approved subject", text: "Approved body", html: "<p>Approved body</p>", reply_to: "", conversation_id: null, draft_id: null, idempotency_key: "phase4d-key-123456", attachments: [], crm: { lead_id: LEAD }, ...extra }) });
function harness({ crmFail = false, duplicate = false, priorStatus = "sent", linkedLead = null } = {}) {
  const calls = { provider: 0, record: [], create: [] };
  const rows = [];
  const store = {
    providerEnabled: async () => true, getProviderRegistryRow: async () => REG,
    getAccount: async () => ({ id: ACC, organization_id: ORG, provider: "resend", address: "sender@example.com", display_name: "Sender", status: "active" }),
    getLeadForUser: async (u, id) => u === "user-1" && id === LEAD ? { id } : null,
    getConversationLead: async () => linkedLead ? { lead_id: linkedLead } : null,
    getThreadParent: async () => null, countOutboundSince: async () => 0,
    createOutbound: async (p) => { calls.create.push(p); if (duplicate) return { duplicate: true, message_id: "message-1", conversation_id: "conversation-1", status: priorStatus }; rows.push(p); return { duplicate: false, message_id: "message-1", conversation_id: "conversation-1", status: "queued" }; },
    markResult: async () => {}, saveAttachments: async () => {},
    recordCrmActivity: async (id) => { calls.record.push(id); if (crmFail) throw new Error("database unavailable"); return { recorded: true, duplicate: false }; },
  };
  const deps = { env: (k) => k === "RESEND_API_KEY" ? "re_test_1234567890" : undefined, now: () => Date.UTC(2026,10,10), sleep: async () => {}, store, adapters: { resend: { ...resendAdapter, async send() { calls.provider++; return { ok: true, providerMessageId: "provider-message-1", attempts: 1 }; } } },
    authenticate: async () => ({ ok: true, userId: "user-1", organizationId: ORG }) };
  return { deps, calls };
}

test("4D: successful provider acceptance records CRM activity once and carries the lead identity into the outbound row", async () => {
  const h = harness(); const res = await handleSend(req(), h.deps); const body = await res.json();
  assert.equal(res.status, 200); assert.equal(body.outcome, "accepted"); assert.deepEqual(body.crm, { lead_id: LEAD, activity: "recorded" });
  assert.equal(h.calls.provider, 1); assert.deepEqual(h.calls.record, ["message-1"]);
  assert.equal(h.calls.create[0].crm_lead_id, LEAD); assert.equal(h.calls.create[0].crm_user_id, "user-1");
});

test("4D: CRM database failure after provider acceptance returns accepted + pending, never a send retry", async () => {
  const h = harness({ crmFail: true }); const res = await handleSend(req(), h.deps); const body = await res.json();
  assert.equal(res.status, 200); assert.equal(body.outcome, "accepted"); assert.equal(body.warning, "crm_activity_pending");
  assert.deepEqual(body.crm, { lead_id: LEAD, activity: "pending" }); assert.equal(h.calls.provider, 1); assert.deepEqual(h.calls.record, ["message-1"]);
});

test("4D: replay of an already accepted idempotent send repairs CRM activity without provider submission", async () => {
  const h = harness({ duplicate: true, priorStatus: "sent" }); const res = await handleSend(req(), h.deps); const body = await res.json();
  assert.equal(res.status, 200); assert.equal(body.outcome, "duplicate"); assert.deepEqual(body.crm, { lead_id: LEAD, activity: "recorded" });
  assert.equal(h.calls.provider, 0); assert.deepEqual(h.calls.record, ["message-1"]);
});

test("4D: CRM recording failure on an accepted duplicate remains pending and does not call provider", async () => {
  const h = harness({ duplicate: true, priorStatus: "delivered", crmFail: true }); const res = await handleSend(req(), h.deps); const body = await res.json();
  assert.equal(body.outcome, "duplicate"); assert.equal(body.warning, "crm_activity_pending"); assert.equal(body.crm.activity, "pending");
  assert.equal(h.calls.provider, 0);
});

test("4D migration: ownership, durable content, idempotency, and service-only recovery are enforced in SQL", async () => {
  const fs = await import("node:fs");
  const path = new URL("../../supabase/migrations/20261208100000_email_crm_activity.sql", import.meta.url);
  const sql = fs.readFileSync(path, "utf8");
  assert.match(sql, /add column if not exists crm_lead_id uuid references public\.leads\(id\)/);
  assert.match(sql, /m\.created_by is distinct from v_crm_user|v_lead_owner is distinct from v_crm_user/);
  assert.match(sql, /create table if not exists public\.email_crm_activities/);
  assert.match(sql, /message_id uuid not null unique references public\.email_messages\(id\)/);
  assert.match(sql, /body_text text not null/);
  assert.match(sql, /body_html text not null/);
  assert.match(sql, /email_record_crm_activity\(p_message_id uuid\)/);
  assert.match(sql, /email_recover_crm_activities\(p_limit integer default 100\)/);
  assert.match(sql, /grant execute on function public\.email_recover_crm_activities\(integer\) to service_role/);
  assert.match(sql, /status in \('sent','delivered','delivery_delayed','bounced','complained'\)/);
  assert.match(sql, /provider-accepted outbound rows/);
  assert.match(sql, /never calls an email provider/);
  assert.match(sql.trim(), /^begin;[\s\S]*commit;/);
  assert.match(sql, /Rollback \(non-destructive\)/);
});

test("4D: a conversation's existing CRM lead is inherited when sending a reply", async () => {
  const h = harness({ linkedLead: LEAD });
  const res = await handleSend(req({ conversation_id: "aaaaaaaa-1111-2222-3333-444444444444", crm: null }), h.deps);
  const body = await res.json();
  assert.equal(res.status, 200); assert.deepEqual(body.crm, { lead_id: LEAD, activity: "recorded" });
  assert.equal(h.calls.create[0].crm_lead_id, LEAD); assert.equal(h.calls.provider, 1);
});

test("4D: an explicit CRM lead cannot silently override a conversation's different lead", async () => {
  const h = harness({ linkedLead: "40000000-0000-0000-0000-0000000000a2" });
  const res = await handleSend(req({ conversation_id: "aaaaaaaa-1111-2222-3333-444444444444" }), h.deps);
  const body = await res.json();
  assert.equal(res.status, 409); assert.equal(body.code, "crm_lead_conflict");
  assert.equal(h.calls.create.length, 0); assert.equal(h.calls.provider, 0);
});

test("4D: a database-detected CRM association race returns a safe 409 and never submits", async () => {
  const h = harness();
  h.deps.store.createOutbound = async () => { h.calls.create.push({}); throw new Error("crm_lead_conflict"); };
  const res = await handleSend(req({ conversation_id: "aaaaaaaa-1111-2222-3333-444444444444" }), h.deps);
  const body = await res.json();
  assert.equal(res.status, 409); assert.equal(body.code, "crm_lead_conflict");
  assert.equal(h.calls.provider, 0);
});

test("4D composer/API contract forwards an explicit CRM lead claim to the server", async () => {
  const fs = await import("node:fs");
  const api = fs.readFileSync(new URL("./lib/api.js", import.meta.url), "utf8");
  const composer = fs.readFileSync(new URL("./components/ComposeDialog.jsx", import.meta.url), "utf8");
  assert.match(api, /crm: m\.crmLeadId \? \{ lead_id: m\.crmLeadId \} : null/);
  assert.match(composer, /crmLeadId: initial\.crmLeadId \|\| null/);
});
