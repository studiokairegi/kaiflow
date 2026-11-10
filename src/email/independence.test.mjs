// Audit fixes KF-01 (independent Email authorization), KF-02 (no shared kill switch), KF-03 / finding F (webhook isolation).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { canAccessEmail, loadEmailAccess } from "./access.js";
import { processDeliveryEvent } from "../../supabase/functions/_shared/email_resend_logic.ts";
import { resendAdapter } from "../../supabase/functions/_shared/email_adapter_resend.ts";

const root = new URL("../../supabase/", import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), "utf8").replace(/\r\n/g, "\n");
const codeOnly = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|--|\/\*|\*)/.test(l)).map((l) => l.replace(/\s(\/\/|--)\s.*$/, "")).join("\n");

// ------------------------------------------------------------------------------------------------ KF-01
test("KF-01: Email access helper asks email_has_access, fails closed, and never touches Intelligence", async () => {
  assert.equal(canAccessEmail(true), true);
  for (const v of [null, undefined, false, "true", 1]) assert.equal(canAccessEmail(v), false);
  const asked = [];
  const ok = { rpc: async (n) => { asked.push(n); return { data: true, error: null }; } };
  assert.equal(await loadEmailAccess(ok, "u1"), true);
  assert.deepEqual(asked, ["email_has_access"]);
  assert.equal(await loadEmailAccess({ rpc: async () => ({ data: true, error: { message: "x" } }) }, "u1"), false);
  assert.equal(await loadEmailAccess({ rpc: async () => ({ data: "true", error: null }) }, "u1"), false);
  assert.equal(await loadEmailAccess({ rpc: async () => { throw new Error("net"); } }, "u1"), false);
  assert.equal(await loadEmailAccess(null, "u1"), false);
  assert.equal(await loadEmailAccess(ok, null), false);
});

test("KF-01: the Email access functions are defined from base tables, with no intel_* call, and are not callable by anon", () => {
  const sql = codeOnly(read("migrations/20261216090000_email_independent_access.sql"));
  assert.equal(/intel_/i.test(sql), false, "no Intelligence object may be referenced");
  for (const fn of ["email_can_access(p_organization_id uuid)", "email_has_access()", "email_require_access()"]) assert.match(sql, new RegExp(`create or replace function public\\.${fn.replace(/[()]/g, "\\$&")}`));
  assert.match(sql, /s\.is_admin is true/);
  assert.match(sql, /m\.role = 'master_user' and m\.status = 'active'/);
  assert.match(sql, /exception when others then\s+return false/);                       // fail closed
  assert.match(sql, /revoke all on function public\.email_can_access\(uuid\) from public, anon/);
  assert.match(sql, /revoke all on function public\.email_has_access\(\) from public, anon/);
  assert.match(sql, /revoke all on function public\.email_require_access\(\) from public, anon/);
  assert.equal(/\b(drop|alter)\s+table|\bdelete\s+from|\btruncate\b/i.test(sql), false);
});

test("KF-01: general Email browser code does not import Intelligence access", () => {
  const inbox = fs.readFileSync(new URL("./InboxModule.jsx", import.meta.url), "utf8");
  assert.equal(/intelligence\/access|canAccessIntelligence|intelAccess/.test(inbox), false);
  assert.match(inbox, /from "\.\/access\.js"/);
});

