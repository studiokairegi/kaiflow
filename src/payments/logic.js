// Pure Payments logic (no React, no network) so every figure on the Payments tab and the
// Dashboard is computed in one place and can be unit-tested.
//
// Everything is grouped BY CURRENCY and never summed across currencies: a Kenyan shilling is
// not a dollar, and the Finance module takes the same position.
import { symbolToCode } from "../finance/currency.js";

export const SANDBOX_NOTICE = "SANDBOX · TEST DATA · NOT REAL MONEY";
export const SIMULATED_NOTICE = "SIMULATED — NO MONEY TRANSFERRED";
export const FEE_CATEGORY = "Payment processing fees";
export const PAYSTACK_METHOD = "Paystack (test mode)";
export const PAYSTACK_LIVE_METHOD = "Paystack";        // label on live invoice payments in Finance
export const LIVE_NOTICE = "LIVE · REAL PAYMENTS";
export const envNotice = (env) => (env === "live" ? LIVE_NOTICE : SANDBOX_NOTICE);
export const txEnvironment = (t) => (t?.environment === "live" ? "live" : "test");
export const methodLabelFor = (env) => (env === "live" ? PAYSTACK_LIVE_METHOD : PAYSTACK_METHOD);

// Same ids/labels/days as the Dashboard's period filter.
export const PAYMENT_PERIODS = [
  { id: "30d", label: "Last 30 days", days: 30 },
  { id: "90d", label: "Last 90 days", days: 90 },
  { id: "6m", label: "Last 6 months", days: 182 },
  { id: "12m", label: "Last 12 months", days: 365 },
  { id: "all", label: "All time", days: null },
];

export const r2 = (n) => Math.round((Number(n) || 0) * 100 + Number.EPSILON * Math.sign(n || 0)) / 100;

export function inPeriod(iso, periodId, now = new Date()) {
  const days = PAYMENT_PERIODS.find((p) => p.id === periodId)?.days ?? null;
  if (days === null) return true;
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  return t >= now.getTime() - days * 86400000 && t <= now.getTime() + 86400000;
}

const add = (map, ccy, n) => { map[ccy] = r2((map[ccy] || 0) + (Number(n) || 0)); };
const sumBy = (rows, ccyOf, amtOf) => { const m = {}; for (const r of rows) add(m, ccyOf(r), amtOf(r)); return m; };
const nonZero = (m) => Object.fromEntries(Object.entries(m).filter(([, v]) => Math.abs(v) > 0.004));

// ---- status vocab -------------------------------------------------------------------------
export const TX_STATUS = {
  initialized: { label: "Awaiting payment", tone: "muted" },
  pending: { label: "Pending", tone: "warn" },
  success: { label: "Successful", tone: "ok" },
  failed: { label: "Failed", tone: "bad" },
  abandoned: { label: "Abandoned", tone: "muted" },
  refunded: { label: "Refunded", tone: "info" },
  partially_refunded: { label: "Partly refunded", tone: "info" },
};
export const PAYOUT_STATUS = {
  pending_approval: { label: "Pending approval", tone: "warn", step: 2 },
  approved: { label: "Approved", tone: "info", step: 3 },
  simulated_initiated: { label: "Simulation started", tone: "info", step: 4 },
  completed_simulated: { label: "Completed (simulated)", tone: "ok", step: 5 },
  failed: { label: "Failed", tone: "bad", step: 6 },
  cancelled: { label: "Cancelled", tone: "muted", step: 6 },
};
export const OPEN_PAYOUT_STATUSES = ["pending_approval", "approved", "simulated_initiated"];

const COUNTED = ["success", "partially_refunded"];        // gross still sitting in Finance as a posted payment
const SETTLED = ["success", "partially_refunded", "refunded"]; // verified at the gateway at some point

