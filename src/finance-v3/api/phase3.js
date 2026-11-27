// Finance V3 Phase 3 client API: a thin, strict wrapper over the user RPCs (public.fin3_*). It is what the Phase 5 screens call.
//   * Only user RPCs can be called. Service RPCs (fin3svc_*) belong to Edge Functions and are refused here.
//   * Money, quantities, percentages and rates are DECIMAL STRINGS ("12.50"); a JS number is rejected before it can reach the database.
//   * Errors keep the database's stable V3xxx code so the UI can react to the code, never to message text.
// `rpc(name, args)` is any function returning { data, error } (for example supabase.rpc.bind(supabase)).
import { PHASE3_RPCS, PHASE3_SERVICE_RPCS, ERROR_CODES } from "../contracts/index.js";

export class FinanceV3Error extends Error {
  constructor(message, code, name) { super(message); this.name = "FinanceV3Error"; this.code = code; this.codeName = name; }
}
const CODE_NAMES = Object.fromEntries(Object.entries(ERROR_CODES).map(([k, v]) => [v, k]));

const DECIMAL = /^(0|[1-9][0-9]{0,14})(\.[0-9]{1,10})?$/;
export function assertDecimalString(value, label = "amount") {
  if (typeof value !== "string" || !DECIMAL.test(value)) throw new FinanceV3Error(`${label} must be a decimal string such as "12.50"`, ERROR_CODES.INVALID_INPUT, "INVALID_INPUT");
  return value;
}
function assertInvoiceLines(lines) {
  if (!Array.isArray(lines)) throw new FinanceV3Error("lines must be a list", ERROR_CODES.INVALID_INPUT, "INVALID_INPUT");
  lines.forEach((l, i) => {
    assertDecimalString(l.quantity, `line ${i + 1} quantity`); assertDecimalString(l.unit_price, `line ${i + 1} unit price`);
    for (const k of ["discount_pct", "tax_rate"]) if (l[k] !== undefined && l[k] !== null) assertDecimalString(l[k], `line ${i + 1} ${k}`);
  });
}

