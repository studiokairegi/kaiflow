import React, { useEffect, useMemo, useState } from "react";
import { S, T, Btn, Pill, Banner, Field, Modal, Table, Tabs, Totals, CARD_TONES, useBusy } from "../finance/ui.jsx";
import { ActivityCard } from "../DashboardKit.jsx";
import { formatMoney, formatTotalsByCurrency, symbolToCode } from "../finance/currency.js";
import { PrivacyToggle } from "../finance/PrivacyToggle.jsx";
import { usePayments } from "./usePayments.js";
import PayNowDialog from "./PayNowDialog.jsx";
import ProvidersTab from "./ProvidersTab.jsx";
import * as api from "./api.js";
import {
  PAYMENT_PERIODS, PAYOUT_STATUS, SANDBOX_NOTICE, SIMULATED_NOTICE, TX_STATUS, billAvailableForRequest, checkoutBlocker,
  freelancerObligations, needsAttention, outstandingOf, payableInvoices, reconcileTotals, recentActivity, summarizePayments,
} from "./logic.js";

const TABS = [["overview", "Overview"], ["providers", "Providers"], ["incoming", "Incoming payments"], ["outgoing", "Outgoing payments"], ["payouts", "Freelancer payouts"], ["transactions", "Transactions"], ["settlements", "Settlements"], ["reconciliation", "Reconciliation"], ["settings", "Settings"]];
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString() : "-");
const fmtDay = (iso) => (iso ? String(iso).slice(0, 10) : "-");
const money = (c, n, priv) => (priv ? "••••" : formatMoney(c, n));

function SandboxBar() {
  return <div role="note" style={{ border: `1px solid ${T.warn}66`, background: `${T.warn}14`, color: T.warn, borderRadius: 14, padding: "7px 14px", fontSize: 12.5, letterSpacing: "0.04em", fontWeight: 600 }}>{SANDBOX_NOTICE}</div>;
}
const StatusPill = ({ map, status }) => <Pill tone={map[status]?.tone || "muted"}>{map[status]?.label || status}</Pill>;

// Headline figure as a dashboard-style gradient card.
function Kpi({ label, totals, privacy, sub, tone, card = "sky", icon = "card" }) {
  const t = CARD_TONES[card] || CARD_TONES.sky;
  const value = typeof totals === "number" ? (privacy ? "\u2022\u2022\u2022" : totals) : <Totals totals={totals} privacy={privacy} />;
  return <ActivityCard gradient={t.gradient} iconColor={t.icon} icon={icon} title={label} badge={tone === "bad" ? "ACTION" : undefined} value={value} label={sub || ""} />;
}

function Overview({ ctx }) {
  const { summary: s, privacy, data, setTab } = ctx;
  const activity = recentActivity(data);
  return (
    <>
      <div style={S.grid(200)}>
        <Kpi card="mint" icon="wallet" label="Client payments received" totals={s.receivedGross} privacy={privacy} sub="Gross, verified (test data)" />
        <Kpi card="sky" icon="clock" label="Received today" totals={s.receivedToday} privacy={privacy} />
        <Kpi card="violet" icon="percent" label="Transaction fees (actual)" totals={s.fees} privacy={privacy} sub="As reported by Paystack" />
        <Kpi card="royal" icon="trend" label="Net after fees" totals={s.net} privacy={privacy} sub="Gross minus actual fees" />
        <Kpi card="violet" icon="undo" label="Refunds" totals={s.refunds} privacy={privacy} />
        <Kpi card="sky" icon="invoice" label="Outstanding client invoices" totals={s.outstandingInvoices} privacy={privacy} sub={`${s.outstandingInvoiceCount} open`} />
      </div>
      <div style={S.grid(200)}>
        <Kpi card="sky" icon="clock" label="Pending / successful" totals={`${s.counts.pending} / ${s.counts.successful}`} privacy={false} sub={`${s.counts.failed} failed or abandoned · ${s.counts.refunded} refunded`} />
        <Kpi card="violet" icon="users" label="Owed to freelancers" totals={s.freelancerOwed} privacy={privacy} sub="Outstanding bills in Finance" />
        <Kpi card="royal" icon="send" label="Approved, awaiting payment" totals={s.approvedPayoutsAwaiting} privacy={privacy} sub={`${formatTotalsByCurrency(s.pendingApprovalPayouts)} pending approval`} />
        <Kpi card="mint" icon="zap" label="Freelancer payouts simulated" totals={s.simulatedPaid} privacy={privacy} sub={SIMULATED_NOTICE} />
        <Kpi card="royal" icon="alert" label="Unreconciled" totals={s.unreconciledCount + s.unreconciledPayoutCount} privacy={false} sub="Payments + simulated payouts" tone={s.unreconciledCount ? "bad" : undefined} />
      </div>
      <div style={S.card}>
        <div style={{ ...S.row, justifyContent: "space-between" }}><h3 style={S.h3}>Recent payment activity</h3><Btn small kind="link" onClick={() => setTab("transactions")}>All transactions</Btn></div>
        <Table rowKey={(r) => r.kind + r.id} empty="No payment activity yet. Use Pay now on an invoice to run a sandbox payment." rows={activity} columns={[
          { key: "at", label: "When", render: (r) => fmtDateTime(r.at) }, { key: "kind", label: "Type", render: (r) => (r.kind === "payout" ? "Payout (simulated)" : "Client payment") },
          { key: "label", label: "Detail" }, { key: "amount", label: "Amount", num: true, render: (r) => money(r.currency, r.amount, privacy) }]} />
      </div>
      <p style={S.sub}>Totals are grouped by currency and never added across currencies. Pending payments are not counted as received, and sandbox payments are test data, not income.</p>
    </>
  );
}

