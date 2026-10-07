import React, { useMemo, useState } from "react";
import { S, T, Btn, Pill, Banner, Field, Modal, Table, Money, Totals, useBusy } from "./ui.jsx";
import { FINANCE_CURRENCIES, formatMoney, r2, todayLocal } from "./currency.js";
import { rpc } from "./api.js";
import { bankBalances, legacyCash } from "./reports.js";

const today = () => todayLocal();
const num = (v) => Number(v) || 0;

function AccountModal({ ctx, onClose }) {
  const [f, setF] = useState({ name: "", kind: "bank", currency: ctx.base, opening: "", date: today() });
  const { busy, error, run } = useBusy();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="Add bank or cash account" onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" disabled={busy || !f.name.trim()} onClick={() => run(async () => { await rpc("finance_create_bank_account", { p_name: f.name, p_kind: f.kind, p_currency: f.currency, p_opening_balance: num(f.opening), p_opened_on: f.date }); await ctx.reload(); onClose(); })}>{busy ? "Adding..." : "Add account"}</Btn></>}>
      <div style={S.grid(170)}>
        <Field label="Name"><input style={S.input} value={f.name} onChange={set("name")} placeholder="e.g. Wise EUR, KCB Current" /></Field>
        <Field label="Type"><select style={S.input} value={f.kind} onChange={set("kind")}><option value="bank">Bank account</option><option value="wallet">Wallet (PayPal, M-Pesa...)</option><option value="cash">Cash</option></select></Field>
        <Field label="Currency" hint="An account holds one currency."><select style={S.input} value={f.currency} onChange={set("currency")}>{FINANCE_CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</select></Field>
        <Field label="Opening balance" hint="Balance on the opening date"><input style={S.input} inputMode="decimal" value={f.opening} onChange={set("opening")} placeholder="0" /></Field>
        <Field label="Opening date"><input style={S.input} type="date" value={f.date} onChange={set("date")} /></Field>
      </div>
      {error && <Banner tone="bad">{error}</Banner>}
    </Modal>
  );
}

function TransferModal({ ctx, onClose }) {
  const banks = ctx.data.bankAccounts.filter((b) => !b.archived);
  const [f, setF] = useState({ from: banks[0]?.id || "", to: banks[1]?.id || "", amountFrom: "", amountTo: "", date: today(), reference: "" });
  const { busy, error, run } = useBusy();
  const from = banks.find((b) => b.id === f.from), to = banks.find((b) => b.id === f.to);
  const cross = from && to && from.currency !== to.currency;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="Transfer between accounts" onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" disabled={busy || !from || !to || from.id === to.id || !(num(f.amountFrom) > 0)} onClick={() => run(async () => { await rpc("finance_record_transfer", { p_from: f.from, p_to: f.to, p_amount_from: num(f.amountFrom), p_amount_to: cross ? num(f.amountTo) : num(f.amountFrom), p_date: f.date, p_reference: f.reference }); await ctx.reload(); onClose(); })}>{busy ? "Transferring..." : "Transfer"}</Btn></>}>
      <p style={S.sub}>Moving money between your own accounts is not income or expense. Only the two balances change.</p>
      {banks.length < 2 && <Banner tone="warn">Add at least two accounts to record a transfer.</Banner>}
      <div style={S.grid(170)}>
        <Field label="From"><select style={S.input} value={f.from} onChange={set("from")}>{banks.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.currency})</option>)}</select></Field>
        <Field label="To"><select style={S.input} value={f.to} onChange={set("to")}>{banks.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.currency})</option>)}</select></Field>
        <Field label={`Amount sent${from ? ` (${from.currency})` : ""}`}><input style={S.input} inputMode="decimal" value={f.amountFrom} onChange={set("amountFrom")} /></Field>
        {cross && <Field label={`Amount received (${to.currency})`} hint="What actually arrived"><input style={S.input} inputMode="decimal" value={f.amountTo} onChange={set("amountTo")} /></Field>}
        <Field label="Date"><input style={S.input} type="date" value={f.date} onChange={set("date")} /></Field>
        <Field label="Reference"><input style={S.input} value={f.reference} onChange={set("reference")} /></Field>
      </div>
      {cross && <p style={S.sub}>Different currencies: the conversion is valued at the stored rates for that date and any difference is booked as realized FX gain/loss. If a rate is missing the transfer is refused rather than guessed.</p>}
      {error && <Banner tone="bad">{error}</Banner>}
    </Modal>
  );
}

