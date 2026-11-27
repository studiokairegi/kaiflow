import React, { useState } from "react";
import { Async, Banner, Card, DataTable, EmptyState, useFinance, useResource } from "../shared/kit.jsx";
import { Money } from "../shared/parts.jsx";
import { label, todayISO } from "../shared/format.js";
import { RangeBar, ccyArg, useRange, validRange } from "./common.jsx";

function Section({ title = undefined, sec = undefined, c = undefined, onAccount = undefined }) {
  return (<><tr><th colSpan={3} scope="colgroup" style={{ paddingTop: 14 }}>{title}</th></tr>
    {(sec.rows || []).map((r) => <tr key={r.account_id || r.code}><td>{r.code}</td><td>{onAccount ? <button type="button" className="btn ghost small" onClick={() => onAccount(r.account_id)}>{r.name}</button> : r.name}</td><td className="num"><Money value={r.amount} currency={c} /></td></tr>)}
    <tr className="totals"><td /><td>Total {title.toLowerCase()}</td><td className="num"><Money value={sec.total} currency={c} /></td></tr></>);
}
const Basis = ({ d }) => <>{d.basis === "native" && <Banner tone="info">Shown in {d.currency} only, exactly as posted. Other currencies are not converted.</Banner>}
  {d.excluded_entries_missing_fx > 0 && <Banner tone="warning" title="Some entries are left out.">{d.excluded_entries_missing_fx} journal entr{d.excluded_entries_missing_fx === 1 ? "y has" : "ies have"} no exchange rate, so they are not in these base-currency figures. Add the rate to include them.</Banner>}</>;

