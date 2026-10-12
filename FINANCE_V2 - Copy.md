# Finance v2 - technical assessment, architecture, deployment

## 1. Assessment of the old module (verified against the code)

| Area | Finding |
|---|---|
| Architecture | `computeFinanceData()` re-derived revenue/expenses/profit from invoices + expenses on every render. No ledger, no payments, no liabilities. |
| FX (critical) | `convertToUSD()` applied **today's** rate to every historical amount, so past revenue changed when rates moved. When a rate was missing it **returned the unconverted amount** (EUR 1,000 became $1,000) while its own comment claimed the opposite. |
| Currency identity | Currencies stored as symbols (`$`), not ISO codes. Finance and the dashboard hardcoded `$` / USD. |
| Payments | `invoices.amount_paid` + one `paid_date`. No payment history; revenue recognised by "paid" status only. |
| Freelancers | Marking a shot paid wrote a *cash expense*. Assigned work was never a liability; nothing could say "you owe Asama EUR 120". |
| Expenses | 6 fields (project, category, description, amount, currency, date). No vendor, payment account, status. |
| Dashboard | Its own revenue / outstanding maths with live-FX conversion, separate from Finance. |
| Not present | Chart of accounts, journals, balance sheet, cash flow, A/P, banking, reconciliation, tax data, audit trail. |

## 2. Architecture

```
financial events -> journal entries (immutable, balanced) -> reports.js -> Finance screens + dashboard
```
* **Database** (`migration_finance_v2.sql`): ledger tables, payments, bills, banking, atomic RPCs, triggers that keep existing UI flows posting to the ledger, RLS.
* **Accounting domain** (`src/finance/ledger.js`): reference implementation of the posting rules (used for tests and the manual-journal balance check). **The SQL is the system of record; if a posting rule changes, change both.**
* **Reporting** (`src/finance/reports.js`): pure functions over ledger lines. Finance and the dashboard both read this; there is no second source of financial truth.
* **UI** (`src/finance/*.jsx`): Overview, Sales, Purchases, Expenses, Banking, Accounting, Reports, Taxes, Settings. App.jsx only mounts it.

