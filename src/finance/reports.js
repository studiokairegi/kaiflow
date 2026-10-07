// Reporting layer. PURE functions over ledger data - no Supabase, no React.
//
// Every number on the Finance screens and the dashboard comes from here, and
// everything here is derived from journal lines. There is no second source of
// financial truth. Base-currency figures use ONLY the base amounts stored with
// each entry (transaction-date FX); entries whose rate is missing are excluded
// from consolidated totals and reported separately, never treated as 1:1.

import { r2 } from "./currency.js";

const DEBIT_NORMAL = new Set(["asset", "cogs", "expense"]);

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------
// data: { accounts: [{id, code, name, type, subtype, system_key, tax_deductible}],
//         entries: [{id, entry_no, entry_date, memo, reference, source_type, source_id,
//                    project_id, currency, fx_status, fx_rate, is_legacy, reverses_entry_id, voided_by_entry_id}],
//         lines:   [{id, entry_id, account_id, currency, debit, credit, base_debit, base_credit,
//                    project_id, bank_account_id, counterparty, memo, reconciled_at}] }
export function buildPostings(data) {
  const acct = new Map((data.accounts || []).map((a) => [a.id, a]));
  const entry = new Map((data.entries || []).map((e) => [e.id, e]));
  const out = [];
  for (const l of data.lines || []) {
    const e = entry.get(l.entry_id);
    const a = acct.get(l.account_id);
    if (!e || !a) continue;
    const debit = Number(l.debit) || 0;
    const credit = Number(l.credit) || 0;
    const hasBase = l.base_debit !== null && l.base_debit !== undefined && l.base_credit !== null && l.base_credit !== undefined;
    out.push({
      lineId: l.id,
      entryId: e.id,
      entryNo: e.entry_no,
      date: e.entry_date,
      memo: l.memo || e.memo || "",
      entryMemo: e.memo || "",
      reference: e.reference || "",
      sourceType: e.source_type,
      sourceId: e.source_id,
      isReversal: !!e.reverses_entry_id,
      isVoided: !!e.voided_by_entry_id,
      isLegacy: !!e.is_legacy,
      fxStatus: e.fx_status,
      accountId: a.id,
      accountCode: a.code,
      accountName: a.name,
      accountType: a.type,
      accountSubtype: a.subtype,
      systemKey: a.system_key,
      taxDeductible: a.tax_deductible !== false,
      currency: l.currency || e.currency,
      debit,
      credit,
      native: debit - credit, // signed, debit positive
      hasBase,
      baseDebit: hasBase ? Number(l.base_debit) : 0,
      baseCredit: hasBase ? Number(l.base_credit) : 0,
      base: hasBase ? Number(l.base_debit) - Number(l.base_credit) : null, // signed, debit positive
      projectId: l.project_id || e.project_id || null,
      bankAccountId: l.bank_account_id || null,
      counterparty: l.counterparty || "",
      reconciledAt: l.reconciled_at || null,
    });
  }
  return out;
}

const inRange = (p, from, to) => (!from || p.date >= from) && (!to || p.date <= to);
const upTo = (p, asOf) => !asOf || p.date <= asOf;

// Natural sign: positive = increases the account's normal balance.
const natural = (p, value) => (DEBIT_NORMAL.has(p.accountType) ? value : -value);

// Sum of base amounts for postings that have one. `missing` counts the rest.
function sumBase(postings, pick) {
  let total = 0;
  let missing = 0;
  for (const p of postings) {
    if (p.debit === 0 && p.credit === 0 && p.baseDebit === 0 && p.baseCredit === 0) continue;
    if (!p.hasBase) { missing += 1; continue; }
    total += pick(p);
  }
  return { total: r2(total), missing };
}

// Native totals grouped by currency - the honest answer when there is no consolidated valuation.
export function nativeByCurrency(postings, pick) {
  const out = {};
  for (const p of postings) {
    out[p.currency] = (out[p.currency] || 0) + pick(p);
  }
  for (const k of Object.keys(out)) out[k] = r2(out[k]);
  return out;
}

// Entries posted without a transaction-date rate. These are excluded from
// base-currency totals until the user supplies a rate.
export function fxIssues(data) {
  return (data.entries || [])
    .filter((e) => e.fx_status === "missing")
    .map((e) => ({ entryId: e.id, entryNo: e.entry_no, date: e.entry_date, currency: e.currency, memo: e.memo, sourceType: e.source_type, isLegacy: !!e.is_legacy }));
}

