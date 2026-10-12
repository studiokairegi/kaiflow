// Tests for Tasks & Planning logic that Node can execute: validation, row
// mapping, date boundaries, the Today/Tomorrow/Week/Upcoming/Completed/
// Recurring selectors, moving without duplicates, recurrence + catch-up
// planning, and the API layer against a fake Supabase client.
// Database behaviour (uniqueness, RLS, ownership, the materialize/sync/status
// functions, the catch-up sweep) lives in SQL: see tasks_tests.sql.
// Run: node --test src/tasks.test.mjs   (also try TZ=Pacific/Auckland / America/Los_Angeles)

import test from "node:test";
import assert from "node:assert/strict";
import * as T from "./tasks.js";
import { makeTasksApi } from "./tasksApi.js";

// Monday 2026-10-12 is "today" unless stated otherwise.
const TODAY = "2026-10-12";
let n = 0;
const task = (o = {}) => T.taskFromRow({ id: `t${++n}`, title: "Task", status: "todo", priority: "normal", category: "general", sort_order: n, created_at: `2026-10-01T00:00:${String(n % 60).padStart(2, "0")}Z`, ...o });
const series = (o = {}) => T.seriesFromRow({ id: "s1", title: "Chore", recurrence: "daily", start_date: "2026-10-01", status: "active", weekdays: [], ...o });

