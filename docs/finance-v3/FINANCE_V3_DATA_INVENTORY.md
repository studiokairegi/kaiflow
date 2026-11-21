# Finance V3 - Phase 1 Financial Data Inventory

Source: static reading of `schema.sql`, `migration_*.sql` (repo root), `supabase/migrations/*.sql` and the client code. **No live database was queried**, so there are **no row counts or balances** in this document; record counts must be gathered by the owner (queries in section 8) before Phase 3 designs the importer. No secrets or private values are reproduced here.

Legend - **Eligibility**: `Migrate` = candidate for V3 import (after validation); `Reference` = read to link/enrich, never copied; `Keep` = stays as-is, V3 links to it; `Exclude` = not financial truth.

## 1. Where each requested data class lives

| Roadmap item | Where it lives today | Eligibility | Notes |
|---|---|---|---|
| Invoices | `public.invoices` | Migrate | Document record (number, description, PDF/language fields) + legacy `amount`, `amount_paid`, `status`. V2 added `journal_entry_id`, `is_legacy`, supersession chain (`superseded` logic in app) |
| Invoice payments | `public.invoice_payments` (V2) | Migrate | Created by V2 (`finance_record_invoice_payment`, Paystack apply, manual flows). Legacy-only paid amounts have a backfilled payment row dated `paid_date` |
| Expenses | `public.expenses` (+ V2 columns) | Migrate | Legacy rows posted Dr expense / Cr "Legacy Cash" |
| Projects | `public.projects` | Keep / Reference | `budget` is **text**; `currency` is a symbol; client is text `client` + optional `contact_id` |
| Clients | `public.contacts` (via `projects.contact_id`) and free-text `projects.client` | Reference | No separate customer ledger today |
| Freelancers | `public.team_members` (+ `team_member_payment_details`, `team_member_rate_history`, `team_member_reviews`) | Reference | Rate stored as text and as `rate_amount`/`rate_type`/`rate_currency` |
| Animator assignments | `shots.assigned_member_id`, `shots.assigned_to` (text), `shots.assigned_pay` (numeric), `shots.assigned_paid` (bool) | Reference + Migrate (obligations) | **No quantity / submitted / approved fields exist.** Phase 4 needs new V3 concepts (see 6) |
| Shot payments | V2 `bills` + `bill_shots` + `bill_payments`; legacy path `log_shot_payment` (writes a cash expense; V2 rewrote it to bill -> payment -> ledger) | Migrate | Duplicate protection via `bill_shots(shot_id)` unique and `expenses(shot_id)` unique |
| Freelancer payouts | `public.freelancer_payout_requests` (simulated only: `is_simulated` is forced true) | Exclude (reference) | No real transfers exist in the module |
| Bank accounts | `public.bank_accounts` (V2) + `finance_settings.default_bank_account_id` | Migrate (accounts only; balances are derived) | Each has a chart account; "Legacy Cash (unallocated)" holds pre-V2 cash movements |
| Financial settings | `public.finance_settings`, `public.user_settings` (currency symbol, tax id, payment terms, payment method options) | Reference | Base currency may be changed only while the ledger is legacy-only |
| Historical currency info | `public.fx_rates` (V2 daily snapshots, per user), `invoices.currency`, `projects.currency`, `expenses.currency`, `payment_fx_snapshots`, `payment_quotes` | Migrate (rates) | No true historical rate exists before V2 snapshots started |
| Existing accounting records | `public.chart_accounts`, `journal_entries`, `journal_lines`, `finance_audit_log`, `bank_reconciliations`, `finance_contacts` | Migrate (selectively) | Posted V2 entries are immutable; V3 imports as **opening/legacy** entries, never edits |
| Online payments | `paystack_transactions`, `paystack_webhook_events`, `payment_*` (providers, quotes, checkout sessions, manual payments, events, fx snapshots), `payment_transactions` | Keep (dependency) | Posts into V2 via `finance_settle` today; see F3 in the root-cause audit |
| Budget planning | `budget_planners`, `planner_templates`, `projects.budget_mode` | Reference | Planner feeds project budget numbers in the UI |

