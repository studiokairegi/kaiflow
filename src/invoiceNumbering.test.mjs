import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ownedInvoices, isInvoiceNumberTaken, nextInvoiceNumber, nextInvoiceNumbers } from "./invoiceNumbering.js";

const inv = (projectId, invoiceNumber, ownerUserId = "u1") => ({ projectId, invoiceNumber, ownerUserId });

test("a second project is never suggested a reference another project already uses", () => {
  const all = [inv("A", "INV-0001"), inv("A", "INV-0002")];
  assert.equal(nextInvoiceNumber(all, "INV"), "INV-0003");
});

test("numbers continue across document types and skip references already taken", () => {
  const all = [inv("A", "PRO-0004"), inv("B", "INV-0002")];
  assert.equal(nextInvoiceNumber(all, "REC"), "REC-0005");
  assert.deepEqual(nextInvoiceNumbers(all, 3, "INV"), ["INV-0005", "INV-0006", "INV-0007"]);
});

test("a suggestion never equals an existing reference (case-insensitive), even with gaps and odd formats", () => {
  const all = [inv("A", "inv-0003"), inv("B", "INV-0001"), inv("C", "INV-2026-001")];
  for (const n of nextInvoiceNumbers(all, 10, "INV")) assert.equal(isInvoiceNumberTaken(all, n), false);
  assert.equal(new Set(nextInvoiceNumbers(all, 10, "INV")).size, 10);
});

test("empty list starts at 0001", () => {
  assert.equal(nextInvoiceNumber([], "INV"), "INV-0001");
  assert.deepEqual(nextInvoiceNumbers(undefined, 2, "PRO"), ["PRO-0001", "PRO-0002"]);
});

test("only invoices owned by the current user count (uniqueness is per user_id)", () => {
  const all = [inv("A", "INV-0001", "u1"), inv("B", "INV-0009", "u2"), { projectId: "C", invoiceNumber: "INV-0002" }];
  assert.deepEqual(ownedInvoices(all, "u1").map((i) => i.invoiceNumber), ["INV-0001", "INV-0002"]);
  assert.equal(nextInvoiceNumber(ownedInvoices(all, "u1"), "INV"), "INV-0003");
});

test("regression: App.jsx never numbers from a single project's invoices", () => {
  const src = fs.readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
  assert.ok(!/nextInvoiceNumbers?\(\s*invoices\.filter/.test(src), "numbering must use ownInvoices, not a project filter");
  assert.ok(!/nextInvoiceNumbers?\(\s*projectInvoices/.test(src));
  assert.ok(/const ownInvoices = ownedInvoices\(invoices, userId\)/.test(src));
  assert.ok(/e\?\.code === "23505"[^\n]*milestone/i.test(src), "milestone creation must explain a duplicate reference");
});
