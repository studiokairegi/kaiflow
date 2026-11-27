import test from "node:test";
import assert from "node:assert/strict";
import { groupMoney, fmtMoney, isNegative, isZero, parseMoneyInput, fmtDate, addDaysISO, label, INVOICE_STATUS, EMAIL_STATUS, EMAIL_STATUS_HELP, newKey } from "./format.js";
import { friendlyError, isProtectionBlock, isNotAuthorized } from "./errors.js";

test("money is formatted as text with no floating point", () => {
  assert.equal(groupMoney("1234567.50"), "1,234,567.50"); assert.equal(fmtMoney("2400.00", "KES"), "KES 2,400.00"); assert.equal(fmtMoney(null, "KES"), "—");
  assert.equal(groupMoney("12345678901234567890.12"), "12,345,678,901,234,567,890.12", "beyond double precision stays exact");
  assert.equal(isNegative("-5.00"), true); assert.equal(isNegative("-0.00"), false); assert.equal(isZero("0.00"), true); assert.equal(isZero("0.01"), false);
});
test("money input accepts plain or grouped decimals and rejects everything else", () => {
  assert.deepEqual(parseMoneyInput("1,250.50"), { ok: true, value: "1250.50" }); assert.deepEqual(parseMoneyInput(" 12 "), { ok: true, value: "12" });
  for (const bad of ["", "abc", "-5", "1.2.3", "1e3", "0", "1.23456", "NaN", "Infinity"]) assert.equal(parseMoneyInput(bad).ok, false, bad);
  assert.equal(parseMoneyInput("0", { allowZero: true }).ok, true);
});
test("dates are exact calendar arithmetic", () => { assert.equal(addDaysISO("2026-12-30", 5), "2027-01-04"); assert.equal(addDaysISO("2028-02-28", 1), "2028-02-29"); assert.equal(fmtDate("2026-11-25"), "25 Nov 2026"); assert.equal(fmtDate(null), "—"); });
test("every email status has plain-language help", () => { for (const k of Object.keys(EMAIL_STATUS)) assert.ok(EMAIL_STATUS_HELP[k] && EMAIL_STATUS_HELP[k].length > 10, k); });
test("labels fall back to readable text for unknown keys", () => { assert.equal(label(INVOICE_STATUS, "issued"), "Sent / unpaid"); assert.equal(label({}, "payment_attempt"), "Payment attempt"); });
test("idempotency keys are unique", () => { assert.notEqual(newKey("a"), newKey("a")); });
test("errors are explained in plain words and never leak internals", () => {
  assert.match(friendlyError({ code: "V3005" }), /permission/); assert.ok(isProtectionBlock({ code: "V3007" })); assert.ok(isNotAuthorized({ code: "V3005" }));
  assert.doesNotMatch(friendlyError(new Error("select * from finance_v3.x failed at line 4")), /select|finance_v3/); assert.ok(friendlyError(null).length > 5);
});