// ---------------------------------------------------------------------------
// Trial balance / general ledger
// ---------------------------------------------------------------------------
export function trialBalance(postings, { asOf } = {}) {
  const rows = new Map();
  let missing = 0;
  for (const p of postings.filter((x) => upTo(x, asOf))) {
    if (!rows.has(p.accountId)) {
      rows.set(p.accountId, { accountId: p.accountId, code: p.accountCode, name: p.accountName, type: p.accountType, debit: 0, credit: 0, nativeByCurrency: {} });
    }
    const r = rows.get(p.accountId);
    r.nativeByCurrency[p.currency] = r2((r.nativeByCurrency[p.currency] || 0) + p.native);
    if (!p.hasBase) { if (p.debit || p.credit) missing += 1; continue; }
    r.debit += p.baseDebit;
    r.credit += p.baseCredit;
  }
  const list = [...rows.values()]
    .map((r) => ({ ...r, debit: r2(r.debit), credit: r2(r.credit), balance: r2(r.debit - r.credit) }))
    .sort((a, b) => a.code.localeCompare(b.code));
  const totalDebit = r2(list.reduce((s, r) => s + r.debit, 0));
  const totalCredit = r2(list.reduce((s, r) => s + r.credit, 0));
  return { rows: list, totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.005, missing };
}

export function generalLedger(postings, accountId, { from, to } = {}) {
  const all = postings.filter((p) => p.accountId === accountId).sort((a, b) => a.date.localeCompare(b.date) || a.entryNo - b.entryNo);
  let opening = 0;
  let openingMissing = 0;
  for (const p of all) if (from && p.date < from) { if (p.hasBase) opening += p.base; else if (p.debit || p.credit) openingMissing += 1; }
  let running = r2(opening);
  const rows = [];
  for (const p of all.filter((x) => inRange(x, from, to))) {
    if (p.hasBase) running = r2(running + p.base);
    rows.push({ ...p, runningBase: p.hasBase ? running : null });
  }
  return { opening: r2(opening), openingMissing, rows, closing: running };
}

// ---------------------------------------------------------------------------
// Profit & Loss
// ---------------------------------------------------------------------------
function groupByAccount(postings, types) {
  const m = new Map();
  for (const p of postings.filter((x) => types.includes(x.accountType))) {
    if (!m.has(p.accountId)) m.set(p.accountId, { accountId: p.accountId, code: p.accountCode, name: p.accountName, subtype: p.accountSubtype, systemKey: p.systemKey, ps: [] });
    m.get(p.accountId).ps.push(p);
  }
  return [...m.values()]
    .map((g) => {
      const { total, missing } = sumBase(g.ps, (p) => natural(p, p.base));
      return { accountId: g.accountId, code: g.code, name: g.name, subtype: g.subtype, systemKey: g.systemKey, amount: total, missing, nativeByCurrency: nativeByCurrency(g.ps, (p) => natural(p, p.native)) };
    })
    .sort((a, b) => a.code.localeCompare(b.code));
}

export function profitAndLoss(postings, { from, to } = {}) {
  const ps = postings.filter((p) => inRange(p, from, to));
  const revenue = groupByAccount(ps, ["revenue"]);
  const cogs = groupByAccount(ps, ["cogs"]);
  const opex = groupByAccount(ps, ["expense"]);
  const sum = (rows) => r2(rows.reduce((s, r) => s + r.amount, 0));
  const totalRevenue = sum(revenue);
  const totalCogs = sum(cogs);
  const grossProfit = r2(totalRevenue - totalCogs);
  const totalOpex = sum(opex);
  const missing = [...revenue, ...cogs, ...opex].reduce((s, r) => s + r.missing, 0);
  return {
    revenue, cogs, opex, totalRevenue, totalCogs, grossProfit, totalOpex,
    netProfit: r2(grossProfit - totalOpex),
    margin: totalRevenue > 0 ? (grossProfit - totalOpex) / totalRevenue : null,
    missing,
  };
}