// ---- invoices ------------------------------------------------------------------------------
// Invoice objects are the app's own (amount, amountPaid, currency symbol, status, docType...).
export function payableInvoices(invoices) {
  const superseded = new Set((invoices || []).map((i) => i.convertedFromId).filter(Boolean));
  return (invoices || []).filter((i) => {
    const t = i.docType || "invoice";
    if (t !== "invoice" && t !== "proforma") return false;
    if (superseded.has(i.id)) return false;
    return outstandingOf(i) > 0.004;
  });
}
export function outstandingOf(inv) {
  return r2((Number(inv.amount) || 0) - (Number(inv.amountPaid) || 0));
}
export function outstandingByCurrency(invoices) {
  const rows = payableInvoices(invoices).filter((i) => i.status !== "paid");
  return nonZero(sumBy(rows, (i) => symbolToCode(i.currency), outstandingOf));
}

// ---- freelancer obligations ----------------------------------------------------------------
// What is owed comes ONLY from bills in Finance (the obligation of record). Payout requests are
// attempts against a bill and never change what is owed. Assigned-but-unbilled shot pay is shown
// separately so it is never double counted with a bill that already includes that shot.
export function billOutstanding(bill) {
  if (!["approved", "partially_paid"].includes(bill.status)) return 0;
  return Math.max(0, r2((Number(bill.amount) || 0) - (Number(bill.amount_paid) || 0)));
}
export function billReserved(billId, payouts) {
  return r2((payouts || []).filter((p) => p.bill_id === billId && OPEN_PAYOUT_STATUSES.includes(p.status)).reduce((s, p) => s + Number(p.amount), 0));
}
export function billAvailableForRequest(bill, payouts) {
  return Math.max(0, r2(billOutstanding(bill) - billReserved(bill.id, payouts)));
}

export function freelancerObligations({ teamMembers = [], bills = [], billPayments = [], payouts = [], billShots = [], cards = [], projects = [] }) {
  const onBill = new Set((billShots || []).map((b) => b.shot_id));
  const projectBy = new Map((projects || []).map((p) => [p.id, p]));
  const out = [];
  for (const m of teamMembers) {
    const myBills = bills.filter((b) => b.team_member_id === m.id && b.status !== "draft" && b.status !== "void");
    const billIds = new Set(myBills.map((b) => b.id));
    const myPays = billPayments.filter((p) => billIds.has(p.bill_id) && p.status === "posted");
    const myPayouts = payouts.filter((p) => p.team_member_id === m.id);
    const unbilled = (cards || []).filter((c) => c.assignedMemberId === m.id && !c.assignedPaid && Number(c.assignedPay) > 0 && !onBill.has(c.id));
    const owed = nonZero(sumBy(myBills, (b) => b.currency, billOutstanding));
    const row = {
      member: m,
      billed: nonZero(sumBy(myBills, (b) => b.currency, (b) => b.amount)),
      paid: nonZero(sumBy(myPays, (p) => p.currency, (p) => p.amount)),
      owed,
      pendingRequests: nonZero(sumBy(myPayouts.filter((p) => p.status === "pending_approval"), (p) => p.currency, (p) => p.amount)),
      approvedAwaiting: nonZero(sumBy(myPayouts.filter((p) => ["approved", "simulated_initiated"].includes(p.status)), (p) => p.currency, (p) => p.amount)),
      simulatedUnreconciled: nonZero(sumBy(myPayouts.filter((p) => p.status === "completed_simulated" && !p.reconciled), (p) => p.currency, (p) => p.amount)),
      unbilledWork: nonZero(sumBy(unbilled, (c) => symbolToCode(projectBy.get(c.projectId)?.currency), (c) => Number(c.assignedPay))),
      unbilledShotIds: unbilled.map((c) => c.id),
      bills: myBills.map((b) => ({ ...b, outstanding: billOutstanding(b), reserved: billReserved(b.id, payouts), available: billAvailableForRequest(b, payouts) })),
      payouts: myPayouts,
      projectIds: [...new Set([...myBills.map((b) => b.project_id), ...unbilled.map((c) => c.projectId)].filter(Boolean))],
    };
    if (myBills.length || myPayouts.length || unbilled.length) out.push(row);
  }
  return out.sort((a, b) => (Object.values(b.owed).reduce((s, v) => s + v, 0)) - (Object.values(a.owed).reduce((s, v) => s + v, 0)));
}

