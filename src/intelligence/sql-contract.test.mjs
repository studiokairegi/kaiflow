import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(`../../supabase/migrations/${f}`, import.meta.url), "utf8");
const tables = read("20261108090000_intelligence_core_tables.sql");
const crm = read("20261108100000_intelligence_crm_notifications.sql");
const rpcs = read("20261108110000_intelligence_rpcs.sql");
const zoho = read("20261108120000_intelligence_zoho_oauth.sql");
const strip = (s) => s.replace(/--.*$/gm, "");
const fnBlocks = (sql) => [...strip(sql).matchAll(/create or replace function public\.(\w+)\(([\s\S]*?)\n(?:end|\$\$;)[\s\S]*?\$\$;/g)].map((m) => ({ name: m[1], body: m[0] }));

test("every Intelligence table has row level security and no client write grants", () => {
  const created = [...strip(tables).matchAll(/create table if not exists public\.(intel_\w+)/g)].map((m) => m[1]);
  assert.equal(created.length, 11);
  const rls = strip(tables) + strip(zoho);
  for (const t of created.filter((t) => t !== "intel_mail_account")) assert.ok(strip(tables).includes(`'${t}'`), `${t} is in the RLS loop`);
  assert.match(strip(tables), /revoke all on public\.%I from public, anon, authenticated/);
  assert.match(strip(tables), /grant select on public\.%I to authenticated/);
  assert.ok(!/grant (insert|update|delete|all)[^;]*to (anon|authenticated|public)/i.test(strip(tables)), "no write grants to clients");
  assert.match(strip(tables), /using \(public\.intel_is_authorized\(organization_id\)\)/);
  assert.match(strip(tables), /alter table public\.intel_mail_account enable row level security;\s*revoke all on public\.intel_mail_account from public, anon, authenticated/);
  assert.match(zoho, /alter table public\.intel_oauth_states enable row level security;\s*revoke all/);
  assert.ok(rls.length > 0);
});

test("hard limits are enforced by the schema itself", () => {
  assert.match(tables, /daily_initial_cap int not null default 30 check \(daily_initial_cap between 0 and 30\)/);
  assert.match(tables, /kill_switch boolean not null default true/);
  assert.match(tables, /autonomy text not null default 'shadow'/);
  assert.match(tables, /intel_messages_one_initial_per_prospect_uidx/); assert.match(tables, /intel_messages_one_initial_per_email_uidx/);
  assert.match(tables, /intel_actions is append-only/);
});

test("every admin RPC authorizes first; every agent RPC proves it is the agent", () => {
  const fns = fnBlocks(rpcs);
  const admin = fns.filter((f) => f.name.startsWith("intel_admin_")), agent = fns.filter((f) => f.name.startsWith("intel_agent_"));
  assert.ok(admin.length >= 17 && agent.length >= 25, `found ${admin.length} admin and ${agent.length} agent functions`);
  for (const f of admin) assert.match(f.body, /public\.intel_admin_org\(\)/, f.name);
  for (const f of agent) assert.match(f.body, /public\.intel_agent_org\(\)/, f.name);
  for (const f of [...admin, ...agent]) assert.match(f.body, /security definer set search_path = pg_catalog, public/, f.name);
  const orgFn = fnBlocks(rpcs).find((f) => f.name === "intel_admin_org");
  assert.match(orgFn.body, /perform public\.intel_require_authorized\(\)/);
});

test("the agent cannot delete leads or reach other modules, and cannot promote itself", () => {
  const code = strip(rpcs);
  assert.ok(!/delete from public\.leads/i.test(code));
  for (const t of ["user_settings", "studio_memberships", "payments", "finance", "projects"]) assert.ok(!new RegExp(`(update|insert into|delete from) public\\.${t}\\b`, "i").test(code), t);
  const reg = fnBlocks(rpcs).find((f) => f.name === "intel_admin_register_agent").body;
  assert.match(reg, /is_admin is true/); assert.match(reg, /studio_memberships/);
  assert.match(code, /grant execute on function %s to authenticated/);
  assert.match(code, /revoke all on function %s from public, anon/);
});

test("AI attribution can be set only by the agent function and never changed afterwards", () => {
  const c = strip(crm);
  assert.match(c, /new\.source_kind := old\.source_kind;\s*new\.intel_prospect_id := old\.intel_prospect_id;\s*new\.created_by := old\.created_by;/);
  assert.match(c, /can only be set by KairFlow Intelligence/);
  assert.match(strip(rpcs), /set_config\('intel\.agent_write', 'on', true\)/);
  assert.match(c, /source_kind text not null default 'manual'/);
  assert.ok(!/update public\.leads set (source_kind|created_by|intel_prospect_id)/i.test(strip(rpcs)));
});

test("sending is gated inside the database: kill switch, suppression, caps, compliance, follow-up rules", () => {
  const f = fnBlocks(rpcs).find((x) => x.name === "intel_agent_reserve_send").body;
  for (const needle of ["s.kill_switch", "intel_suppressions", "'daily_cap'", "'followup_cap'", "'followup_not_due'", "'missing_compliance_footer'", "'already_contacted'", "'prospect_replied'", "max_followups", "for update"]) assert.ok(f.includes(needle), needle);
  const draft = fnBlocks(rpcs).find((x) => x.name === "intel_agent_upsert_draft").body;
  assert.match(draft, /'recipient_not_allowed'/);
});

test("notifications are de-duplicated by a unique key and reuse activity_log", () => {
  assert.match(strip(crm), /create unique index if not exists activity_log_intel_dedupe_uidx/);
  assert.match(strip(crm), /on conflict \(user_id, event_type, \(\(meta ->> 'intelDedupeKey'\)\)\) where meta \? 'intelDedupeKey' do nothing/);
  assert.ok(!/create table[^;]*notification/i.test(strip(tables) + strip(crm) + strip(rpcs)), "no second notification table");
  for (const ev of ["intel_positive_reply", "intel_meeting_request", "intel_pricing_inquiry", "intel_rejection", "intel_unsubscribe", "intel_bounce"]) assert.ok(rpcs.includes(ev), ev);
});

test("Zoho callback re-checks the starter and the function is service-role only", () => {
  assert.match(strip(zoho), /revoke all on function public\.intel_is_authorized_user\(uuid, uuid\) from public, anon, authenticated/);
  assert.match(strip(zoho), /grant execute on function public\.intel_is_authorized_user\(uuid, uuid\) to service_role/);
});
