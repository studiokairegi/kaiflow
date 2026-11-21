# Finance V3 - Master Architecture

Status: **Phase 1 specification. Binding on Phases 2-7 unless a later phase documents a deviation, with reasons, in its handoff.** Nothing in this document is implemented yet except the contracts and guard tests in `src/finance-v3/`.

Evidence behind the decisions: `FINANCE_V3_ROOT_CAUSE_AUDIT.md`, `FINANCE_V3_DATA_INVENTORY.md`.

## 1. Principles

1. **One ledger, one posting service, one security model.** Simple Mode and Accountant Mode are two views of the same data.
2. **The database is the authority.** Balancing, immutability, FX conversion, rounding, authorization and every protection rule are enforced in PostgreSQL. JavaScript renders; it does not decide.
3. **No money arithmetic in JavaScript.** Amounts are decimal strings on the wire.
4. **Events in, entries out.** Business actions become financial events; events become balanced, immutable journal entries; reports read entries.
5. **Isolation.** V3 lives in its own schema and code folder; V2 stays intact and untouched until a controlled cutover.
6. **Honest uncertainty.** Missing FX rates, unmigratable records and unreconciled balances are flagged, never guessed.

## 2. Decision register

| ID | Decision | Why (evidence) | Alternative rejected |
|---|---|---|---|
| D-01 | V3 objects live in Postgres schema **`finance_v3`**, not exposed to PostgREST; clients call **`public.fin3_*`** RPCs and `public.fin3_v_*` read views/RPCs | Isolation from V2 (`public`), a single audited entry surface, no accidental table-level API exposure | Prefixed tables in `public` (`fin3_*`): easier API access but weaker isolation and RLS-by-accident risk |
| D-02 | **Tenant = `organization_id`** (`studio_organizations`), resolved server-side from `studio_memberships` of `auth.uid()`; **never** from a client-supplied id and never `user_id` alone | F1/F2: V2's per-user ledgers split a studio | Keep `user_id` scoping: reproduces the V2 defect |
| D-03 | **Money = `numeric(19,4)`**, FX rate `numeric(20,10)`, rounding half-away-from-zero to the currency's ISO 4217 minor unit once, in the DB, when deriving a base amount; JS sees decimal strings | Roadmap 2.D; F10 | JS numbers / floats |
| D-04 | **Transaction currency + base currency** stored on every line; base amounts computed server-side from a stored transaction-date rate | Roadmap 2.E | Re-converting at report time |
| D-05 | **Missing FX rate => `fx_status='missing'`, NULL base amounts, entry is posted but excluded from base totals and flagged** (V2's proven policy). Never 1:1, never today's rate on history. A user may later attach a real rate (`fx_status` -> `converted`) or an explicitly labelled `estimate` via an audited operation that creates an *adjustment*, not an edit | F9; roadmap 2.E | Block posting entirely (loses cash truth) |
| D-06 | **Single posting entry point** `finance_v3.post_event(...)`. All domain RPCs call it; table DML is revoked from every client role | Prevents bypass; one place for invariants | Per-feature ad-hoc inserts |
| D-07 | V3 installs **no triggers on legacy tables** (`invoices`, `expenses`, `shots`, ...) | F4: V2 bridge triggers changed the behaviour of existing flows | Mirror V2 bridges |
| D-08 | `public.invoices` / `expenses` remain the app's **document records** until cutover. V3 holds the **financial record** (`finance_v3.receivables`, etc.) linked by `source_invoice_id`/`source_expense_id`. After cutover the legacy `amount_paid`/`status` columns become a **cache written by one V3 sync function**; the ledger is the only truth | Roadmap 1.2 (preserve invoices) + "no duplicate sources of truth" | Dropping/rewriting `invoices` |
| D-09 | Payments (Paystack/Wise/manual) are **re-pointed** to a V3 settlement RPC at cutover (Phase 7); until then they keep posting to V2. During any overlap, an organization is flagged as `engine = 'v2'` or `'v3'` so only one engine accepts new money events for it | F3: hard dependency | Dual-write both ledgers |
| D-10 | **Idempotency**: every externally triggered event carries an `idempotency_key`; a unique `(organization_id, idempotency_key)` makes replays return the original result (not an error) | Roadmap 2.F, 3.E | Client-side de-dup |
| D-11 | **Reversal, never edit.** Posted entries are immutable; corrections are new entries linked by `reverses_entry_id`. Drafts are editable by their creator until posted | Roadmap 2.C | Soft-edit with audit |
| D-12 | **Migration naming/ordering:** `supabase/migrations/<ts>_finance_v3_<topic>.sql`, `<ts>` **greater than 20270112100000** (the newest existing). Enforced by a guard test | F7 | Real-date timestamps (would sort mid-history) |
| D-13 | **Errors:** custom SQLSTATE class `V3` (`V3001`...), listed in `contracts/ERROR_CODES` | Programmatic mapping; avoids parsing messages | Message-text matching |
| D-14 | **Allocations are logical, not cash.** Reserves, production allocations and owner-pay plans are a sub-ledger (`allocations`) that earmarks ledger cash; they never create or move cash in the journal | Roadmap 4.C-D: "allocations do not inflate actual cash" | Separate bank accounts only |
| D-15 | **Accounting periods / year-end close** are in the schema from day one (`period_lock_date` on the organization settings) but the close workflow is out of scope until after V3.0. Posting before the lock date raises `V3006` | Roadmap does not require close; schema must not preclude it | Retrofit later |
| D-16 | **No `SECURITY DEFINER` function without** `set search_path = pg_catalog, finance_v3` (and `public` only where needed), an explicit `auth.uid()` check, and an explicit `revoke ... from public, anon` + `grant execute ... to authenticated` | Best practice; V2 followed the same pattern | Default grants |

### Decisions the owner should confirm before Phase 2 starts
* **D-01** - this implies RPC-only access. If the owner prefers direct PostgREST table reads for reporting, say so now.
* **D-02** - assumes every legacy owner can be mapped to an organization (`studio_data_owners`). If some cannot, Phase 3 needs a bootstrap rule.
* **D-08** - the cache-column approach to legacy `invoices.amount_paid`.
* **Base currency policy** - one base currency per organization, changeable only before the first non-legacy posting (V2 rule). KES vs USD is a business choice; V3 must not default it silently (see 5.3).

## 3. Accounting domain

### 3.1 Concepts
* **Organization** - tenant. **Ledger account** - chart-of-accounts row. **Financial event** - what happened (invoice issued, payment received, bill approved...). **Journal entry** - the balanced accounting result of one event (1 event -> 1 entry; reversal = a second event). **Journal line** - one debit or credit on one account. **Allocation** - a logical earmark of cash.

### 3.2 Chart of accounts
Types (contract `ACCOUNT_TYPES`): asset, liability, equity, revenue, cost_of_sales, operating_expense, other_income, other_expense. Codes are strings; ranges by type: 1xxx assets, 2xxx liabilities, 3xxx equity, 4xxx revenue, 5xxx cost of sales, 6xxx operating expenses, 7xxx other income, 8xxx other expenses. System accounts (cash/bank parents, A/R, A/P, Animator Payables, FX gain/loss, Opening Balance, Owner Draws/Contributions, Retained/Current Earnings, Reserve) are flagged `is_system` and cannot be deleted or retyped. Animation-studio defaults are seeded per organization; accounts can be added, renamed and deactivated, never deleted once used.

### 3.3 Core tables (all in `finance_v3`, all have `organization_id not null`)

| Table | Purpose | Key constraints |
|---|---|---|
| `org_settings` | base currency, period lock date, mode preference default, engine flag | PK `organization_id` |
| `accounts` | chart of accounts | unique `(organization_id, code)`; type check |
| `currencies` | ISO 4217 code, minor unit | seeded |
| `fx_rates` | rate per (org, from, to, rate_date), source (`manual`/`provider`), entered_by | unique key; never updated in place (append, supersede) |
| `events` | financial event log | unique `(organization_id, idempotency_key)`; `kind`, `payload jsonb`, `actor` |
| `journal_entries` | header: `entry_no` (gapless per org via counter row, not `max()+1`), `accounting_date`, `status`, `event_id`, `reverses_entry_id`, `project_id`, `memo`, `reference`, `fx_status` | status transitions only draft->posted->(reversed marker via link) |
| `journal_lines` | `entry_id`, `account_id`, `side`, `amount_native`, `currency`, `fx_rate`, `fx_rate_date`, `fx_source`, `amount_base`, `project_id`, `memo` | `amount_native >= 0`; one-sided lines |
| `audit_log` | append-only, row-level before/after, actor, reason | no UPDATE/DELETE privilege for anyone |
| `idempotency` | outcome cache for replays | FK to events |

Domain tables are added by their phase (receivables, payables, expenses, bank accounts, reconciliations, project finance, animator work/obligations, allocations, owner pay). Each phase's tables follow the same rules: `organization_id` first, RLS on, no client DML, audit rows on every mutation.

### 3.4 Invariants (enforced by the database; Phase 2 must test each)
1. For each entry **and each currency**, sum(debits) = sum(credits) in native amounts; and sum(base debits) = sum(base credits) when base amounts exist. Enforced by a **deferred constraint trigger** on `journal_lines`, so an unbalanced entry cannot commit even if application code is wrong.
2. A posted entry and its lines cannot be updated or deleted by any role the application uses (trigger raises `V3002`; privileges revoked).
3. A reversal entry has lines that mirror the original with debit/credit swapped, the same accounts, the same native amounts and the **original base amounts** (history is never re-rated); original is marked reversed by the link, not edited.
4. `(organization_id, idempotency_key)` is unique.
5. Every line's account belongs to the entry's organization (composite FK `(organization_id, account_id)`).
6. A line in a currency different from the org base currency has an `fx_rate` or `fx_status = 'missing'` (never both absent, never 1 by default).
7. No posting dated on or before `period_lock_date` unless an authorized adjustment path is used (`V3006`).

### 3.5 Posting service
`finance_v3.post_event(p_org uuid, p_kind text, p_event_key text, p_accounting_date date, p_lines jsonb, p_meta jsonb) returns uuid`:
validate caller (membership + permission for `p_kind`), take a per-org advisory lock for entry numbering, resolve FX per line, derive base amounts with the rounding rule, insert event + entry + lines + audit atomically, return the entry id. Domain RPCs (`fin3_record_client_payment`, ...) build the lines from business rules; the **posting rules table in the roadmap (section "Posting rules")** is the specification.

### 3.6 Posting rules (summary - exact accounts per phase)
| Event | Debit | Credit |
|---|---|---|
| Invoice issued | Accounts Receivable | Revenue (animation services) |
| Client payment | Bank/Cash | Accounts Receivable (carrying original base value); difference to Realized FX |
| Bill / freelancer work approved | Cost of sales (animator) or expense account | Accounts Payable / Animator Payables |
| Bill payment | Payables | Bank/Cash; FX difference to Realized FX |
| Expense paid | Expense account | Bank/Cash |
| Transfer | To-account | From-account (cross-currency balanced in base, difference to FX) |
| Owner contribution | Bank/Cash | Owner Contributions (equity) |
| Owner draw / personal withdrawal | Owner Draws (equity) | Bank/Cash |
| Owner salary | Salary expense | Bank/Cash |
| Reimbursement to owner | Expense | Bank/Cash (or reduce Owner Payable) |
| Void / correction | Mirror of original | Mirror of original |
Revenue is recognized on **issuance**; cash-basis views are a reporting option, not a different ledger.

## 4. Studio financial model (Phase 4 specification)

### 4.1 Project financials (derived in the database, never typed in)
contract value, client payments received (ledger cash), receivable outstanding, project budget, animator budget, **approved animator cost** (obligation), **paid animator cost**, outstanding obligation = approved - paid, other production expenses, transfer fees, **actual cost** (posted expense/cost-of-sales on the project), **committed cost** (approved-unpaid + approved bills unpaid), remaining budget = budget - actual - committed, profit = revenue recognized - actual cost, margin = profit / revenue (null when revenue is 0), plus a separate **cash view** (cash in - cash out) so accounting profit and cash movement are never conflated.

### 4.2 Animator obligations
Lifecycle: `assigned -> submitted -> approved -> (partially) paid -> settled` (or `cancelled`). Rate snapshot taken at assignment (rate history is preserved, as in `team_member_rate_history`). **Approval** posts Dr cost of sales / Cr Animator Payables - an obligation, not a cash payment. **Payment** posts Dr Animator Payables / Cr Bank. Uniqueness: one open obligation per (assignment, work unit); duplicate approval and duplicate payment are blocked by idempotency keys plus unique constraints. Existing data has no work-unit model (inventory section 6), so V3 introduces `work_units` linked to `shots`.

### 4.3 Allocations and reserve (D-14)
`allocations(organization_id, project_id null, purpose, amount, currency, status, created_by)` with purposes `animator_commitment`, `production_expense`, `business_operations`, `reserve`, `owner_pay`. Allocations never touch the journal. `reserve_policy(target, minimum, currency)` is per-organization and has **no default** (the KSh 100,000-150,000 planning figure belongs to Studio Kairegi's configuration, not the code). Reserve contributions/withdrawals are allocation movements with history; whether a physical reserve account also exists is the owner's configuration.

### 4.4 Owner compensation
Salary (expense, payroll-style schedule), draw (equity reduction), contribution (equity increase), reimbursement (expense/owner payable), personal withdrawal (equity). Classification is mandatory at entry time; a business expense paid personally becomes an owner contribution or reimbursable, never silently a draw.

### 4.5 Safe-to-spend (single authoritative function `finance_v3.safe_to_spend(org, as_of, currency)`)
```
available_cash       = sum(ledger balance of cash & bank accounts, converted at stored rates; missing-FX balances reported separately)
committed_obligations= approved-unpaid animator obligations + approved-unpaid bills (+ other recognised payables due)
protected_allocations= animator_commitment + production_expense + reserve (earmarks that are NOT already counted as a liability above - de-duplicated by allocation.covers_obligation_id)
pending_outflows     = scheduled/pending payments not yet posted
safe_to_spend        = available_cash - committed_obligations - protected_allocations - pending_outflows   (floor shown as 0, shortfall reported)
```
Excluded by rule: unpaid client invoices (receivables are never cash), draft documents. The function returns a **breakdown** (each component with its source accounts/ids) so Accountant Mode can trace the number, and a `warnings` array (missing FX, unreconciled, below reserve). Multi-currency: per-currency cash is shown natively and converted for the headline; if any needed rate is missing the headline is flagged "incomplete", not guessed.

### 4.6 Protection rules (server-enforced)
Owner draws, owner salary, personal withdrawals and discretionary expenses call `check_protection(org, action, amount, currency)`. Outcome `allow` / `warn` / `block` (`V3007`). A block can be overridden only by a user with the `finance.override` permission supplying a reason; the override and reason go to `audit_log` and the event. Direct calls to RPCs cannot bypass this because the check is inside the posting path, not the UI.

## 5. Security and authorization

### 5.1 Model
* Roles come from existing `studio_memberships.role` plus department membership; Finance access = Master User, Finance/Accounting department admins, and explicit grants. A new permission set is added in `finance_v3.permissions` (e.g. `finance.read`, `finance.post`, `finance.approve`, `finance.pay`, `finance.owner_pay`, `finance.override`, `finance.admin`) mapped from existing roles in Phase 2, reusing `studio_user_has_app_permission` patterns rather than inventing a second identity system.
* **RLS on every table**, policy = `organization_id` in the caller's active memberships **and** `finance.read`. No `FOR ALL` policies; no client INSERT/UPDATE/DELETE privileges at all.
* **RPCs** derive the organization from the caller or verify it against memberships; they never trust `organization_id` from the payload without checking membership; they check the specific permission for the action.
* Freelancer and client roles have **no** finance access in V3.0 (the freelancer portal continues to use its own existing functions).
* Service role is used only by the existing payment webhooks (via the re-pointed settlement RPC in Phase 7) and by migration tooling run by an admin.
* Financial privacy mode (V2 `privacy_mode`) is a per-user UI preference, re-implemented as a user preference; hidden amounts are a display matter, not a security boundary.

### 5.2 Audit
Every mutating RPC writes `audit_log(actor, organization_id, action, object_type, object_id, before, after, reason, at)`. Append-only: no UPDATE/DELETE privileges, plus a guard trigger.

### 5.3 Base currency
Stored per organization, **must be chosen explicitly at V3 initialization** (no silent USD default; V2 defaulted to USD). Changeable only while the ledger contains nothing but imported/legacy entries.

## 6. Responsibility split

| Responsibility | Database | Application (client) |
|---|---|---|
| Debit = credit, immutability, idempotency, numbering | Yes | No |
| FX lookup, conversion, rounding | Yes | Display only |
| Authorization, permissions, protection rules | Yes | Hides controls, shows warnings |
| Balances, reports, aging, safe-to-spend, project profit | Yes (SQL functions/views) | Renders, filters, exports |
| Form validation | Final validation in DB | Early UX validation (shape only) |
| Plain-language wording, confirmations ("explain before confirm") | No | Yes |
| Mode (Simple/Accountant) | Stores preference | Switches layout; same RPCs |
| Pagination | Keyset pagination in SQL | Infinite/paged lists |
| CSV export | Source rows | Formatting (Phase 6) |

## 7. Simple Mode and Accountant Mode
Both call the **same RPCs**. Simple Mode wraps them in guided actions ("Record client payment" -> `fin3_record_client_payment`) and shows plain-language summaries (`fin3_overview`). Accountant Mode exposes ledger, journals, statements, aging, reconciliation, audit and settings. Switching mode writes only a preference row. **Traceability rule:** every number in Simple Mode returns an `explain` payload (component amounts + account ids) that Accountant Mode can open.

## 8. Reporting engine (Phase 6, designed now)
SQL functions returning sets (`fin3_report_trial_balance`, `_profit_loss`, `_balance_sheet`, `_cash_flow`, `_general_ledger`, `_ar_aging`, `_ap_aging`, `_project_profitability`, `_expense_breakdown`, `_animator_obligations`, `_reserve`, `_owner_compensation`) with `(p_org, p_from, p_to, p_currency)` and keyset pagination for ledger-sized outputs. Reports reconcile to the ledger by construction (each is a query over `journal_lines`); a `fin3_report_integrity` function checks sum(debits)=sum(credits) and statement ties. The dashboard calls the same functions; it computes nothing itself. Reports exclude `fx_status='missing'` amounts from base totals and return a count of excluded entries.

## 9. Emma (Phase 6)
Read-only: a dedicated `fin3_emma_snapshot(p_org)` RPC returns a bounded, permission-checked JSON summary (overdue invoices, obligations, safe-to-spend, reserve status, budget warnings). Emma has no write path; actions are proposed as confirmation cards that call the normal RPCs under the *user's* session after explicit confirmation.

## 10. Migration and cutover strategy
1. **Phase 3** builds importers that read V2/legacy and write V3 only, with mapping tables, per-record status (`imported`, `skipped_duplicate`, `failed(reason)`), retry, and a reconciliation report. Idempotent by source key. Strict parsing (inventory section 6). Never edits V2.
2. **Phase 7** rehearses on a **copy** of representative data, compares counts and balances, produces the migration reconciliation report, then a cutover plan: backup -> V3 schema -> import -> reconcile -> tests -> flip `org_settings.engine` to `v3` (re-points payments, dashboard, UI) -> verify -> keep V2 read-only. Rollback = flip engine back to `v2` (V2 untouched). V2 is not dropped by any phase in this roadmap.
3. Production migration is never run automatically; it needs the owner's explicit go-ahead.

## 11. Conventions

**Naming:** schema `finance_v3`; tables plural snake_case; RPCs `fin3_<verb>_<noun>`; internal functions in `finance_v3` without prefix; indexes `ix_<table>_<cols>`; constraints `ck_/fk_/uq_` prefixes; migrations `<ts>_finance_v3_<topic>.sql`; tests `supabase/tests/finance_v3/*.test.sql`.
**Errors:** `raise exception '<plain message>' using errcode = 'V3xxx'`; messages are safe to show.
**Money:** decimal strings, `numeric(19,4)`, FX `numeric(20,10)`, rounding once in DB (contract `MONEY`).
**Dates:** `accounting_date date` (never text); timestamps `timestamptz`; organization timezone for display only.
**Versioning:** `finance_v3.schema_version(version, applied_at, notes)`; contract version string in `contracts/index.js`; breaking RPC changes create `fin3_<name>_v2`, never alter a released signature.
**Migrations:** additive; idempotent (`if not exists`); one concern per file; each ships a rollback script in `supabase/rollback/` that never drops tables holding data; safe to re-run in the repo's SQL test harness.
**Testing:** JS unit tests (`*.test.mjs`, `npm test`); SQL tests on a disposable PostgreSQL; RLS tests impersonate roles; concurrency tests use multiple sessions; every handoff records command and real output.
**Performance:** index `(organization_id, accounting_date)`, `(organization_id, account_id)` on lines; keyset pagination; aggregates in SQL.

## 12. Isolation rules (tested by `src/finance-v3/guards/isolation.test.mjs`)
V2 artifacts are hash-pinned (`docs/finance-v3/v2-baseline.sha256`); V3 never imports V2 or payments code; nothing outside V3 imports V3 before Phase 5/6; V3 migrations sort after every existing migration and never alter, drop or write protected tables; no secrets under V3 paths.

## 13. Risks
| Risk | Mitigation |
|---|---|
| Owner's live DB state unknown (U1-U3) | Owner runs audit section 5 checks before Phase 2 |
| Org mapping missing for some legacy owners | Phase 3 bootstrap rule decided with owner (D-02) |
| Payments flows break at cutover | D-09 engine flag, Phase 7 rehearsal incl. payment sandbox tests |
| Currency symbol ambiguity (`$`) | Owner confirms mapping; no silent default |
| Phase scope creep | Roadmap contracts below; handoff checklist |
| No Postgres in some sessions | Phase 2 cannot be accepted without real PostgreSQL results (roadmap 2 acceptance) |
