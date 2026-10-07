import React, { useEffect, useMemo, useRef, useState } from "react";
import { S, T, Btn, Pill, Banner, Field, Table, Money, Totals, Tabs, useBusy } from "./ui.jsx";
import { FINANCE_CURRENCIES, formatMoney, r2, todayLocal } from "./currency.js";
import { rpc, saveManualFxRate, saveDefaultBank, saveFxSnapshot } from "./api.js";
import { useLedger } from "./useLedger.js";
import { dashboardSummary, fxIssues } from "./reports.js";
import { Sales, Expenses } from "./Sales.jsx";
import { Purchases } from "./Purchases.jsx";
import { Banking } from "./Banking.jsx";
import { Accounting } from "./Accounting.jsx";
import { ReportsView } from "./ReportsView.jsx";

const today = () => todayLocal();

export function PrivacyToggle({ privacy, onChange, compact }) {
  return (
    <button type="button" onClick={() => onChange(!privacy)} aria-pressed={privacy} title={privacy ? "Show finances" : "Hide finances"}
      style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 6, color: privacy ? T.warn : T.muted, padding: compact ? "3px 8px" : "6px 12px", cursor: "pointer", fontSize: 12.5, fontFamily: "inherit" }}>
      {privacy ? "Finances hidden \u00b7 Show" : "Hide finances"}
    </button>
  );
}

function Kpi({ label, base, mode, baseAmount, native, privacy, sub, tone, onClick }) {
  return (
    <div style={{ ...S.card, gap: 4, cursor: onClick ? "pointer" : "default" }} onClick={onClick}>
      <span style={S.label}>{label}</span>
      {mode !== "native" && <strong style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 24, color: tone === "bad" ? T.bad : T.text }}><Money code={base} amount={baseAmount} privacy={privacy} /></strong>}
      {mode !== "base" && native && <span style={{ fontSize: mode === "native" ? 18 : 12.5, color: mode === "native" ? T.text : T.muted }}><Totals totals={native} privacy={privacy} /></span>}
      {sub && <span style={{ fontSize: 12, color: T.muted }}>{sub}</span>}
    </div>
  );
}

