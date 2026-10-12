// src/tasks.js
// Pure logic for Tasks & Planning: validation, row mapping, date arithmetic,
// the Today / Tomorrow / Week / Upcoming / Completed / Recurring selectors, and
// recurrence. It imports nothing and never reads the clock or the time zone:
// every function takes `today` ("YYYY-MM-DD", from the app's configured zone)
// so day boundaries are decided in exactly one place and are testable.
//
// All dates are plain "YYYY-MM-DD" strings and are manipulated with UTC math,
// so a DST change or the browser's zone can never shift a task to another day.

export const PRIORITIES = [
  { id: "low", label: "Low", rank: 0 },
  { id: "normal", label: "Normal", rank: 1 },
  { id: "high", label: "High", rank: 2 },
  { id: "urgent", label: "Urgent", rank: 3 },
];
export const STATUSES = [
  { id: "todo", label: "To do" },
  { id: "in_progress", label: "In progress" },
  { id: "completed", label: "Completed" },
  { id: "cancelled", label: "Cancelled" },
];
export const CATEGORIES = [
  { id: "general", label: "General" },
  { id: "outreach", label: "Outreach" },
  { id: "crm", label: "CRM" },
  { id: "production", label: "Production" },
  { id: "administration", label: "Administration" },
  { id: "finance", label: "Finance" },
];
export const LINK_TYPES = [
  { id: "lead", label: "Deal / lead" },
  { id: "contact", label: "Contact" },
  { id: "project", label: "Project" },
  { id: "shot", label: "Shot" },
];
export const RECURRENCES = [
  { id: "daily", label: "Every day" },
  { id: "weekdays", label: "Weekdays (Mon-Fri)" },
  { id: "weekly", label: "Weekly on selected days" },
  { id: "monthly", label: "Monthly on a day" },
  { id: "interval", label: "Every N days" },
];
export const WEEKDAY_LABELS = { 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat", 7: "Sun" };

/** A day with more estimated work than this is flagged as heavy (minutes). */
export const HEAVY_DAY_MINUTES = 8 * 60;
/** How many days ahead recurring tasks are materialized. */
export const MATERIALIZE_HORIZON_DAYS = 14;
/** A missed occurrence is only caught up if it is this recent (monthly: MONTHLY_CATCH_UP_DAYS). */
export const CATCH_UP_WINDOW_DAYS = 7;
export const MONTHLY_CATCH_UP_DAYS = 31;

const PRIORITY_RANK = Object.fromEntries(PRIORITIES.map((p) => [p.id, p.rank]));
const ids = (list) => list.map((x) => x.id);

// ------------------------------------------------------------------- dates

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidYMD(s) {
  const m = YMD.exec(s || "");
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

const toUTC = (s) => {
  const m = YMD.exec(s);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
};
const fromUTC = (ms) => new Date(ms).toISOString().slice(0, 10);

export function addDays(s, n) {
  return fromUTC(toUTC(s) + n * 86400000);
}
/** Whole days from a to b (b - a). */
export function diffDays(a, b) {
  return Math.round((toUTC(b) - toUTC(a)) / 86400000);
}
/** ISO weekday: 1 = Monday ... 7 = Sunday. */
export function isoWeekday(s) {
  const d = new Date(toUTC(s)).getUTCDay();
  return d === 0 ? 7 : d;
}
export function startOfWeek(s) {
  return addDays(s, 1 - isoWeekday(s));
}
export function weekDays(s) {
  const start = startOfWeek(s);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}
export function daysInMonth(year, month1) {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}
export function normalizeTime(t) {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  if (!m) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

export function formatMinutes(min) {
  if (!min) return "0m";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
}

// -------------------------------------------------------------- validation

export function validateTaskInput(input = {}) {
  const errors = {};
  const title = (input.title || "").trim();
  if (!title) errors.title = "Give the task a title.";
  else if (title.length > 200) errors.title = "Title is too long (200 characters max).";
  const notes = (input.notes || "").trim();
  if (notes.length > 5000) errors.notes = "Notes are too long (5000 characters max).";

  const dueDate = input.dueDate || null;
  if (dueDate && !isValidYMD(dueDate)) errors.dueDate = "Enter a valid date.";

  let estMinutes = null;
  if (input.estMinutes !== undefined && input.estMinutes !== null && input.estMinutes !== "") {
    const n = Number(input.estMinutes);
    if (!Number.isInteger(n) || n < 1 || n > 1440) errors.estMinutes = "Estimate must be 1-1440 minutes.";
    else estMinutes = n;
  }
  const startTime = input.startTime ? normalizeTime(input.startTime) : null;
  if (input.startTime && !startTime) errors.startTime = "Enter a valid time.";

  const priority = input.priority || "normal";
  if (!ids(PRIORITIES).includes(priority)) errors.priority = "Unknown priority.";
  const status = input.status || "todo";
  if (!ids(STATUSES).includes(status)) errors.status = "Unknown status.";
  const category = input.category || "general";
  if (!ids(CATEGORIES).includes(category)) errors.category = "Unknown category.";

  const linkType = input.linkType || null;
  const linkId = input.linkId || null;
  if ((linkType && !linkId) || (!linkType && linkId)) errors.link = "Pick the record to link, or clear the link.";
  else if (linkType && !ids(LINK_TYPES).includes(linkType)) errors.link = "Unknown link type.";

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    errors: {},
    value: {
      title, notes, dueDate, startTime, estMinutes, priority, status, category,
      linkType, linkId, linkLabel: linkType ? (input.linkLabel || "").slice(0, 200) || null : null,
      isPriority: !!input.isPriority,
    },
  };
}

export function validateSeriesInput(input = {}) {
  const base = validateTaskInput({ ...input, dueDate: null, status: "todo" });
  const errors = { ...base.errors };
  delete errors.dueDate;
  const recurrence = input.recurrence;
  if (!ids(RECURRENCES).includes(recurrence)) errors.recurrence = "Choose how often this repeats.";

  let weekdays = [];
  if (recurrence === "weekly") {
    weekdays = [...new Set((input.weekdays || []).map(Number))].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
    if (!weekdays.length) errors.weekdays = "Pick at least one day.";
  }
  let monthDay = null;
  if (recurrence === "monthly") {
    const n = Number(input.monthDay);
    if (!Number.isInteger(n) || n < 1 || n > 31) errors.monthDay = "Pick a day of the month (1-31).";
    else monthDay = n;
  }
  let intervalDays = null;
  if (recurrence === "interval") {
    const n = Number(input.intervalDays);
    if (!Number.isInteger(n) || n < 2 || n > 365) errors.intervalDays = "Interval must be 2-365 days.";
    else intervalDays = n;
  }
  if (!isValidYMD(input.startDate)) errors.startDate = "Choose a start date.";
  const endDate = input.endDate || null;
  if (endDate && !isValidYMD(endDate)) errors.endDate = "Enter a valid end date.";
  else if (endDate && isValidYMD(input.startDate) && endDate < input.startDate) errors.endDate = "End date can't be before the start date.";

  if (Object.keys(errors).length) return { ok: false, errors };
  const v = base.value;
  return {
    ok: true,
    errors: {},
    value: {
      title: v.title, notes: v.notes, category: v.category, priority: v.priority,
      estMinutes: v.estMinutes, startTime: v.startTime,
      linkType: v.linkType, linkId: v.linkId, linkLabel: v.linkLabel,
      recurrence, weekdays, monthDay, intervalDays, startDate: input.startDate, endDate,
    },
  };
}

// ------------------------------------------------------------ row mapping

export function taskFromRow(r) {
  return {
    id: r.id,
    title: r.title,
    notes: r.notes || "",
    dueDate: r.due_date || null,
    startTime: normalizeTime(r.start_time),
    estMinutes: r.est_minutes ?? null,
    priority: r.priority || "normal",
    status: r.status || "todo",
    category: r.category || "general",
    linkType: r.link_type || null,
    linkId: r.link_id || null,
    linkLabel: r.link_label || null,
    isPriority: !!r.is_priority,
    sortOrder: Number(r.sort_order) || 0,
    completedAt: r.completed_at || null,
    completedOn: r.completed_on || null,
    seriesId: r.series_id || null,
    occurrenceDate: r.occurrence_date || null,
    seriesOverride: !!r.series_override,
    autoSkipped: !!r.auto_skipped,
    sourceKey: r.source_key || null,
    createdAt: r.created_at || null,
  };
}

export function taskToRow(v) {
  return {
    title: v.title,
    notes: v.notes || null,
    due_date: v.dueDate || null,
    start_time: v.startTime || null,
    est_minutes: v.estMinutes ?? null,
    priority: v.priority,
    status: v.status,
    category: v.category,
    link_type: v.linkType || null,
    link_id: v.linkId || null,
    link_label: v.linkType ? v.linkLabel || null : null,
    is_priority: !!v.isPriority,
  };
}

export function seriesFromRow(r) {
  return {
    id: r.id,
    title: r.title,
    notes: r.notes || "",
    category: r.category || "general",
    priority: r.priority || "normal",
    estMinutes: r.est_minutes ?? null,
    startTime: normalizeTime(r.start_time),
    linkType: r.link_type || null,
    linkId: r.link_id || null,
    linkLabel: r.link_label || null,
    recurrence: r.recurrence,
    weekdays: (r.weekdays || []).map(Number),
    monthDay: r.month_day ?? null,
    intervalDays: r.interval_days ?? null,
    startDate: r.start_date,
    endDate: r.end_date || null,
    status: r.status || "active",
    materializedThrough: r.materialized_through || null,
  };
}

export function seriesToRow(v) {
  return {
    title: v.title,
    notes: v.notes || null,
    category: v.category,
    priority: v.priority,
    est_minutes: v.estMinutes ?? null,
    start_time: v.startTime || null,
    link_type: v.linkType || null,
    link_id: v.linkId || null,
    link_label: v.linkType ? v.linkLabel || null : null,
    recurrence: v.recurrence,
    weekdays: v.recurrence === "weekly" ? v.weekdays : [],
    month_day: v.recurrence === "monthly" ? v.monthDay : null,
    interval_days: v.recurrence === "interval" ? v.intervalDays : null,
    start_date: v.startDate,
    end_date: v.endDate || null,
  };
}

/** Task -> editor form state. */
export function taskToForm(t) {
  return {
    title: t.title, notes: t.notes, dueDate: t.dueDate || "", startTime: t.startTime || "",
    estMinutes: t.estMinutes ?? "", priority: t.priority, status: t.status, category: t.category,
    linkType: t.linkType, linkId: t.linkId, linkLabel: t.linkLabel, isPriority: t.isPriority,
  };
}

/** Does saving this series edit change WHEN occurrences happen (so future ones must be regenerated)? */
export function scheduleChanged(before, after) {
  const w = (s) => (s.recurrence === "weekly" ? [...s.weekdays].sort().join(",") : "");
  return (
    before.recurrence !== after.recurrence ||
    before.startDate !== after.startDate ||
    (before.endDate || null) !== (after.endDate || null) ||
    w(before) !== w(after) ||
    (before.recurrence === "monthly" ? before.monthDay : null) !== (after.recurrence === "monthly" ? after.monthDay : null) ||
    (before.recurrence === "interval" ? before.intervalDays : null) !== (after.recurrence === "interval" ? after.intervalDays : null)
  );
}

// -------------------------------------------------------------- predicates

export const isOpen = (t) => t.status === "todo" || t.status === "in_progress";
export const isOverdue = (t, today) => isOpen(t) && !!t.dueDate && t.dueDate < today;

function byPlan(a, b) {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return (a.createdAt || "").localeCompare(b.createdAt || "") || a.id.localeCompare(b.id);
}
function byUrgencyThenPlan(a, b) {
  return (PRIORITY_RANK[b.priority] ?? 1) - (PRIORITY_RANK[a.priority] ?? 1) || byPlan(a, b);
}

// --------------------------------------------------------------- selectors

/** Workload numbers for one calendar day. Cancelled tasks never count. */
export function dayStats(tasks, date, today) {
  const planned = tasks.filter((t) => t.dueDate === date && t.status !== "cancelled");
  const done = planned.filter((t) => t.status === "completed");
  const remaining = planned.filter(isOpen);
  const estimatedMinutes = remaining.reduce((s, t) => s + (t.estMinutes || 0), 0);
  const unestimated = remaining.filter((t) => !t.estMinutes).length;
  return {
    date,
    total: planned.length,
    completed: done.length,
    remaining: remaining.length,
    estimatedMinutes,
    unestimated,
    hasEstimates: remaining.some((t) => t.estMinutes),
    heavy: estimatedMinutes > HEAVY_DAY_MINUTES,
    overdue: today && date === today ? tasks.filter((t) => isOverdue(t, today)).length : 0,
  };
}

function daySections(tasks, date) {
  const open = tasks.filter((t) => t.dueDate === date && isOpen(t));
  return {
    priorities: open.filter((t) => t.isPriority).sort(byPlan),
    others: open.filter((t) => !t.isPriority).sort(byPlan),
    done: tasks.filter((t) => t.dueDate === date && t.status === "completed").sort(byPlan),
  };
}

/** Today: overdue first (oldest, then most urgent), then top priorities, then the rest. */
export function selectToday(tasks, today) {
  return {
    overdue: tasks.filter((t) => isOverdue(t, today)).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || byUrgencyThenPlan(a, b)),
    ...daySections(tasks, today),
    stats: dayStats(tasks, today, today),
  };
}

export function selectTomorrow(tasks, today) {
  const date = addDays(today, 1);
  return { date, ...daySections(tasks, date), stats: dayStats(tasks, date, today) };
}

/** Monday-Sunday week containing today. Open tasks from past days are in `overdue`, not their old column. */
export function selectWeek(tasks, today) {
  const dates = weekDays(today);
  const days = dates.map((date) => {
    const s = daySections(tasks, date);
    const visibleOpen = date < today ? [] : [...s.priorities, ...s.others];
    return { date, isToday: date === today, isPast: date < today, tasks: [...visibleOpen, ...s.done], stats: dayStats(tasks, date, today) };
  });
  return {
    start: dates[0],
    end: dates[6],
    days,
    overdue: tasks.filter((t) => isOverdue(t, today)).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || byPlan(a, b)),
    unscheduled: tasks.filter((t) => isOpen(t) && !t.dueDate).sort(byPlan),
    completed: tasks.filter((t) => t.status === "completed" && t.completedOn && t.completedOn >= dates[0] && t.completedOn <= dates[6])
      .sort((a, b) => (b.completedOn || "").localeCompare(a.completedOn || "")),
  };
}

