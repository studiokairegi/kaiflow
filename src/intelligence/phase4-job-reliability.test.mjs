// Phase 4 (controller / worker / job execution reliability): job-state presentation logic and source-level contracts for the migration.
// These are mocked / source-level checks. They do not execute the SQL (no PostgreSQL in the session that wrote them) and they are not a live run.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { jobPhase, jobSummary, workerSchedulerNotice, controllerRestartNotice } from "./logic.js";

const NOW = Date.parse("2026-11-13T12:00:00Z");
const iso = (offsetMin) => new Date(NOW + offsetMin * 60000).toISOString();
const job = (o) => ({ id: "j", kind: "discover", state: "queued", attempts: 0, max_attempts: 5, last_error: null, run_after: iso(-1), lease_until: null, ...o });

test("a job that failed and is waiting for its next try is Retrying, not an ordinary scheduled job", () => {
  const p = jobPhase(job({ attempts: 2, last_error: "transient: ollama down", run_after: iso(15) }), NOW);
  assert.equal(p.key, "retrying");
  assert.equal(p.tone, "warn");
  assert.match(p.label, /try 2 of 5/);
  assert.equal(p.recoverable, true);
  assert.equal(p.needsAttention, true);
});

test("a deliberate schedule is not shown as a failure", () => {
  assert.equal(jobPhase(job({ run_after: iso(30) }), NOW).key, "scheduled");
  assert.equal(jobPhase(job({ attempts: 1, last_error: "deferred: daily_cap", run_after: iso(30) }), NOW).key, "deferred");
  assert.equal(jobPhase(job({ run_after: iso(-5) }), NOW).key, "waiting");
  assert.equal(jobPhase(job({ run_after: iso(30) }), NOW).needsAttention, false);
});

test("dead jobs are permanent failures and can be requeued; succeeded jobs are done", () => {
  const dead = jobPhase(job({ state: "dead", attempts: 5, last_error: "permanent: x" }), NOW);
  assert.deepEqual([dead.key, dead.tone, dead.recoverable], ["dead", "bad", true]);
  assert.equal(jobPhase(job({ state: "succeeded" }), NOW).tone, "ok");
  assert.equal(jobPhase(job({ state: "failed" }), NOW).key, "failed");
});

test("a running job whose lease has expired is Stalled; a healthy one is Running", () => {
  assert.equal(jobPhase(job({ state: "running", attempts: 1, lease_until: iso(-2) }), NOW).key, "stalled");
  assert.equal(jobPhase(job({ state: "running", attempts: 1, lease_until: iso(4) }), NOW).key, "running");
  assert.equal(jobPhase(job({ state: "running", attempts: 1 }), NOW).key, "running");
});

test("missing or odd input never throws", () => {
  assert.equal(jobPhase(undefined, NOW).key, "unknown");
  assert.equal(jobPhase({ state: "weird" }, NOW).key, "unknown");
  assert.deepEqual(jobSummary(undefined, NOW).dead, 0);
});

test("jobSummary counts what the table shows", () => {
  const rows = [job({ state: "dead" }), job({ attempts: 1, last_error: "transient: x", run_after: iso(5) }), job({ attempts: 2, last_error: "unexpected KeyError: a" }),
    job({ state: "running", lease_until: iso(-1) }), job({ state: "running", lease_until: iso(3) }), job({ run_after: iso(9) })];
  const s = jobSummary(rows, NOW);
  assert.equal(s.dead, 1); assert.equal(s.retrying, 2); assert.equal(s.stalled, 1); assert.equal(s.running, 1); assert.equal(s.scheduled, 1);
});

test("scheduler problems and crash loops produce a notice only when there is something to say", () => {
  assert.equal(workerSchedulerNotice({}), "");
  assert.equal(workerSchedulerNotice(null), "");
  assert.match(workerSchedulerNotice({ scheduler_error: "scheduler: permission denied" }), /permission denied/);
  assert.equal(controllerRestartNotice({ consecutive_failures: 2, worker_running: false }), "");
  assert.equal(controllerRestartNotice({ consecutive_failures: 5, worker_running: true }), "");
  const n = controllerRestartNotice({ consecutive_failures: 4, worker_running: false, next_restart_seconds: 160 });
  assert.match(n, /4 times in a row/); assert.match(n, /160 s/);
  assert.equal(controllerRestartNotice(undefined), "");
});

// ---- migration source contract (does not run SQL)
const mig = readFileSync(new URL("../../supabase/migrations/20270103090000_intelligence_phase4_job_reliability.sql", import.meta.url), "utf8");
const fn = (name) => { const i = mig.indexOf(`function public.${name}(`); return mig.slice(i, mig.indexOf("end $$;", i)); };

test("migration: fail_job only touches a job that is still running and owned by the caller", () => {
  const body = fn("intel_agent_fail_job");
  assert.match(body, /state = 'running' and locked_by = p_worker_id for update/);
  assert.match(body, /return 'not_owner'/);
});

