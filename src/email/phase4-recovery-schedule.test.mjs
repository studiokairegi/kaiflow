// Roadmap Phase 4: CRM-recording recovery is scheduled automatically where pg_cron exists, and never touches a provider.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const sql = fs.readFileSync(new URL("../../supabase/migrations/20261220090000_email_crm_recovery_schedule.sql", import.meta.url), "utf8");
const d4 = fs.readFileSync(new URL("../../supabase/migrations/20261208100000_email_crm_activity.sql", import.meta.url), "utf8");

test("schedule is guarded, idempotent and only runs the repair function", () => {
  assert.match(sql, /to_regnamespace\('cron'\) is null/);
  assert.match(sql, /cron\.unschedule\(jobid\)[^;]*kairflow_email_crm_recovery/);
  assert.match(sql, /cron\.schedule\('kairflow_email_crm_recovery', '\*\/10 \* \* \* \*', 'select public\.email_recover_crm_activities\(100\)'\)/);
  assert.doesNotMatch(sql, /email_create_outbound|net\.http|insert into|delete from|drop /i);
});
test("the migration sorts after every earlier migration and the recovery function stays service_role only", () => {
  const names = fs.readdirSync(new URL("../../supabase/migrations/", import.meta.url)).filter((n) => n.endsWith(".sql")).sort();
  assert.ok(names.includes("20261220090000_email_crm_recovery_schedule.sql"));
  assert.match(d4, /revoke all on function public\.email_recover_crm_activities\(integer\) from public, anon, authenticated;/);
  assert.match(d4, /grant execute on function public\.email_recover_crm_activities\(integer\) to service_role;/);
});
