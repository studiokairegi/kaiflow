// App dashboard bridge (loaded on demand by App.jsx only when Finance V3 is switched on). The Finance figures come from the
// authoritative reporting service (fin3_dashboard), not from browser-side sums.
// A studio whose Finance V3 books are simply not set up yet resolves to null (the caller keeps V2, as intended).
// ANY OTHER failure resolves to { failed: true } so the app can SAY that V3 could not be loaded, instead of silently showing V2 numbers
// that look like V3 (Phase 6 known issue 6, closed in Phase 7).
import { dashboardTile } from "./dashboardTile.js";
import { createFinanceApi } from "../api/phase6.js";

export { dashboardTile };
export async function loadDashboardV3(supabase, orgId) {
  try {
    const d = await createFinanceApi((n, a) => supabase.rpc(n, a)).dashboard(orgId);
    return dashboardTile(d) ? { raw: d, tile: (o) => dashboardTile(d, o) } : null;
  } catch (e) {
    const text = `${e?.code ?? ""} ${e?.message ?? ""}`;
    return /V3022|has not been set up/i.test(text) ? null : { failed: true, tile: () => null };
  }
}
