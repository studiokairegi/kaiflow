import React, { useMemo, useState } from "react";
import { S, T, Btn, Pill, Banner, Field, Modal, Table, Money, Tabs, useBusy } from "./ui.jsx";
import { FINANCE_CURRENCIES, formatMoney, r2, todayLocal } from "./currency.js";
import { rpc, addAccount } from "./api.js";
import { validateEntry } from "./ledger.js";
import { trialBalance, generalLedger } from "./reports.js";

const today = () => todayLocal();
const num = (v) => Number(v) || 0;
const TYPE_LABEL = { asset: "Assets", liability: "Liabilities", equity: "Equity", revenue: "Revenue", cogs: "Direct production costs", expense: "Operating expenses" };

function Chart({ ctx }) {
  const { data, postings, privacy, base } = ctx;
  const tb = useMemo(() => trialBalance(postings, {}), [postings]);
  const bal = new Map(tb.rows.map((r) => [r.accountId, r]));
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ code: "", name: "", type: "expense", taxDeductible: true });
  const { busy, error, run } = useBusy();
  return (
    <>
      <div style={{ ...S.row, justifyContent: "space-between" }}>
        <p style={S.sub}>Every transaction is posted to these accounts. System accounts are fixed; you can add your own.</p>
        <Btn onClick={() => setAdding(true)}>Add account</Btn>
      </div>
      {Object.keys(TYPE_LABEL).map((type) => (
        <div key={type} style={S.card}>
          <h3 style={S.h3}>{TYPE_LABEL[type]}</h3>
          <Table rowKey={(a) => a.id} rows={data.accounts.filter((a) => a.type === type)} columns={[
            { key: "c", label: "Code", render: (a) => a.code },
            { key: "n", label: "Account", render: (a) => <>{a.name}{a.is_system ? <span style={{ color: T.muted }}> {"\u00b7"} system</span> : null}</> },
            { key: "d", label: "Tax deductible", render: (a) => (type === "cogs" || type === "expense") ? (a.tax_deductible ? "Yes" : "No") : "" },
            { key: "b", label: `Balance (${base})`, num: true, render: (a) => <Money code={base} amount={bal.get(a.id)?.balance ?? 0} privacy={privacy} /> },
          ]} />
        </div>
      ))}
      {adding && (
        <Modal title="Add account" onClose={() => setAdding(false)} footer={<><Btn onClick={() => setAdding(false)}>Cancel</Btn><Btn kind="primary" disabled={busy || !f.code || !f.name} onClick={() => run(async () => { await addAccount(ctx.userId, f); await ctx.reload(); setAdding(false); })}>Add</Btn></>}>
          <div style={S.grid(160)}>
            <Field label="Code"><input style={S.input} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="e.g. 6150" /></Field>
            <Field label="Name"><input style={S.input} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Type"><select style={S.input} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          </div>
          <label style={{ fontSize: 13.5, display: "flex", gap: 8 }}><input type="checkbox" checked={f.taxDeductible} onChange={(e) => setF({ ...f, taxDeductible: e.target.checked })} /> Tax-deductible (used in the tax summary)</label>
          {error && <Banner tone="bad">{error}</Banner>}
        </Modal>
      )}
    </>
  );
}

