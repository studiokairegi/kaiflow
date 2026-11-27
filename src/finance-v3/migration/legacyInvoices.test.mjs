import test from "node:test";
import assert from "node:assert/strict";
import { validateLegacyInvoice, previewLegacyBatch, mapLegacyCurrency } from "./legacyInvoices.js";

const base = { source_id: "L1", invoice_number: "OLD-1", client_name: "Legacy Client", currency: "KES", amount: "1000.00", amount_paid: "400.00", issue_date: "2026-01-10", due_date: "2026-02-10", status: "sent" };

test("an open invoice becomes an opening-balance import; a paid one becomes a historical document", () => {
  assert.deepEqual(validateLegacyInvoice(base), { status: "valid", mode: "opening_balance", errors: [] });
  assert.deepEqual(validateLegacyInvoice({ ...base, status: "paid", amount_paid: "1000.00" }), { status: "valid", mode: "document_only", errors: [] });
});

test("nothing is fabricated: ambiguous symbols, bad numbers, impossible dates and contradictory statuses are errors", () => {
  const bad = (over, text) => { const r = validateLegacyInvoice({ ...base, ...over }); assert.equal(r.status, "invalid", text); assert.ok(r.errors.some((e) => e.includes(text)), `${text}: ${r.errors}`); };
  bad({ currency: "KSh" }, "legacy symbols must be mapped");
  bad({ currency: "$" }, "legacy symbols must be mapped");
  bad({ amount: "10.005" }, "more decimals");
  bad({ amount: "1e3" }, "not a valid decimal");
  bad({ amount: "0" }, "above zero");
  bad({ amount_paid: "2000.00" }, "larger than amount");
  bad({ issue_date: "2026-02-31" }, "issue_date");
  bad({ due_date: "2026-01-01" }, "before issue_date");
  bad({ status: "paid", amount_paid: "10.00" }, "marked paid but amount_paid is lower");
  bad({ status: "sent", amount_paid: "1000.00" }, "already fully paid");
  bad({ status: "weird" }, "unknown legacy status");
  bad({ client_name: " " }, "client_name");
  bad({ invoice_number: "" }, "invoice_number");
});

test("drafts and cancelled invoices are skipped, not imported and not errors", () => {
  for (const s of ["draft", "cancelled", "void"]) assert.equal(validateLegacyInvoice({ ...base, status: s }).status, "skipped");
});

test("the operator-supplied mapping resolves a symbol; without it the record is invalid", () => {
  assert.equal(mapLegacyCurrency("KSh", { KSh: "kes" }), "KES");
  assert.equal(mapLegacyCurrency("usd"), "USD");
  const r = previewLegacyBatch([{ ...base, currency: "KSh" }], { symbolMap: { KSh: "KES" } });
  assert.equal(r.results[0].status, "valid");
  assert.equal(previewLegacyBatch([{ ...base, currency: "KSh" }]).results[0].status, "invalid");
});

test("duplicates are detected against V3 and inside the batch (first wins), and totals use exact integer minor units", () => {
  const recs = [base, { ...base, source_id: "L2", invoice_number: "OLD-1" }, { ...base, source_id: "L3", invoice_number: "OLD-3", amount: "0.30", amount_paid: "0.10" }, { ...base, source_id: "L4", invoice_number: "OLD-4" }];
  const r = previewLegacyBatch(recs, { existing: { sourceIds: new Set(["L4"]), invoiceNumbers: new Set() } });
  assert.deepEqual(r.results.map((x) => x.status), ["valid", "duplicate", "valid", "duplicate"]);
  assert.deepEqual(r.counts, { valid: 2, duplicate: 2 });
  assert.equal(r.openingBalanceMinor.KES, String(60000 + 20), "600.00 + 0.20 with no floating point drift");
});
