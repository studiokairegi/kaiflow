// Reference implementation of the double-entry posting rules.
//
// The database (migration_finance_v2.sql) is the system of record: its SECURITY
// DEFINER functions post the real entries. This module mirrors those rules in
// plain JS for two purposes only:
//   1. validateEntry(): live "is it balanced?" feedback in the manual journal form
//   2. makeLedger(): an in-memory ledger the test suite uses to prove the rules
//      (FX carry, realized gain/loss, void-by-reversal, transfers, payables)
//      produce correct reports, with no database needed.
// If you change a posting rule, change it in BOTH places.

import { r2 } from "./currency.js";

// Checks debits = credits natively (single currency) and in base when base amounts exist.
export function validateEntry(lines) {
  const live = lines.filter((l) => (Number(l.debit) || 0) !== 0 || (Number(l.credit) || 0) !== 0);
  const currencies = new Set(live.map((l) => l.currency));
  const nativeDiff = r2(live.reduce((s, l) => s + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0));
  const withBase = lines.filter((l) => l.baseDebit !== undefined && l.baseDebit !== null);
  const baseDiff = withBase.length === lines.length ? r2(lines.reduce((s, l) => s + (l.baseDebit || 0) - (l.baseCredit || 0), 0)) : 0;
  const nativeOk = currencies.size > 1 || Math.abs(nativeDiff) < 0.005;
  return { balanced: nativeOk && Math.abs(baseDiff) < 0.005, nativeDiff, baseDiff, lineCount: live.length };
}

const COA = [
  ["1090", "Legacy Cash (unallocated)", "asset", "cash", "legacy_cash", false],
  ["1100", "Accounts Receivable", "asset", "receivable", "ar", false],
  ["2100", "Accounts Payable", "liability", "payable", "ap", false],
  ["2200", "Taxes Payable", "liability", "tax_payable", "tax_payable", false],
  ["3050", "Opening Balance Equity", "equity", "equity", "opening_equity", false],
  ["3900", "Retained Earnings", "equity", "retained", "retained_earnings", false],
  ["4100", "Animation Services", "revenue", "sales", "sales", false],
  ["4950", "Realized FX Gain / Loss", "revenue", "fx", "fx_gain_loss", false],
  ["5100", "Freelancer / Contractor Costs", "cogs", "direct", "freelancer_costs", true],
  ["6100", "Software", "expense", "operating", "software", true],
  ["6900", "Other Operating Expenses", "expense", "operating", "misc_expense", true],
];