export function createPhase3Api(rpc) {
  const allowed = new Set(PHASE3_RPCS);
  async function call(name, args = {}) {
    if (PHASE3_SERVICE_RPCS.includes(name)) throw new FinanceV3Error(`${name} is a service-only function`, ERROR_CODES.NOT_AUTHORIZED, "NOT_AUTHORIZED");
    if (!allowed.has(name)) throw new FinanceV3Error(`${name} is not a Finance V3 Phase 3 RPC`, ERROR_CODES.INVALID_INPUT, "INVALID_INPUT");
    const { data, error } = await rpc(name, args);
    if (error) {
      const code = String(error.code || "");
      throw new FinanceV3Error(error.message || "Finance request failed", code, CODE_NAMES[code]);
    }
    return data;
  }
  return {
    call,
    // contacts and profile
    getOrgProfile: (org) => call("fin3_get_org_profile", { p_org: org }),
    updateOrgProfile: (org, profile) => call("fin3_update_org_profile", { p_org: org, p_profile: profile }),
    upsertContact: (org, contact) => call("fin3_upsert_contact", { p_org: org, p_contact: contact }),
    listContacts: (org, kind = null, includeInactive = false) => call("fin3_list_contacts", { p_org: org, p_contact_kind: kind, p_include_inactive: includeInactive }),
    // invoices
    saveInvoiceDraft: (org, key, a) => { assertInvoiceLines(a.lines); return call("fin3_save_invoice_draft", { p_org: org, p_key: key, p_invoice: a.invoiceId ?? null, p_client: a.clientId, p_currency: a.currency,
      p_issue_date: a.issueDate ?? null, p_due_date: a.dueDate ?? null, p_terms_days: a.termsDays ?? null, p_notes: a.notes ?? null, p_po: a.po ?? null, p_project: a.projectId ?? null, p_lines: a.lines }); },
    approveInvoice: (org, id) => call("fin3_approve_invoice", { p_org: org, p_invoice: id }),
    issueInvoice: (org, id) => call("fin3_issue_invoice", { p_org: org, p_invoice: id }),
    issueAndSendInvoice: (org, id, options = {}) => call("fin3_issue_and_send_invoice", { p_org: org, p_invoice: id, p_options: options }),
    voidInvoice: (org, id, reason) => call("fin3_void_invoice", { p_org: org, p_invoice: id, p_reason: reason }),
    creditInvoice: (org, key, id, amount, reason, accountCode = null) => call("fin3_credit_invoice", { p_org: org, p_key: key, p_invoice: id, p_amount: assertDecimalString(amount, "credit amount"), p_reason: reason, p_account_code: accountCode }),
    getInvoice: (org, id) => call("fin3_get_invoice", { p_org: org, p_invoice: id }),
    listInvoices: (org, f = {}) => call("fin3_list_invoices", { p_org: org, p_status: f.status ?? null, p_client: f.clientId ?? null, p_overdue_only: !!f.overdueOnly, p_limit: f.limit ?? 50, p_cursor: f.cursor ?? null }),
    receivablesAging: (org, asOf = null, currency = null) => call("fin3_receivables_aging", { p_org: org, p_as_of: asOf ?? undefined, p_currency: currency }),
    // payments
    recordManualPayment: (org, key, a) => call("fin3_record_manual_payment", { p_org: org, p_key: key, p_invoice: a.invoiceId, p_amount: assertDecimalString(a.amount, "payment amount"), p_currency: a.currency,
      p_received_on: a.receivedOn, p_method: a.method, p_reference: a.reference ?? null, p_cash_account: a.cashAccountId, p_notes: a.notes ?? null, p_evidence: a.evidence ?? [] }),
    verifyManualPayment: (org, id) => call("fin3_verify_manual_payment", { p_org: org, p_payment: id }),
    rejectManualPayment: (org, id, reason) => call("fin3_reject_manual_payment", { p_org: org, p_payment: id, p_reason: reason }),
    reversePayment: (org, id, reason) => call("fin3_reverse_payment", { p_org: org, p_payment: id, p_reason: reason }),
    createPaymentLink: (org, invoiceId, o = {}) => call("fin3_create_payment_link", { p_org: org, p_invoice: invoiceId, p_link_kind: o.kind ?? "pay", p_amount: o.amount === undefined ? null : assertDecimalString(o.amount, "link amount"), p_expires_days: o.expiresDays ?? 30 }),
    requestRefund: (org, key, paymentId, amount, reason) => call("fin3_request_refund", { p_org: org, p_key: key, p_payment: paymentId, p_amount: assertDecimalString(amount, "refund amount"), p_reason: reason }),
    approveRefund: (org, id) => call("fin3_approve_refund", { p_org: org, p_refund: id }),
    recordRefund: (org, id, date, reference = null) => call("fin3_record_refund", { p_org: org, p_refund: id, p_date: date, p_reference: reference }),
    // email
    queueInvoiceEmail: (org, id, recipient = null, options = {}) => call("fin3_queue_invoice_email", { p_org: org, p_invoice: id, p_recipient: recipient, p_options: options }),
    retryEmail: (org, id) => call("fin3_retry_email", { p_org: org, p_message: id }),
    resendEmail: (org, id, reason) => call("fin3_resend_email", { p_org: org, p_message: id, p_reason: reason }),
    invoiceCommunications: (org, id, before = null, limit = 100) => call("fin3_list_invoice_communications", { p_org: org, p_invoice: id, p_before: before, p_limit: limit }),
    // payables, expenses, banking
    saveBillDraft: (org, key, a) => call("fin3_save_bill_draft", { p_org: org, p_key: key, p_bill: a.billId ?? null, p_supplier: a.supplierId, p_bill_type: a.billType, p_currency: a.currency, p_supplier_ref: a.supplierRef ?? null,
      p_bill_date: a.billDate ?? null, p_due_date: a.dueDate ?? null, p_project: a.projectId ?? null, p_notes: a.notes ?? null, p_lines: (a.lines || []).map((l) => ({ ...l, amount: assertDecimalString(l.amount, "bill line amount") })) }),
    approveBill: (org, id) => call("fin3_approve_bill", { p_org: org, p_bill: id }),
    payBill: (org, key, id, amount, paidOn, payAccountId, reference = null) => call("fin3_pay_bill", { p_org: org, p_key: key, p_bill: id, p_amount: assertDecimalString(amount, "payment amount"), p_paid_on: paidOn, p_pay_account: payAccountId, p_reference: reference }),
    recordExpense: (org, key, e) => call("fin3_record_expense", { p_org: org, p_key: key, p_expense: { ...e, amount: assertDecimalString(e.amount, "expense amount") } }),
    postTransfer: (org, key, t) => call("fin3_post_transfer", { p_org: org, p_key: key, p_from_account: t.fromAccountId, p_to_account: t.toAccountId, p_from_ccy: t.fromCurrency, p_to_ccy: t.toCurrency,
      p_amount_from: assertDecimalString(t.amountFrom, "amount sent"), p_amount_to: assertDecimalString(t.amountTo ?? t.amountFrom, "amount received"), p_date: t.date, p_reference: t.reference ?? null, p_memo: t.memo ?? null }),
    listBankAccounts: (org, asOf) => call("fin3_list_bank_accounts", { p_org: org, p_as_of: asOf ?? undefined }),
  };
}
