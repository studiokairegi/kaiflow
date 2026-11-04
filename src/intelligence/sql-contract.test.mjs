import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(`../../supabase/migrations/${f}`, import.meta.url), "utf8");
const tables = read("20261109100000_intelligence_core_tables.sql");
const crm = read("20261109110000_intelligence_crm_notifications.sql");
const rpcs = read("20261109120000_intelligence_rpcs.sql");
const zoho = read("20261109130000_intelligence_zoho_oauth.sql");
const disc = read("20261109170000_intelligence_discovery.sql");
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
  assert.match(tables, /send_start_hour int not null default 8/); assert.match(tables, /check \(send_start_hour < send_end_hour\)/);
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
  for (const needle of ["s.kill_switch", "'outside_send_hours'", "intel_suppressions", "'daily_cap'", "'followup_cap'", "'followup_not_due'", "'missing_compliance_footer'", "'already_contacted'", "'prospect_replied'", "max_followups", "for update"]) assert.ok(f.includes(needle), needle);
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

test("discovery: new tables are locked down and sources need confirmed terms before they can run", () => {
  const c = strip(disc);
  for (const t of ["intel_sources", "intel_source_items", "intel_entity_aliases"]) assert.ok(c.includes(`'${t}'`), t);
  assert.match(c, /revoke all on public\.%I from public, anon, authenticated/); assert.match(c, /using \(public\.intel_is_authorized\(organization_id\)\)/);
  assert.match(c, /tos_status text not null default 'unverified'/); assert.match(c, /enabled boolean not null default false/);
  assert.match(c, /Confirm the source''s terms before enabling it/);
  const agentSources = fnBlocks(disc).find((f) => f.name === "intel_agent_sources").body;
  assert.match(agentSources, /enabled and tos_status = 'confirmed'/); assert.match(agentSources, /circuit_open_until/); assert.match(agentSources, /used_today < daily_budget/);
  const rows = [...c.matchAll(/\(p_org, '(\w+)',[^\n]*?,\s*(true|false),\s*'(confirmed|unverified)'/g)].map((m) => ({ key: m[1], enabled: m[2] === "true", status: m[3] }));
  assert.equal(rows.length, 9, "all nine sources are seeded");
  for (const r of rows) if (r.status === "unverified") assert.equal(r.enabled, false, `${r.key} starts OFF until its terms are confirmed`);
  assert.deepEqual(rows.filter((r) => r.status === "confirmed").map((r) => r.key).sort(), ["rss", "site_crawler", "wikidata", "x_manual"]);
});

test("discovery: every admin function authorizes first and every agent function proves it is the agent", () => {
  const fns = fnBlocks(disc);
  const admin = fns.filter((f) => f.name.startsWith("intel_admin_")), agent = fns.filter((f) => f.name.startsWith("intel_agent_"));
  assert.ok(admin.length >= 5 && agent.length >= 9, `${admin.length} admin, ${agent.length} agent`);
  for (const f of admin) assert.match(f.body, /public\.intel_admin_org\(\)/, f.name);
  for (const f of agent) assert.match(f.body, /public\.intel_agent_org\(\)/, f.name);
  for (const f of [...admin, ...agent]) assert.match(f.body, /security definer set search_path = pg_catalog, public/, f.name);
  const code = strip(disc);
  assert.ok(!/delete from public\.(leads|intel_prospects)/i.test(code)); assert.ok(!/update public\.leads/i.test(code));
});

test("discovery: the model's proposed terms can never overwrite approved ones or approve themselves", () => {
  const f = fnBlocks(disc).find((x) => x.name === "intel_agent_propose_terms").body;
  assert.match(f, /if coalesce\(\(prof ->> 'approved'\)::boolean, false\) then return; end if;/);
  assert.ok(!/'approved', true/.test(f));
  const setp = fnBlocks(disc).find((x) => x.name === "intel_admin_set_profile").body;
  assert.match(setp, /'approved', false/);                                    // any edit un-approves
});

test("discovery: job kinds in the database match the worker's handlers", () => {
  const kinds = [...strip(disc).matchAll(/'(\w+)'/g)].map((m) => m[1]);
  for (const k of ["seed_sources", "analyze_site", "news_scan", "feed_poll", "crawl_index", "manual_post", "profile_terms"]) assert.ok(kinds.includes(k), k);
});
