import test from "node:test";
import assert from "node:assert/strict";
import { makeLedger, validateEntry } from "./ledger.js";
import * as R from "./reports.js";
import { formatMoney, formatTotalsByCurrency, toBase, displayMoney, MASK, symbolToCode } from "./currency.js";

const post = (L) => R.buildPostings(L.data());
const TODAY = "2026-10-06";

test("A: USD invoice $1000, payment $400 -> $600 outstanding", () => {
  const L = makeLedger("USD");
  const bank = L.addBank("Main", "USD", 0);
  L.invoice({ id: "inv1", number: "INV-0001", date: "2026-10-01", amount: 1000, currency: "USD", client: "Acme" });
  L.settle({ kind: "invoice", docId: "inv1", amount: 400, currency: "USD", date: "2026-10-03", bank: bank.id, number: "INV-0001" });
  const ps = post(L);
  const ar = R.aging(ps, "ar", [{ id: "inv1", number: "INV-0001", dueDate: "2026-10-15", party: "Acme" }], TODAY);
  assert.equal(ar.totalBase, 600);
  assert.equal(ar.rows[0].native, 600);
  assert.equal(ar.buckets[0].base, 600); // not yet due -> current
  const pl = R.profitAndLoss(ps, {});
  assert.equal(pl.totalRevenue, 1000);
  assert.equal(R.bankBalances(ps, L.banks)[0].native, 400);
  const bs = R.balanceSheet(ps, {});
  assert.equal(bs.totalAssets, 1000); // cash 400 + AR 600
  assert.ok(bs.balanced, `balance sheet off by ${bs.difference}`);
  assert.ok(R.trialBalance(ps, {}).balanced);
});

test("A2: overpayment is rejected", () => {
  const L = makeLedger("USD");
  const bank = L.addBank("Main", "USD");
  L.invoice({ id: "i", number: "I", date: "2026-10-01", amount: 100, currency: "USD" });
  assert.throws(() => L.settle({ kind: "invoice", docId: "i", amount: 100.5, currency: "USD", date: "2026-10-02", bank: bank.id }), /exceeds/);
});

test("B: EUR invoice keeps its transaction-date base amount; later FX does not rewrite it", () => {
  const L = makeLedger("USD");
  L.invoice({ id: "e1", number: "INV-E1", date: "2026-01-15", amount: 1000, currency: "EUR", rate: 1.08 });
  const before = R.profitAndLoss(post(L), {}).totalRevenue;
  assert.equal(before, 1080);
  // "Today's" rate moves to 1.12 - there is nowhere for it to enter the reports. Rebuild reports: unchanged.
  const after = R.profitAndLoss(post(L), {}).totalRevenue;
  assert.equal(after, 1080);
  const line = L.lines.find((l) => l.account_id === "acct_sales");
  assert.equal(line.credit, 1000);          // native preserved
  assert.equal(line.base_credit, 1080);     // base preserved
  assert.equal(L.entries[0].fx_rate, 1.08);
});

test("B2: paying the EUR invoice at a different rate books realized FX, A/R clears in both currencies", () => {
  const L = makeLedger("USD");
  const eur = L.addBank("Wise EUR", "EUR");
  L.invoice({ id: "e1", number: "INV-E1", date: "2026-01-15", amount: 1000, currency: "EUR", rate: 1.08 });
  L.settle({ kind: "invoice", docId: "e1", amount: 1000, currency: "EUR", date: "2026-07-01", rate: 1.12, bank: eur.id, number: "INV-E1" });
  const ps = post(L);
  assert.deepEqual(R.documentPositions(ps, "ar"), []); // fully cleared natively AND in base
  const pl = R.profitAndLoss(ps, {});
  const fx = pl.revenue.find((r) => r.systemKey === "fx_gain_loss");
  assert.equal(fx.amount, 40);               // 1120 received - 1080 booked
  assert.equal(R.bankBalances(ps, L.banks)[0].base, 1120);
  assert.ok(R.balanceSheet(ps, {}).balanced);
});

