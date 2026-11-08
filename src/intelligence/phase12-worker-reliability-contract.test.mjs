import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(process.cwd());
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

test("Phase 12 has a machine-wide singleton lock and duplicate-mode exit", () => {
  const lock = read("intelligence-worker/kairflow_intel/worker_lock.py");
  const main = read("intelligence-worker/kairflow_intel/main.py");
  const controller = read("intelligence-worker/controller.py");
  assert.match(lock, /Global\\/);
  assert.match(lock, /flock/);
  assert.match(main, /WorkerAlreadyRunning/);
  assert.match(main, /return 73/);
  assert.match(controller, /proc\.returncode == 73/);
  assert.match(controller, /duplicate_worker_detected/);
});

test("Phase 12 has a single restart supervisor per installation mode", () => {
  const wrapper = read("intelligence-worker/windows/run-worker.ps1");
  const scheduled = read("intelligence-worker/windows/install-task.ps1");
  const controller = read("intelligence-worker/windows/install-controller.ps1");
  assert.doesNotMatch(wrapper, /while\s*\(\s*\$true\s*\)/i);
  assert.match(scheduled, /KairFlow Local Worker Controller/);
  assert.match(scheduled, /runningController/);
  assert.match(controller, /KairFlow Intelligence Worker/);
  assert.match(scheduled, /RestartCount 999/);
  assert.match(controller, /RestartCount 999/);
});

test("Phase 12 adds bounded rotating logs and lease ownership checks", () => {
  const controller = read("intelligence-worker/controller.py");
  const logging = read("intelligence-worker/kairflow_intel/logging_setup.py");
  const jobs = read("intelligence-worker/kairflow_intel/jobs.py");
  assert.match(logging, /RotatingFileHandler/);
  assert.match(logging, /backupCount=backups/);
  assert.match(logging, /handler\.handle\(record\)/);
  assert.match(controller, /KAIRFLOW_WORKER_LOG_FILE/);
  assert.match(controller, /stdout=subprocess\.PIPE/);
  assert.match(controller, /def _capture_output/);
  assert.match(jobs, /lease renewal rejected/);
  assert.match(jobs, /completed is not True/);
  assert.match(jobs, /job_lease_lost/);
});

test("Phase 12 SQL supports send-window deferral, queue recovery and RFC threading", () => {
  const sql = read("supabase/migrations/20261202090000_intelligence_phase12_worker_reliability.sql");
  assert.match(sql, /intel_agent_send_window_status/);
  assert.match(sql, /create or replace function public\.intel_agent_approved_outbound/);
  assert.match(sql, /next_open_at/);
  assert.match(sql, /lease expired at/);
  assert.match(sql, /intel_admin_requeue_job/);
  assert.match(sql, /regexp_matches\(p_in_reply_to/);
  assert.match(sql, /regexp_matches\(p_references/);
  assert.match(sql, /array_position\(v_ids, m\.rfc_message_id\) desc/);
  assert.match(sql, /and not exists \(/);
  assert.match(sql, /public\.intel_norm_email\(m\.to_email\) = v_from/);
  const inbound = sql.split("create or replace function public.intel_agent_record_inbound")[1]
    ?.split("create or replace function public.intel_admin_overview")[0] ?? "";
  const tokenMatch = inbound.split("-- Exact In-Reply-To Message-ID match first")[0];
  assert.match(tokenMatch, /m\.token = p_token[\s\S]*?public\.intel_norm_email\(m\.to_email\) = v_from/,
    "token association must verify the inbound sender against the original outbound recipient");
  assert.match(sql, /worker_info/);
  assert.match(sql, /scheduled_jobs/);
  assert.match(sql, /expired_leases/);
});

test("Phase 12 exposes admin-only queue recovery and unified operational metrics", () => {
  const api = read("src/intelligence/api.js");
  const logs = read("src/intelligence/LogsView.jsx");
  const overview = read("src/intelligence/OverviewView.jsx");
  assert.match(api, /intel_admin_requeue_job/);
  assert.match(logs, /Requeue/);
  assert.match(logs, /intelApi\.requeueJob/);
  assert.match(overview, /Worker operations/);
  assert.match(overview, /expired_leases/);
  assert.match(overview, /worker_info/);
});

test("Phase 12 Windows lock and uninstall paths preserve safe shutdown", () => {
  const lock = read("intelligence-worker/kairflow_intel/worker_lock.py");
  const uninstallTask = read("intelligence-worker/windows/uninstall-task.ps1");
  const uninstallController = read("intelligence-worker/windows/uninstall-controller.ps1");
  assert.match(lock, /kernel32\.LocalFree/);
  assert.match(uninstallTask, /Stop-ScheduledTask/);
  assert.match(uninstallTask, /left in place/i);
  assert.match(uninstallController, /worker_running/);
  assert.match(uninstallController, /duplicate_worker_detected/);
});