/** Open tasks scheduled after this week, soonest first, grouped by date. */
export function selectUpcoming(tasks, today) {
  const weekEnd = weekDays(today)[6];
  const list = tasks.filter((t) => isOpen(t) && t.dueDate && t.dueDate > weekEnd)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || byPlan(a, b));
  return groupByDate(list, (t) => t.dueDate);
}

/** Completed tasks, newest completion first, grouped by completion day. */
export function selectCompleted(tasks, { includeCancelled = false } = {}) {
  const list = tasks
    .filter((t) => t.status === "completed" || (includeCancelled && t.status === "cancelled"))
    .sort((a, b) => (b.completedOn || b.dueDate || "").localeCompare(a.completedOn || a.dueDate || ""));
  return groupByDate(list, (t) => t.completedOn || t.dueDate || "");
}

function groupByDate(list, keyOf) {
  const groups = [];
  for (const t of list) {
    const k = keyOf(t);
    const g = groups[groups.length - 1];
    if (g && g.date === k) g.tasks.push(t);
    else groups.push({ date: k, tasks: [t] });
  }
  return groups;
}

/** Counts shown in the always-visible summary strip. */
export function planSummary(tasks, today) {
  const t = dayStats(tasks, today, today);
  const tm = dayStats(tasks, addDays(today, 1), today);
  return { overdue: t.overdue, today: t, tomorrow: tm };
}

