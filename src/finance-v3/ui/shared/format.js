// Formatting helpers for the Finance V3 screens. Money is ALWAYS a decimal string: it is grouped and parsed as text, never as a float.
const DEC = /^-?\d+(\.\d+)?$/;

export function groupMoney(v) {
  const m = /^(-?)(\d+)(\.\d+)?$/.exec(String(v ?? "").trim());
  if (!m) return String(v ?? "");
  let frac = m[3] || "";
  if (frac.length > 3) frac = "." + frac.slice(1).replace(/0+$/, "").padEnd(2, "0");   // 4-decimal ledger values show as cents unless they carry more
  return m[1] + m[2].replace(/\B(?=(\d{3})+(?!\d))/g, ",") + frac;
}
export const fmtMoney = (amount, currency) => (amount === null || amount === undefined || amount === "" ? "—" : `${currency ? currency + " " : ""}${groupMoney(amount)}`);
export const isNegative = (v) => typeof v === "string" && v.trim().startsWith("-") && /[1-9]/.test(v);
export const isZero = (v) => typeof v === "string" && DEC.test(v.trim()) && !/[1-9]/.test(v);

// "1,200.5" -> "1200.5" for the database. Returns { ok, value, error }. Never produces a number.
export function parseMoneyInput(text, { allowZero = false, maxDecimals = 4 } = {}) {
  const t = String(text ?? "").replace(/[\s,]/g, "");
  if (t === "") return { ok: false, error: "Enter an amount." };
  if (!/^\d{1,15}(\.\d{1,10})?$/.test(t)) return { ok: false, error: "Use digits only, for example 1200.50." };
  const [, frac = ""] = t.split(".");
  if (frac.length > maxDecimals) return { ok: false, error: `Use at most ${maxDecimals} decimal places.` };
  if (!allowZero && !/[1-9]/.test(t)) return { ok: false, error: "The amount must be more than zero." };
  const value = t.replace(/^0+(?=\d)/, "");
  return { ok: true, value };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "—";
}
export function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
export const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
export const addDaysISO = (iso, n) => { const [y, m, d] = iso.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return t.toISOString().slice(0, 10); };
export const newKey = (prefix = "ui") => `${prefix}-${(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`)}`;

// Plain words for statuses. Technical provider detail is deliberately not shown to ordinary users.
export const INVOICE_STATUS = { draft: "Draft", approved: "Approved", issued: "Sent / unpaid", partially_paid: "Partly paid", paid: "Paid", credited: "Credited", void: "Cancelled" };
export const PAYMENT_VERIFICATION = { verified: "Confirmed", pending_verification: "Waiting for your check", rejected: "Rejected" };
export const PAYMENT_STATUS = { recorded: "Recorded", partially_refunded: "Partly refunded", refunded: "Refunded", reversed: "Reversed" };
export const EMAIL_STATUS = { queued: "Queued", sending: "Sending", sent: "Sent", delivered: "Delivered", bounced: "Bounced", failed: "Failed" };
export const EMAIL_STATUS_HELP = {
  queued: "Waiting to be sent.", sending: "Being handed to the mail service now.", sent: "Accepted by the mail service. Delivery is not confirmed yet.",
  delivered: "Reached the client's mail server.", bounced: "The client's address did not accept it. Check the email address.", failed: "It could not be sent. You can try again.",
};
export const EMAIL_TYPE = { invoice: "Invoice", invoice_reminder: "Reminder", overdue_notice: "Overdue notice", payment_receipt: "Receipt", invoice_update: "Invoice update", refund_notice: "Refund notice" };
export const REFUND_STATUS = { requested: "Requested", approved: "Approved", processing: "Processing", processed: "Refunded", failed: "Failed", rejected: "Rejected" };
export const OWNER_TYPE = { salary: "Owner salary", draw: "Owner draw", personal_withdrawal: "Personal withdrawal", contribution: "Money put in by the owner", reimbursement: "Reimbursement to owner" };
export const ENTRY_KIND = { manual_journal: "Manual journal", client_payment: "Client payment", invoice_issued: "Invoice issued", expense_paid: "Expense", bill_payment: "Supplier payment", bank_transfer: "Transfer",
  animator_obligation: "Animator work approved", animator_payment: "Animator payment", owner_draw: "Owner draw", owner_salary: "Owner salary", owner_contribution: "Owner contribution", owner_reimbursement: "Owner reimbursement" };
export const label = (map, key) => map[key] || String(key ?? "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
