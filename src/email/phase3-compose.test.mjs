// CRM Lead Composer Integration (roadmap Phase 3): Compose on eligible lead cards opens the existing Inbox composer with the
// recipient and the internal CRM lead id. Sending itself is unchanged (Phase 4 contract: email-send + email_record_crm_activity).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { leadComposeTarget, leadComposeReadiness, crmLeadRecipientMatches } from "./lib/logic.js";

const ID = "3f2b8a52-1c7e-4d6a-9a0b-5e1f2c3d4e5f";
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

test("eligible lead: valid email and saved id", () => {
  assert.deepEqual(leadComposeTarget({ id: ID.toUpperCase(), companyName: "Aozora", email: " Contact@Aozora.example " }),
    { leadId: ID, to: "contact@aozora.example", label: "Aozora" });
});
test("label falls back to contact person then address", () => {
  assert.equal(leadComposeTarget({ id: ID, contactPerson: "Hana", email: "h@x.io" }).label, "Hana");
  assert.equal(leadComposeTarget({ id: ID, email: "h@x.io" }).label, "h@x.io");
});

test("whitespace-only company names fall back to the contact person or email", () => {
  assert.equal(leadComposeTarget({ id: ID, companyName: "   ", contactPerson: " Hana ", email: "h@x.io" }).label, "Hana");
  assert.equal(leadComposeTarget({ id: ID, companyName: "  ", email: "h@x.io" }).label, "h@x.io");
});

test("CRM compose readiness waits for registries, fails closed on errors, and rejects accounts that cannot send", () => {
  assert.equal(leadComposeReadiness({ accounts: { loading: true }, providers: { loading: false } }), "waiting");
  assert.equal(leadComposeReadiness({ accounts: { loading: false, error: new Error("offline") }, providers: { loading: false } }), "error");
  assert.equal(leadComposeReadiness({ accounts: { loading: false, data: [] }, providers: { loading: false, data: [] } }), "unavailable");
  assert.equal(leadComposeReadiness({ accounts: { loading: false, data: [{ status: "active", connection_status: "connected", provider: "resend" }] }, providers: { loading: false, data: [{ provider_key: "resend", enabled: true, capabilities: { send: true } }] } }), "ready");
});

test("CRM link is retained only while the lead's original recipient remains in To", () => {
  assert.equal(crmLeadRecipientMatches("lead@example.com", "other@example.com"), false);
  assert.equal(crmLeadRecipientMatches("lead@example.com", "other@example.com, lead@example.com"), true);
  assert.equal(crmLeadRecipientMatches("bad, lead@example.com", "LEAD@example.com"), true);
});

test("no Compose for leads without a valid email, archived leads, or unsaved ids", () => {
  for (const email of [undefined, null, "", "   ", "not-an-email", "a@b", "a b@c.com"]) assert.equal(leadComposeTarget({ id: ID, email }), null, String(email));
  assert.equal(leadComposeTarget({ id: ID, email: "a@b.co", archivedAt: "2026-01-01" }), null);
  for (const id of [undefined, "", "new", "123", "temp-1"]) assert.equal(leadComposeTarget({ id, email: "a@b.co" }), null, String(id));
  assert.equal(leadComposeTarget(null), null);
});
test("a colleague's lead (different owner) never offers Compose; own leads and unowned new rows do", () => {
  const lead = { id: ID, email: "a@b.co", ownerUserId: "u-1" };
  assert.equal(leadComposeTarget(lead, "u-2"), null);
  assert.equal(leadComposeTarget(lead, undefined), null);
  assert.ok(leadComposeTarget(lead, "u-1"));
  assert.ok(leadComposeTarget({ id: ID, email: "a@b.co" }, "u-1"));
});
test("a lead holding several addresses uses only the first valid one", () => {
  assert.equal(leadComposeTarget({ id: ID, email: "bad, one@x.io; two@x.io" }).to, "one@x.io");
});

test("the hand-off id reaches the send request as crm.lead_id, and is omitted for ordinary composes", () => {
  assert.match(read("./lib/api.js"), /crm: m\.crmLeadId \? \{ lead_id: m\.crmLeadId \} : null/);
});

test("composer wiring: ComposeDialog forwards the lead id; the modal opens it over the CRM after accounts load", () => {
  const dialog = read("./components/ComposeDialog.jsx");
  assert.match(dialog, /crmLeadId: initial\.crmLeadId \|\| null/);
  assert.match(dialog, /initial\.crmLeadId &&/);
  assert.match(dialog, /compose-crm-recipient-warning/);
  assert.match(dialog, /Send without linking to/);
  const modal = read("./components/LeadComposeModal.jsx");
  assert.match(modal, /crmLeadId: target\.leadId/);
  assert.match(modal, /to: target\.to/);
  assert.match(modal, /leadComposeReadiness\(\{ accounts, providers \}\)/);
  assert.match(modal, /readiness === "ready"|else \{\s*const accts/); // only the ready branch renders the dialog
  assert.match(modal, /No connected sender can send right now/);
  assert.match(modal, /onSent\?\.\(target\.leadId\);\s*onClose\(\)/); // closes back to the CRM after sending
  const inbox = read("./InboxModule.jsx");
  assert.ok(!/composeRequest/.test(inbox)); // no Inbox tab hand-off any more
  assert.equal((inbox.match(/setComposer\(\{ title: "New message" \}\)/g) || []).length, 2);
});

test("CRM lead card: icon only for saved, email-authorized, eligible leads; opens a modal and never switches to Inbox", () => {
  const app = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(app, /composeTarget=\{canAccessEmail\(emailAccess\) && editingLead\.id \? leadComposeTarget\(/);
  assert.match(app, /onCompose=\{setLeadComposer\}/);
  assert.match(app, /composeTarget && onCompose && \(/);
  assert.match(app, /<LeadComposeModal/);
  assert.ok(!/setComposeRequest/.test(app));
  assert.ok(!/setComposeRequest|setCrmTab\("inbox"\); \}\}/.test(app.slice(app.indexOf("data-testid=\"lead-compose-button\"") - 600, app.indexOf("data-testid=\"lead-compose-button\"") + 200)));
});

test("Phase 3 leaves the intelligence AI routing / autonomy files alone", () => {
  assert.ok(!/composeRequest|leadComposeTarget|LeadComposeModal/.test(read("../intelligence/api.js")));
});

test("composer modal stacks above the lead editor and the open lead card re-reads its timeline after a send", () => {
  const app = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const z = Number(read("./components/LeadComposeModal.jsx").match(/WRAP = \{[^}]*zIndex: (\d+)/)[1]);
  const overlay = Number(app.match(/  overlay: \{[^}]*?zIndex: (\d+)/s)[1]);
  assert.ok(z > overlay);
  assert.match(app, /setLeadTimelineNonce\(\(n\) => n \+ 1\)/);
  assert.match(app, /\[lead\.id, isNew, timelineNonce\]/);
});