test("B3: partial payments carry a proportional share of the original base value", () => {
  const L = makeLedger("USD");
  const eur = L.addBank("Wise EUR", "EUR");
  L.invoice({ id: "e1", number: "E1", date: "2026-01-15", amount: 1000, currency: "EUR", rate: 1.08 });
  L.settle({ kind: "invoice", docId: "e1", amount: 300, currency: "EUR", date: "2026-02-01", rate: 1.10, bank: eur.id });
  L.settle({ kind: "invoice", docId: "e1", amount: 700, currency: "EUR", date: "2026-03-01", rate: 1.06, bank: eur.id });
  const ps = post(L);
  assert.deepEqual(R.documentPositions(ps, "ar"), []);
  const fx = R.profitAndLoss(ps, {}).revenue.find((r) => r.systemKey === "fx_gain_loss").amount;
  // received 300*1.10 + 700*1.06 = 330 + 742 = 1072 vs booked 1080 -> loss of 8
  assert.equal(fx, -8);
  assert.ok(R.trialBalance(ps, {}).balanced);
});

test("B4: missing FX is flagged and excluded - never treated as 1:1", () => {
  const L = makeLedger("USD");
  L.invoice({ id: "e1", number: "E1", date: "2026-01-15", amount: 1000, currency: "EUR", rate: null });
  L.invoice({ id: "u1", number: "U1", date: "2026-01-16", amount: 500, currency: "USD" });
  const ps = post(L);
  const pl = R.profitAndLoss(ps, {});
  assert.equal(pl.totalRevenue, 500);        // the EUR 1000 is NOT counted as $1000
  assert.ok(pl.missing > 0);
  assert.equal(R.fxIssues(L.data()).length, 1);
  assert.equal(R.fxIssues(L.data())[0].currency, "EUR");
  assert.equal(toBase(1000, null), null);
  const ar = R.aging(ps, "ar", [], TODAY);
  assert.equal(ar.unresolved, 1);
  assert.equal(ar.totalNativeByCurrency.EUR, 1000); // native still visible
});

test("C: freelancer bill EUR250 -> A/P up, cost recognised, cash unchanged", () => {
  const L = makeLedger("USD");
  const eur = L.addBank("Wise EUR", "EUR", 1000);
  L.bill({ id: "b1", number: "FB-1", date: "2026-10-01", amount: 250, currency: "EUR", rate: 1.1, vendor: "John" });
  const ps = post(L);
  const ap = R.aging(ps, "ap", [{ id: "b1", number: "FB-1", dueDate: "2026-10-20", party: "John" }], TODAY);
  assert.equal(ap.totalNativeByCurrency.EUR, 250);
  assert.equal(R.profitAndLoss(ps, {}).totalCogs, 275); // 250 * 1.10
  assert.equal(R.bankBalances(ps, L.banks)[0].native, 1000);
  assert.ok(R.balanceSheet(ps, {}).balanced);
});

test("D: paying EUR100 of the EUR250 bill -> A/P 150, cash -100, no second expense", () => {
  const L = makeLedger("USD");
  const eur = L.addBank("Wise EUR", "EUR", 1000);
  L.bill({ id: "b1", number: "FB-1", date: "2026-10-01", amount: 250, currency: "EUR", rate: 1.1, vendor: "John" });
  const costBefore = R.profitAndLoss(post(L), {}).totalCogs;
  L.settle({ kind: "bill", docId: "b1", amount: 100, currency: "EUR", date: "2026-10-05", rate: 1.1, bank: eur.id, number: "FB-1" });
  const ps = post(L);
  const ap = R.aging(ps, "ap", [], TODAY);
  assert.equal(ap.totalNativeByCurrency.EUR, 150);
  assert.equal(R.bankBalances(ps, L.banks)[0].native, 900);
  assert.equal(R.profitAndLoss(ps, {}).totalCogs, costBefore); // cost recognised once, at billing
  assert.ok(R.balanceSheet(ps, {}).balanced);
});

