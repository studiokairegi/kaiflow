// Multi-provider Email, PHASE 2: source-level contract tests for the two new migrations.
// These read the SQL text (no database is available where they run); the behavioural proof is
// supabase/tests/email_provider_foundation.test.sql, which needs PostgreSQL.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const dir = new URL("../../supabase/migrations/", import.meta.url);
const read = (n) => fs.readFileSync(new URL(n, dir), "utf8");
const REG = "20261204090000_email_provider_registry.sql";
const SCOPE = "20261204100000_email_provider_scoping.sql";
const IDEM = "20261206100000_email_provider_idempotency.sql";
const CRM4D = "20261208100000_email_crm_activity.sql";
const CRM4D_FIX = "20261209100000_email_crm_conversation_attribution.sql";
const INBOX4E = "20261211100000_email_inbox_conversation_consistency.sql";
const PHASE4F = "20261212100000_email_inbox_phase4f_counter_repair.sql";
const PHASE4G = "20261213100000_email_accepted_send_reconciliation.sql";
const PHASE5 = "20261214100000_email_mailbox_phase5_foundation.sql";
const PHASE5_FIX = "20261215100000_email_mailbox_lease_and_provider_state.sql";
const ACCESS = "20261216090000_email_independent_access.sql";
const code = (sql) => sql.split("\n").filter((l) => !l.trim().startsWith("--")).map((l) => l.replace(/\s--\s.*$/, "")).join("\n");
const reg = read(REG), scope = read(SCOPE), idem = read(IDEM), regCode = code(reg), scopeCode = code(scope), idemCode = code(idem);

test("Phase 2 migrations sort after every existing migration and are unique", () => {
  const names = fs.readdirSync(dir).filter((n) => n.endsWith(".sql"));
  const others = names.filter((n) => ![REG, SCOPE, IDEM, CRM4D, CRM4D_FIX, INBOX4E, PHASE4F, PHASE4G, PHASE5, PHASE5_FIX, ACCESS, "20261217090000_intelligence_remove_legacy_mailbox.sql", "20261218090000_intelligence_phase8_lock_policy_hotfix.sql"].includes(n)).map((n) => n.split("_")[0]);
  const last = others.sort().at(-1);
  assert.ok(REG.split("_")[0] > last && SCOPE.split("_")[0] > REG.split("_")[0] && IDEM.split("_")[0] > SCOPE.split("_")[0] && CRM4D.split("_")[0] > IDEM.split("_")[0] && CRM4D_FIX.split("_")[0] > CRM4D.split("_")[0] && INBOX4E.split("_")[0] > CRM4D_FIX.split("_")[0] && PHASE4F.split("_")[0] > INBOX4E.split("_")[0] && PHASE4G.split("_")[0] > PHASE4F.split("_")[0] && PHASE5.split("_")[0] > PHASE4G.split("_")[0] && PHASE5_FIX.split("_")[0] > PHASE5.split("_")[0] && ACCESS.split("_")[0] > PHASE5_FIX.split("_")[0], `must follow ${last}`);
  const versions = names.map((n) => n.split("_")[0]);
  assert.equal(versions.filter((v) => v === REG.split("_")[0]).length, 1);
  assert.equal(versions.filter((v) => v === SCOPE.split("_")[0]).length, 1);
  assert.equal(versions.filter((v) => v === IDEM.split("_")[0]).length, 1);
  assert.equal(versions.filter((v) => v === CRM4D.split("_")[0]).length, 1);
  assert.equal(versions.filter((v) => v === CRM4D_FIX.split("_")[0]).length, 1);
  assert.equal(versions.filter((v) => v === INBOX4E.split("_")[0]).length, 1);
  assert.equal(versions.filter((v) => v === PHASE4F.split("_")[0]).length, 1);
  assert.equal(versions.filter((v) => v === PHASE4G.split("_")[0]).length, 1);
  assert.equal(versions.filter((v) => v === PHASE5.split("_")[0]).length, 1);
  assert.equal(versions.filter((v) => v === PHASE5_FIX.split("_")[0]).length, 1);
  assert.equal(versions.filter((v) => v === ACCESS.split("_")[0]).length, 1);
});

