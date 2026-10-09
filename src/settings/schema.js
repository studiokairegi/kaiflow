// Settings schema: defaults, row mapping and validation. Pure (no React, no
// Supabase), shared by the form and by tests.
//
// SCOPE REGISTRY: every setting records whether it belongs to the studio, the
// user, or the account. Today one user_settings row holds all of them (teams are
// a roster, not logins), but recording scope per field means a future multi-seat
// model can split the row without rediscovering which is which.

export const DEFAULT_LEAD_CHANNELS = ["Referral", "Cold Email", "Instagram", "Website"];
export const MILESTONE_DEFAULTS = [50, 25, 25];
export const DEFAULT_ARCHIVE_DAYS = { won: 30, lost: 60, no_response: 60, disqualified: 30, closed: 30 };
export const DEFAULT_PAYMENT_METHODS = ["Bank transfer", "PayPal", "Payoneer", "M-Pesa", "Wise", "Cash", "Other"];
export const DEFAULT_INVOICE_PREFIXES = { proforma: "PRO", invoice: "INV", receipt: "REC" };
export const DEFAULT_WORKWEEK = { days: [1, 2, 3, 4, 5], hoursPerDay: 8 };
export const DEFAULT_PLANNER_DEFAULTS = { profitPercent: 25, contingencyPercent: 7, fps: 24 };
export const DEFAULT_FOCUS_TIMER = { workMinutes: 25, breakMinutes: 5, longBreakMinutes: 15, cyclesBeforeLongBreak: 4 };
export const DEFAULT_OUTCOME_REASONS = { lost: { hidden: [], custom: [] }, disqualified: { hidden: [], custom: [] } };
export const SUPPORTED_CURRENCY_SYMBOLS = ["$", "\u00a5", "\u20ac", "\u00a3", "KSh"];

export const MAX_FOLLOWUPS = 6;
export const DEFAULT_FOLLOWUP_COUNT = 2;

// Builds Initial + `count` follow-ups. offsets are the day offsets of the follow-ups.
export function followupScheduleFor(count, offsets = []) {
  const fallback = [3, 7, 14, 21, 30, 45];
  const out = [{ label: "Initial email", dayOffset: 0 }];
  for (let i = 1; i <= count; i += 1) {
    out.push({ label: `Follow-up #${i}`, dayOffset: Number.isInteger(offsets[i - 1]) ? offsets[i - 1] : fallback[i - 1] });
  }
  return out;
}

// New default: Initial + 2 follow-ups (days 0 / 3 / 7).
export const DEFAULT_FOLLOWUP_SCHEDULE = followupScheduleFor(DEFAULT_FOLLOWUP_COUNT, [3, 7]);
// The previous hardcoded default. A saved schedule equal to this was never customised.
export const LEGACY_FOLLOWUP_SCHEDULE = followupScheduleFor(4, [3, 7, 14, 21]);

export function isLegacyDefaultSchedule(schedule) {
  return Array.isArray(schedule) && schedule.length === LEGACY_FOLLOWUP_SCHEDULE.length
    && schedule.every((s, i) => s && s.dayOffset === LEGACY_FOLLOWUP_SCHEDULE[i].dayOffset);
}

export const NOTIFICATION_CATEGORIES = [
  { id: "followups", label: "CRM follow-ups due", hint: "Leads whose next follow-up is due today or overdue." },
  { id: "hotLeads", label: "Hot leads awaiting response", hint: "Hot-priority leads that replied and need you." },
  { id: "proposals", label: "Proposals awaiting response", hint: "Proposals sent and still unanswered." },
  { id: "deadlines", label: "Approaching deadlines", hint: "Leads close to their follow-up deadline." },
  { id: "focus", label: "Focus timer breaks", hint: "Start and end of focus and break sessions." },
  { id: "freelancerUploads", label: "Freelancer uploads", hint: "A freelancer uploads a file to a project." },
];

// Short chimes supplied with the app. Browsers cannot control the OS notification
// sound, so these play only while a Kairil tab is open.
export const SOUNDS = [
  { id: "glass", label: "Glass tap", src: "/sounds/glass-tap.mp3" },
  { id: "water", label: "Water droplet", src: "/sounds/water-drop.mp3" },
];