function Overview({ ctx, go }) {
  const { privacy, base, data, invoices, projects } = ctx;
  const [mode, setMode] = useState("both");
  const projectBy = new Map(projects.map((p) => [p.id, p]));
  const docsAR = invoices.map((i) => ({ id: i.id, number: i.invoiceNumber, dueDate: i.dueDate, party: projectBy.get(i.projectId)?.client || "", projectId: i.projectId }));
  const docsAP = data.bills.map((b) => ({ id: b.id, number: b.bill_number, dueDate: b.due_date || b.issue_date, party: b.vendor_name, projectId: b.project_id }));
  const s = useMemo(() => dashboardSummary(data, { today: today(), docsAR, docsAP }), [data, invoices]);
  const maxBar = Math.max(1, ...s.series.map((m) => Math.max(m.revenue, m.expenses)));
  const attention = [];
  if (s.fxIssueCount) attention.push({ tone: "warn", text: `${s.fxIssueCount} transaction(s) need an exchange rate and are excluded from base-currency totals.`, label: "Resolve", to: "settings" });
  if (s.overdueCount) attention.push({ tone: "bad", text: `${s.overdueCount} overdue invoice(s).`, label: "View", to: "sales" });
  if (s.upcomingCount) attention.push({ tone: "warn", text: `${s.upcomingCount} freelancer/vendor bill(s) due within 14 days or overdue.`, label: "View", to: "purchases" });
  if (!data.bankAccounts.length) attention.push({ tone: "info", text: "Add your bank and cash accounts so payments can be recorded against real money.", label: "Add account", to: "banking" });
  if (s.legacyEntryCount) attention.push({ tone: "info", text: `${s.legacyEntryCount} historic transaction(s) were imported from before Finance v2 and are marked Legacy.`, label: "Review", to: "accounting" });
  return (
    <>
      <div style={{ ...S.row, justifyContent: "space-between" }}>
        <div><h2 style={S.h2}>Overview</h2><p style={S.sub}>Base currency: <strong>{base}</strong>. Amounts use the exchange rate stored with each transaction.</p></div>
        <span style={S.row}>
          <div style={{ display: "flex", border: `1px solid ${T.border}`, borderRadius: 6, overflow: "hidden" }} role="group" aria-label="Currency view">
            {[["base", "Base"], ["native", "Native"], ["both", "Both"]].map(([k, l]) => <button key={k} type="button" onClick={() => setMode(k)} aria-pressed={mode === k} style={{ background: mode === k ? "rgba(47,191,166,0.18)" : "none", color: mode === k ? T.text : T.muted, border: "none", padding: "6px 12px", cursor: "pointer", fontSize: 12.5, fontFamily: "inherit" }}>{l}</button>)}
          </div>
          <PrivacyToggle privacy={privacy} onChange={ctx.setPrivacy} />
        </span>
      </div>
      {s.fxIssueCount > 0 && <span style={{ fontSize: 12.5, color: T.warn }}>Base-currency figures exclude {s.fxIssueCount} transaction(s) still waiting for an exchange rate. Native amounts are complete.</span>}
      <div style={S.grid(210)}>
        <Kpi label="Cash & bank" base={base} mode={mode} baseAmount={s.cashBase} native={s.cashNative} privacy={privacy} onClick={() => go("banking")} />
        <Kpi label="Accounts receivable" base={base} mode={mode} baseAmount={s.receivableBase} native={s.receivableNative} privacy={privacy} sub={`${s.receivableCount} open`} onClick={() => go("sales")} />
        <Kpi label="Accounts payable" base={base} mode={mode} baseAmount={s.payableBase} native={s.payableNative} privacy={privacy} sub={`${s.payableCount} open`} onClick={() => go("purchases")} />
        <Kpi label="Net profit (year to date)" base={base} mode={mode} baseAmount={s.netProfitYtd} native={null} privacy={privacy} tone={s.netProfitYtd < 0 ? "bad" : undefined} onClick={() => go("reports")} />
      </div>
      <div style={S.grid(210)}>
        <Kpi label="Revenue (year to date)" base={base} mode={mode} baseAmount={s.revenueYtd} native={s.revenueYtdNative} privacy={privacy} />
        <Kpi label="Expenses (year to date)" base={base} mode={mode} baseAmount={s.expensesYtd} native={null} privacy={privacy} />
        <Kpi label="Revenue this month" base={base} mode={mode} baseAmount={s.revenueMonth} native={null} privacy={privacy} />
      </div>
      <div style={S.grid(320)}>
        <div style={S.card}>
          <h3 style={S.h3}>Needs attention</h3>
          {attention.length === 0 ? <span style={{ color: T.ok, fontSize: 13.5 }}>Nothing needs attention.</span> : attention.map((a, i) => (
            <div key={i} style={{ ...S.row, justifyContent: "space-between", fontSize: 13.5 }}><span><Pill tone={a.tone}>{a.tone === "bad" ? "Overdue" : a.tone === "warn" ? "Check" : "Info"}</Pill> {a.text}</span><Btn small kind="link" onClick={() => go(a.to)}>{a.label}</Btn></div>
          ))}
        </div>
        <div style={S.card}>
          <h3 style={S.h3}>Quick actions</h3>
          <div style={S.row}>
            <Btn small kind="primary" onClick={ctx.onNewInvoice}>New invoice</Btn>
            <Btn small onClick={() => go("sales")}>Record customer payment</Btn>
            <Btn small onClick={ctx.onNewExpense}>Add expense</Btn>
            <Btn small onClick={() => go("purchases")}>Freelancer bill / pay</Btn>
            <Btn small onClick={() => go("banking")}>Transfer money</Btn>
            <Btn small onClick={() => go("accounting")}>Journal entry</Btn>
          </div>
        </div>
      </div>
      <div style={S.card}>
        <h3 style={S.h3}>Last six months ({base})</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12, alignItems: "end" }}>
          {s.series.map((m) => (
            <div key={m.month} style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "stretch" }}>
              <div style={{ height: 80, display: "flex", alignItems: "flex-end", gap: 4 }} aria-hidden="true">
                <div style={{ flex: 1, height: privacy ? 4 : `${(m.revenue / maxBar) * 100}%`, minHeight: 2, background: T.accent, borderRadius: 2 }} />
                <div style={{ flex: 1, height: privacy ? 4 : `${(m.expenses / maxBar) * 100}%`, minHeight: 2, background: T.warn, borderRadius: 2 }} />
              </div>
              <span style={{ fontSize: 11.5, color: T.muted }}>{m.month}</span>
              <span style={{ fontSize: 12 }}><Money code={base} amount={m.profit} privacy={privacy} /></span>
            </div>
          ))}
        </div>
        <span style={{ fontSize: 12, color: T.muted }}>Teal: revenue {"\u00b7"} Amber: expenses {"\u00b7"} Number: net profit</span>
      </div>
    </>
  );
}