export function ProfitLoss({ go = undefined }) {
  const { api, org } = useFinance(); const [r, setR] = useRange(30); const [c, setC] = useState("");
  const res = useResource(() => (validRange(r) ? api.profitLoss(org, r.from, r.to, ccyArg(c)) : Promise.resolve(null)), [api, org, r.from, r.to, c]);
  return (<div className="stack"><RangeBar range={r} onChange={setR} currency={c} onCurrency={setC} />
    {validRange(r) ? <Async res={res}>{(d) => d && (<><Basis d={d} /><div className="scroll"><table className="fv3-table"><caption className="sr">Profit and loss</caption><thead><tr><th>Code</th><th>Account</th><th className="num">Amount</th></tr></thead><tbody>
      <Section title="Revenue" sec={d.revenue} c={d.currency} onAccount={(id) => go("gl", id)} /><Section title="Cost of sales" sec={d.cost_of_sales} c={d.currency} onAccount={(id) => go("gl", id)} />
      <tr className="totals"><td /><td>Gross profit</td><td className="num"><Money value={d.gross_profit} currency={d.currency} /></td></tr>
      <Section title="Operating expenses" sec={d.operating_expenses} c={d.currency} onAccount={(id) => go("gl", id)} />
      <tr className="totals"><td /><td>Operating profit</td><td className="num"><Money value={d.operating_profit} currency={d.currency} /></td></tr>
      <Section title="Other income" sec={d.other_income} c={d.currency} /><Section title="Other expenses" sec={d.other_expenses} c={d.currency} />
      <tr className="totals"><td /><td>Net profit</td><td className="num"><Money value={d.net_profit} currency={d.currency} /></td></tr></tbody></table></div></>)}</Async> : <Banner tone="warning">Choose a start date that is not after the end date.</Banner>}</div>);
}
export function BalanceSheet({ go = undefined }) {
  const { api, org } = useFinance(); const [r, setR] = useState({ from: "", to: todayISO() }); const [c, setC] = useState("");
  const res = useResource(() => api.balanceSheet(org, r.to, ccyArg(c)), [api, org, r.to, c]);
  return (<div className="stack"><RangeBar range={r} onChange={setR} single currency={c} onCurrency={setC} />
    <Async res={res}>{(d) => (<><Basis d={d} />{d.balanced ? <Banner tone="ok">Assets equal liabilities plus equity.</Banner> : <Banner tone="critical" title="The balance sheet does not balance.">Difference {d.difference}. Please report this.</Banner>}
      <div className="scroll"><table className="fv3-table"><caption className="sr">Balance sheet</caption><thead><tr><th>Code</th><th>Account</th><th className="num">Balance</th></tr></thead><tbody>
        <Section title="Assets" sec={d.assets} c={d.currency} onAccount={(id) => go("gl", id)} /><Section title="Liabilities" sec={d.liabilities} c={d.currency} onAccount={(id) => go("gl", id)} />
        <Section title="Equity" sec={d.equity} c={d.currency} onAccount={(id) => go("gl", id)} />
        <tr><td /><td>Current period earnings</td><td className="num"><Money value={d.equity.current_earnings} currency={d.currency} /></td></tr>
        <tr className="totals"><td /><td>Total liabilities and equity</td><td className="num"><Money value={d.total_liabilities_and_equity} currency={d.currency} /></td></tr></tbody></table></div></>)}</Async></div>);
}
export function CashFlow() {
  const { api, org } = useFinance(); const [r, setR] = useRange(30); const [c, setC] = useState("");
  const res = useResource(() => (validRange(r) ? api.cashFlow(org, r.from, r.to, ccyArg(c)) : Promise.resolve(null)), [api, org, r.from, r.to, c]);
  return (<div className="stack"><RangeBar range={r} onChange={setR} currency={c} onCurrency={setC} />
    {validRange(r) ? <Async res={res}>{(d) => d && (<><Basis d={d} /><p>Opening cash <b><Money value={d.opening_cash} currency={d.currency} /></b></p>
      <DataTable caption="Cash movements" rows={d.rows} rowKey={(x) => x.kind} columns={[{ key: "kind", header: "Source", render: (x) => label({}, x.kind) }, { key: "class", header: "Type", render: (x) => label({}, x.class) },
        { key: "inflow", header: "In", num: true, render: (x) => <Money value={x.inflow} /> }, { key: "outflow", header: "Out", num: true, render: (x) => <Money value={x.outflow} /> }, { key: "net", header: "Net", num: true, render: (x) => <Money value={x.net} /> }]}
        totals={["", "Net change", "", "", <Money key="n" value={d.net_change} />]} empty={<EmptyState title="No cash moved in this period" />} />
      <p>Closing cash <b><Money value={d.closing_cash} currency={d.currency} /></b> {d.reconciles ? "· reconciles to the ledger" : "· does not reconcile"}</p><p className="sub">{d.note}</p></>)}</Async> : <Banner tone="warning">Choose a start date that is not after the end date.</Banner>}</div>);
}
export function Tax() {
  const { api, org } = useFinance(); const [r, setR] = useRange(90); const [c, setC] = useState("");
  const res = useResource(() => (validRange(r) ? api.taxSummary(org, r.from, r.to, ccyArg(c)) : Promise.resolve(null)), [api, org, r.from, r.to, c]);
  return (<div className="stack"><RangeBar range={r} onChange={setR} currency={c} onCurrency={setC} />
    {validRange(r) ? <Async res={res}>{(d) => d && (<><DataTable caption="Sales tax by rate" rows={d.sales.rows} rowKey={(x) => x.tax_rate} columns={[{ key: "tax_rate", header: "Rate %", num: true }, { key: "classification", header: "Classification", render: (x) => label({ zero_rated_or_exempt: "Zero-rated or exempt", standard: "Standard rate" }, x.classification) },
      { key: "invoices", header: "Invoices", num: true }, { key: "taxable_net", header: "Taxable amount", num: true, render: (x) => <Money value={x.taxable_net} currency={d.currency} /> }, { key: "tax", header: "Tax", num: true, render: (x) => <Money value={x.tax} currency={d.currency} /> }]}
      totals={["", "Total", "", <Money key="net" value={d.sales.taxable_net} currency={d.currency} />, <Money key="tax" value={d.sales.tax} currency={d.currency} />]} empty={<EmptyState title="No taxed sales in this period" />} />
      <Banner tone="info" title="Purchases">{d.purchases.note}</Banner><p className="sub">Basis: {d.basis}.</p></>)}</Async> : <Banner tone="warning">Choose a start date that is not after the end date.</Banner>}</div>);
}
