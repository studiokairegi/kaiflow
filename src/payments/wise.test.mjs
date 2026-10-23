import test from "node:test";
import assert from "node:assert/strict";
import { normalizePhone, validateWiseSettings, isWiseOffered, orderMethods, wiseInstructions } from "./wise.js";

test("phone normalisation validates instead of blindly prepending", () => {
  assert.equal(normalizePhone("+254", "0712345678"), "+254712345678");
  assert.equal(normalizePhone("+254", "0112345678"), "+254112345678");
  assert.equal(normalizePhone("+254", "712 345 678"), "+254712345678");
  assert.equal(normalizePhone("+254", "+254 712-345-678"), "+254712345678");
  assert.equal(normalizePhone("+254", "254712345678"), "+254712345678");
  assert.equal(normalizePhone("+254", "00254712345678"), "+254712345678");
  assert.equal(normalizePhone("+255", "0754123456"), "+255754123456");        // another country's code is respected
  for (const bad of ["", "abc", "0612345678", "071234567", "07123456789", "+2547123", "+999", "0712 34x678"]) assert.equal(normalizePhone("+254", bad), null, bad);
  assert.equal(normalizePhone("254", "0712345678"), null);                      // malformed calling code
});

test("settings: complete only with name, country, provider and a valid number", () => {
  const ok = validateWiseSettings({ recipient_name: "Test Recipient", country: "Kenya", mobile_provider: "M-PESA", calling_code: "+254", phone: "0712345678" });
  assert.ok(ok.complete); assert.equal(ok.normalizedPhone, "+254712345678");
  for (const patch of [{ recipient_name: "" }, { country: " " }, { mobile_provider: "" }, { phone: "" }, { phone: "12" }, { calling_code: "254" }]) {
    const v = validateWiseSettings({ recipient_name: "Test Recipient", country: "Kenya", mobile_provider: "M-PESA", calling_code: "+254", phone: "0712345678", ...patch });
    assert.ok(!v.complete, JSON.stringify(patch)); assert.ok(Object.keys(v.errors).length >= 1);
  }
  assert.ok(!validateWiseSettings({}).complete);                                // nothing is invented as a default recipient
});

test("Wise is hidden unless the server lists it, and is always the last option", () => {
  const paystack = [{ provider: "paystack", channel: "card", enabled: true }, { provider: "paystack", channel: "bank_transfer", enabled: true }];
  assert.ok(!isWiseOffered(paystack));
  assert.ok(!isWiseOffered([...paystack, { provider: "wise", enabled: false }]));
  const mixed = [{ provider: "wise", channel: "wise", enabled: true }, ...paystack];
  assert.ok(isWiseOffered(mixed));
  assert.deepEqual(orderMethods(mixed).map((m) => m.provider), ["paystack", "paystack", "wise"]);
});

test("instructions state facts and warnings without inventing a fee, rate or amount", () => {
  const t = { country: "Kenya", mobile_provider: "M-PESA", recipient_name: "Test Recipient", phone: "+254712345678" };
  const { steps, warnings } = wiseInstructions(t);
  const text = [...steps, ...warnings].join(" ");
  assert.ok(text.includes("Kenya") && text.includes("+254712345678") && text.includes("Test Recipient"));
  assert.match(text, /check the amount, fees and exchange rate/i);
  assert.match(text, /does not pass a reference/i);
  assert.doesNotMatch(text, /\d+(\.\d+)?\s?%/);                                  // no made-up percentage fee
});