export const DEFAULT_USER_PREFS = {
  dashboardPeriod: "all",
  notifyCategories: { followups: true, hotLeads: true, proposals: true, deadlines: true, focus: true, freelancerUploads: true },
  sound: { enabled: false, id: "glass", volume: 0.6 },
  focusTimer: DEFAULT_FOCUS_TIMER,
};

export const DATE_FORMATS = [
  { id: "", label: "Browser default" },
  { id: "DMY", label: "31/12/2026 (day first)" },
  { id: "MDY", label: "12/31/2026 (month first)" },
  { id: "ISO", label: "2026-12-31" },
];

export const LANDING_TABS = [
  { id: "dashboard", label: "Dashboard" }, { id: "leads", label: "Leads" }, { id: "planner", label: "Planner" },
  { id: "projects", label: "Projects" }, { id: "teams", label: "Teams" }, { id: "finance", label: "Finance" },
];

export const DEFAULT_SETTINGS = {
  studioName: "Studio Kairegi",
  studioTagline: "Anime-style animation & production",
  studioLegalName: "",
  studioAddress: "",
  studioTaxId: "",
  studioVatStatus: "",
  studioEtimsNumber: "",
  currencySymbol: "$",
  milestoneDefaults: MILESTONE_DEFAULTS,
  defaultLandingTab: "dashboard",
  defaultShotPriority: "normal",
  logoUrl: "",
  leadChannels: DEFAULT_LEAD_CHANNELS,
  followupSchedule: DEFAULT_FOLLOWUP_SCHEDULE,
  autoNoResponse: true,
  archiveDays: DEFAULT_ARCHIVE_DAYS,
  outcomeReasons: DEFAULT_OUTCOME_REASONS,
  dashboardHiddenChannels: [],
  notificationsEnabled: true,
  paymentMethodOptions: DEFAULT_PAYMENT_METHODS,
  timezone: "",
  dateFormat: "",
  workweek: DEFAULT_WORKWEEK,
  defaultPipelinePreset: "full",
  defaultPipelineStageKeys: [],
  plannerDefaults: DEFAULT_PLANNER_DEFAULTS,
  invoicePrefixes: DEFAULT_INVOICE_PREFIXES,
  defaultPaymentTermsDays: 0,
  userPrefs: DEFAULT_USER_PREFS,
  // Privileged / account state. Read from the row, NEVER written by the settings form.
  hasSeenTutorial: false,
  plan: "free",
  isAdmin: false,
};

// --- field registry: scope + which tab owns it (drives the unsaved-changes dots) ---
export const SETTING_REGISTRY = {
  studioName: ["studio", "general"], studioTagline: ["studio", "general"], studioLegalName: ["studio", "general"],
  studioAddress: ["studio", "general"], logoUrl: ["studio", "general"], defaultLandingTab: ["user", "general"],
  timezone: ["user", "general"], dateFormat: ["user", "general"], workweek: ["user", "general"],
  leadChannels: ["studio", "crm"], dashboardHiddenChannels: ["user", "crm"], followupSchedule: ["studio", "crm"],
  autoNoResponse: ["studio", "crm"], archiveDays: ["studio", "crm"], outcomeReasons: ["studio", "crm"],
  defaultShotPriority: ["studio", "production"], defaultPipelinePreset: ["studio", "production"],
  defaultPipelineStageKeys: ["studio", "production"], plannerDefaults: ["studio", "production"],
  paymentMethodOptions: ["studio", "teams"],
  currencySymbol: ["studio", "finance"], milestoneDefaults: ["studio", "finance"], invoicePrefixes: ["studio", "finance"],
  defaultPaymentTermsDays: ["studio", "finance"], studioTaxId: ["studio", "finance"], studioVatStatus: ["studio", "finance"],
  studioEtimsNumber: ["studio", "finance"],
  notificationsEnabled: ["user", "alerts"], userPrefs: ["user", "alerts"],
  hasSeenTutorial: ["account", "account"], plan: ["account", "account"], isAdmin: ["account", "account"],
};

