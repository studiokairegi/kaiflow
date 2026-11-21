# Finance V3 - Phase 1 Root-Cause Audit of Finance V2

Date of audit: 2026-11-21. Scope: the repository supplied as `00_repo__36_.zip` (git HEAD `9100078`, working tree with uncommitted changes).

## 0. Read this first

**A single root cause for "Finance V2 stopped working" cannot be confirmed from the repository.** No error message, screenshot or symptom description was supplied with the roadmap, and this session had no access to the live Supabase project, no PostgreSQL, no network, and a `node_modules` that lacks React and Vite (see section 2). Everything below is therefore labelled:

* **CONFIRMED (code)** - read directly from the supplied source; reproducible by anyone with the repo.
* **CONFIRMED (executed)** - a command was actually run here and its output observed.
* **STATIC (database)** - read from SQL files; the live database was not queried.
* **UNVERIFIED** - could not be established here. Each has a one-step check for the owner in section 5.

No root cause has been invented. The most useful single thing the owner can do is tell the next session **exactly what "stopped working" looks like** (blank Finance tab? an error banner? a specific action failing?) and run the section 5 checks.

## 1. Summary of findings

| # | Finding | Label | Severity for V3 design |
|---|---|---|---|
| F1 | V2 is scoped **only** by `user_id = auth.uid()`; there is no organization concept anywhere in the 1,817-line V2 migration. The app was later made multi-user/multi-organization, and `App.jsx` explicitly filters Finance to records the logged-in user owns. Finance was left as a single-owner island. | CONFIRMED (code) | Critical - drives V3 tenancy model |
| F2 | `finance_init()` creates a *separate* settings row + chart of accounts for **every user who opens Finance**. A second team member opening Finance gets a second, empty ledger instead of the studio's. | CONFIRMED (code) | Critical |
| F3 | The Paystack / Wise / manual checkout code (`supabase/migrations/20261018...` to `20261026...`) writes directly into V2 objects (`finance_settle`, `finance_post_entry`, `invoice_payments`). V2 cannot be retired without re-pointing payments. | CONFIRMED (code) | High - cutover blocker |
| F4 | V2 attaches guard/bridge triggers to the legacy `invoices` and `expenses` tables. Behaviour of existing tables was changed (saved-invoice edits rejected, deletes blocked). Any code path that edits `amount_paid`/status directly is rejected at the database. | CONFIRMED (code) | High - V3 must avoid bridge-trigger coupling |
| F5 | The V2 SQL has **never been recorded as executed** by its own authors (`FINANCE_V2.md` section 6: "SQL migration and RPCs: NOT EXECUTED"). `finance_v2_tests.sql` exists at repo root; no recorded run output exists anywhere in the repo. The payments test harness (`supabase/tests/run.sh`) applies the V2 migration to a scratch database, but no result log is present. | CONFIRMED (code) | High |
| F6 | A real, previous V2 runtime failure is documented in the repo: the balance-check trigger wrapper needed `SECURITY DEFINER` (`20261012190000_finance_balance_trigger_security.sql`: "Fix Finance V2 balance-trigger permission errors"). The fix is present in both copies of the V2 migration and in the follow-up migration. Whether the **live** database has the fixed function is unknown. | CONFIRMED (code) / UNVERIFIED (live) | Medium |
| F7 | Migration housekeeping is unsafe for adding new migrations: files are timestamped up to `20270112100000` (future relative to 2026-11-21), and 11 migration names appear twice under two different timestamps (e.g. `intelligence_phase2_fixes`). Root-level `migration_*.sql` files are a second, manual deployment path with unknown applied state. | CONFIRMED (code) | High - V3 migration naming rule (D-12) |
| F8 | Money is stored as `text` in several legacy places (`projects.budget`, `shots.rate`, `invoices.issue_date`, `invoices.due_date`, `expenses.date`) and currency as a *symbol* (`'$'`, `'KSh'`). V2 maps symbols to ISO codes with a fallback of **USD for unknown text** (`finance_ccy_code`). | CONFIRMED (code) | High - migration data-quality risk |
| F9 | The prior V2 FX policy (flag missing rates, never 1:1) is sound and matches the V3 requirement; but historical foreign-currency legacy amounts have **no** historical rate, so they are `fx_status='missing'` by design. | CONFIRMED (code) | Informational |
| F10 | Client-side report computation: the whole ledger is loaded into the browser (`loadLedger`) and reduced in JavaScript (`reports.js`, 467 lines). Amounts are JS numbers (`num(f.amount)` is sent to RPCs). | CONFIRMED (code) | Medium - V3 moves aggregation into the database |
| F11 | A dual source of truth exists for settled amounts: `invoices.amount_paid` / `status` (legacy columns) vs `invoice_payments` + ledger. V2 mitigates with guard triggers. | CONFIRMED (code) | Medium |

Positive findings (things that are **not** broken, verified so V3 does not "fix" them needlessly):

