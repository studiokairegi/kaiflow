// Finance V3 Phase 6 client API = everything from Phase 5 + reports, dashboard, notifications, alert settings, exports, project links, Emma snapshot.
// No function here calculates a balance: each returns what the database computed. Money in and out = decimal strings.
import { PHASE6_RPCS, ERROR_CODES, EXPORT_KINDS, RECORD_LINK_TYPES } from "../contracts/index.js";
import { createFinanceApi as createPhase5Api } from "./phase5.js";
import { FinanceV3Error } from "./phase3.js";
import { toCsv, exportFileName } from "../reporting/csv.js";

const bad = (m) => new FinanceV3Error(m, ERROR_CODES.INVALID_INPUT, "INVALID_INPUT");
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const needDate = (d, label) => { if (!DATE.test(String(d || ""))) throw bad(`${label} must be a date (YYYY-MM-DD)`); return d; };

export function createFinanceApi(rpc) {
  const base = createPhase5Api(rpc);
  const allowed = new Set(PHASE6_RPCS);
  const call6 = async (name, args = {}) => {
    if (String(name).startsWith("fin3svc_")) throw new FinanceV3Error(`${name} is a service-only function`, ERROR_CODES.NOT_AUTHORIZED, "NOT_AUTHORIZED");
    if (!allowed.has(name)) throw new FinanceV3Error(`${name} is not a Phase 6 Finance RPC`, ERROR_CODES.INVALID_INPUT, "INVALID_INPUT");
    const { data, error } = await rpc(name, args);
    if (error) { const code = String(error.code || ""); throw new FinanceV3Error(error.message || "Finance request failed", code, Object.keys(ERROR_CODES).find((k) => ERROR_CODES[k] === code)); }
    return data;
  };
  return {
    ...base, call6,
    // dashboard + health
    dashboard: (org, o = {}) => call6("fin3_dashboard", { p_org: org, p_currency: o.currency ?? null, p_from: o.from ?? null, p_to: o.to ?? null }),
    integrity: (org) => call6("fin3_report_integrity", { p_org: org }),
    schedulerStatus: (org) => call6("fin3_scheduler_status", { p_org: org }),
    emmaSnapshot: (org) => call6("fin3_emma_snapshot", { p_org: org }),
    // reports
    expenseBreakdown: (org, from, to, currency = null) => call6("fin3_report_expense_breakdown", { p_org: org, p_from: needDate(from, "From"), p_to: needDate(to, "To"), p_currency: currency }),
    animatorObligations: (org, currency = null) => call6("fin3_report_animator_obligations", { p_org: org, p_currency: currency }),
    reservesReport: (org, asOf = null) => call6("fin3_report_reserves", { p_org: org, p_as_of: asOf }),
    ownerCompensation: (org, from, to) => call6("fin3_report_owner_compensation", { p_org: org, p_from: needDate(from, "From"), p_to: needDate(to, "To") }),
    invoiceStatus: (org, from, to, currency = null) => call6("fin3_report_invoice_status", { p_org: org, p_from: needDate(from, "From"), p_to: needDate(to, "To"), p_currency: currency }),
    paymentHistory: (org, from, to, currency = null, limit = 200) => call6("fin3_report_payment_history", { p_org: org, p_from: needDate(from, "From"), p_to: needDate(to, "To"), p_currency: currency, p_limit: limit }),
    paymentReconciliation: (org, from, to) => call6("fin3_report_payment_reconciliation", { p_org: org, p_from: needDate(from, "From"), p_to: needDate(to, "To") }),
    emailDelivery: (org, from, to) => call6("fin3_report_email_delivery", { p_org: org, p_from: needDate(from, "From"), p_to: needDate(to, "To") }),
    // notifications and settings
    notifications: (org, o = {}) => call6("fin3_list_notifications", { p_org: org, p_unread_only: !!o.unreadOnly, p_category: o.category ?? null, p_limit: o.limit ?? 50, p_offset: o.offset ?? 0 }),
    notificationCounts: (org) => call6("fin3_notification_counts", { p_org: org }),
    markNotificationsRead: (org, ids = null) => call6("fin3_mark_notifications_read", { p_org: org, p_ids: ids }),
    getAlertSettings: (org) => call6("fin3_get_alert_settings", { p_org: org }),
    setAlertSettings: (org, settings) => call6("fin3_set_alert_settings", { p_org: org, p_settings: settings }),
    // projects
    projectFinanceDetail: (org, projectId) => call6("fin3_project_finance_detail", { p_org: org, p_project: projectId }),
    setRecordLink: (org, type, objectId, projectId, shotId = null, stage = null) => {
      if (!RECORD_LINK_TYPES.includes(type)) throw bad("Unknown record type");
      return call6("fin3_set_record_link", { p_org: org, p_object_type: type, p_object_id: objectId, p_project: projectId ?? null, p_shot: shotId, p_stage: stage });
    },
    // exports: the database returns rows; the CSV text is built here with formula protection
    exportRows: (org, kind, o = {}) => {
      if (!EXPORT_KINDS.includes(kind)) throw bad("Unknown export");
      if ((o.from && !o.to) || (!o.from && o.to)) throw bad("Give both dates or neither");
      if (o.from) { needDate(o.from, "From"); needDate(o.to, "To"); }
      return call6("fin3_export_rows", { p_org: org, p_export: kind, p_from: o.from ?? null, p_to: o.to ?? null, p_currency: o.currency ?? null });
    },
    async exportCsv(org, kind, o = {}) {
      const r = await this.exportRows(org, kind, o);
      return { csv: toCsv(r.columns, r.rows), fileName: exportFileName(kind, o.orgLabel, o.from, o.to), rowCount: r.row_count, truncated: !!r.truncated };
    }
  };
}
