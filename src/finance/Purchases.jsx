import React, { useMemo, useState } from "react";
import { S, T, Btn, Pill, Banner, Field, Modal, Table, Money, Totals, useBusy, fmtDate } from "./ui.jsx";
import { AgingCard } from "./Sales.jsx";
import { FINANCE_CURRENCIES, symbolToCode, formatMoney, todayLocal } from "./currency.js";
import { rpc } from "./api.js";
import { aging } from "./reports.js";

const METHODS = ["Bank transfer", "PayPal", "Wise", "Payoneer", "M-Pesa", "Cash", "Other"];
const today = () => todayLocal();
const num = (v) => Number(v) || 0;

function BillModal({ ctx, onClose }) {
  const { data, projects, teamMembers } = ctx;
  const [f, setF] = useState({ team_member_id: "", vendor_name: "", project_id: "", bill_number: "", description: "", currency: ctx.base, amount: "", issue_date: today(), due_date: "", account_id: "", approve: true });
  const { busy, error, run } = useBusy();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const costAccounts = data.accounts.filter((a) => a.type === "cogs" || a.type === "expense");
  const submit = () => run(async () => {
    await rpc("finance_save_bill", { p: { ...f, amount: num(f.amount) } });
    await ctx.reload(); onClose();
  });
  return (
    <Modal title="New bill" onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" disabled={busy || !(num(f.amount) > 0)} onClick={submit}>{busy ? "Saving..." : f.approve ? "Save and approve" : "Save draft"}</Btn></>}>
      <p style={S.sub}>A bill is money you owe. Cost is recognised now; cash only moves when you record a payment.</p>
      <div style={S.grid(180)}>
        <Field label="Freelancer / vendor">
          <select style={S.input} value={f.team_member_id} onChange={(e) => { const m = teamMembers.find((t) => t.id === e.target.value); setF({ ...f, team_member_id: e.target.value, vendor_name: m ? m.name : f.vendor_name }); }}>
            <option value="">Other vendor (type below)</option>{teamMembers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Field>
        <Field label="Name on bill"><input style={S.input} value={f.vendor_name} onChange={set("vendor_name")} /></Field>
        <Field label="Project"><select style={S.input} value={f.project_id} onChange={set("project_id")}><option value="">No project</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Bill number"><input style={S.input} value={f.bill_number} onChange={set("bill_number")} placeholder="Their invoice no." /></Field>
        <Field label="Currency"><select style={S.input} value={f.currency} onChange={set("currency")}>{FINANCE_CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</select></Field>
        <Field label="Amount"><input style={S.input} inputMode="decimal" value={f.amount} onChange={set("amount")} /></Field>
        <Field label="Issue date"><input style={S.input} type="date" value={f.issue_date} onChange={set("issue_date")} /></Field>
        <Field label="Due date"><input style={S.input} type="date" value={f.due_date} onChange={set("due_date")} /></Field>
        <Field label="Cost account" hint="Defaults to Freelancer / Contractor Costs"><select style={S.input} value={f.account_id} onChange={set("account_id")}><option value="">Freelancer / Contractor Costs</option>{costAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></Field>
      </div>
      <Field label="Description"><input style={S.input} value={f.description} onChange={set("description")} placeholder="e.g. Genga for shots 12-20" /></Field>
      <label style={{ fontSize: 13.5, display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={f.approve} onChange={set("approve")} /> Approve now (post to accounts payable)</label>
      {error && <Banner tone="bad">{error}</Banner>}
    </Modal>
  );
}

function PayBillModal({ ctx, bill, outstanding, onClose }) {
  const { data } = ctx;
  const banks = data.bankAccounts.filter((b) => !b.archived && b.currency === bill.currency);
  const [amount, setAmount] = useState(String(outstanding));
  const [date, setDate] = useState(today());
  const [bank, setBank] = useState(banks.find((b) => b.id === data.settings.default_bank_account_id)?.id || banks[0]?.id || "");
  const [method, setMethod] = useState("Bank transfer");
  const [reference, setReference] = useState("");
  const { busy, error, run } = useBusy();
  const submit = () => run(async () => {
    await rpc("finance_record_bill_payment", { p_bill: bill.id, p_amount: num(amount), p_date: date, p_bank_account: bank, p_method: method, p_reference: reference });
    await ctx.reload(); onClose();
  });
  return (
    <Modal title={`Pay ${bill.vendor_name}`} onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" disabled={busy || !bank || !(num(amount) > 0)} onClick={submit}>{busy ? "Recording..." : "Record payment"}</Btn></>}>
      <p style={S.sub}>Outstanding on this bill: <strong>{formatMoney(bill.currency, outstanding)}</strong>. This reduces what you owe and the selected account's balance; it does not create a second expense.</p>
      {banks.length === 0 && <Banner tone="warn">You have no {bill.currency} bank or cash account. Add one under Banking, or convert funds with a transfer first.</Banner>}
      <div style={S.grid(160)}>
        <Field label={`Amount (${bill.currency})`}><input style={S.input} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Date paid"><input style={S.input} type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Paid from"><select style={S.input} value={bank} onChange={(e) => setBank(e.target.value)}>{banks.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.currency})</option>)}</select></Field>
        <Field label="Method"><select style={S.input} value={method} onChange={(e) => setMethod(e.target.value)}>{METHODS.map((m) => <option key={m}>{m}</option>)}</select></Field>
      </div>
      <Field label="Reference"><input style={S.input} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Transaction ID, optional" /></Field>
      {error && <Banner tone="bad">{error}</Banner>}
    </Modal>
  );
}

export function Purchases({ ctx }) {
  const { data, postings, privacy, base, cards, projects, teamMembers } = ctx;
  const [modal, setModal] = useState(null); // 'bill' | {pay: bill}
  const [expanded, setExpanded] = useState(null);
  const [picked, setPicked] = useState({});
  const { busy, error, run } = useBusy();
  const t = today();
  const docs = data.bills.map((b) => ({ id: b.id, number: b.bill_number, dueDate: b.due_date || b.issue_date, party: b.vendor_name, projectId: b.project_id }));
  const ap = useMemo(() => aging(postings, "ap", docs, t), [postings, data.bills]);

  const billed = useMemo(() => new Set(data.billShots.map((s) => s.shot_id)), [data.billShots]);
  const projectBy = new Map(projects.map((p) => [p.id, p]));
  const unbilled = useMemo(() => {
    const groups = new Map();
    for (const c of cards) {
      const pay = num(c.assignedPay);
      if (!pay || c.assignedPaid || billed.has(c.id) || !(c.assignedTo || c.assignedMemberId)) continue;
      const member = teamMembers.find((m) => m.id === c.assignedMemberId);
      const ccy = symbolToCode(projectBy.get(c.projectId)?.currency);
      const key = `${c.assignedMemberId || c.assignedTo}|${ccy}`;
      if (!groups.has(key)) groups.set(key, { key, vendor: member?.name || c.assignedTo, ccy, total: 0, ids: [] });
      const g = groups.get(key); g.total += pay; g.ids.push(c.id);
    }
    return [...groups.values()];
  }, [cards, billed, teamMembers, projects]);

  const paymentsOf = (id) => data.billPayments.filter((p) => p.bill_id === id);
  const statusOf = (b) => {
    const out = num(b.amount) - num(b.amount_paid);
    if (b.status === "void") return { tone: "muted", label: "Void" };
    if (b.status === "draft") return { tone: "muted", label: "Draft" };
    if (b.status === "paid") return { tone: "ok", label: "Paid" };
    const overdue = out > 0.004 && (b.due_date || "") && b.due_date < t;
    if (b.status === "partially_paid") return { tone: overdue ? "bad" : "warn", label: overdue ? "Partially paid \u00b7 overdue" : "Partially paid" };
    return overdue ? { tone: "bad", label: "Overdue" } : { tone: "info", label: "Approved" };
  };
  const owedByVendor = useMemo(() => {
    const m = new Map();
    for (const r of ap.rows) { const k = r.party || "-"; if (!m.has(k)) m.set(k, {}); m.get(k)[r.currency] = (m.get(k)[r.currency] || 0) + r.native; }
    return [...m.entries()].map(([vendor, totals]) => ({ vendor, totals }));
  }, [ap]);

  return (
    <>
      <div style={{ ...S.row, justifyContent: "space-between" }}>
        <div><h2 style={S.h2}>Purchases</h2><p style={S.sub}>What you owe freelancers and suppliers, and the payments you've made.</p></div>
        <Btn kind="primary" onClick={() => setModal("bill")}>New bill</Btn>
      </div>
      {error && <Banner tone="bad">{error}</Banner>}
      <AgingCard title="Accounts payable" report={ap} privacy={privacy} base={base} />

      {owedByVendor.length > 0 && (
        <div style={S.card}>
          <h3 style={S.h3}>You owe</h3>
          <Table rowKey={(r) => r.vendor} rows={owedByVendor} columns={[
            { key: "v", label: "Freelancer / vendor", render: (r) => r.vendor },
            { key: "t", label: "Outstanding (native)", num: true, render: (r) => <Totals totals={r.totals} privacy={privacy} /> },
          ]} />
        </div>
      )}

      {unbilled.length > 0 && (
        <div style={S.card}>
          <h3 style={S.h3}>Assigned work not yet billed</h3>
          <p style={S.sub}>Assigning a shot to a freelancer is not a payment and not yet a liability. Create a bill when you accept their work; it then appears under "You owe".</p>
          <Table rowKey={(g) => g.key} rows={unbilled} columns={[
            { key: "v", label: "Freelancer", render: (g) => g.vendor },
            { key: "n", label: "Shots", render: (g) => g.ids.length },
            { key: "t", label: "Amount", num: true, render: (g) => <Money code={g.ccy} amount={g.total} privacy={privacy} /> },
            { key: "a", label: "", render: (g) => <Btn small disabled={busy} onClick={() => run(async () => { await rpc("finance_bill_pending_shots", { p_shot_ids: g.ids, p_issue: t, p_due: null }); await ctx.reload(); })}>Create bill</Btn> },
          ]} />
        </div>
      )}

      <div style={S.card}>
        <h3 style={S.h3}>Bills</h3>
        <Table rowKey={(b) => b.id} empty="No bills yet." rows={data.bills} columns={[
          { key: "n", label: "Bill", render: (b) => <><strong>{b.bill_number || b.id.slice(0, 8)}</strong><div style={{ fontSize: 12, color: T.muted }}>{b.description}</div></> },
          { key: "v", label: "Vendor", render: (b) => b.vendor_name },
          { key: "p", label: "Project", render: (b) => projectBy.get(b.project_id)?.name || "-" },
          { key: "due", label: "Due", render: (b) => (b.due_date ? fmtDate(b.due_date) : "-") },
          { key: "t", label: "Amount", num: true, render: (b) => <Money code={b.currency} amount={num(b.amount)} privacy={privacy} /> },
          { key: "pd", label: "Paid", num: true, render: (b) => <Money code={b.currency} amount={num(b.amount_paid)} privacy={privacy} /> },
          { key: "o", label: "Outstanding", num: true, render: (b) => <strong><Money code={b.currency} amount={b.status === "void" ? 0 : Math.max(0, num(b.amount) - num(b.amount_paid))} privacy={privacy} /></strong> },
          { key: "s", label: "Status", render: (b) => { const s = statusOf(b); return <Pill tone={s.tone}>{s.label}</Pill>; } },
          { key: "x", label: "", render: (b) => (
            <span style={S.row}>
              {b.status === "draft" && <Btn small onClick={() => run(async () => { await rpc("finance_approve_bill", { p_bill: b.id }); await ctx.reload(); })}>Approve</Btn>}
              {(b.status === "approved" || b.status === "partially_paid") && <Btn small kind="primary" onClick={() => setModal({ pay: b })}>Pay</Btn>}
              <Btn small kind="link" onClick={() => setExpanded(expanded === b.id ? null : b.id)}>{paymentsOf(b.id).length} payment(s)</Btn>
              {b.status !== "void" && b.status !== "paid" && <Btn small kind="danger" onClick={() => { const r = window.prompt("Reason for voiding this bill?", "Entered in error"); if (r !== null) run(async () => { await rpc("finance_void_bill", { p_bill: b.id, p_reason: r }); await ctx.reload(); }); }}>Void</Btn>}
            </span>) },
        ]} />
        {expanded && (
          <div style={{ ...S.card, background: T.raised }}>
            <h3 style={S.h3}>Payments on this bill</h3>
            <Table rowKey={(p) => p.id} empty="No payments yet." rows={paymentsOf(expanded)} columns={[
              { key: "d", label: "Date", render: (p) => fmtDate(p.paid_date) },
              { key: "a", label: "Amount", num: true, render: (p) => <Money code={p.currency} amount={num(p.amount)} privacy={privacy} /> },
              { key: "acc", label: "Paid from", render: (p) => data.bankAccounts.find((b) => b.id === p.bank_account_id)?.name || (p.is_legacy ? "Legacy (unallocated)" : "Unallocated") },
              { key: "m", label: "Method", render: (p) => p.method || "-" },
              { key: "s", label: "Status", render: (p) => <Pill tone={p.status === "void" ? "muted" : "ok"}>{p.status === "void" ? "Void" : "Posted"}</Pill> },
              { key: "x", label: "", render: (p) => p.status === "posted" ? <Btn small kind="danger" onClick={() => { const r = window.prompt("Reason for voiding this payment?", "Entered in error"); if (r !== null) run(async () => { await rpc("finance_void_bill_payment", { p_payment: p.id, p_reason: r }); await ctx.reload(); }); }}>Void</Btn> : null },
            ]} />
          </div>
        )}
      </div>
      {modal === "bill" && <BillModal ctx={ctx} onClose={() => setModal(null)} />}
      {modal?.pay && <PayBillModal ctx={ctx} bill={modal.pay} outstanding={Math.max(0, num(modal.pay.amount) - num(modal.pay.amount_paid))} onClose={() => setModal(null)} />}
    </>
  );
}