test("D2: bill paid at a different rate books realized FX loss/gain on the payable", () => {
  const L = makeLedger("USD");
  const eur = L.addBank("Wise EUR", "EUR", 1000);
  L.bill({ id: "b1", number: "FB-1", date: "2026-10-01", amount: 250, currency: "EUR", rate: 1.10 });
  L.settle({ kind: "bill", docId: "b1", amount: 250, currency: "EUR", date: "2026-10-20", rate: 1.14, bank: eur.id });
  const ps = post(L);
  assert.deepEqual(R.documentPositions(ps, "ap"), []);
  // owed 275 base, paid 285 base -> 10 loss
  assert.equal(R.profitAndLoss(ps, {}).revenue.find((r) => r.systemKey === "fx_gain_loss").amount, -10);
  assert.ok(R.trialBalance(ps, {}).balanced);
});

test("E: bank transfer $500 A -> B changes balances but not revenue/expense", () => {
  const L = makeLedger("USD");
  const a = L.addBank("Bank A", "USD", 2000), b = L.addBank("Bank B", "USD", 100);
  L.transfer({ from: a.id, to: b.id, amountFrom: 500, date: "2026-10-02" });
  const ps = post(L);
  const bal = R.bankBalances(ps, L.banks);
  assert.equal(bal[0].native, 1500);
  assert.equal(bal[1].native, 600);
  const pl = R.profitAndLoss(ps, {});
  assert.equal(pl.totalRevenue, 0); assert.equal(pl.totalCogs + pl.totalOpex, 0);
  const cf = R.cashFlow(ps, { from: "2026-10-01", to: "2026-10-31" });
  assert.equal(cf.operating, 0); assert.equal(cf.net, 0);
  assert.ok(R.balanceSheet(ps, {}).balanced);
});

test("E2: cross-currency conversion balances in base and books FX difference", () => {
  const L = makeLedger("USD");
  const usd = L.addBank("USD", "USD", 5000), eur = L.addBank("EUR", "EUR", 0);
  L.transfer({ from: usd.id, to: eur.id, amountFrom: 1000, amountTo: 900, date: "2026-10-02", rateFrom: 1, rateTo: 1.12 });
  const ps = post(L);
  assert.equal(R.bankBalances(ps, L.banks)[1].native, 900);
  assert.equal(R.bankBalances(ps, L.banks)[1].base, 1008);
  assert.equal(R.profitAndLoss(ps, {}).revenue.find((r) => r.systemKey === "fx_gain_loss").amount, 8);
  assert.ok(R.trialBalance(ps, {}).balanced);
  assert.ok(R.balanceSheet(ps, {}).balanced);
});

test("F: multi-currency dashboard - native values visible, base uses stored rates, never summed raw", () => {
  const L = makeLedger("USD");
  L.invoice({ id: "u", number: "U", date: "2026-10-01", amount: 1000, currency: "USD" });
  L.invoice({ id: "e", number: "E", date: "2026-10-01", amount: 1000, currency: "EUR", rate: 1.08 });
  L.invoice({ id: "k", number: "K", date: "2026-10-01", amount: 100000, currency: "KES", rate: 0.0077 });
  const s = R.dashboardSummary(L.data(), { today: TODAY });
  assert.deepEqual(s.revenueYtdNative, { USD: 1000, EUR: 1000, KES: 100000 });
  assert.equal(s.revenueYtd, 1000 + 1080 + 770);            // 2850, from stored rates
  assert.notEqual(s.revenueYtd, 1000 + 1000 + 100000);      // the old bug: adding unlike currencies
  assert.equal(formatTotalsByCurrency(s.revenueYtdNative), "\u20ac1,000.00 \u00b7 KSh 100,000.00 \u00b7 $1,000.00"); // alphabetical by code, never summed
});

