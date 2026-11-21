# Finance V3 - Phase Roadmap and Inter-Phase Contracts

The authoritative scope for each phase is the owner's "Seven-Phase Ground-Up Rebuild Roadmap". This file does **not** replace it; it adds the *contracts* each phase must honour so the next session can start without guessing. Names below are binding unless the implementing session documents a deviation in its handoff.

## Session protocol (applies to every phase)
1. Read `FINANCE_V3_MASTER_ARCHITECTURE.md` and the previous `docs/finance-v3/PHASE_<n-1>_HANDOFF.md`.
2. Re-inspect the repo; run `node --experimental-strip-types --test src/finance-v3/contracts/contracts.test.mjs src/finance-v3/guards/isolation.test.mjs` first. A failing guard means the previous phase broke an invariant - report it.
3. Implement only the assigned phase. A needed future-phase interface is added as the **minimum contract** and documented.
4. Handoff goes to **`docs/finance-v3/PHASE_<n>_HANDOFF.md`**. (The repo root and `docs/` already contain unrelated `PHASE_1_HANDOFF.md` ... `PHASE_14_HANDOFF.md` from the email/intelligence work. Writing a Finance handoff to either location would overwrite one of them.)
5. Update `docs/finance-v3/v2-baseline.sha256` and the guards only if the phase legitimately changes a guarded artifact, in the same commit, and say so.
6. Never report an unexecuted test as passing.

## Cross-phase invariants (every phase)
* Org-scoped (`organization_id`), RLS on, no client DML, RPC-only writes, audit row per mutation.
* Amounts are decimal strings; `numeric(19,4)`; FX `numeric(20,10)`.
* Errors use `V3xxx` SQLSTATEs from `contracts/ERROR_CODES` (a phase may add codes; add them to the contract and its test).
* Migrations: `<ts>_finance_v3_<topic>.sql`, `<ts> > 20270112100000` (or greater than the newest existing at that time), additive, idempotent, with a rollback script.
* Each phase adds its tests to `npm test` (JS) and `supabase/tests/finance_v3/` (SQL).

---

## Phase 2 - Core accounting engine and database foundation

**Consumes:** this architecture, contracts. **Needs from owner first:** results of audit checks 5.1-5.3, decision on D-01/D-02/D-08, explicit base-currency policy, a disposable PostgreSQL/Supabase for tests.

**Produces (database, schema `finance_v3`):** `org_settings`, `currencies`, `accounts` (+ seeded animation-studio chart), `fx_rates`, `events`, `journal_entries`, `journal_lines`, `audit_log`, `schema_version`, `permissions` mapping.

**RPC contract (public, `authenticated` only):**
| RPC | Purpose |
|---|---|
| `fin3_init_organization(p_org uuid, p_base_currency text)` | Create settings + default chart; idempotent; membership + admin check |
| `fin3_list_accounts(p_org)` / `fin3_upsert_account(p_org, p_account jsonb)` | Chart of accounts (no delete once used) |
| `fin3_set_fx_rate(p_org, p_from, p_to, p_date, p_rate, p_source)` | Append-only rates |
| `fin3_post_journal(p_org, p_key text, p_date, p_memo, p_reference, p_lines jsonb, p_project uuid default null) returns uuid` | Manual/adjustment posting through `post_event` (idempotent) |
| `fin3_reverse_entry(p_org, p_entry uuid, p_key text, p_reason text) returns uuid` | Reversal |
| `fin3_save_draft_entry` / `fin3_post_draft_entry` | Draft lifecycle |
| `fin3_trial_balance(p_org, p_as_of, p_currency)` | Minimum read to prove balancing (full reports are Phase 6) |

`p_lines` element: `{account_id|account_code, side:'debit'|'credit', amount:'1234.5600', currency:'KES', project_id?, memo?}`. Lines are **native**; the DB derives base amounts and FX status.

**Must-pass tests (real PostgreSQL):** balanced post; unbalanced rejected (`V3001`) including when sent via a raw insert attempt; duplicate key returns original; update/delete of posted entry rejected (`V3002`); reversal mirrors original with original base amounts; multi-currency; missing rate -> `fx_status='missing'` and excluded from base trial balance; rounding table (JPY 0dp, KES/USD 2dp, KWD 3dp, half-away-from-zero ties); cross-organization read and write denied (RLS and RPC); anon denied; concurrent posting (N parallel sessions -> gapless unique `entry_no`, all balanced); concurrent identical idempotency keys -> exactly one entry.

**Out of scope:** all domain workflows, UI, import, reports beyond trial balance.

## Phase 3 - Core financial operations

**Consumes:** Phase 2 `post_event`, accounts, FX.

**Produces tables:** `contacts_v3` (customers/suppliers/freelancers link), `receivables` (+ `receivable_lines`, `receipts`), `payables` (+ `bill_lines`, `bill_payments`), `expenses`, `bank_accounts`, `bank_transfers`, `reconciliations` (+ matched/unmatched), `attachments` (receipt metadata; files in storage), `import_*` (mapping, log, failures).

