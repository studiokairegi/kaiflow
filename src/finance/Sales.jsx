import React, { useMemo, useState } from "react";
import { S, T, Btn, Pill, Banner, Field, Modal, Table, Money, Totals, useBusy } from "./ui.jsx";
import { symbolToCode, formatMoney, todayLocal } from "./currency.js";
import { rpc } from "./api.js";
import { aging, documentPositions, expensesByCategory } from "./reports.js";

const METHODS = ["Bank transfer", "PayPal", "Wise", "Payoneer", "M-Pesa", "Cash", "Other"];
const today = () => todayLocal();

export function AgingCard({ title, report, privacy, base }) {
  return (
    <div style={S.card}>
      <h3 style={S.h3}>{title}</h3>
      <div style={S.grid(130)}>
        {report.buckets.map((b) => (
          <div key={b.id} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={S.label}>{b.label}</span>
            <strong style={{ fontSize: 16 }}><Money code={base} amount={b.base} privacy={privacy} /></strong>
            <span style={{ fontSize: 12, color: T.muted }}><Totals totals={b.nativeByCurrency} privacy={privacy} /></span>
          </div>
        ))}
      </div>
      {report.unresolved > 0 && <span style={{ fontSize: 12.5, color: T.warn }}>{report.unresolved} item(s) have no exchange rate yet and are not in the base-currency figures. Resolve them in Settings &gt; FX.</span>}
    </div>
  );
}

function PaymentModal({ ctx, invoice, outstanding, onClose }) {
  const { data, base } = ctx;
  const code = symbolToCode(invoice.currency);
  const banks = data.bankAccounts.filter((b) => !b.archived && b.currency === code);
  const [amount, setAmount] = useState(String(outstanding));
  const [date, setDate] = useState(today());
  const [bank, setBank] = useState(banks.find((b) => b.id === data.settings.default_bank_account_id)?.id || banks[0]?.id || "");
  const [method, setMethod] = useState("Bank transfer");
  const [reference, setReference] = useState("");
  const { busy, error, run } = useBusy();
  const submit = () => run(async () => {
    await rpc("finance_record_invoice_payment", { p_invoice: invoice.id, p_amount: Number(amount), p_date: date, p_bank_account: bank, p_method: method, p_reference: reference });
    await ctx.reload(); await ctx.refreshApp(); onClose();
  });
  return (
    <Modal title={`Record payment \u00b7 ${invoice.invoiceNumber}`} onClose={onClose}
      footer={<><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" disabled={busy || !bank || !(Number(amount) > 0)} onClick={submit}>{busy ? "Recording..." : "Record payment"}</Btn></>}>
      <p style={S.sub}>Outstanding: <strong>{formatMoney(code, outstanding)}</strong>. Each payment is its own record; the invoice status follows from them.</p>
      {banks.length === 0 && <Banner tone="warn">There is no {code} bank or cash account yet. Add one under Banking first, then record the payment.</Banner>}
      <div style={S.grid(160)}>
        <Field label={`Amount (${code})`}><input style={S.input} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Date received"><input style={S.input} type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Received into">
          <select style={S.input} value={bank} onChange={(e) => setBank(e.target.value)}>{banks.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.currency})</option>)}</select>
        </Field>
        <Field label="Method"><select style={S.input} value={method} onChange={(e) => setMethod(e.target.value)}>{METHODS.map((m) => <option key={m}>{m}</option>)}</select></Field>
      </div>
      <Field label="Reference"><input style={S.input} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Transaction ID, optional" /></Field>
      {code !== base && <p style={S.sub}>This is a {code} invoice and your base currency is {base}. The payment is converted at the rate for the payment date; any difference from the invoice-date value is booked as realized FX gain/loss. If no rate exists for that date it is flagged for you to resolve, never assumed.</p>}
      {error && <Banner tone="bad">{error}</Banner>}
    </Modal>
  );
}