// ------------------------------------------------------------------------------------------------ KF-02
test("KF-02: the Resend adapter has no shared kill switch and general Email never reads email_provider_flags", () => {
  assert.equal(resendAdapter.legacyFlagKey, null);
  for (const f of ["_shared/email_adapter_resend.ts", "_shared/email_resend_store.ts", "_shared/email_resend_logic.ts"]) {
    // Only the (now unused) optional-flag plumbing may mention the legacy key; no code may call the shared flag RPC for Resend.
    assert.equal(/email_provider_flags/.test(codeOnly(read(`functions/${f}`))), false, f);
  }
  assert.equal(/legacyFlagKey:\s*"/.test(codeOnly(read("functions/_shared/email_adapter_resend.ts"))), false);
});

// ------------------------------------------------------------------------------------------------ KF-03 / F
test("KF-03: general Email store and logic contain no Intelligence tables or RPCs; the Intelligence sink lives in its own file", () => {
  for (const f of ["_shared/email_resend_store.ts", "_shared/email_resend_logic.ts", "_shared/email_adapter_resend.ts"]) {
    assert.equal(/intel_(messages|agent_|suppressions)/.test(codeOnly(read(`functions/${f}`))), false, f);
  }
  const sink = read("functions/_shared/intel_resend_delivery_sink.ts");
  assert.match(sink, /from\("intel_messages"\)/);
  assert.match(sink, /intel_agent_apply_delivery_event/);
  assert.match(read("functions/resend-webhook/index.ts"), /applyIntelDeliveryEvent: makeIntelDeliverySink\(service\)/);
});

const EV = { type: "email.delivered", created_at: "2026-11-10T12:20:00.000Z", data: { email_id: "re_1", to: ["a@b.test"] } };
function deps({ emailFails = false, intelFails = false, emailFound = true, intelFound = true, withSink = true } = {}) {
  const calls = { email: 0, intel: 0 };
  const store = {
    reconcileTaggedDeliveryEvent: async () => ({ found: false }),
    applyDeliveryEvent: async () => { calls.email++; if (emailFails) throw new Error("crm rpc down"); return { found: emailFound }; },
  };
  if (withSink) store.applyIntelDeliveryEvent = async () => { calls.intel++; if (intelFails) throw new Error("intel rpc down"); return { found: intelFound }; };
  return { d: { env: () => undefined, fetch: async () => { throw new Error("no network"); }, now: () => Date.parse("2026-11-10T12:21:00Z"), sleep: async () => {}, store }, calls };
}
const origErr = console.error;

test("KF-03: an Intelligence failure does not stop CRM processing, and the event is still retried (error surfaces)", async () => {
  console.error = () => {};
  try {
    const { d, calls } = deps({ intelFails: true });
    await assert.rejects(() => processDeliveryEvent(d, "svix-1", EV), /intel rpc down/);
    assert.equal(calls.email, 1, "CRM side ran");
    assert.equal(calls.intel, 1);
  } finally { console.error = origErr; }
});

test("KF-03: a CRM failure does not stop Intelligence processing, and the event is still retried", async () => {
  console.error = () => {};
  try {
    const { d, calls } = deps({ emailFails: true });
    await assert.rejects(() => processDeliveryEvent(d, "svix-2", EV), /crm rpc down/);
    assert.equal(calls.intel, 1, "Intelligence side ran although CRM failed");
    assert.equal(calls.email, 1);
  } finally { console.error = origErr; }
});

test("KF-03: general Email runs alone when no Intelligence sink is plugged in", async () => {
  const { d, calls } = deps({ withSink: false });
  assert.deepEqual(await processDeliveryEvent(d, "svix-3", EV), { result: "processed" });
  assert.equal(calls.email, 1); assert.equal(calls.intel, 0);
});

test("KF-03: either side matching marks the event processed; neither matching keeps it queued for reconciliation", async () => {
  assert.deepEqual(await processDeliveryEvent(deps({ emailFound: false, intelFound: true }).d, "s4", EV), { result: "processed" });
  assert.deepEqual(await processDeliveryEvent(deps({ emailFound: true, intelFound: false }).d, "s5", EV), { result: "processed" });
  const none = await processDeliveryEvent(deps({ emailFound: false, intelFound: false }).d, "s6", EV);
  assert.equal(none.result, "ignored"); assert.match(none.reason, /queued for reconciliation/);
});

test("KF-03: an ambiguous Intelligence provider id still fails the delivery, after CRM has been processed", async () => {
  console.error = () => {};
  try {
    const { d, calls } = deps();
    d.store.applyIntelDeliveryEvent = async () => ({ found: false, ambiguous: true });
    await assert.rejects(() => processDeliveryEvent(d, "s7", EV), /ambiguous/);
    assert.equal(calls.email, 1);
  } finally { console.error = origErr; }
});
