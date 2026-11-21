# Finance V3 - Phase 1 Handoff

Phase: 1 of 7 (forensic audit, root-cause investigation, V3 architecture foundation). Date: 2026-11-21.
Location note: this file is in `docs/finance-v3/` on purpose. The repo root and `docs/` already contain unrelated `PHASE_1_HANDOFF.md` ... `PHASE_14_HANDOFF.md` from email/intelligence work. Finance handoffs go in `docs/finance-v3/`.

## 1. Phase summary
Audited Finance V2 statically, inventoried financial data, wrote the V3 architecture and per-phase contracts, and created the V3 source foundation plus guard tests. **No database objects, no migrations, no UI, and no wiring into the app were created.** No existing file was modified.

Headline: **a single root cause for "V2 stopped working" is NOT confirmed.** No symptom was supplied and the live Supabase database was not accessible. Confirmed structural defects and unverified items are listed in `FINANCE_V3_ROOT_CAUSE_AUDIT.md`.

## 2. Repository state
New files (18 + this handoff):
* `docs/finance-v3/`: `FINANCE_V3_MASTER_ARCHITECTURE.md`, `FINANCE_V3_ROOT_CAUSE_AUDIT.md`, `FINANCE_V3_DATA_INVENTORY.md`, `FINANCE_V3_PHASE_ROADMAP.md`, `v2-baseline.sha256`, `PHASE_1_HANDOFF.md`
* `src/finance-v3/`: `README.md`, `contracts/index.js`, `contracts/contracts.test.mjs`, `guards/isolation.test.mjs`, and a README in each of `api/ domain/ reporting/ emma/ migration/ ui/simple/ ui/accountant/ ui/shared/`
* `supabase/tests/finance_v3/README.md`

Modified existing files: none (byte comparison against the uploaded zip: 4,203 original files, 0 modified, 0 missing; `.git/index` differs only because git commands were run).
Deleted: none.

## 3. Database state
New migrations: none. New tables/columns/functions/RPCs/RLS changes: none. Migration execution: none. Live database: not accessed.

## 4. Testing
| Test | Command | Result |
|---|---|---|
| V3 contracts + isolation guards | `node --experimental-strip-types --test src/finance-v3/contracts/contracts.test.mjs src/finance-v3/guards/isolation.test.mjs` | 12 run, **12 passed**, 0 failed |
| Guard negative check (bad V3 migration, V3 importing V2, tampered V2 file) | manual injection, then restored | 3 guards failed as intended; after restore 6/6 passed; restored file hash matches baseline |
| Finance V2 JS tests | `node --experimental-strip-types --test src/finance/finance.test.mjs src/finance/regression.test.mjs` | 31 run, **31 passed** |
| Full existing suite, before changes | `node --experimental-strip-types --test` | 1,361 run, 1,356 passed, **5 failed** |
| Full suite, after changes | same | 1,373 run, 1,368 passed, **same 5 failed** |
| RPC name/argument cross-check | ad-hoc script (not committed) | 19/19 names exist; 21 call sites, 0 real mismatches |
| `npm run build` | - | **NOT RUN**: supplied `node_modules` lacks vite/react/recharts; no network |
| Any PostgreSQL/Supabase test (`finance_v2_tests.sql`, `supabase/tests/*.sql`) | - | **NOT RUN**: no PostgreSQL available |

Pre-existing failures (all outside Finance, causes not investigated): `compose from a lead opens a modal over the pipeline...`; `rollback script restores the old functions and removes every column the migration added`; `every tool the assistant can propose has a label and an implementation`; `SQL and Python agree on exactly which chat tools exist`; file-level failure of `src/intelligence/duplicates.parity.test.mjs`.

## 5. Known issues / unknowns
* Root cause of the owner's current V2 symptom unknown (audit section 5 checks pending).
* Live schema state, whether V2 SQL ever ran in production, org mapping for every legacy owner, row counts, and `fx_status='missing'` volume are unknown (U1-U7 in the audit).
* Build status of the app is unverified in this session.
* 5 pre-existing failing tests.
* The owner's roadmap text is not stored in the repo; attach it to each session.
* Isolation guard #4 ("nothing outside V3 imports V3") must be relaxed deliberately in Phase 5/6.

## 6. Compatibility
No existing source, migration or config file changed, so runtime behaviour of KairFlow is unchanged by this session. V2 is intact and hash-pinned (24 files in `v2-baseline.sha256`). Build not verified here.

## 7. Next phase (Phase 2) instructions
**Do not start until the owner supplies:** results of the read-only checks in audit section 5 (at minimum 5.1-5.3), confirmation of decisions D-01, D-02, D-08, the base-currency policy, a description of the actual V2 failure, and a disposable PostgreSQL/Supabase environment (Phase 2 cannot be accepted without real PostgreSQL test output).
Then: read `FINANCE_V3_MASTER_ARCHITECTURE.md` and `FINANCE_V3_PHASE_ROADMAP.md` (Phase 2 contract), run the two V3 test files first, create `supabase/migrations/<ts>_finance_v3_<topic>.sql` with `<ts> > 20270112100000`, schema `finance_v3`, RPCs `fin3_*`, errors `V3xxx`, tests in `supabase/tests/finance_v3/`, handoff at `docs/finance-v3/PHASE_2_HANDOFF.md`. Do not build domain workflows, UI, import or reports.

## 8. Repository integrity
* Complete repository included in `KairFlow_Finance_V3_Phase_1.zip`, including `.git` history.
* Excluded on purpose: `.env`, `paystack-live.env.txt` (both gitignored; the latter appears to hold a live Paystack secret key - rotating it is advisable because it was uploaded to a chat), `node_modules` (the upload's copy was partial and unusable for building), `dist/` (gitignored build output), `__pycache__`, `.pytest_cache`. Run `npm install` after unzipping.
* `.env.example` and all setup docs retained. No secrets added (guard test scans V3 paths; scan of the repo found only obvious test fixtures).
* No unrelated modules touched. Build status: not run (see section 4).
