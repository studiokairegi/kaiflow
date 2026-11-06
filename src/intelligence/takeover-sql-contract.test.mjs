import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../../supabase/migrations/20261116090000_intelligence_crm_takeover.sql", import.meta.url), "utf8");
const code = sql.replace(/--.*$/gm, "");
const fn = (name) => {
  const m = code.match(new RegExp(`create or replace function public\\.${name}\\(([\\s\\S]*?)\\n(?:end|end;) ?\\$\\$;`));
  assert.ok(m, `${name} is defined`);
  return m[0];
};

test("the pasted-conversation table is private to the authorized administrator and written only through functions", () => {
  assert.match(code, /create table if not exists public\.intel_lead_history/);
  assert.match(code, /alter table public\.intel_lead_history enable row level security/);
  assert.match(code, /revoke all on public\.intel_lead_history from public, anon, authenticated/);
  assert.match(code, /grant select on public\.intel_lead_history to authenticated/);
  assert.match(code, /using \(public\.intel_is_authorized\(organization_id\)\)/);
  assert.ok(!/grant (insert|update|delete|all)[^;]*intel_lead_history/i.test(code));
});

test("admin functions authorize first, agent functions prove they are the agent, all are security definer with a fixed search path", () => {
  for (const n of ["intel_admin_crm_import_history", "intel_admin_crm_remove_history", "intel_admin_crm_takeover_refresh", "intel_admin_crm_introduce"]) {
    const b = fn(n);
    assert.match(b, /v_org uuid := public\.intel_admin_org\(\)/, n);
    assert.match(b, /security definer set search_path = pg_catalog, public/, n);
  }
  const a = fn("intel_agent_takeover_result");
  assert.match(a, /public\.intel_agent_org\(\)/);
  assert.match(a, /security definer set search_path = pg_catalog, public/);
  assert.match(code, /revoke all on function public\._intel_lead_email_gate\(uuid, text\) from public, anon, authenticated/);
});

test("importing a conversation never sends: it stores, replans and queues a worker job", () => {
  const b = fn("intel_admin_crm_import_history");
  assert.ok(!/state = 'approved'|state = 'sending'|reserve_send|confirm_send/.test(b.replace(/'approved'\)/g, "")), "no approval or send");
  assert.match(b, /insert into public\.intel_jobs\(organization_id, kind, payload, priority, idempotency_key\)\s*values \(v_org, 'takeover'/);
  assert.match(b, /set state = 'discarded'[\s\S]*?state in \('draft', 'pending_approval', 'approved'\)/);
  assert.match(b, /bucket'\) in \('do_not_contact', 'no_email'\) then raise exception/);
  assert.match(b, /v_to = '' or position\('@' in v_to\) < 2 then/);
  assert.match(b, /origin = 'crm_existing'/);
  assert.match(b, /direction'?\)? ?(not in|<>)|not in \('outbound', 'inbound'\)/);
});

test("the email rule runs when a draft is created and again when a send is reserved", () => {
  assert.match(fn("_intel_lead_email_gate"), /'lead_has_no_email'[\s\S]*'lead_email_mismatch'/);
  const draft = fn("intel_agent_upsert_draft");
  assert.match(draft, /_intel_lead_email_gate\(p\.lead_id, case when p_kind in \('initial','followup'\) then v_to else null end\)/);
  assert.match(draft, /p\.lead_id is null and p_kind in \('initial','followup'\) then return public\._intel_deny\('no_crm_lead'\)/);
  assert.match(draft, /when p\.origin = 'crm_existing' then 'pending_approval'/);
  const send = fn("intel_agent_reserve_send");
  const gate = send.indexOf("_intel_lead_email_gate(m.lead_id");
  const reserve = send.indexOf("set state = 'reserved'");
  assert.ok(gate > 0 && reserve > gate, "gate comes before the message is reserved");
  assert.match(send, /error = 'CRM email check failed: ' \|\| v_gate/);
  assert.match(send, /m\.kind in \('initial','followup'\) and m\.lead_id is null then/);
});

test("follow-up candidates need a matching CRM email and send pasted conversations to take-over", () => {
  const c = fn("intel_agent_followup_candidates");
  assert.match(c, /join public\.leads l on l\.id = p\.lead_id/);
  assert.match(c, /position\('@' in public\.intel_norm_email\(l\.email\)\) > 1/);
  assert.match(c, /intel_norm_email\(l\.email\) = public\.intel_norm_email\(p\.contact_email\)/);
  assert.match(c, /as takeover/);
  assert.match(c, /not exists \(select 1 from public\.intel_messages f where f\.prospect_id = p\.id and f\.kind = 'followup'/);
});

test("the worker analysis can suppress an address only for an unsubscribe or a complaint", () => {
  const b = fn("intel_agent_takeover_result");
  assert.match(b, /p_suppress not in \('unsubscribe', 'complaint'\)/);
  assert.match(b, /insert into public\.intel_suppressions/);
  assert.ok(!/delete from/i.test(b));
});

test("introductions are drafted only for never-contacted leads with an email, and need approval", () => {
  const b = fn("intel_admin_crm_introduce");
  assert.match(b, /bucket'\) <> 'not_contacted'/);
  assert.match(b, /_intel_lead_email_gate\(l\.id, null\) is not null/);
  assert.match(b, /'lead_linked'[\s\S]*'crm_existing'/);
  assert.match(b, /array_length\(v_ids, 1\) > 25/);
});

test("job kinds keep the union of earlier migrations and add takeover", () => {
  const kinds = ["discover", "research", "qualify", "resolve", "draft", "send", "sync_mail", "classify", "reconcile", "followup_scan", "retention", "chat",
    "seed_sources", "analyze_site", "news_scan", "feed_poll", "crawl_index", "manual_post", "profile_terms", "takeover"];
  for (const k of kinds) assert.ok(code.includes(`'${k}'`), k);
});

test("every new function is granted explicitly", () => {
  for (const sig of ["intel_admin_crm_import_history\\(uuid, text, jsonb, text, date, text\\)", "intel_admin_crm_remove_history\\(uuid\\)", "intel_admin_crm_takeover_refresh\\(uuid\\)",
    "intel_admin_crm_introduce\\(uuid\\[\\], text\\)", "intel_agent_takeover_result\\(uuid, jsonb, text, text\\)"]) {
    assert.match(code, new RegExp(`revoke all on function public\\.${sig} from public, anon`), sig);
    assert.match(code, new RegExp(`grant execute on function public\\.${sig} to authenticated`), sig);
  }
});
