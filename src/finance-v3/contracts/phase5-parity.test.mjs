// Phase 5: static checks that the UI-services migration, its rollback, the JS contracts and the client API agree.
// BEHAVIOUR is proven against a real PostgreSQL by supabase/tests/finance_v3/phase5.test.sql (run.sh).
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
const files = fs.readdirSync(MIG).filter((f) => f.includes("finance_v3") && f.slice(0, 14) >= "20270116000000" && f.slice(0, 14) < "20270117000000").sort();
const f5 = files[0]; const sql = strip(read(path.join(MIG, f5))); const rb = strip(read(path.join(RB, f5.replace(/\.sql$/, ".rollback.sql"))));

test("Phase 5 ships exactly one transactional migration with a data-safe rollback", () => {
  assert.deepEqual(files.map((f) => f.replace(/^\d+_finance_v3_/, "")), ["ui_services.sql"]);
  assert.match(sql, /^begin;/m); assert.match(sql, /^commit;/m); assert.match(rb, /^begin;/m); assert.match(rb, /^commit;/m);
  assert.match(rb, /rollback_discard_settings/); assert.match(rb, /Rollback refused/);
});
test("new public RPCs equal PHASE5_RPCS; the one redefined Phase 3 RPC keeps its signature", () => {
  const defs = [...sql.matchAll(/create or replace function public\.(fin3_[a-z_0-9]+)\(/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(defs)].filter((n) => !c.PHASE5_REDEFINED_RPCS.includes(n)).sort(), [...c.PHASE5_RPCS].sort());
  assert.deepEqual([...c.PHASE5_REDEFINED_RPCS], ["fin3_queue_invoice_email"]);
  assert.ok(c.PHASE3_RPCS.includes("fin3_queue_invoice_email"));
  assert.match(sql, /function public\.fin3_queue_invoice_email\(p_org uuid, p_invoice uuid, p_recipient text default null, p_options jsonb default '\{\}'::jsonb\)/);
  for (const n of c.PHASE5_RPCS) assert.ok(!c.PHASE2_RPCS.includes(n) && !c.PHASE3_RPCS.includes(n) && !c.PHASE4_RPCS.includes(n), `${n} is new`);
});
test("every report and overview function is STABLE; only the preference setter and email queue write", () => {
  for (const n of ["fin3_overview", "fin3_explain_safe_to_spend", "fin3_report_profit_loss", "fin3_report_balance_sheet", "fin3_report_cash_flow", "fin3_report_general_ledger", "fin3_report_tax_summary", "fin3_list_entries", "fin3_list_audit", "fin3_list_receipts", "fin3_preview_invoice_email", "fin3_get_ui_prefs"]) {
    const m = sql.match(new RegExp(`function public\\.${n}\\([\\s\\S]*?\\bas \\$\\$`)); assert.ok(m, n); assert.match(m[0], /\bstable\b/, `${n} is stable`);
  }
  const setter = sql.match(/function public\.fin3_set_ui_prefs\([\s\S]*?\bas \$\$/)[0]; assert.doesNotMatch(setter, /\bstable\b/);
});
test("the UI preference table is select-own only: no client write path", () => {
  assert.match(sql, /create table if not exists finance_v3\.ui_prefs/); assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all on finance_v3\.ui_prefs from public, anon, authenticated, service_role/); assert.match(sql, /grant select on finance_v3\.ui_prefs to authenticated/);
  assert.doesNotMatch(sql, /grant\s+(insert|update|delete|all)[^;]*on\s+finance_v3\./i); assert.doesNotMatch(sql, /create\s+policy[^;]*for\s+(insert|update|delete|all)/i);
});
test("the privilege footer is present: authenticated only, nothing for anon or service_role", () => {
  assert.match(sql, /revoke all on function %s from public, anon, service_role/); assert.match(sql, /grant execute on function %s to authenticated/);
  assert.match(sql, /fin3svc\\_%/);
});
test("no floating point in the Phase 5 SQL", () => { assert.doesNotMatch(sql, /\b(double precision|float[48]?|real)\b/i); });
test("rollback restores the Phase 3 email-queue function and drops everything Phase 5 created", () => {
  for (const n of c.PHASE5_RPCS) assert.match(rb, new RegExp(`${n}\\b`), `${n} dropped`);
  assert.match(rb, /create or replace function public\.fin3_queue_invoice_email/); assert.match(rb, /drop table if exists finance_v3\.ui_prefs/);
  assert.match(rb, /delete from finance_v3\.schema_version/);
});
test("contract constants", () => {
  assert.equal(c.PHASE5_RPCS.length, 13); assert.deepEqual([...c.UI_MODES], ["simple", "accountant"]); assert.equal(c.DEFAULT_UI_MODE, "simple");
  assert.deepEqual({ ...c.EMAIL_EDIT_LIMITS }, { subjectMax: 150, messageMax: 2000 }); assert.match(c.FINANCE_V3_VERSION, /phase[56]/);
});
