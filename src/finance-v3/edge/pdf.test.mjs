import test from "node:test";
import assert from "node:assert/strict";
import { renderInvoicePdf, renderReceiptPdf, pdfSafeText, groupDecimal, toBase64, fromBase64, textWidth } from "../../../supabase/functions/_shared/finance_v3_pdf.ts";

const snap = (over = {}) => ({
  invoice_no: "INV-000001", currency: "KES", issue_date: "2026-11-23", due_date: "2026-12-07",
  studio: { name: "Kairegi Studio", address: "12 Riverside Drive", email: "hello@studio.test", brand_color: "#1F3A5F" },
  client: { name: "Acme (Pty) Ltd", email: "pay@acme.test" },
  lines: [{ line_no: 1, description: "Storyboard", quantity: "3", unit_price: "33.33", discount_pct: "10", tax_rate: "16", net_amount: "89.99" }],
  subtotal: "99.99", discount_total: "10.00", tax_total: "14.40", total: "104.39", notes: "Thanks (really) \\ ok", ...over,
});
const text = (u8) => Buffer.from(u8).toString("latin1");

test("invoice PDF is structurally valid: header, trailer and an xref whose offsets point at their objects", () => {
  const { bytes, pages } = renderInvoicePdf(snap());
  const t = text(bytes);
  assert.ok(t.startsWith("%PDF-1.4"));
  assert.ok(t.trimEnd().endsWith("%%EOF"));
  assert.equal(pages, 1);
  const start = Number(/startxref\n(\d+)\n%%EOF/.exec(t)[1]);
  assert.ok(t.slice(start).startsWith("xref\n"));
  const entries = [...t.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assert.ok(entries.length >= 7);
  entries.forEach((off, i) => assert.ok(t.slice(off).startsWith(`${i + 1} 0 obj`), `object ${i + 1} offset`));
  // every stream /Length is exact
  for (const m of t.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)) assert.equal(Number(m[1]), m[2].length);
});

test("PDF output is deterministic: the same snapshot always yields the same bytes", () => {
  assert.deepEqual(renderInvoicePdf(snap()).bytes, renderInvoicePdf(snap()).bytes);
});

test("amounts are printed exactly as the database wrote them (no recomputation, only digit grouping)", () => {
  const t = text(renderInvoicePdf(snap({ total: "1234567.39" })).bytes);
  assert.match(t, /KES 1,234,567\.39/);
  assert.match(t, /\(KES 14\.40\)/);
  assert.equal(groupDecimal("1234567.5"), "1,234,567.5");     // decimals untouched, never padded or rounded
  assert.equal(groupDecimal("0.50"), "0.50");
  assert.equal(groupDecimal("abc"), "abc");
});

test("text that could break the PDF syntax is escaped; non-Latin-1 becomes a visible question mark", () => {
  const t = text(renderInvoicePdf(snap({ notes: "a (b) \\ c" })).bytes);
  assert.match(t, /a \\\(b\\\) \\\\ c/);
  assert.equal(pdfSafeText("Zoë 日本 \u2019"), "Zoë ?? '");
  assert.equal(pdfSafeText("a\nb\tc"), "a b c");
});

test("long invoices paginate and every line is kept", () => {
  const lines = Array.from({ length: 70 }, (_, i) => ({ line_no: i + 1, description: `Item ${i + 1}`, quantity: "1", unit_price: "10.00", discount_pct: "0", tax_rate: "0", net_amount: "10.00" }));
  const r = renderInvoicePdf(snap({ lines }));
  assert.ok(r.pages >= 3);
  const t = text(r.bytes);
  for (let i = 1; i <= 70; i++) assert.ok(t.includes(`(Item ${i})`), `line ${i}`);
});

test("receipt PDF carries the receipt facts and the remaining balance", () => {
  const { bytes } = renderReceiptPdf({ receipt_no: "RCT-000001", payment_date: "2026-11-23", invoice_no: "INV-000001", currency: "KES", studio: snap().studio, client: snap().client,
    payment_amount: "100.00", payment_method: "bank_transfer", payment_reference: "MPESA-1", invoice_total: "254.39", previously_paid: "0.00", remaining_balance: "154.39", invoice_fully_paid: false });
  const t = text(bytes);
  for (const s of ["RCT-000001", "KES 100.00", "KES 154.39", "MPESA-1", "bank transfer"]) assert.ok(t.includes(s), s);
});

test("base64 helpers round-trip arbitrary bytes and widths are positive", () => {
  const b = new Uint8Array([0, 1, 2, 250, 255, 37, 80]);
  assert.deepEqual(fromBase64(toBase64(b)), b);
  assert.ok(textWidth("Invoice", 10) > 0 && textWidth("Invoice", 10, true) > textWidth("Invoice", 10));
});
