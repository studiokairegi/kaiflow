import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("Phase 10 schema alignment is additive and checks registry prerequisites", () => {
  const sql = read("../../supabase/migrations/20261130100000_intelligence_phase10_schema_provider_alignment.sql");
  assert.match(sql, /to_regclass\('public\.intel_provider_accounts'\)/);
  assert.match(sql, /add column if not exists display_name/);
  assert.match(sql, /add column if not exists last_health_check_at/);
  assert.match(sql, /create or replace function public\.intel_admin_mail_status\(\)/);
  assert.match(sql, /source_of_truth', 'intel_provider_accounts'/);
  assert.match(sql, /source_of_truth', 'legacy_migration_bridge'/);
  assert.match(sql, /begin;/i); assert.match(sql, /commit;/i);
});

test("kill-switch release requires an enabled dynamic Gmail, Zoho or SMTP account", () => {
  const sql = read("../../supabase/migrations/20261130100000_intelligence_phase10_schema_provider_alignment.sql");
  const fn = sql.slice(sql.indexOf("create or replace function public.intel_admin_set_kill_switch"));
  assert.match(fn, /intel_provider_accounts/);
  assert.match(fn, /intel_email_provider_registry/);
  assert.match(fn, /a\.provider_key in \('gmail','zoho','smtp'\)/);
  assert.match(fn, /a\.status = 'connected' and a\.is_enabled and a\.send_enabled/);
  assert.match(fn, /r\.enabled and r\.sending_enabled/);
  assert.doesNotMatch(fn, /intel_mail_account/);
});

test("Resend inbound and transactional webhook logic share the documented secret", () => {
  const inbound = read("../../supabase/functions/intel-resend-webhook/index.ts");
  const shared = read("../../supabase/functions/_shared/email_resend_logic.ts");
  assert.match(inbound, /Deno\.env\.get\("RESEND_WEBHOOK_SECRET"\)/);
  assert.match(shared, /d\.env\("RESEND_WEBHOOK_SECRET"\)/);
  assert.doesNotMatch(inbound, /INTEL_RESEND_WEBHOOK_SECRET/);
  assert.doesNotMatch(shared, /INTEL_RESEND_WEBHOOK_SECRET/);
});

test("Resend is not in the prospect provider registry; dynamic router rejects partial assignments", () => {
  const migration = read("../../supabase/migrations/20261124090000_intelligence_provider_registry_accounts.sql");
  const router = read("../../intelligence-worker/kairflow_intel/providers/router.py");
  assert.match(migration, /Resend is intentionally excluded from the prospect communication catalogue/);
  assert.match(router, /incomplete provider account assignment; refusing legacy fallback/);
});


test("Phase 10 Settings exposes only the dynamic provider-account connection UI", () => {
  const ui = read("./SettingsView.jsx");
  assert.match(ui, /<ProviderAccountsCard/);
  assert.doesNotMatch(ui, /<AccessCard/);
  assert.doesNotMatch(ui, /Set KAIRFLOW_MAIL_PROVIDER/);
  assert.doesNotMatch(ui, /There is one mailbox per studio/);
});

test("Phase 10 migration rejects missing provider identity columns before additive repair", () => {
  const sql = read("../../supabase/migrations/20261130100000_intelligence_phase10_schema_provider_alignment.sql");
  assert.match(sql, /pg_attribute/);
  assert.match(sql, /intel_provider_accounts','organization_id/);
  assert.match(sql, /intel_provider_accounts','provider_key/);
  assert.match(sql, /intel_email_provider_registry','sending_enabled/);
  assert.match(sql, /Restore the canonical Phase 2 provider-registry schema first/);
});


test("Phase 10 status separates mailbox connection from sending eligibility", () => {
  const sql = read("../../supabase/migrations/20261130100000_intelligence_phase10_schema_provider_alignment.sql");
  assert.match(sql, /sending_eligible/);
  assert.match(sql, /provider_gate_enabled/);
  assert.match(sql, /provider_gate_sending_enabled/);
  assert.match(sql, /coalesce\(\(a\.status = 'connected' and a\.is_enabled and a\.send_enabled/);
  assert.match(sql, /r\.enabled and r\.sending_enabled/);
});

test("Phase 10 schema guard checks incompatible existing column types", () => {
  const sql = read("../../supabase/migrations/20261130100000_intelligence_phase10_schema_provider_alignment.sql");
  assert.match(sql, /format_type\(a\.atttypid, a\.atttypmod\) <> expected\.expected_type/);
  assert.match(sql, /incompatible provider-registry column types/);
});

test("Phase 10 synchronizes legacy OAuth account changes into registry without enabling sending", () => {
  const sql = read("../../supabase/migrations/20261130110000_intelligence_phase10_legacy_account_sync.sql");
  assert.match(sql, /after insert or update or delete on public\.intel_mail_account/);
  assert.match(sql, /insert into public\.intel_provider_accounts/);
  assert.match(sql, /credentials_ciphertext/);
  assert.match(sql, /false, false/);
  assert.match(sql, /is_enabled and send_enabled intentionally stay at their existing values/);
  assert.match(sql, /on conflict \(organization_id, provider_key, mailbox\) do update/);
});