// ---------------------------------------------------- moving / carrying forward

/** Moving a task only changes its date; it never creates a second task. */
export function reschedulePatch(task, newDate) {
  if (newDate !== null && !isValidYMD(newDate)) throw new Error("Enter a valid date.");
  if (!isOpen(task)) throw new Error("Only open tasks can be rescheduled. Reopen it first.");
  return { dueDate: newDate };
}

/** Ids of unfinished tasks to carry from a day (and anything overdue when `date` is today) onto `toDate`. */
export function carryForwardIds(tasks, date, toDate, today) {
  if (toDate < date) return [];
  return tasks
    .filter((t) => isOpen(t) && t.dueDate && t.dueDate !== toDate && (t.dueDate === date || (date === today && t.dueDate < today)))
    .map((t) => t.id);
}

/** Swap the order of a task with its neighbour in a list; returns the new id order, or null at the edge. */
export function reorderIds(list, taskId, direction) {
  const i = list.findIndex((t) => t.id === taskId);
  const j = i + (direction === "up" ? -1 : 1);
  if (i < 0 || j < 0 || j >= list.length) return null;
  const idsOrder = list.map((t) => t.id);
  [idsOrder[i], idsOrder[j]] = [idsOrder[j], idsOrder[i]];
  return idsOrder;
}

