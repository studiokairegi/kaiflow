// Legacy (Finance V2) invoice migration helpers: a DRY-RUN mirror of the database validation, plus the explicit currency-symbol mapping
// the operator must supply. The database (fin3_migration_validate / fin3_migration_import) is authoritative; this module lets an
// operator preview and fix the data BEFORE staging it. Nothing here writes anywhere and nothing is guessed:
//   * legacy invoices store a currency SYMBOL; a symbol is ambiguous ("$"), so the operator provides the mapping, and an unmapped symbol
//     is a validation error rather than a default;
//   * a record that cannot be mapped faithfully is reported with the reason, never repaired silently.
import { MONEY } from "../contracts/index.js";

const DEC = /^(0|[1-9][0-9]{0,14})(\.[0-9]{1,4})?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;
const OPEN = new Set(["sent", "unpaid", "overdue", "partial", "partially_paid", "issued", "pending", "open"]);
const SKIP = new Set(["draft", "cancelled", "canceled", "void", "voided"]);

/** symbolMap: { "KSh": "KES", "$": "USD" } provided by the operator. Returns an ISO code, or the input unchanged if it already is one. */
export function mapLegacyCurrency(value, symbolMap = {}) {
  const v = String(value ?? "").trim();
  // An explicit operator mapping always wins (a symbol such as "KSh" is three letters but is not an ISO code).
  if (Object.prototype.hasOwnProperty.call(symbolMap, v)) return String(symbolMap[v]).toUpperCase();
  return /^[A-Za-z]{3}$/.test(v) ? v.toUpperCase() : v;
}

function validDate(s) {
  if (!ISO_DATE.test(String(s ?? ""))) return null;
  const d = new Date(String(s).slice(0, 10) + "T00:00:00Z");
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== String(s).slice(0, 10) ? null : String(s).slice(0, 10);
}

/** Mirrors finance_v3.legacy_validate. existing = { sourceIds:Set, invoiceNumbers:Set } already present in V3. */
/** @param {any} rec @param {{ symbolMap?: any, supportedCurrencies?: string[], existing?: { sourceIds?: Set<string>, invoiceNumbers?: Set<string> } }} [opts] */
export function validateLegacyInvoice(rec, { symbolMap = {}, supportedCurrencies = Object.keys(/** @type {any} */ (MONEY).minorUnits ?? { KES: 2, USD: 2, EUR: 2, GBP: 2, ZAR: 2, NGN: 2, GHS: 2 }), existing = {} } = {}) {
  const errors = [];
  const sid = String(rec.source_id ?? "").trim(), no = String(rec.invoice_number ?? "").trim();
  if (!sid || sid.length > 100) errors.push("source_id is missing or too long");
  if (!no || no.length > 50) errors.push("invoice_number is missing or longer than 50 characters");
  if (!String(rec.client_name ?? "").trim() || String(rec.client_name).trim().length > 160) errors.push("client_name is missing");
  const ccy = mapLegacyCurrency(rec.currency, symbolMap);
  if (!supportedCurrencies.includes(ccy)) errors.push(`currency "${ccy}" is not an ISO code supported by Finance V3 (legacy symbols must be mapped first)`);
  const dec = supportedCurrencies.includes(ccy) ? (ccy === "JPY" ? 0 : 2) : 2;
  let amount = null, paid = 0;
  if (!DEC.test(String(rec.amount ?? ""))) errors.push("amount is not a valid decimal");
  else if ((String(rec.amount).split(".")[1] || "").length > dec) errors.push("amount has more decimals than the currency allows");
  else { amount = Number(rec.amount); if (amount <= 0) errors.push("amount must be above zero"); }
  if (String(rec.amount_paid ?? "").trim() !== "") { if (!DEC.test(String(rec.amount_paid))) errors.push("amount_paid is not a valid decimal"); else paid = Number(rec.amount_paid); }
  if (amount !== null && paid > amount) errors.push("amount_paid is larger than amount");
  const issue = validDate(rec.issue_date), due = validDate(rec.due_date);
  if (!issue) errors.push("issue_date is not a valid date (YYYY-MM-DD)");
  if (!due) errors.push("due_date is not a valid date (YYYY-MM-DD)");
  if (issue && due && due < issue) errors.push("due_date is before issue_date");
  const status = String(rec.status ?? "").trim().toLowerCase();
  if (SKIP.has(status)) return { status: "skipped", mode: null, errors: [`not eligible: legacy status is ${status}`] };
  let mode = null;
  if (status === "paid") { mode = "document_only"; if (amount !== null && paid < amount) errors.push("marked paid but amount_paid is lower than amount (needs manual review)"); }
  else if (OPEN.has(status)) { mode = "opening_balance"; if (amount !== null && paid >= amount) errors.push("open invoice is already fully paid (needs manual review)"); }
  else errors.push(`unknown legacy status "${status}"`);
  if (errors.length) return { status: "invalid", mode: null, errors };
  if (existing.sourceIds?.has(sid) || existing.invoiceNumbers?.has(no)) return { status: "duplicate", mode, errors: ["already present in Finance V3 (same source id or invoice number)"] };
  return { status: "valid", mode, errors: [] };
}

/** Classifies a whole batch like the database does, including duplicates inside the batch (first occurrence wins). */
export function previewLegacyBatch(records, opts = {}) {
  const seen = new Set();
  const out = records.map((r) => {
    const v = validateLegacyInvoice({ ...r, currency: mapLegacyCurrency(r.currency, opts.symbolMap) }, opts);
    if (v.status === "valid") { const no = String(r.invoice_number).trim(); if (seen.has(no)) return { source_id: r.source_id, status: "duplicate", mode: v.mode, errors: ["another record of this run has the same invoice number"] }; seen.add(no); }
    return { source_id: r.source_id, ...v };
  });
  const counts = {}; for (const r of out) counts[r.status] = (counts[r.status] || 0) + 1;
  // Opening balance that WOULD reach the ledger, per currency, as exact integer minor units (no floating point money).
  const open = {};
  records.forEach((r, i) => { if (out[i].status === "valid" && out[i].mode === "opening_balance") { const c = mapLegacyCurrency(r.currency, opts.symbolMap); open[c] = (open[c] ?? 0n) + toMinor(r.amount) - toMinor(r.amount_paid || "0"); } });
  return { results: out, counts, openingBalanceMinor: Object.fromEntries(Object.entries(open).map(([k, v]) => [k, v.toString()])) };
}
function toMinor(s) { const [i, f = ""] = String(s).split("."); return BigInt(i) * 100n + BigInt((f + "00").slice(0, 2)); }
