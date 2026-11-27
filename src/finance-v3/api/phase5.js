// Finance V3 Phase 5 client API: everything the Finance screens call, in one object.
//   = Phase 3 + Phase 4 wrappers (Phase 4 spending paths replace Phase 3's, adding the optional override)
//   + the Phase 5 read services (overview, explain, statements, ledger, audit, receipts, email preview, UI mode)
//   + the Phase 2/3 reads the Accountant screens need (trial balance, chart of accounts, payments, emails, settings).
// The screens never compute a balance: every figure shown comes from one of these calls. Money in = decimal strings only.
import { PHASE2_RPCS, PHASE3_RPCS, PHASE4_RPCS, PHASE5_RPCS, PHASE3_SERVICE_RPCS, ERROR_CODES, EMAIL_EDIT_LIMITS, UI_MODES } from "../contracts/index.js";
import { createPhase3Api, FinanceV3Error } from "./phase3.js";
import { createPhase4Api } from "./phase4.js";

const bad = (m) => new FinanceV3Error(m, ERROR_CODES.INVALID_INPUT, "INVALID_INPUT");

/** @param {Record<string, any>} [options] */
export function assertEmailEdit(options = {}) {
  /** @type {Record<string, any>} */
  const out = { ...options };
  for (const [k, max] of /** @type {[string, number][]} */ ([["subject", EMAIL_EDIT_LIMITS.subjectMax], ["message", EMAIL_EDIT_LIMITS.messageMax]])) {
    if (out[k] === undefined || out[k] === null) { delete out[k]; continue; }
    if (typeof out[k] !== "string") throw bad(`The ${k} must be text`);
    if (out[k].length > max) throw bad(`The ${k} can be at most ${max} characters`);
  }
  if (typeof out.subject === "string" && /[\r\n]/.test(out.subject)) throw bad("The subject must be a single line");
  return out;
}

