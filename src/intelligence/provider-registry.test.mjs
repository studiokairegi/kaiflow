import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const migration = read("../../supabase/migrations/20261124090000_intelligence_provider_registry_accounts.sql");
const oauth = read("../../supabase/functions/_shared/intel_provider_oauth.ts");
const connect = read("../../supabase/functions/intel-provider-connect/index.ts");
const callback = read("../../supabase/functions/intel-provider-callback/index.ts");
const token = read("../../supabase/functions/intel-provider-token/index.ts");
const registry = read("../../intelligence-worker/kairflow_intel/providers/registry.py");
const main = read("../../intelligence-worker/kairflow_intel/main.py");

test("provider catalogue and accounts are dynamic and support multiple accounts per organization", () => {
  assert.match(migration, /create table if not exists public\.intel_email_provider_registry/);
  assert.match(migration, /create table if not exists public\.intel_provider_accounts/);
  assert.match(migration, /unique \(organization_id, provider_key, mailbox\)/);
  assert.doesNotMatch(migration, /organization_id uuid primary key[^;]*intel_provider_accounts/s);
  assert.match(migration, /daily_send_limit/);
  assert.match(migration, /sending_enabled boolean not null default false/);
  assert.match(migration, /email_provider_enabled\(p_provider text\)/);
  assert.match(migration, /select f\.enabled from public\.email_provider_flags/);
  assert.match(migration, /select r\.sending_enabled from public\.intel_email_provider_registry/);
  assert.match(migration, /health_status/);
  assert.match(migration, /sync_cursor jsonb/);
});

test("credentials and OAuth state are server-only; safe RPCs never return ciphertext", () => {
  assert.match(migration, /credentials_ciphertext text not null/);
  assert.match(migration, /alter table public\.intel_provider_accounts enable row level security/);
  assert.match(migration, /revoke all on public\.intel_provider_accounts from public, anon, authenticated/);
  assert.match(migration, /intel_admin_provider_accounts\(\)/);
  assert.doesNotMatch(migration.match(/create or replace function public\.intel_admin_provider_accounts\(\)[\s\S]*?\$\$;/)?.[0] || "", /credentials_ciphertext|refresh_token/);
});

test("OAuth callback uses short-lived single-use state and stores each Gmail mailbox as its own account", () => {
  assert.match(oauth, /intel_provider_oauth_states/);
  assert.match(oauth, /used_at/);
  assert.match(oauth, /expires_at/);
  assert.match(oauth, /intel_is_authorized_user/);
  assert.match(oauth, /onConflict: "organization_id,provider_key,mailbox"/);
  assert.match(oauth, /is_enabled: false, send_enabled: false/);
  assert.match(connect, /handleProviderConnect/);
  assert.match(callback, /handleProviderCallback/);
});

test("worker token endpoint is agent-only, account-scoped and fails closed until account activation", () => {
  assert.match(oauth, /intel_settings/);
  assert.match(oauth, /agent_user_id/);
  assert.match(oauth, /eq\("id", accountId\)\.eq\("organization_id", settings\.organization_id\)/);
  assert.match(oauth, /!account\.is_enabled \|\| !account\.send_enabled/);
  assert.match(token, /handleProviderToken/);
});

test("worker constructs adapters through the code registry; Resend is not a prospect route", () => {
  assert.match(main, /build_registry\(\)/);
  assert.match(main, /registry\.create\(cfg\.mail_provider/);
  assert.match(registry, /Resend is deliberately absent/);
  assert.doesNotMatch(registry, /provider_key="resend"/);
});
