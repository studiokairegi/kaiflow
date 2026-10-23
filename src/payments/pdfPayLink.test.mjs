import test from "node:test";
import assert from "node:assert/strict";
import { payLinkEligible, isValidPayUrl, requestPayLink, drawPayNowButton } from "./pdfPayLink.js";

const TOKEN = "c".repeat(64);
const inv = { id: "i1", docType: "invoice", currency: "¥", amount: "150000", amountPaid: "0" };
const fakeDoc = () => { const calls = []; return new Proxy({ calls }, { get: (t, k) => (k === "calls" ? calls : (...a) => { calls.push([k, ...a]); }) }); };

test("only unpaid invoices and proformas get a link; receipts and settled documents do not", () => {
  assert.ok(payLinkEligible(inv, 150000));
  assert.ok(payLinkEligible({ ...inv, docType: "proforma" }, 10));
  assert.ok(!payLinkEligible({ ...inv, docType: "receipt" }, 100));
  assert.ok(!payLinkEligible(inv, 0));
  assert.ok(!payLinkEligible({ ...inv, id: undefined }, 100));
});

test("URL shape: https /pay/{64 hex}, nothing else", () => {
  assert.ok(isValidPayUrl(`https://studiokairegi.com/pay/${TOKEN}`));
  assert.ok(isValidPayUrl(`http://localhost:5173/pay/${TOKEN}`));
  for (const bad of [`http://studiokairegi.com/pay/${TOKEN}`, `https://studiokairegi.com/pay/${TOKEN}?x=1`, `https://studiokairegi.com/pay/${TOKEN}#a`, "https://studiokairegi.com/pay/abc", `https://studiokairegi.com/invoice/i1`, "javascript:alert(1)", "", "nope"]) assert.ok(!isValidPayUrl(bad), bad);
});

test("link comes from the existing session RPC (invoice id in, token out); the URL is built from the returned token", async () => {
  const seen = [];
  const r = await requestPayLink(inv, 150000, { origin: "https://studiokairegi.com", create: async (...a) => { seen.push(a); return { token: TOKEN, expires_at: "2026-11-07T00:00:00Z" }; } });
  assert.deepEqual(seen, [["i1", null, 14]]);
  assert.deepEqual(r, { ok: true, url: `https://studiokairegi.com/pay/${TOKEN}`, expiresAt: "2026-11-07T00:00:00Z" });
});

test("failure to create a link never produces a URL", async () => {
  const origin = "https://studiokairegi.com";
  assert.deepEqual((await requestPayLink(inv, 100, { origin, create: async () => { throw new Error("Connect Paystack Live first"); } })).ok, false);
  assert.equal((await requestPayLink(inv, 100, { origin, create: async () => ({ token: "short" }) })).ok, false);
  assert.equal((await requestPayLink(inv, 100, { origin, create: async () => ({}) })).ok, false);
  let called = false;
  const r = await requestPayLink({ ...inv, docType: "receipt" }, 100, { origin, create: async () => { called = true; return { token: TOKEN }; } });
  assert.equal(r.ok, false); assert.equal(called, false);
});

test("the button is a real PDF link annotation over the drawn rectangle, and a bad URL draws nothing", () => {
  const doc = fakeDoc();
  const url = `https://studiokairegi.com/pay/${TOKEN}`;
  const y = drawPayNowButton(doc, url, { x: 20, y: 200 });
  const link = doc.calls.find((c) => c[0] === "link");
  assert.deepEqual(link, ["link", 20, 200, 46, 11, { url }]);
  assert.ok(doc.calls.some((c) => c[0] === "roundedRect" && c[1] === 20 && c[2] === 200));
  assert.ok(doc.calls.some((c) => c[0] === "text" && c[1] === "Pay Now"));
  assert.equal(y, 211);
  const none = fakeDoc();
  assert.equal(drawPayNowButton(none, "https://evil.example/x", { x: 1, y: 2 }), 2);
  assert.equal(none.calls.length, 0);
});