test("F2: base currency other than USD (KES) works end to end", () => {
  const L = makeLedger("KES");
  L.invoice({ id: "k", number: "K", date: "2026-10-01", amount: 50000, currency: "KES" });
  L.invoice({ id: "u", number: "U", date: "2026-10-01", amount: 100, currency: "USD", rate: 129 });
  const s = R.dashboardSummary(L.data(), { today: TODAY });
  assert.equal(s.baseCurrency, "KES");
  assert.equal(s.revenueYtd, 62900);
});

test("G: privacy mode censors the rendered value itself, not just styling", () => {
  assert.equal(displayMoney("USD", 12430.5, false), "$12,430.50");
  const hidden = displayMoney("USD", 12430.5, true);
  assert.equal(hidden, MASK);
  assert.ok(!/\d/.test(hidden));
});

test("voiding reverses, never deletes; totals return to zero", () => {
  const L = makeLedger("USD");
  const e = L.invoice({ id: "i", number: "I", date: "2026-10-01", amount: 700, currency: "USD" });
  const n = L.entries.length;
  L.void(e.id);
  assert.equal(L.entries.length, n + 1);                       // original still there
  assert.ok(L.entries[0].voided_by_entry_id);
  const ps = post(L);
  assert.equal(R.profitAndLoss(ps, {}).totalRevenue, 0);
  assert.deepEqual(R.documentPositions(ps, "ar"), []);
  assert.ok(R.trialBalance(ps, {}).balanced);
});

test("unbalanced entries are rejected", () => {
  const L = makeLedger("USD");
  assert.throws(() => L.post({ date: "2026-10-01", currency: "USD", lines: [{ account: "ar", debit: 100 }, { account: "sales", credit: 99 }] }), /Unbalanced|do not balance/);
  assert.equal(validateEntry([{ debit: 50, credit: 0, currency: "USD" }, { debit: 0, credit: 50, currency: "USD" }]).balanced, true);
  assert.equal(validateEntry([{ debit: 50, credit: 0, currency: "USD" }, { debit: 0, credit: 40, currency: "USD" }]).balanced, false);
});

test("rounding: 3 x 33.33 style splits stay balanced in base", () => {
  const L = makeLedger("USD");
  L.invoice({ id: "r", number: "R", date: "2026-10-01", amount: 99.99, currency: "EUR", rate: 1.0837 });
  assert.ok(R.trialBalance(post(L), {}).balanced);
});

test("AR aging buckets by days overdue, native and base kept apart", () => {
  const L = makeLedger("USD");
  L.invoice({ id: "a", number: "A", date: "2026-05-01", amount: 100, currency: "USD" });
  L.invoice({ id: "b", number: "B", date: "2026-08-20", amount: 200, currency: "USD" });
  L.invoice({ id: "c", number: "C", date: "2026-09-25", amount: 50, currency: "EUR", rate: 1.1 });
  const docs = [{ id: "a", number: "A", dueDate: "2026-05-15" }, { id: "b", number: "B", dueDate: "2026-08-30" }, { id: "c", number: "C", dueDate: "2026-10-30" }];
  const ag = R.aging(post(L), "ar", docs, TODAY);
  const by = Object.fromEntries(ag.buckets.map((b) => [b.id, b]));
  assert.equal(by.d90p.base, 100);
  assert.equal(by.d31_60.base, 200);
  assert.equal(by.current.base, 55);
  assert.equal(by.current.nativeByCurrency.EUR, 50);
});

