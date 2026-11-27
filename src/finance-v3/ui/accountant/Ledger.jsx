import React, { useEffect, useState } from "react";
import { Async, Banner, Button, DataTable, EmptyState, Field, Pager, Pill, useFinance, useResource } from "../shared/kit.jsx";
import { Money } from "../shared/parts.jsx";
import { ENTRY_KIND, fmtDate, label, todayISO } from "../shared/format.js";
import { RangeBar, ccyArg, useRange, validRange } from "./common.jsx";

export function ChartOfAccounts({ go = undefined }) {
  const { api, org } = useFinance(); const [inactive, setInactive] = useState(false); const [type, setType] = useState(""); const [q, setQ] = useState("");
  const res = useResource(() => api.listAccounts(org, inactive), [api, org, inactive]);
  return (<div className="stack"><div className="row" style={{ alignItems: "flex-end" }}>
    <Field label="Search code or name"><input value={q} onChange={(e) => setQ(e.target.value)} /></Field>
    <Field label="Type"><select value={type} onChange={(e) => setType(e.target.value)}><option value="">All</option>{["asset", "liability", "equity", "revenue", "cost_of_sales", "expense", "other_income", "other_expense"].map((t) => <option key={t} value={t}>{label({}, t)}</option>)}</select></Field>
    <label className="row sub"><input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} /> Include inactive</label></div>
    <Async res={res}>{(rows) => { const f = rows.filter((a) => (!type || a.account_type === type) && (!q || `${a.code} ${a.name}`.toLowerCase().includes(q.toLowerCase())));
      return <DataTable caption="Chart of accounts" rows={f} onRowClick={(a) => go("gl", a.id)} columns={[{ key: "code", header: "Code" }, { key: "name", header: "Account" }, { key: "account_type", header: "Type", render: (a) => label({}, a.account_type) },
        { key: "normal_balance", header: "Normal balance", render: (a) => label({}, a.normal_balance) }, { key: "currency", header: "Currency", render: (a) => a.currency || "Any" },
        { key: "flags", header: "", render: (a) => <>{a.is_system && <Pill>System</Pill>} {!a.is_active && <Pill tone="warn">Inactive</Pill>} {!a.is_postable && <Pill>Header</Pill>}</> }]} empty={<EmptyState title="No accounts match" />} />; }}</Async></div>);
}

export function GeneralLedger({ jump = undefined }) {
  const { api, org } = useFinance(); const accounts = useResource(() => api.listAccounts(org, true), [api, org]);
  const [acct, setAcct] = useState(jump || ""); const [r, setR] = useRange(90); const [c, setC] = useState(""); const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [acct, r.from, r.to, c]);
  const res = useResource(() => (acct && validRange(r) ? api.generalLedger(org, acct, { from: r.from, to: r.to, currency: ccyArg(c), limit: 50, offset }) : Promise.resolve(null)), [api, org, acct, r.from, r.to, c, offset]);
  return (<div className="stack"><div className="row" style={{ alignItems: "flex-end" }}>
    <Field label="Account"><select value={acct} onChange={(e) => setAcct(e.target.value)}><option value="">Choose an account…</option>{(accounts.data || []).map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></Field>
    <RangeBar range={r} onChange={setR} currency={c} onCurrency={setC} /></div>
    {!acct ? <EmptyState title="Choose an account to see its ledger" /> : !validRange(r) ? <Banner tone="warning">Choose a start date that is not after the end date.</Banner> :
      <Async res={res}>{(d) => d && (<><p><b>{d.account.code} {d.account.name}</b> · normal {d.account.normal_balance} balance · {d.basis === "base" ? "base currency" : `${d.currency} only`}</p>
        <p>Opening balance <Money value={d.opening_balance} currency={d.currency} /></p>
        <DataTable caption="General ledger" rows={d.lines} rowKey={(x, i) => i} columns={[{ key: "date", header: "Date", render: (x) => fmtDate(x.date) }, { key: "entry_no", header: "Journal ref", render: (x) => `JE-${x.entry_no}` }, { key: "reference", header: "Reference" }, { key: "memo", header: "Description" },
          { key: "debit", header: "Debit", num: true, render: (x) => x.debit ?? "" }, { key: "credit", header: "Credit", num: true, render: (x) => x.credit ?? "" }, { key: "balance", header: "Balance", num: true, render: (x) => <Money value={x.balance} /> }]} empty={<EmptyState title="No postings in this period" />} />
        <Pager total={d.total_lines} limit={d.limit} offset={d.offset} onChange={setOffset} /><p>Closing balance <b><Money value={d.closing_balance} currency={d.currency} /></b></p></>)}</Async>}</div>);
}