* **All 19 distinct RPCs the client calls exist in SQL, and all 21 call sites use parameter names that match the SQL signatures** (script-checked; the single flagged mismatch was a false positive of the checker - `finance_save_bill(p jsonb)` is called with `{ p: ... }`). Wrong RPC names/signatures are **not** the cause of a failure. (CONFIRMED, executed.)
* Internal `finance_*` functions are revoked from `public/anon/authenticated`; only the 17 client RPCs are granted to `authenticated`. No function created after V2 re-opens this (only `finance_check_balance_trigger` is re-created, and it is a trigger function). (STATIC.)
* The ledger tables have RLS with `select` for the owner and `insert/update/delete` revoked from clients; the V2 immutability guards exist as triggers. (STATIC.)
* The V2 JavaScript tests pass: 31/31 in `src/finance/` (CONFIRMED, executed - section 2).

## 2. What was actually executed in this session

| Check | Command | Result |
|---|---|---|
| Finance V2 JS tests | `node --experimental-strip-types --test src/finance/finance.test.mjs src/finance/regression.test.mjs` | 31 tests, 31 pass, 0 fail |
| Full existing JS suite (baseline) | `node --experimental-strip-types --test` | 1,361 tests: **1,356 pass, 5 fail**, 0 skipped. Failures are all outside Finance: `compose from a lead opens a modal...` (CRM), `rollback script restores the old functions...` (contract language), `every tool the assistant can propose has a label and an implementation` and `SQL and Python agree on exactly which chat tools exist` (Emma chat tools), and the file-level failure of `src/intelligence/duplicates.parity.test.mjs`. **Causes not investigated** (out of Phase 1 scope); they pre-exist this session because no existing source file was modified. |
| RPC name + argument cross-check | ad-hoc Python script (not committed) over `src/finance/*`, `src/App.jsx`, `supabase/migrations/20261007215055_finance_v2.sql` | 19/19 names defined; 21 call sites checked; 0 real mismatches |
| Duplicate V2 migration copies | `diff --strip-trailing-cr` | Root `migration_finance_v2.sql` (CRLF) and `supabase/migrations/20261007215055_finance_v2.sql` (LF) are identical except line endings |
| **Not executable here** | `npm run build` | **NOT RUN.** The supplied `node_modules` contains only `supabase`, `@supabase`, `jose`, `nanoid` and a few helpers - **no `vite`, `react` or `recharts`** - and there is no network. A prebuilt `dist/` is in the upload but it is gitignored and was not rebuilt, so it is not evidence of current buildability. |
| **Not executable here** | Any PostgreSQL / Supabase test (`finance_v2_tests.sql`, `supabase/tests/*.sql`) | **NOT RUN.** No PostgreSQL binary is available. |

## 3. Detail on the main findings

### F1 / F2 - single-owner ledger inside a multi-user app (most likely structural cause of "wrong or empty Finance")

* V2 tables: `finance_settings.user_id` is the primary key; `chart_accounts`, `journal_entries`, `journal_lines`, `bank_accounts`, `bills`, `invoice_payments`, ... all carry `user_id` with `auth.uid() = user_id` policies. Zero references to `organization`, `studio_*` or membership tables (grep over the V2 migration returns nothing).
* `20261030090000_studio_multiuser_core.sql` adds organizations/roles and shared *read* policies for `invoices` and `expenses` only, and states in a comment that finance ledger/payment writes "remain under existing Finance/payment RPC and RLS rules until those paths are explicitly migrated". The same migration lists the V2 ledger tables as "remain own-only in this release".
* `src/App.jsx` (the `FinanceModule` mount, around line 6711) passes only projects/invoices/expenses whose owner is the current user, with the comment "keep shared records out of its calculations until cross-owner read-only Finance is designed".
* `finance_init()` -> `finance_init_user(auth.uid())` seeds a chart of accounts per user.

Effect: for an organization with a Master User plus Finance staff, each person sees a different ledger and the studio has no single financial truth. For a lone owner this is invisible, so it is not necessarily what the owner is currently experiencing. **V3 must key everything to the organization, not the user** (Master Architecture D-02).

### F3 - payments coupling

`finance_settle(p_user uuid, p_kind text, p_doc uuid, ...)` and `finance_post_entry(p_user uuid, ...)` are called by the Paystack apply function (`20261018090000`, `20261025090000`) and the quote/Wise/manual flow (`20261026090000`). They post to V2's per-user ledger and insert `invoice_payments`. V3 cutover (Phase 7) must either re-point these functions to a V3 posting API or run V2 and V3 side-by-side. The Master Architecture records this as D-09.

### F4 - bridge triggers on legacy tables

`trg_finance_invoice_guard` (BEFORE UPDATE on `invoices`) and the after-insert/after-update/before-delete trigger family on `invoices` and `expenses` mean ordinary application writes now have accounting side effects and can fail with finance errors. V3 will not install triggers on legacy tables (D-07); it ingests events explicitly.

### F5 - never-verified SQL