test("each migration is one transaction with balanced dollar quoting and a rollback note", () => {
  for (const [name, sql, c] of [[REG, reg, regCode], [SCOPE, scope, scopeCode], [IDEM, idem, idemCode], [INBOX4E, read(INBOX4E), code(read(INBOX4E))], [PHASE4F, read(PHASE4F), code(read(PHASE4F))], [PHASE4G, read(PHASE4G), code(read(PHASE4G))], [PHASE5, read(PHASE5), code(read(PHASE5))], [PHASE5_FIX, read(PHASE5_FIX), code(read(PHASE5_FIX))]]) {
    assert.match(c.trim(), /^begin;/, `${name} begins a transaction`);
    assert.match(c.trim(), /commit;$/, `${name} commits`);
    assert.equal((c.match(/\$\$/g) || []).length % 2, 0, `${name}: unbalanced $$`);
    assert.match(sql, /Rollback/, `${name} documents its rollback`);
    assert.match(sql, /Nothing is sent|Nothing here deletes|does not edit earlier|does not edit those files/i);
  }
});

test("registry: seeds Resend only, never Gmail/Zoho, and never overwrites", () => {
  assert.match(regCode, /create table if not exists public\.email_provider_registry/);
  assert.match(regCode, /values \(\s*'resend', 'resend', 'Resend'/);
  assert.match(regCode, /on conflict \(provider_key\) do nothing/);
  assert.equal(/'gmail'|'zoho'/i.test(regCode), false, "no Gmail/Zoho in executable registry SQL");
  assert.match(regCode, /enable row level security/);
  assert.match(regCode, /revoke all on public\.email_provider_registry from public, anon, authenticated/);
  assert.match(regCode, /grant select on public\.email_provider_registry to authenticated/);
  assert.equal(/grant (insert|update|delete)/i.test(regCode), false, "no client write grants");
  assert.match(regCode, /using \(public\.email_has_access\(\)\)/);
  for (const cap of ["remote_sync", "remote_search", "remote_folders", "oauth"]) assert.match(regCode, new RegExp(`'${cap}', false`), `${cap} is declared false: nothing is promised that is not built`);
});

test("registry: Intelligence-owned flag objects are never written, altered or dropped", () => {
  for (const c of [regCode, scopeCode]) {
    assert.equal(/\b(insert\s+into|update|delete\s+from|alter\s+table|drop\s+table|truncate)\s+(only\s+)?public\.email_provider_flags\b/i.test(c), false);
    assert.equal(/\b(create or replace|drop)\s+function\s+(if exists\s+)?public\.email_provider_enabled\b/i.test(c), false);
    assert.equal(/\bintel_[a-z_]+/i.test(c.replace(/public\.intel_(is_authorized|admin_org)/g, "")), false, "no intel_* object is referenced by executable SQL");
  }
  // the only touch of the flags table is the read that seeds Resend's initial 'enabled'
  assert.match(regCode, /select f\.enabled from public\.email_provider_flags f where f\.provider = 'resend'/);
  assert.match(regCode, /jsonb_object_agg\(provider_key, enabled\) from public\.email_provider_registry/);
});

test("registry: the browser RPCs require access and are not callable by anon", () => {
  for (const fn of ["email_provider_flags_get", "email_provider_registry_list"]) {
    const m = regCode.match(new RegExp(`function public\\.${fn}\\(\\)[\\s\\S]*?end \\$\\$;`));
    assert.ok(m, fn);
    assert.match(m[0], /perform public\.email_require_access\(\)/);
    assert.match(m[0], /security definer set search_path = pg_catalog, public/);
    assert.match(regCode, new RegExp(`revoke all on function public\\.${fn}\\(\\) from public, anon`));
  }
});

test("scoping: provider identity is a registry reference, the Resend-only CHECK goes, nothing is deleted", () => {
  assert.match(scopeCode, /email_accounts_provider_registry_fk[\s\S]*references public\.email_provider_registry\(provider_key\)/);
  assert.match(scopeCode, /email_messages_provider_registry_fk/);
  assert.match(scopeCode, /email_messages_account_provider_fk[\s\S]*foreign key \(account_id, provider\) references public\.email_accounts\(id, provider\)/);
  assert.match(scopeCode, /create unique index if not exists email_accounts_id_provider_uidx on public\.email_accounts\(id, provider\)/);
  assert.match(scopeCode, /like '%provider = ''resend''%'/);
  assert.equal(/\bdelete\s+from\b|\btruncate\b|drop\s+table|drop\s+column/i.test(scopeCode), false, "no data or column is removed");
  assert.match(scopeCode, /not valid/i, "new constraints do not scan or reject legacy rows");
  assert.match(scopeCode, /exception when foreign_key_violation then\s+raise warning/);
});

test("scoping: account uniqueness is per provider and the new index exists BEFORE the old one is dropped", () => {
  const add = scopeCode.indexOf("create unique index if not exists email_accounts_provider_address_uidx on public.email_accounts(organization_id, provider, address)");
  const drop = scopeCode.indexOf("drop index if exists public.email_accounts_address_uidx");
  assert.ok(add > 0 && drop > add);
  assert.match(scopeCode, /on conflict \(organization_id, provider, address\) do update set display_name/);
  assert.equal(/on conflict \(organization_id, address\)/.test(scopeCode), false, "no function may name the retired index");
});

test("scoping: message deduplication is per account; the org-wide indexes are replaced after the narrower ones exist", () => {
  const a = scopeCode.indexOf("email_messages_account_provider_uidx\n  on public.email_messages(account_id, direction, provider_message_id) where provider_message_id is not null");
  const b = scopeCode.indexOf("email_messages_account_rfc_uidx\n  on public.email_messages(account_id, rfc_message_id) where rfc_message_id is not null");
  const dropA = scopeCode.indexOf("drop index if exists public.email_messages_provider_uidx");
  const dropB = scopeCode.indexOf("drop index if exists public.email_messages_rfc_uidx");
  assert.ok(a > 0 && b > 0 && dropA > a && dropB > b);
  assert.equal(/email_messages_idem_uidx/.test(scopeCode.replace(/--.*$/gm, "")), false, "the idempotency index is left alone");
  assert.match(scopeCode, /where account_id = v_acc and \(\(direction = 'inbound' and provider_message_id = v_pmid\) or \(v_rfc is not null and rfc_message_id = v_rfc\)\)/);
  assert.equal(/where organization_id = v_org and \(\(direction/.test(scopeCode), false, "the ingest duplicate check is no longer organisation-wide");
});

test("scoping: ownership is immutable and a message's provider cannot disagree with its account", () => {
  for (const t of ["email_accounts", "email_conversations", "email_messages"]) assert.match(scopeCode, new RegExp(`create trigger ${t}_owner_immutable before update of`));
  assert.match(scopeCode, /create trigger email_messages_provider_from_account before insert on public\.email_messages/);
  assert.match(scopeCode, /raise exception 'A message must use the provider of its account'/);
  assert.match(scopeCode, /alter table public\.email_messages alter column provider drop default/);
  for (const fn of ["_email_message_provider_from_account", "_email_owner_immutable"]) {
    assert.match(scopeCode, new RegExp(`revoke all on function public\\.${fn}\\(\\) from public, anon, authenticated`));
  }
});

test("scoping: email_upsert_account validates the provider against the registry, server-side", () => {
  const m = scopeCode.match(/function public\.email_upsert_account[\s\S]*?end \$\$;/)[0];
  assert.match(m, /public\.email_require_access\(\)/);
  assert.match(m, /from public\.email_provider_registry where provider_key = v_prov and enabled/);
  assert.match(m, /raise exception 'Unknown or disabled email provider'/);
  assert.match(scopeCode, /drop function if exists public\.email_upsert_account\(text, text\)/, "the two-argument overload is dropped so RPC calls are never ambiguous");
  assert.match(scopeCode, /grant execute on function public\.email_upsert_account\(text, text, text\) to authenticated/);
  assert.match(scopeCode, /revoke all on function public\.email_upsert_account\(text, text, text\) from public, anon/);
});

test("scoping: drafts and outbound mail refuse another account's draft or conversation", () => {
  const save = scopeCode.match(/function public\.email_save_draft[\s\S]*?end \$\$;/)[0];
  const out = scopeCode.match(/function public\.email_create_outbound[\s\S]*?end \$\$;/)[0];
  assert.match(save, /raise exception 'This draft belongs to a different sender account'/);
  assert.match(save, /raise exception 'This conversation belongs to a different sender account'/);
  assert.match(out, /raise exception 'This draft belongs to a different sender account'/);
  assert.match(out, /raise exception 'This conversation belongs to a different sender account'/);
  assert.match(save, /public\.email_require_access\(\)/);
  // the idempotent replay still comes first, exactly as in the original function
  assert.ok(out.indexOf("idempotency_key = v_key") < out.indexOf("belongs to a different sender account"));
  assert.match(save, /where id = p_draft_id and organization_id = v_org and status = 'draft' for update/);
  // grants unchanged: create_outbound/ingest are service-role only, save_draft is for the browser
  assert.match(scopeCode, /revoke all on function public\.email_create_outbound\(jsonb\) from public, anon, authenticated;\s*grant execute on function public\.email_create_outbound\(jsonb\) to service_role/);
  assert.match(scopeCode, /revoke all on function public\.email_ingest_inbound\(jsonb\) from public, anon, authenticated;\s*grant execute on function public\.email_ingest_inbound\(jsonb\) to service_role/);
  assert.match(scopeCode, /grant execute on function public\.email_save_draft\(uuid,uuid,uuid,text\[\],text\[\],text\[\],text,text,text\) to authenticated/);
});

test("scoping: inbound ingest keeps every hardening check and the Resend default", () => {
  const m = scopeCode.match(/function public\.email_ingest_inbound[\s\S]*?end \$\$;/)[0];
  const hard = read("20261111090000_email_resend_hardening.sql");
  for (const phrase of ["Invalid inbound payload", "Inbound account does not belong to this organization", "Inbound account is not active",
    "Conversation does not belong to this organization", "Conversation belongs to a different sender address", "exception when unique_violation"]) {
    assert.ok(m.includes(phrase), `kept: ${phrase}`);
    assert.ok(hard.includes(phrase), `and it was in the hardening migration: ${phrase}`);
  }
  assert.match(m, /coalesce\(nullif\(btrim\(coalesce\(p ->> 'provider', ''\)\), ''\), 'resend'\)/);
  assert.match(m, /Inbound account is not a % account/);
});

test("scoping: Intelligence-shared email functions and tables are not redefined", () => {
  for (const fn of ["email_apply_delivery_event", "email_webhook_claim", "email_webhook_finish", "email_replay_delivery_events_for_message", "intel_agent_email_save_draft", "email_provider_enabled", "email_can_access", "email_require_access", "email_has_access"]) {
    assert.equal(new RegExp(`function public\\.${fn}\\b`).test(scopeCode + regCode), false, `${fn} must keep its existing definition`);
  }
  assert.equal(/email_events_provider_uidx/.test(scopeCode + regCode), false, "the email_events unique index is deliberately left as is");
});

test("every security-definer function in the Phase 2 migrations pins its search_path", () => {
  for (const c of [regCode, scopeCode]) {
    const fns = c.split(/create or replace function /).slice(1);
    assert.ok(fns.length > 0);
    for (const f of fns) {
      const head = f.slice(0, f.indexOf("as $$"));
      if (/security definer/.test(head)) assert.match(head, /set search_path = pg_catalog, public/, head.slice(0, 60));
    }
  }
});

test("phase 3: the shared store no longer hardcodes the provider; it takes it from the account row / the adapter", () => {
  const store = fs.readFileSync(new URL("../../supabase/functions/_shared/email_resend_store.ts", import.meta.url), "utf8");
  // Resend-only literals were replaced by parameters (phase 2 handoff, section 7). The only "resend" strings left belong to Intelligence's own provider_key.
  const stripped = store.replace(/\.eq\("provider_key", "resend"\)/g, "").replace(/p_provider_key: "resend"/g, "");
  assert.equal(/"resend"/.test(stripped), false, "no hardcoded Resend provider in the shared store outside the Intelligence routing");
  assert.match(store, /\.eq\("provider", providerKey\)\.eq\("address", base\)/);
  assert.match(store, /select\("id,organization_id,provider,address,display_name,status"\)/);   // phase 4B added organization_id; provider is still read from the row
  assert.match(store, /email_provider_enabled", \{ p_provider: legacyFlagKey \}/);
  assert.match(store, /from\("email_provider_registry"\)/);
  assert.match(store, /service\.rpc\("email_ingest_inbound", \{ p \}\)/);
});

test("composer: the sender cannot be switched on a saved draft or an existing conversation", () => {
  const src = fs.readFileSync(new URL("./components/ComposeDialog.jsx", import.meta.url), "utf8");
  assert.match(src, /disabled=\{Boolean\(draftId \|\| conversationId\)\}/);
});

test("test runner applies both Phase 2 migrations twice and runs the new SQL test", () => {
  const sh = fs.readFileSync(new URL("../../supabase/tests/run_intelligence_auth.sh", import.meta.url), "utf8");
  assert.equal((sh.match(/20261204090000_email_provider_registry\.sql/g) || []).length, 2);
  assert.equal((sh.match(/20261204100000_email_provider_scoping\.sql/g) || []).length, 2);
  assert.match(sh, /email_provider_foundation\.test\.sql/);
  assert.ok(sh.indexOf("20261204100000_email_provider_scoping.sql") > sh.indexOf("20261111090000_email_resend_hardening.sql"));
  assert.ok(fs.existsSync(new URL("../../supabase/tests/email_provider_foundation.test.sql", import.meta.url)));
});


test("idempotency migration binds keys to sender and full submission identity", () => {
  assert.match(idemCode, /add column if not exists request_fingerprint/);
  assert.match(idemCode, /m\.account_id <> v_acc\.id/);
  assert.match(idemCode, /m\.request_fingerprint <> v_fingerprint/);
  assert.match(idemCode, /'attachments', coalesce\(p -> 'attachments'/);
  assert.match(idemCode, /raise exception 'idempotency_key_conflict'/);
});


test("Phase 4F repairs the Phase 4E trigger's undeclared timestamp and recomputes read/order metadata", () => {
  const sql = read(PHASE4F);
  const executable = code(sql);
  assert.match(executable, /v_at\s+timestamptz/i);
  assert.match(executable, /into v_count, v_unread, v_direction, v_snippet, v_at/i);
  assert.match(executable, /update of status, sent_at, received_at, is_read/i);
  assert.match(executable, /E'\\\\s\+'/);
  assert.match(executable, /count\(\*\) filter \(where m\.status <> 'draft' and m\.direction = 'inbound' and not m\.is_read\)/i);
  assert.match(executable, /grant|revoke/i);
  assert.equal(/\bdelete\s+from\b|\btruncate\b|drop\s+table|drop\s+column/i.test(executable), false);
  const sqlTest = fs.readFileSync(new URL("../../supabase/tests/email_phase4f_validation.test.sql", import.meta.url), "utf8");
  for (const assertion of ["outbound acceptance recalculates", "inbound receipt increments unread", "read-state changes recalculate", "delayed provider timestamp reorders"]) assert.ok(sqlTest.includes(assertion));
});


test("Phase 4F SQL runner applies 4C-4G migrations and executes CRM plus Inbox database checks", () => {
  const sh = fs.readFileSync(new URL("../../supabase/tests/run_intelligence_auth.sh", import.meta.url), "utf8");
  for (const migration of ["20261206100000_email_provider_idempotency", "20261208100000_email_crm_activity", "20261209100000_email_crm_conversation_attribution", "20261211100000_email_inbox_conversation_consistency", "20261212100000_email_inbox_phase4f_counter_repair", "20261213100000_email_accepted_send_reconciliation"]) assert.ok(sh.includes(migration), `runner applies ${migration}`);
  assert.match(sh, /for t in email_crm_activity email_phase4f_validation/);
  assert.ok(fs.existsSync(new URL("../../supabase/tests/email_phase4f_validation.test.sql", import.meta.url)));
});


test("Phase 4F accepted-send recovery uses a server-generated Resend tag and validates provider evidence", () => {
  const migration = read(PHASE4G);
  const executable = code(migration);
  assert.match(executable, /create or replace function public\.email_mark_provider_accepted/i);
  assert.match(executable, /create or replace function public\.email_reconcile_tagged_delivery_event/i);
  assert.match(executable, /lower\(btrim\(coalesce\(a\.address/i);
  assert.match(executable, /p_recipients/i);
  assert.match(executable, /email_record_crm_activity/i);
  assert.match(executable, /revoke all on function public\.email_reconcile_tagged_delivery_event/i);
  const adapter = fs.readFileSync(new URL("../../supabase/functions/_shared/email_adapter_resend.ts", import.meta.url), "utf8");
  assert.match(adapter, /name: "kf_message_id", value: o\.correlationId/);
  const logic = fs.readFileSync(new URL("../../supabase/functions/_shared/email_resend_logic.ts", import.meta.url), "utf8");
  assert.match(logic, /correlationId: created\.message_id/);
  assert.match(logic, /reconcileTaggedDeliveryEvent/);
});


test("Phase 5 foundation keeps provider secrets encrypted and sync checkpoint RPCs service-only", () => {
  const sql = code(read(PHASE5));
  assert.match(sql, /create table if not exists public\.email_provider_credentials/);
  assert.match(sql, /create table if not exists public\.email_oauth_states/);
  assert.match(sql, /create or replace function public\.email_claim_sync/);
  assert.match(sql, /create or replace function public\.email_commit_sync_checkpoint/);
  assert.match(sql, /create or replace function public\.email_finish_sync/);
  assert.match(sql, /create or replace function public\.email_ingest_synced_outbound/);
  assert.match(sql, /grant execute on function public\.email_claim_sync\(uuid,integer\) to service_role/);
  assert.match(sql, /revoke all on public\.email_provider_credentials from public, anon, authenticated/);
  assert.equal(/public\.intel_[a-z_]+/i.test(sql), false, "general Email does not depend on Intelligence tables");
});


test("Phase 5 follow-up: leases renew only for the live connected account and provider state is account-scoped", () => {
  const sql = code(read(PHASE5_FIX));
  assert.match(sql, /create or replace function public\.email_renew_sync/);
  assert.match(sql, /s\.lease_token = p_lease_token/);
  assert.match(sql, /s\.lease_expires_at > now\(\)/);
  assert.match(sql, /a\.connection_status = 'connected'/);
  assert.match(sql, /create or replace function public\.email_reconcile_synced_message_state/);
  assert.match(sql, /account_id = p_account_id and organization_id = a\.organization_id/);
  assert.match(sql, /provider_folder_ids/);
  assert.match(sql, /provider_is_deleted/);
  assert.match(sql, /revoke all on function public\.email_reconcile_synced_message_state/);
  assert.match(sql, /grant execute on function public\.email_reconcile_synced_message_state.*to service_role/);
});
