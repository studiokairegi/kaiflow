// The twelve quick actions. Each opens a plain-language dialog; the loading of pick-lists is handled here, the money rules are the database's.
import React from "react";
import { ActionDialog } from "../shared/parts.jsx";
import { Async, Dialog, Button, useFinance, useResource } from "../shared/kit.jsx";
import { OWNER_TYPE, fmtMoney, todayISO } from "../shared/format.js";
import { UI_ACTIONS } from "./actions.js";

const opt = (rows, v, l) => (rows || []).map((r) => ({ value: r[v], label: typeof l === "function" ? l(r) : r[l] }));

function Lookup({ title = undefined, load = undefined, onClose = undefined, children = undefined }) {
  const res = useResource(load, []);
  if (res.data) return children(res.data);
  return (<Dialog title={title} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}><Async res={res}>{() => null}</Async></Dialog>);
}

export default function QuickActionDialog({ action = undefined, onClose = undefined, onDone = undefined, invoice = undefined }) {
  const { api, org } = useFinance();
  const common = { onClose, onDone };
  const ccy = (c) => c || "";
  switch (action) {
    case "record_payment": return (<Lookup title="Record a client payment" onClose={onClose} load={async () => ({ inv: (await api.listInvoices(org, { limit: 200 })).items.filter((i) => ["issued", "partially_paid"].includes(i.status)), banks: await api.listBankAccounts(org) })}>
      {({ inv, banks }) => <ActionDialog {...common} title="Record a client payment" confirmText="Record payment"
        intro="Use this when a client paid you by bank transfer, cash or mobile money. Payments made through the payment link are recorded automatically. A payment you record here waits for someone to confirm it."
        fields={[{ name: "invoiceId", label: "Which invoice", type: "select", required: true, default: invoice?.id || "", options: opt(inv, "id", (i) => `${i.invoice_no} · ${i.client?.name || ""} · owes ${fmtMoney(i.outstanding, i.currency)}`) },
          { name: "amount", label: "Amount received", type: "money" }, { name: "receivedOn", label: "Date received", type: "date", required: true, default: todayISO() },
          { name: "method", label: "How it was paid", type: "select", required: true, default: "bank_transfer", options: [["bank_transfer", "Bank transfer"], ["mobile_money", "Mobile money"], ["cash", "Cash"], ["cheque", "Cheque"], ["other", "Other"]].map(([value, label]) => ({ value, label })) },
          { name: "cashAccountId", label: "Money went into", type: "select", required: true, options: opt(banks, "ledger_account_id", (b) => `${b.name} (${b.currency})`) },
          { name: "reference", label: "Reference from the bank or phone", type: "text" }]}
        onSubmit={(v, _o, key) => { const i = inv.find((x) => x.id === v.invoiceId); return api.recordManualPayment(org, key, { invoiceId: v.invoiceId, amount: v.amount, currency: i.currency, receivedOn: v.receivedOn, method: v.method, reference: v.reference, cashAccountId: v.cashAccountId }); }} />}</Lookup>);
    case "add_expense": return (<Lookup title="Add an expense" onClose={onClose} load={async () => ({ cats: await api.listExpenseCategories(org), banks: await api.listBankAccounts(org) })}>
      {({ cats, banks }) => <ActionDialog {...common} title="Add an expense" confirmText="Save expense"
        intro="Money the business already spent: software, travel, equipment. It is taken from the account you choose today."
        fields={[{ name: "description", label: "What was it for", type: "text", required: true }, { name: "category", label: "Category", type: "select", required: true, options: opt(cats.filter?.((c) => c.is_active) ?? cats, "id", "name") },
          { name: "amount", label: "Amount", type: "money" }, { name: "pay", label: "Paid from", type: "select", required: true, options: opt(banks, "ledger_account_id", (b) => `${b.name} (${b.currency})`) },
          { name: "date", label: "Date", type: "date", required: true, default: todayISO() }]}
        onSubmit={(v, o, key) => { const b = banks.find((x) => x.ledger_account_id === v.pay); return api.recordExpense(org, key, { category_id: v.category, description: v.description, amount: v.amount, currency: b.currency, expense_date: v.date, pay_account_id: v.pay }, o); }} />}</Lookup>);
    case "record_work": return (<Lookup title="Record animator work" onClose={onClose} load={() => api.listAnimatorAssignments(org)}>
      {(rows) => <ActionDialog {...common} title="Record animator work" confirmText="Submit work"
        intro="Log work an animator has done. It stays a draft claim until you approve it: only approved work counts as money you owe."
        fields={[{ name: "assignment", label: "Animator and project", type: "select", required: true, options: opt(rows, "id", (a) => `${a.animator_name || "Animator"} · ${a.role_label || a.rate_unit} · ${fmtMoney(a.agreed_rate, a.currency)} per ${a.rate_unit}`) },
          { name: "work_ref", label: "Short reference (for example Episode 3 scene 2)", type: "text", required: true }, { name: "quantity", label: "Quantity done (seconds, minutes, days or items)", type: "money" },
          { name: "description", label: "Notes", type: "textarea" }]}
        onSubmit={(v, _o, key) => api.submitAnimatorWork(org, key, v.assignment, { work_ref: v.work_ref, quantity: v.quantity, description: v.description })} />}</Lookup>);
    case "approve_work": return (<Lookup title="Approve animator work" onClose={onClose} load={() => api.listAnimatorObligations(org, { status: "submitted" })}>
      {(rows) => <ActionDialog {...common} title="Approve animator work" confirmText="Approve"
        intro="Approving makes this an amount you owe the animator. You can approve less than they claimed."
        fields={[{ name: "work", label: "Which work", type: "select", required: true, options: opt(rows, "id", (w) => `${w.animator_name || ""} · ${w.work_ref || w.description || ""} · ${fmtMoney(w.submitted_amount, w.currency)}`) },
          { name: "qty", label: "Approved quantity (leave empty to approve all)", type: "text" }]}
        onSubmit={(v) => api.approveAnimatorWork(org, v.work, v.qty ? v.qty : null)} />}</Lookup>);
    case "pay_animator": return (<Lookup title="Pay an animator" onClose={onClose} load={async () => ({ w: await api.listAnimatorObligations(org, { outstandingOnly: true, status: "approved" }), banks: await api.listBankAccounts(org) })}>
      {({ w, banks }) => <ActionDialog {...common} title="Pay an animator" confirmText="Pay now"
        intro="Pays approved work from one of your accounts. The money leaves that account today."
        fields={[{ name: "work", label: "Which work", type: "select", required: true, options: opt(w, "id", (x) => `${x.animator_name || ""} · ${x.work_ref || ""} · owed ${fmtMoney(x.outstanding, x.currency)}`) },
          { name: "amount", label: "Amount to pay", type: "money" }, { name: "pay", label: "Pay from", type: "select", required: true, options: opt(banks, "ledger_account_id", (b) => `${b.name} (${b.currency})`) },
          { name: "date", label: "Date paid", type: "date", required: true, default: todayISO() }, { name: "reference", label: "Reference", type: "text" }]}
        onSubmit={(v, o, key) => api.payAnimator(org, key, v.work, v.amount, v.date, v.pay, { reference: v.reference, override: o })} />}</Lookup>);
    case "pay_supplier": return (<Lookup title="Pay a supplier" onClose={onClose} load={async () => ({ bills: (await api.listBills(org)).filter((b) => ["approved", "partially_paid"].includes(b.status)), banks: await api.listBankAccounts(org) })}>
      {({ bills, banks }) => <ActionDialog {...common} title="Pay a supplier" confirmText="Pay now"
        intro="Pays an approved supplier bill, in full or in part."
        fields={[{ name: "bill", label: "Which bill", type: "select", required: true, options: opt(bills, "id", (b) => `${b.bill_no || ""} · ${b.supplier?.name || ""} · ${fmtMoney(b.total, b.currency)}`) },
          { name: "amount", label: "Amount to pay", type: "money" }, { name: "pay", label: "Pay from", type: "select", required: true, options: opt(banks, "ledger_account_id", (b) => `${b.name} (${b.currency})`) },
          { name: "date", label: "Date paid", type: "date", required: true, default: todayISO() }, { name: "reference", label: "Reference", type: "text" }]}
        onSubmit={(v, o, key) => api.payBill(org, key, v.bill, v.amount, v.date, v.pay, { reference: v.reference, override: o })} />}</Lookup>);
    case "transfer": return (<Lookup title="Move money" onClose={onClose} load={() => api.listBankAccounts(org)}>
      {(banks) => <ActionDialog {...common} title="Move money between accounts" confirmText="Move money"
        intro="Moves money between your own accounts. Nothing is spent. For two currencies, enter both amounts exactly as the bank shows them."
        fields={[{ name: "from", label: "From", type: "select", required: true, options: opt(banks, "ledger_account_id", (b) => `${b.name} (${b.currency}) · ${fmtMoney(b.ledger_balance, b.currency)}`) },
          { name: "to", label: "To", type: "select", required: true, options: opt(banks, "ledger_account_id", (b) => `${b.name} (${b.currency})`) },
          { name: "amount", label: "Amount sent", type: "money" }, { name: "amountTo", label: "Amount received (only if the currencies differ)", type: "text" },
          { name: "date", label: "Date", type: "date", required: true, default: todayISO() }, { name: "memo", label: "Note", type: "text" }]}
        onSubmit={(v, o, key) => { const f = banks.find((b) => b.ledger_account_id === v.from), t = banks.find((b) => b.ledger_account_id === v.to);
          if (!f || !t || f.ledger_account_id === t.ledger_account_id) throw Object.assign(new Error("Choose two different accounts."), { code: "V3011" });
          return api.postTransfer(org, key, { fromAccountId: f.ledger_account_id, toAccountId: t.ledger_account_id, fromCurrency: f.currency, toCurrency: t.currency, amountFrom: v.amount, amountTo: f.currency === t.currency ? v.amount : v.amountTo, date: v.date, memo: v.memo, override: o }); }} />}</Lookup>);
    case "add_reserve": return (<Lookup title="Add to reserve" onClose={onClose} load={() => api.listReserves(org)}>
      {(rs) => <ActionDialog {...common} title="Add to the business reserve" confirmText="Add to reserve"
        intro="Sets money aside so it does not count as safe to spend. The money stays in your account."
        fields={[{ name: "reserve", label: "Reserve", type: "select", required: true, options: opt(rs, "id", (r) => `${r.name} (${r.currency}) · now ${fmtMoney(r.current, r.currency)}`) },
          { name: "amount", label: "Amount to set aside", type: "money" }, { name: "date", label: "Date", type: "date", required: true, default: todayISO() }, { name: "note", label: "Note", type: "text" }]}
        onSubmit={(v, o, key) => api.moveReserve(org, key, v.reserve, "add", v.amount, v.date, { note: v.note, override: o })} />}</Lookup>);
    case "owner_payment": return (<Lookup title="Owner payment" onClose={onClose} load={() => api.listBankAccounts(org)}>
      {(banks) => <ActionDialog {...common} title="Record an owner payment" confirmText="Record payment"
        intro="Money you take out of the business, or put into it. Salary and draws are checked against safe-to-spend first."
        fields={[{ name: "type", label: "What kind", type: "select", required: true, options: Object.entries(OWNER_TYPE).map(([value, label]) => ({ value, label })) },
          { name: "amount", label: "Amount", type: "money" }, { name: "pay", label: "Account", type: "select", required: true, options: opt(banks, "ledger_account_id", (b) => `${b.name} (${b.currency})`) },
          { name: "date", label: "Date", type: "date", required: true, default: todayISO() }, { name: "note", label: "Note", type: "text" }]}
        onSubmit={(v, o, key) => { const b = banks.find((x) => x.ledger_account_id === v.pay); return api.recordOwnerPayment(org, key, v.type, v.amount, b.currency, v.date, v.pay, { note: v.note, override: o }); }} />}</Lookup>);
    default: return null;
  }
}
