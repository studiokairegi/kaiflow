import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { flowLines, ensureSpace, invoicePdfFileName, PDF_PAGE_TOP, PDF_PAGE_BOTTOM } from "./invoicePdfLayout.js";
import { invoiceT } from "./i18n/invoiceStrings.js";
import { normalizeLang, formatDocDate } from "./i18n/languages.js";

// Minimal jsPDF stand-in that records where text lands.
class FakeDoc {
  constructor() { this.page = 1; this.size = 10; this.draws = []; this.saved = null; this.internal = { scaleFactor: 72 / 25.4 }; }
  getFontSize() { return this.size; }
  getLineHeightFactor() { return 1.15; }
  setFontSize(n) { this.size = n; }
  setTextColor() {} setDrawColor() {} setFillColor() {} line() {} link() {} roundedRect() {} rect() {}
  addPage() { this.page += 1; }
  splitTextToSize(text, width) { const per = Math.max(10, Math.floor(width / 2)); const out = []; for (let i = 0; i < String(text).length; i += per) out.push(String(text).slice(i, i + per)); return out.length ? out : [""]; }
  text(t, x, y) {
    const lh = (this.size * 1.15) / (72 / 25.4);
    (Array.isArray(t) ? t : [t]).forEach((line, i) => this.draws.push({ page: this.page, text: String(line), x, y: y + i * lh }));
  }
  save(name) { this.saved = name; }
}

test("flowLines keeps a block that fits on one page exactly where the fixed layout put it", () => {
  const d = new FakeDoc();
  assert.equal(flowLines(d, ["a", "b", "c"], 20, 100, { pitch: 6 }), 118);
  assert.equal(d.page, 1);
});

test("flowLines breaks long blocks across pages and never draws below the bottom margin", () => {
  const d = new FakeDoc();
  const end = flowLines(d, Array.from({ length: 200 }, (_, i) => `line ${i}`), 20, 60, { pitch: 6 });
  assert.ok(d.page > 1);
  assert.equal(d.draws.length, 200);
  assert.ok(d.draws.every((x) => x.y <= PDF_PAGE_BOTTOM + 0.001));
  assert.ok(end >= PDF_PAGE_TOP);
});

test("ensureSpace only adds a page when the block would not fit", () => {
  const d = new FakeDoc();
  assert.equal(ensureSpace(d, 100, 20), 100);
  assert.equal(d.page, 1);
  assert.equal(ensureSpace(d, 270, 20), PDF_PAGE_TOP);
  assert.equal(d.page, 2);
});

test("PDF file name is the document reference, sanitised, with sensible fallbacks", () => {
  assert.equal(invoicePdfFileName({ invoiceNumber: "INV-0007" }), "INV-0007.pdf");
  assert.equal(invoicePdfFileName({ invoiceNumber: " PRO/2026:001 " }), "PRO-2026-001.pdf");
  assert.equal(invoicePdfFileName({ invoiceNumber: "" }, { paystackRef: "KRL-L-1" }), "KRL-L-1.pdf");
  assert.equal(invoicePdfFileName({}, { fallback: "invoice" }), "invoice.pdf");
  assert.equal(invoicePdfFileName({ invoiceNumber: "請求書 0001" }), "請求書 0001.pdf");
});

// Run the real downloadInvoicePDF from App.jsx against the fake doc.
function loadDownload(doc, extra = {}) {
  const src = fs.readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
  const i = src.indexOf("async function downloadInvoicePDF");
  const j = src.indexOf("\nfunction cardFromRow");
  const body = src.slice(i, j).replace('await import("jspdf")', "({ jsPDF: function () { return __fakeDoc; } })");
  const parseMoney = (v) => Number(String(v ?? "").replace(/[^0-9.-]/g, "")) || 0;
  const formatMoney = (v) => parseMoney(v).toFixed(2);
  const deps = {
    normalizeLang, invoiceT, formatDocDate, parseMoney, formatMoney, __fakeDoc: doc,
    useJapaneseFont: async () => {}, wrapMixed: (d, t, w) => d.splitTextToSize(t, w),
    DEFAULT_SETTINGS: {}, invoiceRefFor: () => "", createCheckoutSession: async () => ({}),
    requestPayLink: async () => ({ ok: false }), drawPayNowButton: () => {}, payLinkFailureNotice: () => "", console: { warn() {} },
    flowLines, ensureSpace, invoicePdfFileName, PDF_PAGE_TOP, PDF_PAGE_BOTTOM,
    window: { location: { origin: "https://example.test" } }, ...extra,
  };
  const names = Object.keys(deps);
  return new Function(...names, `${body}\nreturn downloadInvoicePDF;`)(...names.map((n) => deps[n]));
}

const baseInvoice = { id: "i1", invoiceNumber: "INV-0007", docType: "invoice", language: "en", amountMode: "manual", amount: "500", amountPaid: "0", currency: "$", issueDate: "2026-11-15", dueDate: "2026-12-15", status: "unpaid", description: "Cleanup" };
const project = { client: "Acme", name: "Spot" };
const settings = { studioName: "Studio", invoicePaymentInstructions: "Pay by bank transfer.", invoiceFooterNote: "Thanks" };

test("short invoice stays on one page, prints its reference number and is named after it", async () => {
  const doc = new FakeDoc();
  await loadDownload(doc)(baseInvoice, project, settings);
  assert.equal(doc.page, 1);
  assert.ok(doc.draws.some((d) => d.text === "Reference no.: INV-0007"));
  assert.equal(doc.saved, "INV-0007.pdf");
});

test("60 line items flow onto extra pages; nothing is drawn off the page and the totals stay together", async () => {
  const doc = new FakeDoc();
  const lineItems = Array.from({ length: 60 }, (_, i) => ({ id: `l${i}`, description: `Shot ${i} cleanup and compositing`, qty: "1", unitPrice: "10" }));
  await loadDownload(doc)({ ...baseInvoice, amountMode: "items", lineItems, amount: "600" }, project, settings);
  assert.ok(doc.page >= 2);
  assert.ok(doc.draws.every((d) => d.y <= PDF_PAGE_BOTTOM + 0.001), "text drawn below the bottom margin");
  const balance = doc.draws.find((d) => d.text === "Balance due");
  const subtotal = doc.draws.find((d) => d.text === "Subtotal");
  assert.equal(balance.page, subtotal.page);
  assert.ok(doc.draws.filter((d) => d.text === "Description").length >= 2, "column header repeats on continuation pages");
});

test("a very long single-amount description flows instead of overflowing", async () => {
  const doc = new FakeDoc();
  await loadDownload(doc)({ ...baseInvoice, description: "x".repeat(5000) }, project, settings);
  assert.ok(doc.page >= 2);
  assert.ok(doc.draws.every((d) => d.y <= PDF_PAGE_BOTTOM + 0.001));
  assert.ok(doc.draws.some((d) => d.text === "Balance due"));
});

test("Japanese invoice prints the localised reference label", async () => {
  const doc = new FakeDoc();
  await loadDownload(doc)({ ...baseInvoice, language: "ja" }, project, settings);
  assert.ok(doc.draws.some((d) => d.text === "書類番号: INV-0007"));
});