### Posting rules
| Event | Debit | Credit |
|---|---|---|
| Invoice issued | Accounts Receivable | Animation Services (revenue) |
| Customer payment | Bank (payment-date rate) | A/R (carries the invoice's ORIGINAL base value); difference to Realized FX |
| Bill approved | Freelancer / chosen cost account | Accounts Payable |
| Bill payment | A/P (original base value) | Bank; difference to Realized FX |
| Expense paid | Expense account | Bank (or Legacy Cash) |
| Transfer | To-account | From-account (cross-currency: balanced in base, FX difference booked) |
| Void | reversal entry with debit/credit swapped; original is never edited or deleted | |

Every entry stores native amounts, currency, base currency, FX rate, rate date, rate source and base amounts. Entries are balanced natively (single-currency) and in base, enforced by a deferred constraint trigger.

### FX policy
* Rates come from daily snapshots saved when the app opens (`fx_rates`), or manual entries. A transaction uses the stored rate at or up to 7 days before its date.
* **No rate = entry posted with `fx_status='missing'` and NULL base amounts.** It is excluded from consolidated totals, counted and flagged, and resolved in Finance > Settings (enter the real rate, or accept today's rate as an explicitly labelled *estimate*). Never 1:1.
* Today's rate is used only for display of "today's rate" estimates and never rewrites a stored entry.

## 3. Data migration (legacy)
Run inside the migration, idempotent, nothing deleted:
* Non-superseded invoices -> issuance entry (+ a payment record/entry for `amount_paid`, dated `paid_date`). Superseded chain members are skipped (matches how the app always counted revenue).
* Expenses -> Dr expense account / Cr **Legacy Cash (unallocated)**, mapped from the old category labels.
* All flagged `is_legacy`. Historic payments have no known bank account, so they sit in Legacy Cash until you move them with a transfer.
* Foreign-currency legacy amounts have no historical rate, so they are `fx_status='missing'` until resolved. This is deliberate: inventing rates would be fabrication.
* Base currency defaults to the studio's currency in `user_settings` (USD if absent). It can be changed (`finance_set_base_currency`) only while the ledger holds nothing but legacy-derived entries; after that it is locked.

## 4. What changed outside `src/finance/`
`App.jsx` only: imports; expense model + editor (vendor, paid-from account, reference); invoice editor makes `amount paid`/status read-only for saved invoices (payments are recorded in Finance); old `FinancePanel` and `computeFinanceData` removed; dashboard financial KPIs/chart read the ledger summary and respect privacy mode; FX snapshot saving; ledger errors are shown instead of failing silently.

Behaviour changes to be aware of:
* Editing the paid amount/status of a saved invoice, or amount/currency/project/issue date of an invoice that has payments, is rejected with a message.
* Deleting an invoice that has recorded payments, or a project containing one, is blocked (void the payments, or archive the project).
* `log_shot_payment` keeps its signature but now creates bill -> payment -> ledger entries atomically. Duplicate protection: shot row lock + `assigned_paid` + unique `bill_shots(shot_id)` + existing unique `expenses(shot_id)`.

## 5. Deployment
1. **Back up the database.**
2. Run `migration_finance_v2.sql` in the Supabase SQL editor (includes the backfill).
3. Run `finance_v2_tests.sql` (rolls back; see the note at its top).
4. Copy `src/App.jsx` and `src/finance/` into the project; `npm run build`.
5. Open Finance: Settings (resolve missing FX), Banking (add real accounts, set a default).

Rollback of the app code requires dropping the guard triggers or old invoice edits will be rejected:
```sql
drop trigger if exists trg_finance_invoice_guard on invoices;
drop trigger if exists trg_finance_invoice_after_insert on invoices;
drop trigger if exists trg_finance_invoice_after_update on invoices;
drop trigger if exists trg_finance_invoice_before_delete on invoices;
drop trigger if exists trg_finance_expense_after_insert on expenses;
drop trigger if exists trg_finance_expense_guard on expenses;
drop trigger if exists trg_finance_expense_after_update on expenses;
drop trigger if exists trg_finance_expense_before_delete on expenses;
```
(the old `log_shot_payment` body is in `migration_teams_payment_atomicity.sql`).

## 6. Verification status - read this
| | Status |
|---|---|
| JS posting rules, reports, scenarios A-G, rounding, voids, aging, cash flow, tax summary | **23 automated tests pass** (`node --test src/finance/finance.test.mjs`) |
| App compiles; no undefined identifiers | Built with esbuild; TypeScript check found none |
| UI | Rendered and driven in Chromium against a mock database: every tab, privacy toggle (persists across reload, masks values on all tabs), balance sheet/trial balance balanced messages, error surfacing, no mobile overflow |
| **SQL migration and RPCs** | **NOT EXECUTED.** No Postgres was available. Statically checked only (balanced quoting/parentheses, every internal function resolves). Treat `finance_v2_tests.sql` as mandatory before relying on it, on a copy of your data first. |

## 7. Not built / known limitations
* **Invoice tax lines, discounts, credit notes, write-offs** are not implemented. The Tax view is a classification summary (deductible vs not, tax-payable account activity), not a tax computation.
* **Payments must go into an account of the invoice's currency** (a EUR invoice into a EUR account); convert between accounts with a transfer. Paying a EUR invoice straight into a USD account is refused rather than guessed.
* Only **realized** FX gain/loss is booked. No unrealized revaluation report.
* Reconciliation is manual selection against a statement balance; no bank-feed or statement import.
* No accounting-period locking / year-end close. Retained Earnings is derived (shown as "current earnings").
* Customers are the existing project clients; there is no separate customer record UI. Vendors/contacts are created automatically for team members.
* `projectBudgetSummary()` (the budget-progress figure on project cards, outside Finance) still converts with live rates. Same class of flaw; left alone because it is not a financial record, but it should be moved onto the ledger.
* Backdated foreign-currency transactions created before rate snapshots exist need a manual rate (Settings).
* Reports load the whole ledger client-side; fine for a studio's volume, would need server-side aggregation at tens of thousands of lines.
