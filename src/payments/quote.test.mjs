import test from "node:test";
import assert from "node:assert/strict";
import { convertAmount, describeRate, ccyDecimals, toMinorUnits, parseDecimal, quoteSecondsLeft, quoteIsLive, needsRequote } from "./quote.js";

test("minor units: JPY has none, KES has two", () => { assert.equal(ccyDecimals("JPY"), 0); assert.equal(ccyDecimals("KES"), 2); });

test("conversion is exact decimal maths, rounded half-up to the charge currency's minor unit", () => {
  assert.equal(convertAmount("150000", "0.8512345678", "KES"), "127685.19");
  assert.equal(convertAmount("100", "0.125", "KES"), "12.50");
  assert.equal(convertAmount("0.01", "0.5", "KES"), "0.01");             // 0.005 rounds up
  assert.equal(convertAmount("0.01", "0.49", "KES"), "0.00");
  assert.equal(convertAmount("10", "0.1", "JPY"), "1");
  assert.equal(convertAmount("1000.10", "129.5", "KES"), "129512.95");  // float maths would drift here
});

test("rate direction is spelled out: base -> quote", () => {
  assert.equal(describeRate("JPY", "KES", "0.8512345678"), "1 JPY = 0.8512 KES");
  assert.equal(describeRate("USD", "KES", "129.5"), "1 USD = 129.5000 KES");
  assert.match(describeRate("KES", "JPY", "1.1747"), /^1 KES = 1\.1747 JPY$/);
});

test("partial payment converts the amount paid now, not the whole balance", () => {
  const rate = "0.8512345678";
  const part = convertAmount("40000", rate, "KES");
  assert.equal(part, "34049.38");
  assert.notEqual(part, convertAmount("150000", rate, "KES"));
});

test("invalid inputs are rejected, never coerced", () => {
  for (const bad of ["", "abc", "-5", "1e3", "1,000", null]) assert.throws(() => parseDecimal(bad));
  assert.throws(() => convertAmount("0", "1", "KES"));
  assert.throws(() => convertAmount("5", "0", "KES"));
  assert.throws(() => toMinorUnits("10.5", "JPY"));
  assert.equal(toMinorUnits("1500.5", "KES"), 150050n);
});

test("quote expiry and the requote codes", () => {
  const now = Date.parse("2026-10-24T10:00:00Z");
  const q = { expires_at: "2026-10-24T10:15:00Z" };
  assert.equal(quoteSecondsLeft(q, now), 900); assert.ok(quoteIsLive(q, now));
  assert.ok(!quoteIsLive(q, now + 900_000)); assert.ok(!quoteIsLive(null, now)); assert.equal(quoteSecondsLeft({}, now), 0);
  for (const c of ["quote_expired", "quote_superseded", "quote_invalid", "quote_used", "quote_required"]) assert.ok(needsRequote(c));
  assert.ok(!needsRequote("not_payable"));
});