// -------------------------------------------------------------- recurrence

function matchesRule(series, d) {
  switch (series.recurrence) {
    case "daily":
      return true;
    case "weekdays":
      return isoWeekday(d) <= 5;
    case "weekly":
      return series.weekdays.includes(isoWeekday(d));
    case "monthly": {
      const [y, m, day] = d.split("-").map(Number);
      // A day the month doesn't have (31st in April, 30th in February) falls on the last day.
      return day === Math.min(series.monthDay, daysInMonth(y, m));
    }
    case "interval":
      return diffDays(series.startDate, d) >= 0 && diffDays(series.startDate, d) % series.intervalDays === 0;
    default:
      return false;
  }
}

/** Scheduled dates in [from, to], clamped to the series' own start/end. At most 400 days are scanned. */
export function occurrenceDates(series, from, to) {
  const lo = from > series.startDate ? from : series.startDate;
  const hi = series.endDate && series.endDate < to ? series.endDate : to;
  if (lo > hi) return [];
  const span = Math.min(diffDays(lo, hi), 400);
  const out = [];
  for (let i = 0; i <= span; i++) {
    const d = addDays(lo, i);
    if (matchesRule(series, d)) out.push(d);
  }
  return out;
}

/** First scheduled date on/after `from` (null when the series has ended or never fires again). */
export function nextOccurrenceDate(series, from) {
  const limit = addDays(from, 400);
  const end = series.endDate && series.endDate < limit ? series.endDate : limit;
  return occurrenceDates(series, from, end)[0] || null;
}