export function makeLedger(baseCurrency = "USD") {
  const L = {
    base: baseCurrency, accounts: [], entries: [], lines: [], banks: [], seq: 0, ids: 0,
    data() { return { accounts: this.accounts, entries: this.entries, lines: this.lines, bankAccounts: this.banks, settings: { base_currency: this.base } }; },
  };
  const id = (p) => `${p}${++L.ids}`;
  for (const [code, name, type, subtype, key, ded] of COA) L.accounts.push({ id: `acct_${key}`, code, name, type, subtype, system_key: key, tax_deductible: ded });
  const acct = (k) => L.accounts.find((a) => a.system_key === k || a.id === k);

  L.addBank = (name, currency, opening = 0, date = "2026-01-01") => {
    const code = String(1001 + L.banks.length);
    const a = { id: `acct_bank_${code}`, code, name, type: "asset", subtype: "bank", system_key: null, tax_deductible: false };
    L.accounts.push(a);
    const b = { id: id("bank"), name, currency, account_id: a.id };
    L.banks.push(b);
    if (opening) {
      L.post({ date, memo: `Opening balance - ${name}`, sourceType: "opening", sourceId: b.id, currency, lines: [
        { account: a.id, debit: Math.max(opening, 0), credit: Math.max(-opening, 0), bank: b.id },
        { account: "opening_equity", debit: Math.max(-opening, 0), credit: Math.max(opening, 0) }] });
    }
    return b;
  };

  // Mirrors finance_post_entry. rate: number | null (null on a foreign entry => fx 'missing').
  L.post = ({ date, memo = "", reference = "", sourceType = "manual", sourceId = null, currency, rate = null, projectId = null, lines, legacy = false, forceMissing = false }) => {
    const missing = currency !== L.base && (forceMissing || !(rate > 0));
    const r = currency === L.base ? 1 : rate;
    const entry = { id: id("je"), entry_no: ++L.seq, entry_date: date, memo, reference, source_type: sourceType, source_id: sourceId, project_id: projectId,
      currency, base_currency: L.base, fx_rate: missing ? null : r, fx_rate_date: date, fx_source: missing ? "" : "test", fx_status: missing ? "missing" : "ok",
      reverses_entry_id: null, voided_by_entry_id: null, is_legacy: legacy };
    const ls = lines.map((l, i) => {
      const lc = l.currency || currency;
      const debit = r2(l.debit || 0), credit = r2(l.credit || 0);
      let bd = null, bc = null;
      if (!missing) {
        if (l.baseDebit !== undefined || l.baseCredit !== undefined) { bd = r2(l.baseDebit || 0); bc = r2(l.baseCredit || 0); }
        else if (lc === currency) { bd = r2(debit * r); bc = r2(credit * r); }
        else if (lc === L.base) { bd = debit; bc = credit; }
        else throw new Error("Line needs explicit base amount");
      }
      return { id: id("jl"), entry_id: entry.id, line_no: i + 1, account_id: acct(l.account).id, currency: lc, debit, credit, base_debit: bd, base_credit: bc,
        project_id: l.projectId || projectId, bank_account_id: l.bank || null, counterparty: l.counterparty || "", memo: l.memo || "", reconciled_at: null };
    });
    if (!missing) { // absorb sub-5-cent rounding drift, reject anything bigger
      const diff = r2(ls.reduce((s, l) => s + l.base_debit - l.base_credit, 0));
      if (Math.abs(diff) > 0.05) throw new Error(`Base amounts do not balance (${diff})`);
      if (diff > 0) { const t = ls.filter((l) => l.base_credit > 0).sort((a, b) => b.base_credit - a.base_credit)[0]; t.base_credit = r2(t.base_credit + diff); }
      if (diff < 0) { const t = ls.filter((l) => l.base_debit > 0).sort((a, b) => b.base_debit - a.base_debit)[0]; t.base_debit = r2(t.base_debit - diff); }
    }
    const v = validateEntry(ls.map((l) => ({ debit: l.debit, credit: l.credit, currency: l.currency, baseDebit: l.base_debit, baseCredit: l.base_credit })));
    if (!v.balanced) throw new Error(`Unbalanced journal entry (${v.nativeDiff} / ${v.baseDiff})`);
    L.entries.push(entry);
    L.lines.push(...ls);
    return entry;
  };

  // signed (debit - credit) position of a document in a control account, optionally only before an entry
  L.position = (key, docId, beforeNo) => {
    const a = acct(key);
    const es = new Map(L.entries.filter((e) => e.source_id === docId && (!beforeNo || e.entry_no < beforeNo)).map((e) => [e.id, e]));
    let native = 0, base = 0, anyMissing = false;
    for (const l of L.lines.filter((x) => x.account_id === a.id && es.has(x.entry_id))) {
      native += l.debit - l.credit;
      if (l.base_debit === null) { if (l.debit || l.credit) anyMissing = true; } else base += l.base_debit - l.base_credit;
    }
    return { native: r2(native), base: r2(base), anyMissing };
  };

  L.invoice = ({ id: docId, number, date, amount, currency, rate = null, projectId = null, client = "", legacy = false }) =>
    L.post({ date, memo: `Invoice ${number}`, reference: number, sourceType: "invoice", sourceId: docId, currency, rate, projectId, legacy, lines: [
      { account: "ar", debit: amount, counterparty: client }, { account: "sales", credit: amount, counterparty: client }] });

  L.bill = ({ id: docId, number, date, amount, currency, rate = null, projectId = null, vendor = "", expenseKey = "freelancer_costs" }) =>
    L.post({ date, memo: `Bill ${number}`, reference: number, sourceType: "bill", sourceId: docId, currency, rate, projectId, lines: [
      { account: expenseKey, debit: amount, counterparty: vendor }, { account: "ap", credit: amount, counterparty: vendor }] });

  // Mirrors finance_settle: carries the document's ORIGINAL base value, books the difference as realized FX.
  L.settle = ({ kind, docId, amount, currency, date, rate = null, bank, projectId = null, party = "", number = "" }) => {
    const ctrlKey = kind === "invoice" ? "ar" : "ap";
    const pos = L.position(ctrlKey, docId);
    const openNative = kind === "invoice" ? pos.native : -pos.native;
    const openBase = kind === "invoice" ? pos.base : -pos.base;
    if (amount > openNative + 0.005) throw new Error("Payment exceeds outstanding balance");
    const cash = L.banks.find((b) => b.id === bank);
    const cashAcct = cash ? cash.account_id : "legacy_cash";
    const ok = currency === L.base || (rate > 0 && !pos.anyMissing);
    let lines;
    if (ok) {
      const r = currency === L.base ? 1 : rate;
      const bankBase = currency === L.base ? amount : r2(amount * r);
      const release = currency === L.base ? amount : Math.abs(amount - openNative) <= 0.005 ? openBase : r2((openBase * amount) / openNative);
      const diff = r2(bankBase - release);
      if (kind === "invoice") {
        lines = [{ account: cashAcct, debit: amount, baseDebit: bankBase, bank, counterparty: party }, { account: "ar", credit: amount, baseCredit: release, counterparty: party }];
        if (diff > 0) lines.push({ account: "fx_gain_loss", baseCredit: diff }); else if (diff < 0) lines.push({ account: "fx_gain_loss", baseDebit: -diff });
      } else {
        lines = [{ account: "ap", debit: amount, baseDebit: release, counterparty: party }, { account: cashAcct, credit: amount, baseCredit: bankBase, bank, counterparty: party }];
        if (diff > 0) lines.push({ account: "fx_gain_loss", baseDebit: diff }); else if (diff < 0) lines.push({ account: "fx_gain_loss", baseCredit: -diff });
      }
    } else {
      lines = kind === "invoice"
        ? [{ account: cashAcct, debit: amount, bank }, { account: "ar", credit: amount }]
        : [{ account: "ap", debit: amount }, { account: cashAcct, credit: amount, bank }];
    }
    return L.post({ date, memo: `${kind === "invoice" ? "Payment received" : "Payment made"} - ${number}`, reference: number,
      sourceType: kind === "invoice" ? "invoice_payment" : "bill_payment", sourceId: docId, currency, rate: ok ? rate : null, projectId, lines, forceMissing: !ok });
  };

  L.expense = ({ id: docId, date, amount, currency, rate = null, projectId = null, key = "misc_expense", bank, vendor = "" }) => {
    const cash = L.banks.find((b) => b.id === bank);
    return L.post({ date, memo: "Expense", sourceType: "expense", sourceId: docId, currency, rate, projectId, lines: [
      { account: key, debit: amount, counterparty: vendor }, { account: cash ? cash.account_id : "legacy_cash", credit: amount, bank, counterparty: vendor }] });
  };

  // Same-currency transfer, or a cross-currency conversion balanced in base with realized FX.
  L.transfer = ({ from, to, amountFrom, amountTo, date, rateFrom = null, rateTo = null }) => {
    const f = L.banks.find((b) => b.id === from), t = L.banks.find((b) => b.id === to);
    if (f.currency === t.currency) {
      return L.post({ date, memo: `Transfer ${f.name} to ${t.name}`, sourceType: "transfer", currency: f.currency, lines: [
        { account: t.account_id, debit: amountFrom, bank: t.id }, { account: f.account_id, credit: amountFrom, bank: f.id }] });
    }
    const fb = f.currency === L.base ? amountFrom : r2(amountFrom * rateFrom);
    const tb = t.currency === L.base ? amountTo : r2(amountTo * rateTo);
    const diff = r2(tb - fb);
    const lines = [
      { account: t.account_id, currency: t.currency, debit: amountTo, baseDebit: tb, bank: t.id },
      { account: f.account_id, currency: f.currency, credit: amountFrom, baseCredit: fb, bank: f.id }];
    if (diff > 0) lines.push({ account: "fx_gain_loss", baseCredit: diff }); else if (diff < 0) lines.push({ account: "fx_gain_loss", baseDebit: -diff });
    return L.post({ date, memo: `Conversion ${f.name} to ${t.name}`, sourceType: "transfer", currency: f.currency, rate: rateFrom, lines });
  };

  // Void = reversal entry; the original is never edited or removed.
  L.void = (entryId, date = "2026-12-31") => {
    const e = L.entries.find((x) => x.id === entryId);
    const rev = { ...e, id: id("je"), entry_no: ++L.seq, entry_date: date, memo: `Reversal of #${e.entry_no}`, reverses_entry_id: e.id, voided_by_entry_id: null };
    const ls = L.lines.filter((l) => l.entry_id === e.id).map((l) => ({ ...l, id: id("jl"), entry_id: rev.id, debit: l.credit, credit: l.debit, base_debit: l.base_credit, base_credit: l.base_debit, reconciled_at: null }));
    e.voided_by_entry_id = rev.id;
    L.entries.push(rev); L.lines.push(...ls);
    return rev;
  };
  return L;
}