function ReconcileModal({ ctx, bank, onClose }) {
  const lines = useMemo(() => ctx.postings.filter((p) => p.accountId === bank.account_id && !p.reconciledAt && (p.debit || p.credit)).sort((a, b) => a.date.localeCompare(b.date)), [ctx.postings, bank]);
  const clearedAlready = r2(ctx.postings.filter((p) => p.accountId === bank.account_id && p.reconciledAt).reduce((s, p) => s + p.native, 0));
  const [sel, setSel] = useState({});
  const [date, setDate] = useState(today());
  const [stmt, setStmt] = useState("");
  const { busy, error, run } = useBusy();
  const picked = lines.filter((l) => sel[l.lineId]);
  const cleared = r2(clearedAlready + picked.reduce((s, p) => s + p.native, 0));
  const diff = r2(num(stmt) - cleared);
  return (
    <Modal title={`Reconcile \u00b7 ${bank.name}`} onClose={onClose} width={720} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" disabled={busy || stmt === "" || Math.abs(diff) > 0.005} onClick={() => run(async () => { await rpc("finance_reconcile", { p_bank: bank.id, p_statement_date: date, p_statement_balance: num(stmt), p_line_ids: picked.map((p) => p.lineId) }); await ctx.reload(); onClose(); })}>{busy ? "Saving..." : "Mark reconciled"}</Btn></>}>
      <p style={S.sub}>Tick the transactions that appear on your bank statement, enter the statement's closing balance, and the difference should reach zero.</p>
      <div style={S.grid(160)}>
        <Field label="Statement date"><input style={S.input} type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label={`Statement balance (${bank.currency})`}><input style={S.input} inputMode="decimal" value={stmt} onChange={(e) => setStmt(e.target.value)} /></Field>
      </div>
      <div style={{ ...S.row, justifyContent: "space-between" }}>
        <span>Cleared book balance: <strong>{formatMoney(bank.currency, cleared)}</strong></span>
        <span style={{ color: stmt === "" ? T.muted : Math.abs(diff) < 0.005 ? T.ok : T.bad }}>Difference: <strong>{stmt === "" ? "-" : formatMoney(bank.currency, diff)}</strong></span>
      </div>
      <div style={{ maxHeight: 320, overflowY: "auto" }}>
        <Table rowKey={(l) => l.lineId} empty="Everything in this account is already reconciled." rows={lines} columns={[
          { key: "c", label: "", render: (l) => <input type="checkbox" checked={!!sel[l.lineId]} onChange={(e) => setSel({ ...sel, [l.lineId]: e.target.checked })} /> },
          { key: "d", label: "Date", render: (l) => l.date },
          { key: "m", label: "Description", render: (l) => l.entryMemo || l.memo },
          { key: "a", label: "Amount", num: true, render: (l) => formatMoney(bank.currency, l.native, { signed: true }) },
        ]} />
      </div>
      {error && <Banner tone="bad">{error}</Banner>}
    </Modal>
  );
}

