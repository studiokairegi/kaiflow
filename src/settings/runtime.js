// Runtime configuration derived from Settings.
//
// Several pieces of the app (empty-record factories, the notification helper, the
// workday maths) are called from places that never receive the settings object.
// Rather than thread a prop through ~20 call sites, the settings page and the app
// shell push the current values here and those helpers read them. This is the same
// pattern the app already used for the notifications on/off flag.
import { DEFAULT_SETTINGS, DEFAULT_INVOICE_PREFIXES, DEFAULT_PLANNER_DEFAULTS, DEFAULT_WORKWEEK, DEFAULT_FOCUS_TIMER, DEFAULT_USER_PREFS, DEFAULT_FOLLOWUP_SCHEDULE, SOUNDS } from "./schema.js";

const state = {
  followupSchedule: DEFAULT_FOLLOWUP_SCHEDULE,
  invoicePrefixes: DEFAULT_INVOICE_PREFIXES,
  plannerDefaults: DEFAULT_PLANNER_DEFAULTS,
  workweek: DEFAULT_WORKWEEK,
  focusTimer: DEFAULT_FOCUS_TIMER,
  pipelinePreset: "full",
  pipelineStageKeys: [],
  paymentTermsDays: 0,
  timezone: "",
  dateFormat: "",
  notifications: { enabled: true, categories: DEFAULT_USER_PREFS.notifyCategories, sound: DEFAULT_USER_PREFS.sound },
  outcomeReasons: DEFAULT_SETTINGS.outcomeReasons,
};

export const runtime = state;

export function applyRuntimeSettings(s) {
  state.followupSchedule = s.followupSchedule;
  state.invoicePrefixes = s.invoicePrefixes;
  state.plannerDefaults = s.plannerDefaults;
  state.workweek = s.workweek;
  state.focusTimer = s.userPrefs.focusTimer;
  state.pipelinePreset = s.defaultPipelinePreset;
  state.pipelineStageKeys = s.defaultPipelineStageKeys;
  state.paymentTermsDays = s.defaultPaymentTermsDays;
  state.timezone = s.timezone;
  state.dateFormat = s.dateFormat;
  state.outcomeReasons = s.outcomeReasons;
  state.notifications = { enabled: s.notificationsEnabled !== false, categories: s.userPrefs.notifyCategories, sound: s.userPrefs.sound };
}

// --- dates ------------------------------------------------------------------
// YYYY-MM-DD for "today" in the studio's chosen timezone (browser timezone if unset).
export function todayInZone(date = new Date(), timeZone = state.timezone) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || undefined, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  } catch {
    const d = date;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
}

// Formats a YYYY-MM-DD string using the chosen date format; falls back to the input.
export function formatIsoDate(iso, fmt = state.dateFormat) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  if (!m || !fmt) return iso;
  const [, y, mo, d] = m;
  if (fmt === "DMY") return `${d}/${mo}/${y}`;
  if (fmt === "MDY") return `${mo}/${d}/${y}`;
  return `${y}-${mo}-${d}`;
}

// --- workweek ---------------------------------------------------------------
export function isWorkday(date, ww = state.workweek) {
  return (ww.days || []).includes(date.getDay());
}
export function workdayTargetSeconds(date, ww = state.workweek) {
  return isWorkday(date, ww) ? Math.round(Number(ww.hoursPerDay) * 3600) : 0;
}

// --- notifications ----------------------------------------------------------
const audioCache = {};
export function playNotificationSound(prefs = state.notifications.sound) {
  if (!prefs || !prefs.enabled || typeof Audio === "undefined") return;
  const def = SOUNDS.find((s) => s.id === prefs.id) || SOUNDS[0];
  try {
    const a = audioCache[def.id] || (audioCache[def.id] = new Audio(def.src));
    a.volume = Math.min(1, Math.max(0, Number(prefs.volume) || 0.6));
    a.currentTime = 0;
    const p = a.play();
    if (p && p.catch) p.catch(() => {}); // autoplay can be blocked until the user interacts; never throw
  } catch { /* a missed chime is not worth an error */ }
}

// Is a category allowed to notify right now? (Master switch AND category switch.)
export function categoryAllowed(category) {
  if (!state.notifications.enabled) return false;
  if (!category) return true;
  return state.notifications.categories[category] !== false;
}

// --- outcome reasons ----------------------------------------------------------
// System defaults stay available unless hidden; custom reasons are appended.
// A reason already saved on a lead is always still valid even if it is later hidden.
export function reasonsFor(kind, defaults, current, reasons = state.outcomeReasons) {
  const g = reasons?.[kind] || { hidden: [], custom: [] };
  const list = [...defaults.filter((r) => r === "Other" || !g.hidden.includes(r)), ...g.custom.filter((r) => !defaults.includes(r))];
  const seen = new Set();
  const out = list.filter((r) => (seen.has(r) ? false : (seen.add(r), true)));
  if (current && !out.includes(current)) out.push(current);
  return out;
}
