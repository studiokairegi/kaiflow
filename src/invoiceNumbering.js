// Invoice reference numbering.
//
// The database enforces ONE reference per user across ALL of that user's projects
// (unique index invoices_user_number_uniq on invoices(user_id, invoice_number), migration_settings_v2.sql).
// Numbers must therefore be chosen from every invoice the user owns, never from a single project's invoices:
// a per-project list suggests INV-0001 again for the second project and the save fails with 23505.

const norm = (n) => String(n ?? "").trim().toLowerCase();

// Rows that belong to this user (the unique index is per user_id). Rows shared in from another studio owner
// have a different user_id and cannot collide with a number this user creates.
export function ownedInvoices(invoices, userId) {
  return (Array.isArray(invoices) ? invoices : []).filter((i) => !i?.ownerUserId || !userId || i.ownerUserId === userId);
}

export function isInvoiceNumberTaken(invoices, number) {
  const n = norm(number);
  if (!n) return false;
  return (Array.isArray(invoices) ? invoices : []).some((i) => norm(i?.invoiceNumber) === n);
}

// A reference that is just a prefix plus a calendar year ("INV-2026") is a year label, not sequence number 2026,
// so it must not push the next suggestion to INV-2027. Zero-padded sequence numbers (INV-0007) are never years.
const YEAR_LABEL = /^[A-Za-z]*[-_ /]?(?:19|20)\d{2}$/;
const trailingNumber = (ref) => {
  const text = String(ref || "").trim();
  if (YEAR_LABEL.test(text)) return 0;
  const m = text.match(/(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
};

// `count` consecutive free references with the given prefix, e.g. ["INV-0004", "INV-0005"].
// Starts after the highest trailing number in use and also skips any reference that is already taken.
export function nextInvoiceNumbers(invoices, count, prefix = "INV") {
  const list = Array.isArray(invoices) ? invoices : [];
  const taken = new Set(list.map((i) => norm(i?.invoiceNumber)));
  let n = list.reduce((m, i) => Math.max(m, trailingNumber(i?.invoiceNumber)), 0);
  const out = [];
  while (out.length < count) {
    n += 1;
    const candidate = `${prefix}-${String(n).padStart(4, "0")}`;
    if (taken.has(norm(candidate))) continue;
    taken.add(norm(candidate));
    out.push(candidate);
  }
  return out;
}

export const nextInvoiceNumber = (invoices, prefix = "INV") => nextInvoiceNumbers(invoices, 1, prefix)[0];