function Transactions({ ctx }) {
  const { data, privacy } = ctx;
  const [open, setOpen] = useState(null);
  const [q, setQ] = useState("");
  const { error, run } = useBusy();
  const accountBy = new Map(data.accounts.map((a) => [a.id, a]));
  const rows = [...data.entries].sort((a, b) => b.entry_no - a.entry_no).filter((e) => !q || `${e.memo} ${e.reference} ${e.source_type} ${e.entry_no}`.toLowerCase().includes(q.toLowerCase()));
  const lines = (id) => data.lines.filter((l) => l.entry_id === id);
  return (
    <>
      <input style={{ ...S.input, maxWidth: 320 }} placeholder="Search memo, reference, type..." value={q} onChange={(e) => setQ(e.target.value)} />
      {error && <Banner tone="bad">{error}</Banner>}
      <div style={S.card}>
        <Table rowKey={(e) => e.id} rows={rows.slice(0, 300)} empty="No transactions yet." onRow={(e) => setOpen(open === e.id ? null : e.id)} columns={[
          { key: "n", label: "#", render: (e) => e.entry_no },
          { key: "d", label: "Date", render: (e) => e.entry_date },
          { key: "m", label: "Description", render: (e) => <>{e.memo}<div style={{ fontSize: 12, color: T.muted }}>{e.source_type}{e.reference ? ` \u00b7 ${e.reference}` : ""}</div></> },
          { key: "c", label: "Currency", render: (e) => e.currency },
          { key: "f", label: "FX", render: (e) => e.fx_status === "missing" ? <Pill tone="warn">rate missing</Pill> : e.currency === e.base_currency ? "-" : `${Number(e.fx_rate)}` },
          { key: "s", label: "Status", render: (e) => <span style={S.row}>{e.reverses_entry_id ? <Pill tone="muted">Reversal</Pill> : e.voided_by_entry_id ? <Pill tone="muted">Voided</Pill> : <Pill tone="ok">Posted</Pill>}{e.is_legacy ? <Pill tone="info">Legacy</Pill> : null}</span> },
          { key: "x", label: "", render: (e) => ["manual", "transfer", "opening"].includes(e.source_type) && !e.voided_by_entry_id && !e.reverses_entry_id ? <Btn small kind="danger" onClick={(ev) => { ev.stopPropagation(); const r = window.prompt("Reason for voiding?", "Entered in error"); if (r !== null) run(async () => { await rpc("finance_void_manual_entry", { p_entry: e.id, p_reason: r }); await ctx.reload(); }); }}>Void</Btn> : null },
        ]} />
        {open && (
          <div style={{ ...S.card, background: T.raised }}>
            <Table rowKey={(l) => l.id} rows={lines(open)} columns={[
              { key: "a", label: "Account", render: (l) => { const a = accountBy.get(l.account_id); return a ? `${a.code} ${a.name}` : "?"; } },
              { key: "p", label: "Counterparty", render: (l) => l.counterparty || "-" },
              { key: "dr", label: "Debit", num: true, render: (l) => Number(l.debit) ? <Money code={l.currency} amount={Number(l.debit)} privacy={privacy} /> : "" },
              { key: "cr", label: "Credit", num: true, render: (l) => Number(l.credit) ? <Money code={l.currency} amount={Number(l.credit)} privacy={privacy} /> : "" },
            ]} />
          </div>
        )}
      </div>
    </>
  );
}