function Incoming({ ctx }) {
  const { invoices, projects, privacy, data, onPay } = ctx;
  const [q, setQ] = useState("");
  const projectBy = new Map(projects.map((p) => [p.id, p]));
  const txByInvoice = new Map();
  for (const t of data.transactions) if (t.invoice_id && ["initialized", "pending"].includes(t.status)) txByInvoice.set(t.invoice_id, t);
  const rows = payableInvoices(invoices).filter((i) => i.status !== "paid").filter((i) => {
    const hay = `${i.invoiceNumber} ${projectBy.get(i.projectId)?.name || ""} ${projectBy.get(i.projectId)?.client || ""}`.toLowerCase();
    return hay.includes(q.trim().toLowerCase());
  });
  return (
    <div style={S.card}>
      <div style={{ ...S.row, justifyContent: "space-between" }}><h3 style={S.h3}>Outstanding client invoices</h3>
        <input style={{ ...S.input, maxWidth: 260 }} placeholder="Search invoice, client, project" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search invoices" /></div>
      <Table rowKey={(i) => i.id} empty="No outstanding invoices." rows={rows} columns={[
        { key: "n", label: "Invoice", render: (i) => i.invoiceNumber },
        { key: "c", label: "Client / project", render: (i) => { const p = projectBy.get(i.projectId); return p ? <Btn small kind="link" onClick={() => ctx.onOpenProject(p.id)}>{p.client || p.name}</Btn> : "-"; } },
        { key: "d", label: "Due", render: (i) => i.dueDate || "-" },
        { key: "o", label: "Outstanding", num: true, render: (i) => money(symbolToCode(i.currency), outstandingOf(i), privacy) },
        { key: "s", label: "Status", render: (i) => (txByInvoice.get(i.id) ? <Pill tone="warn">Checkout open</Pill> : <Pill tone="muted">Unpaid</Pill>) },
        { key: "a", label: "", render: (i) => { const b = checkoutBlocker(i); return <Btn small kind="primary" disabled={!!b} title={b} onClick={() => onPay(i)}>Pay now (sandbox)</Btn>; } },
      ]} />
    </div>
  );
}