export function createFinanceApi(rpc) {
  const allowed = new Set([...PHASE2_RPCS, ...PHASE3_RPCS, ...PHASE4_RPCS, ...PHASE5_RPCS]);
  const guarded = async (name, args) => {
    if (PHASE3_SERVICE_RPCS.includes(name) || String(name).startsWith("fin3svc_")) throw new FinanceV3Error(`${name} is a service-only function`, ERROR_CODES.NOT_AUTHORIZED, "NOT_AUTHORIZED");
    if (!allowed.has(name)) throw new FinanceV3Error(`${name} is not a Finance V3 RPC the screens may call`, ERROR_CODES.INVALID_INPUT, "INVALID_INPUT");
    return rpc(name, args);
  };
  const p3 = createPhase3Api(guarded), p4 = createPhase4Api(guarded);
  const call = async (name, args = {}) => {
    const { data, error } = await guarded(name, args);
    if (error) { const code = String(error.code || ""); throw new FinanceV3Error(error.message || "Finance request failed", code, Object.keys(ERROR_CODES).find((k) => ERROR_CODES[k] === code)); }
    return data;
  };
  return {
    ...p3, ...p4, call,
    // mode and permissions
    getUiPrefs: (org) => call("fin3_get_ui_prefs", { p_org: org }),
    setUiMode: (org, mode) => { if (!UI_MODES.includes(mode)) throw bad("Mode must be simple or accountant"); return call("fin3_set_ui_prefs", { p_org: org, p_prefs: { mode } }); },
    myPermissions: (org) => call("fin3_my_permissions", { p_org: org }),
    // Simple Mode
    overview: (org, currency = null) => call("fin3_overview", { p_org: org, p_currency: currency }),
    explainSafeToSpend: (org, currency = null) => call("fin3_explain_safe_to_spend", { p_org: org, p_currency: currency }),
    previewInvoiceEmail: (org, invoiceId, recipient = null, options = {}) => call("fin3_preview_invoice_email", { p_org: org, p_invoice: invoiceId, p_recipient: recipient || null, p_options: assertEmailEdit(options) }),
    // Same as Phase 3's, but validates the controlled-edit fields before they leave the browser
    queueInvoiceEmail: (org, id, recipient = null, options = {}) => call("fin3_queue_invoice_email", { p_org: org, p_invoice: id, p_recipient: recipient || null, p_options: assertEmailEdit(options) }),
    issueAndSendInvoice: (org, id, options = {}) => call("fin3_issue_and_send_invoice", { p_org: org, p_invoice: id, p_options: assertEmailEdit(options) }),
    listReceipts: (org, invoiceId = null, limit = 50, offset = 0) => call("fin3_list_receipts", { p_org: org, p_invoice: invoiceId, p_limit: limit, p_offset: offset }),
    getReceipt: (org, id) => call("fin3_get_receipt", { p_org: org, p_receipt: id }),
    queueReceiptEmail: (org, receiptId) => call("fin3_queue_receipt_email", { p_org: org, p_receipt: receiptId }),
    listPayments: (org, status = null, limit = 100) => call("fin3_list_payments", { p_org: org, p_status: status, p_limit: limit }),
    listRefunds: (org, paymentId = null) => call("fin3_list_refunds", { p_org: org, p_payment: paymentId }),
    intentForInvoice: (org, invoiceId) => call("fin3_get_intent_for_invoice", { p_org: org, p_invoice: invoiceId }),
    revokeLinks: (org, invoiceId) => call("fin3_revoke_links", { p_org: org, p_invoice: invoiceId }),
    listBills: (org, status = null, limit = 100) => call("fin3_list_bills", { p_org: org, p_status: status, p_limit: limit }),
    getBill: (org, id) => call("fin3_get_bill", { p_org: org, p_bill: id }),
    listExpenses: (org, from = null, to = null, limit = 100) => call("fin3_list_expenses", { p_org: org, p_from: from, p_to: to, p_limit: limit }),
    listExpenseCategories: (org) => call("fin3_list_expense_categories", { p_org: org }),
    listEmails: (org, status = null, limit = 100) => call("fin3_list_emails", { p_org: org, p_status: status, p_limit: limit }),
    getOrgSettings: (org) => call("fin3_get_org_settings", { p_org: org }),
    // Accountant Mode
    listAccounts: (org, includeInactive = false) => call("fin3_list_accounts", { p_org: org, p_include_inactive: includeInactive }),
    trialBalance: (org, asOf = null, currency = null) => call("fin3_trial_balance", { p_org: org, p_as_of: asOf ?? undefined, p_currency: currency }),
    profitLoss: (org, from, to, currency = null) => call("fin3_report_profit_loss", { p_org: org, p_from: from, p_to: to, p_currency: currency }),
    balanceSheet: (org, asOf = null, currency = null) => call("fin3_report_balance_sheet", { p_org: org, p_as_of: asOf, p_currency: currency }),
    cashFlow: (org, from, to, currency = null) => call("fin3_report_cash_flow", { p_org: org, p_from: from, p_to: to, p_currency: currency }),
    generalLedger: (org, accountId, o = {}) => call("fin3_report_general_ledger", { p_org: org, p_account: accountId, p_from: o.from ?? null, p_to: o.to ?? null, p_currency: o.currency ?? null, p_limit: o.limit ?? 50, p_offset: o.offset ?? 0 }),
    taxSummary: (org, from, to, currency = null) => call("fin3_report_tax_summary", { p_org: org, p_from: from, p_to: to, p_currency: currency }),
    listEntries: (org, o = {}) => call("fin3_list_entries", { p_org: org, p_from: o.from ?? null, p_to: o.to ?? null, p_search: o.search || null, p_limit: o.limit ?? 50, p_offset: o.offset ?? 0 }),
    listAudit: (org, o = {}) => call("fin3_list_audit", { p_org: org, p_object_type: o.objectType || null, p_limit: o.limit ?? 50, p_offset: o.offset ?? 0 }),
    payablesAging: (org, asOf = null, currency = null) => call("fin3_payables_aging", { p_org: org, p_as_of: asOf ?? undefined, p_currency: currency }),
    reservesList: (org, includeInactive = false) => call("fin3_list_reserves", { p_org: org, p_include_inactive: includeInactive }),
    startReconciliation: (org, bankId, statementDate, balance) => call("fin3_start_reconciliation", { p_org: org, p_bank: bankId, p_statement_date: statementDate, p_statement_balance: balance }),
    reconciliationSummary: (org, id) => call("fin3_reconciliation_summary", { p_org: org, p_recon: id }),
  };
}
