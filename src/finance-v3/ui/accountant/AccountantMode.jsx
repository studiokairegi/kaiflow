import React, { useState } from "react";
import { Banner, Tabs, useFinance } from "../shared/kit.jsx";
import HeaderTools from "../shared/Notifications.jsx";
import { Overview, Sales, Purchases, Expenses, Banking, Reconciliation, Settings } from "./Books.jsx";
import { ChartOfAccounts, GeneralLedger, Journal, TrialBalance } from "./Ledger.jsx";
import { ProfitLoss, BalanceSheet, CashFlow, Tax } from "./Statements.jsx";
import { Reports, Exports, Alerts } from "./Reports.jsx";
import { AuditHistory, PaymentRecords, EmailAudit } from "./Audit.jsx";

const TABS = [["overview", "Overview", Overview], ["sales", "Sales", Sales], ["purchases", "Purchases", Purchases], ["expenses", "Expenses", Expenses], ["banking", "Banking", Banking],
  ["coa", "Chart of accounts", ChartOfAccounts], ["gl", "General ledger", GeneralLedger], ["journal", "Journal entries", Journal], ["tb", "Trial balance", TrialBalance],
  ["pl", "Profit & loss", ProfitLoss], ["bs", "Balance sheet", BalanceSheet], ["cf", "Cash flow", CashFlow], ["tax", "Tax", Tax],
  ["ar", "Receivables", Sales.Aging], ["ap", "Payables", Purchases.Aging], ["recon", "Reconciliation", Reconciliation], ["audit", "Audit history", AuditHistory],
  ["reports", "More reports", Reports], ["exports", "Exports", Exports], ["alerts", "Alerts", Alerts], ["settings", "Settings", Settings], ["payments", "Payment records", PaymentRecords], ["emails", "Email delivery", EmailAudit]];
export default function AccountantMode() {
  const { can } = useFinance(); const [tab, setTab] = useState("overview"); const [jump, setJump] = useState(null);
  if (!can("finance.read")) return <Banner tone="info" title="Finance is not open to your role.">Ask a finance admin if you need access.</Banner>;
  /** @type {any} */
  const C = TABS.find((t) => t[0] === tab)[2];
  const go = (t, arg) => { setJump(arg ?? null); setTab(t); };
  return (<div className="stack">
    <div className="head"><div><h1>Finance · Accountant</h1><p className="sub">Accounts, ledger and statements. Every figure here is the one Simple view is built from.</p></div><HeaderTools /></div>
    <Tabs tabs={TABS.map(([id, label]) => ({ id, label }))} value={tab} onChange={(t) => go(t)} label="Accountant sections" />
    <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} key={tab}><C go={go} jump={jump} /></div></div>);
}
