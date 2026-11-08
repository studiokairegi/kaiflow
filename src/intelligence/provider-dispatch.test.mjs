import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../../supabase/migrations/20261125090000_intelligence_multi_account_dispatch.sql", import.meta.url), "utf8");
const mailops = readFileSync(new URL("../../intelligence-worker/kairflow_intel/mailops.py", import.meta.url), "utf8");
const router = readFileSync(new URL("../../intelligence-worker/kairflow_intel/providers/router.py", import.meta.url), "utf8");
const hardening = readFileSync(new URL("../../supabase/migrations/20261126090000_intelligence_provider_gate_owner_only.sql", import.meta.url), "utf8");

test("prospecting sends require explicit active, evidenced consent for the exact recipient", () => {
  assert.match(migration, /create table if not exists public\.intel_contact_permissions/);
  assert.match(migration, /cp\.email=public\.intel_norm_email\(m\.to_email\)/);
  assert.match(migration, /cp\.purpose=v_purpose and cp\.status='granted' and cp\.revoked_at is null/);
  assert.match(migration, /'prospecting_consent_required'/);
});

test("account selection enforces provider gates, purpose allowlist, and row-locked quota limits", () => {
  assert.match(migration, /limit 1 for update of pa skip locked/);
  assert.match(migration, /pr\.sending_enabled/);
  assert.match(migration, /v_purpose = any\(pa\.allowed_message_purposes\)/);
  assert.match(migration, /daily_send_limit/);
  assert.match(migration, /hourly_send_limit/);
  assert.match(migration, /minute_send_limit/);
  assert.match(migration, /insert into public\.intel_provider_account_usage/);
});

test("message assignment is persisted and adapter code resolves from that durable assignment", () => {
  assert.match(mailops, /intel_agent_assign_provider_account/);
  assert.match(mailops, /provider = zoho\.for_message\(m\)/);
  assert.match(router, /self\.registry\.create\(provider_key[\s\S]*account_id=str\(account_id\)/);
});

test("permission and quota ledgers are service-only and the global provider gate is owner-controlled", () => {
  assert.match(migration, /alter table public\.intel_contact_permissions enable row level security/);
  assert.match(migration, /revoke all on public\.intel_contact_permissions from public,anon,authenticated/);
  assert.match(migration, /alter table public\.intel_provider_account_usage enable row level security/);
  assert.match(migration, /revoke all on public\.intel_provider_account_usage from public,anon,authenticated/);
  assert.match(hardening, /drop function if exists public\.intel_admin_set_provider_sending_enabled\(text,boolean\)/);
  assert.doesNotMatch(hardening, /grant execute[^;]*to authenticated/i);
});

test("final mark_sending rechecks the assigned account and provider gates beside the kill switch", () => {
  const finalGuard = migration.split("create or replace function public.intel_agent_mark_sending")[1];
  assert.match(finalGuard, /if s\.kill_switch then/);
  assert.match(finalGuard, /m\.provider_account_id is not null and not exists/);
  assert.match(finalGuard, /a\.is_enabled and a\.send_enabled and r\.enabled and r\.sending_enabled/);
  assert.match(finalGuard, /set state='sending'/);
});


test("Phase 2.8.1 enforces provider purpose intersection and human-approved Zoho outreach", () => {
  const migration = readFileSync(new URL("../../supabase/migrations/20261126093000_intelligence_provider_policy_human_review.sql", import.meta.url), "utf8");
  assert.match(migration, /coalesce\(pr\.manifest->'message_purposes',[\s\S]*?\? v_purpose/);
  assert.match(migration, /m\.provider_key='zoho' or \(m\.provider_key is null and exists\(select 1 from public\.intel_mail_account/);
  assert.match(migration, /m\.kind in \('initial','followup'\) and m\.auto_sent/);
  assert.match(migration, /Zoho outreach requires explicit human approval/);
  assert.match(migration, /zoho_human_approval_required/);
  const assignment = migration.split("create or replace function public.intel_agent_mark_sending")[0];
  const zohoHold = assignment.indexOf("zoho_human_approval_required");
  const usageInsert = assignment.indexOf("insert into public.intel_provider_account_usage");
  assert.ok(zohoHold > 0 && usageInsert > zohoHold, "Zoho auto-approved outreach is held before consuming account quota");
  assert.match(migration, /insert into public\.intel_jobs\(organization_id,kind,payload,priority,idempotency_key\)/);
  assert.match(migration, /set state='approved',auto_sent=false/);
});

test("router rejects partial provider assignments instead of using legacy fallback", () => {
  assert.match(router, /if account_id is None and provider_key is None/);
  assert.match(router, /incomplete provider account assignment; refusing legacy fallback/);
});


test("Phase 2.8.2 rejects partial or cross-provider durable account assignments at the database boundary", () => {
  const integrity = readFileSync(new URL("../../supabase/migrations/20261126100000_intelligence_provider_assignment_integrity.sql", import.meta.url), "utf8");
  assert.match(integrity, /\(new\.provider_account_id is null\) <> \(new\.provider_key is null\)/);
  assert.match(integrity, /a\.organization_id = new\.organization_id/);
  assert.match(integrity, /a\.provider_key = new\.provider_key/);
  assert.match(integrity, /before insert or update on public\.intel_messages/i);
});