function Ledger({ ctx }) {
  const { data, postings, privacy, base } = ctx;
  const [acct, setAcct] = useState(data.accounts[0]?.id || "");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const gl = useMemo(() => acct ? generalLedger(postings, acct, { from: from || undefined, to: to || undefined }) : null, [postings, acct, from, to]);
  return (
    <>
      <div style={S.grid(180)}>
        <Field label="Account"><select style={S.input} value={acct} onChange={(e) => setAcct(e.target.value)}>{data.accounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></Field>
        <Field label="From"><input style={S.input} type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input style={S.input} type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      {gl && (
        <div style={S.card}>
          <div style={{ ...S.row, justifyContent: "space-between", fontSize: 13.5 }}><span>Opening balance ({base})</span><strong><Money code={base} amount={gl.opening} privacy={privacy} /></strong></div>
          <Table rowKey={(r) => r.lineId} rows={gl.rows} empty="No activity in this period." columns={[
            { key: "d", label: "Date", render: (r) => r.date },
            { key: "m", label: "Description", render: (r) => r.entryMemo || r.memo },
            { key: "r", label: "Reference", render: (r) => r.reference || "-" },
            { key: "dr", label: "Debit", num: true, render: (r) => r.debit ? <Money code={r.currency} amount={r.debit} privacy={privacy} /> : "" },
            { key: "cr", label: "Credit", num: true, render: (r) => r.credit ? <Money code={r.currency} amount={r.credit} privacy={privacy} /> : "" },
            { key: "b", label: `Balance (${base})`, num: true, render: (r) => r.runningBase === null ? <Pill tone="warn">rate missing</Pill> : <Money code={base} amount={r.runningBase} privacy={privacy} /> },
          ]} />
          <div style={{ ...S.row, justifyContent: "space-between", fontSize: 13.5 }}><span>Closing balance ({base})</span><strong><Money code={base} amount={gl.closing} privacy={privacy} /></strong></div>
        </div>
      )}
    </>
  );
}

function Journal({ ctx }) {
  const { data, base } = ctx;
  const blank = () => ({ account_id: "", debit: "", credit: "" });
  const [f, setF] = useState({ date: today(), memo: "", reference: "", currency: base, rate: "" });
  const [lines, setLines] = useState([blank(), blank()]);
  const { busy, error, run } = useBusy();
  const v = validateEntry(lines.map((l) => ({ debit: num(l.debit), credit: num(l.credit), currency: f.currency })));
  const setLine = (i, k, val) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: val } : l)));
  const needsRate = f.currency !== base;
  return (
    <div style={S.card}>
      <p style={S.sub}>For adjustments the other screens can't make. Every entry must balance; posted entries can only be voided, never edited.</p>
      <div style={S.grid(160)}>
        <Field label="Date"><input style={S.input} type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Description"><input style={S.input} value={f.memo} onChange={(e) => setF({ ...f, memo: e.target.value })} /></Field>
        <Field label="Reference"><input style={S.input} value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
        <Field label="Currency"><select style={S.input} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>{FINANCE_CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</select></Field>
        {needsRate && <Field label={`Rate (${base} per 1 ${f.currency})`} hint="Leave blank to flag for later"><input style={S.input} inputMode="decimal" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} /></Field>}
      </div>
      <Table rowKey={(_, i) => i} rows={lines} columns={[
        { key: "a", label: "Account", render: (l) => { const i = lines.indexOf(l); return <select style={S.input} value={l.account_id} onChange={(e) => setLine(i, "account_id", e.target.value)}><option value="">Choose...</option>{data.accounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select>; } },
        { key: "dr", label: "Debit", render: (l) => { const i = lines.indexOf(l); return <input style={{ ...S.input, textAlign: "right" }} inputMode="decimal" value={l.debit} onChange={(e) => setLine(i, "debit", e.target.value)} />; } },
        { key: "cr", label: "Credit", render: (l) => { const i = lines.indexOf(l); return <input style={{ ...S.input, textAlign: "right" }} inputMode="decimal" value={l.credit} onChange={(e) => setLine(i, "credit", e.target.value)} />; } },
      ]} />
      <div style={{ ...S.row, justifyContent: "space-between" }}>
        <Btn small onClick={() => setLines([...lines, blank()])}>Add line</Btn>
        <span style={{ color: v.balanced ? T.ok : T.warn, fontSize: 13.5 }}>{v.balanced ? "Balanced" : `Out of balance by ${formatMoney(f.currency, Math.abs(v.nativeDiff))}`}</span>
      </div>
      {error && <Banner tone="bad">{error}</Banner>}
      <div><Btn kind="primary" disabled={busy || !v.balanced || v.lineCount < 2 || lines.some((l) => (num(l.debit) || num(l.credit)) && !l.account_id)} onClick={() => run(async () => {
        await rpc("finance_post_manual_entry", { p_date: f.date, p_memo: f.memo, p_reference: f.reference, p_currency: f.currency, p_fx_rate: needsRate && num(f.rate) > 0 ? num(f.rate) : null, p_lines: lines.filter((l) => num(l.debit) || num(l.credit)).map((l) => ({ account_id: l.account_id, debit: num(l.debit), credit: num(l.credit) })) });
        await ctx.reload(); setLines([blank(), blank()]); setF({ ...f, memo: "", reference: "" });
      })}>{busy ? "Posting..." : "Post entry"}</Btn></div>
    </div>
  );
}

function Audit({ ctx }) {
  return (
    <div style={S.card}>
      <p style={S.sub}>Append-only record of significant financial actions. Latest 200 shown.</p>
      <Table rowKey={(a) => a.id} rows={ctx.data.audit} empty="Nothing recorded yet." columns={[
        { key: "t", label: "When", render: (a) => new Date(a.at).toLocaleString() },
        { key: "a", label: "Action", render: (a) => a.action },
        { key: "o", label: "Object", render: (a) => a.object_type },
        { key: "d", label: "Detail", render: (a) => <code style={{ fontSize: 11.5, color: T.muted }}>{a.new_values ? JSON.stringify(a.new_values).slice(0, 140) : ""}</code> },
      ]} />
    </div>
  );
}

export function Accounting({ ctx }) {
  const [tab, setTab] = useState("transactions");
  return (
    <>
      <div><h2 style={S.h2}>Accounting</h2><p style={S.sub}>The books underneath everything else. You never need this to run the studio, but every number elsewhere traces back to it.</p></div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: "transactions", label: "Transactions" }, { id: "ledger", label: "General ledger" }, { id: "chart", label: "Chart of accounts" }, { id: "journal", label: "Journal entry" }, { id: "audit", label: "Audit log" }]} />
      {tab === "transactions" && <Transactions ctx={ctx} />}
      {tab === "ledger" && <Ledger ctx={ctx} />}
      {tab === "chart" && <Chart ctx={ctx} />}
      {tab === "journal" && <Journal ctx={ctx} />}
      {tab === "audit" && <Audit ctx={ctx} />}
    </>
  );
}