function Outgoing({ ctx }) {
  const { data, privacy, teamMembers } = ctx;
  const [status, setStatus] = useState("all");
  const nameOf = (id) => teamMembers.find((m) => m.id === id)?.name || "Freelancer";
  const rows = data.payouts.filter((p) => status === "all" || p.status === status);
  const real = data.billPayments.filter((p) => p.status === "posted").slice(0, 25);
  return (
    <>
      <div style={S.card}>
        <div style={{ ...S.row, justifyContent: "space-between" }}><h3 style={S.h3}>Payout requests <Pill tone="warn">SIMULATED</Pill></h3>
          <select style={{ ...S.input, maxWidth: 220 }} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
            <option value="all">All statuses</option>{Object.entries(PAYOUT_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></div>
        <p style={S.sub}>{SIMULATED_NOTICE}. A simulated payout never posts to Finance and never reduces what you owe.</p>
        <Table rowKey={(p) => p.id} empty="No payout requests yet." rows={rows} columns={[
          { key: "r", label: "Request", render: (p) => p.request_ref }, { key: "m", label: "Freelancer", render: (p) => nameOf(p.team_member_id) },
          { key: "a", label: "Amount", num: true, render: (p) => money(p.currency, p.amount, privacy) },
          { key: "s", label: "Status", render: (p) => <StatusPill map={PAYOUT_STATUS} status={p.status} /> },
          { key: "x", label: "Reconciled", render: (p) => (p.reconciled ? "Yes" : "-") }, { key: "d", label: "Created", render: (p) => fmtDay(p.created_at) }]} />
      </div>
      <div style={S.card}>
        <div style={{ ...S.row, justifyContent: "space-between" }}><h3 style={S.h3}>Payments recorded in Finance (real bookkeeping)</h3><Btn small kind="link" onClick={ctx.onGoFinance}>Open Finance</Btn></div>
        <Table rowKey={(p) => p.id} empty="No bill payments recorded." rows={real} columns={[
          { key: "d", label: "Paid", render: (p) => p.paid_date }, { key: "v", label: "Payee", render: (p) => p.vendor_name }, { key: "b", label: "Bill", render: (p) => p.bill_number || "-" },
          { key: "a", label: "Amount", num: true, render: (p) => money(p.currency, p.amount, privacy) }]} />
      </div>
    </>
  );
}

function RequestForm({ row, ctx, onClose }) {
  const [billId, setBillId] = useState(row.bills.find((b) => b.available > 0)?.id || "");
  const bill = row.bills.find((b) => b.id === billId);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const { busy, error, run } = useBusy();
  useEffect(() => { if (bill) setAmount(String(bill.available)); }, [billId]);
  const amt = Number(amount);
  const ok = bill && amt > 0 && amt <= bill.available + 0.005;
  return (
    <Modal title={`Payment request — ${row.member.name}`} onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" disabled={busy || !ok} onClick={() => run(async () => { await api.createPayoutRequest(billId, amt, note); await ctx.reload(); onClose(); })}>Create request</Btn></>}>
      <Banner tone="warn">{SIMULATED_NOTICE}. This creates a request for approval. Nothing is paid.</Banner>
      {error && <Banner tone="bad">{error}</Banner>}
      <Field label="Payable record (approved bill)">
        <select style={S.input} value={billId} onChange={(e) => setBillId(e.target.value)}>
          <option value="">Choose a bill…</option>
          {row.bills.filter((b) => b.available > 0).map((b) => <option key={b.id} value={b.id}>{b.bill_number || b.description || b.id.slice(0, 8)} · {formatMoney(b.currency, b.available)} available</option>)}
        </select>
      </Field>
      {bill && <Field label={`Amount (${bill.currency})`} hint={`Outstanding ${formatMoney(bill.currency, bill.outstanding)}; ${formatMoney(bill.currency, bill.reserved)} already in open requests.`}><input style={S.input} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>}
      <Field label="Note"><input style={S.input} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Episode 3 background layouts" /></Field>
    </Modal>
  );
}

function Payouts({ ctx }) {
  const { data, privacy, teamMembers, cards, projects } = ctx;
  const rows = useMemo(() => freelancerObligations({ teamMembers, bills: data.bills, billPayments: data.billPayments, payouts: data.payouts, billShots: data.billShots, cards, projects }), [teamMembers, cards, projects, data]);
  const [form, setForm] = useState(null);
  const [confirm, setConfirm] = useState(null); // { kind, req }
  const [q, setQ] = useState("");
  const [pick, setPick] = useState({});
  const { busy, error, run } = useBusy();
  const projectName = (id) => projects.find((p) => p.id === id)?.name || "Project";
  const act = (fn) => run(async () => { await fn(); await ctx.reload(); setConfirm(null); });
  const shown = rows.filter((r) => r.member.name.toLowerCase().includes(q.trim().toLowerCase()));
  const T_ = (m) => formatTotalsByCurrency(m);
  return (
    <>
      <Banner tone="warn">{SIMULATED_NOTICE}. Paystack payouts are not enabled in this module: approving and "paying" a request only simulates it. The amount owed always comes from approved bills in Finance.</Banner>
      {error && <Banner tone="bad">{error}</Banner>}
      <input style={{ ...S.input, maxWidth: 280 }} placeholder="Search freelancer" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search freelancers" />
      {shown.length === 0 && <div style={S.card}><span style={S.sub}>No freelancer has bills or assigned paid work yet. Create a bill in Finance &gt; Purchases, or assign paid shots in Teams.</span></div>}
      {shown.map((r) => (
        <div key={r.member.id} style={S.card}>
          <div style={{ ...S.row, justifyContent: "space-between" }}>
            <div><h3 style={S.h3}>{r.member.name}</h3><span style={S.sub}>{r.member.role || "Team member"} · {r.projectIds.map(projectName).join(", ") || "No linked projects"}</span></div>
            <span style={S.row}><Btn small onClick={ctx.onGoTeams}>Open Teams</Btn><Btn small kind="primary" disabled={!r.bills.some((b) => b.available > 0)} onClick={() => setForm(r)}>New payment request</Btn></span>
          </div>
          <div style={S.grid(150)}>
            {[["Billed", r.billed], ["Paid (Finance)", r.paid], ["Outstanding", r.owed], ["Pending requests", r.pendingRequests], ["Approved, awaiting", r.approvedAwaiting], ["Assigned, not billed", r.unbilledWork]].map(([l, m]) => (
              <div key={l}><span style={S.label}>{l}</span><div style={{ fontSize: 14 }}>{privacy ? "••••" : T_(m)}</div></div>))}
          </div>
          {r.unbilledShotIds.length > 0 && <div style={S.row}><span style={S.sub}>{r.unbilledShotIds.length} assigned shot(s) have pay but no bill yet, so they are not counted as owed.</span>
            <Btn small disabled={busy} onClick={() => act(() => api.billPendingShots(r.unbilledShotIds).then(() => ctx.refreshApp?.()))}>Create bill from assigned shots</Btn></div>}
          <Table rowKey={(p) => p.id} empty="No payment requests for this freelancer." rows={r.payouts} columns={[
            { key: "r", label: "Request", render: (p) => <>{p.request_ref}{p.note ? <span style={{ color: T.muted }}> · {p.note}</span> : null}</> },
            { key: "a", label: "Amount", num: true, render: (p) => money(p.currency, p.amount, privacy) },
            { key: "s", label: "Status", render: (p) => <><StatusPill map={PAYOUT_STATUS} status={p.status} />{p.status === "failed" && p.failure_reason ? <span style={{ color: T.muted, fontSize: 12 }}> {p.failure_reason}</span> : null}{p.reconciled ? <> <Pill tone="ok">Reconciled</Pill></> : null}</> },
            { key: "x", label: "", render: (p) => (
              <span style={S.row}>
                {(p.status === "pending_approval" || p.status === "failed") && <Btn small kind="primary" disabled={busy} onClick={() => setConfirm({ kind: "approve", req: p })}>{p.status === "failed" ? "Re-approve" : "Approve"}</Btn>}
                {p.status === "approved" && <Btn small disabled={busy} onClick={() => setConfirm({ kind: "start", req: p })}>Start simulation</Btn>}
                {p.status === "simulated_initiated" && <><Btn small kind="primary" disabled={busy} onClick={() => act(() => api.finishSimulation(p.id, true))}>Complete (success)</Btn><Btn small kind="danger" disabled={busy} onClick={() => act(() => api.finishSimulation(p.id, false, "Simulated failure"))}>Fail</Btn></>}
                {p.status === "completed_simulated" && !p.reconciled && (() => {
                  const cands = data.billPayments.filter((b) => b.status === "posted" && b.bill_id === p.bill_id && Math.abs(b.amount - p.amount) < 0.005 && !data.payouts.some((o) => o.bill_payment_id === b.id));
                  return cands.length ? <><select style={{ ...S.input, width: 160 }} value={pick[p.id] || ""} onChange={(e) => setPick({ ...pick, [p.id]: e.target.value })} aria-label="Matching Finance payment"><option value="">Match to payment…</option>{cands.map((b) => <option key={b.id} value={b.id}>{b.paid_date} · {formatMoney(b.currency, b.amount)}</option>)}</select><Btn small disabled={busy || !pick[p.id]} onClick={() => act(() => api.reconcilePayout(p.id, pick[p.id]))}>Reconcile</Btn></>
                    : <span style={{ fontSize: 12, color: T.muted }}>Record the real payment in Finance, then reconcile</span>;
                })()}
                {["pending_approval", "approved", "failed"].includes(p.status) && <Btn small kind="link" disabled={busy} onClick={() => act(() => api.cancelPayoutRequest(p.id, "Cancelled by user"))}>Cancel</Btn>}
              </span>) }]} />
        </div>
      ))}
      {form && <RequestForm row={form} ctx={ctx} onClose={() => setForm(null)} />}
      {confirm && (
        <Modal title={confirm.kind === "approve" ? "Approve payment request" : "Start simulated payout"} onClose={() => setConfirm(null)}
          footer={<><Btn onClick={() => setConfirm(null)}>Back</Btn><Btn kind="primary" disabled={busy} onClick={() => act(() => (confirm.kind === "approve" ? api.approvePayoutRequest(confirm.req.id) : api.startSimulation(confirm.req.id)))}>{confirm.kind === "approve" ? "Approve" : "Start simulation"}</Btn></>}>
          <p style={S.sub}>{confirm.req.request_ref} · <strong>{formatMoney(confirm.req.currency, confirm.req.amount)}</strong></p>
          <Banner tone="warn">{SIMULATED_NOTICE}. {confirm.kind === "approve" ? "Approving authorises the request; it does not pay anyone." : "This creates a test record only. It posts nothing to Finance and does not reduce what you owe."}</Banner>
        </Modal>
      )}
    </>
  );
}

function Transactions({ ctx }) {
  const { data, privacy } = ctx;
  const [status, setStatus] = useState("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(null);
  const rows = data.transactions.filter((t) => (status === "all" || t.status === status)
    && `${t.reference} ${t.invoice_number} ${t.client_name}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <>
      <div style={S.card}>
        <div style={S.row}>
          <input style={{ ...S.input, maxWidth: 260 }} placeholder="Search reference, invoice, client" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search transactions" />
          <select style={{ ...S.input, maxWidth: 200 }} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status"><option value="all">All statuses</option>{Object.entries(TX_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
        </div>
        <Table rowKey={(t) => t.id} onRow={setOpen} empty="No transactions yet." rows={rows} columns={[
          { key: "d", label: "Created", render: (t) => fmtDateTime(t.created_at) }, { key: "r", label: "Reference", render: (t) => t.reference },
          { key: "i", label: "Invoice", render: (t) => t.invoice_number || "-" },
          { key: "a", label: "Gross", num: true, render: (t) => money(t.currency, t.amount, privacy) },
          { key: "f", label: "Fee", num: true, render: (t) => (t.fee_actual == null ? "-" : money(t.currency, t.fee_actual, privacy)) },
          { key: "n", label: "Net", num: true, render: (t) => (t.net_amount == null ? "-" : money(t.currency, t.net_amount, privacy)) },
          { key: "s", label: "Status", render: (t) => <StatusPill map={TX_STATUS} status={t.status} /> }]} />
      </div>
      {open && (
        <Modal title={`Transaction ${open.reference}`} onClose={() => setOpen(null)} footer={<Btn onClick={() => setOpen(null)}>Close</Btn>}>
          <Banner tone="warn">{SANDBOX_NOTICE}</Banner>
          <Table rowKey={(r) => r.k} rows={[
            ["Status", TX_STATUS[open.status]?.label || open.status], ["Gross", formatMoney(open.currency, open.amount)],
            ["Actual fee", open.fee_actual == null ? "Not reported" : formatMoney(open.currency, open.fee_actual)],
            ["Estimated fee", open.fee_estimated == null ? "None (not estimated)" : formatMoney(open.currency, open.fee_estimated)],
            ["Net", open.net_amount == null ? "-" : formatMoney(open.currency, open.net_amount)], ["Refunded", formatMoney(open.currency, open.refunded_amount)],
            ["Method", open.channel || "-"], ["Customer", open.customer_email || "-"], ["Client", open.client_name || "-"],
            ["Paystack id", open.paystack_id || "-"], ["Gateway response", open.gateway_response || "-"],
            ["Created / verified", `${fmtDateTime(open.created_at)} / ${fmtDateTime(open.verified_at)}`],
            ["Settlement", `${open.settlement_status}${open.settlement_reference ? ` (${open.settlement_reference})` : ""}`],
            ["Finance", open.invoice_payment_id ? "Posted to invoice payments" + (open.fee_expense_id ? " + fee expense" : "") : open.apply_status === "failed" ? `Not applied: ${open.apply_error}` : "Not applied"],
            ["Reconciliation", `${open.reconciliation_status}${open.reconciliation_note ? ` — ${open.reconciliation_note}` : ""}`],
          ].map(([a, b]) => ({ k: a, a, b }))} columns={[{ key: "a", label: "Field" }, { key: "b", label: "Value" }]} />
          <div style={S.row}>
            {open.invoice_id && <Btn small onClick={ctx.onGoFinance}>View in Finance</Btn>}
            {open.project_id && <Btn small onClick={() => ctx.onOpenProject(open.project_id)}>Open project</Btn>}
          </div>
        </Modal>
      )}
    </>
  );
}

function Settlements({ ctx }) {
  const [state, setState] = useState({ loading: true });
  const load = () => { setState({ loading: true }); api.getSettlements().then((r) => setState({ loading: false, ...r })).catch((e) => setState({ loading: false, error: e.message })); };
  useEffect(load, []);
  const mine = ctx.data.transactions.filter((t) => t.settlement_status !== "unknown");
  return (
    <>
      <div style={S.card}>
        <div style={{ ...S.row, justifyContent: "space-between" }}><h3 style={S.h3}>Paystack settlements (test mode)</h3><Btn small onClick={load}>Refresh</Btn></div>
        {state.loading ? <span style={S.sub}>Loading…</span> : state.error ? <Banner tone="bad" action={<Btn small onClick={load}>Retry</Btn>}>{state.error}</Banner>
          : !state.available ? <Banner tone="info">Paystack returned no settlement data: {state.reason || "none available in test mode"}. Nothing is invented here.</Banner>
          : <Table rowKey={(s) => s.id} empty="Paystack reports no settlements for this test account." rows={state.settlements} columns={[
            { key: "d", label: "Date", render: (s) => fmtDay(s.settlementDate) }, { key: "s", label: "Status", render: (s) => s.status },
            { key: "t", label: "Total", num: true, render: (s) => formatMoney(s.currency, s.totalAmount) }, { key: "f", label: "Fees", num: true, render: (s) => formatMoney(s.currency, s.totalFees) },
            { key: "p", label: "Processed", num: true, render: (s) => formatMoney(s.currency, s.totalProcessed) }]} />}
        {state.fetchedAt && <span style={S.sub}>Last refreshed {fmtDateTime(state.fetchedAt)}. Test-mode data, not real funds.</span>}
      </div>
      <div style={S.card}><h3 style={S.h3}>Settlement status on transactions</h3>
        <Table rowKey={(t) => t.id} empty="No transaction has a settlement status yet." rows={mine} columns={[{ key: "r", label: "Reference", render: (t) => t.reference }, { key: "s", label: "Settlement", render: (t) => t.settlement_status }, { key: "x", label: "Reference", render: (t) => t.settlement_reference || "-" }]} /></div>
    </>
  );
}

function Reconciliation({ ctx }) {
  const { data, privacy } = ctx;
  const attention = needsAttention(data.transactions);
  const check = reconcileTotals({ transactions: data.transactions, invoicePayments: data.invoicePayments, expenses: data.feeExpenses });
  const unrecPayouts = data.payouts.filter((p) => p.status === "completed_simulated" && !p.reconciled);
  const [notes, setNotes] = useState({});
  const { busy, error, run } = useBusy();
  const act = (fn) => run(async () => { await fn(); await ctx.reload(); await ctx.refreshApp?.(); });
  return (
    <>
      {error && <Banner tone="bad">{error}</Banner>}
      <div style={S.card}>
        <h3 style={S.h3}>Gateway vs Finance</h3>
        <Banner tone={check.ok ? "ok" : "bad"}>{check.ok ? "Paystack transactions and Finance records agree." : "Differences found. Review the rows below; nothing was changed automatically."}</Banner>
        <Table rowKey={(r) => r.currency} empty="No payments to compare yet." rows={check.rows} columns={[
          { key: "c", label: "Currency", render: (r) => r.currency }, { key: "g", label: "Gateway gross", num: true, render: (r) => money(r.currency, r.gatewayGross, privacy) },
          { key: "l", label: "Finance receipts", num: true, render: (r) => money(r.currency, r.ledgerGross, privacy) },
          { key: "f", label: "Gateway fees", num: true, render: (r) => money(r.currency, r.gatewayFees, privacy) }, { key: "e", label: "Finance fee expenses", num: true, render: (r) => money(r.currency, r.ledgerFees, privacy) },
          { key: "d", label: "Difference", num: true, render: (r) => (Math.abs(r.grossDifference) + Math.abs(r.feeDifference) < 0.005 ? <Pill tone="ok">Match</Pill> : <Pill tone="bad">{formatMoney(r.currency, r.grossDifference)} / {formatMoney(r.currency, r.feeDifference)}</Pill>) }]} />
      </div>
      <div style={S.card}>
        <h3 style={S.h3}>Payments needing attention ({attention.length})</h3>
        <Table rowKey={(t) => t.id} empty="Nothing needs attention." rows={attention} columns={[
          { key: "r", label: "Reference", render: (t) => t.reference }, { key: "a", label: "Amount", num: true, render: (t) => money(t.currency, t.amount, privacy) },
          { key: "w", label: "Why", render: (t) => t.apply_error || t.reconciliation_note || "Not reconciled" },
          { key: "x", label: "", render: (t) => (
            <span style={S.row}>
              {t.status === "success" && !t.invoice_payment_id && <Btn small disabled={busy} onClick={() => act(() => api.retryApply(t.id))}>Retry apply</Btn>}
              <input style={{ ...S.input, width: 170 }} placeholder="Resolution note" value={notes[t.id] || ""} onChange={(e) => setNotes({ ...notes, [t.id]: e.target.value })} aria-label="Resolution note" />
              <Btn small disabled={busy || !(notes[t.id] || "").trim()} onClick={() => act(() => api.resolveReview(t.id, notes[t.id]))}>Mark reviewed</Btn>
            </span>) }]} />
      </div>
      <div style={S.card}>
        <h3 style={S.h3}>Simulated payouts not yet matched to a real payment ({unrecPayouts.length})</h3>
        <Table rowKey={(p) => p.id} empty="None." rows={unrecPayouts} columns={[{ key: "r", label: "Request", render: (p) => p.request_ref }, { key: "a", label: "Amount", num: true, render: (p) => money(p.currency, p.amount, privacy) }, { key: "s", label: "Simulation", render: (p) => p.simulation_ref }]} />
        <span style={S.sub}>Match them in Freelancer payouts after recording the real payment in Finance.</span>
      </div>
      <div style={S.card}>
        <h3 style={S.h3}>Webhook events</h3>
        <Table rowKey={(e) => e.id} empty="No webhook events received. Add the webhook URL in Paystack (Settings tab)." rows={ctx.data.events} columns={[
          { key: "t", label: "Received", render: (e) => fmtDateTime(e.received_at) }, { key: "e", label: "Event", render: (e) => e.event }, { key: "r", label: "Reference", render: (e) => e.reference || "-" },
          { key: "s", label: "Status", render: (e) => <Pill tone={e.status === "processed" ? "ok" : e.status === "failed" ? "bad" : "muted"}>{e.status}</Pill> }, { key: "x", label: "Detail", render: (e) => e.error || "" }]} />
      </div>
      <div style={S.card}>
        <h3 style={S.h3}>Audit trail</h3>
        <Table rowKey={(a) => a.id} empty="No audit entries yet." rows={data.audit.slice(0, 40)} columns={[{ key: "t", label: "When", render: (a) => fmtDateTime(a.at) }, { key: "a", label: "Action", render: (a) => `${a.action} · ${a.object_type}` }, { key: "o", label: "Record", render: (a) => String(a.object_id || "").slice(0, 8) }]} />
      </div>
    </>
  );
}

function SettingsTab({ ctx }) {
  const [status, setStatus] = useState(null);
  const [bal, setBal] = useState(null);
  const { busy, error, run } = useBusy();
  const check = () => run(async () => { setStatus(await api.getSandboxStatus()); });
  useEffect(() => { check(); }, []);
  const loadBal = () => run(async () => { setBal(await api.getBalance()); });
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return (
    <>
      <div style={S.card}>
        <h3 style={S.h3}>Sandbox connection</h3>
        {error && <Banner tone="bad" action={<Btn small onClick={check}>Retry</Btn>}>{error}</Banner>}
        {status && <Banner tone={status.ok ? "ok" : "bad"}>{status.ok ? "Paystack TEST mode is configured. Live payments are not possible from this module." : status.message}</Banner>}
        {status && !status.ok && (
          <ol style={{ ...S.sub, paddingLeft: 18 }}>
            <li>In Paystack, switch the dashboard to <strong>Test mode</strong> and copy the test secret key (starts with <code>sk_test_</code>).</li>
            <li>Set Supabase function secrets: <code>PAYSTACK_SECRET_KEY</code>, <code>PAYMENTS_MODE=sandbox</code>, optionally <code>APP_URL</code>.</li>
            <li>Deploy <code>paystack-payments</code>, and <code>paystack-webhook</code> with <code>--no-verify-jwt</code>.</li>
            <li>In Paystack (Test mode) set the webhook URL to <code>{`<project-url>/functions/v1/paystack-webhook`}</code>.</li>
          </ol>)}
        <div style={S.row}><Btn small onClick={check} disabled={busy}>Re-check</Btn><span style={S.sub}>Environment: TEST. Secret keys live only in server secrets; the browser never sees them.</span></div>
      </div>
      <div style={S.card}>
        <h3 style={S.h3}>Paystack test balance</h3>
        <p style={S.sub}>Shown only if the sandbox API returns one. It is simulated and does not represent real funds, and it is separate from settled funds and outstanding invoices.</p>
        <div><Btn small onClick={loadBal} disabled={busy || !status?.ok}>Fetch balance</Btn></div>
        {bal && (bal.available ? <Table rowKey={(b) => b.currency} rows={bal.balances} columns={[{ key: "c", label: "Currency", render: (b) => b.currency }, { key: "b", label: "Test balance", num: true, render: (b) => formatMoney(b.currency, b.balance) }]} />
          : <Banner tone="info">No balance available: {bal.reason}</Banner>)}
        {bal?.fetchedAt && <span style={S.sub}>Environment: test · refreshed {fmtDateTime(bal.fetchedAt)}</span>}
      </div>
      <div style={S.card}>
        <h3 style={S.h3}>Accounting settings</h3>
        <p style={S.sub}>Verified payments post to your Finance default bank/cash account when its currency matches (otherwise Legacy Cash). Actual Paystack fees are booked once as <em>Payment processing fees</em>. Change the default account in Finance &gt; Settings.</p>
        <p style={S.sub}>Webhook URL for this project: <code>{`<your-supabase-url>/functions/v1/paystack-webhook`}</code> (app: {origin}).</p>
      </div>
    </>
  );
}

export default function PaymentsModule({ userId, projects, invoices, teamMembers, cards, defaultPeriod = "all", onOpenProject, onGoFinance, onGoTeams, refreshApp }) {
  const { loading, error, data, reload } = usePayments(userId);
  const [tab, setTab] = useState("overview");
  const [period, setPeriod] = useState(PAYMENT_PERIODS.some((p) => p.id === defaultPeriod) ? defaultPeriod : "all");
  const [privacy, setPrivacy] = useState(false);
  const [payInvoice, setPayInvoice] = useState(null);
  const [returnNote, setReturnNote] = useState("");

  // Returning from Paystack's checkout (?payments_return=1&reference=...): verify server-side, then tidy the URL.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const ref = q.get("reference") || q.get("trxref");
    if (!q.get("payments_return") || !ref) return;
    api.verifyPayment(ref)
      .then((r) => { setReturnNote(r.applied ? "Payment verified and recorded (test data)." : r.note || `Payment status: ${r.status}.`); reload(); refreshApp?.(); })
      .catch((e) => setReturnNote(`Could not verify the payment: ${e.message}`))
      .finally(() => window.history.replaceState({}, "", window.location.pathname));
  }, []);

  const summary = useMemo(() => (data ? summarizePayments({ ...data, invoices, period }) : null), [data, invoices, period]);
  if (loading) return <div style={{ ...S.page, color: T.muted }}>Loading Payments…</div>;
  if (error || !data) return <div style={S.page}><Banner tone="bad" action={<Btn small onClick={reload}>Retry</Btn>}>Payments couldn't load: {error || "no data"}. If this is the first run, apply the 20261018090000_payments_paystack_sandbox.sql migration.</Banner></div>;

  const attention = needsAttention(data.transactions).length;
  const ctx = { data, summary, privacy, invoices, projects, teamMembers, cards, reload: async () => { await reload(); }, refreshApp, onPay: setPayInvoice, onOpenProject, onGoFinance, onGoTeams, setTab };
  return (
    <div style={S.page}>
      <SandboxBar />
      <div style={{ ...S.row, justifyContent: "space-between" }}>
        <Tabs value={tab} onChange={setTab} tabs={TABS.map(([id, label]) => ({ id, label, badge: id === "reconciliation" && attention ? `• ${attention}` : "" }))} />
        <span style={S.row}>
          {["overview"].includes(tab) && <select style={{ ...S.input, width: 160 }} value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Period">{PAYMENT_PERIODS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>}
          <PrivacyToggle privacy={privacy} onChange={setPrivacy} compact />
        </span>
      </div>
      {returnNote && <Banner tone="info" action={<Btn small onClick={() => setReturnNote("")}>Dismiss</Btn>}>{returnNote}</Banner>}
      {tab === "overview" && <Overview ctx={ctx} />}
      {tab === "providers" && <ProvidersTab />}
      {tab === "incoming" && <Incoming ctx={ctx} />}
      {tab === "outgoing" && <Outgoing ctx={ctx} />}
      {tab === "payouts" && <Payouts ctx={ctx} />}
      {tab === "transactions" && <Transactions ctx={ctx} />}
      {tab === "settlements" && <Settlements ctx={ctx} />}
      {tab === "reconciliation" && <Reconciliation ctx={ctx} />}
      {tab === "settings" && <SettingsTab ctx={ctx} />}
      {payInvoice && <PayNowDialog invoice={payInvoice} onClose={() => { setPayInvoice(null); reload(); refreshApp?.(); }} onChanged={() => { reload(); }} />}
    </div>
  );
}