// -------------------------------------------------------------------- dates
test("date arithmetic is calendar-exact across months, years, leap days and DST changes", () => {
  assert.equal(T.addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(T.addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(T.addDays("2027-02-28", 1), "2027-03-01");
  assert.equal(T.addDays("2026-03-08", 1), "2026-03-09"); // US DST start
  assert.equal(T.addDays("2026-11-01", 1), "2026-11-02"); // US DST end
  assert.equal(T.diffDays("2026-10-12", "2026-10-19"), 7);
  assert.equal(T.diffDays("2026-03-07", "2026-03-10"), 3);
  assert.equal(T.isoWeekday("2026-10-12"), 1); // Monday
  assert.equal(T.isoWeekday("2026-10-18"), 7); // Sunday
  assert.equal(T.isValidYMD("2026-02-30"), false);
  assert.equal(T.isValidYMD("2026-2-3"), false);
  assert.equal(T.isValidYMD("2028-02-29"), true);
});

test("week is Monday-Sunday and handles Monday, Sunday and year boundaries", () => {
  assert.deepEqual(T.weekDays("2026-10-12")[0], "2026-10-12");
  assert.equal(T.weekDays("2026-10-12")[6], "2026-10-18");
  assert.equal(T.weekDays("2026-10-18")[0], "2026-10-12"); // Sunday still belongs to the week that began Monday
  assert.equal(T.weekDays("2026-10-18")[6], "2026-10-18");
  assert.equal(T.startOfWeek("2027-01-01"), "2026-12-28");
  assert.equal(T.weekDays("2027-01-01")[6], "2027-01-03");
});

test("time and duration formatting", () => {
  assert.equal(T.normalizeTime("09:30:00"), "09:30");
  assert.equal(T.normalizeTime("9:05"), "09:05");
  assert.equal(T.normalizeTime(""), null);
  assert.equal(T.formatMinutes(90), "1h 30m");
  assert.equal(T.formatMinutes(120), "2h");
  assert.equal(T.formatMinutes(45), "45m");
});

// --------------------------------------------------------------- validation
test("task validation: title, dates, estimate, enums and link pairing", () => {
  assert.equal(T.validateTaskInput({ title: "  " }).ok, false);
  assert.equal(T.validateTaskInput({ title: "x".repeat(201) }).ok, false);
  assert.equal(T.validateTaskInput({ title: "a", dueDate: "2026-02-30" }).errors.dueDate.length > 0, true);
  assert.equal(T.validateTaskInput({ title: "a", estMinutes: 0 }).ok, false);
  assert.equal(T.validateTaskInput({ title: "a", estMinutes: 1441 }).ok, false);
  assert.equal(T.validateTaskInput({ title: "a", estMinutes: "45" }).value.estMinutes, 45);
  assert.equal(T.validateTaskInput({ title: "a", priority: "asap" }).ok, false);
  assert.equal(T.validateTaskInput({ title: "a", status: "done" }).ok, false);
  assert.equal(T.validateTaskInput({ title: "a", category: "x" }).ok, false);
  assert.equal(T.validateTaskInput({ title: "a", linkType: "lead" }).ok, false);
  assert.equal(T.validateTaskInput({ title: "a", linkId: "x" }).ok, false);
  const ok = T.validateTaskInput({ title: "  Reply  ", linkType: "lead", linkId: "L1", linkLabel: "Acme" });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.title, "Reply");
  assert.deepEqual([ok.value.priority, ok.value.status, ok.value.category], ["normal", "todo", "general"]);
});

test("series validation per schedule type", () => {
  const base = { title: "Review", startDate: TODAY };
  assert.equal(T.validateSeriesInput({ ...base, recurrence: "weekly", weekdays: [] }).errors.weekdays.length > 0, true);
  assert.deepEqual(T.validateSeriesInput({ ...base, recurrence: "weekly", weekdays: [5, 1, 1] }).value.weekdays, [1, 5]);
  assert.equal(T.validateSeriesInput({ ...base, recurrence: "monthly", monthDay: 0 }).ok, false);
  assert.equal(T.validateSeriesInput({ ...base, recurrence: "monthly", monthDay: 31 }).ok, true);
  assert.equal(T.validateSeriesInput({ ...base, recurrence: "interval", intervalDays: 1 }).ok, false);
  assert.equal(T.validateSeriesInput({ ...base, recurrence: "interval", intervalDays: 366 }).ok, false);
  assert.equal(T.validateSeriesInput({ ...base, recurrence: "interval", intervalDays: 10 }).ok, true);
  assert.equal(T.validateSeriesInput({ ...base, recurrence: "daily", endDate: "2026-10-01" }).errors.endDate.length > 0, true);
  assert.equal(T.validateSeriesInput({ ...base, recurrence: "yearly" }).ok, false);
  assert.equal(T.validateSeriesInput({ title: "x", recurrence: "daily" }).ok, false); // start date required
  // fields that don't belong to the chosen schedule are dropped from the row
  const row = T.seriesToRow(T.validateSeriesInput({ ...base, recurrence: "daily", weekdays: [1], monthDay: 3, intervalDays: 4 }).value);
  assert.deepEqual([row.weekdays, row.month_day, row.interval_days], [[], null, null]);
});

test("row mapping round-trips and normalizes", () => {
  const t = T.taskFromRow({ id: "a", title: "T", due_date: "2026-10-12", start_time: "09:30:00", est_minutes: 20, link_type: "lead", link_id: "L", is_priority: true, series_id: "s", occurrence_date: "2026-10-12" });
  assert.equal(t.startTime, "09:30");
  assert.equal(t.isPriority, true);
  const row = T.taskToRow(T.validateTaskInput(T.taskToForm(t)).value);
  assert.equal(row.start_time, "09:30");
  assert.equal(row.link_id, "L");
  assert.equal(row.notes, null);
});

// ------------------------------------------------------------ today/tomorrow
test("today: overdue first (oldest, then most urgent), then priorities, then the rest; completed tracked", () => {
  const tasks = [
    task({ id: "o2", due_date: "2026-10-10", priority: "low" }),
    task({ id: "o1", due_date: "2026-10-09", priority: "normal" }),
    task({ id: "o3", due_date: "2026-10-10", priority: "urgent" }),
    task({ id: "p1", due_date: TODAY, is_priority: true, sort_order: 5 }),
    task({ id: "a", due_date: TODAY, sort_order: 2 }),
    task({ id: "b", due_date: TODAY, sort_order: 1 }),
    task({ id: "d", due_date: TODAY, status: "completed", completed_on: TODAY }),
    task({ id: "c", due_date: TODAY, status: "cancelled" }),
    task({ id: "f", due_date: "2026-10-13" }),
    task({ id: "u", due_date: null }),
  ];
  const v = T.selectToday(tasks, TODAY);
  assert.deepEqual(v.overdue.map((t) => t.id), ["o1", "o3", "o2"]);
  assert.deepEqual(v.priorities.map((t) => t.id), ["p1"]);
  assert.deepEqual(v.others.map((t) => t.id), ["b", "a"]);
  assert.deepEqual(v.done.map((t) => t.id), ["d"]);
  assert.deepEqual([v.stats.total, v.stats.completed, v.stats.remaining, v.stats.overdue], [4, 1, 3, 3]); // cancelled excluded
});

test("a past due date never completes or hides a task", () => {
  const t = task({ id: "x", due_date: "2026-09-01", status: "todo" });
  const v = T.selectToday([t], TODAY);
  assert.equal(v.overdue.length, 1);
  assert.equal(t.status, "todo");
  assert.equal(T.isOverdue(task({ due_date: "2026-09-01", status: "completed" }), TODAY), false);
  assert.equal(T.isOverdue(task({ due_date: TODAY }), TODAY), false);
});

test("workload: estimates sum for remaining tasks only, unestimated are counted, heavy days flagged", () => {
  const tasks = [
    task({ due_date: TODAY, est_minutes: 60 }),
    task({ due_date: TODAY, est_minutes: 30 }),
    task({ due_date: TODAY }),
    task({ due_date: TODAY, est_minutes: 600, status: "completed", completed_on: TODAY }),
  ];
  const s = T.dayStats(tasks, TODAY, TODAY);
  assert.deepEqual([s.estimatedMinutes, s.unestimated, s.hasEstimates, s.heavy], [90, 1, true, false]);
  assert.equal(T.dayStats([task({ due_date: TODAY, est_minutes: 481 })], TODAY, TODAY).heavy, true);
  assert.equal(T.dayStats([task({ due_date: TODAY, est_minutes: 480 })], TODAY, TODAY).heavy, false);
  assert.equal(T.dayStats([task({ due_date: TODAY })], TODAY, TODAY).hasEstimates, false);
});

test("tomorrow is the next calendar day, including across a month/year end", () => {
  const v = T.selectTomorrow([task({ due_date: "2027-01-01" }), task({ due_date: "2026-12-31" })], "2026-12-31");
  assert.equal(v.date, "2027-01-01");
  assert.equal(v.others.length, 1);
  assert.equal(v.stats.remaining, 1);
});

// ---------------------------------------------------------------- week view
test("week groups tasks by day; past open tasks are overdue, not left in an old column", () => {
  const tasks = [
    task({ id: "mon", due_date: "2026-10-12" }),
    task({ id: "wed", due_date: "2026-10-14" }),
    task({ id: "sun", due_date: "2026-10-18" }),
    task({ id: "next", due_date: "2026-10-19" }),
    task({ id: "late", due_date: "2026-10-05" }),
    task({ id: "free", due_date: null }),
    task({ id: "done", due_date: "2026-10-13", status: "completed", completed_on: "2026-10-13" }),
    task({ id: "old-done", due_date: "2026-10-05", status: "completed", completed_on: "2026-10-05" }),
  ];
  const w = T.selectWeek(tasks, "2026-10-14"); // Wednesday
  assert.deepEqual([w.start, w.end], ["2026-10-12", "2026-10-18"]);
  assert.equal(w.days.length, 7);
  assert.deepEqual(w.days[0].tasks.map((t) => t.id), []); // Monday is past and still open -> overdue list
  assert.deepEqual(w.overdue.map((t) => t.id), ["late", "mon"]);
  assert.deepEqual(w.days[1].tasks.map((t) => t.id), ["done"]);
  assert.deepEqual(w.days[2].tasks.map((t) => t.id), ["wed"]);
  assert.deepEqual(w.days[6].tasks.map((t) => t.id), ["sun"]);
  assert.deepEqual(w.unscheduled.map((t) => t.id), ["free"]);
  assert.deepEqual(w.completed.map((t) => t.id), ["done"]);
  assert.equal(w.days[2].isToday, true);
});

test("a heavy day is identified from estimated work", () => {
  const w = T.selectWeek([task({ due_date: "2026-10-15", est_minutes: 300 }), task({ due_date: "2026-10-15", est_minutes: 200 }), task({ due_date: "2026-10-16", est_minutes: 60 })], TODAY);
  assert.deepEqual(w.days.map((d) => d.stats.heavy), [false, false, false, true, false, false, false]);
});

test("upcoming is open work after this week; completed is newest first with dates", () => {
  const tasks = [
    task({ id: "a", due_date: "2026-10-19" }),
    task({ id: "b", due_date: "2026-10-18" }),
    task({ id: "c", due_date: "2026-11-02" }),
    task({ id: "d", due_date: "2026-10-30", status: "completed", completed_on: "2026-10-11" }),
    task({ id: "e", due_date: "2026-10-02", status: "completed", completed_on: "2026-10-12" }),
    task({ id: "f", due_date: "2026-10-02", status: "completed", completed_on: "2026-10-12" }),
    task({ id: "x", due_date: "2026-10-02", status: "cancelled" }),
  ];
  const up = T.selectUpcoming(tasks, TODAY);
  assert.deepEqual(up.map((g) => g.date), ["2026-10-19", "2026-11-02"]);
  const done = T.selectCompleted(tasks);
  assert.deepEqual(done.map((g) => [g.date, g.tasks.length]), [["2026-10-12", 2], ["2026-10-11", 1]]);
  assert.equal(T.selectCompleted(tasks, { includeCancelled: true }).flatMap((g) => g.tasks).length, 4);
});

// ------------------------------------------------------ moving without duplicates
test("rescheduling is a date patch on the same task; completed tasks must be reopened first", () => {
  const t = task({ id: "m", due_date: TODAY });
  assert.deepEqual(T.reschedulePatch(t, "2026-10-13"), { dueDate: "2026-10-13" });
  assert.deepEqual(T.reschedulePatch(t, null), { dueDate: null });
  assert.throws(() => T.reschedulePatch(t, "2026-13-01"));
  assert.throws(() => T.reschedulePatch(task({ status: "completed" }), "2026-10-13"));
});

test("carry forward selects each unfinished task once (ids, not copies); today also sweeps up overdue", () => {
  const tasks = [
    task({ id: "a", due_date: TODAY }),
    task({ id: "b", due_date: TODAY, status: "in_progress" }),
    task({ id: "c", due_date: TODAY, status: "completed", completed_on: TODAY }),
    task({ id: "d", due_date: "2026-10-09" }),
    task({ id: "e", due_date: "2026-10-13" }),
    task({ id: "f", due_date: TODAY, status: "cancelled" }),
  ];
  assert.deepEqual(T.carryForwardIds(tasks, TODAY, "2026-10-13", TODAY).sort(), ["a", "b", "d"]);
  assert.deepEqual(T.carryForwardIds(tasks, "2026-10-13", "2026-10-14", TODAY), ["e"]);
  assert.deepEqual(T.carryForwardIds(tasks, TODAY, "2026-10-10", TODAY), []); // never backwards
  assert.deepEqual(T.carryForwardIds(tasks, TODAY, TODAY, TODAY), ["d"]); // overdue -> today; today's own stay put
});

test("reorder swaps with the neighbour and stops at the ends", () => {
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(T.reorderIds(list, "b", "up"), ["b", "a", "c"]);
  assert.deepEqual(T.reorderIds(list, "b", "down"), ["a", "c", "b"]);
  assert.equal(T.reorderIds(list, "a", "up"), null);
  assert.equal(T.reorderIds(list, "c", "down"), null);
  assert.equal(T.reorderIds(list, "zzz", "up"), null);
});

// --------------------------------------------------------------- recurrence
test("daily, weekdays, weekly and interval occurrences", () => {
  const d = series({ recurrence: "daily" });
  assert.deepEqual(T.occurrenceDates(d, "2026-10-12", "2026-10-14"), ["2026-10-12", "2026-10-13", "2026-10-14"]);
  const wk = series({ recurrence: "weekdays" });
  assert.deepEqual(T.occurrenceDates(wk, "2026-10-16", "2026-10-20"), ["2026-10-16", "2026-10-19", "2026-10-20"]); // Fri, Mon, Tue
  const sel = series({ recurrence: "weekly", weekdays: [1, 4] });
  assert.deepEqual(T.occurrenceDates(sel, "2026-10-12", "2026-10-25"), ["2026-10-12", "2026-10-15", "2026-10-19", "2026-10-22"]);
  const iv = series({ recurrence: "interval", interval_days: 3, start_date: "2026-10-10" });
  assert.deepEqual(T.occurrenceDates(iv, "2026-10-12", "2026-10-20"), ["2026-10-13", "2026-10-16", "2026-10-19"]);
});

test("monthly on a day the month lacks falls on its last day", () => {
  const m31 = series({ recurrence: "monthly", month_day: 31, start_date: "2026-01-01" });
  assert.deepEqual(T.occurrenceDates(m31, "2026-01-01", "2026-05-31"), ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
  const m30 = series({ recurrence: "monthly", month_day: 30, start_date: "2028-01-01" });
  assert.deepEqual(T.occurrenceDates(m30, "2028-02-01", "2028-02-29"), ["2028-02-29"]); // leap year
  const m15 = series({ recurrence: "monthly", month_day: 15, start_date: "2026-11-20" });
  assert.deepEqual(T.occurrenceDates(m15, "2026-11-01", "2027-01-31"), ["2026-12-15", "2027-01-15"]); // not before the start date
});

test("start and end dates bound the series; next occurrence is found or null", () => {
  const s = series({ recurrence: "daily", start_date: "2026-10-14", end_date: "2026-10-16" });
  assert.deepEqual(T.occurrenceDates(s, "2026-10-01", "2026-10-31"), ["2026-10-14", "2026-10-15", "2026-10-16"]);
  assert.equal(T.nextOccurrenceDate(s, "2026-10-12"), "2026-10-14");
  assert.equal(T.nextOccurrenceDate(s, "2026-10-17"), null);
  assert.equal(T.nextOccurrenceDate(series({ recurrence: "monthly", month_day: 5 }), "2026-10-12"), "2026-11-05");
});

test("describeRecurrence is readable", () => {
  assert.equal(T.describeRecurrence(series({ recurrence: "weekly", weekdays: [1, 3] })), "Weekly on Mon, Wed");
  assert.match(T.describeRecurrence(series({ recurrence: "monthly", month_day: 31 })), /last day/);
  assert.equal(T.describeRecurrence(series({ recurrence: "interval", interval_days: 10 })), "Every 10 days");
});

test("materialization plan: horizon, refresh safety, and catch-up", () => {
  // first run for a brand-new daily series starting today: today..today+14, no catch-up
  const fresh = series({ start_date: TODAY });
  const p = T.planMaterialization(fresh, TODAY);
  assert.equal(p.dates.length, 15);
  assert.equal(p.dates[0], TODAY);
  assert.equal(p.through, "2026-10-26");

  // refresh: already materialized to the horizon -> nothing to do (no call, so no duplicates)
  assert.equal(T.planMaterialization(series({ start_date: TODAY, materialized_through: "2026-10-26" }), TODAY), null);
  // next day it needs to top up, and the plan is the same dates again: duplicates are the DB's no-op
  const next = T.planMaterialization(series({ start_date: TODAY, materialized_through: "2026-10-26" }), "2026-10-13");
  assert.equal(next.through, "2026-10-27");
  assert.ok(next.dates.includes("2026-10-27"));

  // missed days: a daily task last materialized 10 days ago gets ONE catch-up occurrence (yesterday), not ten
  const away = series({ start_date: "2026-09-01", materialized_through: "2026-10-02" });
  const a = T.planMaterialization(away, TODAY);
  assert.equal(a.dates.filter((d) => d < TODAY).length, 1);
  assert.equal(a.dates[0], "2026-10-11");

  // a miss older than the window is not back-filled
  const old = series({ recurrence: "weekly", weekdays: [1], start_date: "2026-08-01", materialized_through: "2026-09-20" });
  assert.equal(T.planMaterialization(old, "2026-10-13").dates.filter((d) => d < "2026-10-13").length, 1); // Mon Oct 12, within 7 days
  assert.equal(T.planMaterialization(series({ recurrence: "weekly", weekdays: [1], start_date: "2026-08-01", materialized_through: "2026-09-20" }), "2026-10-15").dates.filter((d) => d < "2026-10-15").length, 1);
  assert.equal(T.planMaterialization(series({ recurrence: "weekly", weekdays: [1], start_date: "2026-08-01", materialized_through: "2026-09-20" }), "2026-10-21").dates.filter((d) => d < "2026-10-21").length, 1); // Oct 19
  assert.equal(T.planMaterialization(series({ recurrence: "weekly", weekdays: [2], start_date: "2026-08-01", materialized_through: "2026-09-20" }), "2026-10-21").dates.filter((d) => d < "2026-10-21").length, 1); // Tue Oct 20
  assert.equal(T.planMaterialization(series({ recurrence: "weekly", weekdays: [2], start_date: "2026-08-01", materialized_through: "2026-09-20" }), "2026-10-28").dates.filter((d) => d < "2026-10-28").length, 1); // Oct 27
  // interval series too sparse for the 7-day window: nothing caught up
  const sparse = series({ recurrence: "interval", interval_days: 30, start_date: "2026-08-01", materialized_through: "2026-09-01" });
  assert.equal(T.planMaterialization(sparse, TODAY).dates.filter((d) => d < TODAY).length, 0);
  // monthly gets a wider window
  const monthly = series({ recurrence: "monthly", month_day: 1, start_date: "2026-01-01", materialized_through: "2026-09-15" });
  assert.deepEqual(T.planMaterialization(monthly, "2026-10-20").dates.filter((d) => d < "2026-10-20"), ["2026-10-01"]);

  // paused / ended never materialize
  assert.equal(T.planMaterialization(series({ status: "paused" }), TODAY), null);
  assert.equal(T.planMaterialization(series({ status: "ended" }), TODAY), null);
  // an end date stops generation
  const ending = T.planMaterialization(series({ start_date: TODAY, end_date: "2026-10-14" }), TODAY);
  assert.deepEqual(ending.dates, ["2026-10-12", "2026-10-13", "2026-10-14"]);
});

test("a series that has not started yet only schedules from its start date", () => {
  const p = T.planMaterialization(series({ start_date: "2026-10-20" }), TODAY);
  assert.equal(p.dates[0], "2026-10-20");
  assert.equal(p.dates.some((d) => d < "2026-10-20"), false);
});

test("schedule vs content changes are told apart (decides regeneration)", () => {
  const a = series({ recurrence: "weekly", weekdays: [1, 3] });
  assert.equal(T.scheduleChanged(a, { ...a, title: "New title", priority: "high", notes: "n" }), false);
  assert.equal(T.scheduleChanged(a, { ...a, weekdays: [3, 1] }), false);
  assert.equal(T.scheduleChanged(a, { ...a, weekdays: [1, 4] }), true);
  assert.equal(T.scheduleChanged(a, { ...a, endDate: "2026-12-01" }), true);
  assert.equal(T.scheduleChanged(a, { ...a, recurrence: "daily" }), true);
});

test("recurring view: next occurrence from the existing open task, else computed; paused shows none", () => {
  const s = series({ recurrence: "weekly", weekdays: [3], start_date: "2026-10-01" });
  const tasks = [task({ series_id: "s1", occurrence_date: "2026-10-14", due_date: "2026-10-15" })]; // moved to Thursday
  const rows = T.selectRecurring([s, series({ id: "s2", status: "paused", title: "Paused" })], tasks, TODAY);
  assert.equal(rows.find((r) => r.series.id === "s1").next, "2026-10-15");
  assert.equal(rows.find((r) => r.series.id === "s2").next, null);
  assert.equal(T.selectRecurring([s], [], TODAY)[0].next, "2026-10-14");
});

// -------------------------------------------------- suggestions, links, errors
test("suggestions are dropped when any task already carries the key, and de-duplicated", () => {
  const tasks = [task({ source_key: "lead-followup:L1:1", status: "completed" })];
  const out = T.filterSuggestions([{ key: "lead-followup:L1:1" }, { key: "lead-followup:L2:1" }, { key: "lead-followup:L2:1" }, { title: "no key" }], tasks);
  assert.deepEqual(out.map((s) => s.key), ["lead-followup:L2:1"]);
});

test("a task resolves to its source record; a deleted record degrades to the saved label", () => {
  const ctx = { leads: [{ id: "L1", companyName: "Acme" }], projects: [{ id: "P1", name: "Series A" }], shots: [{ id: "S1", title: "Cut 12" }], contacts: [{ id: "C1", name: "Mia" }] };
  assert.deepEqual(["lead", "project", "shot", "contact"].map((type, i) => T.resolveLink(task({ link_type: type, link_id: ["L1", "P1", "S1", "C1"][i] }), ctx).label), ["Acme", "Series A", "Cut 12", "Mia"]);
  const gone = T.resolveLink(task({ link_type: "lead", link_id: "L9", link_label: "Old Co" }), ctx);
  assert.deepEqual([gone.exists, gone.label], [false, "Old Co"]);
  assert.equal(T.resolveLink(task(), ctx), null);
});

test("error text is friendly and distinguishes a missing migration", () => {
  assert.match(T.describeTaskError({ code: "42P01", message: 'relation "studio_tasks" does not exist' }), /migration/);
  assert.match(T.describeTaskError({ code: "PGRST205", message: "x" }), /migration/);
  assert.match(T.describeTaskError({ code: "P0002", message: "task_link_not_found" }), /no longer exists/);
  assert.match(T.describeTaskError({ code: "42501", message: "rls" }), /permission/);
  assert.match(T.describeTaskError({ code: "22023", message: "series_ended" }), /can't be resumed/);
  assert.match(T.describeTaskError({ message: "x".repeat(500) }), /try again/);
});

// ------------------------------------------------------------------ API layer
function fakeClient(script = {}) {
  const calls = [];
  const result = (key, fallback) => (typeof script[key] === "function" ? script[key]() : script[key] ?? fallback);
  const chain = (table, op, payload) => {
    const state = { table, op, payload, filters: [] };
    const q = {
      select: () => { state.select = true; return q; },
      eq: (c, v) => { state.filters.push(["eq", c, v]); return q; },
      in: (c, v) => { state.filters.push(["in", c, v]); return q; },
      gte: (c, v) => { state.filters.push(["gte", c, v]); return q; },
      order: () => q,
      single: () => { calls.push(state); return Promise.resolve(result(`${table}.${op}`, { data: {}, error: null })); },
      maybeSingle: () => { calls.push(state); return Promise.resolve(result(`${table}.${op}.maybe`, { data: null, error: null })); },
      then: (res, rej) => { calls.push(state); return Promise.resolve(result(`${table}.${op}`, { data: [], error: null })).then(res, rej); },
    };
    return q;
  };
  return {
    calls,
    from: (table) => ({
      select: (...a) => chain(table, "select", a),
      insert: (row) => chain(table, "insert", row),
      update: (row) => chain(table, "update", row),
      delete: () => chain(table, "delete"),
    }),
    rpc: (name, args) => { calls.push({ rpc: name, args }); return Promise.resolve(result(`rpc.${name}`, { data: 0, error: null })); },
  };
}
const trow = (o = {}) => ({ id: "r1", title: "T", status: "todo", priority: "normal", category: "general", ...o });

test("list loads open tasks plus a bounded window of completed/cancelled", async () => {
  const sb = fakeClient({ "studio_tasks.select": () => ({ data: [trow()], error: null }) });
  const api = makeTasksApi(sb);
  const out = await api.list(TODAY);
  assert.equal(out.length, 2); // same fake rows returned for both queries
  const statuses = sb.calls.map((c) => c.filters.find((f) => f[1] === "status")[2]);
  assert.deepEqual(statuses, [["todo", "in_progress"], ["completed", "cancelled"]]);
  assert.match(sb.calls[1].filters.find((f) => f[0] === "gte")[2], /^2026-08-13T/); // 60 days back
});

test("create sends one insert with a request key; a duplicate key returns the first row (no second task)", async () => {
  const sb = fakeClient({ "studio_tasks.insert": { data: trow({ id: "new" }), error: null } });
  const r = await makeTasksApi(sb).create({ title: "Reply to Acme", dueDate: TODAY }, { requestKey: "reqkey-0001" });
  assert.equal(r.created, true);
  assert.equal(sb.calls[0].payload.request_key, "reqkey-0001");
  assert.equal(sb.calls[0].payload.title, "Reply to Acme");

  const dupe = fakeClient({
    "studio_tasks.insert": { data: null, error: { code: "23505", message: "duplicate" } },
    "studio_tasks.select.maybe": { data: trow({ id: "first" }), error: null },
  });
  const d = await makeTasksApi(dupe).create({ title: "Reply" }, { requestKey: "reqkey-0002" });
  assert.deepEqual([d.created, d.task.id], [false, "first"]);
  assert.deepEqual(dupe.calls[1].filters[0], ["eq", "request_key", "reqkey-0002"]);

  const sug = fakeClient({
    "studio_tasks.insert": { data: null, error: { code: "23505", message: "duplicate" } },
    "studio_tasks.select.maybe": { data: trow({ id: "existing" }), error: null },
  });
  const s = await makeTasksApi(sug).create({ title: "Follow up" }, { sourceKey: "lead-followup:L1:1" });
  assert.deepEqual(sug.calls[1].filters[0], ["eq", "source_key", "lead-followup:L1:1"]);
  assert.equal(s.created, false);
});

test("create validates before touching the network", async () => {
  const sb = fakeClient();
  await assert.rejects(() => makeTasksApi(sb).create({ title: " " }), (e) => !!e.validation?.title);
  assert.equal(sb.calls.length, 0);
});

test("completing updates exactly that task row; reopening sends only the status", async () => {
  const sb = fakeClient({ "studio_tasks.update": { data: trow({ status: "completed" }), error: null } });
  const api = makeTasksApi(sb);
  await api.setStatus("occ-1", "completed", TODAY);
  assert.deepEqual(sb.calls[0].payload, { status: "completed", completed_on: TODAY });
  assert.deepEqual(sb.calls[0].filters, [["eq", "id", "occ-1"]]);
  assert.equal(sb.calls.some((c) => c.table === "studio_task_series"), false); // the series is never written
  await api.setStatus("occ-1", "todo", TODAY);
  assert.deepEqual(sb.calls[1].payload, { status: "todo" });
});

test("reschedule and carry forward update in place (one update, no insert)", async () => {
  const sb = fakeClient({ "studio_tasks.update": { data: [trow()], error: null } });
  const api = makeTasksApi(sb);
  await api.moveMany(["a", "b"], "2026-10-13");
  assert.deepEqual(sb.calls.map((c) => c.op), ["update"]);
  assert.deepEqual(sb.calls[0].filters, [["in", "id", ["a", "b"]]]);
  assert.deepEqual(sb.calls[0].payload, { due_date: "2026-10-13" });
  assert.deepEqual(await api.moveMany([], "2026-10-13"), []);
  assert.equal(sb.calls.length, 1);
});

test("deleting a one-off task deletes it; deleting a recurring occurrence skips it so it can't regenerate", async () => {
  const sb = fakeClient({ "studio_tasks.update": { data: trow({ status: "cancelled" }), error: null } });
  const api = makeTasksApi(sb);
  await api.remove({ id: "one", seriesId: null });
  assert.equal(sb.calls[0].op, "delete");
  await api.remove({ id: "occ", seriesId: "s1" });
  assert.equal(sb.calls[1].op, "update");
  assert.deepEqual(sb.calls[1].payload, { status: "cancelled" });
});

test("quick estimate updates only est_minutes and rejects nonsense", async () => {
  const sb = fakeClient({ "studio_tasks.update": { data: trow({ est_minutes: 45 }), error: null } });
  const api = makeTasksApi(sb);
  assert.equal((await api.setEstimate("a", 45)).estMinutes, 45);
  assert.deepEqual(sb.calls[0].payload, { est_minutes: 45 });
  await api.setEstimate("a", null);
  assert.deepEqual(sb.calls[1].payload, { est_minutes: null });
  await assert.rejects(() => api.setEstimate("a", 0));
  await assert.rejects(() => api.setEstimate("a", 2.5));
  assert.equal(sb.calls.length, 2);
});

test("reorder is one RPC call with the full id order", async () => {
  const sb = fakeClient();
  await makeTasksApi(sb).reorder(["c", "a", "b"]);
  assert.deepEqual(sb.calls, [{ rpc: "studio_tasks_reorder", args: { p_ids: ["c", "a", "b"] } }]);
});

const srow = (o = {}) => ({ id: "s1", title: "Chore", recurrence: "daily", start_date: TODAY, status: "active", weekdays: [], ...o });

test("ensureMaterialized calls the database only for series that need it, and one failure doesn't block the rest", async () => {
  const sb = fakeClient({
    "rpc.studio_task_materialize": (() => { let i = 0; return () => (++i === 1 ? { data: null, error: { message: "boom" } } : { data: 4, error: null }); })(),
  });
  const api = makeTasksApi(sb);
  const list = [
    series({ id: "a", start_date: TODAY }),
    series({ id: "b", start_date: TODAY }),
    series({ id: "done", start_date: TODAY, materialized_through: "2026-10-26" }), // up to date: no call
    series({ id: "paused", status: "paused" }), // no call
  ];
  const res = await api.ensureMaterialized(list, TODAY);
  assert.deepEqual(res, { inserted: 4, failed: 1 });
  assert.deepEqual(sb.calls.map((c) => c.args.p_series_id), ["a", "b"]);
  assert.equal(sb.calls[0].args.p_today, TODAY);
  assert.equal(sb.calls[0].args.p_dates.length, 15);
  // a second pass with the refreshed through-date does nothing
  const again = await makeTasksApi(fakeClient()).ensureMaterialized([series({ start_date: TODAY, materialized_through: "2026-10-26" })], TODAY);
  assert.deepEqual(again, { inserted: 0, failed: 0 });
});

test("editing a series: content-only edit syncs without regenerating; schedule edit regenerates and re-materializes", async () => {
  const before = series({ id: "s1", recurrence: "weekly", weekdays: [1], start_date: TODAY });
  const input = { title: "Renamed", recurrence: "weekly", weekdays: [1], startDate: TODAY };
  const sb = fakeClient({ "studio_task_series.update": { data: srow({ title: "Renamed", recurrence: "weekly", weekdays: [1] }), error: null } });
  await makeTasksApi(sb).updateSeries(before, input, TODAY);
  assert.deepEqual(sb.calls.find((c) => c.rpc === "studio_task_series_sync").args, { p_series_id: "s1", p_today: TODAY, p_regenerate: false });
  assert.equal(sb.calls.some((c) => c.rpc === "studio_task_materialize"), false);

  const sb2 = fakeClient({
    "studio_task_series.update": { data: srow({ recurrence: "weekly", weekdays: [2] }), error: null },
    "studio_task_series.select": { data: srow({ recurrence: "weekly", weekdays: [2], materialized_through: "2026-10-11" }), error: null },
  });
  await makeTasksApi(sb2).updateSeries(before, { ...input, weekdays: [2] }, TODAY);
  const names = sb2.calls.filter((c) => c.rpc).map((c) => `${c.rpc}:${c.args.p_regenerate ?? ""}`);
  assert.deepEqual(names, ["studio_task_series_sync:true", "studio_task_materialize:"]);
});

test("pause / resume / end go through one status RPC; resume then top-ups, pause and end do not", async () => {
  const sb = fakeClient({ "studio_task_series.select": { data: srow({ status: "paused" }), error: null } });
  const api = makeTasksApi(sb);
  await api.setSeriesStatus("s1", "paused", TODAY);
  assert.deepEqual(sb.calls.filter((c) => c.rpc).map((c) => c.rpc), ["studio_task_series_set_status"]);
  assert.equal(sb.calls[0].args.p_status, "paused");

  const sb2 = fakeClient({ "studio_task_series.select": { data: srow({ status: "active", materialized_through: "2026-10-11" }), error: null } });
  await makeTasksApi(sb2).setSeriesStatus("s1", "active", TODAY);
  assert.deepEqual(sb2.calls.filter((c) => c.rpc).map((c) => c.rpc), ["studio_task_series_set_status", "studio_task_materialize"]);
});

test("a missing migration surfaces as a friendly error, not a raw database message", async () => {
  const sb = fakeClient({ "studio_tasks.select": { data: null, error: { code: "42P01", message: 'relation "public.studio_tasks" does not exist' } } });
  await assert.rejects(() => makeTasksApi(sb).list(TODAY), /migration/);
});

test("everything is independent of the process time zone", () => {
  // Same inputs, same outputs, whatever TZ node runs under (run this file with TZ=... to exercise it).
  assert.equal(T.weekDays("2026-03-08")[0], "2026-03-02");
  assert.equal(T.occurrenceDates(series({ recurrence: "daily", start_date: "2026-03-07" }), "2026-03-07", "2026-03-10").length, 4);
  assert.equal(T.addDays("2026-10-25", 1), "2026-10-26");
});
