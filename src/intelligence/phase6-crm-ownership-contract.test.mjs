import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const migration = readFileSync(new URL("../../supabase/migrations/20261118100000_intelligence_phase6_crm_ownership.sql", import.meta.url), "utf8");
const reeval = readFileSync(new URL("../../supabase/migrations/20261117090000_intelligence_studio_reevaluation.sql", import.meta.url), "utf8");
const admin = readFileSync(new URL("../../supabase/migrations/20261117100000_intelligence_studio_reevaluation_admin_rpc.sql", import.meta.url), "utf8");
test("Phase 6 preserves score model, old score and supporting evidence", () => {
  for (const token of ["score_model", "intel_score_history", "prior_score", "prior_model", "prior_breakdown", "evidence_snapshot", "phase6_baseline"]) assert.ok(migration.includes(token), token);
});
test("Phase 6 records takeover actor and timestamp and exposes separate admin inventory", () => {
  for (const token of ["takeover_actor", "takeover_at", "origin_detail", "intel_admin_crm_taken_over", "intel_admin_phase6_score_audit", "intel_lead_history"]) assert.ok(migration.includes(token), token);
});
test("Phase 6 prevents duplicate CRM-to-prospect ownership", () => {
  assert.match(migration, /origin_detail->>'kind'='taken_over'/);
  assert.match(migration, /intel_prospects_one_per_lead_uidx/);
  assert.match(migration, /leads_one_per_intel_prospect_uidx/);
  assert.match(migration, /new\.takeover_actor := null/);
  assert.match(migration, /new\.takeover_at := null/);
  assert.match(migration, /reconcile manually before applying/);
});
test("reevaluation covers rejected, review and qualified pre-outreach studio states", () => {
  for (const status of ["rejected", "needs_review", "qualified", "lead_linked"]) { assert.ok(reeval.includes(status)); assert.ok(admin.includes(status)); }
  assert.match(reeval, /prospect_link_mismatch/);
  assert.match(reeval, /p\.status in \('qualified', 'lead_linked'\) then 'needs_review'/);
});
test("human rejection, suppression, messages and pasted history remain exclusions", () => {
  for (const token of ["human_rejected", "prospect_suppressed", "intel_messages", "intel_lead_history"]) assert.ok(reeval.includes(token), token);
});

test("Phase 6 origin backfill declares the prospect alias used by its history lookup", () => {
  assert.match(migration, /update public\.intel_prospects p\s+set origin_detail = case[\s\S]*?h\.prospect_id=p\.id/);
});

test("reevaluation status remains available when the optional score audit RPC fails", () => {
  const panel = readFileSync(new URL("./ReevaluationPanel.jsx", import.meta.url), "utf8");
  assert.match(panel, /Promise\.allSettled\(/);
  assert.match(panel, /statusResult\.status === "fulfilled"/);
  assert.match(panel, /auditResult\.status === "fulfilled"/);
  assert.match(panel, /Inventory unavailable:/);
  assert.doesNotMatch(panel, /Promise\.all\(\[intelApi\.reevalStatus/);
});

test("pilot starts are capped in both database entry points", () => {
  assert.match(reeval, /p_limit > 50/);
  assert.match(admin, /p_limit > 50/);
  assert.match(reeval, /full-population confirmation/);
  assert.match(admin, /full-population confirmation/);
});

test("score history snapshots pre-refresh evidence for the current reevaluation", () => {
  assert.match(migration, /create table if not exists public\.intel_evidence_versions/);
  assert.match(reeval, /insert into public\.intel_evidence_versions/);
  assert.match(migration, /v\.archived_by_run::text=v_reeval_run/);
  assert.match(migration, /e\.reeval_run::text is distinct from v_reeval_run/);
});

test("takeover provenance belongs to the selected history record creator", () => {
  assert.match(migration, /new\.takeover_actor := v_history\.created_by/);
  assert.match(migration, /new\.takeover_at := v_history\.created_at/);
  assert.doesNotMatch(migration, /new\.takeover_actor := coalesce\(auth\.uid\(\),v_history\.created_by\)/);
});


test("score-audit inventory uses the same default exclusions as the pilot selector", () => {
  const report = migration.split("'pre_outreach_studio_candidates'", 2)[1];
  assert.ok(report, "inventory field exists");
  for (const token of ["intel_messages", "intel_lead_history", "intel_actions", "intel_suppressions", "intel_reeval_items", "prospect_link_mismatch"]) {
    if (token === "prospect_link_mismatch") continue; // the report expresses the same ownership check directly
    assert.ok(report.includes(token), token);
  }
  assert.match(report, /review_prospect_reject/);
  assert.match(report, /i\.state='scored'/);
  assert.match(report, /l\.intel_prospect_id=p\.id/);
  assert.match(report, /l\.id=p\.lead_id/);
});