function Settings({ ctx }) {
  const { data, base, userId, liveRates } = ctx;
  const { busy, error, run } = useBusy();
  const issues = fxIssues(data);
  const locked = data.entries.some((e) => !e.is_legacy);
  const [newBase, setNewBase] = useState(base);
  const [rates, setRates] = useState({});
  const [manual, setManual] = useState({ date: today(), currency: "EUR", perUsd: "" });
  const perUsd = (code) => (code === "USD" ? 1 : liveRates?.[code]);
  const liveRateFor = (code) => (perUsd(base) && perUsd(code) ? perUsd(base) / perUsd(code) : null);
  return (
    <>
      <div><h2 style={S.h2}>Finance settings</h2></div>
      {error && <Banner tone="bad">{error}</Banner>}

      <div style={S.card}>
        <h3 style={S.h3}>Base currency</h3>
        <p style={S.sub}>All consolidated reports are shown in <strong>{base}</strong>. Each transaction keeps its own currency and the exchange rate used on its date.</p>
        {locked
          ? <p style={{ ...S.sub, color: T.warn }}>The base currency is locked because new-style transactions are already in the ledger. Changing it would silently change history.</p>
          : <div style={S.row}>
              <select style={{ ...S.input, width: 120 }} value={newBase} onChange={(e) => setNewBase(e.target.value)}>{FINANCE_CURRENCIES.map((c) => <option key={c.code}>{c.code}</option>)}</select>
              <Btn disabled={busy || newBase === base} onClick={() => { if (window.confirm(`Rebuild your imported history with ${newBase} as the base currency? This is only possible now, before any new transactions are posted.`)) run(async () => { await rpc("finance_set_base_currency", { p_new: newBase }); await ctx.reload(); }); }}>Change base currency</Btn>
              <span style={S.sub}>Only possible until your first new transaction is posted.</span>
            </div>}
      </div>

      <div style={S.card}>
        <h3 style={S.h3}>Exchange rates needed ({issues.length})</h3>
        <p style={S.sub}>These transactions were posted without a rate for their date, so they are left out of base-currency totals rather than guessed. Enter the real rate, or use today's rate as a clearly labelled estimate.</p>
        <Table rowKey={(i) => i.entryId} empty="Every transaction has an exchange rate." rows={issues} columns={[
          { key: "n", label: "#", render: (i) => i.entryNo }, { key: "d", label: "Date", render: (i) => i.date },
          { key: "m", label: "Description", render: (i) => <>{i.memo}{i.isLegacy ? <span style={{ color: T.muted }}> {"\u00b7"} legacy</span> : null}</> },
          { key: "c", label: "Currency", render: (i) => i.currency },
          { key: "r", label: `${base} per 1 unit`, render: (i) => <input style={{ ...S.input, width: 110 }} inputMode="decimal" placeholder="e.g. 1.08" value={rates[i.entryId] || ""} onChange={(e) => setRates({ ...rates, [i.entryId]: e.target.value })} /> },
          { key: "a", label: "", render: (i) => (
            <span style={S.row}>
              <Btn small kind="primary" disabled={busy || !(Number(rates[i.entryId]) > 0)} onClick={() => run(async () => { await rpc("finance_set_entry_fx", { p_entry: i.entryId, p_rate: Number(rates[i.entryId]), p_rate_date: i.date, p_source: "entered manually" }); await ctx.reload(); })}>Apply</Btn>
              {liveRateFor(i.currency) && <Btn small disabled={busy} onClick={() => run(async () => { await rpc("finance_set_entry_fx", { p_entry: i.entryId, p_rate: Number(liveRateFor(i.currency).toFixed(6)), p_rate_date: today(), p_source: `ESTIMATE: live rate on ${today()}, not the transaction-date rate` }); await ctx.reload(); })}>Use today's rate (estimate)</Btn>}
            </span>) },
        ]} />
      </div>

      <div style={S.card}>
        <h3 style={S.h3}>Stored exchange rates</h3>
        <p style={S.sub}>Daily rates are saved automatically when you open the app. New transactions are valued from these, using the rate at or just before their date. Add a historical rate if you need one.</p>
        <div style={{ ...S.row, alignItems: "flex-end" }}>
          <Field label="Date"><input style={S.input} type="date" value={manual.date} onChange={(e) => setManual({ ...manual, date: e.target.value })} /></Field>
          <Field label="Currency"><select style={S.input} value={manual.currency} onChange={(e) => setManual({ ...manual, currency: e.target.value })}>{FINANCE_CURRENCIES.filter((c) => c.code !== "USD").map((c) => <option key={c.code}>{c.code}</option>)}</select></Field>
          <Field label="Units per 1 USD"><input style={S.input} inputMode="decimal" value={manual.perUsd} onChange={(e) => setManual({ ...manual, perUsd: e.target.value })} placeholder="e.g. 0.92" /></Field>
          <Btn disabled={busy || !(Number(manual.perUsd) > 0)} onClick={() => run(async () => { await saveManualFxRate(userId, { date: manual.date, currency: manual.currency, perUsd: Number(manual.perUsd) }); await ctx.reload(); })}>Save rate</Btn>
          {liveRates && Object.keys(liveRates).length > 0 && <Btn onClick={() => run(async () => { await saveFxSnapshot(userId, liveRates, new Date()); await ctx.reload(); })}>Save today's live rates</Btn>}
        </div>
        <Table rowKey={(r) => r.id} rows={data.fxRates.slice(0, 25)} empty="No rates stored yet." columns={[{ key: "d", label: "Date", render: (r) => r.rate_date }, { key: "c", label: "Currency", render: (r) => r.currency }, { key: "p", label: "Per 1 USD", num: true, render: (r) => Number(r.per_usd) }, { key: "s", label: "Source", render: (r) => r.source }]} />
      </div>

      <div style={S.card}>
        <h3 style={S.h3}>Defaults</h3>
        <Field label="Default account for recorded payments and expenses" hint="Used when a payment is logged without choosing an account (e.g. paying a freelancer from Teams). Only applies when the currencies match.">
          <select style={{ ...S.input, maxWidth: 320 }} value={data.settings.default_bank_account_id || ""} onChange={(e) => run(async () => { await saveDefaultBank(userId, e.target.value); await ctx.reload(); })}>
            <option value="">None (use Legacy Cash)</option>{data.bankAccounts.filter((b) => !b.archived).map((b) => <option key={b.id} value={b.id}>{b.name} ({b.currency})</option>)}
          </select>
        </Field>
        <div><PrivacyToggle privacy={ctx.privacy} onChange={ctx.setPrivacy} /> <span style={S.sub}> Your choice is saved to your account.</span></div>
      </div>
    </>
  );
}

const TABS = [["overview", "Overview"], ["sales", "Sales"], ["purchases", "Purchases"], ["expenses", "Expenses"], ["banking", "Banking"], ["accounting", "Accounting"], ["reports", "Reports"], ["taxes", "Taxes"], ["settings", "Settings"]];

export default function FinanceModule({ userId, projects, invoices, expenses, cards, teamMembers, liveRates, onNewInvoice, onEditInvoice, onNewExpense, onEditExpense, refreshApp }) {
  const ledger = useLedger(userId);
  const [tab, setTab] = useState("overview");
  const first = useRef(true);
  useEffect(() => {
    // An invoice/expense was saved elsewhere in the app: pull the ledger entries it just produced.
    if (first.current) { first.current = false; return; }
    ledger.reload();
  }, [invoices, expenses]);
  if (ledger.loading) return <div style={{ ...S.page, color: T.muted }}>Loading Finance...</div>;
  if (ledger.error || !ledger.data) {
    return <div style={S.page}><Banner tone="bad" action={<Btn small onClick={ledger.reload}>Retry</Btn>}>Finance couldn't load: {ledger.error || "no data"}. If this is the first run, apply migration_finance_v2.sql in Supabase.</Banner></div>;
  }
  const ctx = {
    data: ledger.data, postings: ledger.postings, privacy: ledger.privacy, setPrivacy: ledger.setPrivacy, reload: ledger.reload,
    base: ledger.data.settings.base_currency, userId, projects, invoices, expenses, cards, teamMembers, liveRates,
    onNewInvoice, onEditInvoice, onNewExpense, onEditExpense, refreshApp: refreshApp || (async () => {}),
  };
  const issues = fxIssues(ledger.data).length;
  return (
    <div style={S.page}>
      <Tabs value={tab} onChange={setTab} tabs={TABS.map(([id, label]) => ({ id, label, badge: id === "settings" && issues ? `\u2022 ${issues}` : "" }))} />
      {tab === "overview" && <Overview ctx={ctx} go={setTab} />}
      {tab === "sales" && <Sales ctx={ctx} />}
      {tab === "purchases" && <Purchases ctx={ctx} />}
      {tab === "expenses" && <Expenses ctx={ctx} />}
      {tab === "banking" && <Banking ctx={ctx} />}
      {tab === "accounting" && <Accounting ctx={ctx} />}
      {tab === "reports" && <ReportsView ctx={ctx} />}
      {tab === "taxes" && <ReportsView ctx={ctx} initial="tax" taxOnly />}
      {tab === "settings" && <Settings ctx={ctx} />}
    </div>
  );
}
