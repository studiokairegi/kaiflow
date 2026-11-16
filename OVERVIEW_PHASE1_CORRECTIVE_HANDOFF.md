# Intelligence → Overview — Corrective Pass (2026-11-12)

Scope: the five confirmed findings from the Overview audit. No migrations, RLS, RPCs, send gates, autonomy or AI routing were touched. No deployment or real email occurred.

Note on IDs: the audit's findings table and its technical-evidence section number OV-03/OV-04 differently. This report uses the table: OV-04 = sending status, OV-05 = partial discovery.

## Fixes
| ID | Fix | File |
|---|---|---|
| OV-01 | `refresh` now only bumps `tick`; both `useLoad` hooks (and every tab) reload once from that. Previously it called `ov.reload()`, `mail.reload()` and bumped `tick`, so each ran twice. | `IntelligenceModule.jsx` |
| OV-02 | `attentionItems` now alerts on `failed_jobs` (warn). | `logic.js` |
| OV-03 | `attentionItems` now alerts on `expired_leases` (warn). Order: unverified sends, dead jobs (bad); expired leases, failed jobs, approvals, needs-review (warn). | `logic.js` |
| OV-04 | New `sendingReadiness(o, mail)`. Kill switch ON keeps the old OFF wording. Kill switch off now shows "ON and no sending blockers are showing" (green) only when mail is connected, the worker is online and daily limits are not both exhausted; otherwise a warn banner lists the reasons. Shadow mode adds "every email still waits for your approval". It never claims delivery is guaranteed. | `logic.js`, `OverviewView.jsx` |
| OV-05 | New `queueDiscovery`: each campaign type is attempted independently, and the UI reports what queued and what failed. After a partial failure the button becomes "Retry failed" and re-queues only the failed type, so nothing is double-queued. | `logic.js`, `OverviewView.jsx` |

## Tests
New `src/intelligence/overview-corrective.test.mjs` (5 tests): refresh single-path, alert coverage/order, readiness states (stopped / ready / blocked by mail, check failure, loading, accounts, worker offline or never seen, both caps reached, shadow note), discovery partial success/failure and retry-only-failed, and a wiring check that the view uses the helpers.

| Check | Result |
|---|---|
| `npm test` (before changes) | 1123 passed, 0 failed |
| `npm test` (after changes) | **1128 passed, 0 failed** |
| Python worker suite (before, unchanged code) | 817 passed |
| TypeScript syntax diagnostics on the two edited .jsx files | no errors |

## Not verified
- `npm run build`: no `node_modules`/Vite in the archive.
- No browser/manual UI test, no live Supabase.
- Readiness is derived from data the Overview already has (mail status, heartbeat, daily counters). It does not see provider-level restrictions the RPC does not expose. If you want server-authoritative readiness, a small RPC change would be needed (not done).
- OV-05 is client-side orchestration. The enqueue RPC is idempotent per minute, but a single atomic "enqueue both" RPC would need a migration (not done).

## Files changed
`src/intelligence/IntelligenceModule.jsx`, `src/intelligence/OverviewView.jsx`, `src/intelligence/logic.js`, `src/intelligence/overview-corrective.test.mjs` (new), this report.