/**
 * What to materialize now for one series. Pure; the database does the
 * inserting (idempotently) and the sweep of stale occurrences.
 *   - nothing for paused/ended series;
 *   - every scheduled date from today through today + 14 days;
 *   - plus at most ONE missed occurrence (the most recent before today), only
 *     when it is recent enough (7 days; monthly 31) and not already covered by
 *     an earlier materialization. Older misses are never back-filled.
 * Returns { dates, through } or null when there is nothing to do.
 */
export function planMaterialization(series, today, horizonDays = MATERIALIZE_HORIZON_DAYS) {
  if (series.status !== "active") return null;
  const through = addDays(today, horizonDays);
  if (series.materializedThrough && series.materializedThrough >= through) return null;

  const dates = new Set(occurrenceDates(series, today, through));

  const window = series.recurrence === "monthly" ? MONTHLY_CATCH_UP_DAYS : CATCH_UP_WINDOW_DAYS;
  const missedFrom = addDays(today, -window);
  const lowest = series.materializedThrough ? addDays(series.materializedThrough, 1) : series.startDate;
  const missed = occurrenceDates(series, missedFrom > lowest ? missedFrom : lowest, addDays(today, -1));
  if (missed.length) dates.add(missed[missed.length - 1]);

  return { dates: [...dates].sort(), through };
}