export function Banking({ ctx }) {
  const { data, postings, privacy, base } = ctx;
  const [modal, setModal] = useState(null);
  const [selected, setSelected] = useState(null);
  const { error, run } = useBusy();
  const balances = useMemo(() => bankBalances(postings, data.bankAccounts), [postings, data.bankAccounts]);
  const legacy = useMemo(() => legacyCash(postings), [postings]);
  const sel = data.bankAccounts.find((b) => b.id === selected);
  const txns = sel ? postings.filter((p) => p.accountId === sel.account_id && (p.debit || p.credit)).sort((a, b) => b.date.localeCompare(a.date) || b.entryNo - a.entryNo) : [];
  return (
    <>
      <div style={{ ...S.row, justifyContent: "space-between" }}>
        <div><h2 style={S.h2}>Banking</h2><p style={S.sub}>Where the money actually is. Balances come from the ledger, not from a typed-in number.</p></div>
        <span style={S.row}><Btn onClick={() => setModal("transfer")}>Transfer</Btn><Btn kind="primary" onClick={() => setModal("account")}>Add account</Btn></span>
      </div>
      {error && <Banner tone="bad">{error}</Banner>}
      {legacy.hasActivity && (
        <Banner tone="info">
          Historic payments and expenses from before Finance v2 sit in <strong>Legacy Cash (unallocated)</strong> because they were never tied to a bank account. Add your real accounts and move the money with a transfer from Legacy Cash, via Accounting &gt; Journal entry, when you're ready.
        </Banner>
      )}
      <div style={S.card}>
        <Table rowKey={(r) => r.bank.id} empty="No bank or cash accounts yet. Add one to receive customer payments and pay bills." rows={balances} columns={[
          { key: "n", label: "Account", render: (r) => <><strong>{r.bank.name}</strong>{data.settings.default_bank_account_id === r.bank.id ? <span style={{ color: T.accentText }}> {"\u00b7"} default</span> : null}<div style={{ fontSize: 12, color: T.muted }}>{r.bank.kind}{r.bank.archived ? " \u00b7 archived" : ""}</div></> },
          { key: "c", label: "Currency", render: (r) => r.bank.currency },
          { key: "b", label: "Balance", num: true, render: (r) => <strong><Money code={r.bank.currency} amount={r.native} privacy={privacy} /></strong> },
          { key: "v", label: `In ${base}`, num: true, render: (r) => r.baseMissing ? <Pill tone="warn">rate missing</Pill> : <Money code={base} amount={r.base} privacy={privacy} /> },
          { key: "u", label: "Unreconciled", num: true, render: (r) => r.unreconciledCount },
          { key: "t", label: "Reconciled to", render: (r) => r.bank.reconciled_through || <span style={{ color: T.muted }}>never</span> },
          { key: "a", label: "", render: (r) => (
            <span style={S.row}>
              <Btn small kind="link" onClick={() => setSelected(selected === r.bank.id ? null : r.bank.id)}>Transactions</Btn>
              <Btn small onClick={() => setModal({ reconcile: r.bank })}>Reconcile</Btn>
              <Btn small kind="link" onClick={() => { const name = window.prompt("Rename account", r.bank.name); if (name) run(async () => { await rpc("finance_update_bank_account", { p_id: r.bank.id, p_name: name, p_archived: r.bank.archived, p_make_default: false }); await ctx.reload(); }); }}>Rename</Btn>
              {data.settings.default_bank_account_id !== r.bank.id && <Btn small kind="link" onClick={() => run(async () => { await rpc("finance_update_bank_account", { p_id: r.bank.id, p_name: r.bank.name, p_archived: r.bank.archived, p_make_default: true }); await ctx.reload(); })}>Make default</Btn>}
            </span>) },
        ]} />
        {legacy.hasActivity && (
          <div style={{ ...S.row, justifyContent: "space-between", borderTop: `1px solid ${T.rule}`, paddingTop: 10, fontSize: 13.5 }}>
            <span>Legacy Cash (unallocated)</span>
            <span style={{ color: T.muted }}><Totals totals={legacy.nativeByCurrency} privacy={privacy} /></span>
          </div>
        )}
      </div>
      {sel && (
        <div style={S.card}>
          <h3 style={S.h3}>{sel.name} transactions</h3>
          <Table rowKey={(p) => p.lineId} empty="No transactions." rows={txns} columns={[
            { key: "d", label: "Date", render: (p) => p.date },
            { key: "m", label: "Description", render: (p) => <>{p.entryMemo || p.memo}<div style={{ fontSize: 12, color: T.muted }}>{p.sourceType}{p.reference ? ` \u00b7 ${p.reference}` : ""}</div></> },
            { key: "i", label: "Money in", num: true, render: (p) => p.debit ? <Money code={p.currency} amount={p.debit} privacy={privacy} /> : "" },
            { key: "o", label: "Money out", num: true, render: (p) => p.credit ? <Money code={p.currency} amount={p.credit} privacy={privacy} /> : "" },
            { key: "r", label: "Reconciled", render: (p) => p.reconciledAt ? <Pill tone="ok">Yes</Pill> : <span style={{ color: T.muted }}>-</span> },
          ]} />
        </div>
      )}
      {modal === "account" && <AccountModal ctx={ctx} onClose={() => setModal(null)} />}
      {modal === "transfer" && <TransferModal ctx={ctx} onClose={() => setModal(null)} />}
      {modal?.reconcile && <ReconcileModal ctx={ctx} bank={modal.reconcile} onClose={() => setModal(null)} />}
    </>
  );
}