test("migration: complete_job is idempotent only for the same worker and a succeeded job", () => {
  const body = fn("intel_agent_complete_job");
  assert.match(body, /state = 'running' and locked_by = p_worker_id/);
  assert.match(body, /state = 'succeeded' and locked_by = p_worker_id/);
});

test("migration: additive only (no table, column, constraint or data change) and signatures unchanged", () => {
  const code = mig.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.doesNotMatch(code, /\b(alter table|drop |truncate|delete from|insert into|create table|create index)\b/i);
  assert.match(code, /intel_agent_complete_job\(p_job_id uuid, p_worker_id text, p_result jsonb default '\{\}'::jsonb\) returns boolean/);
  assert.match(code, /intel_agent_fail_job\(p_job_id uuid, p_worker_id text, p_error text, p_retry_seconds int default 60\) returns text/);
  assert.match(code, /revoke all on function public\.intel_agent_fail_job\(uuid, text, text, int\) from public, anon/);
});

test("worker source: permanent failures use the dead-letter RPC and completion is retried before any failure is reported", () => {
  const jobs = readFileSync(new URL("../../intelligence-worker/kairflow_intel/jobs.py", import.meta.url), "utf8");
  assert.match(jobs, /intel_agent_fail_job_permanent/);
  assert.match(jobs, /def _settle\(/);
  assert.match(jobs, /def _housekeeping\(/);
  assert.doesNotMatch(jobs, /min\(30 \* 2 \*\* max\(job\["attempts"\] - 1, 0\), 3600\)/);   // the old 7.5-minute schedule is gone
});

// ---- Emma master switch
import { emmaSwitch, EMMA_LAUNCH_URL } from "./logic.js";

test("emmaSwitch: on, paused, off and unpaired each say what a click does", () => {
  const on = emmaSwitch({ reachable: true, status: { worker_running: true } });
  assert.deepEqual([on.state, on.on, on.action], ["on", true, "shutdown"]);
  const paused = emmaSwitch({ reachable: true, status: { worker_running: false } });
  assert.deepEqual([paused.state, paused.on, paused.action], ["paused", false, "start"]);
  const off = emmaSwitch({ reachable: false });
  assert.deepEqual([off.state, off.on, off.action], ["off", false, "launch"]);
  const pair = emmaSwitch({ reachable: true, authFailed: true });
  assert.deepEqual([pair.state, pair.action], ["pair", null]);
});

test("emmaSwitch: busy states block clicks, and a failed launch explains the one-time setup", () => {
  assert.equal(emmaSwitch({ launching: true }).busy, true);
  assert.equal(emmaSwitch({ stopping: true, reachable: true, status: { worker_running: true } }).action, null);
  assert.match(emmaSwitch({ reachable: false, launchTimedOut: true }).detail, /Install-Emma-Switch\.cmd/);
  assert.equal(emmaSwitch().state, "off");
});

test("master switch source contracts: confirmation before any change, launcher link, no web input reaches the launcher", () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  const sw = read("./EmmaSwitch.jsx");
  assert.match(sw, /confirmAction\("Turn Emma completely off\?/);
  assert.match(sw, /\/api\/shutdown/);
  assert.equal(EMMA_LAUNCH_URL, "kairflow-emma://start");
  assert.match(sw, /Authorization: `Bearer \$\{token\}`/);
  assert.doesNotMatch(sw, /supabase/i);                                  // the controller token never goes to Supabase
  assert.match(read("./SettingsView.jsx"), /<EmmaSwitch \/>/);
  assert.match(read("./OverviewView.jsx"), /<EmmaSwitch compact \/>/);
  const launcher = read("../../intelligence-worker/windows/launcher.ps1");
  assert.match(launcher, /Start-ScheduledTask -TaskName \$taskName/);
  assert.doesNotMatch(launcher, /\$args|\$input|%1|param\(/i);           // reads nothing from the link
  const install = read("../../intelligence-worker/windows/install-launcher.ps1");
  assert.match(install, /HKCU:\\Software\\Classes\\kairflow-emma/);
  assert.doesNotMatch(install, /HKLM|RunAs|-Verb/i);                     // per user, no administrator
  assert.doesNotMatch(install, /%1/);
  assert.match(read("../../intelligence-worker/windows/install-controller.ps1"), /install-launcher\.ps1/);
});

test("emmaSwitch: a controller that answers with an error is never shown as paused", () => {
  const e = emmaSwitch({ reachable: true, authFailed: false, status: null });
  assert.deepEqual([e.state, e.action, e.on], ["error", null, false]);
});

test("EmmaSwitch source: launches through an anchor, and the mounted flag is re-armed for StrictMode", () => {
  const sw = readFileSync(new URL("./EmmaSwitch.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(sw, /window\.location\.href\s*=/);
  assert.match(sw, /alive\.current = true; return/);
});
