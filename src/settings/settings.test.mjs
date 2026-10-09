import test from "node:test";
import assert from "node:assert/strict";
import * as S from "./schema.js";
import * as F from "./followups.js";
import * as R from "./runtime.js";

const clone = (o) => JSON.parse(JSON.stringify(o));

test("defaults validate and the new follow-up default is Initial + 2 (days 0/3/7)", () => {
  assert.deepEqual(S.validateSettings(S.DEFAULT_SETTINGS), {});
  assert.deepEqual(S.DEFAULT_FOLLOWUP_SCHEDULE.map((s) => s.dayOffset), [0, 3, 7]);
});

test("a saved schedule equal to the old 5-step default is recognised as never customised", () => {
  assert.equal(S.isLegacyDefaultSchedule([{ dayOffset: 0 }, { dayOffset: 3 }, { dayOffset: 7 }, { dayOffset: 14 }, { dayOffset: 21 }]), true);
  assert.equal(S.isLegacyDefaultSchedule([{ dayOffset: 0 }, { dayOffset: 2 }, { dayOffset: 7 }, { dayOffset: 14 }, { dayOffset: 21 }]), false);
});

test("row round-trip keeps every field and never writes privileged columns", () => {
  const s = clone(S.DEFAULT_SETTINGS); s.timezone = "Africa/Nairobi"; s.invoicePrefixes.invoice = "KAI"; s.userPrefs.sound.enabled = true;
  const row = S.settingsToRow(s, "u1");
  for (const k of ["plan", "is_admin", "has_seen_tutorial"]) assert.ok(!(k in row), `${k} must not be written by the settings form`);
  const back = S.settingsFromRow({ ...row, plan: "pro", is_admin: false, has_seen_tutorial: true });
  assert.equal(back.timezone, "Africa/Nairobi"); assert.equal(back.invoicePrefixes.invoice, "KAI"); assert.equal(back.userPrefs.sound.enabled, true);
  assert.equal(back.plan, "pro"); assert.equal(back.hasSeenTutorial, true);
});

test("old rows (missing every new column) load with safe defaults", () => {
  const s = S.settingsFromRow({ studio_name: "X", followup_schedule: [{ label: "a", dayOffset: 0 }, { label: "b", dayOffset: 3 }, { label: "c", dayOffset: 7 }, { label: "d", dayOffset: 14 }, { label: "e", dayOffset: 21 }] });
  assert.equal(s.followupSchedule.length, 5); // an existing studio's 5-step schedule is preserved
  assert.equal(s.autoNoResponse, true); assert.deepEqual(s.archiveDays, S.DEFAULT_ARCHIVE_DAYS); assert.equal(s.defaultPipelinePreset, "full");
});

test("garbage in new columns falls back instead of crashing", () => {
  const s = S.settingsFromRow({ followup_schedule: [{ dayOffset: "x" }], workweek: "nope", archive_days: [], user_prefs: "bad", outcome_reasons: 5 });
  assert.deepEqual(s.followupSchedule, S.DEFAULT_FOLLOWUP_SCHEDULE); assert.deepEqual(s.workweek, S.DEFAULT_WORKWEEK);
  assert.deepEqual(s.userPrefs.notifyCategories, S.DEFAULT_USER_PREFS.notifyCategories);
});

test("validation: milestones, follow-ups, archive, prefixes, terms, timezone, planner, focus", () => {
  const bad = (mut) => { const s = clone(S.DEFAULT_SETTINGS); mut(s); return S.validateSettings(s); };
  assert.ok(bad((s) => { s.milestoneDefaults = [50, 30, 30]; }).milestoneDefaults);
  assert.ok(bad((s) => { s.milestoneDefaults = [50, 25, 25.5]; }).milestoneDefaults);
  assert.deepEqual(bad((s) => { s.milestoneDefaults = [33.33, 33.33, 33.34]; }), {});
  assert.ok(bad((s) => { s.followupSchedule[2].dayOffset = 3; }).followupSchedule);          // not strictly increasing
  assert.ok(bad((s) => { s.followupSchedule[1].dayOffset = -1; }).followupSchedule);
  assert.ok(bad((s) => { s.followupSchedule = S.followupScheduleFor(7); }).followupSchedule); // > 6 follow-ups
  assert.ok(bad((s) => { s.archiveDays.won = 0; }).archiveDays);
  assert.ok(bad((s) => { s.invoicePrefixes.invoice = "inv"; }).invoicePrefixes);
  assert.ok(bad((s) => { s.invoicePrefixes.receipt = "INV"; }).invoicePrefixes);              // duplicate
  assert.ok(bad((s) => { s.defaultPaymentTermsDays = 400; }).defaultPaymentTermsDays);
  assert.ok(bad((s) => { s.timezone = "Mars/Olympus"; }).timezone);
  assert.deepEqual(bad((s) => { s.timezone = "Africa/Nairobi"; }), {});
  assert.ok(bad((s) => { s.plannerDefaults.profitPercent = 100; }).plannerDefaults);
  assert.ok(bad((s) => { s.workweek.days = []; }).workweek);
  assert.ok(bad((s) => { s.userPrefs.focusTimer.workMinutes = 0; }).focusTimer);
  assert.ok(bad((s) => { s.defaultPipelinePreset = "custom"; }).defaultPipelineStageKeys);
  assert.ok(bad((s) => { s.studioName = "  "; }).studioName);
});

