import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { leadComposeBlockReason, leadComposeTarget } from "./lib/logic.js";

const ID = "3f2b8c1e-9a4d-4e6b-8c1a-2d3e4f5a6b7c";
const ME = "11111111-1111-4111-8111-111111111111";
const lead = { id: ID, email: "a@x.io", ownerUserId: ME };

test("mail icon reason: null only when the lead can be emailed", () => {
  assert.equal(leadComposeBlockReason(lead, ME, true), null);
  assert.ok(leadComposeTarget(lead, ME));
});

test("mail icon reason explains each blocker", () => {
  assert.match(leadComposeBlockReason(lead, ME, null), /Checking/);
  assert.match(leadComposeBlockReason(lead, ME, false), /not enabled/);
  assert.match(leadComposeBlockReason({ ...lead, id: "" }, ME, true), /Save this lead/);
  assert.match(leadComposeBlockReason({ ...lead, archivedAt: "2026-01-01" }, ME, true), /Archived/);
  assert.match(leadComposeBlockReason({ ...lead, ownerUserId: "other" }, ME, true), /another user/);
  assert.match(leadComposeBlockReason({ ...lead, email: "" }, ME, true), /no email/);
  assert.match(leadComposeBlockReason({ ...lead, email: "nope" }, ME, true), /isn't valid/);
});

test("reason agrees with leadComposeTarget for every case", () => {
  for (const l of [lead, { ...lead, email: "bad" }, { ...lead, archivedAt: "x" }, { ...lead, ownerUserId: "o" }, { ...lead, id: "x" }]) {
    assert.equal(leadComposeBlockReason(l, ME, true) === null, leadComposeTarget(l, ME) !== null);
  }
});

test("opened lead always renders the mail icon (disabled with a reason), not gated on access", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(app, /composeBlockReason=\{leadComposeBlockReason\(editingLead, userId, emailAccess\)\}/);
  assert.match(app, /form\.email && !isNew && onComposeEmail/);
  assert.match(app, /aria-disabled=\{composeBlockReason \? "true" : undefined\}/);
});

test("compose from a lead opens a modal over the pipeline: never navigates to the Inbox, never closes the CRM page", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  // both entry points (pipeline card button, lead editor icon) open the modal
  assert.equal((app.match(/setLeadComposeModal\(\{ \.\.\.target, nonce: Date\.now\(\) \}\)/g) || []).length, 2);
  // neither entry point switches tab or sets the Inbox hand-off request
  const cardBtn = app.slice(app.indexOf("title={`Compose an email to ${target.to}`}"), app.indexOf(">\n                                  Compose"));
  assert.ok(!/setCrmTab|setComposeRequest/.test(cardBtn));
  const editorCb = app.slice(app.indexOf("onComposeEmail={() => {"), app.indexOf("timelineRefreshKey={leadTimelineTick}"));
  assert.ok(!/setCrmTab|setComposeRequest|setEditingLead/.test(editorCb));
  // the modal is gated on email access and refreshes the lead timeline after a send
  assert.match(app, /leadComposeModal && canAccessEmail\(emailAccess\) && \(\s*<LeadComposeModal/);
  assert.match(app, /onSent=\{\(leadId\) => \{ const l = leads\.find\(\(x\) => x\.id === leadId\); if \(l\) refreshLeadTimeline\(l\); setLeadTimelineTick/);
});

test("lead editor icon uses the Inbox Compose button design", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const inbox = readFileSync(new URL("./InboxModule.jsx", import.meta.url), "utf8");
  assert.match(inbox, /className="chat-icon-btn solid" onClick=\{\(\) => setComposer\(\{ title: "New message" \}\)\} aria-label="Compose"/);
  assert.match(inbox, /<IconNewChat \/><\/button>/);
  assert.match(app, /className="chat-icon-btn solid sm"/);
  assert.match(app, /<IconNewChat size=\{16\} \/>/);
  assert.ok(!/MailIcon/.test(app));
});

test("LeadComposeModal reuses ComposeDialog and the Inbox sender rules, closes itself after send", () => {
  const src = readFileSync(new URL("./LeadComposeModal.jsx", import.meta.url), "utf8");
  assert.match(src, /import ComposeDialog from "\.\/components\/ComposeDialog\.jsx"/);
  assert.match(src, /leadComposeReadiness\(\{ accounts, providers \}\)/);
  assert.match(src, /trustedProviderRows\(providers\.data, providers\.error\)/);
  assert.match(src, /sendProviderRows = accounts\.error \? \[\] : providerRows/);
  assert.match(src, /onSent=\{\(\) => \{ onSent\?\.\(request\.leadId\); onClose\(\); \}\}/);
  assert.match(src, /crmLeadId: request\.leadId/);
  assert.ok(!/setCrmTab/.test(src));
});

test("LeadComposeModal has no Escape shortcut (it would silently discard a half-written email)", () => {
  const src = readFileSync(new URL("./LeadComposeModal.jsx", import.meta.url), "utf8");
  assert.ok(!/Escape|keydown/.test(src));
});