// Tabs whose fields differ between two settings objects.
export function dirtyTabs(base, form) {
  const tabs = new Set();
  for (const [key, [, tab]] of Object.entries(SETTING_REGISTRY)) {
    if (tab === "account") continue;
    if (JSON.stringify(base[key]) !== JSON.stringify(form[key])) tabs.add(tab);
  }
  return tabs;
}

// --- parsing helpers -------------------------------------------------------
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const num = (v, d) => (Number.isFinite(Number(v)) && v !== "" && v !== null ? Number(v) : d);

export function parseSchedule(raw) {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_FOLLOWUPS + 1) return DEFAULT_FOLLOWUP_SCHEDULE;
  const ok = raw.every((s) => s && Number.isInteger(Number(s.dayOffset)) && Number(s.dayOffset) >= 0);
  if (!ok) return DEFAULT_FOLLOWUP_SCHEDULE;
  return raw.map((s, i) => ({ label: i === 0 ? "Initial email" : s.label || `Follow-up #${i}`, dayOffset: Number(s.dayOffset) }));
}

function mergePrefs(raw) {
  const p = isObj(raw) ? raw : {};
  return {
    dashboardPeriod: typeof p.dashboardPeriod === "string" ? p.dashboardPeriod : DEFAULT_USER_PREFS.dashboardPeriod,
    notifyCategories: { ...DEFAULT_USER_PREFS.notifyCategories, ...(isObj(p.notifyCategories) ? p.notifyCategories : {}) },
    sound: { ...DEFAULT_USER_PREFS.sound, ...(isObj(p.sound) ? p.sound : {}) },
    focusTimer: { ...DEFAULT_FOCUS_TIMER, ...(isObj(p.focusTimer) ? p.focusTimer : {}) },
  };
}

export function settingsFromRow(row) {
  if (!row) return DEFAULT_SETTINGS;
  const D = DEFAULT_SETTINGS;
  const reasons = isObj(row.outcome_reasons) ? row.outcome_reasons : {};
  const grp = (k) => ({
    hidden: Array.isArray(reasons[k]?.hidden) ? reasons[k].hidden : [],
    custom: Array.isArray(reasons[k]?.custom) ? reasons[k].custom : [],
  });
  return {
    studioName: row.studio_name || D.studioName,
    studioTagline: row.studio_tagline || D.studioTagline,
    studioLegalName: row.studio_legal_name || "",
    studioAddress: row.studio_address || "",
    studioTaxId: row.studio_tax_id || "",
    studioVatStatus: row.studio_vat_status || "",
    studioEtimsNumber: row.studio_etims_number || "",
    currencySymbol: row.currency_symbol || D.currencySymbol,
    milestoneDefaults: Array.isArray(row.milestone_defaults) && row.milestone_defaults.length === 3 ? row.milestone_defaults : MILESTONE_DEFAULTS,
    defaultLandingTab: row.default_landing_tab || D.defaultLandingTab,
    defaultShotPriority: row.default_shot_priority || D.defaultShotPriority,
    logoUrl: row.logo_url || "",
    leadChannels: Array.isArray(row.lead_channels) && row.lead_channels.length > 0 ? row.lead_channels : DEFAULT_LEAD_CHANNELS,
    followupSchedule: parseSchedule(row.followup_schedule),
    autoNoResponse: row.auto_no_response !== false,
    archiveDays: { ...DEFAULT_ARCHIVE_DAYS, ...(isObj(row.archive_days) ? row.archive_days : {}) },
    outcomeReasons: { lost: grp("lost"), disqualified: grp("disqualified") },
    dashboardHiddenChannels: Array.isArray(row.dashboard_hidden_channels) ? row.dashboard_hidden_channels : [],
    notificationsEnabled: row.notifications_enabled !== false,
    paymentMethodOptions: Array.isArray(row.payment_method_options) && row.payment_method_options.length > 0 ? row.payment_method_options : DEFAULT_PAYMENT_METHODS,
    timezone: row.timezone || "",
    dateFormat: row.date_format || "",
    workweek: isObj(row.workweek)
      ? { days: Array.isArray(row.workweek.days) ? row.workweek.days : DEFAULT_WORKWEEK.days, hoursPerDay: num(row.workweek.hoursPerDay, DEFAULT_WORKWEEK.hoursPerDay) }
      : DEFAULT_WORKWEEK,
    defaultPipelinePreset: row.default_pipeline_preset === "custom" ? "custom" : "full",
    defaultPipelineStageKeys: Array.isArray(row.default_pipeline_stage_keys) ? row.default_pipeline_stage_keys : [],
    plannerDefaults: { ...DEFAULT_PLANNER_DEFAULTS, ...(isObj(row.planner_defaults) ? row.planner_defaults : {}) },
    invoicePrefixes: { ...DEFAULT_INVOICE_PREFIXES, ...(isObj(row.invoice_prefixes) ? row.invoice_prefixes : {}) },
    defaultPaymentTermsDays: num(row.default_payment_terms_days, 0),
    userPrefs: mergePrefs(row.user_prefs),
    hasSeenTutorial: row.has_seen_tutorial || false,
    plan: row.plan || "free",
    isAdmin: row.is_admin || false,
  };
}

