import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { splitMilestoneAmounts } from "./milestoneSplit.js";
import { fetchAllPages } from "./pagedFetch.js";
import { nextInvoiceNumber } from "./invoiceNumbering.js";

test("milestone amounts add up to the budget to the cent", () => {
  for (const [budget, pcts] of [[100, [33.33, 33.33, 33.34]], [100, [33.33, 33.33, 33.33, 0.01]], [0.05, [50, 50]], [1000.01, [30, 40, 30]], [99.99, [33.33, 33.33, 33.34]]]) {
    const out = splitMilestoneAmounts(budget, pcts);
    assert.equal(Math.round(out.reduce((a, b) => a + b, 0) * 100), Math.round(budget * 100), `${budget} ${pcts}`);
  }
  assert.deepEqual(splitMilestoneAmounts(100, [50, 50]), [50, 50]);
});
test("a split that is not 100% just rounds each milestone", () => {
  assert.deepEqual(splitMilestoneAmounts(200, [30, 20]), [60, 40]);
  assert.deepEqual(splitMilestoneAmounts(0, [50, 50]), [0, 0]);
});

test("fetchAllPages reads past the 1000-row cap, in order", async () => {
  const rows = Array.from({ length: 2300 }, (_, i) => ({ id: i }));
  let calls = 0;
  const build = () => ({ range: async (a, b) => { calls++; return { data: rows.slice(a, b + 1), error: null }; } });
  const { data, error } = await fetchAllPages(build, 1000);
  assert.equal(error, null); assert.equal(data.length, 2300); assert.equal(data.at(-1).id, 2299); assert.equal(calls, 3);
});
test("fetchAllPages stops on an exact page boundary and reports errors", async () => {
  const rows = Array.from({ length: 2000 }, (_, i) => i);
  const r = await fetchAllPages(() => ({ range: async (a, b) => ({ data: rows.slice(a, b + 1), error: null }) }), 1000);
  assert.equal(r.data.length, 2000);
  const bad = await fetchAllPages(() => ({ range: async () => ({ data: null, error: { message: "x" } }) }));
  assert.equal(bad.data, null); assert.equal(bad.error.message, "x");
});

test("a year-style reference does not push the next number to the next year", () => {
  assert.equal(nextInvoiceNumber([{ invoiceNumber: "INV-2026" }]), "INV-0001");
  assert.equal(nextInvoiceNumber([{ invoiceNumber: "INV-2026" }, { invoiceNumber: "INV-0007" }]), "INV-0008");
  assert.equal(nextInvoiceNumber([{ invoiceNumber: "INV-0099" }]), "INV-0100");
});

test("bank transfer is no longer offered at checkout or in the provider settings", () => {
  const checkout = fs.readFileSync(new URL("./payments/PayCheckoutPage.jsx", import.meta.url), "utf8");
  const tab = fs.readFileSync(new URL("./payments/ProvidersTab.jsx", import.meta.url), "utf8");
  assert.match(checkout, /m\.channel !== "bank_transfer"/);
  assert.doesNotMatch(tab.match(/const CHANNEL_LABELS = .*/)[0], /bank_transfer/);
});
