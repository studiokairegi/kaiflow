import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../../supabase/migrations/20261217090000_intelligence_remove_legacy_mailbox.sql", import.meta.url), "utf8");
const code = sql.replace(/^\s*--.*$/gm, "");

test("legacy mailbox removal backfills and verifies the registry before dropping anything", () => {
  assert.ok(code.indexOf("insert into public.intel_provider_accounts") < code.indexOf("drop table if exists public.intel_mail_account"));
  assert.match(code, /Refusing to drop legacy mailbox table/);
  assert.match(code, /on conflict \(organization_id, provider_key, mailbox\) do nothing/);
});

test("legacy trigger, sync function, cursor RPC and tables are dropped", () => {
  for (const re of [/drop trigger if exists intel_legacy_mail_account_registry_sync/, /drop function if exists public\.intel_sync_legacy_mail_account_to_registry\(\)/,
    /drop function if exists public\.intel_agent_sync_state\(jsonb\)/, /drop table if exists public\.intel_oauth_states/, /drop table if exists public\.intel_mail_account/]) assert.match(code, re);
});

test("replacement RPCs are registry-only and keep their grants", () => {
  const body = code.slice(code.indexOf("create or replace function public.intel_admin_mail_status"));
  const defs = body.slice(0, body.indexOf("drop function if exists public.intel_agent_sync_state"));
  assert.ok(!/intel_mail_account|v_legacy|legacy_migration_bridge/.test(defs));
  assert.match(defs, /grant execute on function public\.intel_admin_mail_status\(\) to authenticated/);
  assert.match(defs, /grant execute on function public\.intel_admin_disconnect_mail\(\) to authenticated/);
  assert.match(defs, /grant execute on function public\.intel_agent_assign_provider_account\(uuid\) to authenticated/);
  assert.match(defs, /no_eligible_provider_account/);
});

test("the migration does not change safety settings or provider gates", () => {
  assert.doesNotMatch(code, /kill_switch\s*=\s*false/);
  assert.doesNotMatch(code, /autonomy/);
  assert.doesNotMatch(code, /update public\.intel_email_provider_registry/);
  assert.doesNotMatch(code, /send_enabled\s*=\s*true/);
});