`FINANCE_V2.md` section 6 says the SQL was only statically checked. The SQL is 1,817 lines with 54 `SECURITY DEFINER` functions. Without a recorded PostgreSQL run, "V2 passed its tests" can only mean "V2's JavaScript reference model passed its JavaScript tests" - which is exactly the trap the roadmap warns about ("do not assume that the old code is correct merely because it previously passed JavaScript tests"). Note the V2 design intentionally keeps `src/finance/ledger.js` as a *second* implementation of the posting rules ("if a posting rule changes, change both"). That is a standing risk of divergence; V3 has one implementation, in the database.

### F7 - migration ordering

The Supabase CLI applies migrations in timestamp order and refuses (or requires `--include-all`) when a local migration sorts before the last remote-applied one. Because existing files run to `20270112100000`, **any new migration timestamped with today's real date would sort in the middle of existing history**. V3 migrations must therefore be timestamped **after** `20270112100000` (guard test enforces this) and must be named `<timestamp>_finance_v3_<topic>.sql`.

Duplicate-named migrations (the same name under two timestamps) are almost certainly the same change re-issued; whether both are recorded as applied in production is unknown. This does not involve Finance but affects how safely any V3 migration can be pushed.

## 4. Failure-origin matrix (roadmap 1.A list)

| Possible origin (from roadmap) | Verdict |
|---|---|
| Frontend rendering | No defect found by reading; 31 JS tests pass. Not exercised in a browser here. **UNVERIFIED** |
| Missing database objects | Cannot tell without querying the live DB. Check 5.1. **UNVERIFIED** |
| Incorrect RPC signatures | **Ruled out statically** (names and argument keys match). |
| SQL migration failures | Possible; never recorded as run (F5). Check 5.1-5.2. **UNVERIFIED** |
| RLS restrictions | **Structural mismatch confirmed** (F1/F2): user-scoped RLS vs multi-user app. Whether it is the *current* failure is unknown. |
| Authentication changes | `finance_require_user()` relies on `auth.uid()`; the multi-user/bootstrap migrations did not change that. No defect found. |
| Broken relationships | FKs reference `auth.users`, `projects`, `invoices`, `shots`, `team_members`; ownership-preserving triggers were added. No defect found statically. **UNVERIFIED live** |
| Wrong assumptions about schema | Legacy money/date columns are `text` (F8). Real risk for migration; not a runtime failure by itself. |
| Data inconsistency | Possible (F11, F8). Needs live data. **UNVERIFIED** |
| Application integration | F3, F4 are integration hazards. |
| Other | Dual deployment paths and migration timestamps (F7). |

## 5. Checks the owner should run (read-only SQL, Supabase SQL editor)

Do not paste results containing client names or amounts into shared channels; counts and booleans are enough.

1. **Are the V2 objects present?**
   ```sql
   select to_regclass('public.journal_entries') is not null as has_journal,
          to_regprocedure('public.finance_init()') is not null as has_init,
          (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='public' and p.proname like 'finance\_%') as finance_fn_count;  -- repo defines 56 distinct names
   ```
2. **Is the fixed balance trigger live?**
   ```sql
   select prosecdef from pg_proc where proname='finance_check_balance_trigger';  -- expect true
   ```
3. **Which migrations does production think it has?**
   ```sql
   select version from supabase_migrations.schema_migrations order by version desc limit 15;
   ```
4. **Does the failing user have a ledger of their own?**
   ```sql
   select user_id, base_currency from finance_settings;   -- one row per user who opened Finance
   select user_id, count(*) from journal_entries group by 1;
   ```
5. **Do the legacy rows reconcile with the ledger?** (counts only)
   ```sql
   select (select count(*) from invoices) invoices, (select count(*) from invoice_payments) payments,
          (select count(*) from expenses) expenses, (select count(*) from journal_entries) entries,
          (select count(*) from journal_entries where fx_status='missing') missing_fx;
   ```
6. **Browser:** open Finance with the developer console open; copy the first red error (the hook logs `Finance load failed:` with the Supabase error).

## 6. Unknowns carried into later phases

U1 live schema state; U2 whether V2 SQL ever executed in production; U3 whether every existing user has an organization (`studio_data_owners` mapping); U4 volume of legacy rows; U5 whether any `fx_status='missing'` rows exist; U6 whether any code path other than the Finance RPCs edits `invoices.amount_paid` (references exist in `src/App.jsx`, `src/finance/Purchases.jsx` and `src/payments/logic.js`; their runtime behaviour against the guard triggers was not exercised); U7 the 5 pre-existing failing tests.

## 7. Conclusion

Finance V2 is not provably broken by anything in the code that was read, and it is provably *architecturally unsuited* to the multi-user, multi-organization application it now lives in, and un-verified at the SQL level. That is sufficient justification for the V3 ground-up plan, but it is **not** a diagnosis of the owner's current symptom. Phase 2 must not begin its migrations before the owner confirms checks 5.1-5.3, because they decide whether V2 SQL is even installed in production.
