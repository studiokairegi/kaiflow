// Pure helper for the app dashboard bridge (no React, so it is unit-testable on its own).
// Pure: shapes the service output for the dashboard tile. Money stays a string; nothing is added up here.
export function dashboardTile(d, { privacy = false, symbol = (c) => c } = {}) {
  if (!d || typeof d !== "object" || d.source !== "finance_v3.ledger") return null;
  const hide = (s) => (privacy ? "••••" : `${symbol(d.currency)} ${String(s)}`.trim());
  return {
    currency: d.currency, value: hide(d.revenue), label: "revenue this month",
    outstanding: hide(d.outstanding_invoices), overdueCount: Number(d.overdue_invoice_count) || 0, owedToAnimators: hide(d.animator_obligations),
    safeToSpend: hide(d.safe_to_spend), unread: Number(d.unread_notifications) || 0 };
}
