import { test } from "node:test";
import assert from "node:assert/strict";
import { dashboardTile } from "./dashboardTile.js";
const D = { source: "finance_v3.ledger", currency: "KES", revenue: "3500.00", outstanding_invoices: "1200.00", overdue_invoice_count: 2, animator_obligations: "900.00", safe_to_spend: "0.00", unread_notifications: 3 };
test("dashboard tile passes service figures through as strings", () => { const t = dashboardTile(D); assert.equal(t.value, "KES 3500.00"); assert.equal(t.outstanding, "KES 1200.00"); assert.equal(t.overdueCount, 2); assert.equal(t.unread, 3); });
test("privacy mode hides every money figure", () => { const t = dashboardTile(D, { privacy: true }); for (const k of ["value", "outstanding", "owedToAnimators", "safeToSpend"]) assert.equal(t[k], "••••"); });
test("anything that is not the V3 ledger output yields no tile (caller keeps V2)", () => { assert.equal(dashboardTile(null), null); assert.equal(dashboardTile({ ...D, source: "v2" }), null); assert.equal(dashboardTile("x"), null); });

// Phase 7 (known issue 6): the dashboard bridge must tell a real failure apart from "Finance is not set up yet".
import { loadDashboardV3 } from "./useDashboardV3.js";
test("bridge: a studio that is not set up resolves to null (V2 stays, intended)", async () => {
  const supabase = { rpc: async () => ({ data: null, error: { code: "V3022", message: "Finance has not been set up for this studio yet." } }) };
  assert.equal(await loadDashboardV3(supabase, "org"), null);
});
test("bridge: any other failure is reported as failed, never silently treated as V2", async () => {
  for (const err of [{ code: "XX000", message: "boom" }, { code: "42501", message: "permission denied" }]) {
    const supabase = { rpc: async () => ({ data: null, error: err }) };
    const r = await loadDashboardV3(supabase, "org");
    assert.equal(r?.failed, true, JSON.stringify(err));
    assert.equal(r.tile(), null);
  }
  const throwing = { rpc: async () => { throw new Error("network down"); } };
  assert.equal((await loadDashboardV3(throwing, "org"))?.failed, true);
});