test("dirty tracking and error-to-tab mapping", () => {
  const a = clone(S.DEFAULT_SETTINGS), b = clone(a); b.studioName = "New"; b.archiveDays.won = 45;
  assert.deepEqual([...S.dirtyTabs(a, b)].sort(), ["crm", "general"]);
  assert.deepEqual([...S.errorTabs({ milestoneDefaults: "x", focusTimer: "y" })].sort(), ["finance", "production"]);
});

// ---- follow-up cadence --------------------------------------------------------
const sch = (n) => S.followupScheduleFor(n, [3, 7, 14, 21, 30, 45].slice(0, n));
test("new leads get Initial + N slots matching the schedule", () => {
  assert.equal(F.emptyEmailSlots(3).length, 3);  // schedule length 3 = initial + 2
  assert.deepEqual(F.emptyEmailSlots(3).map((e) => e.label), ["Initial Email", "Follow-up 1", "Follow-up 2"]);
});
test("an old lead with 5 slots keeps them; a lead is padded up (never down) to the schedule", () => {
  const five = F.emptyEmailSlots(5);
  assert.equal(F.normalizeEmailSlots(five, 3).length, 5);
  assert.equal(F.normalizeEmailSlots(F.emptyEmailSlots(3), 5).length, 5);
});
test("slots beyond the schedule are never due and the lead can complete early", () => {
  const emails = F.emptyEmailSlots(5);
  assert.equal(F.lastScheduledIndex(emails, sch(2)), 2);
  assert.equal(F.nextScheduledIndex(emails, sch(2)), 0);
  emails[0].sent = emails[1].sent = emails[2].sent = true;
  assert.equal(F.nextScheduledIndex(emails, sch(2)), -1);       // slots 3 and 4 exist but are out of schedule
  assert.equal(F.followupCountLabel(emails, sch(2)), "2 follow-ups");
  assert.equal(F.followupCountLabel(F.emptyEmailSlots(2), sch(1)), "1 follow-up");
});
test("auto No Response fires only on the final SCHEDULED follow-up, only from Cold Email, only if enabled", () => {
  const e = F.emptyEmailSlots(5);
  const base = { sent: true, stage: "cold_email", emails: e, schedule: sch(2), autoNoResponse: true };
  assert.equal(F.sendingTriggersNoResponse({ ...base, index: 1 }), false);
  assert.equal(F.sendingTriggersNoResponse({ ...base, index: 2 }), true);
  assert.equal(F.sendingTriggersNoResponse({ ...base, index: 4 }), false);      // old hardcoded slot 4 no longer special
  assert.equal(F.sendingTriggersNoResponse({ ...base, index: 2, autoNoResponse: false }), false);
  assert.equal(F.sendingTriggersNoResponse({ ...base, index: 2, stage: "responded" }), false);
  assert.equal(F.sendingTriggersNoResponse({ ...base, index: 0 }), false);
  // legacy studio with the old 5-step schedule still behaves exactly as before
  assert.equal(F.sendingTriggersNoResponse({ ...base, schedule: sch(4), index: 4 }), true);
});