// ---------------------------------------------------------------------------
// Balance sheet - enforces Assets = Liabilities + Equity (+ current earnings)
// ---------------------------------------------------------------------------
export function balanceSheet(postings, { asOf } = {}) {
  const ps = postings.filter((p) => upTo(p, asOf));
  const assets = groupByAccount(ps, ["asset"]);
  const liabilities = groupByAccount(ps, ["liability"]);
  const equity = groupByAccount(ps, ["equity"]);
  const earnings = profitAndLoss(ps, {}).netProfit; // all P&L to date, not yet closed to retained earnings
  const sum = (rows) => r2(rows.reduce((s, r) => s + r.amount, 0));
  const totalAssets = sum(assets);
  const totalLiabilities = sum(liabilities);
  const totalEquity = r2(sum(equity) + earnings);
  const diff = r2(totalAssets - (totalLiabilities + totalEquity));
  const missing = [...assets, ...liabilities, ...equity].reduce((s, r) => s + r.missing, 0);
  return { assets, liabilities, equity, currentEarnings: earnings, totalAssets, totalLiabilities, totalEquity, difference: diff, balanced: Math.abs(diff) < 0.01, missing };
}

// ---------------------------------------------------------------------------
// Cash flow (direct method) from movements on cash/bank accounts
// ---------------------------------------------------------------------------
export function cashFlow(postings, { from, to } = {}) {
  const isCash = (p) => p.accountType === "asset" && (p.accountSubtype === "cash" || p.accountSubtype === "bank");
  const byEntry = new Map();
  for (const p of postings) {
    if (!byEntry.has(p.entryId)) byEntry.set(p.entryId, []);
    byEntry.get(p.entryId).push(p);
  }
  let opening = 0;
  const buckets = { operating: 0, investing: 0, financing: 0 };
  const detail = { operating: {}, investing: {}, financing: {} };
  let missing = 0;
  for (const ps of byEntry.values()) {
    const cash = ps.filter(isCash);
    if (!cash.length) continue;
    const date = ps[0].date;
    const cashBase = cash.reduce((s, p) => s + (p.hasBase ? p.base : 0), 0);
    if (cash.some((p) => !p.hasBase && (p.debit || p.credit))) { if (inRange({ date }, from, to)) missing += 1; continue; }
    if (from && date < from) { opening += cashBase; continue; }
    if (to && date > to) continue;
    const others = ps.filter((p) => !isCash(p) && (p.debit || p.credit || p.baseDebit || p.baseCredit));
    const nonFx = others.filter((p) => p.systemKey !== "fx_gain_loss");
    let kind = "operating";
    let label = ps[0].sourceType;
    if (!others.length) continue; // pure transfer between cash accounts: no cash-flow effect
    const lead = nonFx[0] || others[0];
    if (lead.accountSubtype === "fixed_asset") { kind = "investing"; label = "Equipment & fixed assets"; }
    else if (lead.accountType === "equity" || lead.accountSubtype === "loan") { kind = "financing"; label = lead.accountType === "equity" ? "Owner capital / drawings" : "Loans"; }
    else if (ps[0].sourceType === "invoice_payment") label = "Customer receipts";
    else if (ps[0].sourceType === "bill_payment") label = "Supplier & freelancer payments";
    else if (ps[0].sourceType === "expense") label = "Expenses paid";
    detail[kind][label] = r2((detail[kind][label] || 0) + cashBase);
    buckets[kind] += cashBase;
  }
  const net = r2(buckets.operating + buckets.investing + buckets.financing);
  return {
    opening: r2(opening),
    operating: r2(buckets.operating), investing: r2(buckets.investing), financing: r2(buckets.financing),
    net, closing: r2(opening + net), detail, missing,
  };
}

// ---------------------------------------------------------------------------
// Receivables / payables
// ---------------------------------------------------------------------------
// Open position per document, taken from the control account (AR or AP) in the ledger.
export function documentPositions(postings, controlKey) {
  const m = new Map();
  for (const p of postings.filter((x) => x.systemKey === controlKey && x.sourceId)) {
    if (!m.has(p.sourceId)) m.set(p.sourceId, { sourceId: p.sourceId, currency: p.currency, native: 0, base: 0, baseMissing: false, projectId: p.projectId, counterparty: p.counterparty, reference: p.reference, firstDate: p.date });
    const d = m.get(p.sourceId);
    const sign = controlKey === "ar" ? 1 : -1;
    d.native += sign * p.native;
    if (p.hasBase) d.base += sign * p.base; else if (p.debit || p.credit) d.baseMissing = true;
    if (p.date < d.firstDate) d.firstDate = p.date;
    if (!d.counterparty && p.counterparty) d.counterparty = p.counterparty;
  }
  return [...m.values()].map((d) => ({ ...d, native: r2(d.native), base: r2(d.base) })).filter((d) => Math.abs(d.native) > 0.004);
}