export function Journal() {
  const { api, org } = useFinance(); const [r, setR] = useState({ from: "", to: "" }); const [q, setQ] = useState(""); const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [r.from, r.to, q]);
  const ok = !r.from || !r.to || r.from <= r.to;
  const res = useResource(() => (ok ? api.listEntries(org, { from: r.from || null, to: r.to || null, search: q.trim() || null, limit: 25, offset }) : Promise.resolve(null)), [api, org, r.from, r.to, q, offset]);
  return (<div className="stack"><div className="row" style={{ alignItems: "flex-end" }}><Field label="From"><input type="date" value={r.from} onChange={(e) => setR({ ...r, from: e.target.value })} /></Field>
    <Field label="To" error={ok ? null : "From is after To."}><input type="date" value={r.to} onChange={(e) => setR({ ...r, to: e.target.value })} /></Field>
    <Field label="Search memo, reference or number"><input value={q} maxLength={100} onChange={(e) => setQ(e.target.value)} /></Field></div>
    <Async res={res}>{(d) => d && (<>{d.items.length === 0 ? <EmptyState title="No journal entries match" /> : d.items.map((e) => (<section key={e.id} className="card" aria-label={`Journal entry ${e.entry_no}`}>
      <div className="row" style={{ justifyContent: "space-between" }}><b>JE-{e.entry_no} · {fmtDate(e.date)}</b><span className="row">{e.kind ? <Pill>{label(ENTRY_KIND, e.kind)}</Pill> : <Pill>Manual journal</Pill>}{e.reversed && <Pill tone="warn">Reversed</Pill>}{e.reverses_entry_id && <Pill tone="info">Reversal</Pill>}{e.fx_status === "missing" && <Pill tone="bad">No FX rate</Pill>}</span></div>
      <p className="sub">{e.memo}{e.reference ? ` · ref ${e.reference}` : ""}{e.reversal_reason ? ` · ${e.reversal_reason}` : ""}</p>
      <DataTable caption={`Lines of JE-${e.entry_no}`} rows={e.lines} rowKey={(l) => l.line_no} columns={[{ key: "account_code", header: "Account", render: (l) => `${l.account_code} ${l.account_name}` },
        { key: "debit", header: "Debit", num: true, render: (l) => (l.side === "debit" ? <Money value={l.amount} currency={l.currency} /> : "") }, { key: "credit", header: "Credit", num: true, render: (l) => (l.side === "credit" ? <Money value={l.amount} currency={l.currency} /> : "") },
        { key: "amount_base", header: "Base amount", num: true, render: (l) => l.amount_base ?? "—" }, { key: "memo", header: "Line note" }]} /></section>))}
      <Pager total={d.total} limit={d.limit} offset={d.offset} onChange={setOffset} /></>)}</Async></div>);
}

export function TrialBalance({ go = undefined }) {
  const { api, org } = useFinance(); const [asOf, setAsOf] = useState(todayISO()); const [c, setC] = useState("");
  const res = useResource(() => api.trialBalance(org, asOf, ccyArg(c)), [api, org, asOf, c]);
  return (<div className="stack"><RangeBar range={{ from: "", to: asOf }} onChange={(x) => setAsOf(x.to)} single currency={c} onCurrency={setC} />
    <Async res={res}>{(d) => (<>{d.balanced ? <Banner tone="ok">Debits equal credits.</Banner> : <Banner tone="critical" title="Debits and credits differ.">Please report this.</Banner>}
      {d.excluded_entries > 0 && <Banner tone="warning">{d.excluded_entries} entr{d.excluded_entries === 1 ? "y is" : "ies are"} left out because of a missing exchange rate.</Banner>}
      <DataTable caption="Trial balance" rows={d.accounts} rowKey={(a) => a.account_id} onRowClick={(a) => go("gl", a.account_id)} columns={[{ key: "code", header: "Code" }, { key: "name", header: "Account" }, { key: "account_type", header: "Type", render: (a) => label({}, a.account_type) },
        { key: "debit", header: "Debit", num: true, render: (a) => <Money value={a.debit} /> }, { key: "credit", header: "Credit", num: true, render: (a) => <Money value={a.credit} /> }]}
        totals={["", "Total", "", <Money key="d" value={d.total_debits} currency={d.currency} />, <Money key="c" value={d.total_credits} currency={d.currency} />]} empty={<EmptyState title="Nothing has been posted yet" />} /></>)}</Async></div>);
}