**RPC contract (names fixed, args finalised in the phase):** `fin3_create_invoice`, `fin3_approve_invoice`, `fin3_issue_invoice`, `fin3_record_client_payment(p_org, p_key, p_invoice, p_amount, p_currency, p_bank, p_date, p_ref)`, `fin3_void_invoice`, `fin3_create_bill`, `fin3_approve_bill`, `fin3_record_bill_payment`, `fin3_reverse_bill`, `fin3_record_expense`, `fin3_create_bank_account`, `fin3_record_transfer`, `fin3_reconcile_account` (never changes the ledger), `fin3_list_*` (keyset paginated), `fin3_ar_aging`, `fin3_ap_aging`; importer: `fin3_import_v2_batch(p_org, p_batch jsonb, p_dry_run boolean)`, `fin3_import_report(p_org)`.

**Rules:** invoice states `draft -> approved -> issued -> partially_paid -> paid | void`; overpayment raises `V3012`; payments in an invoice's currency go to an account of that currency (cross-currency receipt is an explicit transfer, as in V2) unless Phase 3 documents an explicit FX-receipt path; every operation is idempotent by key; payment + posting are one transaction.

**Importer rules:** read V2/legacy, write V3 only; strict date/currency parsing (inventory section 6); `(source_table, source_id)` unique -> idempotent; statuses `imported | skipped_duplicate | failed`; dry-run mode; retry only failed; never fabricate; foreign legacy amounts import `fx_status='missing'`. **No production cutover.**

## Phase 4 - Studio financial intelligence and money protection

**Consumes:** Phase 3 payables/receipts/bank accounts.

**Produces tables:** `work_units` (linked to `shots`), `animator_assignments` (rate snapshot), `animator_obligations`, `project_finance` (contract value, budgets), `allocations`, `reserve_policy`, `owner_pay_plans`, `protection_overrides`.

**RPC contract:** `fin3_assign_animator`, `fin3_submit_work`, `fin3_approve_work` (posts obligation), `fin3_pay_animator`, `fin3_project_financials(p_org, p_project)`, `fin3_allocate_funds`, `fin3_set_reserve_policy`, `fin3_reserve_movement`, `fin3_record_owner_payment(kind in salary|draw|contribution|reimbursement|personal_withdrawal)`, `fin3_safe_to_spend(p_org, p_as_of, p_currency) returns jsonb` **(components + warnings, per architecture 4.5)**, `fin3_check_protection(...)`, `fin3_override_protection(...)` (needs `finance.override` + reason).

**Rules:** approval creates a liability, never a cash movement; duplicate approval/payment blocked; unpaid invoices never count as cash; allocations never alter ledger cash; no hardcoded reserve target; blocked actions raise `V3007` from inside the posting path.

## Phase 5 - User interface (Simple + Accountant)

**Consumes:** every `fin3_*` RPC above through `src/finance-v3/api/`. **Produces:** `src/finance-v3/ui/{simple,accountant,shared}`, a Finance V3 route behind a feature flag (`org_settings.engine`/UI flag), mode preference RPC `fin3_get_ui_prefs` / `fin3_set_ui_prefs` (mode only; default `simple`).

**Rules:** Both modes call the same API; Simple Mode figures expose an `explain` payload openable in Accountant Mode; guided confirmations describe the accounting effect in plain language before submit; responsive; loading/error/empty states; pagination; accessible controls; no placeholder buttons. **First point at which V3 may be imported into the app shell** (update the isolation guard #4 accordingly).

## Phase 6 - Reporting, dashboard, Emma, integration

**Produces:** `fin3_report_*` functions (architecture section 8), `fin3_report_integrity`, `fin3_emma_snapshot`, notification feed `fin3_alerts`, export helpers (CSV), dashboard switch to V3 reporting (replacing `useFinanceSummary` for engine=v3 orgs), project/client/shot/stage links.

**Rules:** report totals reconcile to the ledger (tested); the dashboard computes nothing; Emma read-only; exports respect permissions and privacy; existing modules keep working.

## Phase 7 - Final audit, migration rehearsal, hardening, release

**Produces:** no new features. Accounting audit, security audit (explicit negative tests), migration rehearsal on a copy with real comparison of counts/balances, `fin3_settle_payment` re-pointing of Paystack/Wise/manual flows behind the engine flag (D-09), cutover and rollback guides, performance audit, final docs, `PHASE_7_FINAL_HANDOFF.md`. Release requires every acceptance criterion in the owner's roadmap; any criterion that could not be tested must be listed as an explicit limitation.

---

## Dependency map
```
Phase 1 (this) -> Phase 2 engine -> Phase 3 operations -> Phase 4 studio model -> Phase 5 UI -> Phase 6 integration -> Phase 7 release
                         \______ payments re-pointing (D-09) lands in Phase 7 ______/
```
Owner inputs needed before Phase 2: audit checks 5.1-5.3 results; confirmation of D-01, D-02, D-08; base currency decision; a disposable PostgreSQL (or Supabase branch) for tests.