// ---- summary (Overview tab + Dashboard) -----------------------------------------------------
export function summarizePayments({ transactions = [], payouts = [], bills = [], billPayments = [], invoices = [], period = "all", now = new Date(), todayIso } = {}) {
  const tx = transactions.filter((t) => inPeriod(t.paid_at || t.created_at, period, now));
  const counted = tx.filter((t) => COUNTED.includes(t.status) && t.apply_status === "applied");
  const fees = tx.filter((t) => SETTLED.includes(t.status) && t.apply_status === "applied" && t.fee_actual != null);

  const receivedGross = nonZero(sumBy(counted, (t) => t.currency, (t) => t.amount));
  const feeTotals = nonZero(sumBy(fees, (t) => t.currency, (t) => t.fee_actual));
  const net = {};
  for (const c of new Set([...Object.keys(receivedGross), ...Object.keys(feeTotals)])) net[c] = r2((receivedGross[c] || 0) - (feeTotals[c] || 0));
  const refunds = nonZero(sumBy(tx.filter((t) => Number(t.refunded_amount) > 0), (t) => t.currency, (t) => t.refunded_amount));

  const today = todayIso || now.toISOString().slice(0, 10);
  const receivedToday = nonZero(sumBy(
    transactions.filter((t) => COUNTED.includes(t.status) && t.apply_status === "applied" && String(t.paid_at || "").slice(0, 10) === today),
    (t) => t.currency, (t) => t.amount));

  const pendingTx = tx.filter((t) => ["initialized", "pending"].includes(t.status));
  const counts = {
    pending: pendingTx.length,
    successful: tx.filter((t) => COUNTED.includes(t.status)).length,
    failed: tx.filter((t) => ["failed", "abandoned"].includes(t.status)).length,
    refunded: tx.filter((t) => Number(t.refunded_amount) > 0).length,
  };
  const unreconciledTx = transactions.filter((t) => SETTLED.includes(t.status) && t.reconciliation_status !== "matched");

  const pay = payouts.filter((p) => inPeriod(p.completed_at || p.created_at, period, now));
  const obligations = freelancerObligations({ teamMembers: [...new Map(bills.filter((b) => b.team_member_id).map((b) => [b.team_member_id, { id: b.team_member_id }])).values()], bills, billPayments, payouts });
  const owed = {};
  for (const o of obligations) for (const [c, v] of Object.entries(o.owed)) add(owed, c, v);

  return {
    period,
    receivedGross, receivedToday, fees: feeTotals, net, refunds,
    counts,
    pendingIncoming: nonZero(sumBy(pendingTx, (t) => t.currency, (t) => t.amount)),
    outstandingInvoices: outstandingByCurrency(invoices),
    outstandingInvoiceCount: payableInvoices(invoices).filter((i) => i.status !== "paid").length,
    unreconciledCount: unreconciledTx.length,
    unreconciledPayoutCount: payouts.filter((p) => p.status === "completed_simulated" && !p.reconciled).length,
    freelancerOwed: nonZero(owed),
    approvedPayoutsAwaiting: nonZero(sumBy(payouts.filter((p) => ["approved", "simulated_initiated"].includes(p.status)), (p) => p.currency, (p) => p.amount)),
    pendingApprovalPayouts: nonZero(sumBy(payouts.filter((p) => p.status === "pending_approval"), (p) => p.currency, (p) => p.amount)),
    simulatedPaid: nonZero(sumBy(pay.filter((p) => p.status === "completed_simulated"), (p) => p.currency, (p) => p.amount)),
  };
}