## 2. Legacy business tables (pre-V2)

### `projects`
PK `id uuid`. `user_id` -> `auth.users` (cascade). Money-relevant: `budget text`, `currency text default '$'`, `budget_mode text`, `client text`, `client_address`, `client_tax_id`, `contact_id uuid -> contacts (set null)`. Ownership additionally mapped to an organization through `studio_data_owners` and shared by `studio_project_members`.

### `shots`
PK `id`. `user_id`; `project_id -> projects (cascade)`; `rate text` (client-side rate, free text); `assigned_member_id -> team_members (set null)`; `assigned_to text`; `assigned_pay numeric`; `assigned_paid boolean`. A shot is the unit of freelancer work.

### `invoices`
PK `id`. `user_id`; `project_id -> projects (cascade)`; `invoice_number text`; `description text`; `amount numeric`; `amount_paid numeric`; `issue_date text`; `due_date text`; `status text` (default `unpaid`); `currency text` (symbol); language/doc-type columns added later; V2 added `journal_entry_id`, `is_legacy`. **Dates are text**, not date.

### `expenses`
PK `id`. `user_id`; `project_id -> projects (set null)`; `category text`; `description`; `amount numeric`; `date text`; `currency` (added by `migration_expense_currency.sql`); V2 added `vendor`, `account_id`, `bank_account_id`, `reference`, `notes`, `journal_entry_id`, `bill_id`, `is_legacy`.

### `team_members`
PK `id`. `user_id`; `name`, `role`, `email`; `rate text` + `rate_type`, `rate_amount`, `rate_currency`; `payment_method`, `payment_currency`, `payment_country`. Children: `team_member_payment_details`, `team_member_rate_history (team_member_id cascade)`.

## 3. Finance V2 tables (created by `20261007215055_finance_v2.sql`)

| Table | Cols | Foreign keys (beyond `user_id -> auth.users`) | Mutability |
|---|---|---|---|
| `finance_settings` | 7 | - | guarded by trigger |
| `chart_accounts` | 11 | - | user-editable (custom accounts) |
| `fx_rates` | 7 | - | user-editable snapshots |
| `journal_entries` | 20 | `journal_entries` (reversal link), `projects` | immutable (trigger + revoked DML) |
| `journal_lines` | 16 | `journal_entries`, `chart_accounts`, `projects` | immutable |
| `finance_audit_log` | 9 | - | append-only |
| `finance_contacts` | 9 | `team_members` | RPC/user |
| `bank_accounts` | 10 | `chart_accounts` | RPC only |
| `bank_reconciliations` | 9 | `bank_accounts` | RPC only |
| `invoice_payments` | 15 | `invoices`, `bank_accounts`, `journal_entries` | RPC only |
| `bills` | 19 | `chart_accounts`, `finance_contacts`, `journal_entries`, `projects`, `team_members` | RPC only |
| `bill_shots` | 4 | `bills`, `shots` | RPC only |
| `bill_payments` | 16 | `bank_accounts`, `bills`, `journal_entries` | RPC only |

All carry `user_id` and an `auth.uid() = user_id` policy (no organization column). Ownership-preserving triggers (`studio_preserve_record_owner`) were added by the multi-user migration.

## 4. Ownership and tenancy map (critical for V3)

```
auth.users ──< studio_memberships >── studio_organizations
    │ (role: master_user | department_admin | staff | freelancer | client)
    └── studio_data_owners (user_id PK -> organization_id)   -- maps a legacy data owner to an org
legacy business data: user_id (the owner) ; shared read via studio_user_has_app_permission('invoices.read'|'expenses.read', ...)
```
Finance V2 ignores everything below the first line. V3 will resolve **organization** from the caller's membership and treat `studio_data_owners` as the bridge for importing each legacy owner's V2 data into that owner's organization. Open item U3: confirm every existing legacy owner has a `studio_data_owners` row.

## 5. Cross-module dependencies on V2 finance objects