export function Sales({ ctx }) {
  const { data, postings, privacy, base, invoices, projects } = ctx;
  const [payFor, setPayFor] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const { error, run } = useBusy();
  const projectBy = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const superseded = useMemo(() => new Set(invoices.filter((i) => i.convertedFromId).map((i) => i.convertedFromId)), [invoices]);
  const live = invoices.filter((i) => !superseded.has(i.id));
  const t = today();
  const docs = live.map((i) => ({ id: i.id, number: i.invoiceNumber, dueDate: i.dueDate, party: projectBy.get(i.projectId)?.client || "", projectId: i.projectId }));
  const ar = useMemo(() => aging(postings, "ar", docs, t), [postings, invoices]);
  const rows = live.map((i) => {
    const total = Number(i.amount) || 0, paid = Number(i.amountPaid) || 0;
    const outstanding = Math.max(0, Math.round((total - paid) * 100) / 100);
    const overdue = outstanding > 0 && i.dueDate && i.dueDate < t;
    const status = outstanding === 0 && total > 0 ? { tone: "ok", label: "Paid" } : paid > 0 ? { tone: overdue ? "bad" : "warn", label: overdue ? "Partially paid \u00b7 overdue" : "Partially paid" } : overdue ? { tone: "bad", label: "Overdue" } : { tone: "muted", label: i.docType === "proforma" ? "Awaiting payment" : "Unpaid" };
    return { inv: i, total, paid, outstanding, status, code: symbolToCode(i.currency) };
  }).sort((a, b) => (b.inv.issueDate || "").localeCompare(a.inv.issueDate || ""));
  const payments = (id) => data.invoicePayments.filter((p) => p.invoice_id === id);

  return (
    <>
      <div style={{ ...S.row, justifyContent: "space-between" }}>
        <div><h2 style={S.h2}>Sales</h2><p style={S.sub}>Invoices, payments received and who owes you money.</p></div>
        <Btn kind="primary" onClick={ctx.onNewInvoice}>New invoice</Btn>
      </div>
      {error && <Banner tone="bad">{error}</Banner>}
      <AgingCard title="Accounts receivable" report={ar} privacy={privacy} base={base} />
      <div style={S.card}>
        <h3 style={S.h3}>Invoices</h3>
        <Table rowKey={(r) => r.inv.id} empty="No invoices yet." rows={rows} columns={[
          { key: "n", label: "Number", render: (r) => <><strong style={{ whiteSpace: "nowrap" }}>{r.inv.invoiceNumber}</strong>{r.inv.docType && r.inv.docType !== "invoice" ? <span style={{ color: T.muted }}> {"\u00b7"} {r.inv.docType}</span> : null}</> },
          { key: "c", label: "Client / project", render: (r) => <>{projectBy.get(r.inv.projectId)?.client || "-"}<div style={{ fontSize: 12, color: T.muted }}>{projectBy.get(r.inv.projectId)?.name}</div></> },
          { key: "d", label: "Issued", render: (r) => <span style={{ whiteSpace: "nowrap" }}>{r.inv.issueDate || "-"}</span> },
          { key: "due", label: "Due", render: (r) => <span style={{ whiteSpace: "nowrap" }}>{r.inv.dueDate || "-"}</span> },
          { key: "t", label: "Total", num: true, render: (r) => <Money code={r.code} amount={r.total} privacy={privacy} /> },
          { key: "p", label: "Paid", num: true, render: (r) => <Money code={r.code} amount={r.paid} privacy={privacy} /> },
          { key: "b", label: "Balance", num: true, render: (r) => <strong><Money code={r.code} amount={r.outstanding} privacy={privacy} /></strong> },
          { key: "s", label: "Status", render: (r) => <Pill tone={r.status.tone}>{r.status.label}</Pill> },
          { key: "a", label: "", render: (r) => (
            <span style={S.row}>
              {r.outstanding > 0 && <Btn small kind="primary" onClick={() => setPayFor(r)}>Record payment</Btn>}
              <Btn small kind="link" onClick={() => setExpanded(expanded === r.inv.id ? null : r.inv.id)}>{payments(r.inv.id).length} payment(s)</Btn>
              <Btn small kind="link" onClick={() => ctx.onEditInvoice(r.inv)}>Edit</Btn>
            </span>) },
        ]} />
        {expanded && (
          <div style={{ ...S.card, background: T.raised }}>
            <h3 style={S.h3}>Payments</h3>
            <Table rowKey={(p) => p.id} empty="No payments recorded." rows={payments(expanded)} columns={[
              { key: "date", label: "Date", render: (p) => p.paid_date },
              { key: "amt", label: "Amount", num: true, render: (p) => <Money code={p.currency} amount={Number(p.amount)} privacy={privacy} /> },
              { key: "m", label: "Method", render: (p) => p.method || "-" },
              { key: "acc", label: "Account", render: (p) => data.bankAccounts.find((b) => b.id === p.bank_account_id)?.name || (p.is_legacy ? "Legacy (unallocated)" : "-") },
              { key: "ref", label: "Reference", render: (p) => p.reference || "-" },
              { key: "st", label: "Status", render: (p) => <Pill tone={p.status === "void" ? "muted" : "ok"}>{p.status === "void" ? `Void${p.void_reason ? `: ${p.void_reason}` : ""}` : "Posted"}</Pill> },
              { key: "x", label: "", render: (p) => p.status === "posted" ? <Btn small kind="danger" onClick={() => { const reason = window.prompt("Reason for voiding this payment?", "Entered in error"); if (reason !== null) run(async () => { await rpc("finance_void_invoice_payment", { p_payment: p.id, p_reason: reason }); await ctx.reload(); await ctx.refreshApp(); }); }}>Void</Btn> : null },
            ]} />
          </div>
        )}
      </div>
      {payFor && <PaymentModal ctx={ctx} invoice={payFor.inv} outstanding={payFor.outstanding} onClose={() => setPayFor(null)} />}
    </>
  );
}