export function recentActivity({ transactions = [], payouts = [] }, limit = 10) {
  const rows = [
    ...transactions.map((t) => ({ kind: "payment", at: t.paid_at || t.updated_at || t.created_at, id: t.id, label: `${t.invoice_number || "Invoice"} · ${TX_STATUS[t.status]?.label || t.status}`, amount: t.amount, currency: t.currency })),
    ...payouts.map((p) => ({ kind: "payout", at: p.updated_at || p.created_at, id: p.id, label: `${p.request_ref} · ${PAYOUT_STATUS[p.status]?.label || p.status} (simulated)`, amount: p.amount, currency: p.currency })),
  ];
  return rows.filter((r) => r.at).sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, limit);
}

// ---- reconciliation -------------------------------------------------------------------------
// Compares what the gateway says with what Finance holds, by currency. A non-zero difference is
// surfaced, never silently "fixed".
export function reconcileTotals({ transactions = [], invoicePayments = [], expenses = [], environment = "test" }) {
  const refs = new Set(transactions.map((t) => t.reference));
  const gatewayGross = sumBy(transactions.filter((t) => COUNTED.includes(t.status) && t.apply_status === "applied"), (t) => t.currency, (t) => t.amount);
  const ledgerGross = sumBy(invoicePayments.filter((p) => p.method === methodLabelFor(environment) && p.status === "posted"), (p) => p.currency, (p) => p.amount);
  const gatewayFees = sumBy(transactions.filter((t) => SETTLED.includes(t.status) && t.apply_status === "applied" && t.fee_actual != null), (t) => t.currency, (t) => t.fee_actual);
  const ledgerFees = sumBy(expenses.filter((e) => e.category === FEE_CATEGORY && refs.has(e.reference)), (e) => symbolToCode(e.currency), (e) => e.amount);
  const ccys = [...new Set([...Object.keys(gatewayGross), ...Object.keys(ledgerGross), ...Object.keys(gatewayFees), ...Object.keys(ledgerFees)])].sort();
  const rows = ccys.map((c) => ({
    currency: c,
    gatewayGross: r2(gatewayGross[c] || 0), ledgerGross: r2(ledgerGross[c] || 0),
    gatewayFees: r2(gatewayFees[c] || 0), ledgerFees: r2(ledgerFees[c] || 0),
    grossDifference: r2((gatewayGross[c] || 0) - (ledgerGross[c] || 0)),
    feeDifference: r2((gatewayFees[c] || 0) - (ledgerFees[c] || 0)),
  }));
  return { rows, ok: rows.every((r) => Math.abs(r.grossDifference) < 0.005 && Math.abs(r.feeDifference) < 0.005) };
}

export function needsAttention(transactions) {
  return transactions.filter((t) =>
    (SETTLED.includes(t.status) && t.reconciliation_status !== "matched") || (t.status === "success" && t.apply_status === "failed"));
}

// ---- dashboard metrics ----------------------------------------------------------------------
// Keys/labels used by the Dashboard cards. Kept here so Payments and Dashboard cannot disagree.
export function dashboardMetrics(s) {
  return {
    receivedToday: s.receivedToday,
    receipts: s.receivedGross,
    fees: s.fees,
    net: s.net,
    outstandingInvoices: s.outstandingInvoices,
    pendingIncoming: s.pendingIncoming,
    refunds: s.refunds,
    freelancerOwed: s.freelancerOwed,
    approvedPayoutsAwaiting: s.approvedPayoutsAwaiting,
    simulatedPaid: s.simulatedPaid,
    unreconciled: s.unreconciledCount + s.unreconciledPayoutCount,
  };
}

// ---- helpers for forms ----------------------------------------------------------------------
export function isValidEmail(s) {
  return typeof s === "string" && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}
export const PAYSTACK_CURRENCIES = ["NGN", "GHS", "ZAR", "KES", "USD"];
export function checkoutBlocker(inv) {
  const code = symbolToCode(inv.currency);
  if (!PAYSTACK_CURRENCIES.includes(code)) return `Paystack cannot collect ${code}. Supported: ${PAYSTACK_CURRENCIES.join(", ")}.`;
  if (!payableInvoices([inv]).length) return "Nothing is outstanding on this document.";
  return "";
}
