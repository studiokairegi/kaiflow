import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as core from "../../supabase/functions/_shared/paystack_core.ts";

test("toMinor rounds halves away from zero without binary noise", () => {
  assert.equal(core.toMinor(1.005), 101);
  assert.equal(core.toMinor(8.325), 833);
  assert.equal(core.toMinor(1.15), 115);
  assert.equal(core.toMinor(1500.5), 150050);
  assert.equal(core.toMinor(0), 0);
  assert.equal(core.toMinor("19.99"), 1999);
  assert.equal(core.toMinor(-1.005), -101);
});

test("refund events: two different refunds of one charge get different keys; a retry gets the same key", async () => {
  const mk = (amount, refund_reference = null) => ({ event: "refund.processed", data: { transaction_reference: "KRL-L-X", refund_reference, amount, currency: "KES", status: "processed" } });
  const key = (p) => core.webhookEventKey(JSON.stringify(p), p);
  const a = mk("5000"), b = mk("2000");
  assert.notEqual(await key(a), await key(b));
  assert.equal(await key(a), await key(mk("5000")));                       // identical retry collapses
  assert.equal(await key(mk("5000", "RF-1")), "refund.processed:RF-1");
  assert.notEqual(await key(mk("5000", "RF-1")), await key(mk("5000", "RF-2")));
});

test("charge and id-bearing events keep their old keys", async () => {
  const p = { event: "charge.success", data: { id: 42, reference: "R" } };
  assert.equal(await core.webhookEventKey("{}", p), "charge.success:42");
  const q = { event: "charge.success", data: { reference: "R" } };
  assert.equal(await core.webhookEventKey("{}", q), "charge.success:R");
});

test("bank transfer is refused everywhere on the server side", () => {
  assert.equal(core.channelsFor("bank_transfer"), null);
  assert.ok(!core.PAYSTACK_CHANNELS.includes("bank_transfer"));
  const mig = fs.readFileSync(new URL("../../supabase/migrations/20270112090000_remove_bank_transfer_channel.sql", import.meta.url), "utf8");
  assert.match(mig, /c not in \('card', 'apple_pay'\)/);
  assert.match(mig, /<> 'bank_transfer'/);
});

test("webhook and FX failures are logged, not swallowed", () => {
  const wh = fs.readFileSync(new URL("../../supabase/functions/paystack-webhook/index.ts", import.meta.url), "utf8");
  const co = fs.readFileSync(new URL("../../supabase/functions/paystack-checkout/index.ts", import.meta.url), "utf8");
  assert.match(wh, /could not record event status/);
  assert.match(co, /checkout FX refresh failed \(network\)/);
});
