// Phase 6: static checks that the migrations, rollbacks, JS contracts and the Emma worker agree.
// BEHAVIOUR is proven against a real PostgreSQL by supabase/tests/finance_v3/phase6.test.sql (run.sh).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as c from "./index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const MIG = path.join(ROOT, "supabase/migrations"), RB = path.join(ROOT, "supabase/rollback");
const read = (p) => fs.readFileSync(p, "utf8");
const strip = (t) => t.replace(/--.*$/gm, "");
const files = fs.readdirSync(MIG).filter((f) => f.includes("finance_v3") && f.slice(0, 14) >= "20270117000000" && f.slice(0, 14) < "20270118000000").sort();   // Phase 6 only; Phase 7 has its own guard (phase7-guards.test.mjs)
const sql = strip(read(path.join(MIG, files[0]))), emma = strip(read(path.join(MIG, files[1])));
const rb = (f) => strip(read(path.join(RB, f.replace(/\.sql$/, ".rollback.sql"))));

test("Phase 6 ships two transactional migrations, each with a rollback", () => {
  assert.deepEqual(files.map((f) => f.replace(/^\d+_finance_v3_/, "")), ["reporting_alerts.sql", "emma_read.sql"]);
  for (const [f, t] of [[files[0], sql], [files[1], emma]]) { assert.match(t, /^begin;/m); assert.match(t, /^commit;/m); const r = rb(f); assert.match(r, /^begin;/m); assert.match(r, /^commit;/m); }
  assert.match(rb(files[0]), /Rollback refused/); assert.match(rb(files[0]), /rollback_discard_settings/);
});
test("new public fin3_ RPCs equal PHASE6_RPCS and fin3svc_ equal PHASE6_SERVICE_RPCS; none is a repeat", () => {
  const pub = [...new Set([...sql.matchAll(/create or replace function public\.(fin3_[a-z_0-9]+)\(/g)].map((m) => m[1]))].sort();
  assert.deepEqual(pub, [...c.PHASE6_RPCS].sort());
  const svc = [...new Set([...sql.matchAll(/create or replace function public\.(fin3svc_[a-z_0-9]+)\(/g)].map((m) => m[1]))].sort();
  assert.deepEqual(svc, [...c.PHASE6_SERVICE_RPCS].sort());
  for (const n of c.PHASE6_RPCS) for (const old of [c.PHASE2_RPCS, c.PHASE3_RPCS, c.PHASE4_RPCS, c.PHASE5_RPCS]) assert.ok(!old.includes(n), `${n} is new`);
});
test("every function the rollback drops is one the migration created, and every created one is dropped", () => {
  const made = [...sql.matchAll(/create or replace function ((?:public|finance_v3)\.[a-z_0-9]+)\(/g)].map((m) => m[1]);
  const dropped = [...rb(files[0]).matchAll(/drop function if exists ((?:public|finance_v3)\.[a-z_0-9]+)\(/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(made)].sort(), [...new Set(dropped)].sort());
  for (const t of ["notifications", "notification_reads", "alert_settings", "record_links", "scheduler_runs", "scheduler_config"]) assert.match(rb(files[0]), new RegExp(`drop table if exists finance_v3\\.${t}\\b`));
});
test("only five Phase 6 RPCs write, each exactly one kind of record; every other one is STABLE", () => {
  const writers = ["fin3_set_alert_settings", "fin3_mark_notifications_read", "fin3_set_record_link", "fin3_export_rows"];
  for (const n of c.PHASE6_RPCS) {
    const m = sql.match(new RegExp(`function public\\.${n}\\([\\s\\S]*?\\bas \\$\\$`)); assert.ok(m, n);
    if (writers.includes(n)) assert.match(m[0], /\bvolatile\b/, `${n} writes`); else assert.match(m[0], /\bstable\b/, `${n} is stable`);
  }
});
test("no Phase 6 SQL touches V2 tables or the app's project / shot tables", () => {
  assert.doesNotMatch(sql, /\b(public\.)?(projects|shots|activity_log|notification_state)\b\s*(\(|set|where|values)/i);
  assert.doesNotMatch(sql, /(insert into|update|delete from|alter table|create table)\s+public\./i);
  assert.doesNotMatch(emma, /(insert into|update|delete from)\s+finance_v3\.(?!schema_version)/i);
});
test("Emma's function writes exactly one Intelligence row (its tool trace) and no other table", () => {
  const body = emma.match(/create or replace function public\.intel_agent_finance_read[\s\S]*?end \$\$;/)[0];
  const writes = [...body.matchAll(/\b(insert into|update|delete from)\s+([a-z_.]+)/gi)].map((m) => `${m[1].toLowerCase()} ${m[2]}`);
  assert.deepEqual(writes, ["insert into public.intel_chat_messages"]);
});
test("every new table has RLS on and no direct grant to any app role", () => {
  for (const t of ["notifications", "notification_reads", "alert_settings", "record_links", "scheduler_config", "scheduler_runs"]) assert.match(sql, new RegExp(`'${t}'`));
  assert.match(sql, /enable row level security/); assert.match(sql, /revoke all on finance_v3\.%I from public, anon, authenticated, service_role/);
  assert.doesNotMatch(sql, /grant\s+(select|insert|update|delete|all)[^;]*on\s+finance_v3\./i); assert.doesNotMatch(sql, /create\s+policy/i);
});
test("the privilege footer is present", () => {
  assert.match(sql, /revoke all on function %s from public, anon, service_role/); assert.match(sql, /grant execute on function %s to authenticated/);
  assert.match(sql, /grant execute on function finance_v3\.has_permission\(uuid, text\) to authenticated/);
});
test("no floating point in the Phase 6 SQL", () => { assert.doesNotMatch(sql, /\b(double precision|float[48]?|real)\b/i); });
test("client reminders and automatic receipts default to OFF", () => {
  assert.match(sql, /reminders_enabled\s+boolean not null default false/); assert.match(sql, /auto_receipts\s+boolean not null default false/);
});
test("Emma's database function is read-only and answers only the finance_insights tool", () => {
  assert.match(emma, /p_tool is distinct from 'finance_insights'/); assert.match(emma, /has_permission_for\(t\.user_id, v_org, 'finance\.read'\)/);
  assert.match(emma, /intel_is_authorized_user\(t\.user_id, v_org\)/); assert.equal(c.EMMA_FINANCE_TOOL, "finance_insights"); assert.equal(c.PHASE6_EMMA_RPC, "intel_agent_finance_read");
  assert.match(rb(files[1]), /drop function if exists public\.intel_agent_finance_read/);
});
test("the Emma worker routes the finance tool to that function and offers no finance write tool", () => {
  const chat = read(path.join(ROOT, "intelligence-worker/kairflow_intel/chat.py"));
  assert.match(chat, /finance_insights/); assert.match(chat, /intel_agent_finance_read/);
  assert.doesNotMatch(chat, /finance_(pay|send|issue|record|approve|refund|post)\w*/i);
});
