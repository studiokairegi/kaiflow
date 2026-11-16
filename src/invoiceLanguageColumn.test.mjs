import test from "node:test";
import assert from "node:assert/strict";
import { invoiceLanguageFields, rowHasLanguageColumn } from "./invoiceLanguageColumn.js";
import { payLinkFailureNotice, requestPayLink } from "./payments/pdfPayLink.js";

test("row from an unmigrated database has no language column", () => {
  assert.equal(rowHasLanguageColumn({ id: "1", invoice_number: "INV-1" }), false);
  assert.equal(rowHasLanguageColumn({ id: "1", language: "en" }), true);
  assert.equal(rowHasLanguageColumn(null), false);
});

test("existing invoice loaded without the column sends no language (frontend-before-migration)", () => {
  assert.deepEqual(invoiceLanguageFields({ id: "1", language: "en", languageColumn: false }), {});
  assert.deepEqual(invoiceLanguageFields({ id: "1", language: "ja" }), {});
});

test("existing invoice loaded with the column sends its language", () => {
  assert.deepEqual(invoiceLanguageFields({ id: "1", language: "en", languageColumn: true }), { language: "en" });
  assert.deepEqual(invoiceLanguageFields({ id: "1", language: "JA-jp", languageColumn: true }), { language: "ja" });
});

test("new English invoice omits language; new Japanese invoice sends it", () => {
  assert.deepEqual(invoiceLanguageFields({ language: "en" }), {});
  assert.deepEqual(invoiceLanguageFields({}), {});
  assert.deepEqual(invoiceLanguageFields({ language: "ja" }), { language: "ja" });
});

test("a failed pay-link request surfaces its reason", async () => {
  const inv = { id: "i1", docType: "invoice", language: "en" };
  const result = await requestPayLink(inv, 100, { create: async () => { throw new Error("boom"); }, origin: "https://x.test" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "create_failed");
  assert.match(payLinkFailureNotice(inv, 100, result), /without a Pay Now button/);
  assert.match(payLinkFailureNotice(inv, 100, result), /could not be created/);
});

test("no notice when not payable by design or when the link worked", () => {
  assert.equal(payLinkFailureNotice({ id: "i1", docType: "receipt" }, 100, { ok: false, reason: "not_payable" }), "");
  assert.equal(payLinkFailureNotice({ id: "i1", docType: "invoice" }, 0, { ok: false, reason: "not_payable" }), "");
  assert.equal(payLinkFailureNotice({ id: "i1", docType: "invoice" }, 100, { ok: true, url: "u" }), "");
});