const BUCKETS = [
  { id: "current", label: "Current", test: (days) => days <= 0 },
  { id: "d1_30", label: "1-30 days", test: (days) => days >= 1 && days <= 30 },
  { id: "d31_60", label: "31-60 days", test: (days) => days >= 31 && days <= 60 },
  { id: "d61_90", label: "61-90 days", test: (days) => days >= 61 && days <= 90 },
  { id: "d90p", label: "90+ days", test: (days) => days > 90 },
];

const daysBetween = (a, b) => Math.floor((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86400000);

// docs: [{id, number, dueDate, party, projectId}] describes invoices (kind 'ar') or bills (kind 'ap')
export function aging(postings, kind, docs, today) {
  const control = kind === "ar" ? "ar" : "ap";
  const meta = new Map(docs.map((d) => [d.id, d]));
  const rows = documentPositions(postings, control)
    .filter((d) => d.native > 0.004)
    .map((d) => {
      const m = meta.get(d.sourceId) || {};
      const due = m.dueDate || d.firstDate;
      const days = daysBetween(today, due);
      const bucket = BUCKETS.find((b) => b.test(days)) || BUCKETS[0];
      return { ...d, number: m.number || d.reference, party: m.party || d.counterparty || "-", dueDate: due, daysOverdue: Math.max(days, 0), bucket: bucket.id, bucketLabel: bucket.label, projectId: m.projectId || d.projectId };
    })
    .sort((a, b) => b.daysOverdue - a.daysOverdue);
  const buckets = BUCKETS.map((b) => {
    const rs = rows.filter((r) => r.bucket === b.id);
    return {
      id: b.id, label: b.label, count: rs.length,
      base: r2(rs.reduce((s, r) => s + (r.baseMissing ? 0 : r.base), 0)),
      nativeByCurrency: nativeByCurrency(rs.map((r) => ({ currency: r.currency, v: r.native })), (x) => x.v),
    };
  });
  return {
    rows, buckets,
    totalBase: r2(rows.reduce((s, r) => s + (r.baseMissing ? 0 : r.base), 0)),
    totalNativeByCurrency: nativeByCurrency(rows.map((r) => ({ currency: r.currency, v: r.native })), (x) => x.v),
    unresolved: rows.filter((r) => r.baseMissing).length,
  };
}

// ---------------------------------------------------------------------------
// Project / client / category reports
// ---------------------------------------------------------------------------
export function projectProfitability(postings, projects, { from, to } = {}) {
  const ps = postings.filter((p) => inRange(p, from, to));
  const arPos = documentPositions(postings, "ar");
  const apPos = documentPositions(postings, "ap");
  return projects.map((proj) => {
    const mine = ps.filter((p) => p.projectId === proj.id);
    const rev = sumBase(mine.filter((p) => p.accountType === "revenue" && p.systemKey !== "fx_gain_loss"), (p) => natural(p, p.base));
    const freelancer = sumBase(mine.filter((p) => p.systemKey === "freelancer_costs"), (p) => natural(p, p.base));
    const direct = sumBase(mine.filter((p) => p.accountType === "cogs" && p.systemKey !== "freelancer_costs"), (p) => natural(p, p.base));
    const other = sumBase(mine.filter((p) => p.accountType === "expense"), (p) => natural(p, p.base));
    const grossProfit = r2(rev.total - freelancer.total - direct.total);
    const net = r2(grossProfit - other.total);
    const sel = (pos) => pos.filter((d) => d.projectId === proj.id && d.native > 0.004);
    return {
      project: proj,
      revenue: rev.total, freelancerCosts: freelancer.total, directCosts: direct.total, otherCosts: other.total,
      grossProfit, netContribution: net,
      margin: rev.total > 0 ? grossProfit / rev.total : null,
      outstandingClientNative: nativeByCurrency(sel(arPos), (d) => d.native),
      outstandingFreelancerNative: nativeByCurrency(sel(apPos), (d) => d.native),
      revenueNative: nativeByCurrency(mine.filter((p) => p.accountType === "revenue" && p.systemKey !== "fx_gain_loss"), (p) => natural(p, p.native)),
      missing: rev.missing + freelancer.missing + direct.missing + other.missing,
    };
  }).filter((r) => r.revenue || r.freelancerCosts || r.directCosts || r.otherCosts || Object.keys(r.outstandingClientNative).length || Object.keys(r.outstandingFreelancerNative).length);
}

export function revenueByClient(postings, projects, { from, to } = {}) {
  const clientOf = new Map(projects.map((p) => [p.id, (p.client || "").trim() || "Unknown"]));
  const m = new Map();
  for (const p of postings.filter((x) => x.accountType === "revenue" && x.systemKey === "sales" && inRange(x, from, to))) {
    const client = clientOf.get(p.projectId) || p.counterparty || "Unknown";
    if (!m.has(client)) m.set(client, []);
    m.get(client).push(p);
  }
  return [...m.entries()].map(([client, ps]) => {
    const { total, missing } = sumBase(ps, (p) => natural(p, p.base));
    return { client, revenue: total, missing, nativeByCurrency: nativeByCurrency(ps, (p) => natural(p, p.native)) };
  }).sort((a, b) => b.revenue - a.revenue);
}

export function expensesByCategory(postings, { from, to } = {}) {
  const ps = postings.filter((p) => inRange(p, from, to));
  return groupByAccount(ps, ["cogs", "expense"]).filter((r) => r.amount || Object.keys(r.nativeByCurrency).length);
}

// ---------------------------------------------------------------------------
// Tax readiness (data for an accountant - not a legal determination)
// ---------------------------------------------------------------------------
export function taxSummary(postings, { from, to } = {}) {
  const ps = postings.filter((p) => inRange(p, from, to));
  const pl = profitAndLoss(postings, { from, to });
  const costRows = [...pl.cogs, ...pl.opex];
  const deductibleIds = new Set(postings.filter((p) => p.taxDeductible && (p.accountType === "cogs" || p.accountType === "expense")).map((p) => p.accountId));
  const deductible = r2(costRows.filter((r) => deductibleIds.has(r.accountId)).reduce((s, r) => s + r.amount, 0));
  const nonDeductible = r2(costRows.filter((r) => !deductibleIds.has(r.accountId)).reduce((s, r) => s + r.amount, 0));
  const taxPayable = ps.filter((p) => p.accountSubtype === "tax_payable");
  const collected = r2(taxPayable.reduce((s, p) => s + (p.hasBase ? p.baseCredit : 0), 0));
  const paid = r2(taxPayable.reduce((s, p) => s + (p.hasBase ? p.baseDebit : 0), 0));
  const operatingRevenue = r2(pl.revenue.filter((r) => r.systemKey !== "fx_gain_loss").reduce((s, r) => s + r.amount, 0));
  return {
    revenue: operatingRevenue,
    otherGainsLosses: r2(pl.totalRevenue - operatingRevenue),
    deductibleExpenses: deductible,
    nonDeductibleExpenses: nonDeductible,
    indicativeTaxableProfit: r2(pl.totalRevenue - deductible),
    taxCollected: collected, taxPaid: paid, taxPayableBalance: r2(collected - paid),
    missing: pl.missing,
  };
}

// Flat transaction export (one row per journal line) - traceable to its source.
export function transactionExport(postings, { from, to } = {}) {
  return postings
    .filter((p) => inRange(p, from, to))
    .sort((a, b) => a.date.localeCompare(b.date) || a.entryNo - b.entryNo)
    .map((p) => ({
      entry_no: p.entryNo, date: p.date, account_code: p.accountCode, account: p.accountName, memo: p.memo, reference: p.reference,
      source_type: p.sourceType, source_id: p.sourceId || "", counterparty: p.counterparty, currency: p.currency,
      debit: p.debit, credit: p.credit, base_debit: p.hasBase ? p.baseDebit : "", base_credit: p.hasBase ? p.baseCredit : "",
      fx_status: p.fxStatus, legacy: p.isLegacy ? "yes" : "", reversal: p.isReversal ? "yes" : "", reconciled: p.reconciledAt ? "yes" : "",
    }));
}

export function toCsv(rows) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}