// The settings write path. Deliberately omits plan, is_admin and has_seen_tutorial:
// privileged state must never travel through a form save (a trigger also guards it,
// but it should not be in the path at all). The tutorial flag has its own writer.
export function settingsToRow(s, userId) {
  return {
    user_id: userId,
    studio_name: s.studioName,
    studio_tagline: s.studioTagline,
    studio_legal_name: s.studioLegalName || "",
    studio_address: s.studioAddress || "",
    studio_tax_id: s.studioTaxId || "",
    studio_vat_status: s.studioVatStatus || "",
    studio_etims_number: s.studioEtimsNumber || "",
    currency_symbol: s.currencySymbol,
    milestone_defaults: s.milestoneDefaults.map(Number),
    default_landing_tab: s.defaultLandingTab,
    default_shot_priority: s.defaultShotPriority,
    logo_url: s.logoUrl || "",
    lead_channels: s.leadChannels || DEFAULT_LEAD_CHANNELS,
    followup_schedule: s.followupSchedule || DEFAULT_FOLLOWUP_SCHEDULE,
    auto_no_response: s.autoNoResponse !== false,
    archive_days: s.archiveDays || DEFAULT_ARCHIVE_DAYS,
    outcome_reasons: s.outcomeReasons || DEFAULT_OUTCOME_REASONS,
    dashboard_hidden_channels: s.dashboardHiddenChannels || [],
    notifications_enabled: s.notificationsEnabled !== false,
    payment_method_options: Array.isArray(s.paymentMethodOptions) && s.paymentMethodOptions.length > 0 ? s.paymentMethodOptions : DEFAULT_PAYMENT_METHODS,
    timezone: s.timezone || "",
    date_format: s.dateFormat || "",
    workweek: s.workweek || DEFAULT_WORKWEEK,
    default_pipeline_preset: s.defaultPipelinePreset === "custom" ? "custom" : "full",
    default_pipeline_stage_keys: s.defaultPipelineStageKeys || [],
    planner_defaults: s.plannerDefaults || DEFAULT_PLANNER_DEFAULTS,
    invoice_prefixes: s.invoicePrefixes || DEFAULT_INVOICE_PREFIXES,
    default_payment_terms_days: Math.round(Number(s.defaultPaymentTermsDays) || 0),
    user_prefs: s.userPrefs || DEFAULT_USER_PREFS,
  };
}

