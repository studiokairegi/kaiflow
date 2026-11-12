import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { criteriaPatch } from "./logic.js";

const migration = readFileSync(new URL("../../supabase/migrations/20261112140000_intelligence_indie_project_qualification_v2.sql", import.meta.url), "utf8");
const scoring = readFileSync(new URL("../../intelligence-worker/kairflow_intel/scoring.py", import.meta.url), "utf8");
const research = readFileSync(new URL("../../intelligence-worker/kairflow_intel/research.py", import.meta.url), "utf8");
const jobs = readFileSync(new URL("../../intelligence-worker/kairflow_intel/jobs.py", import.meta.url), "utf8");
const contactability = readFileSync(new URL("../../intelligence-worker/kairflow_intel/contactability.py", import.meta.url), "utf8");
const modal = readFileSync(new URL("./ProspectModal.jsx", import.meta.url), "utf8");

test("indie campaign criteria are fixed at the V2 75/55 bands", () => {
  const p = criteriaPatch({ keywords: "anime", seedUrls: "", qualifyMin: 10, reviewMin: 5, prospectType: "indie_game_developer" });
  assert.equal(p.qualify_min, 75);
  assert.equal(p.review_min, 55);
});

test("V2 scoring has the exact requested five categories and mandatory gate model", () => {
  for (const [key, points] of Object.entries({ anime_visual_identity: 30, active_development: 25, release_marketing_timing: 25, indie_partnership_opportunity: 10, project_identity_confidence: 10 })) {
    assert.match(scoring, new RegExp(`\\"${key}\\": ${points}`));
  }
  for (const gate of ["project_identity", "active_or_marketing_opportunity", "anime_visual_identity", "verified_usable_email", "suppression_clear", "protected_account_clear", "sufficient_evidence"]) {
    assert.ok(scoring.includes(gate), gate);
  }
  assert.match(scoring, /INDIE_QUALIFY_MIN = 75/);
  assert.match(scoring, /INDIE_REVIEW_MIN = 55/);
  assert.match(scoring, /ANIME_DESCRIPTION_FACT_TYPES/);
  assert.match(migration, /official_anime_style_description/);
});

test("typed project dates and project identity fields remain distinct", () => {
  for (const column of ["project_title", "project_source_url", "project_announcement_date", "project_campaign_date", "project_expected_release_date", "project_actual_release_date", "project_latest_activity_date", "project_marketing_milestones"]) {
    assert.match(migration, new RegExp(`add column if not exists ${column}`));
  }
  assert.match(migration, /_intel_sync_project_facts/);
  assert.match(migration, /_intel_indie_domain/);
  assert.doesNotMatch(migration, /public\.intel_domain_of/);
  assert.match(migration, /create trigger intel_00_sync_project_facts/);
  assert.ok(migration.indexOf("Legacy indie qualification must be re-evaluated") < migration.indexOf("set facts = p.facts"));
});

test("database scoring and manual approval cannot override mandatory gates", () => {
  assert.match(migration, /indie V2 mandatory qualification gates are required/);
  assert.match(migration, /indie V2 qualification requires at least 75 points/);
  assert.match(migration, /indie V2 qualification model version is required/);
  assert.match(migration, /indie V2 mandatory gate failed/);
  assert.match(migration, /contactability must pass before approval/);
  assert.match(migration, /intel_suppressions/);
  assert.match(migration, /intel_enforce_indie_qualification_status/);
  assert.match(migration, /new\.facts #>> '\{verified,contactability,status\}'/);
  assert.match(migration, /_intel_is_protected_indie_entity/);
  assert.match(migration, /intel_block_protected_indie_outbound/);
  assert.match(migration, /verified,unsubscribed/);
  assert.match(migration, /verified,bounced/);
  assert.match(migration, /outbound contact to protected Studio Kairegi account is blocked/);
  assert.match(migration, /outbound contact to suppressed indie developer is blocked/);
  assert.match(migration, /outbound indie prospecting requires V2 score and all mandatory gates/);
  assert.match(migration, /intel_agent_mark_indie_blocked/);
  assert.match(migration, /status = case[\s\S]*p_estimates #>> '\{suppression,suppressed\}'/);
  assert.match(migration, /intel_agent_indie_suppression_facts\(p_email text default '', p_domain text default ''\)/);
  assert.match(migration, /p_estimates #>> '\{suppression,suppressed\}'/);
  assert.match(migration, /cold indie follow-up is blocked for a prospect outside an active qualified state/);
  assert.match(migration, /outbound indie prospecting requires a linked and qualified project/);
  assert.match(migration, /outbound indie contact requires exact-address verified contactability/);
  assert.match(migration, /suppressed indie prospect cannot be requalified/);
  assert.match(migration, /Suppression preserved; prospect remains suppressed/);
  assert.match(migration, /suppressed indie prospect cannot be approved or linked/);
  assert.match(migration, /protected Studio Kairegi account cannot be approved or linked/);
  assert.match(modal, /const canLink = p\.type !== "indie_game_developer" \|\| \(p\.status !== "suppressed" && gatesPass/);
  assert.match(migration, /p_action in \('approve','create_new','use_lead'\)/);
});

test("indie research can start from an official project/store page without a developer website", () => {
  assert.match(jobs, /official project\/store page not found/);
  assert.match(jobs, /intel_agent_mark_indie_blocked/);
  assert.match(jobs, /intel_agent_indie_suppression_facts/);
  assert.match(research, /raw_site = website or project_source/);
});

test("suppression lookup exposes all suppression categories, not only bounce and complaint", () => {
  assert.match(migration, /'suppressed', v_suppressed/);
  assert.match(migration, /intel_agent_indie_suppression_facts/);
  assert.match(migration, /intel_agent_indie_context/);
  assert.match(migration, /'suppression_reason'/);
  assert.match(research, /suppression\.get\("suppressed"\)/);
});

test("personal mailbox pass requires documented affiliation and deliverability", () => {
  assert.match(contactability, /PERSONAL_EMAIL_DOMAINS/);
  assert.match(contactability, /personal_email_affiliation_documented/);
  assert.match(contactability, /affiliation_source_url/);
  assert.match(contactability, /deliverability/);
});

test("prospect modal exposes mandatory gate explanations", () => {
  assert.match(modal, /Mandatory project qualification/);
  assert.match(modal, /mandatory_gates/);
  assert.match(modal, /Evidence \/ reason/);
  assert.match(modal, /disabled=\{busy \|\| !canApprove\}/);
});
