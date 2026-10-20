import test from "node:test";
import assert from "node:assert/strict";
import * as P from "./providers.js";
import { canAccessPayments } from "./access.js";
import * as reg from "../../supabase/functions/_shared/payments/registry.ts";
import { ProviderNotImplementedError } from "../../supabase/functions/_shared/payments/provider.ts";

const HEX64 = "a".repeat(64);

// ---------------------------------------------------------------- admin-only (UI side)
test("access: only an explicit isAdmin=true opens Payments; everything else fails closed", () => {
  assert.equal(canAccessPayments({ isAdmin: true }), true);
  for (const s of [undefined, null, {}, { isAdmin: false }, { isAdmin: "true" }, { isAdmin: 1 }, { plan: "pro" }]) assert.equal(canAccessPayments(s), false);
});

// ---------------------------------------------------------------- provider catalogue
test("catalogue: Wise first, enabled + primary by default, not connected; others Coming Soon", () => {
  const ps = P.mergeProviders([]);
  assert.deepEqual(ps.map((p) => p.id), ["wise", "paystack", "paypal", "payoneer", "mpesa"]);
  assert.equal(ps[0].enabled, true); assert.equal(ps[0].primary, true); assert.equal(ps[0].connected, false);
  for (const p of ps.slice(1)) { assert.equal(p.status, "coming_soon"); assert.equal(p.enabled, false); assert.equal(p.primary, false); }
});
test("catalogue: stored rows win for Wise; a stored row can never enable a Coming Soon provider", () => {
  const ps = P.mergeProviders([
    { provider: "wise", status: "connected", is_enabled: true, is_primary: false },
    { provider: "paypal", status: "connected", is_enabled: true, is_primary: true },
  ]);
  assert.equal(ps[0].connected, true); assert.equal(ps[0].primary, false);
  assert.equal(ps.find((p) => p.id === "paypal").enabled, false);
  assert.equal(P.offeredToClients(ps[0]), true);
  assert.equal(P.offeredToClients(ps.find((p) => p.id === "paypal")), false);
});
test("offeredToClients needs enabled AND connected", () => {
  const w = (o) => ({ available: true, enabled: true, connected: true, ...o });
  assert.equal(P.offeredToClients(w({})), true);
  assert.equal(P.offeredToClients(w({ enabled: false })), false);
  assert.equal(P.offeredToClients(w({ connected: false })), false);
});

// ---------------------------------------------------------------- checkout token / URL
test("token: only 64 lowercase hex chars is accepted; invoice-id-like values are not", () => {
  assert.ok(P.isCheckoutToken(HEX64));
  for (const t of ["", "abc", HEX64 + "0", "A".repeat(64), "g".repeat(64), "123e4567-e89b-12d3-a456-426614174000", null, undefined]) assert.equal(P.isCheckoutToken(t), false);
});
test("path: /pay/{token} is recognised; other paths are not", () => {
  assert.equal(P.tokenFromPath(`/pay/${HEX64}`), HEX64);
  assert.equal(P.tokenFromPath(`/pay/${HEX64}/`), HEX64);
  for (const p of ["/", "/pay", "/pay/", `/payments/${HEX64}`, `/pay/${HEX64}/extra`, `/x/pay/${HEX64}`]) assert.equal(P.tokenFromPath(p), null);
  assert.equal(P.checkoutUrl(HEX64, "https://studiokairegi.com/"), `https://studiokairegi.com/pay/${HEX64}`);
});

// ---------------------------------------------------------------- server-side registry
test("registry: every provider is a placeholder, so nothing is ever offered to clients yet", () => {
  const all = reg.allProviders();
  assert.equal(all.length, 5);
  assert.ok(all.every((p) => p.capabilities.implemented === false));
  const cfgs = ["wise", "paystack", "paypal", "payoneer", "mpesa"].map((provider, i) => ({ provider, status: "connected", isEnabled: true, isPrimary: i === 0 }));
  assert.deepEqual(reg.availablePaymentMethods(cfgs, "USD"), []);
});
test("registry: Wise is described as an embedded flow, not a card checkout", () => {
  assert.equal(reg.getProvider("wise").capabilities.flow, "embedded");
  assert.equal(reg.getProvider("nope"), null);
});
test("registry: every operation on a placeholder throws instead of pretending to succeed", async () => {
  const w = reg.getProvider("wise");
  for (const call of [() => w.createCheckout({}), () => w.getCheckoutStatus("x"), () => w.handleWebhook("{}", {}), () => w.verifyPayment("x", {}), () => w.refundPayment("x", 1), () => w.reconcilePayment("x")]) {
    await assert.rejects(async () => call(), ProviderNotImplementedError);
  }
});
test("registry: availablePaymentMethods filters (implemented, enabled, connected, currency) and puts primary first", () => {
  // Simulate future implemented providers by temporarily flipping capabilities.
  const flip = (id, over) => Object.assign(reg.getProvider(id).capabilities, over);
  const restore = [["wise", reg.getProvider("wise").capabilities.implemented, reg.getProvider("wise").capabilities.supportedCurrencies],
                   ["paypal", false, null]];
  try {
    flip("wise", { implemented: true }); flip("paypal", { implemented: true, supportedCurrencies: ["USD"] });
    const cfg = (provider, o = {}) => ({ provider, status: "connected", isEnabled: true, isPrimary: false, ...o });
    const out = reg.availablePaymentMethods([cfg("paypal"), cfg("wise", { isPrimary: true })], "usd");
    assert.deepEqual(out.map((m) => m.provider), ["wise", "paypal"]);
    assert.deepEqual(reg.availablePaymentMethods([cfg("paypal"), cfg("wise", { isPrimary: true })], "KES").map((m) => m.provider), ["wise"]); // paypal can't do KES
    assert.deepEqual(reg.availablePaymentMethods([cfg("wise", { status: "not_connected" }), cfg("paypal", { isEnabled: false })], "USD"), []);
  } finally { for (const [id, impl, cur] of restore) flip(id, { implemented: impl, supportedCurrencies: cur }); }
});