// --- validation ------------------------------------------------------------
export function isValidTimezone(tz) {
  if (!tz) return true; // empty = follow the browser
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

// Returns { [fieldKey]: message }. Empty object = valid.
export function validateSettings(s) {
  const e = {};
  const inRange = (v, lo, hi) => Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi;
  if (!String(s.studioName || "").trim()) e.studioName = "Studio name can't be empty.";
  if (!SUPPORTED_CURRENCY_SYMBOLS.includes(s.currencySymbol)) e.currencySymbol = "Choose a supported currency.";

  const m = s.milestoneDefaults || [];
  if (m.length !== 3 || m.some((x) => !inRange(x, 0, 100))) e.milestoneDefaults = "Each milestone must be 0-100.";
  else if (Math.round(m.reduce((a, b) => a + Number(b), 0) * 100) / 100 !== 100) e.milestoneDefaults = "Milestones must add up to exactly 100%.";

  const sched = s.followupSchedule || [];
  if (sched.length < 2 || sched.length > MAX_FOLLOWUPS + 1) e.followupSchedule = `Choose 1-${MAX_FOLLOWUPS} follow-ups.`;
  else {
    let prev = -1;
    for (let i = 0; i < sched.length; i += 1) {
      const d = Number(sched[i].dayOffset);
      if (!Number.isInteger(d) || d < 0) { e.followupSchedule = "Follow-up days must be whole numbers, 0 or more."; break; }
      if (i > 0 && d <= prev) { e.followupSchedule = "Each follow-up must come later than the one before."; break; }
      prev = d;
    }
    if (!e.followupSchedule && Number(sched[0].dayOffset) !== 0) e.followupSchedule = "The initial email is day 0.";
  }

  for (const [stage, days] of Object.entries(s.archiveDays || {})) {
    if (!Number.isInteger(Number(days)) || !inRange(days, 1, 3650)) { e.archiveDays = `Archive days must be 1-3650 (check "${stage}").`; break; }
  }

  const p = s.invoicePrefixes || {};
  const vals = Object.values(p);
  if (vals.some((v) => !/^[A-Z0-9]{1,6}$/.test(v || ""))) e.invoicePrefixes = "Prefixes are 1-6 characters, A-Z and 0-9 only.";
  else if (new Set(vals).size !== vals.length) e.invoicePrefixes = "Each document type needs its own prefix.";

  if (!Number.isInteger(Number(s.defaultPaymentTermsDays)) || !inRange(s.defaultPaymentTermsDays, 0, 365)) e.defaultPaymentTermsDays = "Payment terms are 0-365 days.";
  if (!isValidTimezone(s.timezone)) e.timezone = "Not a valid timezone.";

  const w = s.workweek || {};
  if (!inRange(w.hoursPerDay, 0, 24)) e.workweek = "Hours per day must be 0-24.";
  else if (Number(w.hoursPerDay) > 0 && !(w.days || []).length) e.workweek = "Pick at least one working day.";

  const pd = s.plannerDefaults || {};
  if (!inRange(pd.profitPercent, 0, 99)) e.plannerDefaults = "Target profit must be 0-99%.";
  else if (!inRange(pd.contingencyPercent, 0, 100)) e.plannerDefaults = "Safety reserve must be 0-100%.";
  else if (!Number.isInteger(Number(pd.fps)) || !inRange(pd.fps, 1, 240)) e.plannerDefaults = "Frame rate must be a whole number from 1 to 240.";

  const f = (s.userPrefs || {}).focusTimer || {};
  const ft = [["workMinutes", 1, 180], ["breakMinutes", 1, 60], ["longBreakMinutes", 1, 120], ["cyclesBeforeLongBreak", 1, 12]];
  if (ft.some(([k, lo, hi]) => !Number.isInteger(Number(f[k])) || !inRange(f[k], lo, hi))) e.focusTimer = "Focus timer values are out of range (work 1-180, break 1-60, long break 1-120, cycles 1-12).";

  if (s.defaultPipelinePreset === "custom" && !(s.defaultPipelineStageKeys || []).length) e.defaultPipelineStageKeys = "Pick at least one stage for a custom pipeline.";
  if ((s.paymentMethodOptions || []).length === 0) e.paymentMethodOptions = "Keep at least one payment method.";
  return e;
}

// Which tab each error lives on, so the nav can flag it.
export function errorTabs(errors) {
  const tabOf = { focusTimer: "production", ...Object.fromEntries(Object.entries(SETTING_REGISTRY).map(([k, [, t]]) => [k, t])) };
  return new Set(Object.keys(errors).map((k) => tabOf[k] || "general"));
}