// ---------------------------------------------------------------------------
// Bank & cash
// ---------------------------------------------------------------------------
export function bankBalances(postings, bankAccounts) {
  return bankAccounts.map((b) => {
    const ps = postings.filter((p) => p.accountId === b.account_id);
    const native = r2(ps.reduce((s, p) => s + p.native, 0));
    const cleared = r2(ps.filter((p) => p.reconciledAt).reduce((s, p) => s + p.native, 0));
    const base = sumBase(ps, (p) => p.base);
    return { bank: b, native, cleared, unreconciledCount: ps.filter((p) => !p.reconciledAt && (p.debit || p.credit)).length, base: base.total, baseMissing: base.missing };
  });
}

export function legacyCash(postings) {
  const ps = postings.filter((p) => p.systemKey === "legacy_cash");
  const base = sumBase(ps, (p) => p.base);
  return { nativeByCurrency: nativeByCurrency(ps, (p) => p.native), base: base.total, missing: base.missing, hasActivity: ps.length > 0 };
}

// ---------------------------------------------------------------------------
// Dashboard summary (the dashboard reads THIS, nothing else)
// ---------------------------------------------------------------------------
const monthKey = (d) => d.slice(0, 7);

export function dashboardSummary(data, { today, docsAR = [], docsAP = [] }) {
  const postings = buildPostings(data);
  const year = today.slice(0, 4);
  const month = monthKey(today);
  const ytd = profitAndLoss(postings, { from: `${year}-01-01`, to: today });
  const thisMonth = profitAndLoss(postings, { from: `${month}-01`, to: today });
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 - i, 1));
    months.push(d.toISOString().slice(0, 7));
  }
  const series = months.map((m) => {
    const last = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
    const pl = profitAndLoss(postings, { from: `${m}-01`, to: `${m}-${String(last).padStart(2, "0")}` });
    return { month: m, revenue: pl.totalRevenue, expenses: r2(pl.totalCogs + pl.totalOpex), profit: pl.netProfit };
  });
  const banks = bankBalances(postings, data.bankAccounts || []);
  const legacy = legacyCash(postings);
  const ar = aging(postings, "ar", docsAR, today);
  const ap = aging(postings, "ap", docsAP, today);
  const nativeRevenue = nativeByCurrency(postings.filter((p) => p.accountType === "revenue" && p.systemKey === "sales" && p.date >= `${year}-01-01` && p.date <= today), (p) => natural(p, p.native));
  const cashBase = r2(banks.reduce((s, b) => s + b.base, 0) + legacy.base);
  const cashNative = {};
  for (const b of banks) cashNative[b.bank.currency] = r2((cashNative[b.bank.currency] || 0) + b.native);
  for (const [c, v] of Object.entries(legacy.nativeByCurrency)) cashNative[c] = r2((cashNative[c] || 0) + v);
  const issues = fxIssues(data);
  const overdue = ar.rows.filter((r) => r.daysOverdue > 0);
  const soon = ap.rows.filter((r) => daysBetween(r.dueDate, today) <= 14);
  return {
    baseCurrency: data.settings?.base_currency || "USD",
    revenueYtd: ytd.totalRevenue, expensesYtd: r2(ytd.totalCogs + ytd.totalOpex), netProfitYtd: ytd.netProfit,
    revenueMonth: thisMonth.totalRevenue, expensesMonth: r2(thisMonth.totalCogs + thisMonth.totalOpex), netProfitMonth: thisMonth.netProfit,
    revenueYtdNative: nativeRevenue,
    cashBase, cashNative, banks, legacyCash: legacy,
    receivableBase: ar.totalBase, receivableNative: ar.totalNativeByCurrency, receivableCount: ar.rows.length,
    payableBase: ap.totalBase, payableNative: ap.totalNativeByCurrency, payableCount: ap.rows.length,
    overdueInvoices: overdue, overdueCount: overdue.length,
    upcomingBills: soon, upcomingCount: soon.length,
    series, fxIssues: issues, fxIssueCount: issues.length,
    legacyEntryCount: (data.entries || []).filter((e) => e.is_legacy && !e.reverses_entry_id).length,
    hasLedger: (data.entries || []).length > 0,
    missingBase: ytd.missing,
  };
}