/** Plain-English description of a schedule. */
export function describeRecurrence(s) {
  switch (s.recurrence) {
    case "daily": return "Every day";
    case "weekdays": return "Weekdays";
    case "weekly": return `Weekly on ${s.weekdays.map((d) => WEEKDAY_LABELS[d]).join(", ")}`;
    case "monthly": return `Monthly on day ${s.monthDay}${s.monthDay > 28 ? " (last day in shorter months)" : ""}`;
    case "interval": return `Every ${s.intervalDays} days`;
    default: return "";
  }
}

/** Recurring view rows: each series with its next occurrence (an existing open task if there is one). */
export function selectRecurring(series, tasks, today) {
  return series
    .map((s) => {
      const openOcc = tasks
        .filter((t) => t.seriesId === s.id && isOpen(t) && t.dueDate && t.dueDate >= today)
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
      const next = s.status === "active" ? openOcc?.dueDate || nextOccurrenceDate(s, today) : null;
      return { series: s, next, description: describeRecurrence(s) };
    })
    .sort((a, b) => (a.series.status === "ended") - (b.series.status === "ended") || (a.next || "9999").localeCompare(b.next || "9999") || a.series.title.localeCompare(b.series.title));
}

// ------------------------------------------------------------- suggestions

/** Drop suggestions that already have a task (any status) with the same source key. */
export function filterSuggestions(suggestions, tasks) {
  const used = new Set(tasks.map((t) => t.sourceKey).filter(Boolean));
  const seen = new Set();
  return (suggestions || []).filter((s) => {
    if (!s.key || used.has(s.key) || seen.has(s.key)) return false;
    seen.add(s.key);
    return true;
  });
}

// -------------------------------------------------------------------- misc

/** Where a linked task leads. Returns null when the record is gone (the UI then shows the saved label, unlinked). */
export function resolveLink(task, { leads = [], projects = [], shots = [], contacts = [] } = {}) {
  if (!task.linkType || !task.linkId) return null;
  const pick = { lead: leads, project: projects, shot: shots, contact: contacts }[task.linkType] || [];
  const rec = pick.find((r) => r.id === task.linkId);
  if (!rec) return { type: task.linkType, id: task.linkId, label: task.linkLabel || "Linked record", exists: false };
  const label =
    task.linkType === "lead" ? rec.companyName || rec.company_name || rec.name :
    task.linkType === "project" ? rec.name :
    task.linkType === "shot" ? rec.title :
    rec.name;
  return { type: task.linkType, id: task.linkId, label: label || task.linkLabel || "Linked record", exists: true, record: rec };
}

export function newRequestKey() {
  const a = new Uint8Array(12);
  (globalThis.crypto || { getRandomValues: (x) => x.map(() => Math.floor(Math.random() * 256)) }).getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function describeTaskError(error) {
  const code = error?.code;
  const raw = error?.message || "";
  if (code === "42P01" || code === "PGRST205" || (/studio_tasks|studio_task_series/.test(raw) && /does not exist|schema cache/.test(raw))) {
    return "Tasks aren't set up yet. Apply the tasks migration first.";
  }
  if (code === "P0002" && /task_link_not_found/.test(raw)) return "That linked record no longer exists.";
  if (code === "P0002" && /series_not_found/.test(raw)) return "That recurring task no longer exists.";
  if (code === "22023" && /series_ended/.test(raw)) return "An ended recurring task can't be resumed. Create a new one.";
  if (code === "42501") return "You don't have permission to change that task.";
  return raw && raw.length < 160 ? raw : "Something went wrong with tasks. Please try again.";
}