test("project profitability: revenue, freelancer cost, outstanding client/freelancer balances", () => {
  const L = makeLedger("USD");
  const bank = L.addBank("Main", "USD");
  L.invoice({ id: "i", number: "I", date: "2026-09-01", amount: 5000, currency: "USD", projectId: "p1", client: "Acme" });
  L.settle({ kind: "invoice", docId: "i", amount: 3000, currency: "USD", date: "2026-09-10", bank: bank.id, projectId: "p1" });
  L.bill({ id: "b", number: "B", date: "2026-09-05", amount: 1800, currency: "USD", projectId: "p1", vendor: "Asama" });
  L.settle({ kind: "bill", docId: "b", amount: 500, currency: "USD", date: "2026-09-12", bank: bank.id, projectId: "p1" });
  L.expense({ id: "x", date: "2026-09-02", amount: 400, currency: "USD", projectId: "p1", key: "software", bank: bank.id });
  const rows = R.projectProfitability(post(L), [{ id: "p1", name: "Trailer", client: "Acme" }]);
  const r = rows[0];
  assert.equal(r.revenue, 5000); assert.equal(r.freelancerCosts, 1800); assert.equal(r.otherCosts, 400);
  assert.equal(r.grossProfit, 3200); assert.equal(r.netContribution, 2800);
  assert.equal(r.outstandingClientNative.USD, 2000);
  assert.equal(r.outstandingFreelancerNative.USD, 1300);
  assert.equal(R.revenueByClient(post(L), [{ id: "p1", client: "Acme" }])[0].revenue, 5000);
});

test("cash flow classifies receipts/payments/expenses and ignores transfers", () => {
  const L = makeLedger("USD");
  const a = L.addBank("A", "USD", 1000, "2026-01-01"), b = L.addBank("B", "USD", 0, "2026-01-01");
  L.invoice({ id: "i", number: "I", date: "2026-10-01", amount: 800, currency: "USD" });
  L.settle({ kind: "invoice", docId: "i", amount: 800, currency: "USD", date: "2026-10-02", bank: a.id });
  L.expense({ id: "x", date: "2026-10-03", amount: 100, currency: "USD", bank: a.id });
  L.transfer({ from: a.id, to: b.id, amountFrom: 300, date: "2026-10-04" });
  const cf = R.cashFlow(post(L), { from: "2026-10-01", to: "2026-10-31" });
  assert.equal(cf.opening, 1000);
  assert.equal(cf.operating, 700);
  assert.equal(cf.closing, 1700);
  assert.equal(cf.detail.operating["Customer receipts"], 800);
});

test("general ledger running balance and CSV export", () => {
  const L = makeLedger("USD");
  L.invoice({ id: "i", number: "I", date: "2026-10-01", amount: 100, currency: "USD" });
  L.invoice({ id: "j", number: "J", date: "2026-10-05", amount: 50, currency: "USD" });
  const ps = post(L);
  const gl = R.generalLedger(ps, "acct_ar", {});
  assert.deepEqual(gl.rows.map((r) => r.runningBase), [100, 150]);
  const csv = R.toCsv(R.transactionExport(ps, {}));
  assert.ok(csv.split("\n").length === 5);
  assert.ok(csv.startsWith("entry_no,date,account_code"));
});

test("formatting and code mapping", () => {
  assert.equal(formatMoney("JPY", 5000), "\u00a55,000");
  assert.equal(formatMoney("KES", 1250), "KSh 1,250.00");
  assert.equal(symbolToCode("$"), "USD"); assert.equal(symbolToCode("KSh"), "KES");
});

test("tax summary separates deductible costs and is not a legal determination", () => {
  const L = makeLedger("USD");
  const bank = L.addBank("Main", "USD");
  L.invoice({ id: "i", number: "I", date: "2026-10-01", amount: 1000, currency: "USD" });
  L.expense({ id: "x", date: "2026-10-02", amount: 200, currency: "USD", key: "software", bank: bank.id });
  const t = R.taxSummary(post(L), {});
  assert.equal(t.revenue, 1000); assert.equal(t.deductibleExpenses, 200); assert.equal(t.indicativeTaxableProfit, 800);
});
