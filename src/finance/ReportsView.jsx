import React, { useMemo, useState } from "react";
import { S, T, Btn, Banner, Field, Table, Money, Totals } from "./ui.jsx";
import { formatMoney, formatTotalsByCurrency, todayLocal } from "./currency.js";
import { download } from "./api.js";
import * as R from "./reports.js";

const iso = (d) => d.toISOString().slice(0, 10);
const todayStr = () => todayLocal();

export function periodRange(id, custom) {
  const now = new Date();
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const eom = (yy, mm) => iso(new Date(Date.UTC(yy, mm + 1, 0)));
  switch (id) {
    case "month": return { from: iso(new Date(Date.UTC(y, m, 1))), to: eom(y, m), label: "This month" };
    case "lastmonth": return { from: iso(new Date(Date.UTC(y, m - 1, 1))), to: eom(y, m - 1), label: "Last month" };
    case "quarter": { const q = Math.floor(m / 3) * 3; return { from: iso(new Date(Date.UTC(y, q, 1))), to: eom(y, q + 2), label: "This quarter" }; }
    case "ytd": return { from: `${y}-01-01`, to: todayStr(), label: "Year to date" };
    case "lastyear": return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31`, label: "Last year" };
    case "custom": return { from: custom.from || undefined, to: custom.to || undefined, label: "Custom" };
    default: return { from: undefined, to: undefined, label: "All time" };
  }
}

const REPORTS = [
  ["pnl", "Profit & Loss"], ["bs", "Balance Sheet"], ["cf", "Cash Flow"], ["tb", "Trial Balance"],
  ["ar", "A/R Aging"], ["ap", "A/P Aging"], ["project", "Project profitability"], ["client", "Revenue by client"],
  ["category", "Expenses by category"], ["tax", "Tax summary"],
];

function Section({ title, rows, privacy, base, bold }) {
  return (
    <>
      <tr><td colSpan={2} style={{ ...S.td, ...S.label, paddingTop: 14 }}>{title}</td></tr>
      {rows.map((r) => <tr key={r.accountId || r.name}><td style={S.td}>{r.code ? `${r.code} ` : ""}{r.name}</td><td style={{ ...S.td, ...S.num }}><Money code={base} amount={r.amount} privacy={privacy} /></td></tr>)}
    </>
  );
}
const Total = ({ label, amount, base, privacy, strong }) => (
  <tr><td style={{ ...S.td, fontWeight: strong ? 700 : 600, borderTop: `1px solid ${T.border}` }}>{label}</td><td style={{ ...S.td, ...S.num, fontWeight: strong ? 700 : 600, borderTop: `1px solid ${T.border}` }}><Money code={base} amount={amount} privacy={privacy} /></td></tr>
);

export function buildReport(id, ctx, range, today) {
  const { postings, projects, invoices, data } = ctx;
  const projectBy = new Map(projects.map((p) => [p.id, p]));
  switch (id) {
    case "pnl": return { pnl: R.profitAndLoss(postings, range) };
    case "bs": return { bs: R.balanceSheet(postings, { asOf: range.to }) };
    case "cf": return { cf: R.cashFlow(postings, range) };
    case "tb": return { tb: R.trialBalance(postings, { asOf: range.to }) };
    case "ar": return { ag: R.aging(postings, "ar", invoices.map((i) => ({ id: i.id, number: i.invoiceNumber, dueDate: i.dueDate, party: projectBy.get(i.projectId)?.client || "", projectId: i.projectId })), today) };
    case "ap": return { ag: R.aging(postings, "ap", data.bills.map((b) => ({ id: b.id, number: b.bill_number, dueDate: b.due_date || b.issue_date, party: b.vendor_name, projectId: b.project_id })), today) };
    case "project": return { pp: R.projectProfitability(postings, projects, range) };
    case "client": return { rc: R.revenueByClient(postings, projects, range) };
    case "category": return { ec: R.expensesByCategory(postings, range) };
    case "tax": return { tax: R.taxSummary(postings, range) };
    default: return {};
  }
}

// One CSV per report; also used by the financial package.
export function reportCsv(id, rep, base) {
  const num = (n) => n;
  if (rep.pnl) { const p = rep.pnl; return R.toCsv([...p.revenue.map((r) => ({ section: "Revenue", account: `${r.code} ${r.name}`, [base]: r.amount })), ...p.cogs.map((r) => ({ section: "Direct costs", account: `${r.code} ${r.name}`, [base]: r.amount })), { section: "Gross profit", account: "", [base]: p.grossProfit }, ...p.opex.map((r) => ({ section: "Operating expenses", account: `${r.code} ${r.name}`, [base]: r.amount })), { section: "Net profit", account: "", [base]: p.netProfit }]); }
  if (rep.bs) { const b = rep.bs; return R.toCsv([...b.assets.map((r) => ({ section: "Assets", account: `${r.code} ${r.name}`, [base]: r.amount })), ...b.liabilities.map((r) => ({ section: "Liabilities", account: `${r.code} ${r.name}`, [base]: r.amount })), ...b.equity.map((r) => ({ section: "Equity", account: `${r.code} ${r.name}`, [base]: r.amount })), { section: "Equity", account: "Current earnings", [base]: b.currentEarnings }]); }
  if (rep.cf) { const c = rep.cf; return R.toCsv([{ line: "Opening cash", [base]: c.opening }, { line: "Operating", [base]: c.operating }, { line: "Investing", [base]: c.investing }, { line: "Financing", [base]: c.financing }, { line: "Closing cash", [base]: c.closing }]); }
  if (rep.tb) return R.toCsv(rep.tb.rows.map((r) => ({ code: r.code, account: r.name, debit: r.debit, credit: r.credit, balance: r.balance })));
  if (rep.ag) return R.toCsv(rep.ag.rows.map((r) => ({ number: r.number, party: r.party, due: r.dueDate, days_overdue: r.daysOverdue, bucket: r.bucketLabel, currency: r.currency, native_outstanding: r.native, [`${base}_value`]: r.baseMissing ? "" : r.base })));
  if (rep.pp) return R.toCsv(rep.pp.map((r) => ({ project: r.project.name, revenue: r.revenue, freelancer_costs: r.freelancerCosts, direct_costs: r.directCosts, other_costs: r.otherCosts, gross_profit: r.grossProfit, net_contribution: r.netContribution })));
  if (rep.rc) return R.toCsv(rep.rc.map((r) => ({ client: r.client, revenue: r.revenue, native: formatTotalsByCurrency(r.nativeByCurrency) })));
  if (rep.ec) return R.toCsv(rep.ec.map((r) => ({ account: `${r.code} ${r.name}`, [base]: r.amount, native: formatTotalsByCurrency(r.nativeByCurrency) })));
  if (rep.tax) return R.toCsv(Object.entries(rep.tax).map(([k, v]) => ({ item: k, value: v })));
  return "";
}

function ReportBody({ id, rep, ctx, range }) {
  const { privacy, base } = ctx;
  const m = (a) => <Money code={base} amount={a} privacy={privacy} />;
  if (rep.pnl) { const p = rep.pnl; return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}><tbody>
      <Section title="Revenue" rows={p.revenue} privacy={privacy} base={base} /><Total label="Total revenue" amount={p.totalRevenue} base={base} privacy={privacy} />
      <Section title="Direct production costs" rows={p.cogs} privacy={privacy} base={base} /><Total label="Gross profit" amount={p.grossProfit} base={base} privacy={privacy} />
      <Section title="Operating expenses" rows={p.opex} privacy={privacy} base={base} /><Total label="Net profit" amount={p.netProfit} base={base} privacy={privacy} strong />
    </tbody></table>); }
  if (rep.bs) { const b = rep.bs; return (<>
    <table style={{ width: "100%", borderCollapse: "collapse" }}><tbody>
      <Section title="Assets" rows={b.assets} privacy={privacy} base={base} /><Total label="Total assets" amount={b.totalAssets} base={base} privacy={privacy} />
      <Section title="Liabilities" rows={b.liabilities} privacy={privacy} base={base} /><Total label="Total liabilities" amount={b.totalLiabilities} base={base} privacy={privacy} />
      <Section title="Equity" rows={[...b.equity, { name: "Current earnings (unclosed profit)", amount: b.currentEarnings }]} privacy={privacy} base={base} /><Total label="Total equity" amount={b.totalEquity} base={base} privacy={privacy} />
    </tbody></table>
    <Banner tone={b.balanced ? "ok" : "bad"}>{b.balanced ? "Assets equal liabilities plus equity." : `Out of balance by ${formatMoney(base, b.difference)}. This normally means some entries have no exchange rate yet.`}</Banner></>); }
  if (rep.cf) { const c = rep.cf; const rows = [["Opening cash", c.opening], ["Operating activities", c.operating], ["Investing activities", c.investing], ["Financing activities", c.financing]]; return (<>
    <table style={{ width: "100%", borderCollapse: "collapse" }}><tbody>
      {rows.map(([l, a]) => <tr key={l}><td style={S.td}>{l}</td><td style={{ ...S.td, ...S.num }}>{m(a)}</td></tr>)}
      <Total label="Closing cash" amount={c.closing} base={base} privacy={privacy} strong />
    </tbody></table>
    {["operating", "investing", "financing"].map((k) => Object.keys(c.detail[k]).length ? <div key={k} style={{ fontSize: 12.5, color: T.muted }}>{k}: {Object.entries(c.detail[k]).map(([l, a]) => `${l} ${privacy ? "\u2022\u2022\u2022" : formatMoney(base, a)}`).join(" \u00b7 ")}</div> : null)}
    <p style={S.sub}>Direct method: built from movements on bank and cash accounts. Transfers between your own accounts are excluded.</p></>); }
  if (rep.tb) return (<>
    <Table rowKey={(r) => r.accountId} rows={rep.tb.rows} columns={[{ key: "c", label: "Code", render: (r) => r.code }, { key: "n", label: "Account", render: (r) => r.name }, { key: "d", label: `Debit (${base})`, num: true, render: (r) => m(r.debit) }, { key: "cr", label: `Credit (${base})`, num: true, render: (r) => m(r.credit) }, { key: "b", label: "Balance", num: true, render: (r) => m(r.balance) }]} />
    <Banner tone={rep.tb.balanced ? "ok" : "bad"}>{rep.tb.balanced ? "Total debits equal total credits." : "Debits and credits differ."} Totals: {m(rep.tb.totalDebit)} / {m(rep.tb.totalCredit)}</Banner></>);
  if (rep.ag) return <Table rowKey={(r) => r.sourceId} rows={rep.ag.rows} empty="Nothing outstanding." columns={[
    { key: "n", label: "Document", render: (r) => r.number || "-" }, { key: "p", label: "Party", render: (r) => r.party }, { key: "d", label: "Due", render: (r) => r.dueDate },
    { key: "o", label: "Days overdue", num: true, render: (r) => r.daysOverdue || "" }, { key: "b", label: "Bucket", render: (r) => r.bucketLabel },
    { key: "nat", label: "Outstanding", num: true, render: (r) => <Money code={r.currency} amount={r.native} privacy={privacy} /> },
    { key: "base", label: `In ${base}`, num: true, render: (r) => r.baseMissing ? "rate missing" : m(r.base) }]} />;
  if (rep.pp) return <Table rowKey={(r) => r.project.id} rows={rep.pp} empty="No project activity in this period." columns={[
    { key: "p", label: "Project", render: (r) => <>{r.project.name}<div style={{ fontSize: 12, color: T.muted }}>{r.project.client}</div></> },
    { key: "r", label: "Revenue", num: true, render: (r) => m(r.revenue) }, { key: "f", label: "Freelancers", num: true, render: (r) => m(r.freelancerCosts) },
    { key: "d", label: "Other direct", num: true, render: (r) => m(r.directCosts + r.otherCosts) }, { key: "g", label: "Gross profit", num: true, render: (r) => <strong>{m(r.grossProfit)}</strong> },
    { key: "mg", label: "Margin", num: true, render: (r) => r.margin === null ? "-" : privacy ? "\u2022\u2022\u2022" : `${Math.round(r.margin * 100)}%` },
    { key: "oc", label: "Client owes", render: (r) => <Totals totals={r.outstandingClientNative} privacy={privacy} /> }, { key: "of", label: "You owe", render: (r) => <Totals totals={r.outstandingFreelancerNative} privacy={privacy} /> }]} />;
  if (rep.rc) return <Table rowKey={(r) => r.client} rows={rep.rc} empty="No revenue in this period." columns={[{ key: "c", label: "Client", render: (r) => r.client }, { key: "n", label: "Native", render: (r) => <Totals totals={r.nativeByCurrency} privacy={privacy} /> }, { key: "r", label: `Revenue (${base})`, num: true, render: (r) => m(r.revenue) }]} />;
  if (rep.ec) return <Table rowKey={(r) => r.accountId} rows={rep.ec} empty="No expenses in this period." columns={[{ key: "a", label: "Account", render: (r) => `${r.code} ${r.name}` }, { key: "n", label: "Native", render: (r) => <Totals totals={r.nativeByCurrency} privacy={privacy} /> }, { key: "b", label: `Amount (${base})`, num: true, render: (r) => m(r.amount) }]} />;
  if (rep.tax) { const t = rep.tax; const rows = [["Revenue", t.revenue], ["Other FX gains / losses", t.otherGainsLosses], ["Deductible expenses", t.deductibleExpenses], ["Non-deductible expenses", t.nonDeductibleExpenses], ["Indicative taxable profit", t.indicativeTaxableProfit], ["Tax collected", t.taxCollected], ["Tax paid", t.taxPaid], ["Tax payable balance", t.taxPayableBalance]]; return (<>
    <table style={{ width: "100%", borderCollapse: "collapse" }}><tbody>{rows.map(([l, a]) => <tr key={l}><td style={S.td}>{l}</td><td style={{ ...S.td, ...S.num }}>{m(a)}</td></tr>)}</tbody></table>
    <p style={S.sub}>This is organised data for you and your accountant, not tax advice. The software does not decide legal tax treatment. Deductibility follows the flag on each account (Accounting &gt; Chart of accounts). Every figure traces to journal entries: export the transactions below.</p></>); }
  return null;
}

// Self-contained HTML (opens/prints anywhere) for lenders and accountants.
export function buildPackageHtml(ctx, range, today) {
  const base = ctx.base;
  const f = (a) => formatMoney(base, a);
  const pl = R.profitAndLoss(ctx.postings, range), bs = R.balanceSheet(ctx.postings, { asOf: range.to || today }), cf = R.cashFlow(ctx.postings, range);
  const arRep = buildReport("ar", ctx, range, today).ag, apRep = buildReport("ap", ctx, range, today).ag;
  const tr = (l, a, b) => `<tr${b ? ' class="t"' : ""}><td>${l}</td><td class="n">${f(a)}</td></tr>`;
  const rows = (rs) => rs.map((r) => tr(`${r.code ? r.code + " " : ""}${r.name}`, r.amount)).join("");
  const agRows = (ag) => ag.buckets.map((b) => tr(`${b.label} (${b.count})`, b.base)).join("");
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  return `<!doctype html><html><head><meta charset="utf-8"><title>Financial package</title><style>body{font:14px/1.5 system-ui,sans-serif;max-width:760px;margin:32px auto;color:#111}h1{font-size:22px}h2{font-size:16px;margin:28px 0 6px;border-bottom:1px solid #999}table{width:100%;border-collapse:collapse}td{padding:4px 6px}td.n{text-align:right;font-variant-numeric:tabular-nums}tr.t td{font-weight:700;border-top:1px solid #999}small{color:#555}</style></head><body>
<h1>Financial package</h1><small>Period: ${esc(range.label)} ${range.from || ""} ${range.to ? "to " + range.to : ""} &middot; Reported in ${base} &middot; Generated ${today}. Amounts are converted using the exchange rate stored with each transaction. Transactions without a rate are excluded and listed in the transaction export.</small>
<h2>Profit &amp; Loss</h2><table>${rows(pl.revenue)}${tr("Total revenue", pl.totalRevenue, 1)}${rows(pl.cogs)}${tr("Gross profit", pl.grossProfit, 1)}${rows(pl.opex)}${tr("Net profit", pl.netProfit, 1)}</table>
<h2>Balance sheet (as of ${range.to || today})</h2><table>${rows(bs.assets)}${tr("Total assets", bs.totalAssets, 1)}${rows(bs.liabilities)}${tr("Total liabilities", bs.totalLiabilities, 1)}${rows(bs.equity)}${tr("Current earnings", bs.currentEarnings)}${tr("Total equity", bs.totalEquity, 1)}</table>
<h2>Cash flow</h2><table>${tr("Opening cash", cf.opening)}${tr("Operating", cf.operating)}${tr("Investing", cf.investing)}${tr("Financing", cf.financing)}${tr("Closing cash", cf.closing, 1)}</table>
<h2>Accounts receivable aging</h2><table>${agRows(arRep)}${tr("Total", arRep.totalBase, 1)}</table>
<h2>Accounts payable aging</h2><table>${agRows(apRep)}${tr("Total", apRep.totalBase, 1)}</table>
<p><small>${bs.balanced ? "Balance sheet is in balance." : "Balance sheet is NOT in balance: unresolved exchange rates exist."}</small></p></body></html>`;
}

export function ReportsView({ ctx, initial = "pnl", taxOnly = false }) {
  const { privacy, base, postings } = ctx;
  const [id, setId] = useState(initial);
  const [period, setPeriod] = useState("ytd");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const range = periodRange(period, custom);
  const today = todayStr();
  const rep = useMemo(() => buildReport(id, ctx, range, today), [id, period, custom, postings, ctx.invoices, ctx.data.bills, ctx.projects]);
  const missing = R.fxIssues(ctx.data).length;
  const list = taxOnly ? REPORTS.filter(([k]) => k === "tax") : REPORTS;
  return (
    <>
      <div><h2 style={S.h2}>{taxOnly ? "Taxes" : "Reports"}</h2><p style={S.sub}>{taxOnly ? "Organised, traceable data for tax preparation." : "Every report is computed from the ledger. Amounts are in your base currency, using the rate stored with each transaction."}</p></div>
      {missing > 0 && <Banner tone="warn">{missing} transaction(s) have no exchange rate and are excluded from base-currency totals. Resolve them under Settings &gt; FX.</Banner>}
      <div style={{ ...S.row, alignItems: "flex-end" }}>
        {!taxOnly && <Field label="Report"><select style={S.input} value={id} onChange={(e) => setId(e.target.value)}>{list.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>}
        <Field label="Period"><select style={S.input} value={period} onChange={(e) => setPeriod(e.target.value)}>{[["month", "This month"], ["lastmonth", "Last month"], ["quarter", "This quarter"], ["ytd", "Year to date"], ["lastyear", "Last year"], ["all", "All time"], ["custom", "Custom"]].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        {period === "custom" && <><Field label="From"><input style={S.input} type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} /></Field><Field label="To"><input style={S.input} type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} /></Field></>}
        <Btn onClick={() => download(`${id}-${today}.csv`, reportCsv(id, rep, base))}>Export CSV</Btn>
        <Btn onClick={() => download(`transactions-${today}.csv`, R.toCsv(R.transactionExport(postings, range)))}>Export transactions</Btn>
        {!taxOnly && <Btn kind="primary" onClick={() => download(`financial-package-${today}.html`, buildPackageHtml(ctx, range, today), "text/html;charset=utf-8")}>Financial package</Btn>}
      </div>
      <div style={S.card}><ReportBody id={id} rep={rep} ctx={ctx} range={range} /></div>
    </>
  );
}
