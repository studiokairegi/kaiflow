# Finance V3 (source)

Status: **Phase 2 (accounting engine) complete in the database; the JavaScript side is still contracts only.** Nothing here is wired into the running app.
Phase 2 reference: `docs/finance-v3/FINANCE_V3_PHASE2_ENGINE.md`. SQL tests: `supabase/tests/finance_v3/`.
Authoritative design: `docs/finance-v3/FINANCE_V3_MASTER_ARCHITECTURE.md`.

## Rules (enforced by `guards/isolation.test.mjs`)
1. Never import from `src/finance/` (V2), `App.jsx` or `src/payments/`.
2. Nothing outside this folder imports it until Phase 5/6.
3. **No accounting arithmetic in JavaScript.** Money is a decimal string; the database computes.
4. Every write goes through a `public.fin3_*` RPC. No direct table writes from the client.

## Layout and owning phase
| Folder | Purpose | Built in |
|---|---|---|
| `contracts/` | Names, enums, error codes, money conventions (no logic). Phase 2 added permissions, event kinds, RPC names and `phase2-parity.test.mjs` (SQL <-> JS drift guard) | Phase 1, extended in Phase 2 (done) |
| `guards/` | Isolation and V2-intact tests | Phase 1 (done) |
| `api/` | Thin typed wrappers over `fin3_*` RPCs, error mapping | Phase 2-4 (grows per phase) |
| `domain/` | Pure presentation helpers (labels, formatting of decimal strings). No arithmetic | Phase 5 |
| `reporting/` | Client for reporting RPCs, CSV export formatting | Phase 6 |
| `emma/` | Read-only finance context provider for Emma | Phase 6 |
| `migration/` | Legacy V2 -> V3 import tooling (client-side runner/report viewer) | Phase 3 (tooling), Phase 7 (rehearsal) |
| `ui/simple/` | Simple Mode screens | Phase 5 |
| `ui/accountant/` | Accountant Mode screens | Phase 5 |
| `ui/shared/` | Components used by both modes (same figures, same API) | Phase 5 |

## Conventions
* Files: `camelCase.js` / `PascalCase.jsx`; tests `*.test.mjs` beside the code (the repo's `npm test` glob finds them).
* Errors: the API layer converts a Postgres error with SQLSTATE `V3xxx` into `{ code, message }` using `contracts/ERROR_CODES`. UI shows plain language; Accountant Mode also shows the code.
* Amounts: decimal strings matching `MONEY.amountPattern`. Never `Number()` an amount for anything except display via `Intl.NumberFormat` after the database has already rounded it.
