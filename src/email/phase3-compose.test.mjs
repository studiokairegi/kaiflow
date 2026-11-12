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

test("composer wiring: ComposeDialog forwards the lead id; InboxModule opens it from the request after accounts load", () => {
  const dialog = read("./components/ComposeDialog.jsx");
  assert.match(dialog, /crmLeadId: initial\.crmLeadId \|\| null/);
  assert.match(dialog, /initial\.crmLeadId &&/);
  assert.match(dialog, /compose-crm-recipient-warning/);
  assert.match(dialog, /Send without linking to/);
  const inbox = read("./InboxModule.jsx");
  assert.match(inbox, /composeRequest/);
  assert.match(inbox, /crmLeadId: composeRequest\.leadId/);
  assert.match(inbox, /to: composeRequest\.to/);
  assert.match(inbox, /leadComposeReadiness\(\{ accounts, providers \}\)/); // readiness helper refuses loading/error/stale registries
  assert.match(inbox, /onComposeHandled\?\.\(\)/);
  assert.match(inbox, /readiness === "ready"/);
  assert.match(inbox, /else \{\s*setComposeNotice\("No connected sender can send right now/);
  const app = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(app, /view !== "projects" \|\| workspace !== "leads" \|\| crmTab !== "inbox".*setComposeRequest\(null\)/s);
  // the existing manual Compose entry points are untouched
  assert.equal((inbox.match(/setComposer\(\{ title: "New message" \}\)/g) || []).length, 2);
});

test("CRM board: button only for email-authorized users and eligible leads; clicks never open or drag the card", () => {
  const app = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(app, /canAccessEmail\(emailAccess\) && \(\(\) => \{\s*const target = leadComposeTarget\(lead, userId\);\s*if \(!target\) return null;/);
  assert.match(app, /onPointerDown=\{\(e\) => e\.stopPropagation\(\)\}\s*onClick=\{\(e\) => \{ e\.stopPropagation\(\); setLeadComposeModal\(\{ \.\.\.target, nonce: Date\.now\(\) \}\); \}\}/);
  assert.match(app, /composeRequest=\{composeRequest\} onComposeHandled=\{\(\) => setComposeRequest\(null\)\}/);
});

test("Phase 3 leaves the intelligence AI routing / autonomy files alone", () => {
  assert.ok(!/composeRequest|leadComposeTarget/.test(read("../intelligence/api.js")));
});