export function Expenses({ ctx }) {
  const { data, postings, privacy, base, expenses, projects } = ctx;
  const projectBy = new Map(projects.map((p) => [p.id, p]));
  const year = today().slice(0, 4);
  const cats = useMemo(() => expensesByCategory(postings, { from: `${year}-01-01`, to: today() }), [postings]);
  const rows = [...expenses].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return (
    <>
      <div style={{ ...S.row, justifyContent: "space-between" }}>
        <div><h2 style={S.h2}>Expenses</h2><p style={S.sub}>Money already paid out (software, rent, equipment...). Money you still owe a freelancer or supplier belongs under Purchases &gt; Bills.</p></div>
        <Btn kind="primary" onClick={ctx.onNewExpense}>Add expense</Btn>
      </div>
      <div style={S.card}>
        <h3 style={S.h3}>This year by category</h3>
        <Table rowKey={(r) => r.accountId} empty="No expenses posted this year." rows={cats} columns={[
          { key: "c", label: "Account", render: (r) => `${r.code} ${r.name}` },
          { key: "n", label: "Native", render: (r) => <Totals totals={r.nativeByCurrency} privacy={privacy} /> },
          { key: "b", label: `Base (${base})`, num: true, render: (r) => <Money code={base} amount={r.amount} privacy={privacy} /> },
        ]} />
      </div>
      <div style={S.card}>
        <h3 style={S.h3}>All expenses</h3>
        <Table rowKey={(e) => e.id} onRow={ctx.onEditExpense} empty="No expenses recorded." rows={rows} columns={[
          { key: "d", label: "Date", render: (e) => e.date || "-" },
          { key: "x", label: "Description", render: (e) => <>{e.description || e.category}<div style={{ fontSize: 12, color: T.muted }}>{e.vendor || ""}</div></> },
          { key: "c", label: "Category", render: (e) => e.category },
          { key: "p", label: "Project", render: (e) => projectBy.get(e.projectId)?.name || "General" },
          { key: "a", label: "Paid from", render: (e) => data.bankAccounts.find((b) => b.id === e.bankAccountId)?.name || "Unallocated" },
          { key: "m", label: "Amount", num: true, render: (e) => <Money code={symbolToCode(e.currency)} amount={Number(e.amount) || 0} privacy={privacy} /> },
        ]} />
      </div>
    </>
  );
}