* `finance_settle`, `finance_post_entry`, `invoice_payments` <- Paystack apply functions and quote/Wise/manual flow (payments).
* `finance_record_invoice_payment` <- `App.jsx` ("mark as paid").
* `log_shot_payment` <- team/shot payment UI (signature preserved by V2).
* `create_milestone_invoices` <- invoicing (writes `invoices`; V2 guard triggers apply).
* `expenses` and `invoices` rows are read by the dashboard (`DashboardPanel`) and project cards (`projectBudgetSummary()` still uses live FX per `FINANCE_V2.md` section 7).
* Emma/Intelligence, chat and the edge functions do **not** reference finance tables or `finance_*` RPCs (grep over `src/intelligence`, `src/chat`, `supabase/functions`, `intelligence-worker`, excluding tests, found none). Phase 6 therefore adds Emma's finance access from scratch.

## 6. Data-quality hazards for migration

| Hazard | Where | Handling rule for Phase 3 |
|---|---|---|
| Text dates | `invoices.issue_date/due_date`, `expenses.date`, `shots.due` | Parse strictly; unparseable -> migration-failure record, never a guessed date. V2 used a lenient `finance_parse_date` with a fallback date; V3 must not |
| Text money | `projects.budget`, `shots.rate`, `team_members.rate` | Reference only; never the source of a posting |
| Currency symbols | `'$'`, `'KSh'`, `'EUR'`... and default `'$'` | Map only unambiguous symbols; `'$'` is ambiguous (USD/other dollar) - confirm with owner; unknown -> failure record. V2's fallback "unknown text -> USD" must **not** be inherited |
| Superseded invoices | Invoice chain (superseded logic in the app) | Skip superseded members exactly as V2 did; document counts |
| Foreign-currency legacy | No historical rate | Import as `fx_status = missing`, flagged; never 1:1, never today's rate |
| Legacy Cash | Expenses without a paid-from account | Opening "unallocated" account; reconcile later |
| Dual paid state | `invoices.amount_paid` vs `invoice_payments` | Ledger/payments win; legacy column is a cache |
| Duplicate-prone | `bill_shots(shot_id)`, `expenses(shot_id)` | Use as natural idempotency keys |
| Missing animator "work" data | shots have only `assigned_pay/assigned_paid` | Phase 4 introduces work-unit/approval tables; historical shots import as already-approved obligations **only** where `assigned_pay > 0` and evidence of assignment exists |

## 7. What V3 will NOT touch

All tables above. V3 reads them (and only via explicit, read-only import functions in Phase 3), never alters, drops, truncates or backfills them, and never edits historical rows to ease migration (roadmap 1.3).

## 8. Read-only inventory queries for the owner (counts only)

```sql
select 'projects' t, count(*) from projects union all select 'shots', count(*) from shots
union all select 'invoices', count(*) from invoices union all select 'expenses', count(*) from expenses
union all select 'team_members', count(*) from team_members union all select 'journal_entries', count(*) from journal_entries
union all select 'journal_lines', count(*) from journal_lines union all select 'invoice_payments', count(*) from invoice_payments
union all select 'bills', count(*) from bills union all select 'bill_payments', count(*) from bill_payments
union all select 'bank_accounts', count(*) from bank_accounts union all select 'fx_rates', count(*) from fx_rates
union all select 'paystack_transactions', count(*) from paystack_transactions;

select currency, count(*) from invoices group by 1;          -- symbol vs ISO mix
select currency, count(*) from expenses group by 1;
select count(*) filter (where issue_date !~ '^\d{4}-\d{2}-\d{2}$') bad_invoice_dates from invoices;
select count(*) filter (where date !~ '^\d{4}-\d{2}-\d{2}$') bad_expense_dates from expenses;
select count(distinct user_id) legacy_owners from invoices;
select count(*) owners_without_org from (select distinct user_id from invoices union select distinct user_id from expenses) o
  where not exists (select 1 from studio_data_owners d where d.user_id = o.user_id);
```