// ---- runtime --------------------------------------------------------------------
test("workweek: configurable days/hours, weekends default to zero target", () => {
  const sat = new Date(2026, 9, 10), mon = new Date(2026, 9, 5);
  assert.equal(R.workdayTargetSeconds(mon, { days: [1, 2, 3, 4, 5], hoursPerDay: 8 }), 28800);
  assert.equal(R.workdayTargetSeconds(sat, { days: [1, 2, 3, 4, 5], hoursPerDay: 8 }), 0);
  assert.equal(R.workdayTargetSeconds(sat, { days: [1, 2, 3, 4, 5, 6], hoursPerDay: 6 }), 21600);
});
test("timezone-aware 'today' and date formats", () => {
  const instant = new Date("2026-10-08T22:30:00Z"); // already Oct 9 in Nairobi (UTC+3), still Oct 8 in New York
  assert.equal(R.todayInZone(instant, "Africa/Nairobi"), "2026-10-09");
  assert.equal(R.todayInZone(instant, "America/New_York"), "2026-10-08");
  assert.equal(R.formatIsoDate("2026-10-09", "DMY"), "09/10/2026");
  assert.equal(R.formatIsoDate("2026-10-09", "MDY"), "10/09/2026");
  assert.equal(R.formatIsoDate("2026-10-09", ""), "2026-10-09");
});
test("notification categories honour the master switch and each toggle", () => {
  const s = clone(S.DEFAULT_SETTINGS); s.userPrefs.notifyCategories.hotLeads = false;
  R.applyRuntimeSettings(s);
  assert.equal(R.categoryAllowed("followups"), true); assert.equal(R.categoryAllowed("hotLeads"), false);
  s.notificationsEnabled = false; R.applyRuntimeSettings(s);
  assert.equal(R.categoryAllowed("followups"), false);
});
test("outcome reasons: hide defaults, add custom, never lose a reason already on a lead", () => {
  const defaults = ["No budget", "Not a fit", "Other"];
  const cfg = { lost: { hidden: ["Not a fit"], custom: ["Ghosted"] } };
  assert.deepEqual(R.reasonsFor("lost", defaults, "", cfg), ["No budget", "Other", "Ghosted"]);
  assert.ok(R.reasonsFor("lost", defaults, "Not a fit", cfg).includes("Not a fit"));
});
test("sound choices are the two supplied files", () => {
  assert.deepEqual(S.SOUNDS.map((s) => s.src), ["/sounds/glass-tap.mp3", "/sounds/water-drop.mp3"]);
});
test("lead card count follows the studio schedule, not a fixed 5", () => {
  const sched = (n) => Array.from({ length: n }, (_, i) => ({ dayOffset: i * 3 }));
  const emails = F.emptyEmailSlots(5); // an old lead with 5 slots
  emails[0].sent = true;
  assert.deepEqual(F.emailsSentSummary(emails, sched(3)), { sent: 1, total: 3 });   // initial + 2 follow-ups
  assert.deepEqual(F.emailsSentSummary(emails, sched(6)), { sent: 1, total: 5 });   // capped by the lead's own slots
  assert.equal(F.visibleSlotCount(emails, sched(2)), 2);
});
test("shrinking the cadence never hides a slot that already has work in it", () => {
  const sched = [{ dayOffset: 0 }, { dayOffset: 3 }];
  const emails = F.emptyEmailSlots(5);
  emails[0].sent = true; emails[3].sent = true;            // 4th email was already sent
  assert.equal(F.visibleSlotCount(emails, sched), 4);
  assert.deepEqual(F.emailsSentSummary(emails, sched), { sent: 2, total: 4 });
  emails[4].message = "draft";                              // a drafted message also counts
  assert.equal(F.visibleSlotCount(emails, sched), 5);
});
test("a dated 'needs follow-up' flag is due on or after its date, and never without a date", () => {
  const lead = (o) => ({ needsFollowup: true, followupDate: "2026-10-12", ...o });
  assert.equal(F.isManualFollowupDue(lead(), "2026-10-11"), false);
  assert.equal(F.isManualFollowupDue(lead(), "2026-10-12"), true);
  assert.equal(F.isManualFollowupDue(lead(), "2026-10-20"), true);
  assert.equal(F.isManualFollowupDue(lead({ followupDate: "" }), "2026-10-20"), false);
  assert.equal(F.isManualFollowupDue(lead({ needsFollowup: false }), "2026-10-20"), false);
  assert.equal(F.manualFollowupState(lead(), "2026-10-11"), "upcoming");
  assert.equal(F.manualFollowupState(lead(), "2026-10-12"), "today");
  assert.equal(F.manualFollowupState(lead(), "2026-10-13"), "overdue");
  assert.equal(F.manualFollowupState(lead({ needsFollowup: false }), "2026-10-13"), null);
});
