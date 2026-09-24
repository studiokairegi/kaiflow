import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { supabase, functionUrl } from "./supabaseClient";
import { jsPDF } from "jspdf";
import { genShareToken } from "./SharedViews.jsx";
import {
  DonutBreakdown,
  RevenueTrendChart,
  MonthlyFinanceChart,
  RevenueByClientBarChart,
  ProjectComparisonChart,
  LeadOutreachTrendChart,
  HoursTrendChart,
} from "./DashboardCharts.jsx";

const STAGES = [
  { id: "character_design", label: "Character Design" },
  { id: "bg_lighting", label: "BG & Lighting Design" },
  { id: "storyboard", label: "Storyboard" },
  { id: "layout", label: "Layout" },
  { id: "genga", label: "Genga" },
  { id: "douga", label: "Douga" },
  { id: "backgrounds", label: "Backgrounds" },
  { id: "frametest", label: "Frame Test" },
  { id: "cleanup", label: "Cleanup & Color" },
  { id: "compositing", label: "Compositing" },
  { id: "editing", label: "Editing" },
  { id: "delivered", label: "Delivered" },
];

const PRIORITY_COLORS = {
  low: "#7FE0D0",
  normal: "#2FBFA6",
  rush: "#F2A65A",
};

const REVIEW_COLORS = {
  in_progress: "#5C6B70",
  waiting: "#4A90D9",
  approved: "#3DDC84",
  revisions: "#FF4D4D",
};

const REVIEW_LABELS = {
  in_progress: "In Progress",
  waiting: "Waiting Review",
  approved: "Approved",
  revisions: "Requested Revisions",
};

const REVIEW_STATUS_ORDER = ["in_progress", "waiting", "approved", "revisions"];

const FREE_PROJECT_LIMIT = 3;
const FREE_BUDGET_PLANNER_LIMIT = 3;

const PROFIT_PRESETS = [10, 15, 20, 25, 30, 40, 50, 60];

// Direct checkout link for the Pro tier, built from the values pulled out
// of the real checkout URL. Worth a live click-through test since Patreon's
// URL shape isn't officially documented, this is reverse-engineered.
const PATREON_CHECKOUT_URL = "https://www.patreon.com/checkout/11039549?rid=29264433";
const PATREON_MANAGE_URL = "https://www.patreon.com/settings/memberships";

// Active pipeline, in lifecycle order. A lead moves left-to-right through
// these as outreach progresses.
const LEAD_STAGES = [
  { id: "pool", label: "New" },
  { id: "cold_email", label: "Cold Email Sent" },
  { id: "responded", label: "Responded" },
  { id: "qualified", label: "Qualified" },
  { id: "proposal", label: "Proposal Sent" },
  { id: "negotiation", label: "Negotiation" },
  { id: "won", label: "Won" },
];

// Terminal outcomes. A lead lands in exactly one of these when outreach
// ends, instead of continuing through the active pipeline. No Response is
// deliberately separate from Lost: one means "went quiet", the other means
// "said no" or "we walked away".
const LEAD_TERMINAL_STAGES = [
  { id: "no_response", label: "No Response" },
  { id: "lost", label: "Lost" },
  { id: "disqualified", label: "Disqualified" },
  { id: "closed", label: "Closed" },
];

const ALL_LEAD_STAGES = [...LEAD_STAGES, ...LEAD_TERMINAL_STAGES];

// Won behaves as terminal for every business-logic purpose (follow-ups,
// "active leads" counts, manual archive eligibility) even though it lives
// in LEAD_STAGES rather than LEAD_TERMINAL_STAGES - that placement is only
// so the Kanban board renders its column right after Negotiation instead
// of after Lost/Disqualified/Closed. Use this helper for terminal checks
// instead of testing LEAD_TERMINAL_STAGES directly.
function isLeadStageTerminal(stageId) {
  return stageId === "won" || LEAD_TERMINAL_STAGES.some((s) => s.id === stageId);
}

// "Active outreach" for dashboard purposes: everyone already contacted,
// not counting the untouched pool or any terminal outcome. Won is
// excluded - a won deal has converted, it isn't outreach in progress.
const ACTIVE_OUTREACH_STAGE_IDS = ["cold_email", "responded", "qualified", "proposal", "negotiation"];

// Date-range options for the dashboard's outreach funnel (Cold email
// success rate card). `days: null` means "All time" - no lower bound.
const DASHBOARD_PERIOD_OPTIONS = [
  { id: "30d", label: "Last 30 days", days: 30 },
  { id: "90d", label: "Last 90 days", days: 90 },
  { id: "6m", label: "Last 6 months", days: 182 },
  { id: "12m", label: "Last 12 months", days: 365 },
  { id: "all", label: "All time", days: null },
];

// Bare "YYYY-MM-DD" values (email dateSent) parsed via `new Date(str)` read
// as UTC midnight, landing on the previous local calendar day for anyone
// west of UTC - same issue as monthKey above. Activity-log timestamps are
// full ISO strings and parse the same either way, so this guard is safe
// for both.
function parseDashboardDate(dateStr) {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr || "") ? parseLocalDateStr(dateStr) : new Date(dateStr);
}

// True when `dateStr` falls within the last `days` days of `now` (inclusive,
// not in the future). `days: null`/`undefined` always matches - used for the
// "All time" option. A missing/invalid `dateStr` never matches a bounded
// window, since there's nothing to place in it.
function isWithinDashboardPeriod(dateStr, days, now = new Date()) {
  if (days == null) return true;
  if (!dateStr) return false;
  const d = parseDashboardDate(dateStr);
  if (isNaN(d.getTime())) return false;
  const diffDays = (now - d) / 86400000;
  return diffDays >= 0 && diffDays <= days;
}

// True when `dateStr` falls on the same calendar day as `now`. Used for the
// "today" figures (new leads added today, cold emails sent today) which are
// always "today" regardless of whichever funnel period is selected.
function isToday(dateStr, now = new Date()) {
  if (!dateStr) return false;
  const d = parseDashboardDate(dateStr);
  if (isNaN(d.getTime())) return false;
  return d.toDateString() === now.toDateString();
}

const LEAD_PRIORITIES = [
  { id: "hot", label: "Hot", icon: "\u{1F525}" },
  { id: "warm", label: "Warm", icon: "\u{1F7E1}" },
  { id: "cold", label: "Cold", icon: "\u26AA" },
];

// Default cadence for the 4 automatic follow-ups after the initial cold
// email (day 0). Stored per-studio on settings.followupSchedule so the
// timing can be changed without a code change.
const DEFAULT_FOLLOWUP_SCHEDULE = [
  { label: "Initial email", dayOffset: 0 },
  { label: "Follow-up #1", dayOffset: 3 },
  { label: "Follow-up #2", dayOffset: 7 },
  { label: "Follow-up #3", dayOffset: 14 },
  { label: "Follow-up #4", dayOffset: 21 },
];

// How long a terminal lead sits before it's auto-archived. Mirrors the
// defaults enforced server-side in migration_crm_v2.sql; kept here too so
// the UI can explain the policy without a round trip.
const DEFAULT_ARCHIVE_DAYS = {
  won: 30,
  lost: 60,
  no_response: 60,
  disqualified: 30,
  closed: 30,
};

// ---- Outcome reasons (NOT pipeline stages) ----
//
// Deliberately kept separate from LEAD_STAGES/LEAD_TERMINAL_STAGES. A
// stage answers "where is this lead in the pipeline"; a reason answers
// "why did it end up there". Things like "No budget", "Not a fit" or
// "Wrong timing" are reasons, not stages: they describe a qualification
// outcome, not a position in the funnel.
//
// Mixing the two was the mistake this model exists to prevent. If
// "No budget" were a stage, every stage-driven calculation on the
// dashboard (active leads, the outreach funnel, the pipeline donuts,
// the auto-archive policy) would silently start treating a
// disqualification reason as a pipeline position. Reasons live on their
// own field and are invisible to all of that.
//
// The vocabulary below comes straight from the Lead Generation &
// Outreach Playbook - section 5 (Disqualify / Heavily Deprioritize) and
// section 12 (Reply Handling) - so the CRM records the same outcomes the
// playbook already tells you to look for.

// Why a lead was disqualified during qualification, i.e. it was never
// worth pitching in the first place. Playbook section 5.
const DISQUALIFY_REASONS = [
  "No anime aesthetic",
  "Marketing window passed",
  "Release too far out",
  "No marketing-budget signal",
  "No direct developer contact",
  "Hobby project, no commercial intent",
  "No cinematic trailer angle",
  "Large studio, no external need",
  "Major publisher blocker",
  "Protected client - do not pitch",
  "Other",
];

// Why a lead that WAS worth pitching didn't convert. Playbook section 12
// plus the follow-up policy in section 11.
const LOST_REASONS = [
  "No budget",
  "Wrong timing",
  "Already has a trailer",
  "Not a fit",
  "Chose another studio",
  "No longer producing",
  "Not interested",
  "Bad contact / bounced",
  "Do not contact",
  "Other",
];

// Every reason, deduped, for the board's reason filter and for validating
// a reason loaded off an older row.
const ALL_OUTCOME_REASONS = Array.from(new Set([...LOST_REASONS, ...DISQUALIFY_REASONS]));

// Stages an outcome reason is meaningful on. A lead still in active
// outreach hasn't had an outcome yet, so the field stays hidden there
// rather than inviting someone to record a reason for something that
// hasn't happened.
const OUTCOME_REASON_STAGES = ["lost", "disqualified", "closed", "no_response"];

function stageTakesOutcomeReason(stageId) {
  return OUTCOME_REASON_STAGES.includes(stageId);
}

// Disqualified leads get the qualification vocabulary; everything else
// terminal gets the didn't-convert vocabulary.
function outcomeReasonsForStage(stageId) {
  return stageId === "disqualified" ? DISQUALIFY_REASONS : LOST_REASONS;
}

// Starting set of lead channels, editable and extendable per-studio via
// Settings (or inline from the lead editor's "+" button). Stored on
// user_settings so the same list is shared across the CRM board and the
// dashboard breakdown.
const DEFAULT_LEAD_CHANNELS = ["Referral", "Cold Email", "Instagram", "Website"];

function stagePercent(stageId) {
  const index = STAGES.findIndex((s) => s.id === stageId);
  if (index === -1) return 0;
  return Math.round((index / (STAGES.length - 1)) * 100);
}

function projectProgress(projectCards) {
  const delivered = projectCards.filter((c) => c.stage === "delivered").length;
  if (projectCards.length === 0) return { delivered, percent: 0 };
  const total = projectCards.reduce((sum, c) => sum + stagePercent(c.stage), 0);
  const percent = Math.round(total / projectCards.length);
  return { delivered, percent };
}

function emptyCard(stage, projectId, priority = "normal") {
  return {
    projectId,
    title: "",
    client: "",
    rate: "",
    due: "",
    priority,
    notes: "",
    stage,
    reviewStatus: "in_progress",
    revisions: [],
    revisionVersion: 1,
    assignedTo: "",
    assignedPay: "",
    assignedPaid: false,
    shareToken: null,
    attachments: [],
  };
}

function emptyProject(overrides = {}) {
  return {
    name: "",
    client: "",
    clientAddress: "",
    clientTaxId: "",
    notes: "",
    shotCount: "",
    budget: "",
    budgetMode: "manual",
    currency: "$",
    deadline: "",
    priority: "normal",
    archived: false,
    shareEnabled: false,
    shareToken: null,
    driveFolderId: null,
    driveFolderUrl: null,
    driveDeliverablesFolderId: null,
    driveReferencesFolderId: null,
    ...overrides,
  };
}

function parseMoney(value) {
  const num = parseFloat(String(value || "").replace(/[^0-9.-]/g, ""));
  return isNaN(num) ? 0 : num;
}

function formatMoney(value) {
  const num = parseMoney(value);
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function calculateAutoBudget(projectCards) {
  return projectCards.reduce((sum, c) => sum + parseMoney(c.rate), 0);
}

// Once a proforma has a receipt generated from it, or a receipt has a
// final invoice generated from it, the earlier document is superseded -
// it's still kept (and still downloadable) as a record of that stage, but
// its amount must drop out of revenue/budget totals, or the same payment
// would be counted once per document in its chain (proforma + receipt +
// invoice all "paid" would triple-count a single €150 job).
function excludeSupersededInvoices(allInvoices) {
  const supersededIds = new Set(
    allInvoices.filter((inv) => inv.convertedFromId).map((inv) => inv.convertedFromId)
  );
  return allInvoices.filter((inv) => !supersededIds.has(inv.id));
}

function projectBudgetSummary(project, projectCards, allProjectInvoices, fxRates) {
  const totalBudget =
    project.budgetMode === "auto"
      ? calculateAutoBudget(projectCards)
      : parseMoney(project.budget);
  // See excludeSupersededInvoices: without this, a paid proforma that later
  // gets a receipt (and then a final invoice) generated from it would have
  // its amount counted again at every stage of its own document chain.
  const projectInvoices = excludeSupersededInvoices(allProjectInvoices);
  // Invoices can be issued in a different currency than the project itself
  // (multi-currency is a Pro feature elsewhere in the app), so this can't
  // just sum raw amountPaid numbers across invoices - that silently adds
  // e.g. USD and EUR together as if they were the same unit. Each invoice's
  // amountPaid is converted into the project's own currency before summing,
  // using the same live-FX-rate infrastructure the Finance panel already
  // uses for its USD rollups.
  const projectCurrency = project.currency || "$";
  const amountPaid = projectInvoices.reduce(
    (sum, inv) => sum + convertAmount(inv.amountPaid, inv.currency || "$", projectCurrency, fxRates),
    0
  );
  const outstanding = Math.max(0, totalBudget - amountPaid);
  return { totalBudget, amountPaid, outstanding };
}

const DOC_TYPES = [
  { id: "proforma", label: "Proforma" },
  { id: "invoice", label: "Invoice" },
  { id: "receipt", label: "Receipt" },
];
const DOC_TYPE_PREFIX = { proforma: "PRO", invoice: "INV", receipt: "REC" };
const DOC_TYPE_TITLE = { proforma: "Proforma Invoice", invoice: "Invoice", receipt: "Receipt" };

function emptyLineItem() {
  return { id: genShareToken(), description: "", qty: "1", unitPrice: "" };
}

function lineItemsTotal(lineItems) {
  return (lineItems || []).reduce((sum, li) => sum + parseMoney(li.qty) * parseMoney(li.unitPrice), 0);
}

// The trailing part of a document number after its first "-" is the
// shared series - "2026-001" in "PRO-2026-001", or "0004" in "INV-0004".
// Swapping just the prefix keeps a proforma, its receipt, and its final
// invoice referencing the same document, the way an accountant expects,
// instead of jumping to an unrelated number each time the type changes.
function docSeries(number) {
  const s = String(number || "");
  const i = s.indexOf("-");
  return i === -1 ? s : s.slice(i + 1);
}

function numberForDocType(existingNumber, docType) {
  const series = docSeries(existingNumber);
  const prefix = DOC_TYPE_PREFIX[docType] || DOC_TYPE_PREFIX.invoice;
  return series ? `${prefix}-${series}` : "";
}

function emptyInvoice(projectId, suggestedNumber, currency = "$", docType = "invoice") {
  return {
    projectId,
    invoiceNumber: suggestedNumber,
    docType,
    description: "",
    lineItems: [],
    amountMode: "manual",
    amount: "",
    amountPaid: "",
    currency,
    issueDate: new Date().toISOString().slice(0, 10),
    dueDate: "",
    status: "unpaid",
    paidDate: "",
    convertedFromId: null,
  };
}

function invoiceFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    invoiceNumber: row.invoice_number,
    docType: row.doc_type || "invoice",
    description: row.description,
    lineItems: Array.isArray(row.line_items) ? row.line_items : [],
    amountMode: row.amount_mode || "manual",
    amount: row.amount,
    amountPaid: row.amount_paid,
    currency: row.currency || "$",
    issueDate: row.issue_date,
    dueDate: row.due_date,
    status: row.status,
    paidDate: row.paid_date || "",
    convertedFromId: row.converted_from_id || null,
  };
}

function invoiceToRow(invoice, userId) {
  // Line items are the source of truth for the amount when that mode is
  // on - recomputed here (not just trusted from the form) so a saved
  // invoice's amount can never drift out of sync with its own line items,
  // regardless of what UI state produced the save.
  const amount =
    invoice.amountMode === "items" ? lineItemsTotal(invoice.lineItems) : parseMoney(invoice.amount);
  return {
    project_id: invoice.projectId,
    invoice_number: invoice.invoiceNumber,
    doc_type: invoice.docType || "invoice",
    description: invoice.description,
    line_items: invoice.amountMode === "items" ? invoice.lineItems || [] : [],
    amount_mode: invoice.amountMode || "manual",
    amount,
    amount_paid: parseMoney(invoice.amountPaid),
    currency: invoice.currency || "$",
    issue_date: invoice.issueDate,
    due_date: invoice.dueDate,
    status: invoice.status,
    paid_date: invoice.paidDate || "",
    converted_from_id: invoice.convertedFromId || null,
    user_id: userId,
  };
}

function nextInvoiceNumber(existingInvoices, docType = "invoice") {
  const prefix = DOC_TYPE_PREFIX[docType] || DOC_TYPE_PREFIX.invoice;
  const max = existingInvoices.reduce((m, inv) => {
    const match = String(inv.invoiceNumber || "").match(/(\d+)$/);
    const n = match ? parseInt(match[1], 10) : 0;
    return Math.max(m, n);
  }, 0);
  return `${prefix}-${String(max + 1).padStart(4, "0")}`;
}

function nextInvoiceNumbers(existingInvoices, count, docType = "invoice") {
  const prefix = DOC_TYPE_PREFIX[docType] || DOC_TYPE_PREFIX.invoice;
  const max = existingInvoices.reduce((m, inv) => {
    const match = String(inv.invoiceNumber || "").match(/(\d+)$/);
    const n = match ? parseInt(match[1], 10) : 0;
    return Math.max(m, n);
  }, 0);
  return Array.from({ length: count }, (_, i) => `${prefix}-${String(max + i + 1).padStart(4, "0")}`);
}

const CURRENCIES = [
  { code: "USD", symbol: "$", label: "USD ($)" },
  { code: "JPY", symbol: "\u00a5", label: "JPY (\u00a5)" },
  { code: "EUR", symbol: "\u20ac", label: "EUR (\u20ac)" },
  { code: "GBP", symbol: "\u00a3", label: "GBP (\u00a3)" },
  { code: "KES", symbol: "KSh", label: "KES (KSh)" },
];

const CURRENCY_CODE_BY_SYMBOL = CURRENCIES.reduce((map, c) => {
  map[c.symbol] = c.code;
  return map;
}, {});

const FX_CACHE_KEY = "kairil-fx-rates";
const FX_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours

async function fetchExchangeRates() {
  try {
    const cached = localStorage.getItem(FX_CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Date.now() - parsed.fetchedAt < FX_CACHE_MAX_AGE_MS) {
        return parsed;
      }
    }
  } catch (e) {
    // ignore cache read errors, fall through to a fresh fetch
  }
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD");
    const data = await res.json();
    if (data.result !== "success") throw new Error("Exchange rate fetch failed");
    const payload = {
      rates: data.rates,
      fetchedAt: Date.now(),
      updatedAt: data.time_last_update_utc || null,
    };
    try {
      localStorage.setItem(FX_CACHE_KEY, JSON.stringify(payload));
    } catch (e) {
      // storage full or unavailable, not critical, we still return live data
    }
    return payload;
  } catch (e) {
    console.error("Exchange rate fetch failed:", e);
    return { rates: {}, fetchedAt: Date.now(), updatedAt: null, error: true };
  }
}

// Converts an amount in a given currency symbol into USD using live rates.
// Falls back to returning the amount unconverted if the rate is unavailable,
// rather than silently producing a wrong number.
function convertToUSD(amount, currencySymbol, fxRates) {
  const value = parseMoney(amount);
  const code = CURRENCY_CODE_BY_SYMBOL[currencySymbol] || "USD";
  if (code === "USD") return value;
  const rate = fxRates?.[code];
  if (!rate) return value;
  return value / rate;
}

// Converts an amount from one currency symbol to another via USD as the
// pivot (fxRates is USD-based: units of `code` per 1 USD). Used for project
// budget summaries, where invoices can be issued in a different currency
// than the project itself - see projectBudgetSummary below. Falls back to
// the unconverted amount if either currency's rate is unavailable, same as
// convertToUSD, rather than producing a number that's silently wrong.
function convertAmount(amount, fromSymbol, toSymbol, fxRates) {
  if (fromSymbol === toSymbol) return parseMoney(amount);
  const usd = convertToUSD(amount, fromSymbol, fxRates);
  const toCode = CURRENCY_CODE_BY_SYMBOL[toSymbol] || "USD";
  if (toCode === "USD") return usd;
  const rate = fxRates?.[toCode];
  if (!rate) return usd;
  return usd * rate;
}

const MILESTONE_LABELS = ["Upfront payment", "Mid-project payment", "Delivery payment"];
const MILESTONE_DEFAULTS = [50, 25, 25];

const EXPENSE_CATEGORIES = [
  "Animator Payments",
  "Background Artist Payments",
  "Software",
  "Hardware",
  "Internet",
  "Rent",
  "Utilities",
  "Marketing",
  "Office Costs",
  "Miscellaneous",
];

function emptyExpense(projectId = null, overrides = {}) {
  return {
    projectId,
    category: EXPENSE_CATEGORIES[0],
    description: "",
    amount: "",
    currency: "$",
    date: new Date().toISOString().slice(0, 10),
    ...overrides,
  };
}

function expenseFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    category: row.category,
    description: row.description,
    amount: row.amount,
    currency: row.currency || "$",
    date: row.date,
  };
}

function expenseToRow(expense, userId) {
  return {
    project_id: expense.projectId || null,
    category: expense.category,
    description: expense.description,
    amount: parseMoney(expense.amount),
    currency: expense.currency || "$",
    date: expense.date,
    user_id: userId,
  };
}

const PLANNER_STATUSES = [
  { id: "draft", label: "Draft" },
  { id: "proposal_sent", label: "Proposal Sent" },
  { id: "negotiating", label: "Negotiating" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Rejected" },
  { id: "converted", label: "Converted to Project" },
];

const PLANNER_STATUS_LABELS = PLANNER_STATUSES.reduce((map, s) => {
  map[s.id] = s.label;
  return map;
}, {});

// Departments used for Phase 4 department-budget distribution. Percentages
// are defaults only, the user can override every one of them per plan.
const PLANNER_DEPARTMENTS = [
  { id: "preproduction", label: "Pre-production", defaultPercent: 5 },
  { id: "storyboard", label: "Storyboard / Animatic", defaultPercent: 8 },
  { id: "character_design", label: "Character Design", defaultPercent: 8 },
  { id: "backgrounds", label: "Background Art", defaultPercent: 11 },
  { id: "layout", label: "Layout", defaultPercent: 10 },
  { id: "key_animation", label: "Key Animation", defaultPercent: 27 },
  { id: "cleanup", label: "In-between / Cleanup", defaultPercent: 13 },
  { id: "compositing", label: "Compositing", defaultPercent: 10 },
  { id: "editing", label: "Editing", defaultPercent: 5 },
  { id: "sound", label: "Sound", defaultPercent: 3 },
];

const CREW_RATE_TYPES = [
  { id: "per_shot", label: "Per shot" },
  { id: "per_second", label: "Per second" },
  { id: "per_hour", label: "Per hour" },
  { id: "per_day", label: "Per day" },
  { id: "fixed", label: "Fixed project fee" },
];

const CREW_AVAILABILITY_OPTIONS = [
  { id: "available", label: "Available" },
  { id: "partial", label: "Partially available" },
  { id: "unavailable", label: "Unavailable" },
];

// Maps a Team roster member onto a Planner crew-row shape. This is a
// snapshot, not a live reference: everything copied here stays editable
// per-plan afterward (a studio owner might pay someone a different rate
// on a rush job), but starting from the roster means the skill/dependability/
// capacity data entered once in Team doesn't have to be retyped by hand
// for every plan. teamMemberId is kept only so the row can show it's linked
// and so a "resync from roster" action is possible later - it's never
// required and a manually-typed row works exactly as before.
const TEAM_TO_CREW_RATE_TYPE = { hour: "per_hour", day: "per_day", shot: "per_shot", second: "per_second", fixed: "fixed" };
const TEAM_TO_CREW_AVAILABILITY = { available: "available", busy: "partial", unavailable: "unavailable" };
// TEAM_DEPARTMENT_OPTIONS stores full labels ("Character Design"),
// PLANNER_DEPARTMENTS keys off short ids ("character_design") - these are
// two independently-built lists (Team roster vs. Planner), not the same
// list twice, so a roster department has to be translated to the
// matching Planner id rather than passed through as-is. "Other" (Team's
// catch-all) has no Planner equivalent, and anything else unrecognized
// doesn't have a safe default either: silently dropping the member into
// Pre-production (or any real department) would misclassify them for
// department-level reporting with no visible sign anything was wrong.
// "unmapped" is a sentinel, not a real Planner department - it's
// deliberately left out of PLANNER_DEPARTMENTS so nothing budget-related
// picks it up, and the crew-row department dropdown surfaces it
// explicitly so a person makes a real choice instead of it hiding as a
// normal-looking department.
const TEAM_TO_PLANNER_DEPARTMENT = {
  "Pre-production": "preproduction",
  "Storyboard / Animatic": "storyboard",
  "Character Design": "character_design",
  "Background Art": "backgrounds",
  "Layout": "layout",
  "Key Animation": "key_animation",
  "In-between / Cleanup": "cleanup",
  "Compositing": "compositing",
  "Editing": "editing",
  "Sound": "sound",
};
function crewRowFromTeamMember(tm) {
  return {
    id: `c${Date.now()}`,
    teamMemberId: tm.id,
    name: tm.name || "",
    role: tm.role || "",
    department: TEAM_TO_PLANNER_DEPARTMENT[tm.department] || "unmapped",
    rateType: TEAM_TO_CREW_RATE_TYPE[tm.rateType] || "per_hour",
    rate: tm.rateAmount ? String(tm.rateAmount) : "",
    units: "",
    skillLevel: tm.skillLevel || 3,
    dependability: tm.dependabilityScore ?? 75,
    availability: TEAM_TO_CREW_AVAILABILITY[tm.availability] || "available",
    // Team's capacity is a general weekly/monthly figure (capacityValue +
    // capacityUnit, e.g. "40 hours/week"); the Planner's capacityUnits is
    // this plan's own cap, a different, plan-specific number. The roster
    // value is only a sensible starting point here, not the same field -
    // still fully editable, same as everything else on the row.
    capacityUnits: tm.capacityValue ? String(tm.capacityValue) : "",
    // When this row was snapshotted from the roster (brief §22) - used
    // only to detect that the roster has since changed, never re-read
    // live. The Planner explicitly does NOT become a live view of Team
    // data; see the staleness check in PlannerWorkspace below.
    snapshotAt: new Date().toISOString(),
  };
}

const SKILL_LEVELS = [
  { value: 1, label: "1 · Beginner" },
  { value: 2, label: "2 · Junior" },
  { value: 3, label: "3 · Intermediate" },
  { value: 4, label: "4 · Senior" },
  { value: 5, label: "5 · Expert" },
];

// Compares a saved crew row against what crewRowFromTeamMember would
// produce from the roster TODAY, without ever writing anything back
// automatically (brief §22: Planner stays a deliberate snapshot, not a
// live view). Returns null when there's nothing to say (row isn't linked
// to a roster member, or that member no longer exists) - otherwise a
// { archived, diffs } summary for the UI to show a "changed since" note
// and let the user apply specific fields, one at a time, on request.
const CREW_STALENESS_FIELDS = [
  ["name", "Name"],
  ["role", "Role"],
  ["department", "Department"],
  ["rateType", "Rate type"],
  ["rate", "Rate"],
  ["skillLevel", "Skill level"],
  ["dependability", "Dependability"],
  ["availability", "Availability"],
  ["capacityUnits", "Capacity"],
];
function computeCrewStaleness(row, teamMembers) {
  if (!row.teamMemberId) return null;
  const tm = (teamMembers || []).find((m) => m.id === row.teamMemberId);
  if (!tm) return null;
  const fresh = crewRowFromTeamMember(tm);
  const diffs = CREW_STALENESS_FIELDS.filter(([field]) => String(fresh[field]) !== String(row[field] ?? "")).map(
    ([field, label]) => ({ field, label, newValue: fresh[field] })
  );
  return { archived: tm.status === "archived", diffs };
}

// Phase 3 — built-in starting templates. These are not stored server-side;
// a user's own saved templates (Phase 11) live in planner_templates and are
// merged with this list when picking a starting point for a new plan.
const BUILT_IN_PLANNER_TEMPLATES = [
  {
    id: "builtin_anime_trailer",
    builtin: true,
    name: "Anime Trailer",
    projectType: "Anime Trailer",
    targetProfitPercent: 25,
    departmentAllocations: null, // falls back to PLANNER_DEPARTMENTS defaults
    scope: { complexity: "medium", targetFps: 24 },
  },
  {
    id: "builtin_anime_short",
    builtin: true,
    name: "Anime Short",
    projectType: "Anime Short",
    targetProfitPercent: 25,
    departmentAllocations: null,
    scope: { complexity: "medium", targetFps: 24 },
  },
  {
    id: "builtin_commercial",
    builtin: true,
    name: "Commercial",
    projectType: "Commercial",
    targetProfitPercent: 30,
    departmentAllocations: {
      preproduction: 8, storyboard: 10, character_design: 4, backgrounds: 10,
      layout: 8, key_animation: 20, cleanup: 12, compositing: 15, editing: 8, sound: 5,
    },
    scope: { complexity: "low", targetFps: 24 },
  },
  {
    id: "builtin_music_video",
    builtin: true,
    name: "Music Video",
    projectType: "Music Video",
    targetProfitPercent: 25,
    departmentAllocations: {
      preproduction: 5, storyboard: 8, character_design: 6, backgrounds: 14,
      layout: 8, key_animation: 22, cleanup: 12, compositing: 14, editing: 6, sound: 5,
    },
    scope: { complexity: "medium", targetFps: 24 },
  },
  {
    id: "builtin_game_trailer",
    builtin: true,
    name: "Game Trailer",
    projectType: "Game Trailer",
    targetProfitPercent: 30,
    departmentAllocations: {
      preproduction: 5, storyboard: 7, character_design: 8, backgrounds: 8,
      layout: 7, key_animation: 25, cleanup: 12, compositing: 16, editing: 6, sound: 6,
    },
    scope: { complexity: "high", targetFps: 24 },
  },
  {
    id: "builtin_custom",
    builtin: true,
    name: "Custom",
    projectType: "",
    targetProfitPercent: 25,
    departmentAllocations: null,
    scope: {},
  },
];

function defaultDepartmentAllocations() {
  return PLANNER_DEPARTMENTS.reduce((map, d) => {
    map[d.id] = d.defaultPercent;
    return map;
  }, {});
}

function emptyBudgetPlanner(overrides = {}) {
  return {
    name: "",
    clientName: "",
    projectType: "",
    budget: "",
    currency: "$",
    targetProfitPercent: 25,
    notes: "",
    status: "draft",
    deadline: "",
    startDate: "",
    contingencyPercent: 7,
    departmentAllocations: defaultDepartmentAllocations(),
    crew: [],
    scope: {
      complexity: "medium",
      durationSeconds: "",
      estimatedShots: "",
      characters: "",
      backgrounds: "",
      targetFps: 24,
    },
    templateId: null,
    convertedProjectId: null,
    ...overrides,
  };
}

function budgetPlannerFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    clientName: row.client_name || "",
    projectType: row.project_type || "",
    budget: row.budget,
    currency: row.currency || "$",
    targetProfitPercent: row.target_profit_percent,
    notes: row.notes || "",
    status: row.status || "draft",
    deadline: row.deadline || "",
    startDate: row.start_date || "",
    contingencyPercent: row.contingency_percent ?? 7,
    departmentAllocations: row.department_allocations || defaultDepartmentAllocations(),
    crew: row.crew || [],
    scope: row.scope || { complexity: "medium" },
    templateId: row.template_id || null,
    convertedProjectId: row.converted_project_id || null,
    createdAt: row.created_at,
  };
}

function budgetPlannerToRow(plan, userId) {
  return {
    name: plan.name || "Untitled plan",
    client_name: plan.clientName,
    project_type: plan.projectType,
    budget: parseMoney(plan.budget),
    currency: plan.currency || "$",
    target_profit_percent: parseMoney(plan.targetProfitPercent),
    notes: plan.notes,
    status: plan.status || "draft",
    deadline: plan.deadline || null,
    start_date: plan.startDate || null,
    contingency_percent: parseMoney(plan.contingencyPercent),
    department_allocations: plan.departmentAllocations || defaultDepartmentAllocations(),
    crew: plan.crew || [],
    scope: plan.scope || {},
    template_id: plan.templateId || null,
    converted_project_id: plan.convertedProjectId || null,
    user_id: userId,
  };
}

function plannerTemplateFromRow(row) {
  return {
    id: row.id,
    builtin: false,
    name: row.name,
    projectType: row.project_type || "",
    targetProfitPercent: row.target_profit_percent,
    departmentAllocations: row.department_allocations || null,
    crew: row.crew || [],
    scope: row.scope || {},
    createdAt: row.created_at,
  };
}

function plannerTemplateToRow(template, userId) {
  return {
    name: template.name || "Untitled template",
    project_type: template.projectType || "",
    target_profit_percent: parseMoney(template.targetProfitPercent),
    department_allocations: template.departmentAllocations || null,
    crew: template.crew || [],
    scope: template.scope || {},
    user_id: userId,
  };
}

// Phase 5: live recalculation, this is the math the whole planner hinges on.
// Budget is treated as the client-facing price; production budget is what's
// left to actually spend once the target profit is carved out.
function computeBudgetPlan(plan) {
  const budget = parseMoney(plan.budget);
  const profitPercent = parseMoney(plan.targetProfitPercent);
  const profit = budget * (profitPercent / 100);
  const productionBudget = budget - profit;
  let health = "green";
  if (profitPercent < 10) health = "red";
  else if (profitPercent < 20) health = "yellow";
  return { budget, profitPercent, profit, productionBudget, health };
}

// ---------------------------------------------------------------------------
// Planner Intelligence (spec: planner_i.txt / planner_crew_allocation.txt)
// Deterministic, rule-based only. No AI. Every function here is small,
// pure, and traceable back to the inputs that produced its output so the
// UI can always explain *why* a warning fired.
// ---------------------------------------------------------------------------

// 1. Financial health — actual planned margin vs target, using real crew +
// department costs when available instead of the flat target-only estimate.
function computePlannerFinancialHealth(plan, totalCrewCost) {
  const budget = parseMoney(plan.budget);
  const targetProfitPercent = parseMoney(plan.targetProfitPercent);
  const expectedProfit = budget * (targetProfitPercent / 100);
  const productionBudget = budget - expectedProfit;
  const plannedCosts = totalCrewCost; // crew is the concrete planned cost we know about
  const actualMargin = budget > 0 ? ((budget - plannedCosts) / budget) * 100 : 0;
  const compareMargin = Math.max(targetProfitPercent, 20);
  let state = "green";
  if (actualMargin < 10) state = "red";
  else if (actualMargin < 20) state = "yellow";
  const meetsTarget = actualMargin >= targetProfitPercent;
  return {
    budget,
    targetProfitPercent,
    expectedProfit,
    productionBudget,
    actualMargin,
    state,
    meetsTarget,
    differencePoints: actualMargin - targetProfitPercent,
    compareMargin,
  };
}

// 2. Department allocation intelligence
function computeAllocationState(departmentAllocations) {
  const totalPercent = Object.values(departmentAllocations || {}).reduce(
    (sum, v) => sum + parseMoney(v),
    0
  );
  const rounded = Math.round(totalPercent * 100) / 100;
  if (rounded > 100) return { totalPercent: rounded, state: "over", diffPercent: rounded - 100 };
  if (rounded < 100) return { totalPercent: rounded, state: "under", diffPercent: 100 - rounded };
  return { totalPercent: rounded, state: "exact", diffPercent: 0 };
}

// 3. Contingency intelligence
function recommendedContingencyPercent(complexity) {
  if (complexity === "high" || complexity === "very_high") return 10;
  if (complexity === "medium") return 7.5;
  return 5;
}

function computeContingencyState(contingencyPercent, complexity) {
  const recommended = recommendedContingencyPercent(complexity);
  const value = parseMoney(contingencyPercent);
  if (value <= 0) return { state: "none", recommended, value };
  if (value < recommended) return { state: "below", recommended, value };
  return { state: "ok", recommended, value };
}

// 4/12. Crew cost calculation + ratio
function computeCrewMemberCost(person) {
  const rate = parseMoney(person.rate);
  const units = parseMoney(person.units);
  if (person.rateType === "fixed") return rate;
  return rate * units;
}

function computeTotalCrewCost(crew) {
  return (crew || []).reduce((sum, p) => sum + computeCrewMemberCost(p), 0);
}

function computeCrewCostRatio(totalCrewCost, productionBudget) {
  const ratio = productionBudget > 0 ? (totalCrewCost / productionBudget) * 100 : 0;
  let state = "healthy";
  if (ratio > 75) state = "critical";
  else if (ratio > 60) state = "watch";
  return { ratio, state };
}

// ---------------------------------------------------------------------------
// Crew allocation intelligence (spec: planner_crew_allocation.txt)
// Deterministic scoring + explanation per crew member — not a full
// combinatorial optimizer, but every score is traceable to the same inputs
// the spec calls out: skill fit, availability, dependability, deadline
// pressure and cost.
// ---------------------------------------------------------------------------

function dependabilityLabel(value) {
  const v = parseMoney(value);
  if (v >= 90) return { label: "Highly dependable", tier: "high" };
  if (v >= 75) return { label: "Reliable", tier: "good" };
  if (v >= 60) return { label: "Variable", tier: "watch" };
  return { label: "Risky", tier: "risk" };
}

// Overload check (spec section 16): assigned units vs the person's declared
// capacity for this plan.
function computeCrewCapacityState(person) {
  const capacity = parseMoney(person.capacityUnits);
  const assigned = parseMoney(person.units);
  if (!capacity) return { state: "unknown" };
  if (assigned > capacity) return { state: "over", overBy: assigned - capacity };
  return { state: "ok" };
}

// Deadline weighting (spec section 10/14): which factors matter most
// changes with how tight the schedule is.
function deadlineWeighting(deadlineRiskState) {
  if (deadlineRiskState === "risk") {
    return { availability: 3, speed: 3, dependability: 2.5, skill: 1.5, cost: 0.5 };
  }
  if (deadlineRiskState === "tight") {
    return { availability: 2, speed: 2, skill: 1.5, dependability: 1.5, cost: 1 };
  }
  return { availability: 1, speed: 1, skill: 1.5, dependability: 1, cost: 1.5 }; // comfortable/unknown
}

// A single crew member's fit score for this plan + a human-readable
// explanation, in the spirit of spec section 23 ("Recommended: Jane —
// strong match because...") rather than an opaque number.
function computeCrewMemberFit(person, deadlineRiskState) {
  const weights = deadlineWeighting(deadlineRiskState);
  const skill = parseMoney(person.skillLevel) || 3;
  const dependability = parseMoney(person.dependability) || 75;
  const availability = person.availability || "available";
  const dep = dependabilityLabel(dependability);
  const capacity = computeCrewCapacityState(person);

  let score = 0;
  const reasons = [];

  if (availability === "available") { score += weights.availability * 20; reasons.push({ type: "ok", text: "Available for the project" }); }
  else if (availability === "partial") { score += weights.availability * 10; reasons.push({ type: "warn", text: "Only partially available" }); }
  else { reasons.push({ type: "warn", text: "Marked unavailable" }); }

  score += weights.skill * (skill * 4);
  reasons.push({ type: "ok", text: `Skill level ${skill}/5` });

  score += weights.dependability * (dependability / 5);
  reasons.push({ type: dep.tier === "risk" ? "warn" : "ok", text: `${dep.label} (${dependability}/100)` });

  if (capacity.state === "over") {
    score -= 15;
    reasons.push({ type: "warn", text: `Exceeds declared capacity by ${capacity.overBy} unit(s)` });
  }

  const cost = computeCrewMemberCost(person);
  if (cost > 0) score += weights.cost * Math.max(0, 20 - Math.log2(cost + 1));

  return { score: Math.round(score), reasons, capacity, dependabilityInfo: dep };
}

// 5. Double-spending detection between a department's allocation and the
// crew cost assigned to that same department.
function computeDepartmentSpend(plan, productionBudget) {
  const allocations = plan.departmentAllocations || {};
  const crew = plan.crew || [];
  return PLANNER_DEPARTMENTS.map((dept) => {
    const allocatedAmount = (parseMoney(allocations[dept.id]) / 100) * productionBudget;
    const crewCost = crew
      .filter((p) => p.department === dept.id)
      .reduce((sum, p) => sum + computeCrewMemberCost(p), 0);
    let state = "ok";
    if (allocatedAmount > 0 && crewCost > allocatedAmount) state = "over";
    else if (allocatedAmount > 0 && crewCost >= allocatedAmount * 0.9) state = "close";
    return { ...dept, allocatedAmount, crewCost, state };
  });
}

// 7/10. Production complexity score (transparent, additive)
function computeComplexityScore(scope) {
  let score = 1;
  const factors = [];
  const shotsPerSecond = scopeShotsPerSecond(scope);
  if (shotsPerSecond !== null && shotsPerSecond > 3) {
    score += 0.5;
    factors.push("High shot density (>3 shots/sec)");
  }
  if (parseMoney(scope.characters) > 1) {
    score += 0.5;
    factors.push("Multiple main characters");
  }
  if (scope.complexMovement) {
    score += 0.5;
    factors.push("Complex character movement");
  }
  const bgPerSecond = scopeBackgroundsPerSecond(scope);
  if (bgPerSecond !== null && bgPerSecond > 0.5) {
    score += 0.5;
    factors.push("High background count relative to duration");
  }
  if (scope.heavyEffects) {
    score += 0.5;
    factors.push("Heavy effects work");
  }
  if (scope.cameraMovement) {
    score += 0.5;
    factors.push("Significant camera movement");
  }
  if (scope.dialogueHeavy) {
    score += 0.5;
    factors.push("Dialogue-heavy");
  }
  let label = "Low";
  if (score >= 4) label = "Very High";
  else if (score >= 3) label = "High";
  else if (score >= 2) label = "Medium";
  return { score, label, factors };
}

function scopeShotsPerSecond(scope) {
  const shots = parseMoney(scope.estimatedShots);
  const duration = parseMoney(scope.durationSeconds);
  if (!shots || !duration) return null;
  return shots / duration;
}

function scopeBackgroundsPerSecond(scope) {
  const backgrounds = parseMoney(scope.backgrounds);
  const duration = parseMoney(scope.durationSeconds);
  if (!backgrounds || !duration) return null;
  return backgrounds / duration;
}

// 11. Timeline intelligence — transparent phase-by-phase estimate, in
// production days, driven only by shots/complexity/crew size the user
// entered. Always labelled as a starting point, never a promise.
const TIMELINE_PHASES = [
  { id: "preproduction", label: "Pre-production", baseShare: 0.08 },
  { id: "storyboard", label: "Storyboard / Animatic", baseShare: 0.1 },
  { id: "design", label: "Design", baseShare: 0.08 },
  { id: "layout", label: "Layout", baseShare: 0.1 },
  { id: "animation", label: "Animation", baseShare: 0.28 },
  { id: "cleanup", label: "Cleanup", baseShare: 0.14 },
  { id: "backgrounds", label: "Backgrounds", baseShare: 0.08 },
  { id: "compositing", label: "Compositing", baseShare: 0.08 },
  { id: "editing", label: "Editing", baseShare: 0.04 },
  { id: "review", label: "Review / Revisions", baseShare: 0.02 },
];

function computeTimelineEstimate(scope, crewCount) {
  const shots = parseMoney(scope.estimatedShots) || 0;
  const complexity = computeComplexityScore(scope).score;
  const crew = Math.max(1, crewCount || 1);
  // Base rule: ~0.6 production days per shot at complexity 1, scaled by
  // complexity, then divided across available crew with diminishing
  // returns (sqrt) since more people rarely means linear speedup.
  const baseDaysPerShot = 0.6 * complexity;
  const rawDays = shots > 0 ? shots * baseDaysPerShot : 10 * complexity;
  const estimatedDays = Math.max(3, Math.round(rawDays / Math.sqrt(crew)));
  const phases = TIMELINE_PHASES.map((phase) => ({
    ...phase,
    days: Math.max(1, Math.round(estimatedDays * phase.baseShare)),
  }));
  return { estimatedDays, phases };
}

// 12/13. Deadline risk
function computeDeadlineRisk(estimatedDays, availableDays) {
  if (availableDays === null || availableDays === undefined) return { state: "unknown" };
  if (availableDays >= estimatedDays * 1.2) return { state: "healthy", estimatedDays, availableDays };
  if (availableDays >= estimatedDays) return { state: "tight", estimatedDays, availableDays };
  return { state: "risk", estimatedDays, availableDays };
}

function daysBetween(startDate, endDate) {
  if (!startDate || !endDate) return null;
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (isNaN(start) || isNaN(end)) return null;
  return Math.round((end - start) / (1000 * 60 * 60 * 24));
}

// 15. Minimum viable price
function computeMinimumPrice(estimatedProductionCosts, targetMarginPercent) {
  const margin = parseMoney(targetMarginPercent) / 100;
  if (margin >= 1 || margin < 0) return null;
  return estimatedProductionCosts / (1 - margin);
}

// 20. Overall deal score — deterministic, always explained.
function computeDealScore(plan, derived) {
  const reasons = [];
  let score = 100;

  if (derived.financial.actualMargin < derived.financial.targetProfitPercent) {
    score -= 15;
    reasons.push({ type: "warn", text: "Below target profit margin" });
  } else {
    reasons.push({ type: "ok", text: "Profit target met" });
  }

  if (derived.allocation.state === "over") {
    score -= 20;
    reasons.push({ type: "warn", text: `Department budget overallocated by ${derived.allocation.diffPercent.toFixed(1)}%` });
  } else if (derived.allocation.state === "under") {
    score -= 5;
    reasons.push({ type: "warn", text: `${derived.allocation.diffPercent.toFixed(1)}% of production budget unallocated` });
  } else {
    reasons.push({ type: "ok", text: "Budget fully allocated" });
  }

  if (derived.crewCostRatio.state === "critical") {
    score -= 20;
    reasons.push({ type: "warn", text: `Crew costs are ${derived.crewCostRatio.ratio.toFixed(0)}% of production budget` });
  } else if (derived.crewCostRatio.state === "watch") {
    score -= 8;
    reasons.push({ type: "warn", text: `Crew costs are ${derived.crewCostRatio.ratio.toFixed(0)}% of production budget` });
  }

  if (derived.deadlineRisk.state === "risk") {
    score -= 20;
    reasons.push({ type: "warn", text: "Deadline is at risk" });
  } else if (derived.deadlineRisk.state === "tight") {
    score -= 8;
    reasons.push({ type: "warn", text: "Deadline is tight" });
  }

  if (derived.contingency.state === "none") {
    score -= 10;
    reasons.push({ type: "warn", text: "No contingency reserve" });
  } else if (derived.contingency.state === "below") {
    score -= 5;
    reasons.push({ type: "warn", text: `Contingency is only ${derived.contingency.value}%` });
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  let label = "Critical";
  if (score >= 90) label = "Excellent";
  else if (score >= 75) label = "Healthy";
  else if (score >= 60) label = "Watch";
  else if (score >= 40) label = "Risk";
  return { score, label, reasons };
}

// Aggregates every rule above into one object the UI reads from. Nothing
// here mutates the plan or makes a decision, it only calculates and
// explains.
function computePlannerIntelligence(plan) {
  const crew = plan.crew || [];
  const scope = plan.scope || {};
  const totalCrewCost = computeTotalCrewCost(crew);
  const financial = computePlannerFinancialHealth(plan, totalCrewCost);
  const allocation = computeAllocationState(plan.departmentAllocations);
  const crewCostRatio = computeCrewCostRatio(totalCrewCost, financial.productionBudget);
  const departmentSpend = computeDepartmentSpend(plan, financial.productionBudget);
  const complexity = computeComplexityScore(scope);
  const contingency = computeContingencyState(plan.contingencyPercent, complexity.label.toLowerCase().replace(" ", "_"));
  const timeline = computeTimelineEstimate(scope, crew.length);
  const availableDays = daysBetween(plan.startDate, plan.deadline);
  const deadlineRisk = computeDeadlineRisk(timeline.estimatedDays, availableDays);
  const minimumPrice = computeMinimumPrice(financial.productionBudget, plan.targetProfitPercent);
  const shotsPerSecond = scopeShotsPerSecond(scope);

  // Crew fit scoring, weighted by how tight the deadline is (section 10/14),
  // plus overload/capacity checks (section 16).
  const crewFit = crew.map((person) => ({ person, fit: computeCrewMemberFit(person, deadlineRisk.state) }));
  const overloadedCrew = crewFit.filter((c) => c.fit.capacity.state === "over");

  // Critical crew (section 20): first department, in production order, that
  // has an allocation but no crew assigned yet — a simple stand-in for
  // "this is currently the schedule risk" without a full dependency graph.
  const departmentsWithAllocation = PLANNER_DEPARTMENTS.filter((d) => parseMoney((plan.departmentAllocations || {})[d.id]) > 0 && d.id !== "contingency");
  const criticalDepartment = departmentsWithAllocation.find((d) => !crew.some((p) => p.department === d.id)) || null;

  const derived = { financial, allocation, crewCostRatio, departmentSpend, complexity, contingency, timeline, deadlineRisk, minimumPrice, shotsPerSecond, totalCrewCost, crewFit, criticalDepartment };
  const dealScore = computeDealScore(plan, derived);

  // Priority-ordered warnings (spec section 24: financial loss, deadline,
  // over-allocation, crew-over-budget, scope mismatch, low contingency,
  // then optimization opportunities).
  const warnings = [];
  if (financial.state === "red") {
    warnings.push({ level: "red", text: `Critical margin: ${financial.actualMargin.toFixed(1)}% — very little financial buffer.` });
  }
  if (deadlineRisk.state === "risk") {
    warnings.push({
      level: "red",
      text: `Deadline risk — estimated production is ${timeline.estimatedDays} days but only ${availableDays} days are available.`,
    });
  }
  if (allocation.state === "over") {
    warnings.push({ level: "red", text: `Department budget overallocated by ${allocation.diffPercent.toFixed(1)}%.` });
  }
  const overspendDept = departmentSpend.find((d) => d.state === "over");
  if (overspendDept) {
    warnings.push({
      level: "red",
      text: `Crew costs exceed the ${overspendDept.label} allocation by ${plan.currency || "$"}${formatMoney(overspendDept.crewCost - overspendDept.allocatedAmount)}.`,
    });
  }
  if (crewCostRatio.state === "critical") {
    warnings.push({ level: "red", text: `Crew costs consume ${crewCostRatio.ratio.toFixed(0)}% of the production budget.` });
  }
  if (financial.state === "yellow") {
    warnings.push({ level: "yellow", text: `Tight margin (${financial.actualMargin.toFixed(1)}%) — limited room for revisions or surprises.` });
  }
  if (deadlineRisk.state === "tight") {
    warnings.push({ level: "yellow", text: `Tight schedule — only ${availableDays - timeline.estimatedDays} day(s) of buffer.` });
  }
  if (contingency.state === "none") {
    warnings.push({ level: "yellow", text: "No contingency reserve set aside." });
  } else if (contingency.state === "below") {
    warnings.push({ level: "yellow", text: `Contingency (${contingency.value}%) is below the ${contingency.recommended}% recommended for this project's complexity.` });
  }
  if (crewCostRatio.state === "watch") {
    warnings.push({ level: "yellow", text: `Crew costs are ${crewCostRatio.ratio.toFixed(0)}% of the production budget — worth watching.` });
  }
  if (!financial.meetsTarget && financial.state === "green") {
    warnings.push({ level: "yellow", text: `Below your ${financial.targetProfitPercent}% target margin (currently ${financial.actualMargin.toFixed(1)}%).` });
  }
  overloadedCrew.forEach(({ person, fit }) => {
    warnings.push({
      level: "red",
      text: `${person.name || "This crew member"} is assigned ${fit.capacity.overBy} unit(s) beyond their declared capacity.`,
    });
  });
  if (criticalDepartment && crew.length > 0) {
    warnings.push({
      level: "yellow",
      text: `${criticalDepartment.label} has budget allocated but no crew assigned yet — currently the largest schedule risk.`,
    });
  }

  return { ...derived, dealScore, warnings };
}

const AVAILABILITY_OPTIONS = ["available", "busy", "unavailable"];
const AVAILABILITY_LABELS = {
  available: "Available",
  busy: "Partially available",
  unavailable: "Unavailable",
};
const AVAILABILITY_COLORS = {
  available: "#3DDC84",
  busy: "#F2A65A",
  unavailable: "#FF4D4D",
};

// Kept in sync with the department list the Planner's crew allocator
// expects (see planner_crew_allocation.txt / planner_rm.txt Phase 4).
const TEAM_DEPARTMENT_OPTIONS = [
  "Pre-production",
  "Storyboard / Animatic",
  "Character Design",
  "Background Art",
  "Layout",
  "Key Animation",
  "In-between / Cleanup",
  "Compositing",
  "Editing",
  "Sound",
  "Other",
];

// Common production skills. Crew members aren't limited to this list -
// the editor lets someone add a custom skill too.
const TEAM_SKILL_OPTIONS = [
  "Storyboard",
  "Layout",
  "Key Animation",
  "Character Animation",
  "Inbetween",
  "Cleanup",
  "Backgrounds",
  "Compositing",
  "Effects",
  "Editing",
  "Motion Graphics",
  "Illustration",
  "Sound",
];

const RATE_TYPE_OPTIONS = [
  { value: "hour", label: "Per hour" },
  { value: "day", label: "Per day" },
  { value: "shot", label: "Per shot" },
  { value: "second", label: "Per second" },
  { value: "fixed", label: "Fixed project fee" },
];

const CAPACITY_UNIT_OPTIONS = [
  "hours/week",
  "days/week",
  "shots/week",
];

const SKILL_LEVEL_LABELS = {
  1: "Beginner",
  2: "Junior",
  3: "Intermediate",
  4: "Senior",
  5: "Expert",
};

function skillLevelLabel(level) {
  return SKILL_LEVEL_LABELS[level] || "Intermediate";
}

// "★★★★☆ 4.8" - a simple 5-star visual for a rating out of 5. Used for
// both external (Upwork) and internal ratings, but never mixes the two:
// each call site passes one rating from one source, and the two are
// always labelled separately (brief §15/§38 - never a blended score).
function starRating(rating) {
  const n = Math.max(0, Math.min(5, Number(rating) || 0));
  const full = Math.round(n);
  return "\u2605".repeat(full) + "\u2606".repeat(5 - full);
}

// Tiers per planner_crew_allocation.txt section 6.
function dependabilityTier(score) {
  const n = Number(score);
  if (n >= 90) return { label: "Highly dependable", color: "#3DDC84" };
  if (n >= 75) return { label: "Reliable", color: "#7FE0D0" };
  if (n >= 60) return { label: "Variable", color: "#F2A65A" };
  return { label: "Risky", color: "#FF4D4D" };
}

function rateTypeLabel(rateType) {
  return RATE_TYPE_OPTIONS.find((o) => o.value === rateType)?.label || "Per hour";
}

// Human-readable rate, e.g. "$150/shot" or "$2,400 fixed fee".
// Falls back to the legacy free-text rate note when no structured
// amount has been entered yet, so old data still displays sensibly.
function formatMemberRate(member, currencySymbol) {
  const cur = currencySymbol || "$";
  const amount = Number(member.rateAmount) || 0;
  if (amount > 0) {
    const suffix = { hour: "/hr", day: "/day", shot: "/shot", second: "/sec", fixed: " fixed" }[
      member.rateType || "hour"
    ];
    return `${cur}${formatMoney(amount)}${suffix}`;
  }
  return member.rate || "";
}

// Names that more than one roster member (active or archived) shares.
// UUID is always the real identity, but wherever a human has to pick a
// name out of a list, a shared name needs a second cue or they can't
// tell the two people apart. Case/whitespace-insensitive, matching how
// the legacy assign-by-name fallback itself compares names.
function findDuplicateMemberNames(teamMembers) {
  const counts = new Map();
  for (const m of teamMembers) {
    const key = (m.name || "").trim().toLowerCase();
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([key]) => key));
}

// Label for a team member in a picker: appends a disambiguator (role,
// else email, else the id's first 8 chars) only when their name collides
// with someone else's, so ordinary rosters stay uncluttered.
function disambiguatedMemberLabel(member, duplicateNames) {
  const base = member.name || "Untitled member";
  const key = base.trim().toLowerCase();
  if (!duplicateNames.has(key)) return base;
  const detail = member.role || member.email || `#${(member.id || "").slice(0, 8)}`;
  return `${base} (${detail})`;
}

function emptyTeamMember() {
  return {
    name: "",
    role: "",
    department: "",
    email: "",
    rate: "",
    rateType: "hour",
    rateAmount: 0,
    availability: "available",
    availableStartDate: "",
    availableEndDate: "",
    capacityValue: 0,
    capacityUnit: "hours/week",
    skills: [],
    skillLevel: 3,
    dependabilityScore: 80,
    defaultSpeedValue: 0,
    defaultSpeedUnit: "",
    notes: "",
    status: "active",
    archivedAt: null,
    memberType: "freelancer",
    rateCurrency: "$",
    upworkRating: null,
    upworkReviewCount: null,    paymentMethod: "",
    paymentCurrency: "",
    paymentCountry: "",
  };
}

function teamMemberFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    department: row.department || "",
    email: row.email,
    rate: row.rate,
    rateType: row.rate_type || "hour",
    rateAmount: row.rate_amount || 0,
    availability: row.availability || "available",
    availableStartDate: row.available_start_date || "",
    availableEndDate: row.available_end_date || "",
    capacityValue: row.capacity_value || 0,
    capacityUnit: row.capacity_unit || "hours/week",
    skills: Array.isArray(row.skills) ? row.skills : [],
    skillLevel: row.skill_level || 3,
    dependabilityScore: row.dependability_score ?? 80,
    defaultSpeedValue: row.default_speed_value || 0,
    defaultSpeedUnit: row.default_speed_unit || "",
    notes: row.notes,
    status: row.status || "active",
    archivedAt: row.archived_at || null,
    memberType: row.member_type || "freelancer",
    rateCurrency: row.rate_currency || "$",
    upworkRating: row.upwork_rating == null ? null : Number(row.upwork_rating),
    upworkReviewCount: row.upwork_review_count == null ? null : Number(row.upwork_review_count),    paymentMethod: row.payment_method || "",
    paymentCurrency: row.payment_currency || "",
    paymentCountry: row.payment_country || "",
  };
}

function teamMemberToRow(member, userId) {
  return {
    name: member.name,
    role: member.role,
    department: member.department || "",
    email: member.email,
    rate: member.rate,
    rate_type: member.rateType || "hour",
    rate_amount: Number(member.rateAmount) || 0,
    availability: member.availability || "available",
    available_start_date: member.availableStartDate || null,
    available_end_date: member.availableEndDate || null,
    capacity_value: Number(member.capacityValue) || 0,
    capacity_unit: member.capacityUnit || "hours/week",
    skills: Array.isArray(member.skills) ? member.skills : [],
    skill_level: Number(member.skillLevel) || 3,
    // `|| 80` previously coerced a genuine, deliberately-entered score of 0
    // into the default of 80. Use nullish coalescing so only a truly
    // missing value (null/undefined/NaN) falls back to the default.
    dependability_score: Number.isFinite(Number(member.dependabilityScore))
      ? Number(member.dependabilityScore)
      : 80,
    default_speed_value: Number(member.defaultSpeedValue) || 0,
    default_speed_unit: member.defaultSpeedUnit || "",
    notes: member.notes,
    user_id: userId,
    status: member.status || "active",
    archived_at: member.archivedAt || null,
    member_type: member.memberType === "internal" ? "internal" : "freelancer",
    rate_currency: member.rateCurrency || "$",
    // Upwork rating/review count are external, self-reported metadata -
    // never derived from or blended with internal reviews (brief §15).
    upwork_rating: member.upworkRating === "" || member.upworkRating == null ? null : Number(member.upworkRating),
    upwork_review_count:
      member.upworkReviewCount === "" || member.upworkReviewCount == null ? null : Number(member.upworkReviewCount),    payment_method: member.paymentMethod || "",
    payment_currency: member.paymentCurrency || "",
    payment_country: member.paymentCountry || "",
  };
}

// Masks a payment-details string for display outside of the direct edit
// field: keeps only the last 4 characters visible ("•••• 1234"), matching
// the brief's roster-card example. Never used to decide what gets sent to
// the server - purely a rendering helper.
function maskPaymentDetails(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return "";
  if (trimmed.length <= 4) return "\u2022\u2022\u2022\u2022";
  return `\u2022\u2022\u2022\u2022 ${trimmed.slice(-4)}`;
}

function paymentDetailsFromRow(row) {
  if (!row) return { accountHolderName: "", paymentDetails: "" };
  return {
    accountHolderName: row.account_holder_name || "",
    paymentDetails: row.payment_details || "",
  };
}

function paymentDetailsToRow(teamMemberId, userId, details) {
  return {
    team_member_id: teamMemberId,
    user_id: userId,
    account_holder_name: details.accountHolderName || "",
    payment_details: details.paymentDetails || "",
  };
}

function rateHistoryFromRow(row) {
  return {
    id: row.id,
    rateAmount: row.rate_amount,
    rateType: row.rate_type,
    rateCurrency: row.rate_currency || "$",
    effectiveDate: row.effective_date,
  };
}

function emptyPortfolioItem() {
  return {
    title: "",
    description: "",
    thumbnailUrl: "",
    externalUrl: "",
    rolePerformed: "",
    skillsDemonstrated: [],
    projectCategory: "",
    itemDate: "",
    clientName: "",
  };
}

function portfolioItemFromRow(row) {
  return {
    id: row.id,
    title: row.title || "",
    description: row.description || "",
    thumbnailUrl: row.thumbnail_url || "",
    externalUrl: row.external_url || "",
    rolePerformed: row.role_performed || "",
    skillsDemonstrated: Array.isArray(row.skills_demonstrated) ? row.skills_demonstrated : [],
    projectCategory: row.project_category || "",
    itemDate: row.item_date || "",
    clientName: row.client_name || "",
  };
}

function portfolioItemToRow(teamMemberId, userId, item) {
  return {
    team_member_id: teamMemberId,
    user_id: userId,
    title: item.title || "Untitled piece",
    description: item.description || "",
    thumbnail_url: item.thumbnailUrl || "",
    external_url: item.externalUrl || "",
    role_performed: item.rolePerformed || "",
    skills_demonstrated: Array.isArray(item.skillsDemonstrated) ? item.skillsDemonstrated : [],
    project_category: item.projectCategory || "",
    item_date: item.itemDate || null,
    client_name: item.clientName || "",
  };
}

function emptyReview() {
  return { rating: 5, reviewText: "", reviewer: "", reviewDate: new Date().toISOString().slice(0, 10), projectId: "" };
}

function reviewFromRow(row) {
  return {
    id: row.id,
    rating: row.rating,
    reviewText: row.review_text || "",
    reviewer: row.reviewer || "",
    reviewDate: row.review_date,
    projectId: row.project_id || "",
  };
}

function reviewToRow(teamMemberId, userId, review) {
  return {
    team_member_id: teamMemberId,
    user_id: userId,
    rating: Number(review.rating) || 5,
    review_text: review.reviewText || "",
    reviewer: review.reviewer || "",
    review_date: review.reviewDate || new Date().toISOString().slice(0, 10),
    project_id: review.projectId || null,
  };
}

// Internal reviews only, never blended with an external Upwork rating
// (brief §15/§38). null when there are no reviews yet, rather than
// pretending a 0-review average is a real score of 0.
function averageInternalRating(reviews) {
  if (!reviews || reviews.length === 0) return null;
  return reviews.reduce((sum, r) => sum + (Number(r.rating) || 0), 0) / reviews.length;
}

function computeMemberShots(member, cards, projects, teamMembers = []) {
  const matching = cards.filter((c) => {
    if (!member.name.trim()) return false;
    if (c.assignedMemberId) return c.assignedMemberId === member.id;
    const legacyName = (c.assignedTo || "").trim().toLowerCase();
    if (!legacyName) return false;
    const legacyMatches = teamMembers.filter((m) => (m.name || "").trim().toLowerCase() === legacyName);
    return legacyMatches.length === 1 && legacyMatches[0].id === member.id;
  });
  const withProjectNames = matching.map((c) => {
    const project = projects.find((p) => p.id === c.projectId);
    return { ...c, projectName: project?.name || "-", currency: project?.currency || "$" };
  });
  // Grouped by currency rather than summed into one number: a member can
  // easily be paid out of a USD project and a EUR project in the same
  // roster, and adding $100 + €100 and labelling the result "$200" is
  // simply wrong, not just imprecise. See brief §25.
  const addTo = (map, currency, amount) => {
    map[currency] = (map[currency] || 0) + amount;
    return map;
  };
  const pendingByCurrency = withProjectNames
    .filter((c) => !c.assignedPaid && parseMoney(c.assignedPay) > 0)
    .reduce((map, c) => addTo(map, c.currency, parseMoney(c.assignedPay)), {});
  const paidByCurrency = withProjectNames
    .filter((c) => c.assignedPaid && parseMoney(c.assignedPay) > 0)
    .reduce((map, c) => addTo(map, c.currency, parseMoney(c.assignedPay)), {});
  return { shots: withProjectNames, pendingByCurrency, paidByCurrency };
}

// "$120.00" / "€45.50 · $10.00" etc. — renders a {currency: amount} map as
// a compact string, one term per currency, so mixed-currency totals stay
// visibly separate instead of being silently combined.
function formatCurrencyTotals(byCurrency) {
  const entries = Object.entries(byCurrency).filter(([, amount]) => amount > 0);
  if (entries.length === 0) return null;
  return entries.map(([currency, amount]) => `${currency}${formatMoney(amount)}`).join(" \u00b7 ");
}

// Shots still relying on the legacy free-text assignedTo match (no
// assigned_member_id yet). Classifies each into:
//  - unique: exactly one roster member's name matches exactly
//    (case/whitespace-insensitive) -> a safe candidate to link
//  - ambiguous: more than one member matches -> a human has to pick
//  - unmatched: no member matches -> nothing to link automatically
// Never guesses between multiple same-named people (brief §5/§30).
function computeLegacyAssignmentMatches(cards, teamMembers) {
  const unresolved = cards.filter((c) => (c.assignedTo || "").trim() && !c.assignedMemberId);
  const unique = [];
  const ambiguous = [];
  const unmatched = [];
  for (const c of unresolved) {
    const name = c.assignedTo.trim().toLowerCase();
    const matches = teamMembers.filter((m) => (m.name || "").trim().toLowerCase() === name);
    if (matches.length === 1) unique.push({ card: c, member: matches[0] });
    else if (matches.length > 1) ambiguous.push({ card: c, candidates: matches });
    else unmatched.push({ card: c });
  }
  return { unique, ambiguous, unmatched };
}

// "YYYY-MM-DD" (dateSent/paidDate/deadline) parsed via `new Date(str)` is
// read as UTC midnight, which lands on the previous local calendar day for
// anyone west of UTC - and therefore the previous month, right at month
// boundaries. Route bare dates through parseLocalDateStr instead; full ISO
// timestamps (activity log entries) parse the same either way.
function monthKey(dateStr) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(dateStr || "") ? parseLocalDateStr(dateStr) : new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function lastSixMonthKeys() {
  const keys = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keys.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      label: d.toLocaleString(undefined, { month: "short" }),
    });
  }
  return keys;
}

function computeFinanceData(projects, allInvoices, expenses, fxRates = {}) {
  const months = lastSixMonthKeys();
  // See excludeSupersededInvoices: without this, a paid proforma that
  // later gets a receipt (and then a final invoice) generated from it
  // would have its amount counted again at every stage.
  const invoices = excludeSupersededInvoices(allInvoices);

  const revenueByMonth = months.map(({ key, label }) => {
    const total = invoices
      .filter((inv) => inv.status === "paid" && monthKey(inv.paidDate) === key)
      .reduce((sum, inv) => sum + convertToUSD(inv.amountPaid, inv.currency, fxRates), 0);
    return { label, value: total };
  });

  const expensesByMonth = months.map(({ key, label }) => {
    const total = expenses
      .filter((e) => monthKey(e.date) === key)
      .reduce((sum, e) => sum + convertToUSD(e.amount, e.currency, fxRates), 0);
    return { label, value: total };
  });

  const profitByMonth = months.map((m, i) => ({
    label: m.label,
    value: revenueByMonth[i].value - expensesByMonth[i].value,
  }));

  // Accounts receivable: every unpaid invoice, with client, due date, and days overdue
  const now = new Date();
  const receivables = invoices
    .filter((inv) => inv.status !== "paid")
    .map((inv) => {
      const project = projects.find((p) => p.id === inv.projectId);
      const due = new Date(inv.dueDate);
      const daysOverdue = !isNaN(due.getTime()) ? Math.floor((now - due) / 86400000) : null;
      return {
        invoiceNumber: inv.invoiceNumber,
        client: project?.client || "-",
        projectName: project?.name || "-",
        amountDue:
          convertToUSD(inv.amount, inv.currency, fxRates) - convertToUSD(inv.amountPaid, inv.currency, fxRates),
        dueDate: inv.dueDate,
        daysOverdue,
      };
    })
    .sort((a, b) => (b.daysOverdue ?? -999) - (a.daysOverdue ?? -999));

  // Per-project profitability, converted to USD so projects in different
  // currencies can be compared side by side.
  const profitability = projects
    .filter((p) => !p.archived)
    .map((p) => {
      const projectInvoices = invoices.filter((inv) => inv.projectId === p.id);
      const revenue = projectInvoices.reduce(
        (sum, inv) => sum + convertToUSD(inv.amountPaid, inv.currency, fxRates),
        0
      );
      const projectExpenses = expenses
        .filter((e) => e.projectId === p.id)
        .reduce((sum, e) => sum + convertToUSD(e.amount, e.currency, fxRates), 0);
      const profit = revenue - projectExpenses;
      const margin = revenue > 0 ? Math.round((profit / revenue) * 100) : null;
      return { project: p, revenue, expenses: projectExpenses, profit, margin };
    });

  // Client value: group by client name across all projects, converted to USD
  const clientMap = {};
  projects.forEach((p) => {
    const key = (p.client || "Unknown").trim() || "Unknown";
    if (!clientMap[key]) clientMap[key] = { client: key, revenue: 0, projectCount: 0, lastDate: null };
    const projectInvoices = invoices.filter((inv) => inv.projectId === p.id);
    const revenue = projectInvoices.reduce(
      (sum, inv) => sum + convertToUSD(inv.amountPaid, inv.currency, fxRates),
      0
    );
    clientMap[key].revenue += revenue;
    clientMap[key].projectCount += 1;
    const d = new Date(p.deadline);
    if (!isNaN(d.getTime()) && (!clientMap[key].lastDate || d > clientMap[key].lastDate)) {
      clientMap[key].lastDate = d;
    }
  });
  const clientValue = Object.values(clientMap)
    .map((c) => ({ ...c, avgProjectValue: c.projectCount ? c.revenue / c.projectCount : 0 }))
    .sort((a, b) => b.revenue - a.revenue);

  const revenueByClient = clientValue.map((c) => ({ label: c.client, value: c.revenue }));

  return {
    revenueByMonth,
    expensesByMonth,
    profitByMonth,
    receivables,
    profitability,
    clientValue,
    revenueByClient,
  };
}

const DEFAULT_SETTINGS = {
  studioName: "Studio Kairegi",
  studioTagline: "Anime-style animation & production",
  // Billing/registration details for invoice headers - separate from the
  // studioName brand above because a sole proprietor's registered legal
  // name (what an accountant needs on the document) can differ from the
  // studio's public-facing name. Left blank, invoices fall back to
  // studioName so nothing breaks for studios that don't need the distinction.
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
  hasSeenTutorial: false,
  plan: "free",
  isAdmin: false,
  leadChannels: DEFAULT_LEAD_CHANNELS,
  followupSchedule: DEFAULT_FOLLOWUP_SCHEDULE,
  // Channels toggled off from the dashboard's "Leads by channel" breakdown.
  // Purely a display filter - hidden channels still exist, are still
  // selectable on leads, and still show up everywhere else (CRM board
  // filter chips, lead editor).
  dashboardHiddenChannels: [],
  // App-level kill switch for desktop notifications, independent of the
  // browser permission. Notification.permission only ever goes from
  // "default" to "granted"/"denied" and back to "default" via the
  // browser's own site settings - there was no in-app way to just turn
  // notifications off without digging into browser chrome. This is that
  // toggle; notifyBrowser() checks it before ever calling Notification().
  notificationsEnabled: true,
  // Configurable per-studio payment-method list for Teams (brief §13),
  // rather than hardcoding the options everywhere they're offered.
  paymentMethodOptions: ["Bank transfer", "PayPal", "Payoneer", "M-Pesa", "Wise", "Cash", "Other"],
};

function settingsFromRow(row) {
  if (!row) return DEFAULT_SETTINGS;
  return {
    studioName: row.studio_name || DEFAULT_SETTINGS.studioName,
    studioTagline: row.studio_tagline || DEFAULT_SETTINGS.studioTagline,
    studioLegalName: row.studio_legal_name || "",
    studioAddress: row.studio_address || "",
    studioTaxId: row.studio_tax_id || "",
    studioVatStatus: row.studio_vat_status || "",
    studioEtimsNumber: row.studio_etims_number || "",
    currencySymbol: row.currency_symbol || DEFAULT_SETTINGS.currencySymbol,
    milestoneDefaults:
      Array.isArray(row.milestone_defaults) && row.milestone_defaults.length === 3
        ? row.milestone_defaults
        : MILESTONE_DEFAULTS,
    defaultLandingTab: row.default_landing_tab || DEFAULT_SETTINGS.defaultLandingTab,
    defaultShotPriority: row.default_shot_priority || DEFAULT_SETTINGS.defaultShotPriority,
    logoUrl: row.logo_url || "",
    hasSeenTutorial: row.has_seen_tutorial || false,
    plan: row.plan || "free",
    isAdmin: row.is_admin || false,
    leadChannels:
      Array.isArray(row.lead_channels) && row.lead_channels.length > 0
        ? row.lead_channels
        : DEFAULT_LEAD_CHANNELS,
    followupSchedule:
      Array.isArray(row.followup_schedule) && row.followup_schedule.length === 5
        ? row.followup_schedule
        : DEFAULT_FOLLOWUP_SCHEDULE,
    dashboardHiddenChannels: Array.isArray(row.dashboard_hidden_channels) ? row.dashboard_hidden_channels : [],
    notificationsEnabled: row.notifications_enabled !== false,
    paymentMethodOptions:
      Array.isArray(row.payment_method_options) && row.payment_method_options.length > 0
        ? row.payment_method_options
        : DEFAULT_SETTINGS.paymentMethodOptions,
  };
}

function settingsToRow(settings, userId) {
  return {
    user_id: userId,
    studio_name: settings.studioName,
    studio_tagline: settings.studioTagline,
    studio_legal_name: settings.studioLegalName || "",
    studio_address: settings.studioAddress || "",
    studio_tax_id: settings.studioTaxId || "",
    studio_vat_status: settings.studioVatStatus || "",
    studio_etims_number: settings.studioEtimsNumber || "",
    currency_symbol: settings.currencySymbol,
    milestone_defaults: settings.milestoneDefaults,
    default_landing_tab: settings.defaultLandingTab,
    default_shot_priority: settings.defaultShotPriority,
    logo_url: settings.logoUrl,
    has_seen_tutorial: settings.hasSeenTutorial,
    plan: settings.plan,
    is_admin: settings.isAdmin,
    lead_channels: settings.leadChannels || DEFAULT_LEAD_CHANNELS,
    followup_schedule: settings.followupSchedule || DEFAULT_FOLLOWUP_SCHEDULE,
    dashboard_hidden_channels: settings.dashboardHiddenChannels || [],
    notifications_enabled: settings.notificationsEnabled !== false,
    payment_method_options:
      Array.isArray(settings.paymentMethodOptions) && settings.paymentMethodOptions.length > 0
        ? settings.paymentMethodOptions
        : DEFAULT_SETTINGS.paymentMethodOptions,
  };
}

function computeDashboardStats(projects, cards, leads, allInvoices, fxRates = {}) {
  // See excludeSupersededInvoices: a proforma that's since had a receipt
  // (and then a final invoice) generated from it must drop out here too,
  // or its amount gets counted at every stage of its own document chain.
  const invoices = excludeSupersededInvoices(allInvoices);
  const activeProjects = projects.filter((p) => !p.archived);
  // "Active leads" means outreach actually in progress: contacted but not
  // yet resolved. That excludes the untouched "New" pool (never contacted)
  // and every terminal outcome - No Response, Lost, Disqualified, Closed,
  // and Won (converted, no longer outreach). !isLeadStageTerminal() alone
  // used to leave "New" leads counted as active, since pool isn't a
  // terminal stage - only the true outreach stages should count. This
  // mirrors ACTIVE_OUTREACH_STAGE_IDS, the same definition the dashboard's
  // active-outreach breakdown already uses.
  const activeLeads = leads.filter((l) => !l.archivedAt && ACTIVE_OUTREACH_STAGE_IDS.includes(l.stage));
  const dealsWon = leads.filter((l) => l.stage === "won").length;
  const dealsLost = leads.filter((l) => l.stage === "lost").length;

  const now = new Date();
  // BUG FIX: "YYYY-MM-DD" deadlines were parsed with `new Date(p.deadline)`,
  // which reads the string as UTC midnight - the previous local calendar day
  // for anyone west of UTC. Two separate errors compounded: the parse itself,
  // and diffing against a mid-day `now`, which made a deadline of *today*
  // come out negative and drop off the list entirely. Parse locally and diff
  // against local midnight, matching what computeFollowupStatus already does.
  const todayStart = startOfLocalDay(now);
  const nearDeadline = activeProjects.filter((p) => {
    if (!p.deadline) return false;
    const d = /^\d{4}-\d{2}-\d{2}$/.test(p.deadline) ? parseLocalDateStr(p.deadline) : new Date(p.deadline);
    if (isNaN(d.getTime())) return false;
    const diffDays = Math.round((startOfLocalDay(d) - todayStart) / 86400000);
    return diffDays >= 0 && diffDays <= 7;
  });

  const projectsCompleted = activeProjects.filter((p) => {
    const shots = cards.filter((c) => c.projectId === p.id);
    return shots.length > 0 && shots.every((s) => s.stage === "delivered");
  }).length;

  const thisMonth = now.getMonth();
  const thisYear = now.getFullYear();
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonth = lastMonthDate.getMonth();
  const lastMonthYear = lastMonthDate.getFullYear();

  // BUG FIX: same UTC-midnight parsing issue as monthKey/nearDeadline above
  // - paidDate is a bare "YYYY-MM-DD" string, so `new Date(inv.paidDate)`
  // could land on the wrong local calendar month for anyone west of UTC,
  // right at the edges of the month.
  const revenueThisMonth = invoices.reduce((sum, inv) => {
    if (inv.status !== "paid" || !inv.paidDate) return sum;
    const d = /^\d{4}-\d{2}-\d{2}$/.test(inv.paidDate) ? parseLocalDateStr(inv.paidDate) : new Date(inv.paidDate);
    if (d.getMonth() === thisMonth && d.getFullYear() === thisYear) {
      return sum + convertToUSD(inv.amountPaid, inv.currency, fxRates);
    }
    return sum;
  }, 0);

  const revenueLastMonth = invoices.reduce((sum, inv) => {
    if (inv.status !== "paid" || !inv.paidDate) return sum;
    const d = /^\d{4}-\d{2}-\d{2}$/.test(inv.paidDate) ? parseLocalDateStr(inv.paidDate) : new Date(inv.paidDate);
    if (d.getMonth() === lastMonth && d.getFullYear() === lastMonthYear) {
      return sum + convertToUSD(inv.amountPaid, inv.currency, fxRates);
    }
    return sum;
  }, 0);

  const revenueDelta =
    revenueLastMonth > 0
      ? Math.round(((revenueThisMonth - revenueLastMonth) / revenueLastMonth) * 100)
      : revenueThisMonth > 0
      ? 100
      : null;

  const unpaidInvoices = invoices.filter((inv) => inv.status !== "paid");
  const outstandingTotal = unpaidInvoices.reduce(
    (sum, inv) =>
      sum + (convertToUSD(inv.amount, inv.currency, fxRates) - convertToUSD(inv.amountPaid, inv.currency, fxRates)),
    0
  );

  return {
    activeLeadsCount: activeLeads.length,
    activeProjectsCount: activeProjects.length,
    nearDeadline,
    revenueThisMonth,
    revenueDelta,
    outstandingCount: unpaidInvoices.length,
    outstandingTotal,
    dealsWon,
    dealsLost,
    projectsCompleted,
    totalShots: cards.length,
  };
}

function downloadInvoicePDF(invoice, project, settings = DEFAULT_SETTINGS) {
  const doc = new jsPDF();
  const balance = parseMoney(invoice.amount) - parseMoney(invoice.amountPaid);
  const cur = invoice.currency || settings.currencySymbol || "$";
  const left = 20;
  const right = 190;
  let y = 22;

  // --- Studio header: legal name, tagline, and registration details ---
  doc.setFontSize(18);
  doc.setTextColor(0);
  doc.text(settings.studioLegalName || settings.studioName || "Studio Kairegi", left, y);
  y += 7;

  doc.setFontSize(10);
  doc.setTextColor(100);
  if (settings.studioTagline) {
    doc.text(settings.studioTagline, left, y);
    y += 5.5;
  }
  if (settings.studioAddress) {
    const addrLines = doc.splitTextToSize(settings.studioAddress, 105);
    doc.text(addrLines, left, y);
    y += addrLines.length * 4.5;
  }
  const studioTaxLine = [
    settings.studioTaxId ? `Tax ID: ${settings.studioTaxId}` : "",
    settings.studioVatStatus ? `VAT: ${settings.studioVatStatus}` : "",
  ]
    .filter(Boolean)
    .join("   \u00b7   ");
  if (studioTaxLine) {
    doc.text(studioTaxLine, left, y);
    y += 4.5;
  }
  if (settings.studioEtimsNumber) {
    doc.text(`eTIMS no.: ${settings.studioEtimsNumber}`, left, y);
    y += 4.5;
  }

  // --- Document title ---
  y += 8;
  doc.setFontSize(14);
  doc.setTextColor(0);
  const docType = invoice.docType || "invoice";
  doc.text(`${DOC_TYPE_TITLE[docType] || "Invoice"} ${invoice.invoiceNumber}`, left, y);
  const detailsTop = y + 8;

  // --- Left column: issue/due date and status ---
  // A receipt implies payment already happened, so it states when rather
  // than asking Paid/Unpaid; a proforma is "awaiting payment" rather than
  // flatly "Unpaid", since nothing was ever due yet at that stage.
  let statusLabel;
  if (docType === "receipt") {
    statusLabel = `Payment received${invoice.paidDate ? ` on ${invoice.paidDate}` : ""}`;
  } else if (docType === "proforma") {
    statusLabel = invoice.status === "paid" ? "Paid" : "Awaiting payment";
  } else {
    statusLabel = invoice.status === "paid" ? "Paid" : "Unpaid";
  }
  doc.setFontSize(10);
  doc.text(`Issue date: ${invoice.issueDate || "-"}`, left, detailsTop);
  doc.text(`Due date: ${invoice.dueDate || "-"}`, left, detailsTop + 6);
  doc.text(`Status: ${statusLabel}`, left, detailsTop + 12);
  const leftColBottom = detailsTop + 12;

  // --- Right column: bill-to, with the client's address/tax ID when on file ---
  let billY = detailsTop;
  doc.text(`Bill to: ${project?.client || "-"}`, 130, billY);
  billY += 6;
  if (project?.clientAddress) {
    const clientAddrLines = doc.splitTextToSize(project.clientAddress, 60);
    doc.text(clientAddrLines, 130, billY);
    billY += clientAddrLines.length * 4.5;
  }
  if (project?.clientTaxId) {
    doc.text(`Tax ID: ${project.clientTaxId}`, 130, billY);
    billY += 4.5;
  }
  doc.text(`Project: ${project?.name || "-"}`, 130, billY);
  const rightColBottom = billY;

  const dividerY = Math.max(leftColBottom, rightColBottom) + 9;
  doc.setDrawColor(200);
  doc.line(left, dividerY, right, dividerY);

  doc.setFontSize(11);
  doc.setTextColor(0);
  const hasLineItems =
    invoice.amountMode === "items" && Array.isArray(invoice.lineItems) && invoice.lineItems.length > 0;
  let lineY;

  if (hasLineItems) {
    let rowY = dividerY + 10;
    doc.text("Description", left, rowY);
    doc.text("Qty", 120, rowY, { align: "right" });
    doc.text("Unit price", 150, rowY, { align: "right" });
    doc.text("Amount", 170, rowY, { align: "right" });
    rowY += 8;
    doc.setFontSize(10);
    invoice.lineItems.forEach((li) => {
      const rowLines = doc.splitTextToSize(li.description || "-", 85);
      const rowAmount = parseMoney(li.qty) * parseMoney(li.unitPrice);
      doc.text(rowLines, left, rowY);
      doc.text(String(li.qty ?? ""), 120, rowY, { align: "right" });
      doc.text(`${cur}${formatMoney(li.unitPrice)}`, 150, rowY, { align: "right" });
      doc.text(`${cur}${formatMoney(rowAmount)}`, 170, rowY, { align: "right" });
      rowY += Math.max(rowLines.length, 1) * 6;
    });
    rowY += 4;
    doc.setFontSize(11);
    doc.text("Subtotal", 150, rowY, { align: "right" });
    doc.text(`${cur}${formatMoney(invoice.amount)}`, 170, rowY, { align: "right" });
    lineY = rowY + 10;
  } else {
    doc.text("Description", left, dividerY + 10);
    doc.text("Amount", 170, dividerY + 10, { align: "right" });
    doc.setFontSize(10);
    const descLines = doc.splitTextToSize(invoice.description || "Animation services", 140);
    doc.text(descLines, left, dividerY + 18);
    doc.text(`${cur}${formatMoney(invoice.amount)}`, 170, dividerY + 18, { align: "right" });
    lineY = dividerY + 18 + descLines.length * 6 + 6;
  }

  doc.setDrawColor(200);
  doc.line(left, lineY, right, lineY);

  doc.setFontSize(10);
  doc.text("Amount paid", 130, lineY + 10);
  doc.text(`${cur}${formatMoney(invoice.amountPaid)}`, 170, lineY + 10, { align: "right" });
  doc.setFontSize(12);
  doc.text("Balance due", 130, lineY + 20);
  doc.text(`${cur}${formatMoney(balance)}`, 170, lineY + 20, { align: "right" });

  doc.setFontSize(9);
  doc.setTextColor(130);
  const studioDisplayName = settings.studioLegalName || settings.studioName || "Studio Kairegi";
  const noteByType = {
    proforma: "This is a proforma invoice / advance payment request. A final invoice will be issued upon delivery.",
    receipt: `This receipt confirms payment received. Thank you for working with ${studioDisplayName}.`,
    invoice: `Thank you for working with ${studioDisplayName}.`,
  };
  const noteLines = doc.splitTextToSize(noteByType[docType] || noteByType.invoice, 170);
  doc.text(noteLines, left, lineY + 40);

  doc.save(`${invoice.invoiceNumber || "invoice"}.pdf`);
}


function cardFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    client: row.client,
    rate: row.rate,
    due: row.due,
    priority: row.priority,
    notes: row.notes,
    stage: row.stage,
    reviewStatus: row.review_status || "in_progress",
    revisions: Array.isArray(row.revisions) ? row.revisions : [],
    revisionVersion: row.revision_version || 1,
    assignedTo: row.assigned_to || "",
    assignedMemberId: row.assigned_member_id || "",
    assignedPay: row.assigned_pay || "",
    assignedPaid: row.assigned_paid || false,
    shareToken: row.share_token || null,
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
    deliverables: Array.isArray(row.deliverables) ? row.deliverables : [],
  };
}

function cardToRow(card, userId) {
  return {
    project_id: card.projectId,
    title: card.title,
    client: card.client,
    rate: card.rate,
    due: card.due,
    priority: card.priority,
    notes: card.notes,
    stage: card.stage,
    review_status: card.reviewStatus || "in_progress",
    revisions: card.revisions || [],
    revision_version: card.revisionVersion || 1,
    assigned_to: card.assignedTo || "",
    assigned_member_id: card.assignedMemberId || null,
    assigned_pay: parseMoney(card.assignedPay),
    assigned_paid: card.assignedPaid || false,
    share_token: card.shareToken || null,
    // Deliberately NOT including attachments (or deliverables, which was
    // already left out here) - both are mutated exclusively through their
    // own atomic append/remove RPCs (append_shot_file / remove_shot_file /
    // studio-drive-delete), which touch just the one changed entry. Writing
    // the whole locally-snapshotted array back on every ordinary shot save
    // (renaming it, moving its stage, editing notes, etc.) would silently
    // clobber anything a concurrent upload/removal - in this tab or
    // another - had appended or removed since this editor's form state was
    // last synced with the database. Omitting the key means Supabase's
    // partial UPDATE simply doesn't touch that column, leaving whatever's
    // actually in the database alone.
    user_id: userId,
  };
}

function shotFileName(card) {
  const slug = (card.title || "shot").trim().toLowerCase().replace(/\s+/g, "_");
  const version = String(card.revisionVersion || 1).padStart(2, "0");
  return `${slug}_${card.stage}_v${version}`;
}

function generateShotChecklist(count, projectId, client) {
  const total = Math.max(0, Math.min(500, parseInt(count, 10) || 0));
  const padWidth = Math.max(2, String(total).length);
  return Array.from({ length: total }, (_, i) => ({
    projectId,
    title: `Cut ${String(i + 1).padStart(padWidth, "0")}`,
    client: client || "",
    rate: "",
    due: "",
    priority: "normal",
    notes: "",
    stage: STAGES[0].id,
  }));
}

function emptyEmails() {
  return [
    { label: "Initial Email", message: "", sent: false, dateSent: null },
    { label: "Follow-up 1", message: "", sent: false, dateSent: null },
    { label: "Follow-up 2", message: "", sent: false, dateSent: null },
    { label: "Follow-up 3", message: "", sent: false, dateSent: null },
    { label: "Follow-up 4", message: "", sent: false, dateSent: null },
  ];
}

// Older leads only have 4 slots (Initial + 3 follow-ups). Pad them with the
// new Follow-up 4 slot so the schedule/automation code can always assume 5.
function normalizeEmails(emails) {
  const base = emails && emails.length ? emails : emptyEmails();
  if (base.length >= 5) return base;
  const padded = [...base];
  while (padded.length < 5) {
    padded.push({ label: `Follow-up ${padded.length}`, message: "", sent: false, dateSent: null });
  }
  return padded;
}

function emptyLead(stage = "pool", channel = "") {
  return {
    companyName: "",
    contactPerson: "",
    email: "",
    website: "",
    country: "",
    billingAddress: "",
    taxId: "",
    notes: "",
    stage,
    channel,
    priority: "warm",
    needsFollowup: false,
    lastContactedAt: null,
    activityLog: [],
    archivedAt: null,
    stageChangedAt: null,
    emails: emptyEmails(),
    proposedBudget: "",
    estimatedDeadline: "",
    projectNotes: "",
    // Why this lead ended where it did. Not a stage - see the
    // DISQUALIFY_REASONS/LOST_REASONS block above.
    outcomeReason: "",
    linkedProjectId: null,
  };
}

function leadFromRow(row) {
  return {
    id: row.id,
    companyName: row.company_name,
    contactPerson: row.contact_person,
    email: row.email,
    website: row.website,
    country: row.country,
    billingAddress: row.billing_address || "",
    taxId: row.tax_id || "",
    notes: row.notes,
    stage: row.stage,
    channel: row.channel || "",
    priority: row.priority || "warm",
    needsFollowup: row.needs_followup || false,
    lastContactedAt: row.last_contacted_at || null,
    activityLog: Array.isArray(row.activity_log) ? row.activity_log : [],
    archivedAt: row.archived_at || null,
    stageChangedAt: row.stage_changed_at || row.created_at || null,
    emails: normalizeEmails(row.emails),
    proposedBudget: row.proposed_budget,
    estimatedDeadline: row.estimated_deadline,
    projectNotes: row.project_notes,
    // outcome_reason is the field going forward; lost_reason is the old
    // lost-only column, kept as a read fallback so leads saved before
    // migration_audit_fixes_10.sql still show their reason. Both are
    // written on every save (see leadToRow), so they can't drift.
    outcomeReason: row.outcome_reason || row.lost_reason || "",
    linkedProjectId: row.linked_project_id,
    createdAt: row.created_at || null,
  };
}

function leadToRow(lead, userId) {
  return {
    company_name: lead.companyName,
    contact_person: lead.contactPerson,
    email: lead.email,
    website: lead.website,
    country: lead.country,
    billing_address: lead.billingAddress || "",
    tax_id: lead.taxId || "",
    notes: lead.notes,
    stage: lead.stage,
    channel: lead.channel || "",
    priority: lead.priority || "warm",
    needs_followup: !!lead.needsFollowup,
    last_contacted_at: lead.lastContactedAt || null,
    activity_log: lead.activityLog || [],
    archived_at: lead.archivedAt || null,
    stage_changed_at: lead.stageChangedAt || null,
    emails: lead.emails,
    proposed_budget: lead.proposedBudget,
    estimated_deadline: lead.estimatedDeadline,
    project_notes: lead.projectNotes,
    outcome_reason: lead.outcomeReason || "",
    // Written in lockstep with outcome_reason so the legacy column never
    // holds a stale value that the read fallback above could resurrect
    // after someone clears the reason.
    lost_reason: lead.outcomeReason || "",
    linked_project_id: lead.linkedProjectId || null,
    user_id: userId,
  };
}

// ---- Lead lifecycle helpers (shared by the board, editor, and dashboard) ----

const STAGE_ACTIVITY_LABEL = {
  pool: "Moved back to New",
  cold_email: "Cold email sent",
  responded: "Lead responded",
  qualified: "Qualified",
  proposal: "Proposal sent",
  negotiation: "Entered negotiation",
  won: "Won",
  lost: "Marked lost",
  no_response: "No response after follow-ups",
  disqualified: "Disqualified",
  closed: "Closed",
};

// True if `lead` has a stage-change activity-log entry for `stageId` whose
// timestamp satisfies `matches(ts)`. Shared by the Outreach performance
// trend chart and the Cold email success rate funnel so both agree on what
// counts as e.g. "responded" or "won" - an actual logged stage-change
// event, not "the stage happens to be X right now" - instead of each
// re-deriving its own copy of this check against hardcoded label strings.
function hadStageEvent(lead, stageId, matches) {
  const note = STAGE_ACTIVITY_LABEL[stageId];
  return (lead.activityLog || []).some((a) => a.type === "stage_change" && a.note === note && matches(a.ts));
}

// Diffs the previous saved lead against the form about to be saved and
// returns new activity-log entries for anything meaningful that changed.
// Centralizing this in one place (called right before every save) means
// every stage/priority/follow-up/archive change gets logged automatically,
// without having to remember to log it at each call site.
function buildActivityEntries(oldLead, newLead) {
  const entries = [];
  const now = new Date().toISOString();
  if (!oldLead) {
    entries.push({ ts: now, type: "created", note: "Lead created" });
  } else {
    const oldEmails = normalizeEmails(oldLead.emails);
    const newEmails = normalizeEmails(newLead.emails);
    newEmails.forEach((em, i) => {
      if (em.sent && !oldEmails[i]?.sent) {
        const note = i === 0 ? "Initial cold email sent" : `${em.label} sent`;
        entries.push({ ts: now, type: "email_sent", note });
      }
    });
    if (oldLead.stage !== newLead.stage) {
      entries.push({
        ts: now,
        type: "stage_change",
        note: STAGE_ACTIVITY_LABEL[newLead.stage] || `Status changed to ${newLead.stage}`,
      });
    }
    // Logged as its own entry type, never as a stage_change - hadStageEvent
    // matches on stage_change notes, so folding a reason in here would
    // corrupt the dashboard funnel counts.
    if ((oldLead.outcomeReason || "") !== (newLead.outcomeReason || "")) {
      entries.push({
        ts: now,
        type: "outcome_reason",
        note: newLead.outcomeReason ? `Outcome reason: ${newLead.outcomeReason}` : "Outcome reason cleared",
      });
    }
    if (!oldLead.needsFollowup && newLead.needsFollowup) {
      entries.push({ ts: now, type: "followup_flag", note: "Marked as needing follow-up" });
    }
    if (oldLead.priority !== newLead.priority) {
      const p = LEAD_PRIORITIES.find((x) => x.id === newLead.priority);
      entries.push({ ts: now, type: "priority_change", note: `Priority set to ${p ? p.label : newLead.priority}` });
    }
    if (!oldLead.archivedAt && newLead.archivedAt) {
      entries.push({ ts: now, type: "archived", note: "Lead archived" });
    }
    if (oldLead.archivedAt && !newLead.archivedAt) {
      entries.push({ ts: now, type: "restored", note: "Lead restored" });
    }
  }
  return entries;
}

// "YYYY-MM-DD" parsed via `new Date(str)` is interpreted as UTC midnight,
// which reads as the previous calendar day for anyone west of UTC (all of
// North/South America). Parse the parts directly instead, so the date
// lands on local midnight of the intended calendar day.
function parseLocalDateStr(dateStr) {
  const [y, m, d] = (dateStr || "").split("-").map(Number);
  if (!y || !m || !d) return new Date(NaN);
  return new Date(y, m - 1, d);
}

// Given a lead and the studio's follow-up cadence, figures out what's next:
// which slot is due, when, and what the lead card/editor should say about
// it. Returns null once outreach is over (terminal stage, or all 5 emails
// already sent).
function computeFollowupStatus(lead, schedule = DEFAULT_FOLLOWUP_SCHEDULE) {
  const emails = normalizeEmails(lead.emails);
  const isTerminal = isLeadStageTerminal(lead.stage);
  const anchorStr = emails[0]?.dateSent;
  const lastSent = emails.filter((e) => e.sent && e.dateSent).map((e) => e.dateSent).sort().pop() || null;

  if (!anchorStr) {
    return {
      nextActionLabel: "Send initial email",
      dueLabel: null,
      lastContactedLabel: null,
      isDue: false,
      daysUntilDue: null,
    };
  }

  const nextIndex = emails.findIndex((e) => !e.sent);
  if (isTerminal || nextIndex === -1) {
    return {
      nextActionLabel: nextIndex === -1 ? "No response after 4 follow-ups" : null,
      dueLabel: null,
      lastContactedLabel: lastSent ? formatShortDate(lastSent) : null,
      isDue: false,
      daysUntilDue: null,
    };
  }

  const anchor = parseLocalDateStr(anchorStr);
  const dayOffset = schedule[nextIndex]?.dayOffset ?? 0;
  const due = new Date(anchor);
  due.setDate(due.getDate() + dayOffset);
  const today = new Date();
  const daysUntilDue = Math.round((due.setHours(0, 0, 0, 0) - today.setHours(0, 0, 0, 0)) / 86400000);

  let dueLabel;
  if (daysUntilDue < 0) dueLabel = `Follow-up overdue by ${Math.abs(daysUntilDue)}d`;
  else if (daysUntilDue === 0) dueLabel = "Follow-up due today";
  else dueLabel = `Follow-up in ${daysUntilDue}d`;

  return {
    nextActionLabel: emails[nextIndex]?.label || null,
    dueLabel,
    lastContactedLabel: lastSent ? formatShortDate(lastSent) : null,
    isDue: daysUntilDue <= 0,
    daysUntilDue,
  };
}

function formatShortDate(dateStr) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(dateStr || "") ? parseLocalDateStr(dateStr) : new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ---- Smart duplicate detection ----
// Normalizes free-text so trivially different spellings of the same
// company/website compare as equal ("Example Studios Ltd" vs "example
// studios", "https://www.x.com/" vs "x.com").
function normalizeCompanyName(name) {
  return (name || "")
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\b(ltd|llc|inc|studio|studios|games|co|corp|company)\b/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function normalizeWebsite(url) {
  return (url || "")
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

function normalizeEmailStr(email) {
  return (email || "").toLowerCase().trim();
}

// Returns possible duplicates of `form` among `leads` (excluding the lead
// being edited), each tagged with a confidence level so the UI can decide
// how loudly to warn. Very high/high confidence blocks a silent save; medium
// is a soft, dismissible hint.
function findPossibleDuplicates(form, leads, excludeId) {
  const email = normalizeEmailStr(form.email);
  const website = normalizeWebsite(form.website);
  const company = normalizeCompanyName(form.companyName);
  const contact = (form.contactPerson || "").toLowerCase().trim();
  if (!email && !website && !company) return [];

  const matches = [];
  for (const lead of leads) {
    if (!lead || lead.id === excludeId) continue;
    const leadEmail = normalizeEmailStr(lead.email);
    const leadWebsite = normalizeWebsite(lead.website);
    const leadCompany = normalizeCompanyName(lead.companyName);
    const leadContact = (lead.contactPerson || "").toLowerCase().trim();

    let confidence = null;
    if (email && leadEmail && email === leadEmail) confidence = "very_high";
    else if (website && leadWebsite && website === leadWebsite) confidence = "very_high";
    else if (company && leadCompany && company === leadCompany) {
      confidence = contact && leadContact && contact === leadContact ? "very_high" : "high";
    } else if (
      company &&
      leadCompany &&
      company.length >= 4 &&
      leadCompany.length >= 4 &&
      (company.startsWith(leadCompany) || leadCompany.startsWith(company))
    ) {
      confidence = "medium";
    }

    if (confidence) matches.push({ lead, confidence });
  }

  const rank = { very_high: 0, high: 1, medium: 2 };
  return matches.sort((a, b) => rank[a.confidence] - rank[b.confidence]);
}

function friendlyAuthError(err) {
  const msg = err?.message || "Something went wrong";
  const map = {
    "Invalid login credentials": "Incorrect email or password.",
    "User already registered": "An account already exists with that email.",
    "Password should be at least 6 characters.": "Password should be at least 6 characters.",
  };
  return map[msg] || msg;
}

const ClapperIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 8.5 20 5l.7 3.5L4 12z" />
    <path d="M3 8.5 20.5 12 19 20a1 1 0 0 1-1 .8H5a1 1 0 0 1-1-1z" />
    <path d="m7 6 3 3M12 5l3 3M17 4l3 3" />
  </svg>
);

const PlusIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

const TrashIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-13" />
  </svg>
);

const CloseIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <path d="m6 6 12 12M18 6 6 18" />
  </svg>
);

const BackIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="m15 18-6-6 6-6" />
  </svg>
);

const FolderIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
  </svg>
);

const ArchiveIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <path d="M5 8v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
    <path d="M10 12h4" />
  </svg>
);

const RestoreIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
  </svg>
);

const EditIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);

const SpinnerIcon = ({ size = 18 }) => (
  <svg className="kf-spin" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <path d="M12 3a9 9 0 1 0 9 9" />
  </svg>
);

const CopyIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
  </svg>
);

const InvoiceIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M7 3h10a1 1 0 0 1 1 1v16l-3-2-2 2-2-2-2 2-3-2V4a1 1 0 0 1 1-1z" />
    <path d="M9 8h6M9 12h6M9 16h3" />
  </svg>
);

const TeamIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="9" cy="8" r="3" />
    <path d="M2 20c0-3.3 3.1-6 7-6s7 2.7 7 6" />
    <circle cx="17" cy="7" r="2.5" />
    <path d="M16 12.2c2.6.5 4.5 2.4 5 5.8" />
  </svg>
);

const DownloadIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 4v12m0 0-4-4m4 4 4-4M5 20h14" />
  </svg>
);

const SignOutIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5" />
    <path d="M21 12H9" />
  </svg>
);

const LockIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="11" width="16" height="9" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);

const GearIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

const TargetIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="5" />
    <circle cx="12" cy="12" r="1" fill="currentColor" />
  </svg>
);

const CheckCircleIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="m8 12 2.5 2.5L16 9" />
  </svg>
);

const XCircleIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="m9 9 6 6m0-6-6 6" />
  </svg>
);

const ClockIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3.5 2" />
  </svg>
);

const PopOutIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="14" rx="2" />
    <rect x="12.5" y="10.5" width="7" height="5" rx="1.2" fill="currentColor" stroke="none" />
  </svg>
);

const ChartIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 20V11M12 20V4M20 20v-6" />
  </svg>
);

const TrendIcon = ({ direction = "up" }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    {direction === "up" ? <path d="M4 17 10 11 14 15 20 7M14 7h6v6" /> : <path d="M4 7 10 13 14 9 20 17M14 17h6v-6" />}
  </svg>
);

const BellIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 8a6 6 0 0 1 12 0c0 4 1.5 5.5 2 6H4c.5-.5 2-2 2-6Z" />
    <path d="M10 20a2 2 0 0 0 4 0" />
  </svg>
);

const CalendarIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3.5" y="5" width="17" height="16" rx="2.5" />
    <path d="M8 3v4M16 3v4M3.5 10h17" />
  </svg>
);

export default function ShotTracker() {
  const [session, setSession] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authMode, setAuthMode] = useState(() =>
    new URLSearchParams(window.location.search).get("signup") === "1" ? "signup" : "signin"
  );
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authNotice, setAuthNotice] = useState("");
  const [isPasswordRecovery, setIsPasswordRecovery] = useState(false);
  const [newPassword, setNewPassword] = useState("");

  const [data, setData] = useState({
    projects: [],
    cards: [],
    leads: [],
    invoices: [],
    expenses: [],
    teamMembers: [],
    activity: [],
    budgetPlanners: [],
    plannerTemplates: [],
  });
  const { projects, cards, leads, invoices, expenses, teamMembers, activity, budgetPlanners, plannerTemplates } = data;
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  // Keeps the module-level flag notifyBrowser() checks in sync with the
  // account setting. Runs on every settings load/change, including the
  // initial DEFAULT_SETTINGS render, so nothing can notify before this has
  // had a chance to turn it off.
  useEffect(() => {
    setNotificationsEnabledFlag(settings.notificationsEnabled);
  }, [settings.notificationsEnabled]);
  const [fxRates, setFxRates] = useState({});
  const [fxUpdatedAt, setFxUpdatedAt] = useState(null);
  const [driveEmail, setDriveEmail] = useState(null);
  const [driveNotice, setDriveNotice] = useState("");
  // Shown when the project-card Drive shortcut is used before Drive is
  // connected. Kept separate from driveNotice (which only ever holds plain
  // post-OAuth-redirect text) since this one needs an action button.
  const [driveConnectPrompt, setDriveConnectPrompt] = useState(false);
  const [patreonEmail, setPatreonEmail] = useState(null);
  const [patreonIsPro, setPatreonIsPro] = useState(false);
  const [patreonConnected, setPatreonConnected] = useState(false);
  const [patreonNotice, setPatreonNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [workspace, setWorkspace] = useState("dashboard"); // "dashboard" | "projects" | "leads" | "finance" | "teams"
  const [view, setView] = useState("projects");
  const [boardTab, setBoardTab] = useState("shots"); // "shots" | "invoices" | "activity"
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [editingCard, setEditingCard] = useState(null);
  const [editingProject, setEditingProject] = useState(null);
  const [editingLead, setEditingLead] = useState(null);
  const [editingInvoice, setEditingInvoice] = useState(null);
  const [editingExpense, setEditingExpense] = useState(null);
  const [editingBudgetPlanner, setEditingBudgetPlanner] = useState(null);
  const [editingTeamMember, setEditingTeamMember] = useState(null);
  const [teamMemberSaveError, setTeamMemberSaveError] = useState("");
  const [teamsLoadError, setTeamsLoadError] = useState("");
  const loggingPaymentFor = useRef(new Set()); // shot ids currently mid-flight in handleLogShotExpense
  const [showMilestoneModal, setShowMilestoneModal] = useState(false);
  const [settingsReturnView, setSettingsReturnView] = useState("projects");
  const [showTutorial, setShowTutorial] = useState(false);
  const [showSupportModal, setShowSupportModal] = useState(false);
  const [tutorialHighlightTarget, setTutorialHighlightTarget] = useState(null);
  const [pendingLeadLinkId, setPendingLeadLinkId] = useState(null);
  const [dragOverStage, setDragOverStage] = useState(null);
  const [leadChannelFilter, setLeadChannelFilter] = useState("all");
  const [leadSearch, setLeadSearch] = useState("");
  const [leadStatusFilter, setLeadStatusFilter] = useState("all");
  const [leadPriorityFilter, setLeadPriorityFilter] = useState("all");
  const [leadFollowupFilter, setLeadFollowupFilter] = useState("all");
  const [showArchivedLeads, setShowArchivedLeads] = useState(false);

  // Shared by the Kanban board columns and the archived-leads list, so
  // toggling "Show archived" doesn't leave the search/channel/priority/
  // status/follow-up filters looking live while actually doing nothing.
  const leadMatchesActiveFilters = (l) => {
    if (leadChannelFilter !== "all" && l.channel !== leadChannelFilter) return false;
    if (leadPriorityFilter !== "all" && l.priority !== leadPriorityFilter) return false;
    if (leadStatusFilter !== "all" && l.stage !== leadStatusFilter) return false;
    const searchText = leadSearch.trim().toLowerCase();
    if (searchText) {
      const haystack = [l.companyName, l.contactPerson, l.email, l.website, l.notes]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(searchText)) return false;
    }
    if (leadFollowupFilter !== "all") {
      const status = computeFollowupStatus(l, settings.followupSchedule || DEFAULT_FOLLOWUP_SCHEDULE);
      const notStarted = status.nextActionLabel === "Send initial email";
      if (leadFollowupFilter === "due" && !status.isDue) return false;
      if (leadFollowupFilter === "upcoming" && (status.isDue || status.daysUntilDue == null)) return false;
      if (leadFollowupFilter === "completed" && (notStarted || status.daysUntilDue !== null)) return false;
      if (leadFollowupFilter === "none" && !notStarted) return false;
    }
    return true;
  };
  const [dragVisual, setDragVisual] = useState(null);
  const [saveState, setSaveState] = useState("idle");

  const dataRef = useRef(data);
  const dragStateRef = useRef(null);
  const suppressClickRef = useRef(false);
  const hasAppliedLandingTab = useRef(false);
  const hasCheckedTutorial = useRef(false);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  // Auth session bootstrap and listener
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setAuthLoading(false);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      if (_event === "PASSWORD_RECOVERY") {
        setIsPasswordRecovery(true);
      }
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  // Google (and other OAuth) sign-in failures come back as ?error=... or
  // #error=... on the redirect, not as a thrown exception, since the actual
  // failure happens on Google's or Supabase's side after the browser has
  // already navigated away. Without this, a failed OAuth attempt silently
  // dumps the user back on a blank login screen with no explanation.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const errorDescription =
      params.get("error_description") || hashParams.get("error_description") || params.get("error") || hashParams.get("error");
    if (errorDescription) {
      setAuthError(decodeURIComponent(errorDescription).replace(/\+/g, " "));
      const cleanUrl = window.location.pathname;
      window.history.replaceState({}, "", cleanUrl);
    }
  }, []);

  // Tidy up ?signup=1 from the URL once we've used it to pick the initial
  // auth mode, no need for it to linger in the address bar.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("signup") === "1") {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);


  const userId = session?.user?.id || null;

  const refreshFxRates = useCallback(async () => {
    const result = await fetchExchangeRates();
    setFxRates(result.rates || {});
    setFxUpdatedAt(result.updatedAt);
  }, []);

  useEffect(() => {
    if (userId) refreshFxRates();
  }, [userId, refreshFxRates]);

  const loadDriveStatus = useCallback(async () => {
    if (!userId) return;
    try {
      const { data: row } = await supabase
        .from("google_drive_connections")
        .select("connected_email")
        .eq("user_id", userId)
        .maybeSingle();
      setDriveEmail(row?.connected_email || null);
    } catch (e) {
      console.error("Drive status check failed:", e);
    }
  }, [userId]);

  useEffect(() => {
    if (userId) loadDriveStatus();
  }, [userId, loadDriveStatus]);

  // Picks up ?drive=connected or ?drive=needs_reconsent after the OAuth
  // redirect lands back on the app, shows a quick notice, then tidies the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const driveResult = params.get("drive");
    if (!driveResult) return;
    if (driveResult === "connected") {
      setDriveNotice("Google Drive connected.");
      loadDriveStatus();
    } else if (driveResult === "needs_reconsent") {
      setDriveNotice(
        "Google didn't return a fresh connection. Try disconnecting in your Google Account's third-party access settings, then connect again."
      );
    }
    params.delete("drive");
    const cleanUrl = `${window.location.pathname}${params.toString() ? "?" + params.toString() : ""}`;
    window.history.replaceState({}, "", cleanUrl);
    setTimeout(() => setDriveNotice(""), 6000);
  }, [loadDriveStatus]);

  const handleConnectDrive = async () => {
    const {
      data: { session: currentSession },
    } = await supabase.auth.getSession();
    if (!currentSession) return;
    // The old flow put the raw access token in this URL as ?token=...,
    // which a full-page redirect can't avoid unless the token itself is
    // never in the URL to begin with - so this authenticated fetch (a
    // proper Authorization header, not a query param) trades it for a
    // short-lived, single-use intent id first. See
    // migration_oauth_intents.sql.
    try {
      const res = await fetch(functionUrl("oauth-start-intent"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${currentSession.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ provider: "google_drive" }),
      });
      const result = await res.json();
      if (!res.ok || !result?.intentId) throw new Error(result?.error || "Couldn't start connecting Drive");
      window.location.href = `${functionUrl("google-drive-connect")}?intent=${result.intentId}`;
    } catch (err) {
      console.error("Starting Drive connect failed:", err);
      setDriveNotice("Couldn't connect to Google Drive, please try again.");
    }
  };

  const loadPatreonStatus = useCallback(async () => {
    if (!userId) return;
    try {
      const { data: row } = await supabase
        .from("patreon_connections")
        .select("connected_email, is_pro")
        .eq("user_id", userId)
        .maybeSingle();
      setPatreonConnected(!!row);
      setPatreonEmail(row?.connected_email || null);
      setPatreonIsPro(row?.is_pro || false);
    } catch (e) {
      console.error("Patreon status check failed:", e);
    }
  }, [userId]);

  useEffect(() => {
    if (userId) loadPatreonStatus();
  }, [userId, loadPatreonStatus]);

  // "Become a Patron" opens Patreon's checkout in a new tab, there's no
  // redirect back into the app with a query param the way the OAuth connect
  // flow has, so this is what closes that gap: if someone's connected but
  // not yet Pro, re-check silently whenever they return to this tab, rather
  // than making them remember to hit "Refresh status" themselves.
  useEffect(() => {
    if (!userId || patreonIsPro || !patreonConnected) return;
    const handleVisibility = () => {
      if (document.visibilityState !== "visible") return;
      loadPatreonStatus();
      supabase
        .from("user_settings")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle()
        .then(({ data: row }) => {
          if (row) setSettings(settingsFromRow(row));
        });
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [userId, patreonIsPro, patreonConnected, loadPatreonStatus]);

  // Picks up ?patreon=connected after the OAuth redirect lands back on the
  // app. The callback function already updated user_settings.plan on the
  // server, this just refreshes local state to match and shows a notice.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const patreonResult = params.get("patreon");
    if (!patreonResult) return;
    if (patreonResult === "connected") {
      setPatreonNotice("Patreon connected.");
      loadPatreonStatus();
      // Refresh settings directly rather than depending on loadSettings,
      // which is declared further down this component.
      supabase
        .from("user_settings")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle()
        .then(({ data: row }) => {
          if (row) setSettings(settingsFromRow(row));
        });
    } else if (patreonResult === "already_linked") {
      setPatreonNotice("That Patreon account is already connected to a different Kairil account.");
    } else if (patreonResult === "error") {
      setPatreonNotice("Couldn't connect Patreon, please try again from Settings.");
    }
    params.delete("patreon");
    const cleanUrl = `${window.location.pathname}${params.toString() ? "?" + params.toString() : ""}`;
    window.history.replaceState({}, "", cleanUrl);
    setTimeout(() => setPatreonNotice(""), 6000);
  }, [loadPatreonStatus]);

  const handleConnectPatreon = async () => {
    const {
      data: { session: currentSession },
    } = await supabase.auth.getSession();
    if (!currentSession) return;
    try {
      const res = await fetch(functionUrl("oauth-start-intent"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${currentSession.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ provider: "patreon" }),
      });
      const result = await res.json();
      if (!res.ok || !result?.intentId) throw new Error(result?.error || "Couldn't start connecting Patreon");
      window.location.href = `${functionUrl("patreon-connect")}?intent=${result.intentId}`;
    } catch (err) {
      console.error("Starting Patreon connect failed:", err);
      setPatreonNotice("Couldn't connect to Patreon, please try again.");
    }
  };

  const handleCreateDriveFolders = async (projectId, projectName) => {
    const {
      data: { session: currentSession },
    } = await supabase.auth.getSession();
    if (!currentSession) throw new Error("Not signed in");

    const res = await fetch(functionUrl("google-drive-create-folders"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${currentSession.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ projectId, projectName }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result?.error || "Couldn't create Drive folders");

    const driveFields = {
      driveFolderId: result.folderId,
      driveFolderUrl: result.folderUrl,
      driveDeliverablesFolderId: result.deliverablesFolderId,
      driveReferencesFolderId: result.referencesFolderId,
      driveCutsFolderId: result.cutsFolderId,
      driveAttachmentsFolderId: result.attachmentsFolderId,
    };
    setData((prev) => ({
      ...prev,
      projects: prev.projects.map((p) => (p.id === projectId ? { ...p, ...driveFields } : p)),
    }));
    return driveFields;
  };

  const loadSettings = useCallback(async () => {
    if (!userId) return;
    try {
      const { data: row, error } = await supabase
        .from("user_settings")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw error;
      if (row) {
        const loaded = settingsFromRow(row);
        setSettings(loaded);
        if (!hasAppliedLandingTab.current) {
          setWorkspace(loaded.defaultLandingTab || "dashboard");
          hasAppliedLandingTab.current = true;
        }
        if (!hasCheckedTutorial.current) {
          if (!loaded.hasSeenTutorial) setShowTutorial(true);
          hasCheckedTutorial.current = true;
        }
      } else {
        const { error: insertError } = await supabase
          .from("user_settings")
          .insert(settingsToRow(DEFAULT_SETTINGS, userId));
        if (insertError) throw insertError;
        setSettings(DEFAULT_SETTINGS);
        hasAppliedLandingTab.current = true;
        if (!hasCheckedTutorial.current) {
          setShowTutorial(true);
          hasCheckedTutorial.current = true;
        }
      }
    } catch (e) {
      console.error("Settings load failed:", e);
    }
  }, [userId]);

  useEffect(() => {
    if (userId) loadSettings();
    else setSettings(DEFAULT_SETTINGS);
  }, [userId, loadSettings]);

  // Batched "Needs Attention" desktop notification - checks on load and
  // every 5 minutes after, using the exact same counts DashboardPanel
  // shows, so a notification and the dashboard card it corresponds to
  // never disagree. Only fires when the combination of counts actually
  // changes (see shouldNotifyNeedsAttention) - re-checking with nothing
  // new stays silent rather than re-pinging the same due follow-ups every
  // five minutes.
  useEffect(() => {
    if (!userId || !notificationsSupported() || Notification.permission !== "granted") return;
    const checkNeedsAttention = () => {
      const schedule = settings.followupSchedule || DEFAULT_FOLLOWUP_SCHEDULE;
      const counts = computeNeedsAttentionCounts(leads, schedule);
      const total = counts.followupsDueToday + counts.hotAwaitingResponse + counts.proposalsAwaitingResponse + counts.approachingDeadline;
      if (total === 0) return;
      const todayStr = new Date().toDateString();
      const signature = `${todayStr}:${counts.followupsDueToday}:${counts.hotAwaitingResponse}:${counts.proposalsAwaitingResponse}:${counts.approachingDeadline}`;
      if (!shouldNotifyNeedsAttention(signature)) return;
      const parts = [
        counts.followupsDueToday > 0 && `${counts.followupsDueToday} follow-up${counts.followupsDueToday === 1 ? "" : "s"} due today`,
        counts.hotAwaitingResponse > 0 && `${counts.hotAwaitingResponse} hot lead${counts.hotAwaitingResponse === 1 ? "" : "s"} awaiting response`,
        counts.proposalsAwaitingResponse > 0 && `${counts.proposalsAwaitingResponse} proposal${counts.proposalsAwaitingResponse === 1 ? "" : "s"} awaiting response`,
        counts.approachingDeadline > 0 && `${counts.approachingDeadline} lead${counts.approachingDeadline === 1 ? "" : "s"} approaching follow-up deadline`,
      ].filter(Boolean);
      notifyBrowser("CRM needs your attention", parts.join(" \u00b7 "), "kairil-needs-attention");
      markNeedsAttentionNotified(signature);
    };
    checkNeedsAttention();
    const interval = setInterval(checkNeedsAttention, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [userId, leads, settings.followupSchedule]);

  const handleSaveSettings = async (nextSettings) => {
    setSaveState("saving");
    try {
      const { error } = await supabase
        .from("user_settings")
        .upsert(settingsToRow(nextSettings, userId), { onConflict: "user_id" });
      if (error) throw error;
      setSettings(nextSettings);
      flashSave(true);
    } catch (e) {
      console.error("Settings save failed:", e);
      flashSave(false);
    }
    setView(settingsReturnView);
  };

  // Adds a new channel to the shared, per-studio channel list (used by the
  // lead editor's "+" button) without requiring a trip through the full
  // Settings modal. The list lives on user_settings so it's shared between
  // the CRM board's filter chips and the dashboard breakdown.
  const handleAddLeadChannel = async (name) => {
    const trimmed = (name || "").trim();
    if (!trimmed) return;
    const existing = settings.leadChannels || DEFAULT_LEAD_CHANNELS;
    if (existing.some((c) => c.toLowerCase() === trimmed.toLowerCase())) return;
    const nextSettings = { ...settings, leadChannels: [...existing, trimmed] };
    setSettings(nextSettings);
    try {
      const { error } = await supabase
        .from("user_settings")
        .upsert(settingsToRow(nextSettings, userId), { onConflict: "user_id" });
      if (error) throw error;
    } catch (e) {
      console.error("Adding lead channel failed:", e);
    }
  };

  const handleCompleteTutorial = async () => {
    setShowTutorial(false);
    setTutorialHighlightTarget(null);
    if (settings.hasSeenTutorial) return;
    const next = { ...settings, hasSeenTutorial: true };
    setSettings(next);
    try {
      const { error } = await supabase
        .from("user_settings")
        .upsert(settingsToRow(next, userId), { onConflict: "user_id" });
      if (error) throw error;
    } catch (e) {
      console.error("Couldn't save tutorial status:", e);
    }
  };

  const handleReplayTutorial = () => {
    setView(settingsReturnView);
    setShowTutorial(true);
  };

  const handleSubmitSupportMessage = async (message) => {
    const { error } = await supabase.from("support_messages").insert({
      user_id: userId,
      email: session?.user?.email || "",
      message,
      page_context: `${workspace}${view === "board" ? " / board" : ""}`,
    });
    if (error) throw error;
  };

  const handleTutorialStepChange = (targetTab) => {
    setTutorialHighlightTarget(targetTab);
    if (targetTab && targetTab !== "settings") {
      setView("projects"); // make sure the tab row is visible, not stuck inside a project board
      setWorkspace(targetTab);
    }
  };

  const loadData = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const [projectsRes, shotsRes, leadsRes, invoicesRes, expensesRes, teamRes, activityRes, plannersRes, plannerTemplatesRes] = await Promise.all([
        supabase.from("projects").select("*").order("created_at"),
        supabase.from("shots").select("*").order("created_at"),
        supabase.from("leads").select("*").order("created_at"),
        supabase.from("invoices").select("*").order("created_at"),
        supabase.from("expenses").select("*").order("created_at"),
        supabase.from("team_members").select("*").order("created_at"),
        supabase.from("activity_log").select("*").order("created_at", { ascending: false }),
        supabase.from("budget_planners").select("*").order("created_at", { ascending: false }),
        supabase.from("planner_templates").select("*").order("created_at", { ascending: false }),
      ]);
      if (projectsRes.error) throw projectsRes.error;
      if (shotsRes.error) throw shotsRes.error;
      if (leadsRes.error) throw leadsRes.error;
      if (invoicesRes.error) throw invoicesRes.error;
      if (expensesRes.error) throw expensesRes.error;
      // Teams is intentionally NOT fatal to the rest of loadData: a missing/
      // unrun Teams migration (e.g. the status/archived_at columns) would
      // otherwise abort projects/shots/invoices/etc. too, blanking the
      // whole app over one module's schema problem. The error is still
      // surfaced (not swallowed) via teamsLoadError.
      if (teamRes.error) {
        console.error("Teams data failed to load:", teamRes.error);
        setTeamsLoadError(teamRes.error.message || "Team data failed to load.");
      } else {
        setTeamsLoadError("");
      }
      if (activityRes.error) throw activityRes.error;
      if (plannersRes.error) throw plannersRes.error;
      if (plannerTemplatesRes.error) throw plannerTemplatesRes.error;
      const nextProjects = (projectsRes.data || []).map((p) => ({
        id: p.id,
        name: p.name,
        client: p.client,
        clientAddress: p.client_address || "",
        clientTaxId: p.client_tax_id || "",
        notes: p.notes,
        budget: p.budget,
        budgetMode: p.budget_mode || "manual",
        currency: p.currency || "$",
        deadline: p.deadline,
        priority: p.priority,
        archived: p.archived,
        shareEnabled: p.share_enabled || false,
        shareToken: p.share_token || null,
        driveFolderId: p.drive_folder_id || null,
        driveFolderUrl: p.drive_folder_url || null,
        driveDeliverablesFolderId: p.drive_deliverables_folder_id || null,
        driveReferencesFolderId: p.drive_references_folder_id || null,
      }));
      const nextCards = (shotsRes.data || []).map(cardFromRow);
      const nextLeads = (leadsRes.data || []).map(leadFromRow);
      const nextInvoices = (invoicesRes.data || []).map(invoiceFromRow);
      const nextExpenses = (expensesRes.data || []).map(expenseFromRow);
      const nextTeamMembers = teamRes.error ? [] : (teamRes.data || []).map(teamMemberFromRow);
      const nextActivity = (activityRes.data || []).map((a) => ({
        id: a.id,
        projectId: a.project_id,
        shotId: a.shot_id,
        type: a.event_type,
        message: a.description,
        createdAt: a.created_at,
      }));
      const nextBudgetPlanners = (plannersRes.data || []).map(budgetPlannerFromRow);
      const nextPlannerTemplates = (plannerTemplatesRes.data || []).map(plannerTemplateFromRow);
      setData({
        projects: nextProjects,
        cards: nextCards,
        leads: nextLeads,
        invoices: nextInvoices,
        expenses: nextExpenses,
        teamMembers: nextTeamMembers,
        activity: nextActivity,
        budgetPlanners: nextBudgetPlanners,
        plannerTemplates: nextPlannerTemplates,
      });
    } catch (e) {
      console.error("Shot Tracker load failed:", e);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (userId) loadData();
    else
      setData({
        projects: [],
        cards: [],
        leads: [],
        invoices: [],
        expenses: [],
        teamMembers: [],
        activity: [],
        budgetPlanners: [],
        plannerTemplates: [],
      });
  }, [userId, loadData]);

  const flashSave = (ok) => {
    setSaveState(ok ? "saved" : "error");
    setTimeout(() => setSaveState("idle"), 1200);
  };

  const handleSaveProject = async (project) => {
    if (!project.id && atProjectLimit) {
      flashSave(false);
      return;
    }
    setSaveState("saving");
    try {
      const shareToken = project.shareEnabled ? project.shareToken || genShareToken() : project.shareToken;
      if (project.id) {
        const { error } = await supabase
          .from("projects")
          .update({
            name: project.name,
            client: project.client,
            client_address: project.clientAddress || "",
            client_tax_id: project.clientTaxId || "",
            notes: project.notes,
            budget: project.budget,
            budget_mode: project.budgetMode,
            currency: project.currency,
            deadline: project.deadline,
            priority: project.priority,
            share_enabled: project.shareEnabled,
            share_token: shareToken,
          })
          .eq("id", project.id);
        if (error) throw error;
        setData((prev) => ({
          ...prev,
          projects: prev.projects.map((p) =>
            p.id === project.id ? { ...project, shareToken } : p
          ),
        }));
      } else {
        // Previously this did two separate requests (insert project, then
        // insert the generated shot rows), so a failure on the shots insert
        // left a real project behind with zero shots and no automatic way
        // to retry just the missing part. create_project_with_shots() wraps
        // both inserts in one database transaction: either the project and
        // its full shot checklist are created together, or neither is.
        const { data: result, error } = await supabase.rpc("create_project_with_shots", {
          p_name: project.name,
          p_client: project.client,
          p_client_address: project.clientAddress || "",
          p_client_tax_id: project.clientTaxId || "",
          p_notes: project.notes,
          p_budget: project.budget,
          p_budget_mode: project.budgetMode,
          p_currency: project.currency,
          p_deadline: project.deadline,
          p_priority: project.priority,
          p_share_enabled: project.shareEnabled,
          p_share_token: shareToken,
          p_shot_count: parseInt(project.shotCount, 10) || 0,
        });
        if (error) throw error;
        const inserted = result.project;
        const newCards = (result.shots || []).map(cardFromRow);

        setData((prev) => ({
          ...prev,
          projects: [
            ...prev.projects,
            {
              id: inserted.id,
              name: inserted.name,
              client: inserted.client,
              clientAddress: inserted.client_address || "",
              clientTaxId: inserted.client_tax_id || "",
              notes: inserted.notes,
              budget: inserted.budget,
              budgetMode: inserted.budget_mode || "manual",
              currency: inserted.currency || "$",
              deadline: inserted.deadline,
              priority: inserted.priority,
              shareEnabled: inserted.share_enabled || false,
              shareToken: inserted.share_token || null,
              driveFolderId: inserted.drive_folder_id || null,
              driveFolderUrl: inserted.drive_folder_url || null,
              driveDeliverablesFolderId: inserted.drive_deliverables_folder_id || null,
              driveReferencesFolderId: inserted.drive_references_folder_id || null,
            },
          ],
          cards: [...prev.cards, ...newCards],
        }));

        try {
          await handleCreateDriveFolders(inserted.id, inserted.name);
        } catch (driveErr) {
          console.error("Drive folder provisioning failed:", driveErr);
        }

        if (pendingLeadLinkId) {
          const linkId = pendingLeadLinkId;
          setPendingLeadLinkId(null);
          try {
            const { error: linkError } = await supabase
              .from("leads")
              .update({ linked_project_id: inserted.id })
              .eq("id", linkId);
            if (linkError) throw linkError;
            setData((prev) => ({
              ...prev,
              leads: prev.leads.map((l) =>
                l.id === linkId ? { ...l, linkedProjectId: inserted.id } : l
              ),
            }));
          } catch (linkErr) {
            console.error("Linking lead to project failed:", linkErr);
          }
        }
      }
      flashSave(true);
      // Only close the editor once the save actually succeeded - closing
      // unconditionally (as this used to do) meant a failed save silently
      // discarded whatever the user had just typed, with no way to recover
      // it short of retyping the whole form.
      setEditingProject(null);
    } catch (e) {
      console.error("Project save failed:", e);
      flashSave(false);
      // Same reasoning as the cancel handler: don't let a pending
      // lead->project link survive to attach itself to a later,
      // unrelated project.
      if (!project.id && pendingLeadLinkId) setPendingLeadLinkId(null);
      // Keep the editor open on failure so the user can retry or fix
      // whatever caused the error without losing their unsaved changes.
    }
  };

  const handleDeleteProject = async (id) => {
    setSaveState("saving");
    try {
      // Best-effort: trash the project's Drive folder (and everything
      // nested under it - References/Cuts/Deliverables) before removing the
      // database row. This is deliberately non-fatal: if Drive cleanup
      // fails (not connected, token expired, API hiccup) the project
      // deletion below still proceeds, since the user asked to delete the
      // project, not to be blocked by an external service.
      const projectToDelete = projects.find((p) => p.id === id);
      if (projectToDelete?.driveFolderId) {
        try {
          const {
            data: { session: currentSession },
          } = await supabase.auth.getSession();
          if (currentSession) {
            const res = await fetch(functionUrl("studio-drive-delete-project"), {
              method: "POST",
              headers: {
                Authorization: `Bearer ${currentSession.access_token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ projectId: id }),
            });
            if (!res.ok) {
              const result = await res.json().catch(() => ({}));
              console.error("Trashing project Drive folder failed:", result?.error);
            }
          }
        } catch (driveErr) {
          console.error("Trashing project Drive folder failed:", driveErr);
        }
      }

      const { error } = await supabase.from("projects").delete().eq("id", id);
      if (error) throw error;
      // The database cascades this deletion into shots/invoices/activity
      // and nulls out expenses.project_id and leads.linked_project_id (see
      // schema.sql), but the in-memory state doesn't mirror any of that on
      // its own. Previously only projects/cards were filtered locally, so
      // Finance, Activity, and CRM could keep showing invoices, expenses,
      // and lead links that pointed at a project that no longer existed
      // until the next full reload.
      setData((prev) => ({
        ...prev,
        projects: prev.projects.filter((p) => p.id !== id),
        cards: prev.cards.filter((c) => c.projectId !== id),
        invoices: prev.invoices.filter((inv) => inv.projectId !== id),
        activity: prev.activity.filter((a) => a.projectId !== id),
        expenses: prev.expenses.map((e) => (e.projectId === id ? { ...e, projectId: null } : e)),
        leads: prev.leads.map((l) => (l.linkedProjectId === id ? { ...l, linkedProjectId: null } : l)),
      }));
      flashSave(true);
      // Only close the editor and navigate away once deletion actually
      // succeeded - doing this unconditionally used to make a failed
      // delete look like it had gone through.
      setEditingProject(null);
      if (selectedProjectId === id) {
        setView("projects");
        setSelectedProjectId(null);
      }
    } catch (e) {
      console.error("Project delete failed:", e);
      flashSave(false);
    }
  };

  const handleToggleArchive = async (id, archived) => {
    setSaveState("saving");
    try {
      const { error } = await supabase.from("projects").update({ archived }).eq("id", id);
      if (error) throw error;
      setData((prev) => ({
        ...prev,
        projects: prev.projects.map((p) => (p.id === id ? { ...p, archived } : p)),
      }));
      flashSave(true);
    } catch (e) {
      console.error("Archive toggle failed:", e);
      flashSave(false);
    }
  };

  const handleSaveCard = async (card) => {
    setSaveState("saving");
    try {
      if (card.id) {
        const previous = cards.find((c) => c.id === card.id);
        const { error } = await supabase
          .from("shots")
          .update(cardToRow(card, userId))
          .eq("id", card.id);
        if (error) throw error;
        setData((prev) => ({
          ...prev,
          cards: prev.cards.map((c) => (c.id === card.id ? card : c)),
        }));
        if (previous && previous.reviewStatus !== card.reviewStatus) {
          if (card.reviewStatus === "approved" || card.reviewStatus === "revisions") {
            const eventType = card.reviewStatus === "approved" ? "review_approved" : "review_revisions";
            const message =
              card.reviewStatus === "approved"
                ? `${card.title || "Shot"} was approved`
                : `Revisions requested on ${card.title || "shot"}`;
            try {
              const { error: logError } = await supabase.from("activity_log").insert({
                user_id: userId,
                project_id: card.projectId,
                shot_id: card.id,
                event_type: eventType,
                description: message,
              });
              if (logError) throw logError;
              setData((prev) => ({
                ...prev,
                activity: [
                  {
                    id: genShareToken(),
                    projectId: card.projectId,
                    shotId: card.id,
                    type: eventType,
                    message,
                    createdAt: new Date().toISOString(),
                  },
                  ...prev.activity,
                ],
              }));
            } catch (logErr) {
              console.error("Activity log failed:", logErr);
            }
          }
        }
      } else {
        const { data: inserted, error } = await supabase
          .from("shots")
          .insert(cardToRow(card, userId))
          .select()
          .single();
        if (error) throw error;
        setData((prev) => ({ ...prev, cards: [...prev.cards, cardFromRow(inserted)] }));
      }
      flashSave(true);
      setEditingCard(null);
    } catch (e) {
      console.error("Shot save failed:", e);
      flashSave(false);
      // Keep the editor open on failure so unsaved edits aren't lost.
    }
  };

  const handleDeleteCard = async (id) => {
    setSaveState("saving");
    try {
      const { error } = await supabase.from("shots").delete().eq("id", id);
      if (error) throw error;
      setData((prev) => ({ ...prev, cards: prev.cards.filter((c) => c.id !== id) }));
      flashSave(true);
      setEditingCard(null);
    } catch (e) {
      console.error("Shot delete failed:", e);
      flashSave(false);
    }
  };

  const moveCardStage = async (id, stage) => {
    const existing = data.cards.find((c) => c.id === id);
    if (existing && existing.stage === stage) return; // no-op guard, same reasoning as the drag dispatch check
    const resetFields = { reviewStatus: "in_progress", revisions: [], revisionVersion: 1 };
    setData((prev) => ({
      ...prev,
      cards: prev.cards.map((c) => (c.id === id ? { ...c, stage, ...resetFields } : c)),
    }));
    setSaveState("saving");
    try {
      const { error } = await supabase
        .from("shots")
        .update({
          stage,
          review_status: resetFields.reviewStatus,
          revisions: resetFields.revisions,
          revision_version: resetFields.revisionVersion,
        })
        .eq("id", id);
      if (error) throw error;
      flashSave(true);
    } catch (e) {
      console.error("Stage move failed:", e);
      flashSave(false);
      // The optimistic update above already moved the card in the UI. If
      // the database write failed, roll it back to the pre-move snapshot
      // instead of leaving the UI showing a stage that was never actually
      // saved (previously this just flashed an error and left the card
      // wherever the optimistic update had put it, out of sync with the
      // database until the next reload).
      if (existing) {
        setData((prev) => ({
          ...prev,
          cards: prev.cards.map((c) => (c.id === id ? existing : c)),
        }));
      }
    }
  };

  const moveCardStageRef = useRef(moveCardStage);
  useEffect(() => {
    moveCardStageRef.current = moveCardStage;
  });

  const handlePersistShotShareToken = async (shotId, token, attachments) => {
    if (!shotId) return;
    const patch = { share_token: token };
    if (attachments !== undefined) patch.attachments = attachments;
    try {
      const { error } = await supabase.from("shots").update(patch).eq("id", shotId);
      if (error) throw error;
      setData((prev) => ({
        ...prev,
        cards: prev.cards.map((c) =>
          c.id === shotId
            ? { ...c, shareToken: token, ...(attachments !== undefined ? { attachments } : {}) }
            : c
        ),
      }));
      flashSave(true);
    } catch (e) {
      console.error("Persisting share link failed:", e);
      flashSave(false);
    }
  };

  const handleSaveLead = async (leadInput) => {
    setSaveState("saving");
    // Diff against whatever we last persisted (not the possibly-stale form
    // state) so the activity log reflects real transitions, and every
    // stage/priority/follow-up/archive change gets recorded automatically
    // without every caller having to remember to log it.
    const oldLead = leadInput.id ? data.leads.find((l) => l.id === leadInput.id) : null;
    const lead = {
      ...leadInput,
      activityLog: [...(oldLead?.activityLog || []), ...buildActivityEntries(oldLead, leadInput)],
      stageChangedAt:
        !oldLead || oldLead.stage !== leadInput.stage
          ? new Date().toISOString()
          : oldLead.stageChangedAt || null,
    };
    try {
      let savedLead = lead;
      if (lead.id) {
        const { error } = await supabase.from("leads").update(leadToRow(lead, userId)).eq("id", lead.id);
        if (error) throw error;
        setData((prev) => ({
          ...prev,
          leads: prev.leads.map((l) => (l.id === lead.id ? lead : l)),
        }));
      } else {
        const { data: inserted, error } = await supabase
          .from("leads")
          .insert(leadToRow(lead, userId))
          .select()
          .single();
        if (error) throw error;
        savedLead = leadFromRow(inserted);
        setData((prev) => ({ ...prev, leads: [...prev.leads, savedLead] }));
      }
      flashSave(true);
      setEditingLead(null);
      return savedLead;
    } catch (e) {
      console.error("Lead save failed:", e);
      flashSave(false);
      return null;
    }
  };

  const handleArchiveLead = (lead) => handleSaveLead({ ...lead, archivedAt: new Date().toISOString() });
  const handleRestoreLead = (lead) => handleSaveLead({ ...lead, archivedAt: null });

  const handleDeleteLead = async (id) => {
    setSaveState("saving");
    try {
      const { error } = await supabase.from("leads").delete().eq("id", id);
      if (error) throw error;
      setData((prev) => ({ ...prev, leads: prev.leads.filter((l) => l.id !== id) }));
      flashSave(true);
    } catch (e) {
      console.error("Lead delete failed:", e);
      flashSave(false);
    }
    setEditingLead(null);
  };

  const moveLeadStage = async (id, stage) => {
    const oldLead = data.leads.find((l) => l.id === id);
    if (oldLead && oldLead.stage === stage) return; // no-op guard, same reasoning as the drag dispatch check
    const nowIso = new Date().toISOString();
    const entries = oldLead ? buildActivityEntries(oldLead, { ...oldLead, stage }) : [];
    setData((prev) => ({
      ...prev,
      leads: prev.leads.map((l) =>
        l.id === id
          ? { ...l, stage, stageChangedAt: nowIso, activityLog: [...(l.activityLog || []), ...entries] }
          : l
      ),
    }));
    setSaveState("saving");
    try {
      const { error } = await supabase
        .from("leads")
        .update({
          stage,
          stage_changed_at: nowIso,
          activity_log: [...(oldLead?.activityLog || []), ...entries],
        })
        .eq("id", id);
      if (error) throw error;
      flashSave(true);
    } catch (e) {
      console.error("Lead stage move failed:", e);
      flashSave(false);
      // Roll back the optimistic move - otherwise the board shows a stage
      // the database never actually accepted until the next full reload.
      if (oldLead) {
        setData((prev) => ({
          ...prev,
          leads: prev.leads.map((l) => (l.id === id ? oldLead : l)),
        }));
      }
    }
  };

  const moveLeadStageRef = useRef(moveLeadStage);
  useEffect(() => {
    moveLeadStageRef.current = moveLeadStage;
  });

  // Called from the lead editor: saves the lead as "won" and opens a
  // prefilled New Project form so no data has to be typed twice.
  const handleMarkWon = async (lead) => {
    const wonLead = { ...lead, stage: "won" };
    const saved = await handleSaveLead(wonLead);
    // Don't open project creation off a lead that didn't actually get
    // marked Won - that produced a real project with no corresponding
    // Won lead behind it if the save failed for any reason.
    if (!saved) return;
    // Use the saved lead's id, not lead.id - for a brand-new lead, lead.id
    // is undefined until the insert returns one, so falling back to
    // lead.id here silently dropped the link.
    setPendingLeadLinkId(saved.id || null);
    setWorkspace("projects");
    setView("projects");
    setEditingProject(
      emptyProject({
        name: lead.companyName,
        client: lead.contactPerson || lead.companyName,
        clientAddress: lead.billingAddress || "",
        clientTaxId: lead.taxId || "",
        notes: lead.projectNotes || lead.notes,
        budget: lead.proposedBudget,
        currency: settings.currencySymbol,
        deadline: lead.estimatedDeadline,
      })
    );
  };

  const handleMarkLost = async (lead, reason) => {
    await handleSaveLead({ ...lead, stage: "lost", outcomeReason: reason });
  };

  const handleSaveInvoice = async (invoice) => {
    setSaveState("saving");
    try {
      if (invoice.id) {
        const { error } = await supabase
          .from("invoices")
          .update(invoiceToRow(invoice, userId))
          .eq("id", invoice.id);
        if (error) throw error;
        setData((prev) => ({
          ...prev,
          invoices: prev.invoices.map((inv) => (inv.id === invoice.id ? invoice : inv)),
        }));
      } else {
        const { data: inserted, error } = await supabase
          .from("invoices")
          .insert(invoiceToRow(invoice, userId))
          .select()
          .single();
        if (error) throw error;
        setData((prev) => ({ ...prev, invoices: [...prev.invoices, invoiceFromRow(inserted)] }));
      }
      flashSave(true);
      setEditingInvoice(null);
    } catch (e) {
      console.error("Invoice save failed:", e);
      flashSave(false);
      // Keep the editor open on failure so unsaved edits aren't lost.
    }
  };

  const handleDeleteInvoice = async (id) => {
    setSaveState("saving");
    try {
      const { error } = await supabase.from("invoices").delete().eq("id", id);
      if (error) throw error;
      setData((prev) => ({ ...prev, invoices: prev.invoices.filter((inv) => inv.id !== id) }));
      flashSave(true);
      setEditingInvoice(null);
    } catch (e) {
      console.error("Invoice delete failed:", e);
      flashSave(false);
    }
  };

  const handleMarkInvoicePaid = async (invoice) => {
    const updated = {
      ...invoice,
      status: "paid",
      amountPaid: invoice.amount,
      paidDate: new Date().toISOString().slice(0, 10),
    };
    await handleSaveInvoice(updated);
  };

  // Opens a prefilled New document form seeded from an existing proforma
  // or receipt, rather than saving anything directly - same pattern as
  // handleMarkWon's prefilled New Project form, so the person reviews
  // (and can adjust dates, description, amounts) before it's actually
  // saved as its own row. The number keeps the source's series with the
  // new type's prefix swapped in, so a proforma, its receipt, and its
  // final invoice all read as the same document as it progresses.
  const handleGenerateFollowupDoc = (source, targetDocType) => {
    const projectInvoicesForNumbering = invoices.filter((inv) => inv.projectId === source.projectId);
    const suggestedNumber =
      numberForDocType(source.invoiceNumber, targetDocType) ||
      nextInvoiceNumber(projectInvoicesForNumbering, targetDocType);
    const isReceipt = targetDocType === "receipt";
    setEditingInvoice({
      ...emptyInvoice(source.projectId, suggestedNumber, source.currency, targetDocType),
      description: source.description,
      lineItems: source.lineItems || [],
      amountMode: source.amountMode || "manual",
      amount: source.amount,
      amountPaid: isReceipt ? source.amount : source.amountPaid,
      status: isReceipt ? "paid" : "unpaid",
      paidDate: isReceipt ? new Date().toISOString().slice(0, 10) : "",
      convertedFromId: source.id,
    });
  };

  const handleCreateMilestones = async (percentages) => {
    const projectInvoices = invoices.filter((inv) => inv.projectId === selectedProjectId);
    const project = projects.find((p) => p.id === selectedProjectId);
    const projectShots = cards.filter((c) => c.projectId === selectedProjectId);
    const { totalBudget } = projectBudgetSummary(project, projectShots, projectInvoices);
    const numbers = nextInvoiceNumbers(projectInvoices, 3);
    const rows = [0, 1, 2].map((i) => {
      const amount = ((totalBudget * (parseFloat(percentages[i]) || 0)) / 100).toFixed(2);
      return {
        projectId: selectedProjectId,
        invoiceNumber: numbers[i],
        description: MILESTONE_LABELS[i],
        amount,
        amountPaid: "",
        currency: project?.currency || settings.currencySymbol,
        issueDate: new Date().toISOString().slice(0, 10),
        dueDate: "",
        status: "unpaid",
      };
    });
    setSaveState("saving");
    try {
      // create_milestone_invoices() inserts all 3 rows in a single INSERT,
      // so a failure partway through can't leave a broken partial milestone
      // set (e.g. just the upfront payment with the other two missing) the
      // way three sequential handleSaveInvoice() calls used to.
      const { data: insertedRows, error } = await supabase.rpc("create_milestone_invoices", {
        p_rows: rows,
      });
      if (error) throw error;
      setData((prev) => ({
        ...prev,
        invoices: [...prev.invoices, ...(insertedRows || []).map(invoiceFromRow)],
      }));
      flashSave(true);
      setShowMilestoneModal(false);
    } catch (e) {
      console.error("Milestone invoice creation failed:", e);
      flashSave(false);
      // Keep the milestone modal open on failure so the user can retry
      // rather than silently ending up with zero milestone invoices.
    }
  };

  const handleSaveExpense = async (expense) => {
    setSaveState("saving");
    try {
      if (expense.id) {
        const { error } = await supabase
          .from("expenses")
          .update(expenseToRow(expense, userId))
          .eq("id", expense.id);
        if (error) throw error;
        setData((prev) => ({
          ...prev,
          expenses: prev.expenses.map((e) => (e.id === expense.id ? expense : e)),
        }));
      } else {
        const { data: inserted, error } = await supabase
          .from("expenses")
          .insert(expenseToRow(expense, userId))
          .select()
          .single();
        if (error) throw error;
        setData((prev) => ({ ...prev, expenses: [...prev.expenses, expenseFromRow(inserted)] }));
      }
      flashSave(true);
      setEditingExpense(null);
      return true;
    } catch (e) {
      console.error("Expense save failed:", e);
      flashSave(false);
      return false;
    }
  };

  const handleLogShotExpense = async (card) => {
    // Runs the expense insert + shots.assigned_paid update as one atomic
    // server-side operation (log_shot_payment RPC, see
    // migration_teams_payment_atomicity.sql) instead of two separate
    // client calls. A retried/duplicate call for the same shot is a
    // guaranteed no-op there (unique index on expenses.shot_id) rather
    // than a second expense record.
    // Tag the expense with the project's own currency, not the expense-form
    // default - without this, every crew payment silently got recorded as
    // USD regardless of the project's real currency (e.g. a ¥5,000 payment
    // on a JPY project logged as a $5,000 expense), corrupting profit/
    // expense totals for that project from then on.
    if (loggingPaymentFor.current.has(card.id)) return; // client-side double-click guard
    loggingPaymentFor.current.add(card.id);
    const project = data.projects.find((p) => p.id === card.projectId);
    const description = `${card.title || "Shot"}${card.assignedTo ? " \u2014 " + card.assignedTo : ""}`;
    const amount = parseMoney(card.assignedPay);
    const currency = project?.currency || "$";
    const date = new Date().toISOString().slice(0, 10);
    try {
      const { data: result, error } = await supabase.rpc("log_shot_payment", {
        p_shot_id: card.id,
        p_project_id: card.projectId,
        p_category: "Animator Payments",
        p_description: description,
        p_amount: amount,
        p_currency: currency,
        p_date: date,
      });
      if (error) throw error;
      const row = Array.isArray(result) ? result[0] : result;
      setData((prev) => ({
        ...prev,
        cards: prev.cards.map((c) => (c.id === card.id ? { ...c, assignedPaid: true } : c)),
        expenses: row?.already_paid
          ? prev.expenses // already recorded by an earlier call - don't duplicate locally either
          : [
              ...prev.expenses,
              expenseFromRow({
                id: row?.expense_id,
                project_id: card.projectId,
                category: "Animator Payments",
                description,
                amount,
                currency,
                date,
              }),
            ],
      }));
    } catch (e) {
      console.error("Logging shot payment failed:", e);
      flashSave(false);
    } finally {
      loggingPaymentFor.current.delete(card.id);
    }
  };

  const handleSaveTeamMember = async (member) => {
    setSaveState("saving");
    try {
      if (member.id) {
        const { error } = await supabase
          .from("team_members")
          .update(teamMemberToRow(member, userId))
          .eq("id", member.id);
        if (error) throw error;
        setData((prev) => ({
          ...prev,
          teamMembers: prev.teamMembers.map((m) => (m.id === member.id ? member : m)),
        }));
      } else {
        const { data: inserted, error } = await supabase
          .from("team_members")
          .insert(teamMemberToRow(member, userId))
          .select()
          .single();
        if (error) throw error;
        setData((prev) => ({ ...prev, teamMembers: [...prev.teamMembers, teamMemberFromRow(inserted)] }));
      }
      // Only close the editor and clear the "which member is open" state on
      // a confirmed success. A failed save previously fell through to the
      // same setEditingTeamMember(null) below regardless of the outcome,
      // silently discarding whatever the user had just typed.
      flashSave(true);
      setEditingTeamMember(null);
      setTeamMemberSaveError("");
    } catch (e) {
      console.error("Team member save failed:", e);
      flashSave(false);
      setTeamMemberSaveError(e?.message || "Save failed. Your changes were not saved — please try again.");
      // Editor stays open; entered values live in the editor's own local
      // form state and are untouched by this catch.
    }
  };

  // Archives instead of deleting: preserves the row's UUID so historical
  // shot assignments, payments, and Planner snapshots that reference it
  // keep working. See migration_teams_phase1_safety.sql for the status/
  // archived_at columns this relies on.
  const handleArchiveTeamMember = async (id) => {
    setSaveState("saving");
    try {
      const { error } = await supabase
        .from("team_members")
        .update({ status: "archived", archived_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
      setData((prev) => ({
        ...prev,
        teamMembers: prev.teamMembers.map((m) =>
          m.id === id ? { ...m, status: "archived", archivedAt: new Date().toISOString() } : m
        ),
      }));
      flashSave(true);
      setEditingTeamMember(null);
      setTeamMemberSaveError("");
    } catch (e) {
      console.error("Team member archive failed:", e);
      flashSave(false);
      setTeamMemberSaveError(e?.message || "Archive failed. This member was not removed — please try again.");
      // Do not close the editor and do not remove the member from the
      // roster/UI — a failed archive must not look like a successful one.
    }
  };

  // Links a legacy assignedTo-only shot to a real team_member UUID without
  // touching assignedTo itself. Only ever called with a single resolved
  // member (an unambiguous name match, or a member the user explicitly
  // picked for an ambiguous one) — never guesses. See brief §5/§30.
  const handleBackfillShotAssignment = async (cardId, memberId) => {
    try {
      const { error } = await supabase.from("shots").update({ assigned_member_id: memberId }).eq("id", cardId);
      if (error) throw error;
      setData((prev) => ({
        ...prev,
        cards: prev.cards.map((c) => (c.id === cardId ? { ...c, assignedMemberId: memberId } : c)),
      }));
      return true;
    } catch (e) {
      console.error("Linking legacy assignment failed:", e);
      return false;
    }
  };

  const handleDeleteExpense = async (id) => {
    setSaveState("saving");
    try {
      const { error } = await supabase.from("expenses").delete().eq("id", id);
      if (error) throw error;
      setData((prev) => ({ ...prev, expenses: prev.expenses.filter((e) => e.id !== id) }));
      flashSave(true);
    } catch (e) {
      console.error("Expense delete failed:", e);
      flashSave(false);
    }
    setEditingExpense(null);
  };

  const handleSaveBudgetPlanner = async (plan) => {
    if (!plan.id && atBudgetPlannerLimit) {
      flashSave(false);
      return;
    }
    setSaveState("saving");
    try {
      if (plan.id) {
        const { error } = await supabase
          .from("budget_planners")
          .update(budgetPlannerToRow(plan, userId))
          .eq("id", plan.id);
        if (error) throw error;
        setData((prev) => ({
          ...prev,
          budgetPlanners: prev.budgetPlanners.map((p) => (p.id === plan.id ? { ...plan } : p)),
        }));
        setEditingBudgetPlanner({ ...plan });
      } else {
        const { data: inserted, error } = await supabase
          .from("budget_planners")
          .insert(budgetPlannerToRow(plan, userId))
          .select()
          .single();
        if (error) throw error;
        const savedPlan = budgetPlannerFromRow(inserted);
        setData((prev) => ({
          ...prev,
          budgetPlanners: [savedPlan, ...prev.budgetPlanners],
        }));
        setEditingBudgetPlanner(savedPlan);
      }
      flashSave(true);
    } catch (e) {
      console.error("Budget planner save failed:", e);
      flashSave(false);
    }
  };

  const handleDeleteBudgetPlanner = async (id) => {
    setSaveState("saving");
    try {
      const { error } = await supabase.from("budget_planners").delete().eq("id", id);
      if (error) throw error;
      setData((prev) => ({ ...prev, budgetPlanners: prev.budgetPlanners.filter((p) => p.id !== id) }));
      flashSave(true);
    } catch (e) {
      console.error("Budget planner delete failed:", e);
      flashSave(false);
    }
    setEditingBudgetPlanner(null);
  };

  // Phase 3 — duplicate an existing plan (also used as "new from template").
  const handleDuplicateBudgetPlanner = async (plan) => {
    if (atBudgetPlannerLimit) {
      flashSave(false);
      return;
    }
    const copy = {
      ...plan,
      id: undefined,
      name: `${plan.name || "Untitled plan"} (copy)`,
      status: "draft",
      convertedProjectId: null,
    };
    setSaveState("saving");
    try {
      const { data: inserted, error } = await supabase
        .from("budget_planners")
        .insert(budgetPlannerToRow(copy, userId))
        .select()
        .single();
      if (error) throw error;
      const nextPlan = budgetPlannerFromRow(inserted);
      setData((prev) => ({ ...prev, budgetPlanners: [nextPlan, ...prev.budgetPlanners] }));
      setEditingBudgetPlanner(nextPlan);
      flashSave(true);
    } catch (e) {
      console.error("Budget planner duplicate failed:", e);
      flashSave(false);
    }
  };

  // Phase 11 — save the structure of a plan (not client-specific info) as a
  // reusable template.
  const handleSaveAsTemplate = async (plan) => {
    if (!hasProAccess) return;
    const template = {
      name: plan.name ? `${plan.name} template` : "Untitled template",
      projectType: plan.projectType,
      targetProfitPercent: plan.targetProfitPercent,
      departmentAllocations: plan.departmentAllocations,
      crew: (plan.crew || []).map((p) => ({ ...p, name: "" })), // rate/role defaults only, not the person's name
      scope: plan.scope,
    };
    setSaveState("saving");
    try {
      const { data: inserted, error } = await supabase
        .from("planner_templates")
        .insert(plannerTemplateToRow(template, userId))
        .select()
        .single();
      if (error) throw error;
      setData((prev) => ({ ...prev, plannerTemplates: [plannerTemplateFromRow(inserted), ...prev.plannerTemplates] }));
      flashSave(true);
    } catch (e) {
      console.error("Save as template failed:", e);
      flashSave(false);
    }
  };

  const handleDeleteTemplate = async (id) => {
    setSaveState("saving");
    try {
      const { error } = await supabase.from("planner_templates").delete().eq("id", id);
      if (error) throw error;
      setData((prev) => ({ ...prev, plannerTemplates: prev.plannerTemplates.filter((t) => t.id !== id) }));
      flashSave(true);
    } catch (e) {
      console.error("Template delete failed:", e);
      flashSave(false);
    }
  };

  // Phase 10 — Convert to Project. Copies the planner's core fields into a
  // real project, attaches the planner's budget info as notes, marks the
  // planner Converted, and never deletes the planner. Guards against
  // accidental duplicate conversion.
  const handleConvertPlannerToProject = async (plan) => {
    if (plan.convertedProjectId) {
      flashSave(false);
      return { alreadyConverted: true };
    }
    if (atProjectLimit) {
      flashSave(false);
      return { limitReached: true };
    }
    setSaveState("saving");
    try {
      const { data: newProjectRow, error } = await supabase.rpc("convert_planner_to_project", {
        p_plan_id: plan.id,
      });
      if (error) throw error;
      const newProject = {
        id: newProjectRow.id,
        name: newProjectRow.name,
        client: newProjectRow.client,
        notes: newProjectRow.notes,
        budget: newProjectRow.budget,
        budgetMode: newProjectRow.budget_mode || "manual",
        currency: newProjectRow.currency || "$",
        deadline: newProjectRow.deadline,
        priority: newProjectRow.priority,
        archived: newProjectRow.archived,
        shareEnabled: newProjectRow.share_enabled || false,
        shareToken: newProjectRow.share_token || null,
        driveFolderId: null,
        driveFolderUrl: null,
        driveDeliverablesFolderId: null,
      };
      const updatedPlan = { ...plan, status: "converted", convertedProjectId: newProjectRow.id };
      setData((prev) => ({
        ...prev,
        projects: [...prev.projects, newProject],
        budgetPlanners: prev.budgetPlanners.map((p) => (p.id === plan.id ? updatedPlan : p)),
      }));
      setEditingBudgetPlanner(updatedPlan);
      flashSave(true);
      return { project: newProject };
    } catch (e) {
      console.error("Convert to project failed:", e);
      flashSave(false);
      return { error: e };
    }
  };

  const handleExport = () => {
    const payload = JSON.stringify(data, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `shot-tracker-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleAuthSubmit = async (e) => {
    e.preventDefault();
    setAuthError("");
    setAuthNotice("");
    setAuthBusy(true);
    try {
      if (authMode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({
          email: authEmail,
          password: authPassword,
        });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signUp({
          email: authEmail,
          password: authPassword,
        });
        if (error) throw error;
        setAuthNotice("Check your inbox to confirm your email, then sign in.");
      }
    } catch (err) {
      setAuthError(friendlyAuthError(err));
    } finally {
      setAuthBusy(false);
    }
  };

  const handleRequestPasswordReset = async (e) => {
    e.preventDefault();
    setAuthError("");
    setAuthNotice("");
    setAuthBusy(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(authEmail, {
        redirectTo: window.location.origin,
      });
      if (error) throw error;
      setAuthNotice("If an account exists for that email, a reset link is on its way.");
    } catch (err) {
      setAuthError(friendlyAuthError(err));
    } finally {
      setAuthBusy(false);
    }
  };

  const handleSetNewPassword = async (e) => {
    e.preventDefault();
    setAuthError("");
    setAuthBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      setIsPasswordRecovery(false);
      setNewPassword("");
      setAuthNotice("Password updated.");
    } catch (err) {
      setAuthError(friendlyAuthError(err));
    } finally {
      setAuthBusy(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setAuthError("");
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: window.location.origin },
      });
      if (error) throw error;
    } catch (err) {
      setAuthError(friendlyAuthError(err));
    }
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    setData({ projects: [], cards: [], leads: [], invoices: [], expenses: [], teamMembers: [], activity: [], budgetPlanners: [], plannerTemplates: [] });
    setView("projects");
    setSelectedProjectId(null);
  };

  // Touch drags need a brief "hold" before we commit to picking a card up.
  // Without this, any touch that starts on a card and moves vertically to
  // scroll the board gets immediately hijacked into a drag (since the old
  // 6px threshold fires on scroll gestures too), which is what caused cards
  // to get dropped in the wrong column while someone was just trying to
  // scroll. Mouse/pen drags are unaffected and still arm instantly.
  const TOUCH_HOLD_MS = 160;
  const TOUCH_CANCEL_DISTANCE = 10;

  const endDrag = useCallback(() => {
    const ds = dragStateRef.current;
    if (ds?.holdTimer) clearTimeout(ds.holdTimer);
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
    window.removeEventListener("pointercancel", handlePointerUp);
    dragStateRef.current = null;
    setDragVisual(null);
    setDragOverStage(null);
  }, []);

  const handlePointerMove = useCallback((e) => {
    const ds = dragStateRef.current;
    if (!ds) return;
    const dx = e.clientX - ds.startX;
    const dy = e.clientY - ds.startY;
    const dist = Math.hypot(dx, dy);

    if (!ds.armed) {
      // Still deciding whether this is a drag or a scroll. If the finger
      // has already moved a meaningful distance before the hold timer
      // fired, this was a scroll attempt - bail out without ever calling
      // preventDefault so the browser can scroll normally.
      if (dist > TOUCH_CANCEL_DISTANCE) {
        endDrag();
      }
      return;
    }

    if (!ds.moved && dist > 6) {
      ds.moved = true;
    }
    if (ds.moved) {
      e.preventDefault();
      setDragVisual({
        title: ds.title,
        client: ds.client,
        x: e.clientX - ds.offsetX,
        y: e.clientY - ds.offsetY,
        width: ds.width,
      });
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const columnEl = el && el.closest("[data-stage]");
      setDragOverStage(columnEl ? columnEl.getAttribute("data-stage") : null);
    }
  }, []);

  const handlePointerUp = useCallback(
    (e) => {
      const ds = dragStateRef.current;
      if (ds && ds.moved) {
        suppressClickRef.current = true;
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const columnEl = el && el.closest("[data-stage]");
        const stage = columnEl ? columnEl.getAttribute("data-stage") : null;
        // Dropping back into the same column is an easy, ordinary thing to
        // do (pick up, hesitate, put down) - without this check it still
        // dispatched a full "move", which for shots wipes review status
        // and the entire revision history, and for leads resets
        // stage_changed_at (restarting the archive countdown) even though
        // nothing actually changed.
        if (stage && stage !== ds.originStage) {
          if (ds.kind === "lead") {
            moveLeadStageRef.current(ds.id, stage);
          } else {
            moveCardStageRef.current(ds.id, stage);
          }
        }
      }
      endDrag();
    },
    [endDrag]
  );

  useEffect(() => {
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [handlePointerMove, handlePointerUp]);

  const handlePointerDown = (e, card, kind = "shot") => {
    if (e.button !== undefined && e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const isTouch = e.pointerType === "touch";
    const state = {
      kind,
      id: card.id,
      originStage: card.stage,
      title: kind === "lead" ? card.companyName : card.title,
      client: kind === "lead" ? card.contactPerson : card.client,
      startX: e.clientX,
      startY: e.clientY,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      width: rect.width,
      moved: false,
      // Mouse/pen: arm the drag immediately, same as before.
      // Touch: wait for a short hold so a scroll swipe never gets mistaken
      // for a drag pickup.
      armed: !isTouch,
      holdTimer: null,
    };
    dragStateRef.current = state;
    if (isTouch) {
      state.holdTimer = setTimeout(() => {
        if (dragStateRef.current === state) {
          state.armed = true;
        }
      }, TOUCH_HOLD_MS);
    }
    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  };

  const handleCardClick = (card) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setEditingCard(card);
  };

  const handleLeadClick = (lead) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setEditingLead(lead);
  };

  const openProject = (id) => {
    setSelectedProjectId(id);
    setView("board");
    setBoardTab("shots");
  };

  // Must be called unconditionally, before the early returns below - React
  // requires the same hooks in the same order on every render, and several
  // renders happen while authLoading/session/loading are still resolving.
  // (selectedProject itself is computed again further down for the JSX that
  // needs it; that's a plain expression, not a hook, so it's fine there.)
  const boardDriveAction = useDriveFolderAction({
    project: projects.find((p) => p.id === selectedProjectId),
    driveEmail,
    onCreateDriveFolders: handleCreateDriveFolders,
    onRequestDriveConnect: () => setDriveConnectPrompt(true),
    onDriveError: setDriveNotice,
  });

  if (authLoading) {
    return (
      <div style={styles.loadingScreen}>
        <img src="/logo.png" alt="Kairil" style={{ ...styles.loadingClap, width: 48, height: 48, objectFit: "contain" }} />
      </div>
    );
  }

  if (isPasswordRecovery) {
    return (
      <div style={styles.app}>
        <style>{fontImport}</style>
        <div style={styles.lockScreen}>
          <div style={styles.logoMark}><img src="/logo.png" alt="Kairil" style={{ width: 24, height: 24, objectFit: "contain" }} /></div>
          <h1 style={styles.title}>Set a new password</h1>
          <p style={styles.subtitle}>Choose a new password for your account.</p>

          <form onSubmit={handleSetNewPassword} style={styles.lockForm}>
            <input
              style={styles.input}
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="New password"
              autoComplete="new-password"
              minLength={6}
              autoFocus
              required
            />
            <button type="submit" style={styles.newButton} disabled={authBusy}>
              {authBusy ? "Please wait..." : "Update password"}
            </button>
          </form>

          {authError && <p style={styles.lockError}>{authError}</p>}
          {authNotice && <p style={styles.lockNotice}>{authNotice}</p>}
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div style={styles.app}>
        <style>{fontImport}</style>
        <div style={styles.lockScreen}>
          <div style={styles.logoMark}><img src="/logo.png" alt="Kairil" style={{ width: 24, height: 24, objectFit: "contain" }} /></div>
          <h1 style={styles.title}>Kairil</h1>
          <p style={styles.subtitle}>CRM plus Shot Tracker</p>

          {authMode === "reset" ? (
            <>
              <form onSubmit={handleRequestPasswordReset} style={styles.lockForm}>
                <input
                  style={styles.input}
                  type="email"
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  placeholder="Email"
                  autoComplete="email"
                  autoFocus
                  required
                />
                <button type="submit" style={styles.newButton} disabled={authBusy}>
                  {authBusy ? "Please wait..." : "Send reset link"}
                </button>
              </form>

              {authError && <p style={styles.lockError}>{authError}</p>}
              {authNotice && <p style={styles.lockNotice}>{authNotice}</p>}

              <button
                style={styles.switchModeButton}
                onClick={() => {
                  setAuthMode("signin");
                  setAuthError("");
                  setAuthNotice("");
                }}
              >
                Back to sign in
              </button>
            </>
          ) : (
            <>
              <button style={styles.googleButton} onClick={handleGoogleSignIn} type="button">
                <svg width="16" height="16" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.67-2.26 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.85A11 11 0 0 0 12 23z" />
                  <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.05H2.18a11 11 0 0 0 0 9.9z" />
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1a11 11 0 0 0-9.82 6.05l3.66 2.85C6.71 7.3 9.14 5.38 12 5.38z" />
                </svg>
                Continue with Google
              </button>

              <div style={styles.dividerRow}>
                <div style={styles.dividerLine} />
                <span style={styles.dividerText}>or</span>
                <div style={styles.dividerLine} />
              </div>

              <form onSubmit={handleAuthSubmit} style={styles.lockForm}>
                <input
                  style={styles.input}
                  type="email"
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  placeholder="Email"
                  autoComplete="email"
                  autoFocus
                  required
                />
                <input
                  style={styles.input}
                  type="password"
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  placeholder="Password"
                  autoComplete={authMode === "signin" ? "current-password" : "new-password"}
                  minLength={6}
                  required
                />
                <button type="submit" style={styles.newButton} disabled={authBusy}>
                  {authBusy ? "Please wait..." : authMode === "signin" ? "Sign in" : "Create account"}
                </button>
              </form>

              {authError && <p style={styles.lockError}>{authError}</p>}
              {authNotice && <p style={styles.lockNotice}>{authNotice}</p>}

              {authMode === "signin" && (
                <button
                  style={styles.switchModeButton}
                  onClick={() => {
                    setAuthMode("reset");
                    setAuthError("");
                    setAuthNotice("");
                  }}
                >
                  Forgot password?
                </button>
              )}

              <button
                style={styles.switchModeButton}
                onClick={() => {
                  setAuthMode(authMode === "signin" ? "signup" : "signin");
                  setAuthError("");
                  setAuthNotice("");
                }}
              >
                {authMode === "signin"
                  ? "Need an account? Sign up"
                  : "Already have an account? Sign in"}
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={styles.loadingScreen}>
        <img src="/logo.png" alt="Kairil" style={{ ...styles.loadingClap, width: 48, height: 48, objectFit: "contain" }} />
      </div>
    );
  }

  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const projectCards = cards.filter((c) => c.projectId === selectedProjectId);
  const { delivered: deliveredCount, percent: overallPercent } = projectProgress(projectCards);
  const showTabs = view === "projects";
  const hasProAccess = settings.isAdmin || settings.plan === "pro";
  const activeProjectCount = projects.filter((p) => !p.archived).length;
  const atProjectLimit = !hasProAccess && activeProjectCount >= FREE_PROJECT_LIMIT;
  const atBudgetPlannerLimit = !hasProAccess && budgetPlanners.length >= FREE_BUDGET_PLANNER_LIMIT;

  return (
    <div style={styles.app}>
      <style>{fontImport}</style>

      {driveNotice && (
        <div style={styles.driveToast}>
          <span>{driveNotice}</span>
          <button style={styles.iconButton} onClick={() => setDriveNotice("")}>
            <CloseIcon />
          </button>
        </div>
      )}

      {patreonNotice && (
        <div style={styles.driveToast}>
          <span>{patreonNotice}</span>
          <button style={styles.iconButton} onClick={() => setPatreonNotice("")}>
            <CloseIcon />
          </button>
        </div>
      )}

      {driveConnectPrompt && (
        <div style={{ ...styles.driveToast, flexWrap: "wrap", justifyContent: "center" }}>
          <span>Connect Google Drive to create project folders.</span>
          <button
            type="button"
            style={{ ...styles.addRevisionButton, alignSelf: "center", flexShrink: 0 }}
            onClick={() => {
              setDriveConnectPrompt(false);
              handleConnectDrive();
            }}
          >
            Connect Google Drive
          </button>
          <button style={styles.iconButton} onClick={() => setDriveConnectPrompt(false)}>
            <CloseIcon />
          </button>
        </div>
      )}

      <header style={styles.header}>
        <div style={styles.headerLeft}>
          {view === "board" ? (
            <button style={styles.backButton} onClick={() => setView("projects")}>
              <BackIcon />
            </button>
          ) : view === "settings" ? (
            <button style={styles.backButton} onClick={() => setView(settingsReturnView)}>
              <BackIcon />
            </button>
          ) : (
            <div style={styles.logoMark}><img src="/logo.png" alt="Kairil" style={{ width: 24, height: 24, objectFit: "contain" }} /></div>
          )}
          <div>
            <h1 style={styles.title}>
              {view === "board"
                ? selectedProject?.name || "Project"
                : view === "settings"
                ? "Settings"
                : workspace === "leads"
                ? "Leads"
                : workspace === "dashboard"
                ? "Dashboard"
                : workspace === "finance"
                ? "Finance"
                : workspace === "teams"
                ? "Teams"
                : "Kairil"}
            </h1>
            <p style={styles.subtitle}>
              {view === "board"
                ? selectedProject?.client || settings.studioName
                : view === "settings"
                ? "Studio & account preferences"
                : session.user.email}
            </p>
          </div>
        </div>
        <div style={styles.headerRight}>
          <span style={styles.saveIndicator}>
            {saveState === "saving" && "Saving..."}
            {saveState === "saved" && "Saved"}
            {saveState === "error" && "Save failed"}
          </span>
          <button style={styles.iconButtonGhost} onClick={handleExport} title="Export backup">
            <DownloadIcon />
          </button>
          <button
            className={tutorialHighlightTarget === "settings" ? "kf-tutorial-highlight" : undefined}
            style={styles.iconButtonGhost}
            onClick={() => {
              if (view !== "settings") setSettingsReturnView(view);
              setView("settings");
            }}
            title="Settings"
          >
            <GearIcon />
          </button>
          <button style={styles.iconButtonGhost} onClick={handleSignOut} title="Sign out">
            <SignOutIcon />
          </button>
          {view === "settings" ? null : view === "board" && boardTab === "invoices" ? (
            <button
              style={styles.newButton}
              onClick={() =>
                setEditingInvoice(
                  emptyInvoice(
                    selectedProjectId,
                    nextInvoiceNumber(invoices.filter((inv) => inv.projectId === selectedProjectId)),
                    selectedProject?.currency || settings.currencySymbol
                  )
                )
              }
            >
              <PlusIcon />
              New invoice
            </button>
          ) : view === "board" && boardTab === "activity" ? null : view === "board" ? (
            <button
              style={styles.newButton}
              onClick={() =>
                setEditingCard(emptyCard(STAGES[0].id, selectedProjectId, settings.defaultShotPriority))
              }
            >
              <PlusIcon />
              New shot
            </button>
          ) : workspace === "leads" ? (
            <button style={styles.newButton} onClick={() => setEditingLead(emptyLead())}>
              <PlusIcon />
              New lead
            </button>
          ) : workspace === "finance" ? (
            <button style={styles.newButton} onClick={() => setEditingExpense(emptyExpense())}>
              <PlusIcon />
              New expense
            </button>
          ) : workspace === "teams" ? (
            <button style={styles.newButton} onClick={() => setEditingTeamMember(emptyTeamMember())}>
              <PlusIcon />
              New member
            </button>
          ) : workspace === "planner" && !editingBudgetPlanner ? (
            <>
              <button
                style={styles.newButton}
                onClick={() => setEditingBudgetPlanner(emptyBudgetPlanner({ currency: settings.currencySymbol }))}
                disabled={atBudgetPlannerLimit}
                title={
                  atBudgetPlannerLimit
                    ? `Free plan is limited to ${FREE_BUDGET_PLANNER_LIMIT} budget plans. Delete one or upgrade to Pro.`
                    : undefined
                }
              >
                <PlusIcon />
                New plan
              </button>
              <select
                style={{ ...styles.input, width: 200, marginLeft: 8 }}
                value=""
                disabled={atBudgetPlannerLimit}
                title="Start a new plan pre-filled from a template"
                onChange={(e) => {
                  const templateId = e.target.value;
                  e.target.value = "";
                  if (!templateId) return;
                  const template = [...BUILT_IN_PLANNER_TEMPLATES, ...plannerTemplates].find((t) => t.id === templateId);
                  if (!template) return;
                  setEditingBudgetPlanner(
                    emptyBudgetPlanner({
                      currency: settings.currencySymbol,
                      projectType: template.projectType || "",
                      targetProfitPercent: template.targetProfitPercent ?? 25,
                      departmentAllocations: template.departmentAllocations || defaultDepartmentAllocations(),
                      crew: template.crew || [],
                      scope: { ...emptyBudgetPlanner().scope, ...(template.scope || {}) },
                      templateId: template.builtin ? null : template.id,
                    })
                  );
                }}
              >
                <option value="">New from template…</option>
                <optgroup label="Built-in">
                  {BUILT_IN_PLANNER_TEMPLATES.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </optgroup>
                {plannerTemplates.length > 0 && (
                  <optgroup label="Your templates">
                    {plannerTemplates.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </optgroup>
                )}
              </select>
            </>
          ) : workspace === "planner" && editingBudgetPlanner ? (
            <button style={styles.cancelButton} onClick={() => setEditingBudgetPlanner(null)}>
              <BackIcon />
              All plans
            </button>
          ) : workspace === "dashboard" ? null : (
            <button
              style={styles.newButton}
              onClick={() => setEditingProject(emptyProject({ currency: settings.currencySymbol }))}
              disabled={atProjectLimit}
              title={atProjectLimit ? `Free plan is limited to ${FREE_PROJECT_LIMIT} active projects. Archive one or upgrade to Pro.` : undefined}
            >
              <PlusIcon />
              New project
            </button>
          )}
        </div>
      </header>

      {/* Mounted here - unconditionally, at the app root - rather than
          inside DashboardPanel, so the floating pop-out window it can open
          survives switching workspaces/tabs. DashboardPanel only unmounts
          when the Dashboard workspace isn't active, and this component used
          to live inside it; navigating to Leads/Finance/etc. tore it down
          and, with it, any open pop-out. `visible` keeps its own on-page
          tile showing only on the Dashboard, matching the old layout. */}
      <StudioTimeCard userId={userId} visible={view === "projects" && workspace === "dashboard"} />

      {showTabs && (
        <div style={styles.tabRow}>
          <button
            className={tutorialHighlightTarget === "dashboard" ? "kf-tutorial-highlight" : undefined}
            style={{ ...styles.tabButton, ...(workspace === "dashboard" ? styles.tabButtonActive : {}) }}
            onClick={() => setWorkspace("dashboard")}
          >
            Dashboard
          </button>
          <button
            className={tutorialHighlightTarget === "projects" ? "kf-tutorial-highlight" : undefined}
            style={{ ...styles.tabButton, ...(workspace === "projects" ? styles.tabButtonActive : {}) }}
            onClick={() => setWorkspace("projects")}
          >
            Projects
          </button>
          <button
            className={tutorialHighlightTarget === "leads" ? "kf-tutorial-highlight" : undefined}
            style={{ ...styles.tabButton, ...(workspace === "leads" ? styles.tabButtonActive : {}) }}
            onClick={() => setWorkspace("leads")}
          >
            Leads
          </button>
          <button
            className={tutorialHighlightTarget === "finance" ? "kf-tutorial-highlight" : undefined}
            style={{ ...styles.tabButton, ...(workspace === "finance" ? styles.tabButtonActive : {}) }}
            onClick={() => setWorkspace("finance")}
          >
            Finance
          </button>
          <button
            className={tutorialHighlightTarget === "teams" ? "kf-tutorial-highlight" : undefined}
            style={{ ...styles.tabButton, ...(workspace === "teams" ? styles.tabButtonActive : {}) }}
            onClick={() => setWorkspace("teams")}
          >
            Teams
          </button>
          <button
            style={{ ...styles.tabButton, ...(workspace === "planner" ? styles.tabButtonActive : {}) }}
            onClick={() => setWorkspace("planner")}
          >
            Planner
          </button>
        </div>
      )}

      {view === "board" && (
        <div style={styles.tabRow}>
          <button
            style={{ ...styles.tabButton, ...(boardTab === "shots" ? styles.tabButtonActive : {}) }}
            onClick={() => setBoardTab("shots")}
          >
            Shots
          </button>
          <button
            style={{ ...styles.tabButton, ...(boardTab === "invoices" ? styles.tabButtonActive : {}) }}
            onClick={() => setBoardTab("invoices")}
          >
            Invoices
          </button>
          <button
            style={{ ...styles.tabButton, ...(boardTab === "activity" ? styles.tabButtonActive : {}) }}
            onClick={() => setBoardTab("activity")}
          >
            Activity
          </button>
          {selectedProject && (
            <button
              type="button"
              style={{
                ...styles.addRevisionButton,
                alignSelf: "center",
                fontSize: 13,
                padding: "8px 16px",
                ...(boardDriveAction.connected ? {} : { opacity: 0.6 }),
              }}
              onClick={boardDriveAction.handleDriveAction}
              disabled={boardDriveAction.creatingFolders}
              title={boardDriveAction.tooltip}
              aria-label={boardDriveAction.tooltip}
            >
              {boardDriveAction.creatingFolders ? <SpinnerIcon /> : <FolderIcon />}
              {boardDriveAction.label}
            </button>
          )}
        </div>
      )}

      {view === "board" && boardTab === "shots" && (
        <div style={styles.progressBar}>
          <div style={styles.progressLabelRow}>
            <span style={styles.progressLabel}>
              {projectCards.length === 0
                ? "No shots yet"
                : `${deliveredCount} of ${projectCards.length} shots delivered`}
            </span>
            <span style={styles.progressPercent}>{overallPercent}%</span>
          </div>
          <div style={styles.progressTrack}>
            <div style={{ ...styles.progressFill, width: `${overallPercent}%` }} />
          </div>
        </div>
      )}

      {view === "settings" && (
        <SettingsPage
          settings={settings}
          email={session.user.email}
          driveEmail={driveEmail}
          onConnectDrive={handleConnectDrive}
          patreonEmail={patreonEmail}
          patreonConnected={patreonConnected}
          patreonIsPro={patreonIsPro}
          onConnectPatreon={handleConnectPatreon}
          onReplayTutorial={handleReplayTutorial}
          onOpenSupport={() => {
            setView(settingsReturnView);
            setShowSupportModal(true);
          }}
          onSave={handleSaveSettings}
        />
      )}

      {view === "projects" && workspace === "dashboard" && (
        <DashboardPanel
          projects={projects}
          cards={cards}
          leads={leads}
          invoices={invoices}
          settings={settings}
          fxRates={fxRates}
          onOpenProject={openProject}
          onGoToProjects={() => setWorkspace("projects")}
          onGoToLeads={(filters = {}) => {
            setLeadStatusFilter(filters.status || "all");
            setLeadPriorityFilter(filters.priority || "all");
            setLeadFollowupFilter(filters.followup || "all");
            setLeadChannelFilter("all");
            setShowArchivedLeads(false);
            setWorkspace("leads");
          }}
          user={session?.user}
          userId={userId}
        />
      )}

      {view === "projects" && workspace === "projects" && (
        <ProjectsGrid
          projects={projects}
          cards={cards}
          onOpen={openProject}
          onEdit={setEditingProject}
          onNew={() => setEditingProject(emptyProject({ currency: settings.currencySymbol }))}
          onToggleArchive={handleToggleArchive}
          driveEmail={driveEmail}
          onCreateDriveFolders={handleCreateDriveFolders}
          onRequestDriveConnect={() => setDriveConnectPrompt(true)}
          onDriveError={setDriveNotice}
        />
      )}

      {view === "projects" && workspace === "leads" && (
        <>
          <div style={styles.fieldRow}>
            <input
              style={styles.input}
              value={leadSearch}
              onChange={(e) => setLeadSearch(e.target.value)}
              placeholder="Search company, contact, email, website, notes..."
            />
            <select
              style={styles.input}
              value={leadStatusFilter}
              onChange={(e) => setLeadStatusFilter(e.target.value)}
            >
              <option value="all">All statuses</option>
              {ALL_LEAD_STAGES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            <select
              style={styles.input}
              value={leadFollowupFilter}
              onChange={(e) => setLeadFollowupFilter(e.target.value)}
            >
              <option value="all">Any follow-up</option>
              <option value="due">Due</option>
              <option value="upcoming">Upcoming</option>
              <option value="completed">Completed</option>
              <option value="none">None</option>
            </select>
          </div>
          <div style={{ ...styles.lostReasonGrid, marginBottom: 12 }}>
            <button
              type="button"
              style={{
                ...styles.reviewStatusButton,
                borderColor: leadChannelFilter === "all" ? teal : border,
                color: leadChannelFilter === "all" ? tealLight : textMuted,
                background: leadChannelFilter === "all" ? "rgba(47,191,166,0.1)" : "transparent",
              }}
              onClick={() => setLeadChannelFilter("all")}
            >
              All channels
            </button>
            {(settings.leadChannels || DEFAULT_LEAD_CHANNELS).map((channel) => (
              <button
                key={channel}
                type="button"
                style={{
                  ...styles.reviewStatusButton,
                  borderColor: leadChannelFilter === channel ? teal : border,
                  color: leadChannelFilter === channel ? tealLight : textMuted,
                  background: leadChannelFilter === channel ? "rgba(47,191,166,0.1)" : "transparent",
                }}
                onClick={() => setLeadChannelFilter(channel)}
              >
                {channel}
              </button>
            ))}
            <span style={{ width: 1, background: border, margin: "0 4px" }} />
            <button
              type="button"
              style={{
                ...styles.reviewStatusButton,
                borderColor: leadPriorityFilter === "all" ? teal : border,
                color: leadPriorityFilter === "all" ? tealLight : textMuted,
                background: leadPriorityFilter === "all" ? "rgba(47,191,166,0.1)" : "transparent",
              }}
              onClick={() => setLeadPriorityFilter("all")}
            >
              All priorities
            </button>
            {LEAD_PRIORITIES.map((p) => (
              <button
                key={p.id}
                type="button"
                style={{
                  ...styles.reviewStatusButton,
                  borderColor: leadPriorityFilter === p.id ? teal : border,
                  color: leadPriorityFilter === p.id ? tealLight : textMuted,
                  background: leadPriorityFilter === p.id ? "rgba(47,191,166,0.1)" : "transparent",
                }}
                onClick={() => setLeadPriorityFilter(p.id)}
              >
                {p.icon} {p.label}
              </button>
            ))}
            <span style={{ width: 1, background: border, margin: "0 4px" }} />
            <button
              type="button"
              style={{
                ...styles.reviewStatusButton,
                borderColor: showArchivedLeads ? teal : border,
                color: showArchivedLeads ? tealLight : textMuted,
                background: showArchivedLeads ? "rgba(47,191,166,0.1)" : "transparent",
              }}
              onClick={() => setShowArchivedLeads((v) => !v)}
            >
              <ArchiveIcon /> {showArchivedLeads ? "Showing archived" : "Show archived"}
            </button>
          </div>

          {showArchivedLeads ? (
            <div style={styles.timeline}>
              {leads.filter((l) => l.archivedAt && leadMatchesActiveFilters(l)).length === 0 && (
                <p style={styles.fieldHint}>No archived leads match your filters.</p>
              )}
              {leads
                .filter((l) => l.archivedAt && leadMatchesActiveFilters(l))
                .map((lead) => (
                  <div key={lead.id} style={{ ...styles.card, cursor: "pointer" }} onClick={() => handleLeadClick(lead)}>
                    <div style={styles.cardTop}>
                      <span style={styles.cardTitle}>{lead.companyName || "Untitled lead"}</span>
                    </div>
                    <div style={styles.cardFooter}>
                      <span style={styles.cardTag}>
                        {ALL_LEAD_STAGES.find((s) => s.id === lead.stage)?.label || lead.stage}
                      </span>
                      <span style={styles.cardTag}>Archived {formatShortDate(lead.archivedAt)}</span>
                    </div>
                  </div>
                ))}
            </div>
          ) : (
            <div style={{ ...styles.board, touchAction: dragVisual ? "none" : "auto" }}>
              {ALL_LEAD_STAGES.map((stage) => {
                const stageLeads = leads.filter((l) => {
                  if (l.stage !== stage.id) return false;
                  if (l.archivedAt) return false;
                  return leadMatchesActiveFilters(l);
                });
                const isOver = dragOverStage === stage.id;
                return (
                  <div
                    key={stage.id}
                    data-stage={stage.id}
                    style={{ ...styles.column, ...(isOver ? styles.columnOver : {}) }}
                  >
                    <div style={styles.columnHeader}>
                      <span style={styles.columnLabel}>{stage.label}</span>
                      <span style={styles.columnCount}>{stageLeads.length}</span>
                    </div>
                    <div style={styles.columnBody}>
                      {stageLeads.length === 0 && (
                        <button
                          style={styles.emptyAdd}
                          onClick={() =>
                            setEditingLead(
                              emptyLead(stage.id, leadChannelFilter === "all" ? "" : leadChannelFilter)
                            )
                          }
                        >
                          <PlusIcon />
                          Add lead
                        </button>
                      )}
                      {stageLeads.map((lead) => {
                        const sentCount = lead.emails.filter((e) => e.sent).length;
                        const priorityMeta = LEAD_PRIORITIES.find((p) => p.id === lead.priority);
                        return (
                          <div
                            key={lead.id}
                            onPointerDown={(e) => handlePointerDown(e, lead, "lead")}
                            onClick={() => handleLeadClick(lead)}
                            style={{
                              ...styles.card,
                              opacity: dragStateRef.current?.id === lead.id && dragVisual ? 0.4 : 1,
                              touchAction: dragStateRef.current?.id === lead.id && dragVisual ? "none" : "pan-y",
                            }}
                          >
                            <div style={styles.cardTop}>
                              <span style={styles.cardTitle}>
                                {priorityMeta ? `${priorityMeta.icon} ` : ""}
                                {lead.companyName || "Untitled lead"}
                              </span>
                            </div>
                            {lead.contactPerson && (
                              <div style={styles.cardMeta}>{lead.contactPerson}</div>
                            )}
                            <div style={styles.cardFooter}>
                              {lead.channel && (
                                <span style={styles.cardTag}>{lead.channel}</span>
                              )}
                              {sentCount > 0 && (
                                <span style={styles.cardTag}>{sentCount}/5 emails sent</span>
                              )}
                              {lead.needsFollowup && (
                                <span style={{ ...styles.cardTag, color: "#F2A65A" }}>Needs follow-up</span>
                              )}
                              {stageTakesOutcomeReason(lead.stage) && lead.outcomeReason && (
                                <span style={styles.cardTag}>{lead.outcomeReason}</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {view === "projects" && workspace === "finance" && (
        <FinancePanel
          projects={projects}
          invoices={invoices}
          expenses={expenses}
          settings={settings}
          onEditExpense={setEditingExpense}
          onNewExpense={() => setEditingExpense(emptyExpense(null, { category: "Rent" }))}
          fxRates={fxRates}
          fxUpdatedAt={fxUpdatedAt}
          onRefreshRates={refreshFxRates}
        />
      )}

      {view === "projects" && workspace === "teams" && !hasProAccess && (
        <ProUpgradePrompt feature="Teams" />
      )}
      {view === "projects" && workspace === "teams" && hasProAccess && (
        <TeamsPanel
          teamMembers={teamMembers}
          cards={cards}
          projects={projects}
          settings={settings}
          onEdit={setEditingTeamMember}
          onNew={() => setEditingTeamMember(emptyTeamMember())}
          loadError={teamsLoadError}
          onBackfillAssignment={handleBackfillShotAssignment}
        />
      )}

      {view === "projects" && workspace === "planner" && !editingBudgetPlanner && (
        <PlannerDashboard
          plans={budgetPlanners}
          settings={settings}
          onOpen={setEditingBudgetPlanner}
          onNew={(overrides) => setEditingBudgetPlanner(emptyBudgetPlanner({ currency: settings.currencySymbol, ...overrides }))}
          atLimit={atBudgetPlannerLimit}
          hasProAccess={hasProAccess}
          templates={plannerTemplates}
          onDeleteTemplate={handleDeleteTemplate}
        />
      )}

      {view === "projects" && workspace === "planner" && editingBudgetPlanner && (
        <PlannerWorkspace
          key={editingBudgetPlanner.id || "new"}
          plan={editingBudgetPlanner}
          isNew={!editingBudgetPlanner.id}
          settings={settings}
          hasProAccess={hasProAccess}
          templates={plannerTemplates}
          projects={projects}
          onSave={handleSaveBudgetPlanner}
          onDelete={handleDeleteBudgetPlanner}
          onDuplicate={handleDuplicateBudgetPlanner}
          onSaveAsTemplate={handleSaveAsTemplate}
          onConvertToProject={handleConvertPlannerToProject}
          onClose={() => setEditingBudgetPlanner(null)}
        />
      )}

      {view === "board" && boardTab === "shots" && (
        <div style={{ ...styles.board, touchAction: dragVisual ? "none" : "auto" }}>
          {STAGES.map((stage) => {
            const stageCards = projectCards.filter((c) => c.stage === stage.id);
            const isOver = dragOverStage === stage.id;
            return (
              <div
                key={stage.id}
                data-stage={stage.id}
                style={{ ...styles.column, ...(isOver ? styles.columnOver : {}) }}
              >
                <div style={styles.columnHeader}>
                  <span style={styles.columnLabel}>{stage.label}</span>
                  <span style={styles.columnCount}>{stageCards.length}</span>
                </div>
                <div style={styles.columnBody}>
                  {stageCards.length === 0 && (
                    <button
                      style={styles.emptyAdd}
                      onClick={() =>
                        setEditingCard(emptyCard(stage.id, selectedProjectId, settings.defaultShotPriority))
                      }
                    >
                      <PlusIcon />
                      Add shot
                    </button>
                  )}
                  {stageCards.map((card) => (
                    <div
                      key={card.id}
                      onPointerDown={(e) => handlePointerDown(e, card)}
                      onClick={() => handleCardClick(card)}
                      style={{
                        ...styles.card,
                        opacity: dragStateRef.current?.id === card.id && dragVisual ? 0.4 : 1,
                        touchAction: dragStateRef.current?.id === card.id && dragVisual ? "none" : "pan-y",
                      }}
                    >
                      <div style={styles.cardTop}>
                        <span
                          style={{
                            ...styles.priorityDot,
                            background: PRIORITY_COLORS[card.priority] || PRIORITY_COLORS.normal,
                          }}
                        />
                        <span style={styles.cardTitle}>{card.title || "Untitled shot"}</span>
                        <span style={{ flex: 1 }} />
                        <span
                          title={REVIEW_LABELS[card.reviewStatus] || REVIEW_LABELS.waiting}
                          style={{
                            ...styles.reviewDot,
                            background: REVIEW_COLORS[card.reviewStatus] || REVIEW_COLORS.waiting,
                          }}
                        />
                      </div>
                      {card.client && <div style={styles.cardMeta}>{card.client}</div>}
                      <div style={styles.cardFooter}>
                        {card.rate && <span style={styles.cardTag}>{card.rate}</span>}
                        {card.due && <span style={styles.cardTag}>{card.due}</span>}
                      </div>
                      <div style={styles.cardProgressTrack}>
                        <div
                          style={{
                            ...styles.cardProgressFill,
                            width: `${stagePercent(card.stage)}%`,
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {view === "board" && boardTab === "invoices" && (
        <InvoicesPanel
          project={selectedProject}
          projectCards={projectCards}
          invoices={invoices.filter((inv) => inv.projectId === selectedProjectId)}
          onNew={() =>
            setEditingInvoice(
              emptyInvoice(
                selectedProjectId,
                nextInvoiceNumber(invoices.filter((inv) => inv.projectId === selectedProjectId)),
                selectedProject?.currency || settings.currencySymbol
              )
            )
          }
          onEdit={setEditingInvoice}
          onMarkPaid={handleMarkInvoicePaid}
          onGenerateFollowup={handleGenerateFollowupDoc}
          onDownload={(inv) => downloadInvoicePDF(inv, selectedProject, settings)}
          onOpenMilestones={() => setShowMilestoneModal(true)}
          currencySymbol={selectedProject?.currency || settings.currencySymbol}
          hasProAccess={hasProAccess}
          fxRates={fxRates}
        />
      )}

      {view === "board" && boardTab === "activity" && (
        <ActivityPanel
          entries={activity.filter((a) => a.projectId === selectedProjectId)}
          cards={cards}
          onRefresh={loadData}
        />
      )}

      {showMilestoneModal && (
        <MilestoneModal
          totalBudget={
            projectBudgetSummary(
              selectedProject,
              projectCards,
              invoices.filter((inv) => inv.projectId === selectedProjectId)
            ).totalBudget
          }
          defaultPercentages={settings.milestoneDefaults}
          currencySymbol={selectedProject?.currency || settings.currencySymbol}
          onCancel={() => setShowMilestoneModal(false)}
          onCreate={handleCreateMilestones}
        />
      )}

      {showTutorial && (
        <TutorialModal onComplete={handleCompleteTutorial} onStepChange={handleTutorialStepChange} />
      )}

      {showSupportModal && (
        <SupportModal
          email={session.user.email}
          onSubmit={handleSubmitSupportMessage}
          onCancel={() => setShowSupportModal(false)}
        />
      )}

      {editingExpense && (
        <ExpenseEditor
          expense={editingExpense}
          projects={projects.filter((p) => !p.archived)}
          onCancel={() => setEditingExpense(null)}
          onSave={handleSaveExpense}
          onDelete={handleDeleteExpense}
          isNew={!editingExpense.id}
        />
      )}

      {editingTeamMember && (
        <TeamMemberEditor
          member={editingTeamMember}
          onCancel={() => { setEditingTeamMember(null); setTeamMemberSaveError(""); }}
          onSave={handleSaveTeamMember}
          onArchive={handleArchiveTeamMember}
          isNew={!editingTeamMember.id}
          currencySymbol={settings.currencySymbol}
          saveError={teamMemberSaveError}
          paymentMethodOptions={settings.paymentMethodOptions}
          teamMembers={teamMembers}
          cards={cards}
          projects={projects}
        />
      )}

      {dragVisual && (
        <div style={{ ...styles.dragGhost, left: dragVisual.x, top: dragVisual.y, width: dragVisual.width }}>
          <div style={styles.cardTop}>
            <span style={styles.cardTitle}>{dragVisual.title || "Untitled shot"}</span>
          </div>
          {dragVisual.client && <div style={styles.cardMeta}>{dragVisual.client}</div>}
        </div>
      )}

      {editingCard && (
        <CardEditor
          card={editingCard}
          onCancel={() => setEditingCard(null)}
          onSave={handleSaveCard}
          onDelete={handleDeleteCard}
          isNew={!editingCard.id}
          onPersistShareToken={handlePersistShotShareToken}
          onLogExpense={handleLogShotExpense}
          hasProAccess={hasProAccess}
          teamMembers={teamMembers}
        />
      )}

      {editingProject && (
        <ProjectEditor
          project={editingProject}
          onCancel={() => {
            // A Mark-Won flow may have left pendingLeadLinkId set expecting
            // this project to be saved - if the user cancels instead, that
            // link must not silently attach to whatever project they save
            // next.
            setPendingLeadLinkId(null);
            setEditingProject(null);
          }}
          onSave={handleSaveProject}
          onDelete={handleDeleteProject}
          isNew={!editingProject.id}
          driveEmail={driveEmail}
          onCreateDriveFolders={handleCreateDriveFolders}
          hasProAccess={hasProAccess}
          atProjectLimit={atProjectLimit}
          shotCount={cards.filter((c) => c.projectId === editingProject.id).length}
          invoiceCount={invoices.filter((inv) => inv.projectId === editingProject.id).length}
        />
      )}

      {editingLead && (
        <LeadEditor
          lead={editingLead}
          onCancel={() => setEditingLead(null)}
          onSave={handleSaveLead}
          onDelete={handleDeleteLead}
          onMarkWon={handleMarkWon}
          onMarkLost={handleMarkLost}
          onArchive={handleArchiveLead}
          onRestore={handleRestoreLead}
          isNew={!editingLead.id}
          leadChannels={settings.leadChannels || DEFAULT_LEAD_CHANNELS}
          onAddChannel={handleAddLeadChannel}
          leads={leads}
          followupSchedule={settings.followupSchedule || DEFAULT_FOLLOWUP_SCHEDULE}
        />
      )}

      {editingInvoice && (
        <InvoiceEditor
          invoice={editingInvoice}
          onCancel={() => setEditingInvoice(null)}
          onSave={handleSaveInvoice}
          onDelete={handleDeleteInvoice}
          isNew={!editingInvoice.id}
          currencySymbol={settings.currencySymbol}
          hasProAccess={hasProAccess}
        />
      )}
    </div>
  );
}

// Shared by the Projects-grid card shortcut and the in-project (board view)
// shortcut so the open/create/connect logic exists exactly once. `project`
// may be null/undefined transiently (e.g. selectedProject before it
// resolves) - every read of it is optional-chained so the hook is always
// safe to call unconditionally.
function useDriveFolderAction({ project, driveEmail, onCreateDriveFolders, onRequestDriveConnect, onDriveError }) {
  const [creatingFolders, setCreatingFolders] = useState(false);

  const createFolder = async () => {
    setCreatingFolders(true);
    try {
      const result = await onCreateDriveFolders(project.id, project.name || "Untitled project");
      // Folder info is already saved to the project by onCreateDriveFolders
      // (the same Edge Function call Project Settings uses); immediately
      // open it so the shortcut completes in one click where the browser
      // allows it. If a popup blocker steps in, the button has already
      // flipped to its "Open Drive" state as a one-click fallback.
      if (result?.driveFolderUrl) {
        window.open(result.driveFolderUrl, "_blank", "noopener,noreferrer");
      }
    } catch (err) {
      onDriveError(err.message || "Couldn't create the Drive folder, please try again.");
    } finally {
      setCreatingFolders(false);
    }
  };

  const syncFolders = async () => {
    if (creatingFolders) return;
    setCreatingFolders(true);
    try {
      await onCreateDriveFolders(project.id, project.name || "Untitled project");
    } catch (err) {
      onDriveError(err.message || "Could not sync the Drive folders, please try again.");
    } finally {
      setCreatingFolders(false);
    }
  };

  const handleDriveAction = (e) => {
    e?.stopPropagation?.();
    if (!driveEmail) {
      onRequestDriveConnect();
      return;
    }
    if (project?.driveFolderUrl) {
      window.open(project.driveFolderUrl, "_blank", "noopener,noreferrer");
      return;
    }
    if (creatingFolders) return; // guard against duplicate folder creation on repeated clicks
    createFolder();
  };

  const connected = Boolean(driveEmail);
  const hasFolder = Boolean(project?.driveFolderUrl);
  const label = !connected
    ? "Connect Google Drive"
    : creatingFolders
    ? "Creating…"
    : hasFolder
    ? "Open Drive"
    : "Create Drive Folder";
  const tooltip = !connected
    ? "Connect Google Drive to create a project folder"
    : creatingFolders
    ? "Creating Google Drive folder…"
    : hasFolder
    ? "Open Google Drive folder"
    : "Create Google Drive folder";

  return { creatingFolders, handleDriveAction, syncFolders, connected, hasFolder, label, tooltip };
}

function ProjectsGrid({
  projects,
  cards,
  onOpen,
  onEdit,
  onNew,
  onToggleArchive,
  driveEmail,
  onCreateDriveFolders,
  onRequestDriveConnect,
  onDriveError,
}) {
  const [showArchived, setShowArchived] = useState(false);
  const activeProjects = projects.filter((p) => !p.archived);
  const archivedProjects = projects.filter((p) => p.archived);

  if (projects.length === 0) {
    return (
      <div style={styles.projectsEmpty}>
        <div style={styles.projectsEmptyIcon}><FolderIcon /></div>
        <p style={styles.projectsEmptyText}>No projects yet</p>
        <button style={styles.newButton} onClick={onNew}>
          <PlusIcon />
          New project
        </button>
      </div>
    );
  }

  return (
    <div>
      {activeProjects.length === 0 ? (
        <div style={styles.projectsEmpty}>
          <div style={styles.projectsEmptyIcon}><FolderIcon /></div>
          <p style={styles.projectsEmptyText}>No active projects</p>
          <button style={styles.newButton} onClick={onNew}>
            <PlusIcon />
            New project
          </button>
        </div>
      ) : (
        <div style={styles.projectsGrid}>
          {activeProjects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              cards={cards}
              onOpen={onOpen}
              onEdit={onEdit}
              onToggleArchive={onToggleArchive}
              driveEmail={driveEmail}
              onCreateDriveFolders={onCreateDriveFolders}
              onRequestDriveConnect={onRequestDriveConnect}
              onDriveError={onDriveError}
            />
          ))}
        </div>
      )}

      {archivedProjects.length > 0 && (
        <div style={styles.archiveSection}>
          <button
            style={styles.archiveToggle}
            onClick={() => setShowArchived(!showArchived)}
          >
            <ArchiveIcon />
            {showArchived ? "Hide" : "Show"} archived ({archivedProjects.length})
          </button>
          {showArchived && (
            <div style={styles.projectsGrid}>
              {archivedProjects.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  cards={cards}
                  onOpen={onOpen}
                  onEdit={onEdit}
                  onToggleArchive={onToggleArchive}
                  driveEmail={driveEmail}
                  onCreateDriveFolders={onCreateDriveFolders}
                  onRequestDriveConnect={onRequestDriveConnect}
                  onDriveError={onDriveError}
                  archived
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProjectCard({
  project,
  cards,
  onOpen,
  onEdit,
  onToggleArchive,
  archived,
  driveEmail,
  onCreateDriveFolders,
  onRequestDriveConnect,
  onDriveError,
}) {
  const projectCards = cards.filter((c) => c.projectId === project.id);
  const { delivered, percent } = projectProgress(projectCards);
  const drive = useDriveFolderAction({
    project,
    driveEmail,
    onCreateDriveFolders,
    onRequestDriveConnect,
    onDriveError,
  });

  return (
    <div
      className="kf-card"
      style={{ ...styles.projectCard, ...(archived ? styles.projectCardArchived : {}) }}
      onClick={() => onOpen(project.id)}
    >
      <div style={styles.projectCardTop}>
        <div style={styles.projectIconMark}><FolderIcon /></div>
        <div style={styles.projectCardActions}>
          <button
            style={{
              ...styles.iconButton,
              ...(drive.hasFolder ? { color: teal } : {}),
              ...(!drive.connected ? { opacity: 0.5 } : {}),
            }}
            onClick={drive.handleDriveAction}
            disabled={drive.creatingFolders}
            title={drive.tooltip}
            aria-label={drive.tooltip}
          >
            {drive.creatingFolders ? <SpinnerIcon /> : <FolderIcon />}
          </button>
          <button type="button" style={{ ...styles.addRevisionButton, marginLeft: 4 }} onClick={(e) => { e.stopPropagation(); drive.syncFolders(); }} disabled={drive.creatingFolders} title="Sync Google Drive folders">{drive.creatingFolders ? "Syncing..." : "Sync"}</button>
          <button
            style={styles.iconButton}
            onClick={(e) => {
              e.stopPropagation();
              onEdit(project);
            }}
            title="Edit"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
            </svg>
          </button>
          <button
            style={styles.iconButton}
            onClick={(e) => {
              e.stopPropagation();
              onToggleArchive(project.id, !archived);
            }}
            title={archived ? "Restore" : "Archive"}
          >
            {archived ? <RestoreIcon /> : <ArchiveIcon />}
          </button>
        </div>
      </div>
      <div style={styles.projectName}>{project.name || "Untitled project"}</div>
      {project.client && <div style={styles.projectClient}>{project.client}</div>}
      <div style={styles.projectStats}>
        <span style={styles.progressLabel}>
          {projectCards.length === 0 ? "No shots yet" : `${delivered} of ${projectCards.length} delivered`}
        </span>
        <span style={styles.progressPercent}>{percent}%</span>
      </div>
      <div style={styles.progressTrack}>
        <div style={{ ...styles.progressFill, width: `${percent}%` }} />
      </div>
    </div>
  );
}

function FinancePanel({ projects, invoices, expenses, settings, onEditExpense, onNewExpense, fxRates, fxUpdatedAt, onRefreshRates }) {
  const [tab, setTab] = useState("overview");
  const cur = "$"; // Finance always reports in USD, the studio's base currency
  const finance = computeFinanceData(projects, invoices, expenses, fxRates);

  const subTabs = [
    { id: "overview", label: "Overview" },
    { id: "receivable", label: "Receivable" },
    { id: "profitability", label: "Profitability" },
    { id: "clients", label: "Client Value" },
    { id: "expenses", label: "Expenses" },
  ];

  return (
    <div style={styles.invoicesWrap}>
      <div style={styles.tabRow2}>
        {subTabs.map((t) => (
          <button
            key={t.id}
            style={{ ...styles.tabButton, ...(tab === t.id ? styles.tabButtonActive : {}) }}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div style={styles.fxNoteRow}>
        <span style={styles.fieldHint}>
          All figures shown in USD, converted live from each project's currency.
          {fxUpdatedAt ? ` Rates as of ${new Date(fxUpdatedAt).toLocaleString()}.` : ""}
        </span>
        <button type="button" style={styles.copyButton} onClick={onRefreshRates}>
          Refresh rates
        </button>
      </div>

      {tab === "overview" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div>
            <div style={styles.fieldDivider}>Revenue, expenses & profit (6 months)</div>
            <MonthlyFinanceChart
              revenueByMonth={finance.revenueByMonth}
              expensesByMonth={finance.expensesByMonth}
              profitByMonth={finance.profitByMonth}
              currencySymbol={cur}
            />
          </div>
          <div>
            <div style={styles.fieldDivider}>Revenue by client</div>
            <RevenueByClientBarChart data={finance.revenueByClient} currencySymbol={cur} />
          </div>
        </div>
      )}

      {tab === "receivable" && (
        <div style={styles.invoiceList}>
          {finance.receivables.length === 0 ? (
            <p style={styles.fieldHint}>No outstanding invoices.</p>
          ) : (
            finance.receivables.map((r) => (
              <div key={r.invoiceNumber} style={styles.invoiceCard}>
                <div style={styles.invoiceCardTop}>
                  <span style={styles.invoiceNumber}>{r.invoiceNumber}</span>
                  <span
                    style={{
                      ...styles.invoiceStatusTag,
                      color: r.daysOverdue > 0 ? "#FF4D4D" : "#F2A65A",
                      borderColor: r.daysOverdue > 0 ? "#FF4D4D" : "#F2A65A",
                    }}
                  >
                    {r.daysOverdue > 0 ? `${r.daysOverdue}d overdue` : "Not yet due"}
                  </span>
                </div>
                <div style={styles.cardMeta}>{r.client} &middot; {r.projectName}</div>
                <div style={styles.invoiceAmountsRow}>
                  <span style={styles.fieldHint}>Amount due {cur}{formatMoney(r.amountDue)}</span>
                  <span style={styles.fieldHint}>Due {r.dueDate || "-"}</span>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {tab === "profitability" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div>
            <div style={styles.fieldDivider}>Revenue vs expenses vs profit, by project</div>
            <ProjectComparisonChart
              data={finance.profitability.map((p) => ({
                label: p.project.name || "Untitled project",
                revenue: p.revenue,
                expenses: p.expenses,
                profit: p.profit,
              }))}
              currencySymbol={cur}
            />
          </div>
          <div style={styles.invoiceList}>
            {finance.profitability.length === 0 ? (
              <p style={styles.fieldHint}>No active projects yet.</p>
            ) : (
              finance.profitability.map((p) => (
                <div key={p.project.id} style={styles.invoiceCard}>
                  <div style={styles.invoiceCardTop}>
                    <span style={styles.invoiceNumber}>{p.project.name}</span>
                    <span style={styles.fieldHint}>
                      {p.margin === null ? "No revenue yet" : `${p.margin}% margin`}
                    </span>
                  </div>
                  {p.project.client && <div style={styles.cardMeta}>{p.project.client}</div>}
                  <div style={styles.invoiceAmountsRow}>
                    <span style={styles.fieldHint}>Revenue {cur}{formatMoney(p.revenue)}</span>
                    <span style={styles.fieldHint}>Expenses {cur}{formatMoney(p.expenses)}</span>
                    <span style={styles.fieldHint}>
                      Profit {cur}
                      {formatMoney(p.profit)}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {tab === "clients" && (
        <div style={styles.invoiceList}>
          {finance.clientValue.length === 0 ? (
            <p style={styles.fieldHint}>No clients yet.</p>
          ) : (
            finance.clientValue.map((c) => (
              <div key={c.client} style={styles.invoiceCard}>
                <div style={styles.invoiceCardTop}>
                  <span style={styles.invoiceNumber}>{c.client}</span>
                  <span style={styles.fieldHint}>{c.projectCount} project{c.projectCount === 1 ? "" : "s"}</span>
                </div>
                <div style={styles.invoiceAmountsRow}>
                  <span style={styles.fieldHint}>Total revenue {cur}{formatMoney(c.revenue)}</span>
                  <span style={styles.fieldHint}>Avg value {cur}{formatMoney(c.avgProjectValue)}</span>
                  <span style={styles.fieldHint}>
                    Last project {c.lastDate ? c.lastDate.toISOString().slice(0, 10) : "-"}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {tab === "expenses" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <button
            type="button"
            style={{ ...styles.newButton, alignSelf: "flex-start" }}
            onClick={onNewExpense}
          >
            <PlusIcon />
            Operational costs
          </button>
          <div style={styles.invoiceList}>
            {expenses.length === 0 ? (
              <p style={styles.fieldHint}>No expenses logged yet.</p>
            ) : (
              expenses
                .slice()
                .reverse()
                .map((e) => {
                  const project = projects.find((p) => p.id === e.projectId);
                  return (
                    <div key={e.id} className="kf-card" style={styles.invoiceCard} onClick={() => onEditExpense(e)}>
                      <div style={styles.invoiceCardTop}>
                        <span style={styles.invoiceNumber}>{e.category}</span>
                        <span style={styles.fieldHint}>{e.date || "-"}</span>
                      </div>
                      {e.description && <div style={styles.cardMeta}>{e.description}</div>}
                      <div style={styles.invoiceAmountsRow}>
                        <span style={styles.fieldHint}>
                          {cur}
                          {formatMoney(convertToUSD(e.amount, e.currency, fxRates))}
                        </span>
                        <span style={styles.fieldHint}>{project ? project.name : "General / operational"}</span>
                      </div>
                    </div>
                  );
                })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TeamsPanel({ teamMembers, cards, projects, settings, onEdit, onNew, loadError, onBackfillAssignment }) {
  const cur = settings.currencySymbol || "$";
  const [includeArchived, setIncludeArchived] = useState(false);
  const archivedCount = teamMembers.filter((m) => m.status === "archived").length;
  const statusFilteredMembers = includeArchived
    ? teamMembers
    : teamMembers.filter((m) => m.status !== "archived");
  const duplicateNames = findDuplicateMemberNames(teamMembers);
  const legacyMatches = computeLegacyAssignmentMatches(cards, teamMembers);
  const legacyReviewCount = legacyMatches.unique.length + legacyMatches.ambiguous.length + legacyMatches.unmatched.length;
  const [showLegacyReview, setShowLegacyReview] = useState(false);

  // Search (brief §17): name, email, role, department, skills, Upwork
  // profile - all fields already present on every already-loaded member,
  // so this is a plain client-side filter with no extra queries per
  // keystroke. Portfolio-title matching is left out for now: portfolio
  // items aren't part of the bulk roster load (see the on-demand fetch in
  // TeamMemberEditor), and fetching every member's portfolio just to
  // support search would be exactly the "expensive on every keystroke"
  // pattern the brief warns against.
  const [search, setSearch] = useState("");
  const searchLower = search.trim().toLowerCase();
  const matchesSearch = (m) => {
    if (!searchLower) return true;
    const haystack = [m.name, m.email, m.role, m.department, ...(m.skills || [])]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(searchLower);
  };

  // Filters (§18): a compact popover rather than every filter permanently
  // on screen, with the active count shown on the toggle button.
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState({ department: "", role: "", availability: "", memberType: "", skill: "" });
  const activeFilterCount = Object.values(filters).filter(Boolean).length;
  const matchesFilters = (m) => {
    if (filters.department && m.department !== filters.department) return false;
    if (filters.role && m.role !== filters.role) return false;
    if (filters.availability && m.availability !== filters.availability) return false;
    if (filters.memberType && m.memberType !== filters.memberType) return false;
    if (filters.skill && !(m.skills || []).includes(filters.skill)) return false;
    return true;
  };
  const departmentOptions = [...new Set(teamMembers.map((m) => m.department).filter(Boolean))].sort();
  const roleOptions = [...new Set(teamMembers.map((m) => m.role).filter(Boolean))].sort();
  const skillOptions = [...new Set(teamMembers.flatMap((m) => m.skills || []))].sort();

  const visibleMembers = statusFilteredMembers.filter((m) => matchesSearch(m) && matchesFilters(m));

  // Grouping (§19, V1 scope): no hardcoded department list - built purely
  // from whatever departments actually appear on the roster. Sorting by
  // department (with a stable name tiebreaker) and inserting a header
  // whenever the department changes avoids restructuring the existing
  // per-member card list into a nested map.
  const [groupBy, setGroupBy] = useState("none");
  const orderedMembers =
    groupBy === "department"
      ? [...visibleMembers].sort((a, b) => {
          const da = a.department || "No department";
          const db = b.department || "No department";
          return da === db ? (a.name || "").localeCompare(b.name || "") : da.localeCompare(db);
        })
      : visibleMembers;

  if (teamMembers.length === 0) {
    return (
      <div style={styles.invoicesWrap}>
        {loadError && (
          <p style={{ ...styles.fieldHint, color: "#FF4D4D" }} role="alert">
            Team data couldn't be loaded: {loadError}
          </p>
        )}
        <div style={styles.projectsEmpty}>
          <div style={styles.projectsEmptyIcon}><TeamIcon /></div>
          <p style={styles.projectsEmptyText}>No team members yet</p>
          <button style={styles.newButton} onClick={onNew}>
            <PlusIcon />
            New member
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.invoicesWrap}>
      {loadError && (
        <p style={{ ...styles.fieldHint, color: "#FF4D4D" }} role="alert">
          Team data couldn't be loaded: {loadError}
        </p>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
        <input
          style={{ ...styles.input, maxWidth: 260 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, email, role, skills..."
          aria-label="Search team members"
        />
        <div style={{ position: "relative" }}>
          <button type="button" style={styles.tabButton} onClick={() => setShowFilters((v) => !v)}>
            Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
          </button>
          {showFilters && (
            <div
              style={{
                position: "absolute", top: "100%", left: 0, zIndex: 5, marginTop: 4,
                background: "#131b1a", border: "1px solid #2a3634", borderRadius: 8, padding: 10, minWidth: 220,
                display: "flex", flexDirection: "column", gap: 8,
              }}
            >
              <select style={styles.input} value={filters.department} onChange={(e) => setFilters({ ...filters, department: e.target.value })}>
                <option value="">All departments</option>
                {departmentOptions.map((d) => (<option key={d} value={d}>{d}</option>))}
              </select>
              <select style={styles.input} value={filters.role} onChange={(e) => setFilters({ ...filters, role: e.target.value })}>
                <option value="">All roles</option>
                {roleOptions.map((r) => (<option key={r} value={r}>{r}</option>))}
              </select>
              <select style={styles.input} value={filters.skill} onChange={(e) => setFilters({ ...filters, skill: e.target.value })}>
                <option value="">All skills</option>
                {skillOptions.map((s) => (<option key={s} value={s}>{s}</option>))}
              </select>
              <select style={styles.input} value={filters.availability} onChange={(e) => setFilters({ ...filters, availability: e.target.value })}>
                <option value="">Any availability</option>
                {AVAILABILITY_OPTIONS.map((a) => (<option key={a} value={a}>{AVAILABILITY_LABELS[a] || a}</option>))}
              </select>
              <select style={styles.input} value={filters.memberType} onChange={(e) => setFilters({ ...filters, memberType: e.target.value })}>
                <option value="">Freelancer or internal</option>
                <option value="freelancer">Freelancer</option>
                <option value="internal">Internal</option>
              </select>
              {activeFilterCount > 0 && (
                <button
                  type="button"
                  style={styles.tabButton}
                  onClick={() => setFilters({ department: "", role: "", availability: "", memberType: "", skill: "" })}
                >
                  Clear filters
                </button>
              )}
            </div>
          )}
        </div>
        <select style={styles.input} value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
          <option value="none">All members</option>
          <option value="department">Group by department</option>
        </select>
      </div>
      {archivedCount > 0 && (
        <label style={{ ...styles.fieldHint, display: "flex", alignItems: "center", gap: 6, marginBottom: 8, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />
          Include archived ({archivedCount})
        </label>
      )}
      {legacyReviewCount > 0 && (
        <div style={{ marginBottom: 12 }}>
          <button
            type="button"
            style={styles.tabButton}
            onClick={() => setShowLegacyReview((v) => !v)}
          >
            {showLegacyReview ? "Hide" : "Review"} legacy assignments ({legacyReviewCount})
          </button>
          {showLegacyReview && (
            <LegacyAssignmentReview
              matches={legacyMatches}
              onLink={onBackfillAssignment}
            />
          )}
        </div>
      )}
      <div style={styles.invoiceList}>
        {orderedMembers.map((member, idx) => {
          const { shots, pendingByCurrency, paidByCurrency } = computeMemberShots(member, cards, projects, teamMembers);
          const dependability = dependabilityTier(member.dependabilityScore ?? 80);
          const formattedRate = formatMemberRate(member, cur);
          const isArchived = member.status === "archived";
          const groupKey = groupBy === "department" ? member.department || "No department" : null;
          const prevGroupKey = idx === 0 ? undefined : orderedMembers[idx - 1].department || "No department";
          const showGroupHeader = groupKey !== null && groupKey !== prevGroupKey;
          return (
            <React.Fragment key={member.id}>
              {showGroupHeader && (
                <div style={{ ...styles.fieldDivider, marginTop: idx === 0 ? 0 : 12 }}>
                  {groupKey} ({orderedMembers.filter((m) => (m.department || "No department") === groupKey).length})
                </div>
              )}
              <div
              className="kf-card"
              style={{ ...styles.invoiceCard, opacity: isArchived ? 0.6 : 1 }}
              onClick={() => onEdit(member)}
              role="button"
              tabIndex={0}
              aria-label={`Edit ${member.name || "team member"}`}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onEdit(member);
                }
              }}
            >
              <div style={styles.invoiceCardTop}>
                <span style={styles.invoiceNumber}>
                  {disambiguatedMemberLabel(member, duplicateNames)}
                  {isArchived && <span style={{ ...styles.fieldHint, marginLeft: 6 }}>(archived)</span>}
                </span>
                <span
                  style={{
                    ...styles.invoiceStatusTag,
                    color: AVAILABILITY_COLORS[member.availability] || "#8b9a98",
                    borderColor: AVAILABILITY_COLORS[member.availability] || "#8b9a98",
                  }}
                >
                  {AVAILABILITY_LABELS[member.availability] || member.availability}
                </span>
              </div>
              {(member.role || member.department) && (
                <div style={styles.cardMeta}>
                  {member.role}
                  {member.role && member.department ? " · " : ""}
                  {member.department}
                </div>
              )}
              {member.memberType === "freelancer" && member.upworkRating != null && (
                <div style={styles.fieldHint}>
                  {starRating(member.upworkRating)} {member.upworkRating.toFixed?.(1) ?? member.upworkRating}
                  {member.upworkReviewCount != null ? ` (${member.upworkReviewCount})` : ""} {"\u00b7 Upwork"}
                </div>
              )}
              {member.skills?.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 2 }}>
                  {member.skills.slice(0, 5).map((skill) => (
                    <span key={skill} style={styles.skillChip}>
                      {skill}
                    </span>
                  ))}
                  {member.skills.length > 5 && (
                    <span style={styles.skillChip}>+{member.skills.length - 5}</span>
                  )}
                </div>
              )}
              <div style={styles.invoiceAmountsRow}>
                <span style={styles.fieldHint}>Skill: {skillLevelLabel(member.skillLevel)}</span>
                <span style={{ ...styles.fieldHint, color: dependability.color }}>
                  {dependability.label} ({member.dependabilityScore ?? 80})
                </span>
              </div>
              <div style={styles.invoiceAmountsRow}>
                <span style={styles.fieldHint}>
                  {shots.length} shot{shots.length === 1 ? "" : "s"} assigned
                </span>
                {formattedRate && <span style={styles.fieldHint}>Rate {formattedRate}</span>}
              </div>
              {member.capacityValue > 0 && (
                <div style={styles.fieldHint}>
                  Capacity {member.capacityValue} {member.capacityUnit}
                </div>
              )}
              <div style={styles.invoiceAmountsRow}>
                <span style={{ ...styles.fieldHint, color: "#F2A65A" }}>
                  Pending {formatCurrencyTotals(pendingByCurrency) || `${cur}0.00`}
                </span>
                <span style={{ ...styles.fieldHint, color: "#3DDC84" }}>
                  Paid {formatCurrencyTotals(paidByCurrency) || `${cur}0.00`}
                </span>
              </div>
              {shots.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
                  {shots.slice(0, 4).map((s) => (
                    <span key={s.id} style={styles.fieldHint}>
                      {s.title} &middot; {s.projectName} &middot;{" "}
                      {s.assignedPaid ? "paid" : "pending"}
                    </span>
                  ))}
                  {shots.length > 4 && (
                    <span style={styles.fieldHint}>+{shots.length - 4} more</span>
                  )}
                </div>
              )}
            </div>
            </React.Fragment>
          );
        })}
      </div>
      {visibleMembers.length === 0 && (search || activeFilterCount > 0) && (
        <p style={styles.fieldHint}>No team members match your search/filters.</p>
      )}
    </div>
  );
}

// Review UI for computeLegacyAssignmentMatches(): shots still linked to a
// crew member only by free-text assignedTo. Unique name matches can be
// linked one at a time or all at once; ambiguous ones get a per-shot
// picker so a human — never the app — decides between same-named people;
// unmatched shots are listed for awareness only, nothing to link.
function LegacyAssignmentReview({ matches, onLink }) {
  const [linking, setLinking] = useState(null); // card id currently being linked
  const [linkingAll, setLinkingAll] = useState(false); // batch link in progress
  const [picks, setPicks] = useState({}); // cardId -> chosen member id, for ambiguous rows

  const link = async (cardId, memberId) => {
    if (!memberId) return;
    setLinking(cardId);
    await onLink(cardId, memberId);
    setLinking(null);
  };

  const linkAllUnique = async () => {
    if (linkingAll) return;
    setLinkingAll(true);
    try {
      for (const { card, member } of matches.unique) {
        // eslint-disable-next-line no-await-in-loop
        await link(card.id, member.id);
      }
    } finally {
      setLinkingAll(false);
    }
  };

  return (
    <div style={{ ...styles.invoicesWrap, marginTop: 8, border: "1px solid #2a3634", borderRadius: 8, padding: 12 }}>
      {matches.unique.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <p style={styles.fieldHint}>
              {matches.unique.length} shot{matches.unique.length === 1 ? "" : "s"} match exactly one roster member by
              name &mdash; safe to link.
            </p>
            <button type="button" style={styles.tabButton} disabled={linkingAll} onClick={linkAllUnique}>
              {linkingAll ? "Linking..." : "Link all"}
            </button>
          </div>
          {matches.unique.map(({ card, member }) => (
            <div key={card.id} style={{ ...styles.invoiceAmountsRow, marginTop: 4 }}>
              <span style={styles.fieldHint}>
                {card.title || "Untitled shot"} &middot; "{card.assignedTo}" &rarr; {member.name}
                {member.role ? ` (${member.role})` : ""}
              </span>
              <button
                type="button"
                style={styles.tabButton}
                disabled={linking === card.id}
                onClick={() => link(card.id, member.id)}
              >
                {linking === card.id ? "Linking\u2026" : "Link"}
              </button>
            </div>
          ))}
        </div>
      )}

      {matches.ambiguous.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <p style={styles.fieldHint}>
            {matches.ambiguous.length} shot{matches.ambiguous.length === 1 ? "" : "s"} match more than one roster
            member with the same name &mdash; pick which one before linking.
          </p>
          {matches.ambiguous.map(({ card, candidates }) => (
            <div key={card.id} style={{ ...styles.invoiceAmountsRow, marginTop: 4 }}>
              <span style={styles.fieldHint}>
                {card.title || "Untitled shot"} &middot; "{card.assignedTo}"
              </span>
              <select
                style={{ ...styles.input, width: 200 }}
                value={picks[card.id] || ""}
                onChange={(e) => setPicks({ ...picks, [card.id]: e.target.value })}
              >
                <option value="">Which {card.assignedTo}?</option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}{c.email ? ` \u2014 ${c.email}` : c.role ? ` (${c.role})` : ""}
                  </option>
                ))}
              </select>
              <button
                type="button"
                style={styles.tabButton}
                disabled={!picks[card.id] || linking === card.id}
                onClick={() => link(card.id, picks[card.id])}
              >
                {linking === card.id ? "Linking\u2026" : "Link"}
              </button>
            </div>
          ))}
        </div>
      )}

      {matches.unmatched.length > 0 && (
        <div>
          <p style={styles.fieldHint}>
            {matches.unmatched.length} shot{matches.unmatched.length === 1 ? "" : "s"} are assigned to a name that
            doesn't match anyone on the roster &mdash; nothing to link automatically. Add them as a team member, or
            fix the shot's "Assigned to" spelling, if this is unexpected.
          </p>
        </div>
      )}
    </div>
  );
}

// Full-page Planner dashboard (replaces the old pop-out list). Shows
// portfolio-level summary cards (Phase 12 lite analytics), status
// filtering/search, and the plan list. Clicking a plan opens the full-page
// PlannerWorkspace, never a modal.
function PlannerDashboard({ plans, settings, onOpen, onNew, atLimit, hasProAccess, templates, onDeleteTemplate }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);

  const allTemplates = [...BUILT_IN_PLANNER_TEMPLATES, ...(templates || [])];

  const analytics = computePlannerPortfolioAnalytics(plans);
  const cur = settings.currencySymbol || "$";

  const filtered = plans.filter((plan) => {
    if (statusFilter !== "all" && (plan.status || "draft") !== statusFilter) return false;
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (plan.name || "").toLowerCase().includes(q) || (plan.clientName || "").toLowerCase().includes(q);
  });

  const startFromTemplate = (template) => {
    setShowTemplatePicker(false);
    onNew({
      projectType: template.projectType || "",
      targetProfitPercent: template.targetProfitPercent ?? 25,
      departmentAllocations: template.departmentAllocations || defaultDepartmentAllocations(),
      crew: template.crew || [],
      scope: { ...emptyBudgetPlanner().scope, ...(template.scope || {}) },
      templateId: template.builtin ? null : template.id,
    });
  };

  return (
    <div style={styles.invoicesWrap}>
      <div style={styles.plannerPageHeader}>
        <div>
          <h2 style={styles.plannerPageTitle}>Budget Planner</h2>
          <p style={styles.fieldHint}>Plan, price and scope your productions.</p>
        </div>
      </div>

      <div style={styles.dashboardGrid}>
        <PlannerStatCard label="Total planned" value={`${cur}${formatMoney(analytics.totalPlannedValue)}`} />
        <PlannerStatCard label="Avg. production cost" value={`${cur}${formatMoney(analytics.averageProductionCost)}`} />
        <PlannerStatCard label="Avg. margin" value={`${analytics.averageMargin.toFixed(1)}%`} />
        <PlannerStatCard label="Converted to project" value={`${analytics.convertedCount} / ${plans.length}`} />
        <PlannerStatCard label="Proposal win rate" value={analytics.winRate === null ? "—" : `${analytics.winRate.toFixed(0)}%`} />
      </div>

      {atLimit && (
        <p style={styles.fieldHint}>
          You're at the free plan's limit of {FREE_BUDGET_PLANNER_LIMIT} budget plans. Delete one or upgrade
          to Pro for unlimited plans.
        </p>
      )}

      <div style={styles.plannerToolbar}>
        <input
          style={{ ...styles.input, maxWidth: 260 }}
          placeholder="Search plans or clients..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select style={{ ...styles.input, maxWidth: 200 }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="all">All statuses</option>
          {PLANNER_STATUSES.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          style={styles.tabButton}
          disabled={atLimit}
          onClick={() => setShowTemplatePicker((v) => !v)}
        >
          {showTemplatePicker ? "Close templates" : "New from template"}
        </button>
      </div>

      {showTemplatePicker && (
        <div style={styles.plannerTemplateRow}>
          {allTemplates.map((t) => (
            <button
              key={t.id}
              type="button"
              className="kf-card"
              style={styles.plannerTemplateCard}
              onClick={() => startFromTemplate(t)}
            >
              <span style={styles.invoiceNumber}>{t.name}</span>
              <span style={styles.fieldHint}>{t.builtin ? "Built-in" : "Your template"}</span>
              {!t.builtin && hasProAccess && (
                <span
                  role="button"
                  style={{ ...styles.fieldHint, color: "#FF4D4D" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm(`Delete template "${t.name}"?`)) onDeleteTemplate(t.id);
                  }}
                >
                  Remove
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {plans.length === 0 ? (
        <div style={styles.projectsEmpty}>
          <div style={styles.projectsEmptyIcon}><InvoiceIcon /></div>
          <p style={styles.projectsEmptyText}>No budget plans yet</p>
          <p style={styles.fieldHint}>
            Sketch out a project's numbers before you commit to it: budget, target profit, department spend,
            crew cost, and what's actually left to deliver it.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <p style={styles.fieldHint}>No plans match your search/filter.</p>
      ) : (
        <div style={styles.invoiceList}>
          {filtered.map((plan) => {
            const intel = computePlannerIntelligence(plan);
            const cur2 = plan.currency || settings.currencySymbol || "$";
            const healthColor =
              intel.financial.state === "green" ? "#3DDC84" : intel.financial.state === "yellow" ? "#F2A65A" : "#FF4D4D";
            return (
              <div key={plan.id} className="kf-card" style={styles.invoiceCard} onClick={() => onOpen(plan)}>
                <div style={styles.invoiceCardTop}>
                  <span style={styles.invoiceNumber}>{plan.name || "Untitled plan"}</span>
                  <span style={{ ...styles.invoiceStatusTag, color: healthColor, borderColor: healthColor }}>
                    {PLANNER_STATUS_LABELS[plan.status] || "Draft"}
                  </span>
                </div>
                {plan.clientName && <div style={styles.cardMeta}>{plan.clientName}</div>}
                <div style={styles.invoiceAmountsRow}>
                  <span style={styles.fieldHint}>
                    Budget {cur2}{formatMoney(intel.financial.budget)}
                  </span>
                  <span style={styles.fieldHint}>{plan.targetProfitPercent}% target profit</span>
                  <span style={{ ...styles.fieldHint, color: healthColor }}>
                    {intel.dealScore.label} · {intel.dealScore.score}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PlannerStatCard({ label, value }) {
  return (
    <div className="kf-card" style={styles.budgetStat}>
      <span style={styles.label}>{label}</span>
      <span style={styles.budgetStatValue}>{value}</span>
    </div>
  );
}

// --- Studio Time / greeting helpers -------------------------------------
// The display name comes from the authenticated user's own Supabase auth
// profile, never hardcoded: Google sign-in populates user_metadata's
// full_name/name, so that first name is used when present. Email/password
// accounts have no such metadata, so this falls back to a cleaned-up
// version of the email's local part - still real account data, not a
// placeholder.
function getDisplayName(user) {
  const meta = user?.user_metadata || {};
  const metaName = meta.full_name || meta.name;
  if (metaName) return String(metaName).trim().split(/\s+/)[0];
  const localPart = (user?.email || "").split("@")[0];
  if (!localPart) return "";
  const firstSegment = localPart.split(/[._-]+/)[0];
  return firstSegment ? firstSegment.charAt(0).toUpperCase() + firstSegment.slice(1) : "";
}

// date.getHours() already reads in the browser's local time, so this (and
// localDayStartISO below) needs no stored timezone - there isn't one
// anywhere in this app's user_settings/profile data today, and this way
// nothing is hardcoded to one.
function getGreeting(date) {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  return "Good evening";
}

function formatClockDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatDayDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}

// Local midnight, as the matching UTC instant, for querying "today" without
// assuming UTC. new Date(y, m, d) is built from the browser's own local
// calendar fields, so this lands on the right day in whatever timezone the
// user's system is actually set to.
function localDayStartISO(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0).toISOString();
}

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

// Monday-start week containing `date`.
function startOfWeek(date) {
  const d = startOfLocalDay(date);
  const day = d.getDay(); // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function isSameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Inclusive day count between two dates using calendar-field arithmetic
// (via startOfLocalDay/addDays), matching every other date helper in this
// file - unlike a raw millisecond division by 86400000, this stays correct
// across the day a clock change happens.
function calendarDaysBetween(a, b) {
  const start = startOfLocalDay(a);
  const end = startOfLocalDay(b);
  let count = 0;
  for (let cursor = new Date(start); cursor <= end; cursor = addDays(cursor, 1)) count++;
  return count;
}

function dayKey(d) {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// The studio's normal schedule: Monday-Friday, 09:00-17:00, i.e. an 8h
// target per weekday. Anything clocked beyond a day's target is overtime;
// weekends carry a 0h target, so time worked on them is overtime in full.
const WORKDAY_TARGET_SECONDS = 8 * 3600;

function isScheduledWorkday(date) {
  const day = date.getDay(); // 0 = Sunday, 6 = Saturday
  return day >= 1 && day <= 5;
}

function scheduledSecondsForDay(date) {
  return isScheduledWorkday(date) ? WORKDAY_TARGET_SECONDS : 0;
}

// "9h 30m", "6h", "45m", "0h" - drops a trailing "0m" so the daily
// breakdown reads the way a person would say it out loud, unlike
// formatDayDuration which always prints both parts.
function formatWorkDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h === 0 && m === 0) return "0h";
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

const POMODORO_DEFAULTS = { workMinutes: 25, breakMinutes: 5, longBreakMinutes: 15, cyclesBeforeLongBreak: 4 };
const POMODORO_STORAGE_KEY = "kairil_pomodoro_config";

// Pomodoro setup is a lightweight personal preference, not account data, so
// it's kept in localStorage rather than added to work_sessions - it's read
// once on mount and re-saved whenever the user changes it in the setup form.
function loadPomodoroConfig() {
  if (typeof window === "undefined" || !window.localStorage) return POMODORO_DEFAULTS;
  try {
    const saved = JSON.parse(window.localStorage.getItem(POMODORO_STORAGE_KEY));
    if (saved && typeof saved === "object") return { ...POMODORO_DEFAULTS, ...saved };
  } catch {
    // malformed or missing - fall through to defaults
  }
  return POMODORO_DEFAULTS;
}

function savePomodoroConfig(config) {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(POMODORO_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // storage unavailable/full - the in-memory config still works for this session
  }
}

// Unlike pomodoroConfig (a standing preference), this is the live in-progress
// phase/countdown/cycle - saved so a remount (navigating away from the
// Dashboard and back, or a page refresh) can resume a focus session instead
// of silently dropping it. Cleared whenever there's no active phase.
const POMODORO_STATE_KEY = "kairil_pomodoro_state";

function loadPomodoroState() {
  if (typeof window === "undefined" || !window.localStorage) return null;
  try {
    const saved = JSON.parse(window.localStorage.getItem(POMODORO_STATE_KEY));
    if (
      saved &&
      typeof saved === "object" &&
      ["work", "break", "longBreak"].includes(saved.phase) &&
      Number.isFinite(saved.phaseEndsAt)
    ) {
      return {
        phase: saved.phase,
        phaseEndsAt: saved.phaseEndsAt,
        cycle: Number.isFinite(saved.cycle) && saved.cycle >= 1 ? saved.cycle : 1,
      };
    }
  } catch {
    // malformed or missing - nothing to resume
  }
  return null;
}

function savePomodoroState(state) {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    if (state) window.localStorage.setItem(POMODORO_STATE_KEY, JSON.stringify(state));
    else window.localStorage.removeItem(POMODORO_STATE_KEY);
  } catch {
    // best-effort only
  }
}

// Browser desktop notifications. Permission (like Pomodoro's config) is a
// per-device browser setting, not account data, so there's nothing to sync
// to Supabase here - Notification.permission itself is the source of
// truth, checked fresh every time rather than mirrored into app state that
// could drift from it (e.g. if the user changes it from the browser's own
// site-settings UI instead of Kairil's).
function notificationsSupported() {
  return typeof window !== "undefined" && "Notification" in window;
}

// Mirrors settings.notificationsEnabled. A plain module-level flag rather
// than a prop, because notifyBrowser() is called from places (the CRM
// needs-attention digest, StudioTimeCard's Pomodoro phase transitions)
// that don't all have the settings object threaded through them. Synced
// once, on the main app component, whenever settings load or change - see
// setNotificationsEnabledFlag below.
let notificationsEnabledFlag = true;
function setNotificationsEnabledFlag(enabled) {
  notificationsEnabledFlag = enabled !== false;
}

function notifyBrowser(title, body, tag) {
  if (!notificationsEnabledFlag) return;
  if (!notificationsSupported() || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body, tag, icon: "/icon-512.png" });
    // Auto-close after a while so these don't pile up in the OS
    // notification center if the studio steps away for hours.
    setTimeout(() => n.close(), 20000);
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    // Some browsers throw if called outside a user-gesture-adjacent
    // context on certain platforms - a missed notification isn't worth
    // surfacing an error for.
  }
}

// Needs-Attention notifications are deliberately a single batched digest
// per change, not one notification per lead - four individual "lead
// responded" pings every few minutes would train anyone to ignore them.
// The signature is stored per-day so a fresh day (or a genuinely new
// number of items) can notify again, but re-checking every few minutes
// with no change stays silent.
const NEEDS_ATTENTION_NOTIFIED_KEY = "kairil_needs_attention_notified";
function shouldNotifyNeedsAttention(signature) {
  if (typeof window === "undefined" || !window.localStorage) return true;
  try {
    return window.localStorage.getItem(NEEDS_ATTENTION_NOTIFIED_KEY) !== signature;
  } catch {
    return true;
  }
}
function markNeedsAttentionNotified(signature) {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(NEEDS_ATTENTION_NOTIFIED_KEY, signature);
  } catch {
    // best-effort only
  }
}

function DashboardGreeting({ user, compact = false }) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(id);
  }, []);

  const name = getDisplayName(user);
  const greeting = getGreeting(now);
  const dateLabel = now.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });

  if (compact) {
    return (
      <div style={styles.dashboardGreetingCompact}>
        <span style={styles.dashboardGreetingCompactTitle}>
          {greeting}{name ? `, ${name}` : ""} <span aria-hidden="true">👋</span>
        </span>
        <span style={styles.dashboardGreetingCompactDate}>{dateLabel}</span>
      </div>
    );
  }

  return (
    <div>
      <h2 style={styles.greetingTitle}>
        <span>
          {greeting}
          {name ? `, ${name}` : ""}
        </span>
        <span aria-hidden="true">👋</span>
      </h2>
      <p style={styles.fieldHint}>Ready to get some work done?</p>
    </div>
  );
}

// Studio Time: a persistent, Supabase-backed clock in/out tracker. All
// state is re-derived from work_sessions on every mount rather than kept
// only in memory, so it survives refreshes, closing and reopening the
// Dashboard, and navigating to other Kairil pages and back - there's
// nothing to "restore" client-side, it just re-asks the database what's
// true every time.

function PomodoroSetupForm({ config, onChange, onStart, busy }) {
  const setField = (field, max) => (e) => {
    const value = Math.max(1, Math.min(max, Number(e.target.value) || 1));
    onChange({ ...config, [field]: value });
  };

  return (
    <div style={styles.pomodoroSetup}>
      <div style={styles.pomodoroSetupGrid}>
        <label style={styles.pomodoroField}>
          <span style={styles.label}>Focus (min)</span>
          <input type="number" min={1} max={180} style={styles.input} value={config.workMinutes} onChange={setField("workMinutes", 180)} />
        </label>
        <label style={styles.pomodoroField}>
          <span style={styles.label}>Break (min)</span>
          <input type="number" min={1} max={180} style={styles.input} value={config.breakMinutes} onChange={setField("breakMinutes", 180)} />
        </label>
        <label style={styles.pomodoroField}>
          <span style={styles.label}>Long break (min)</span>
          <input type="number" min={1} max={180} style={styles.input} value={config.longBreakMinutes} onChange={setField("longBreakMinutes", 180)} />
        </label>
        <label style={styles.pomodoroField}>
          <span style={styles.label}>Cycles</span>
          <input type="number" min={1} max={12} style={styles.input} value={config.cyclesBeforeLongBreak} onChange={setField("cyclesBeforeLongBreak", 12)} />
        </label>
      </div>
      <button type="button" style={styles.newButton} onClick={onStart} disabled={busy}>
        {busy ? <SpinnerIcon size={16} /> : <ClockIcon />}
        Start Focus Session
      </button>
    </div>
  );
}

// Totals + a day-by-day trend for one period (week or month), from a set of
// already-fetched completed sessions plus the live active session if any.
// The active session (if present) only counts toward a period whose range
// actually contains its clock_in - a session left open from a prior period
// (forgotten clock-out, a stalled auto-cycle, a sleeping laptop) should not
// have its full elapsed time folded into whatever period happens to be open
// right now.
function computePeriodStats(completedSessions, activeSession, rangeStart, rangeEndExclusive, now) {
  const inRange = completedSessions.filter((r) => {
    const d = new Date(r.clock_in);
    return d >= rangeStart && d < rangeEndExclusive;
  });

  // Every calendar day in the period is built up front - including days
  // still in the future - so the breakdown can show an elapsed 0h day as a
  // real (missed) day while a day that simply hasn't happened yet stays
  // visibly blank instead of masquerading as zero work.
  const today = startOfLocalDay(now);
  const lastDay = addDays(rangeEndExclusive, -1);
  const days = [];
  for (let cursor = new Date(rangeStart); cursor <= lastDay; cursor = addDays(cursor, 1)) {
    const date = new Date(cursor);
    const dayStart = startOfLocalDay(date);
    days.push({
      date,
      seconds: 0,
      scheduledSeconds: scheduledSecondsForDay(date),
      isScheduled: isScheduledWorkday(date),
      isToday: dayStart.getTime() === today.getTime(),
      isFuture: dayStart > today,
    });
  }
  const addToDay = (dateObj, seconds) => {
    const match = days.find((d) => isSameLocalDay(d.date, dateObj));
    if (match) match.seconds += seconds;
  };

  let totalSeconds = 0;
  let pomodoroSeconds = 0;

  // A session that crosses midnight gets its duration split across each
  // calendar day it actually touches, rather than attributing all of it to
  // the start day - so a day's overtime is judged against the hours really
  // worked on that day.
  const attributeSession = (start, end, seconds, sessionType) => {
    totalSeconds += seconds;
    if (sessionType === "pomodoro") pomodoroSeconds += seconds;
    if (seconds <= 0 || isSameLocalDay(start, end)) {
      addToDay(start, seconds);
      return;
    }
    let cursor = start;
    let remaining = seconds;
    while (cursor < end && remaining > 0) {
      const dayEnd = addDays(startOfLocalDay(cursor), 1);
      const segmentEnd = dayEnd < end ? dayEnd : end;
      const isLastSegment = segmentEnd >= end;
      // Every day but the last is capped at its own real elapsed time so it
      // never claims more than actually happened on it. The last day just
      // absorbs whatever's left of the budget - `seconds` (the DB's
      // whole-second duration) and the real end-start difference can be
      // off by a fraction of a second, and letting the final segment
      // soak that up guarantees the per-day total always adds back up to
      // `seconds` exactly, instead of leaving a stray second unattributed.
      const segmentSeconds = isLastSegment
        ? remaining
        : Math.min(remaining, Math.max(0, Math.round((segmentEnd - cursor) / 1000)));
      addToDay(cursor, segmentSeconds);
      remaining -= segmentSeconds;
      cursor = segmentEnd;
    }
  };

  inRange.forEach((r) => {
    const seconds = r.duration || 0;
    const start = new Date(r.clock_in);
    const end = r.clock_out ? new Date(r.clock_out) : new Date(start.getTime() + seconds * 1000);
    attributeSession(start, end, seconds, r.session_type);
  });

  if (activeSession) {
    const start = new Date(activeSession.clockIn);
    if (start >= rangeStart && start < rangeEndExclusive) {
      const elapsed = Math.max(0, Math.floor((now - start) / 1000));
      attributeSession(start, now, elapsed, activeSession.sessionType);
    }
  }

  // Overtime is worked out per day, never from the period total: eight
  // hours on Monday and none on Tuesday is a day of overtime debt, not a
  // balanced 16h. Target and average both count every *elapsed* scheduled
  // weekday, today included, so a day worked at 0h drags the average down
  // instead of quietly vanishing from the denominator.
  //
  // Weekend time is never folded into "overtime" - the schedule has no
  // weekend target to measure it against, so calling 4h on a Saturday
  // "+4h overtime" would misrepresent it as excess against an 8h day that
  // was never scheduled. It's tracked separately as unscheduled work: it
  // still counts fully toward Worked, just not toward Target or Overtime.
  let targetSeconds = 0;
  let overtimeSeconds = 0;
  let unscheduledSeconds = 0;
  let elapsedScheduledDays = 0;

  days.forEach((d) => {
    if (d.isFuture) {
      d.overtimeSeconds = 0;
      d.shortfallSeconds = 0;
      return;
    }
    if (d.isScheduled) {
      d.overtimeSeconds = Math.max(0, d.seconds - d.scheduledSeconds);
      d.shortfallSeconds = Math.max(0, d.scheduledSeconds - d.seconds);
      targetSeconds += d.scheduledSeconds;
      overtimeSeconds += d.overtimeSeconds;
      elapsedScheduledDays += 1;
    } else {
      // Unscheduled (weekend) day: no target, so no overtime/shortfall -
      // just logged hours, kept out of Target/Overtime/Average entirely.
      d.overtimeSeconds = 0;
      d.shortfallSeconds = 0;
      unscheduledSeconds += d.seconds;
    }
  });

  return {
    totalSeconds,
    pomodoroSeconds,
    manualSeconds: totalSeconds - pomodoroSeconds,
    targetSeconds,
    overtimeSeconds,
    unscheduledSeconds,
    elapsedScheduledDays,
    averageSeconds: elapsedScheduledDays > 0 ? Math.round(totalSeconds / elapsedScheduledDays) : 0,
    efficiencyPct: targetSeconds > 0 ? Math.round((totalSeconds / targetSeconds) * 100) : 0,
    dailyTrend: days,
  };
}

function StudioTimeSummaryModal({ userId, onClose }) {
  const [period, setPeriod] = useState("week"); // "week" | "month"
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [completedRows, setCompletedRows] = useState([]);
  const [activeSession, setActiveSession] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const today = new Date();
        const weekStart = startOfWeek(today);
        const monthStart = startOfMonth(today);
        const rangeStart = weekStart < monthStart ? weekStart : monthStart;
        const { data, error: fetchError } = await supabase
          .from("work_sessions")
          .select("*")
          .or(`clock_out.is.null,clock_in.gte.${rangeStart.toISOString()}`)
          .order("clock_in", { ascending: true });
        if (fetchError) throw fetchError;
        if (cancelled) return;
        setCompletedRows((data || []).filter((r) => r.clock_out !== null));
        const active = (data || []).find((r) => r.clock_out === null) || null;
        setActiveSession(active ? { clockIn: active.clock_in, sessionType: active.session_type } : null);
      } catch (err) {
        if (!cancelled) setError(err.message || "Couldn't load the studio time summary.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const now = new Date();
  const rangeStart = period === "week" ? startOfWeek(now) : startOfMonth(now);
  const rangeEndExclusive =
    period === "week" ? addDays(rangeStart, 7) : new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const stats = computePeriodStats(completedRows, activeSession, rangeStart, rangeEndExclusive, now);
  // "In focus sessions" is deliberately a ratio of *time*, not of session
  // count - twenty two-minute sessions shouldn't outweigh one three-hour
  // block of focused work.
  const focusRatio = stats.totalSeconds > 0 ? Math.round((stats.pomodoroSeconds / stats.totalSeconds) * 100) : 0;

  // Scheduled weekdays always get a row, so a 0h Tuesday is visible rather
  // than skipped. A weekend only shows up when something was actually
  // clocked on it - in which case all of it counts as overtime, since the
  // schedule targets 0h there.
  const breakdownDays = stats.dailyTrend
    .filter((d) => d.isScheduled || d.seconds > 0)
    .map((d) => ({
      ...d,
      key: dayKey(d.date),
      label:
        period === "week"
          ? d.date.toLocaleDateString(undefined, { weekday: "long" })
          : d.date.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      shortLabel:
        period === "week"
          ? d.date.toLocaleDateString(undefined, { weekday: "short" })
          : String(d.date.getDate()),
    }));

  // The chart is fed from the very same per-day rows as the list below it,
  // so Monday's plotted value and Monday's printed total can never drift
  // apart. Future days carry a null value rather than a 0, which leaves a
  // gap in the area instead of drawing a plunge to the floor.
  const trendData = breakdownDays.map((d) => ({
    label: d.shortLabel,
    value: d.isFuture ? null : Math.round((d.seconds / 3600) * 100) / 100,
  }));

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={{ ...styles.modal, maxWidth: 600, gap: 18 }} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <h3 style={styles.modalTitle}>Studio Time Summary</h3>
          <button style={styles.iconButton} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        <div style={styles.tabRow}>
          <button
            style={{ ...styles.tabButton, ...(period === "week" ? styles.tabButtonActive : {}) }}
            onClick={() => setPeriod("week")}
          >
            This week
          </button>
          <button
            style={{ ...styles.tabButton, ...(period === "month" ? styles.tabButtonActive : {}) }}
            onClick={() => setPeriod("month")}
          >
            This month
          </button>
        </div>

        {loading ? (
          <p style={styles.fieldHint}>Loading{"\u2026"}</p>
        ) : error ? (
          <p style={{ ...styles.fieldHint, color: "#FF4D4D" }}>{error}</p>
        ) : (
          <>
            <HoursTrendChart data={trendData} />

            <div>
              <span style={styles.label}>Daily breakdown</span>
              <div style={styles.dayBreakdownList}>
                {breakdownDays.map((d, i) => (
                  <div
                    key={d.key}
                    style={{
                      ...styles.dayBreakdownRow,
                      ...(i === breakdownDays.length - 1 ? { borderBottom: "none" } : {}),
                    }}
                  >
                    <span style={{ ...styles.dayBreakdownDay, ...(d.isToday ? styles.dayBreakdownDayToday : {}) }}>
                      {d.label}
                    </span>
                    {d.isFuture ? (
                      <span style={styles.dayBreakdownFuture} title="Not reached yet">
                        {"\u2014"}
                      </span>
                    ) : (
                      <span style={styles.dayBreakdownValues}>
                        <span style={d.seconds > 0 ? styles.dayBreakdownHours : styles.dayBreakdownHoursZero}>
                          {formatWorkDuration(d.seconds)}
                        </span>
                        {!d.isScheduled ? (
                          <span style={styles.dayBreakdownNote}>(unscheduled)</span>
                        ) : d.overtimeSeconds > 0 ? (
                          <span style={styles.dayBreakdownOvertime}>
                            +{formatWorkDuration(d.overtimeSeconds)} overtime
                          </span>
                        ) : d.shortfallSeconds > 0 ? (
                          <span style={styles.dayBreakdownShortfall}>
                            {formatWorkDuration(d.shortfallSeconds)} short
                          </span>
                        ) : null}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div style={styles.summaryStatsRow}>
              <div style={styles.summaryStat}>
                <span style={styles.label}>Worked</span>
                <span style={styles.summaryStatValue}>{formatWorkDuration(stats.totalSeconds)}</span>
                <span style={styles.summaryStatHint}>
                  Clocked time this {period === "week" ? "week" : "month"}.
                </span>
              </div>
              <div style={styles.summaryStat}>
                <span style={styles.label}>Target</span>
                <span style={styles.summaryStatValue}>{formatWorkDuration(stats.targetSeconds)}</span>
                <span style={styles.summaryStatHint}>
                  {stats.elapsedScheduledDays} weekday{stats.elapsedScheduledDays === 1 ? "" : "s"} elapsed {"\u00d7"} 8h.
                </span>
              </div>
              <div style={styles.summaryStat}>
                <span style={styles.label}>Overtime</span>
                <span
                  style={{
                    ...styles.summaryStatValue,
                    ...(stats.overtimeSeconds > 0 ? { color: OVERTIME_COLOR } : {}),
                  }}
                >
                  {stats.overtimeSeconds > 0 ? formatWorkDuration(stats.overtimeSeconds) : "\u2014"}
                </span>
                <span style={styles.summaryStatHint}>
                  Beyond the weekday target.
                  {stats.unscheduledSeconds > 0
                    ? ` (+${formatWorkDuration(stats.unscheduledSeconds)} weekend, in Worked.)`
                    : ""}
                </span>
              </div>
              <div style={styles.summaryStat}>
                <span style={styles.label}>Efficiency</span>
                <span style={styles.summaryStatValue}>
                  {stats.targetSeconds > 0 ? `${stats.efficiencyPct}%` : "\u2014"}
                </span>
                <span style={styles.summaryStatHint}>Worked {"\u00f7"} target.</span>
              </div>
              <div style={styles.summaryStat}>
                <span style={styles.label}>Average</span>
                <span style={styles.summaryStatValue}>
                  {stats.elapsedScheduledDays > 0 ? `${formatWorkDuration(stats.averageSeconds)}/day` : "\u2014"}
                </span>
                <span style={styles.summaryStatHint}>Per elapsed weekday.</span>
              </div>
              <div style={styles.summaryStat}>
                <span style={styles.label}>In focus sessions</span>
                <span style={styles.summaryStatValue}>{focusRatio}%</span>
                <span style={styles.summaryStatHint}>Share of clocked time in Pomodoro sessions.</span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
function StudioTimeCard({ userId, visible = true }) {
  const [activeSession, setActiveSession] = useState(null); // { id, clockIn, sessionType } | null
  const [todaySeconds, setTodaySeconds] = useState(0); // completed sessions today, in seconds
  const [now, setNow] = useState(() => new Date());
  const [initializing, setInitializing] = useState(true);
  const [clockingIn, setClockingIn] = useState(false);
  const [clockingOut, setClockingOut] = useState(false);
  const [clockError, setClockError] = useState("");

  // Pomodoro focus sessions - reuse the exact same clock-in/out calls above
  // (tagged session_type: "pomodoro"), so a focus session is just a
  // structured, auto-repeating way of doing the same clock in/out cycle,
  // not a separate tracking system.
  const [pomodoroConfig, setPomodoroConfig] = useState(loadPomodoroConfig);
  const [showPomodoroSetup, setShowPomodoroSetup] = useState(false);
  // Initialized from localStorage (not just null) so a remount - navigating
  // away from the Dashboard and back, or a page refresh - can resume an
  // in-progress focus session instead of silently dropping the countdown.
  // Reconciled against the actual DB session just below, once it loads.
  const [pomodoroPhase, setPomodoroPhase] = useState(() => loadPomodoroState()?.phase ?? null); // null | "work" | "break" | "longBreak"
  const [pomodoroCycle, setPomodoroCycle] = useState(() => loadPomodoroState()?.cycle ?? 1);
  const [phaseEndsAt, setPhaseEndsAt] = useState(() => loadPomodoroState()?.phaseEndsAt ?? null); // ms epoch
  const transitioningRef = useRef(false);

  // Always-on-top popup (Document Picture-in-Picture). Chrome/Edge and
  // recent Firefox only, as of when this was built - not Safari.
  const [pipSupported, setPipSupported] = useState(false);
  const [pipWindow, setPipWindow] = useState(null);
  // Non-blocking note shown when the floating window itself fails to open.
  // Kept separate from clockError because a failed pop-out is not a failed
  // session - the work session starts and runs normally either way.
  const [pipNotice, setPipNotice] = useState("");

  const [showSummary, setShowSummary] = useState(false);

  // Computed early (rather than just before render) so openPip and the
  // auto-close effect below can both use it: the pop-out window is only
  // ever meant to show an active session/phase, never the idle setup view.
  const idle = !activeSession && !pomodoroPhase;

  useEffect(() => {
    setPipSupported(typeof window !== "undefined" && "documentPictureInPicture" in window);
  }, []);

  // Close the floating window whenever it changes and on unmount (this
  // component is now mounted once, persistently, at the app root - see its
  // call site - so in practice "unmount" means signing out or closing the
  // tab, not switching modules) - otherwise React tears down the portaled
  // content but leaves the native window itself behind, with nothing in
  // the app still holding a reference to close it.
  useEffect(() => {
    return () => {
      if (pipWindow) pipWindow.close();
    };
  }, [pipWindow]);

  // Closes the pop-out any time it's open while idle: the tracked
  // session/phase ending while it's still open, or a blocked/failed
  // clock-in that leaves the app idle with the window already open. This
  // is what actually stops the fixed-size window from settling on the
  // wider "Start a focus session" setup grid.
  //
  // Guarded on !clockingIn: openPip()'s requestWindow() call and the
  // clock-in's own Supabase insert both resolve independently, and
  // requestWindow() often wins that race - the window can finish opening
  // (setPipWindow fires) while activeSession/pomodoroPhase are still null,
  // which makes `idle` momentarily true. Without this guard, that brief
  // window is exactly the "idle" case above and this effect closes the
  // popup the instant it opens, before clocking in ever finishes -
  // clockingIn is true for that whole stretch, so it's a safe way to tell
  // "still starting up" apart from "genuinely idle."
  useEffect(() => {
    if (idle && pipWindow && !clockingIn) {
      pipWindow.close();
      setPipWindow(null);
    }
    // The pop-out notice is only meaningful for a session that's running;
    // once there's nothing being tracked it's just stale text.
    if (idle && !clockingIn) setPipNotice("");
  }, [idle, pipWindow, clockingIn]);

  useEffect(() => {
    savePomodoroConfig(pomodoroConfig);
  }, [pomodoroConfig]);

  // Mirror the live phase/countdown/cycle to localStorage so it survives a
  // remount; cleared automatically whenever there's no active phase (a
  // natural phase end, stopPomodoro, or the reconciliation check below all
  // flow through setPomodoroPhase(null), which lands here).
  useEffect(() => {
    if (pomodoroPhase && phaseEndsAt) {
      savePomodoroState({ phase: pomodoroPhase, phaseEndsAt, cycle: pomodoroCycle });
    } else {
      savePomodoroState(null);
    }
  }, [pomodoroPhase, phaseEndsAt, pomodoroCycle]);

  const refetchSessions = useCallback(async () => {
    if (!userId) return;
    try {
      const dayStart = localDayStartISO();
      const todayStartDate = startOfLocalDay(new Date());
      // Active session (any date, in case it was started just before
      // midnight) plus every session - active or completed - that touches
      // today, which includes ones that started yesterday and were only
      // clocked out after midnight (clock_out.gte.dayStart catches those;
      // clock_in.gte.dayStart alone would miss them entirely).
      const { data: rows, error } = await supabase
        .from("work_sessions")
        .select("*")
        .or(`clock_out.is.null,clock_in.gte.${dayStart},clock_out.gte.${dayStart}`)
        .order("clock_in", { ascending: true });
      if (error) throw error;
      let active = null;
      let completedSeconds = 0;
      (rows || []).forEach((row) => {
        if (row.clock_out === null) {
          active = { id: row.id, clockIn: row.clock_in, sessionType: row.session_type || "manual" };
          return;
        }
        const duration = row.duration || 0;
        const start = new Date(row.clock_in);
        if (start >= todayStartDate) {
          // Started today - the whole thing counts.
          completedSeconds += duration;
        } else {
          // Started before today's local midnight (and, per the query
          // above, was clocked out today or later) - only the portion from
          // midnight onward belongs to "today". Clamped to `duration` so a
          // rounding mismatch between the DB's floored duration and the
          // real clock_out timestamp can't overcount.
          const end = new Date(row.clock_out);
          const sinceMidnight = Math.max(0, Math.round((end - todayStartDate) / 1000));
          completedSeconds += Math.min(duration, sinceMidnight);
        }
      });
      setActiveSession(active);
      setTodaySeconds(completedSeconds);
    } catch (err) {
      console.error("Studio time load failed:", err);
    }
  }, [userId]);

  useEffect(() => {
    let cancelled = false;
    setInitializing(true);
    refetchSessions().finally(() => {
      if (!cancelled) setInitializing(false);
    });
    return () => {
      cancelled = true;
    };
  }, [refetchSessions]);

  // A restored "work" phase claims there's an active pomodoro session, but
  // the only source of truth for that is the database - if it disagrees
  // (stopped from another tab, cleaned up server-side, or the localStorage
  // entry is simply stale), drop the restored phase rather than showing a
  // countdown for a session that no longer exists. A restored break/long
  // break has no corresponding DB row by design, so it's trusted as-is.
  useEffect(() => {
    if (initializing) return;
    if (pomodoroPhase === "work" && (!activeSession || activeSession.sessionType !== "pomodoro")) {
      setPomodoroPhase(null);
      setPhaseEndsAt(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initializing]);

  // Ticks while a session is active, or mid-pomodoro - breaks have no
  // active session but still need their own countdown to keep moving.
  useEffect(() => {
    if (!activeSession && !pomodoroPhase) return;
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, [activeSession, pomodoroPhase]);

  // Resolves to the created session on success, resolves to undefined if
  // blocked by a guard (already clocked in, no userId), and throws on a
  // real failure (after already recording it in clockError) - callers that
  // don't care about the outcome can just fire-and-forget with .catch(() => {}).
  const handleClockIn = async (sessionType = "manual") => {
    if (clockingIn || activeSession || !userId) return undefined;
    // Fired synchronously, before any await below - Chrome's
    // requestWindow() only succeeds inside an active user-gesture call
    // stack, which this still is right now but won't be once we've awaited
    // the Supabase insert. openPip() no-ops on its own if unsupported or
    // already open, so this is safe to call unconditionally on every
    // clock-in (manual or the pomodoro one that opens a focus session).
    openPip();
    setClockError("");
    setClockingIn(true);
    try {
      const { data: row, error } = await supabase
        .from("work_sessions")
        .insert({ user_id: userId, session_type: sessionType }) // clock_in is the database's own now()
        .select()
        .single();
      if (error) {
        if (error.code === "23505") {
          // The one-active-session-per-user index caught a race (another
          // tab, or a click that slipped in before the button disabled) -
          // not a real failure, just resync with what's actually there.
          await refetchSessions();
          return undefined;
        }
        throw error;
      }
      const session = { id: row.id, clockIn: row.clock_in, sessionType: row.session_type || sessionType };
      setActiveSession(session);
      return session;
    } catch (err) {
      setClockError(err.message || "Couldn't clock in, please try again.");
      await refetchSessions();
      throw err;
    } finally {
      setClockingIn(false);
    }
  };

  const handleClockOut = async () => {
    if (clockingOut || !activeSession) return undefined;
    setClockError("");
    setClockingOut(true);
    try {
      // clock_out_active_session() stamps clock_out and computes duration
      // from the database's own clock in one atomic update, rather than
      // trusting the browser's clock or risking a read-then-write gap.
      const { data: row, error } = await supabase.rpc("clock_out_active_session");
      if (error) throw error;
      setActiveSession(null);
      setTodaySeconds((prev) => prev + (row?.duration || 0));
      return row;
    } catch (err) {
      setClockError(err.message || "Couldn't clock out, please try again.");
      // The update may have actually gone through even though this failed
      // (e.g. the response didn't make it back) - resync instead of
      // leaving the UI stuck showing a session the database already closed.
      await refetchSessions();
      throw err;
    } finally {
      setClockingOut(false);
    }
  };

  // Resolves to true if a work phase was actually started, false if it was
  // blocked or failed (and the phase was reset to idle) - callers use this
  // to avoid announcing a focus session that never began.
  const beginPomodoroWork = async () => {
    let session;
    try {
      session = await handleClockIn("pomodoro");
    } catch {
      setPomodoroPhase(null);
      setPhaseEndsAt(null);
      return false;
    }
    if (!session) {
      // Blocked (already clocked in some other way) - don't claim a work
      // phase started when nothing was actually clocked in.
      setPomodoroPhase(null);
      setPhaseEndsAt(null);
      return false;
    }
    setPomodoroPhase("work");
    setPhaseEndsAt(Date.now() + pomodoroConfig.workMinutes * 60000);
    return true;
  };

  const advancePomodoroPhase = async () => {
    if (transitioningRef.current) return;
    transitioningRef.current = true;
    try {
      if (pomodoroPhase === "work") {
        try {
          await handleClockOut();
        } catch {
          // Already surfaced via clockError; still move on to the break so
          // one failed request doesn't get the whole rhythm stuck.
        }
        const completingLongBreak = pomodoroCycle >= pomodoroConfig.cyclesBeforeLongBreak;
        const nextPhase = completingLongBreak ? "longBreak" : "break";
        const minutes = completingLongBreak ? pomodoroConfig.longBreakMinutes : pomodoroConfig.breakMinutes;
        setPomodoroPhase(nextPhase);
        setPhaseEndsAt(Date.now() + minutes * 60000);
        notifyBrowser(
          completingLongBreak ? "Long break time" : "Break time",
          `Focus session done - ${minutes} minute${minutes === 1 ? "" : "s"} to recharge.`,
          "kairil-pomodoro"
        );
      } else {
        const finishedLabel = pomodoroPhase === "longBreak" ? "Long break" : "Break";
        setPomodoroCycle(pomodoroPhase === "longBreak" ? 1 : (c) => c + 1);
        const started = await beginPomodoroWork();
        if (started) {
          notifyBrowser("Back to focus", `${finishedLabel} over - starting the next focus session.`, "kairil-pomodoro");
        }
      }
    } finally {
      transitioningRef.current = false;
    }
  };

  // Auto-advances the pomodoro phase once its countdown reaches zero.
  // advancePomodoroPhase is intentionally re-created each render (not
  // useCallback) so it always closes over the latest state; transitioningRef
  // stops it from firing more than once per phase.
  //
  // Guarded on `initializing`: a restored "work" phase (see the
  // loadPomodoroState() initializers above) can already be past its
  // phaseEndsAt on first render, before refetchSessions has populated
  // activeSession from the database. Advancing at that point would call
  // handleClockOut() while activeSession is still locally null - the
  // clock-out no-ops (its own guard is `if (... || !activeSession) return`),
  // so the phase would move on to a break while the actual work_sessions
  // row stays open in the database, orphaned. Waiting for initializing to
  // clear (and for the reconciliation effect above to run first) ensures
  // activeSession is trustworthy before any auto-advance can fire.
  useEffect(() => {
    if (initializing) return;
    if (!pomodoroPhase || !phaseEndsAt) return;
    if (now.getTime() < phaseEndsAt) return;
    advancePomodoroPhase();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, pomodoroPhase, phaseEndsAt, initializing]);

  const startPomodoro = () => {
    if (activeSession || pomodoroPhase || clockingIn) return;
    setPomodoroCycle(1);
    setShowPomodoroSetup(false);
    beginPomodoroWork();
  };

  const skipPomodoroPhase = () => {
    advancePomodoroPhase();
  };

  const stopPomodoro = async () => {
    if (pomodoroPhase === "work" && activeSession) {
      try {
        await handleClockOut();
      } catch {
        // already surfaced via clockError
      }
    }
    setPomodoroPhase(null);
    setPhaseEndsAt(null);
    setPomodoroCycle(1);
  };

  // Deliberately does NOT check `idle` here: this is called from
  // handleClockIn synchronously, before activeSession/pomodoroPhase have
  // been updated, so an idle-check at this point would be true on every
  // single clock-in and silently block the pop-out from ever auto-opening.
  // Staying idle-unaware here is safe because the two callers guard it
  // differently: the manual pop-out button disables itself while idle
  // (disabled={idle && !pipWindow}), and the effect above closes the
  // window automatically if a clock-in ultimately fails/is blocked and
  // the app is left idle with it still open.
  const openPip = async () => {
    if (!pipSupported || pipWindow) return;
    setPipNotice("");
    try {
      // Square by request - 150x180 was noticeably taller than it was wide.
      const pw = await window.documentPictureInPicture.requestWindow({ width: 180, height: 180 });
      // This app's global styles (fonts, keyframes, hover/disabled rules)
      // live in one <style> tag; everything else is inline styles, which
      // render correctly in any document without copying anything else.
      const styleTag = pw.document.createElement("style");
      styleTag.textContent = fontImport;
      pw.document.head.appendChild(styleTag);
      pw.document.title = "Studio Time \u2014 Kairil";
      Object.assign(pw.document.body.style, {
        margin: "0",
        minHeight: "100vh",
        background: ink,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      });
      pw.addEventListener("pagehide", () => setPipWindow(null), { once: true });
      setPipNotice("");
      setPipWindow(pw);
    } catch (err) {
      // requestWindow() can fail for reasons beyond "browser doesn't
      // support it": a blocked popup permission, a PiP window already open
      // elsewhere, or a platform restriction. Previously this was
      // console-only, so an automatic pop-out that failed looked like the
      // whole clock-in had failed - the session had in fact started fine,
      // the floating window just never appeared. Surface it as a plain
      // note, deliberately not as clockError: the session is not in an
      // error state and nothing needs retrying.
      console.error("Couldn't open the popup window:", err);
      setPipNotice("Floating timer couldn't be opened in this browser. Your session is still running.");
    }
  };

  const closePip = () => {
    if (pipWindow) pipWindow.close();
    setPipWindow(null);
  };

  const elapsedSeconds = activeSession
    ? Math.max(0, Math.floor((now - new Date(activeSession.clockIn)) / 1000))
    : 0;
  // Same "only count what actually happened today" clipping as
  // refetchSessions applies to completed sessions - a still-open session
  // that started before local midnight would otherwise have its full
  // (pre-midnight-inclusive) elapsed time folded into "Today so far".
  // elapsedSeconds itself stays uncapped since the big clock above it is a
  // stopwatch for the whole continuous session, not a "today" figure.
  const elapsedSecondsToday = activeSession
    ? Math.max(0, Math.floor((now - Math.max(new Date(activeSession.clockIn).getTime(), startOfLocalDay(now).getTime())) / 1000))
    : 0;

  let trackingContent;
  if (pomodoroPhase) {
    const phaseLabel = pomodoroPhase === "work" ? "Focus" : pomodoroPhase === "longBreak" ? "Long break" : "Break";
    const phaseRemaining = Math.max(0, Math.round((phaseEndsAt - now.getTime()) / 1000));
    const dotColor = pomodoroPhase === "work" ? "#3DDC84" : "#F2A65A";
    trackingContent = (
      <div>
        <div style={{ ...styles.studioTimeStatus, color: dotColor }}>
          <span style={{ ...styles.studioTimeStatusDot, background: dotColor, boxShadow: `0 0 6px ${dotColor}` }} />
          {phaseLabel} {"\u00b7"} Cycle {pomodoroCycle} of {pomodoroConfig.cyclesBeforeLongBreak}
        </div>
        <div style={styles.studioTimeValue}>{formatClockDuration(phaseRemaining)}</div>
        {clockError && <p style={{ ...styles.fieldHint, color: "#FF4D4D" }}>{clockError}</p>}
        <div style={styles.pomodoroControls}>
          <button type="button" style={styles.pomodoroSecondaryButton} onClick={skipPomodoroPhase}>
            Skip
          </button>
          <button type="button" style={styles.pomodoroSecondaryButton} onClick={() => stopPomodoro()}>
            Stop
          </button>
        </div>
      </div>
    );
  } else if (activeSession) {
    trackingContent = (
      <div>
        <div style={styles.studioTimeStatus}>
          <span style={styles.studioTimeStatusDot} />
          Working
        </div>
        {initializing ? (
          <div style={styles.studioTimeValue}>--:--:--</div>
        ) : (
          <>
            <div style={styles.studioTimeValue}>{formatClockDuration(elapsedSeconds)}</div>
            <p style={styles.fieldHint}>Today so far: {formatDayDuration(todaySeconds + elapsedSecondsToday)}</p>
          </>
        )}
        {clockError && <p style={{ ...styles.fieldHint, color: "#FF4D4D" }}>{clockError}</p>}
        <button
          type="button"
          style={{ ...styles.newButton, marginTop: 8, padding: "6px 12px", fontSize: 11.5 }}
          onClick={() => handleClockOut().catch(() => {})}
          disabled={clockingOut}
        >
          {clockingOut ? <SpinnerIcon size={13} /> : <ClockIcon />}
          Clock Out
        </button>
      </div>
    );
  } else {
    trackingContent = (
      <div>
        {initializing ? (
          <div style={styles.studioTimeValue}>--:--:--</div>
        ) : todaySeconds > 0 ? (
          <div style={styles.studioTimeValue}>{formatDayDuration(todaySeconds)}</div>
        ) : (
          <div style={styles.studioTimeValue}>00:00:00</div>
        )}
        {clockError && <p style={{ ...styles.fieldHint, color: "#FF4D4D" }}>{clockError}</p>}
        <div style={styles.studioTimeActionsRow}>
          <button
            type="button"
            style={{ ...styles.newButton, padding: "6px 12px", fontSize: 11.5 }}
            onClick={() => handleClockIn("manual").catch(() => {})}
            disabled={initializing || clockingIn}
          >
            {clockingIn ? <SpinnerIcon size={13} /> : <ClockIcon />}
            Clock In
          </button>
          <button
            type="button"
            style={{ ...styles.pomodoroLinkButton, fontSize: 11, padding: "6px 0" }}
            onClick={() => setShowPomodoroSetup((v) => !v)}
          >
            {showPomodoroSetup ? "Hide focus session setup" : "Start a focus session"}
          </button>
        </div>
        {showPomodoroSetup && (
          <PomodoroSetupForm config={pomodoroConfig} onChange={setPomodoroConfig} onStart={startPomodoro} busy={initializing || clockingIn} />
        )}
      </div>
    );
  }
  const phaseRemaining = pomodoroPhase ? Math.max(0, Math.round((phaseEndsAt - now.getTime()) / 1000)) : 0;

  // The pop-out window gets its own minimal content - just the number and
  // one action - rather than reusing `trackingContent` above. Portaling the
  // full card (status line, "Today so far", the idle setup grid) into a
  // small square window is what made the PiP feel oversized: the container
  // was sized to the timer but the content inside kept demanding card-sized
  // room. This is sized to actually fit a small square window with minimal
  // empty space around it.
  let pipTrackingContent;
  if (pomodoroPhase) {
    pipTrackingContent = (
      <div style={styles.pipInner}>
        <span style={styles.pipValue}>{formatClockDuration(phaseRemaining)}</span>
        <button type="button" style={styles.pipButton} onClick={() => stopPomodoro()}>
          Stop
        </button>
      </div>
    );
  } else if (activeSession) {
    pipTrackingContent = (
      <div style={styles.pipInner}>
        <span style={styles.pipValue}>{initializing ? "--:--:--" : formatClockDuration(elapsedSeconds)}</span>
        <button
          type="button"
          style={styles.pipButton}
          onClick={() => handleClockOut().catch(() => {})}
          disabled={clockingOut}
        >
          {clockingOut ? <SpinnerIcon size={13} /> : "Stop"}
        </button>
      </div>
    );
  } else {
    // Never actually renders - the effect above closes the pop-out the
    // moment there's nothing being tracked - but keeps this exhaustive
    // rather than leaving a gap the window could flash empty during.
    pipTrackingContent = (
      <div style={styles.pipInner}>
        <span style={styles.pipValue}>{formatDayDuration(todaySeconds)}</span>
      </div>
    );
  }

  const displayValue = initializing
    ? "--:--:--"
    : pomodoroPhase
    ? formatClockDuration(phaseRemaining)
    : activeSession
    ? formatClockDuration(elapsedSeconds)
    : todaySeconds > 0
    ? formatDayDuration(todaySeconds)
    : "00:00:00";
  const compactLabel = pomodoroPhase
    ? pomodoroPhase === "work"
      ? "Focus"
      : pomodoroPhase === "longBreak"
      ? "Long break"
      : "Break"
    : activeSession || todaySeconds === 0
    ? "Studio Time"
    : "Today's studio time";
  const compactBusy = clockingIn || clockingOut;
  return (
    <>
      {visible && (
      <div style={styles.studioTimeCompactWrap}>
      <div style={{ ...styles.studioTimeCompact, ...((activeSession || pomodoroPhase) ? styles.studioTimeCompactActive : {}) }}>
        {(activeSession || pomodoroPhase) && <span style={styles.studioTimeStatusDot} />}
        <span style={styles.dashboardGreetingCompactDate}>{compactLabel}</span>
        <span style={styles.studioTimeCompactValue}>{displayValue}</span>
        {pomodoroPhase ? (
          <>
            <button type="button" style={styles.dashboardCompactButton} onClick={skipPomodoroPhase}>
              Skip
            </button>
            <button
              type="button"
              style={{ ...styles.dashboardCompactButton, background: "transparent", border: `1px solid ${border}`, color: textMuted }}
              onClick={() => stopPomodoro()}
            >
              Stop
            </button>
          </>
        ) : (
          <button
            type="button"
            style={styles.dashboardCompactButton}
            onClick={activeSession ? () => handleClockOut().catch(() => {}) : () => handleClockIn("manual").catch(() => {})}
            disabled={initializing || compactBusy}
          >
            {compactBusy ? <SpinnerIcon size={13} /> : <ClockIcon />}
            {activeSession ? "Clock Out" : "Clock In"}
          </button>
        )}
        <button
          type="button"
          style={{ ...styles.iconButton, padding: 4 }}
          onClick={() => setShowSummary(true)}
          title="Weekly & monthly summary"
          aria-label="Weekly & monthly summary"
        >
          <ChartIcon />
        </button>
        {pipSupported && (
          <button
            type="button"
            style={{ ...styles.iconButton, padding: 4, opacity: idle && !pipWindow ? 0.4 : 1 }}
            onClick={pipWindow ? closePip : openPip}
            disabled={idle && !pipWindow}
            title={pipWindow ? "Bring back to page" : idle ? "Clock in or start a focus session to pop out" : "Pop out as a floating window"}
            aria-label={pipWindow ? "Bring back to page" : idle ? "Clock in or start a focus session to pop out" : "Pop out as a floating window"}
          >
            <PopOutIcon />
          </button>
        )}
        {idle && (
          <button
            type="button"
            style={{ ...styles.pomodoroLinkButton, fontSize: 11, padding: 0, whiteSpace: "nowrap" }}
            onClick={() => setShowPomodoroSetup((v) => !v)}
          >
            {showPomodoroSetup ? "Hide focus session setup" : "Start a focus session"}
          </button>
        )}
      </div>
      {clockError && <span style={{ ...styles.fieldHint, color: "#FF4D4D", fontSize: 11 }}>{clockError}</span>}
      {pipNotice && <span style={{ ...styles.fieldHint, color: "#F2A65A", fontSize: 11 }}>{pipNotice}</span>}
      {idle && showPomodoroSetup && (
        <PomodoroSetupForm config={pomodoroConfig} onChange={setPomodoroConfig} onStart={startPomodoro} busy={initializing || clockingIn} />
      )}
      </div>
      )}
      {pipWindow && createPortal(<div style={styles.pipContent}>{pipTrackingContent}</div>, pipWindow.document.body)}
      {showSummary && <StudioTimeSummaryModal userId={userId} onClose={() => setShowSummary(false)} />}
    </>
  );
}

// Phase 12 — lightweight portfolio analytics computed straight from the
// user's own planner data. No dashboard, just the numbers the spec asks for.
function computePlannerPortfolioAnalytics(plans) {
  if (plans.length === 0) {
    return { totalPlannedValue: 0, averageMargin: 0, averageProductionCost: 0, convertedCount: 0, winRate: null };
  }
  let totalPlannedValue = 0;
  let totalMargin = 0;
  let totalProductionCost = 0;
  let convertedCount = 0;
  let sentOrLater = 0;
  let approvedOrConverted = 0;
  plans.forEach((plan) => {
    const calc = computeBudgetPlan(plan);
    totalPlannedValue += calc.budget;
    totalMargin += calc.profitPercent;
    totalProductionCost += calc.productionBudget;
    if (plan.status === "converted") convertedCount += 1;
    if (["proposal_sent", "negotiating", "approved", "rejected", "converted"].includes(plan.status)) sentOrLater += 1;
    if (["approved", "converted"].includes(plan.status)) approvedOrConverted += 1;
  });
  return {
    totalPlannedValue,
    averageMargin: totalMargin / plans.length,
    averageProductionCost: totalProductionCost / plans.length,
    convertedCount,
    winRate: sentOrLater > 0 ? (approvedOrConverted / sentOrLater) * 100 : null,
  };
}

// Shared by DashboardPanel's "Needs Attention" card and the top-level
// browser-notification digest, so the two can never quietly drift into
// different definitions of what counts as needing attention.
function computeNeedsAttentionCounts(leads, schedule) {
  const activeNonArchived = leads.filter((l) => !l.archivedAt);
  const followupsDueToday = activeNonArchived.filter((l) => computeFollowupStatus(l, schedule).isDue).length;
  const hotAwaitingResponse = activeNonArchived.filter(
    (l) => l.priority === "hot" && l.stage === "cold_email"
  ).length;
  const proposalsAwaitingResponse = activeNonArchived.filter((l) => l.stage === "proposal").length;
  const approachingDeadline = activeNonArchived.filter((l) => {
    const s = computeFollowupStatus(l, schedule);
    return !s.isDue && s.daysUntilDue != null && s.daysUntilDue <= 2;
  }).length;
  return { followupsDueToday, hotAwaitingResponse, proposalsAwaitingResponse, approachingDeadline };
}

function DashboardPanel({ projects, cards, leads, invoices, settings, fxRates, onOpenProject, onGoToProjects, onGoToLeads, user, userId }) {
  const stats = computeDashboardStats(projects, cards, leads, invoices, fxRates);
  const cur = "$"; // Dashboard totals are always USD-converted for cross-project consistency
  const schedule = settings.followupSchedule || DEFAULT_FOLLOWUP_SCHEDULE;
  // Scopes the "Cold email success rate" card's funnel (Sent/Responded/
  // Qualified/Won/Lost/No response) and both rate figures. Defaults to
  // "All time" so the card doesn't silently shrink on first load.
  const [dashboardPeriod, setDashboardPeriod] = useState("all");

  const statItems = [
    { label: "Active projects", value: stats.activeProjectsCount, sub: `${stats.projectsCompleted} completed`, icon: <FolderIcon />, color: teal, onClick: onGoToProjects },
    { label: "Active leads", value: stats.activeLeadsCount, icon: <TargetIcon />, color: "#4A90D9", onClick: () => onGoToLeads() },
    { label: "Total shots", value: stats.totalShots, icon: <ClapperIcon />, color: "#9B8AD8" },
    { label: "Deals won", value: stats.dealsWon, icon: <CheckCircleIcon />, color: "#3DDC84", onClick: () => onGoToLeads({ status: "won" }) },
    { label: "Deals lost", value: stats.dealsLost, icon: <XCircleIcon />, color: "#FF4D4D", onClick: () => onGoToLeads({ status: "lost" }) },
    {
      label: "Revenue this month",
      value: `${cur}${formatMoney(stats.revenueThisMonth)}`,
      icon: <InvoiceIcon />,
      color: "#3DDC84",
      delta: stats.revenueDelta,
    },
    {
      label: "Outstanding invoices",
      value: `${stats.outstandingCount} \u00b7 ${cur}${formatMoney(stats.outstandingTotal)}`,
      icon: <InvoiceIcon />,
      color: "#F2A65A",
    },
  ];

  const shotsByStage = STAGES.map((s) => ({
    label: s.label,
    value: cards.filter((c) => c.stage === s.id).length,
  }));

  // Active-outreach breakdown deliberately excludes the untouched pool and
  // every terminal outcome, per the "active outreach" definition: leads
  // that have actually been contacted and haven't resolved yet.
  const activeOutreachLeads = leads.filter((l) => !l.archivedAt && ACTIVE_OUTREACH_STAGE_IDS.includes(l.stage));
  const leadsByActiveStage = ACTIVE_OUTREACH_STAGE_IDS.map((id) => ({
    label: LEAD_STAGES.find((s) => s.id === id)?.label || id,
    value: activeOutreachLeads.filter((l) => l.stage === id).length,
  }));

  // "Leads by channel" only shows channels the studio hasn't switched off in
  // Settings > Lead channels. Hiding is presentation-only: the channel stays
  // selectable on leads and still works as a filter chip on the CRM board,
  // and hiding it never changes any other figure on this dashboard.
  const studioChannels = settings.leadChannels || DEFAULT_LEAD_CHANNELS;
  const hiddenChannels = settings.dashboardHiddenChannels || [];
  const leadsByChannel = studioChannels
    .filter((channel) => !hiddenChannels.includes(channel))
    .map((channel) => ({
      label: channel,
      value: leads.filter((l) => l.channel === channel && !l.archivedAt).length,
    }));
  const allChannelsHidden = studioChannels.length > 0 && studioChannels.every((c) => hiddenChannels.includes(c));

  const now = new Date();
  const periodDays = DASHBOARD_PERIOD_OPTIONS.find((p) => p.id === dashboardPeriod)?.days ?? null;
  const inPeriod = (dateStr) => isWithinDashboardPeriod(dateStr, periodDays, now);

  // Every funnel figure except "Sent" is event-based: it counts leads with a
  // matching stage-change entry in the activity log inside the selected
  // window, not leads currently sitting in that stage. Two reasons. First, a
  // current-stage snapshot carries no date, so there's nothing for a range
  // filter to filter on. Second, it double-counts and drops depending on
  // where a lead ended up - "Qualified" used to mean "at or beyond
  // qualified", so a lead that qualified and then lost vanished from the
  // qualified count entirely. Event-based counting is also what the Outreach
  // performance chart below already does per month, so the card and the
  // chart can no longer disagree. Archived leads are included throughout, so
  // archiving a resolved lead never rewrites history.
  const coldEmailsSentTotal = leads.filter((l) => l.emails?.[0]?.sent && inPeriod(l.emails[0].dateSent)).length;
  const respondedTotal = leads.filter((l) => hadStageEvent(l, "responded", inPeriod)).length;
  const qualifiedTotal = leads.filter((l) => hadStageEvent(l, "qualified", inPeriod)).length;
  const wonTotal = leads.filter((l) => hadStageEvent(l, "won", inPeriod)).length;
  const lostTotal = leads.filter((l) => hadStageEvent(l, "lost", inPeriod)).length;
  const noResponseTotal = leads.filter((l) => hadStageEvent(l, "no_response", inPeriod)).length;

  // A cold email "succeeding" is really about getting a reply - that's what
  // the email itself controls, while closing the deal also depends on
  // pricing, qualification and negotiation. So response rate is the headline
  // and win rate sits beside it, rather than win rate alone standing in for
  // the whole picture (which reads 0% for a campaign pulling steady replies).
  const responseRate = coldEmailsSentTotal > 0 ? (respondedTotal / coldEmailsSentTotal) * 100 : 0;
  const winRate = coldEmailsSentTotal > 0 ? (wonTotal / coldEmailsSentTotal) * 100 : 0;

  // Today's figures always mean today, independent of whichever period is
  // selected above - they answer "what came in today", not "today, within
  // the selected window".
  const newLeadsToday = leads.filter((l) => isToday(l.createdAt, now)).length;
  const coldEmailsSentToday = leads.filter((l) => l.emails?.[0]?.sent && isToday(l.emails[0].dateSent, now)).length;
  // Today's cold-email success, measured the same way as the headline
  // response rate above: replies received, not deals closed. Uses the same
  // event source (a logged `responded` stage change) and the same
  // isToday() window as the two figures beside it, so the row stays
  // internally consistent.
  //
  // Both halves are same-day counts, so on any given day they describe
  // today's activity rather than tracing one email through to its own
  // reply - a reply today usually answers an email sent days ago. That's
  // the intended reading of a daily campaign figure; the period-filtered
  // funnel above is where cohort-style rates live.
  const respondedToday = leads.filter((l) => hadStageEvent(l, "responded", (ts) => isToday(ts, now))).length;
  const successRateToday = coldEmailsSentToday > 0 ? (respondedToday / coldEmailsSentToday) * 100 : null;

  // Needs Attention: a handful of counts that point at something the user
  // should actually act on today, each clickable straight into a filtered
  // view of the Leads board.
  const { followupsDueToday, hotAwaitingResponse, proposalsAwaitingResponse, approachingDeadline } =
    computeNeedsAttentionCounts(leads, schedule);

  const needsAttentionItems = [
    followupsDueToday > 0 && {
      label: `${followupsDueToday} follow-up${followupsDueToday === 1 ? "" : "s"} due today`,
      onClick: () => onGoToLeads({ followup: "due" }),
    },
    hotAwaitingResponse > 0 && {
      label: `${hotAwaitingResponse} hot lead${hotAwaitingResponse === 1 ? "" : "s"} awaiting response`,
      onClick: () => onGoToLeads({ priority: "hot", status: "cold_email" }),
    },
    proposalsAwaitingResponse > 0 && {
      label: `${proposalsAwaitingResponse} proposal${proposalsAwaitingResponse === 1 ? "" : "s"} awaiting response`,
      onClick: () => onGoToLeads({ status: "proposal" }),
    },
    approachingDeadline > 0 && {
      label: `${approachingDeadline} lead${approachingDeadline === 1 ? "" : "s"} approaching follow-up deadline`,
      onClick: () => onGoToLeads({ followup: "upcoming" }),
    },
  ].filter(Boolean);

  const months = lastSixMonthKeys();
  const revenueTrend = months.map(({ key, label }) => ({
    label,
    value: invoices
      .filter((inv) => inv.status === "paid" && monthKey(inv.paidDate) === key)
      .reduce((sum, inv) => sum + convertToUSD(inv.amountPaid, inv.currency, fxRates), 0),
  }));

  // Outreach-over-time uses each email's own sent date (not the lead's
  // current stage) so a lead that later moved to Lost still counts toward
  // the month it was actually emailed, responded to, etc.
  const outreachTrend = months.map(({ key, label }) => {
    const inMonth = (ts) => monthKey(ts) === key;
    const coldEmails = leads.filter((l) => l.emails?.[0]?.sent && monthKey(l.emails[0].dateSent) === key).length;
    const responded = leads.filter((l) => hadStageEvent(l, "responded", inMonth)).length;
    const won = leads.filter((l) => hadStageEvent(l, "won", inMonth)).length;
    const lost = leads.filter((l) => hadStageEvent(l, "lost", inMonth)).length;
    const noResponse = leads.filter((l) => hadStageEvent(l, "no_response", inMonth)).length;
    return { label, "Cold Emails": coldEmails, Responded: responded, Won: won, Lost: lost, "No Response": noResponse };
  });

  return (
    <div style={styles.dashboardShell}>
      <div style={styles.dashboardTopStrip}>
        <DashboardGreeting user={user} compact />
      </div>

      <div style={styles.dashboardKpiStrip}>
        {statItems.map((item) => (
          <div
            key={item.label}
            className="kf-card"
            style={{ ...styles.dashboardKpiTile, cursor: item.onClick ? "pointer" : "default" }}
            onClick={item.onClick}
          >
            <div style={styles.dashboardKpiTop}>
              <div style={{ ...styles.dashboardKpiIcon, color: item.color, background: `${item.color}1f` }}>
                {item.icon}
              </div>
              {item.delta !== undefined && item.delta !== null && (
                <span style={{ ...styles.dashboardDelta, color: item.delta >= 0 ? "#3DDC84" : "#FF4D4D" }}>
                  <TrendIcon direction={item.delta >= 0 ? "up" : "down"} />
                  {Math.abs(item.delta)}%
                </span>
              )}
            </div>
            <span style={styles.dashboardKpiValue}>{item.value}</span>
            <span style={styles.dashboardKpiLabel}>
              {item.label}
              {item.sub && <span style={styles.dashboardKpiSub}> · {item.sub}</span>}
            </span>
          </div>
        ))}
      </div>

      <div style={styles.dashboardMainGrid}>
        {/* Column A — trends */}
        <div style={styles.dashboardCol}>
          <div className="kf-card" style={styles.dashboardCard}>
            <div style={styles.dashboardCardHeaderRow}>
              <span style={styles.dashboardCardHeader}>Revenue trend</span>
              <span style={styles.dashboardCardHeaderHint}>6 months · USD</span>
            </div>
            <div style={styles.dashboardChartFill}>
              <RevenueTrendChart data={revenueTrend} currencySymbol={cur} height="100%" compact />
            </div>
          </div>
          <div className="kf-card" style={styles.dashboardCard}>
            <div style={styles.dashboardCardHeaderRow}>
              <span style={styles.dashboardCardHeader}>Outreach performance</span>
              <span style={styles.dashboardCardHeaderHint}>6 months</span>
            </div>
            <div style={styles.dashboardChartFill}>
              <LeadOutreachTrendChart data={outreachTrend} height="100%" compact />
            </div>
          </div>
        </div>

        {/* Column B — pipeline snapshot */}
        <div style={styles.dashboardCol}>
          <div className="kf-card" style={{ ...styles.dashboardCard, overflowY: "auto" }} onClick={() => onGoToLeads()}>
            <div style={styles.dashboardCardHeaderRow}>
              <span style={styles.dashboardCardHeader}>Cold email success rate</span>
              <select
                style={styles.dashboardPeriodSelect}
                value={dashboardPeriod}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => {
                  e.stopPropagation();
                  setDashboardPeriod(e.target.value);
                }}
              >
                {DASHBOARD_PERIOD_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div style={styles.dashboardRateRow}>
              <span style={styles.dashboardSuccessBig}>{responseRate.toFixed(1)}%</span>
              <span style={styles.dashboardKpiSub}>response rate</span>
              <span style={styles.dashboardWinRateBadge}>{winRate.toFixed(1)}% win rate</span>
            </div>
            <p style={styles.dashboardCardHeaderHint}>
              {respondedTotal} response{respondedTotal === 1 ? "" : "s"} and {wonTotal} win{wonTotal === 1 ? "" : "s"} from{" "}
              {coldEmailsSentTotal} cold email{coldEmailsSentTotal === 1 ? "" : "s"}
            </p>
            <div style={styles.dashboardMiniFunnelGrid}>
              <div style={styles.dashboardMiniFunnelItem}><span style={styles.dashboardKpiSub}>Sent</span><strong>{coldEmailsSentTotal}</strong></div>
              <div style={styles.dashboardMiniFunnelItem}><span style={styles.dashboardKpiSub}>Responded</span><strong>{respondedTotal}</strong></div>
              <div style={styles.dashboardMiniFunnelItem}><span style={styles.dashboardKpiSub}>Qualified</span><strong>{qualifiedTotal}</strong></div>
              <div style={styles.dashboardMiniFunnelItem}><span style={styles.dashboardKpiSub}>Won</span><strong style={{ color: "#3DDC84" }}>{wonTotal}</strong></div>
              <div style={styles.dashboardMiniFunnelItem}><span style={styles.dashboardKpiSub}>Lost</span><strong style={{ color: "#FF4D4D" }}>{lostTotal}</strong></div>
              <div style={styles.dashboardMiniFunnelItem}><span style={styles.dashboardKpiSub}>No response</span><strong>{noResponseTotal}</strong></div>
            </div>
            <div style={styles.dashboardTodayRow}>
              <span style={styles.dashboardTodayLabel}>Today</span>
              <span style={styles.dashboardKpiSub}>{newLeadsToday} new lead{newLeadsToday === 1 ? "" : "s"}</span>
              <span style={styles.dashboardKpiSub}>{coldEmailsSentToday} cold email{coldEmailsSentToday === 1 ? "" : "s"} sent</span>
              <span style={styles.dashboardKpiSub}>{respondedToday} response{respondedToday === 1 ? "" : "s"}</span>
              <span style={styles.dashboardKpiSub}>
                {successRateToday === null ? "\u2014" : `${successRateToday.toFixed(0)}%`} success
              </span>
            </div>
          </div>
          <div className="kf-card" style={styles.dashboardCard}>
            <div style={styles.dashboardCardHeaderRow}>
              <span style={styles.dashboardCardHeader}>Pipeline breakdown</span>
              {hiddenChannels.length > 0 && (
                <span style={styles.dashboardCardHeaderHint}>
                  {hiddenChannels.length} channel{hiddenChannels.length === 1 ? "" : "s"} hidden
                </span>
              )}
            </div>
            <div style={styles.dashboardDonutRow}>
              <DonutBreakdown data={shotsByStage} emptyLabel="No shots yet." centerLabel="Shots" size={88} compact />
              <DonutBreakdown data={leadsByActiveStage} emptyLabel="No active outreach." centerLabel="Leads" size={88} compact />
              <DonutBreakdown
                data={leadsByChannel}
                emptyLabel={allChannelsHidden ? "All channels hidden (Settings)." : "No channels tagged."}
                centerLabel="Leads"
                size={88}
                compact
              />
            </div>
          </div>
        </div>

        {/* Column C — attention & deadlines */}
        <div style={styles.dashboardCol}>
          <div className="kf-card" style={styles.dashboardCard}>
            <div style={styles.dashboardCardHeaderRow}>
              <span style={styles.dashboardCardHeader}><BellIcon /> Needs attention</span>
              {needsAttentionItems.length > 0 && <span style={styles.dashboardCardHeaderHint}>{needsAttentionItems.length}</span>}
            </div>
            <div style={styles.dashboardScrollList}>
              {needsAttentionItems.length === 0 ? (
                <p style={styles.dashboardEmptyState}>You're all caught up.</p>
              ) : (
                needsAttentionItems.map((item) => (
                  <button key={item.label} type="button" style={styles.dashboardNotifRow} onClick={item.onClick}>
                    {item.label}
                  </button>
                ))
              )}
            </div>
          </div>
          <div className="kf-card" style={styles.dashboardCard}>
            <div style={styles.dashboardCardHeaderRow}>
              <span style={styles.dashboardCardHeader}><CalendarIcon /> Near deadline</span>
              {stats.nearDeadline.length > 0 && <span style={styles.dashboardCardHeaderHint}>{stats.nearDeadline.length}</span>}
            </div>
            <div style={styles.dashboardScrollList}>
              {stats.nearDeadline.length === 0 ? (
                <p style={styles.dashboardEmptyState}>Nothing due in the next 7 days.</p>
              ) : (
                stats.nearDeadline.map((p) => (
                  <div key={p.id} style={styles.dashboardDeadlineRow} onClick={() => onOpenProject(p.id)}>
                    <span style={styles.dashboardDeadlineName}>{p.name}</span>
                    {p.client && <span style={styles.dashboardKpiSub}>{p.client}</span>}
                    <span style={styles.dashboardDeadlineDate}>{p.deadline}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      <p style={styles.dashboardFooterHint}>
        Dollar figures are converted live to USD. For accounts receivable, per-project profitability, and client value, see Finance.
      </p>
    </div>
  );
}

const TUTORIAL_STEPS = [
  {
    title: "Welcome to Kairil",
    body: "A production and client management system built for Studio Kairegi, from first contact with a client through delivery and payment. This quick walkthrough covers the pieces you'll use most.",
    targetTab: "dashboard",
  },
  {
    title: "Dashboard",
    body: "Your home base. Active projects, leads, revenue this month, and charts for shots by stage and revenue trend, all at a glance. Tap any tile to jump straight to that area.",
    targetTab: "dashboard",
  },
  {
    title: "Projects & shots",
    body: "Create a project and optionally generate a starting checklist of shots automatically. Drag shots across the pipeline as work progresses, each one tracks review status, revisions, and file versioning.",
    targetTab: "projects",
  },
  {
    title: "Leads (CRM)",
    body: "Track outreach through New, Cold Email Sent, Responded, Qualified, Proposal, and Negotiation. Mark a deal Won and Kairil pre-fills a new project from that lead, no retyping client details.",
    targetTab: "leads",
  },
  {
    title: "Invoicing & Finance",
    body: "Create invoices per project, generate a 50/25/25 milestone split in one tap, and log expenses. Finance rolls everything up into USD automatically, even across projects billed in different currencies.",
    targetTab: "finance",
  },
  {
    title: "Client & freelancer links",
    body: "Every project can generate a read-only progress link for clients, no login needed. Every shot can generate a link for the assigned freelancer to view the brief, download files, and upload their work back.",
    targetTab: "projects",
  },
  {
    title: "Settings",
    body: "Set your studio name and logo, default currency, default milestone split, and where you land when you open the app. You can replay this tutorial any time from here.",
    targetTab: "settings",
  },
];

function ProUpgradePrompt({ feature, inline }) {
  const content = (
    <>
      <div style={styles.proLockIcon}>
        <LockIcon />
      </div>
      <p style={{ fontSize: 14, fontWeight: 600, color: paper, margin: 0 }}>{feature} is a Pro feature</p>
      <p style={{ ...styles.fieldHint, textAlign: "center", maxWidth: 320 }}>
        Kairil Pro unlocks this along with the rest of the studio toolkit.
      </p>
      <a href={PATREON_CHECKOUT_URL} target="_blank" rel="noreferrer" style={styles.newButton}>
        Upgrade with Patreon
      </a>
      <p style={{ ...styles.fieldHint, fontSize: 12 }}>
        Already subscribed? Connect Patreon in Settings to unlock it.
      </p>
    </>
  );
  if (inline) {
    return <div style={{ ...styles.proLockWrap, padding: "16px 0" }}>{content}</div>;
  }
  return <div style={styles.proLockWrap}>{content}</div>;
}

function SupportModal({ email, onSubmit, onCancel }) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const handleSend = async () => {
    if (!message.trim()) return;
    setSending(true);
    setError("");
    try {
      await onSubmit(message.trim());
      setSent(true);
    } catch (e) {
      setError("Couldn't send that, please try again or email support@kairil.studiokairegi.com directly.");
    }
    setSending(false);
  };

  return (
    <div style={styles.overlay} onClick={onCancel}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <span style={styles.modalTitle}>{sent ? "Message sent" : "Report a problem"}</span>
          <button style={styles.iconButton} onClick={onCancel}>
            <CloseIcon />
          </button>
        </div>

        {sent ? (
          <p style={{ fontSize: 14, lineHeight: 1.6, color: paper, margin: 0 }}>
            Thanks, that's been sent through. If it's urgent, you can also reach out directly at
            support@kairil.studiokairegi.com.
          </p>
        ) : (
          <>
            <p style={styles.fieldHint}>
              Tell us what happened, we'll see it against your account ({email}) along with which part of the
              app you were in.
            </p>
            <textarea
              style={styles.textarea}
              rows={5}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="What went wrong, or what would you like to see?"
              autoFocus
            />
            {error && <p style={{ ...styles.fieldHint, color: "#FF4D4D" }}>{error}</p>}
          </>
        )}

        <div style={styles.modalFooter}>
          <button style={styles.cancelButton} onClick={onCancel}>
            {sent ? "Close" : "Cancel"}
          </button>
          <div style={{ flex: 1 }} />
          {!sent && (
            <button style={styles.saveButton} onClick={handleSend} disabled={sending || !message.trim()}>
              {sending ? "Sending..." : "Send"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function TutorialModal({ onComplete, onStepChange }) {
  const [step, setStep] = useState(0);
  const isLast = step === TUTORIAL_STEPS.length - 1;
  const current = TUTORIAL_STEPS[step];

  useEffect(() => {
    onStepChange?.(current.targetTab);
  }, [step]);

  return (
    <div style={styles.overlay}>
      <div style={{ ...styles.modal, maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <span style={styles.modalTitle}>{current.title}</span>
          <button style={styles.iconButton} onClick={onComplete}>
            <CloseIcon />
          </button>
        </div>

        <p style={{ fontSize: 14, lineHeight: 1.6, color: paper, margin: 0 }}>{current.body}</p>

        <div style={{ display: "flex", justifyContent: "center", gap: 6, marginTop: 4 }}>
          {TUTORIAL_STEPS.map((_, i) => (
            <span
              key={i}
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: i === step ? teal : border,
              }}
            />
          ))}
        </div>

        <div style={styles.modalFooter}>
          {step > 0 ? (
            <button style={styles.cancelButton} onClick={() => setStep(step - 1)}>
              Back
            </button>
          ) : (
            <button style={styles.cancelButton} onClick={onComplete}>
              Skip
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button
            style={styles.saveButton}
            onClick={() => (isLast ? onComplete() : setStep(step + 1))}
          >
            {isLast ? "Get started" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SettingsPage({ settings, email, driveEmail, onConnectDrive, patreonEmail, patreonIsPro, patreonConnected, onConnectPatreon, onReplayTutorial, onOpenSupport, onSave }) {
  const [form, setForm] = useState(settings);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  const [notificationPermission, setNotificationPermission] = useState(
    notificationsSupported() ? Notification.permission : "unsupported"
  );
  const handleEnableNotifications = async () => {
    if (!notificationsSupported()) return;
    const result = await Notification.requestPermission();
    setNotificationPermission(result);
    if (result === "granted") {
      notifyBrowser("Notifications enabled", "Kairil will let you know about Pomodoro breaks and CRM follow-ups.", "kairil-test");
    }
  };
  const setMilestone = (i) => (e) => {
    const next = [...form.milestoneDefaults];
    next[i] = e.target.value;
    setForm({ ...form, milestoneDefaults: next });
  };

  const [newChannel, setNewChannel] = useState("");
  const channels = form.leadChannels || DEFAULT_LEAD_CHANNELS;
  const addChannel = () => {
    const trimmed = newChannel.trim();
    if (!trimmed) return;
    if (channels.some((c) => c.toLowerCase() === trimmed.toLowerCase())) {
      setNewChannel("");
      return;
    }
    setForm({ ...form, leadChannels: [...channels, trimmed] });
    setNewChannel("");
  };
  const removeChannel = (channel) => {
    setForm({ ...form, leadChannels: channels.filter((c) => c !== channel) });
  };
  // Dashboard visibility per channel. Stores the *hidden* set rather than the
  // visible one, so a newly added channel shows up on the dashboard by
  // default instead of silently disappearing until it's opted back in.
  const hiddenChannels = form.dashboardHiddenChannels || [];
  const toggleChannelDashboardVisibility = (channel) => {
    const next = hiddenChannels.includes(channel)
      ? hiddenChannels.filter((c) => c !== channel)
      : [...hiddenChannels, channel];
    setForm({ ...form, dashboardHiddenChannels: next });
  };

  const [supportMessages, setSupportMessages] = useState(null);
  const [loadingInbox, setLoadingInbox] = useState(false);
  const loadSupportInbox = async () => {
    setLoadingInbox(true);
    const { data } = await supabase
      .from("support_messages")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(30);
    setSupportMessages(data || []);
    setLoadingInbox(false);
  };

  return (
    <div style={styles.settingsPageWrap}>
      <div style={styles.settingsGrid}>
        <div style={styles.settingsSection}>
          <h2 style={styles.settingsSectionTitle}>Account</h2>
          <div style={styles.field}>
            <label style={styles.label}>Account email</label>
            <p style={styles.fieldHint}>{email}</p>
          </div>

          <div style={styles.field}>
            <label style={styles.label}>Plan</label>
            {settings.isAdmin ? (
              <p style={{ ...styles.fieldHint, color: "#3DDC84" }}>{"\ud83d\udc51"} Admin {"\u2014"} full access</p>
            ) : settings.plan === "pro" ? (
              <p style={{ ...styles.fieldHint, color: "#3DDC84" }}>Pro</p>
            ) : (
              <>
                <p style={styles.fieldHint}>Free</p>
                <p style={styles.fieldHint}>
                  Teams, Client Portal, Freelancer links, milestones, and multiple currencies are Pro features.
                  Free accounts are also limited to {FREE_PROJECT_LIMIT} active projects.
                </p>
              </>
            )}
          </div>

          <div style={styles.field}>
            <label style={styles.label}>Patreon</label>
            {settings.isAdmin ? (
              <p style={styles.fieldHint}>
                {patreonConnected ? `Connected${patreonEmail ? ` as ${patreonEmail}` : ""}` : "Not connected"}, admin
                override enabled so this doesn't affect your access either way.
              </p>
            ) : !patreonConnected ? (
              <>
                <p style={styles.fieldHint}>
                  Connect your Patreon account to unlock Pro automatically if you're subscribed to the Pro tier.
                </p>
                <button type="button" style={styles.addRevisionButton} onClick={onConnectPatreon}>
                  Connect Patreon
                </button>
              </>
            ) : patreonIsPro ? (
              <>
                <p style={{ ...styles.fieldHint, color: "#3DDC84" }}>
                  {"\u2713"} Connected{patreonEmail ? ` as ${patreonEmail}` : ""} {"\u00b7"} Pro member
                </p>
                <a
                  href={PATREON_MANAGE_URL}
                  target="_blank"
                  rel="noreferrer"
                  style={{ ...styles.fieldHint, color: teal }}
                >
                  Manage membership on Patreon
                </a>
              </>
            ) : (
              <>
                <p style={styles.fieldHint}>
                  Connected{patreonEmail ? ` as ${patreonEmail}` : ""}, not currently subscribed to Pro.
                </p>
                <div style={styles.fieldRow}>
                  <a href={PATREON_CHECKOUT_URL} target="_blank" rel="noreferrer" style={styles.newButton}>
                    Become a Patron
                  </a>
                  <button type="button" style={styles.addRevisionButton} onClick={onConnectPatreon}>
                    Refresh status
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        <div style={styles.settingsSection}>
          <h2 style={styles.settingsSectionTitle}>Studio branding</h2>
          <div style={styles.field}>
            <label style={styles.label}>Studio name</label>
            <input style={styles.input} value={form.studioName} onChange={set("studioName")} />
          </div>

          <div style={styles.field}>
            <label style={styles.label}>Studio tagline</label>
            <input style={styles.input} value={form.studioTagline} onChange={set("studioTagline")} />
            <p style={styles.fieldHint}>Shown on generated invoice PDFs.</p>
          </div>

          <div style={styles.field}>
            <label style={styles.label}>Legal name (optional)</label>
            <input
              style={styles.input}
              value={form.studioLegalName || ""}
              onChange={set("studioLegalName")}
              placeholder="e.g. registered business name"
            />
            <p style={styles.fieldHint}>
              Used on invoice headers instead of the studio name above, if set.
            </p>
          </div>

          <div style={styles.field}>
            <label style={styles.label}>Studio address (optional)</label>
            <textarea
              style={{ ...styles.input, minHeight: 60, resize: "vertical" }}
              value={form.studioAddress || ""}
              onChange={set("studioAddress")}
            />
          </div>

          <div style={styles.field}>
            <label style={styles.label}>Tax ID / VAT number (optional)</label>
            <input
              style={styles.input}
              value={form.studioTaxId || ""}
              onChange={set("studioTaxId")}
            />
          </div>

          <div style={styles.field}>
            <label style={styles.label}>VAT status (optional)</label>
            <input
              style={styles.input}
              value={form.studioVatStatus || ""}
              onChange={set("studioVatStatus")}
              placeholder="e.g. VAT registered / exempt"
            />
          </div>

          <div style={styles.field}>
            <label style={styles.label}>eTIMS number (optional)</label>
            <input
              style={styles.input}
              value={form.studioEtimsNumber || ""}
              onChange={set("studioEtimsNumber")}
            />
          </div>

          <div style={styles.field}>
            <label style={styles.label}>Currency symbol</label>
            <input
              style={{ ...styles.input, maxWidth: 80 }}
              value={form.currencySymbol}
              onChange={set("currencySymbol")}
            />
            <p style={styles.fieldHint}>
              Used as the studio default. Projects and invoices can pick their own currency too.
            </p>
          </div>

          <div style={styles.field}>
            <label style={styles.label}>Studio logo URL (optional)</label>
            <input
              style={styles.input}
              value={form.logoUrl || ""}
              onChange={set("logoUrl")}
              placeholder="https://..."
            />
            <p style={styles.fieldHint}>
              A direct link to your logo image. Shown on the client portal.
            </p>
          </div>
        </div>

        <div style={styles.settingsSection}>
          <h2 style={styles.settingsSectionTitle}>Defaults</h2>
          <div style={styles.fieldRow}>
            <div style={styles.field}>
              <label style={styles.label}>Default landing tab</label>
              <select style={styles.input} value={form.defaultLandingTab} onChange={set("defaultLandingTab")}>
                <option value="dashboard">Dashboard</option>
                <option value="projects">Projects</option>
                <option value="leads">Leads</option>
                <option value="finance">Finance</option>
              </select>
            </div>
            <div style={styles.field}>
              <label style={styles.label}>Default shot priority</label>
              <select
                style={styles.input}
                value={form.defaultShotPriority}
                onChange={set("defaultShotPriority")}
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="rush">Rush</option>
              </select>
            </div>
          </div>

          <div style={styles.field}>
            <label style={styles.label}>Default milestone split (%)</label>
            <div style={styles.fieldRow}>
              {form.milestoneDefaults.map((val, i) => (
                <input
                  key={i}
                  style={styles.input}
                  type="number"
                  min="0"
                  max="100"
                  value={val}
                  onChange={setMilestone(i)}
                />
              ))}
            </div>
            <p style={styles.fieldHint}>
              Upfront / Mid-project / Delivery. Used as the starting point on "Set up milestones."
            </p>
          </div>
        </div>

        <div style={styles.settingsSection}>
          <h2 style={styles.settingsSectionTitle}>Lead channels</h2>
          <div style={styles.field}>
            <div style={styles.lostReasonGrid}>
              {channels.map((channel) => {
                const isHidden = hiddenChannels.includes(channel);
                return (
                  <span key={channel} style={{ ...styles.fileNameRow, ...styles.cardTag, gap: 6, padding: "5px 6px 5px 12px" }}>
                    {channel}
                    <button
                      type="button"
                      title={isHidden ? "Hidden from the Dashboard breakdown — click to show" : "Shown on the Dashboard breakdown — click to hide"}
                      style={{
                        ...styles.copyButton,
                        padding: "2px 8px",
                        fontSize: 10,
                        color: isHidden ? textMuted : teal,
                        borderColor: isHidden ? border : teal,
                      }}
                      onClick={() => toggleChannelDashboardVisibility(channel)}
                    >
                      {isHidden ? "Hidden" : "Shown"}
                    </button>
                    <button
                      type="button"
                      style={{ ...styles.iconButton, width: 18, height: 18 }}
                      onClick={() => removeChannel(channel)}
                    >
                      <CloseIcon />
                    </button>
                  </span>
                );
              })}
            </div>
            <div style={{ ...styles.fieldRow, marginTop: 8 }}>
              <input
                style={styles.input}
                value={newChannel}
                onChange={(e) => setNewChannel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addChannel();
                }}
                placeholder="e.g. TikTok"
              />
              <button type="button" style={styles.addRevisionButton} onClick={addChannel}>
                <PlusIcon />
                Add channel
              </button>
            </div>
            <p style={styles.fieldHint}>
              Track where leads come from. These show up as filters on the Leads board.
              "Shown"/"Hidden" controls only whether a channel appears in the Dashboard's
              "Leads by channel" breakdown — a hidden channel is still selectable on leads
              and still works as a filter everywhere else.
            </p>
          </div>
        </div>

        <div style={styles.settingsSection}>
          <h2 style={styles.settingsSectionTitle}>Follow-up cadence</h2>
          <div style={styles.field}>
            <label style={styles.label}>Days after initial email</label>
            <div style={styles.fieldRow}>
              {(form.followupSchedule || DEFAULT_FOLLOWUP_SCHEDULE).map((step, i) => (
                <input
                  key={step.label}
                  style={styles.input}
                  type="number"
                  min="0"
                  disabled={i === 0}
                  value={step.dayOffset}
                  title={step.label}
                  onChange={(e) => {
                    const next = (form.followupSchedule || DEFAULT_FOLLOWUP_SCHEDULE).map((s, j) =>
                      j === i ? { ...s, dayOffset: Number(e.target.value) } : s
                    );
                    setForm({ ...form, followupSchedule: next });
                  }}
                />
              ))}
            </div>
            <p style={styles.fieldHint}>
              Initial / Follow-up 1 / 2 / 3 / 4. After the 4th follow-up goes unanswered, a lead
              automatically moves to No Response.
            </p>
          </div>
        </div>

        <div style={styles.settingsSection}>
          <h2 style={styles.settingsSectionTitle}>Notifications</h2>
          <div style={styles.field}>
            <label style={styles.label}>Notifications</label>
            <div style={styles.lostReasonGrid}>
              <button
                type="button"
                style={{
                  ...styles.reviewStatusButton,
                  borderColor: form.notificationsEnabled !== false ? teal : border,
                  color: form.notificationsEnabled !== false ? tealLight : textMuted,
                  background: form.notificationsEnabled !== false ? "rgba(47,191,166,0.1)" : "transparent",
                }}
                onClick={() => setForm({ ...form, notificationsEnabled: true })}
              >
                On
              </button>
              <button
                type="button"
                style={{
                  ...styles.reviewStatusButton,
                  borderColor: form.notificationsEnabled === false ? teal : border,
                  color: form.notificationsEnabled === false ? tealLight : textMuted,
                  background: form.notificationsEnabled === false ? "rgba(47,191,166,0.1)" : "transparent",
                }}
                onClick={() => setForm({ ...form, notificationsEnabled: false })}
              >
                Off
              </button>
            </div>
            <p style={styles.fieldHint}>
              {form.notificationsEnabled === false
                ? "Off - Kairil won't send desktop notifications, even if your browser allows them."
                : "On - controls Pomodoro-break and CRM follow-up alerts. Your browser's own permission below still has to be granted too."}
            </p>
          </div>

          <div style={styles.field}>
            <label style={styles.label}>Desktop notification permission</label>
            {notificationPermission === "unsupported" ? (
              <p style={styles.fieldHint}>Your browser doesn't support desktop notifications.</p>
            ) : notificationPermission === "granted" ? (
              <p style={{ ...styles.fieldHint, color: "#3DDC86" }}>
                Granted - you'll get a notification for Pomodoro breaks and when leads need attention
                {form.notificationsEnabled === false ? " once you turn notifications back on above." : "."}
              </p>
            ) : notificationPermission === "denied" ? (
              <p style={styles.fieldHint}>
                Blocked in your browser's site settings. Allow notifications for this site to turn these back on.
              </p>
            ) : (
              <>
                <p style={styles.fieldHint}>
                  Get notified when a focus session's break starts, and when leads need follow-up -
                  even if Kairil isn't the tab you're looking at.
                </p>
                <button type="button" style={styles.addRevisionButton} onClick={handleEnableNotifications}>
                  Enable notifications
                </button>
              </>
            )}
          </div>
        </div>

        <div style={styles.settingsSection}>
          <h2 style={styles.settingsSectionTitle}>Integrations</h2>
          <div style={styles.field}>
            <label style={styles.label}>Google Drive</label>
            {driveEmail ? (
              <p style={{ ...styles.fieldHint, color: "#3DDC84" }}>Connected as {driveEmail}</p>
            ) : (
              <>
                <p style={styles.fieldHint}>
                  Connect to auto-create project folders and let freelancer uploads land straight in
                  Drive.
                </p>
                <button type="button" style={styles.addRevisionButton} onClick={onConnectDrive}>
                  Connect Google Drive
                </button>
              </>
            )}
          </div>
        </div>

        <div style={styles.settingsSection}>
          <h2 style={styles.settingsSectionTitle}>Help & support</h2>
          <div style={styles.field}>
            <label style={styles.label}>Help</label>
            <div style={styles.fieldRow}>
              <button type="button" style={styles.addRevisionButton} onClick={onReplayTutorial}>
                Replay tutorial
              </button>
              <button type="button" style={styles.addRevisionButton} onClick={onOpenSupport}>
                Report a problem
              </button>
            </div>
          </div>

          {settings.isAdmin && (
            <div style={styles.field}>
              <label style={styles.label}>Support inbox</label>
              {supportMessages === null ? (
                <button type="button" style={styles.addRevisionButton} onClick={loadSupportInbox} disabled={loadingInbox}>
                  {loadingInbox ? "Loading..." : "Load recent messages"}
                </button>
              ) : supportMessages.length === 0 ? (
                <p style={styles.fieldHint}>Nothing's come in yet.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 220, overflowY: "auto" }}>
                  {supportMessages.map((m) => (
                    <div key={m.id} style={{ ...styles.fileNameRow, flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", width: "100%" }}>
                        <span style={{ ...styles.fieldHint, color: paper }}>{m.email}</span>
                        <span style={styles.fieldHint}>{new Date(m.created_at).toLocaleDateString()}</span>
                      </div>
                      <p style={{ fontSize: 13, color: paper, margin: 0 }}>{m.message}</p>
                      {m.page_context && <span style={styles.fieldHint}>from: {m.page_context}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div style={styles.settingsFooterBar}>
        <button style={styles.saveButton} onClick={() => onSave(form)}>
          Save settings
        </button>
      </div>
    </div>
  );
}

const ACTIVITY_ICONS = {
  freelancer_upload: "\u2191",
  review_approved: "\u2713",
  review_revisions: "\u21bb",
  note: "\u2022",
};

function formatActivityTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function ActivityPanel({ entries, cards, onRefresh }) {
  const sorted = [...entries].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return (
    <div style={styles.invoicesWrap}>
      <button type="button" style={{ ...styles.cancelButton, alignSelf: "flex-start" }} onClick={onRefresh}>
        Refresh
      </button>
      {sorted.length === 0 ? (
        <p style={styles.fieldHint}>
          No activity yet. Freelancer uploads and review decisions will show up here with a timestamp.
        </p>
      ) : (
        <div style={styles.invoiceList}>
          {sorted.map((entry) => {
            const shot = cards.find((c) => c.id === entry.shotId);
            return (
              <div key={entry.id} style={styles.invoiceCard}>
                <div style={styles.invoiceCardTop}>
                  <span style={styles.invoiceNumber}>
                    {ACTIVITY_ICONS[entry.type] || "\u2022"} {entry.message}
                  </span>
                </div>
                <div style={styles.invoiceAmountsRow}>
                  <span style={styles.fieldHint}>{formatActivityTime(entry.createdAt)}</span>
                  {shot && <span style={styles.fieldHint}>{shot.title}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function InvoicesPanel({
  project,
  projectCards,
  invoices,
  onNew,
  onEdit,
  onMarkPaid,
  onGenerateFollowup,
  onDownload,
  onOpenMilestones,
  currencySymbol,
  hasProAccess,
  fxRates,
}) {
  const cur = currencySymbol || "$";
  if (!project) return null;
  const { totalBudget, amountPaid, outstanding } = projectBudgetSummary(project, projectCards, invoices, fxRates);
  // Whether a receipt/invoice has already been generated from a given
  // proforma/receipt, so the "Generate..." action only shows up once per
  // step - re-clicking it wouldn't lose anything (it just opens another
  // prefilled draft), but offering it after the fact reads as broken.
  const hasFollowup = (sourceId, targetType) =>
    invoices.some((other) => other.convertedFromId === sourceId && other.docType === targetType);

  return (
    <div style={styles.invoicesWrap}>
      <div style={styles.budgetSummaryRow}>
        <div style={styles.budgetStat}>
          <span style={styles.label}>Total budget</span>
          <span style={styles.budgetStatValue}>{cur}{formatMoney(totalBudget)}</span>
          <span style={styles.fieldHint}>
            {project.budgetMode === "auto" ? "Calculated from shot rates" : "Manual"}
          </span>
        </div>
        <div style={styles.budgetStat}>
          <span style={styles.label}>Amount paid</span>
          <span style={{ ...styles.budgetStatValue, color: "#3DDC84" }}>{cur}{formatMoney(amountPaid)}</span>
        </div>
        <div style={styles.budgetStat}>
          <span style={styles.label}>Outstanding</span>
          <span style={{ ...styles.budgetStatValue, color: "#F2A65A" }}>{cur}{formatMoney(outstanding)}</span>
        </div>
      </div>

      {invoices.length === 0 ? (
        <div style={styles.projectsEmpty}>
          <div style={styles.projectsEmptyIcon}><InvoiceIcon /></div>
          <p style={styles.projectsEmptyText}>No invoices yet</p>
          <div style={{ display: "flex", gap: 10 }}>
            <button style={styles.newButton} onClick={onNew}>
              <PlusIcon />
              New invoice
            </button>
            {hasProAccess && (
              <button style={styles.cancelButton} onClick={onOpenMilestones}>
                Set up milestones
              </button>
            )}
          </div>
        </div>
      ) : (
        hasProAccess && (
          <button style={{ ...styles.cancelButton, alignSelf: "flex-start" }} onClick={onOpenMilestones}>
            Set up milestones
          </button>
        )
      )}

      {invoices.length > 0 && (
        <div style={styles.invoiceList}>
          {invoices.map((inv) => {
            const balance = parseMoney(inv.amount) - parseMoney(inv.amountPaid);
            const docType = inv.docType || "invoice";
            const docTypeLabel = DOC_TYPES.find((t) => t.id === docType)?.label || "Invoice";
            const hasLineItems = inv.amountMode === "items" && (inv.lineItems || []).length > 0;
            const summaryText =
              inv.description ||
              (hasLineItems
                ? `${inv.lineItems.length} line item${inv.lineItems.length === 1 ? "" : "s"}`
                : "");
            return (
              <div key={inv.id} className="kf-card" style={styles.invoiceCard} onClick={() => onEdit(inv)}>
                <div style={styles.invoiceCardTop}>
                  <span style={styles.invoiceNumber}>{inv.invoiceNumber}</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={styles.docTypeTag}>{docTypeLabel}</span>
                    <span
                      style={{
                        ...styles.invoiceStatusTag,
                        color: inv.status === "paid" ? "#3DDC84" : "#F2A65A",
                        borderColor: inv.status === "paid" ? "#3DDC84" : "#F2A65A",
                      }}
                    >
                      {inv.status === "paid" ? "Paid" : "Unpaid"}
                    </span>
                  </div>
                </div>
                {summaryText && <div style={styles.cardMeta}>{summaryText}</div>}
                <div style={styles.invoiceAmountsRow}>
                  <span style={styles.fieldHint}>
                    Amount {inv.currency || cur}
                    {formatMoney(inv.amount)}
                  </span>
                  <span style={styles.fieldHint}>
                    Balance {inv.currency || cur}
                    {formatMoney(balance)}
                  </span>
                </div>
                <div style={styles.invoiceActionsRow}>
                  {inv.status !== "paid" && (
                    <button
                      style={styles.cancelButton}
                      onClick={(e) => {
                        e.stopPropagation();
                        onMarkPaid(inv);
                      }}
                    >
                      Mark as paid
                    </button>
                  )}
                  {docType === "proforma" && !hasFollowup(inv.id, "receipt") && (
                    <button
                      style={styles.cancelButton}
                      onClick={(e) => {
                        e.stopPropagation();
                        onGenerateFollowup(inv, "receipt");
                      }}
                    >
                      Generate receipt
                    </button>
                  )}
                  {docType !== "invoice" && !hasFollowup(inv.id, "invoice") && (
                    <button
                      style={styles.cancelButton}
                      onClick={(e) => {
                        e.stopPropagation();
                        onGenerateFollowup(inv, "invoice");
                      }}
                    >
                      Generate invoice
                    </button>
                  )}
                  <button
                    style={{ ...styles.cancelButton, display: "flex", alignItems: "center", gap: 6 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDownload(inv);
                    }}
                  >
                    <DownloadIcon />
                    PDF
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ProjectEditor({ project, onCancel, onSave, onDelete, isNew, driveEmail, onCreateDriveFolders, hasProAccess, atProjectLimit, shotCount, invoiceCount }) {
  const [form, setForm] = useState(project);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  const [linkCopied, setLinkCopied] = useState(false);
  const [creatingFolders, setCreatingFolders] = useState(false);
  const [driveError, setDriveError] = useState("");
  const [saving, setSaving] = useState(false);
  const saveLockRef = useRef(false);

  const shareUrl = form.shareToken
    ? `${window.location.origin}${window.location.pathname}?share=project&token=${form.shareToken}`
    : "";

  const handleCopyShareLink = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch (e) {
      window.prompt("Copy the client link:", shareUrl);
    }
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 1500);
  };

  const handleCreateFolders = async () => {
    // Guard against double-firing this request (e.g. a fast double-click)
    // client-side; the edge function itself now also checks for an
    // existing drive_folder_id server-side, which is the actual defense
    // against two tabs/requests racing to create folders for the same
    // project.
    if (creatingFolders) return;
    setDriveError("");
    setCreatingFolders(true);
    try {
      const result = await onCreateDriveFolders(form.id, form.name || "Untitled project");
      setForm({ ...form, ...result });
    } catch (err) {
      setDriveError(err.message || "Couldn't create Drive folders");
    }
    setCreatingFolders(false);
  };

  return (
    <div style={styles.overlay} onClick={onCancel}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <span style={styles.modalTitle}>{isNew ? "New project" : "Edit project"}</span>
          <button style={styles.iconButton} onClick={onCancel}>
            <CloseIcon />
          </button>
        </div>

        {isNew && atProjectLimit ? (
          <ProUpgradePrompt feature={`More than ${FREE_PROJECT_LIMIT} active projects`} />
        ) : (
          <>
        <div style={styles.field}>
          <label style={styles.label}>Project name</label>
          <input
            style={styles.input}
            value={form.name}
            onChange={set("name")}
            placeholder="e.g. Nightfall Trailer"
            autoFocus
          />
        </div>

        <div style={styles.field}>
          <label style={styles.label}>Client</label>
          <input
            style={styles.input}
            value={form.client}
            onChange={set("client")}
            placeholder="e.g. Vicente Carro"
          />
        </div>

        <div style={styles.field}>
          <label style={styles.label}>Billing address (optional)</label>
          <textarea
            style={{ ...styles.input, minHeight: 60, resize: "vertical" }}
            value={form.clientAddress || ""}
            onChange={set("clientAddress")}
            placeholder={"e.g. S\u00f3lt\u00fan 5, door 203,\nReykjav\u00edk 105, Iceland"}
          />
          <p style={styles.fieldHint}>Printed on this client's invoices, under "Bill to".</p>
        </div>

        <div style={styles.field}>
          <label style={styles.label}>Tax ID / VAT number (optional)</label>
          <input
            style={styles.input}
            value={form.clientTaxId || ""}
            onChange={set("clientTaxId")}
            placeholder="e.g. VAT/RSK no. 162704"
          />
        </div>

        {isNew && (
          <div style={styles.field}>
            <label style={styles.label}>Number of shots</label>
            <input
              style={styles.input}
              type="number"
              min="0"
              max="500"
              value={form.shotCount || ""}
              onChange={set("shotCount")}
              placeholder="e.g. 24"
            />
            <p style={styles.fieldHint}>
              Creates Cut 01, Cut 02... as a starting checklist. Leave blank to add shots one at a time later.
            </p>
          </div>
        )}

        <div style={styles.field}>
          <label style={styles.label}>
            Client sharing <span style={styles.proBadge}>PRO</span>
          </label>
          {!hasProAccess ? (
            <ProUpgradePrompt feature="Client Portal" inline />
          ) : (
            <>
              <label style={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={!!form.shareEnabled}
                  onChange={(e) => setForm({ ...form, shareEnabled: e.target.checked })}
                />
                Share progress with client
              </label>
              {form.shareEnabled && (
                <>
                  <p style={styles.fieldHint}>
                    {isNew
                      ? "A link will be ready to copy right after you save."
                      : "Send this link to your client, no login needed on their end."}
                  </p>
                  {!isNew && shareUrl && (
                    <div style={styles.fileNameRow}>
                      <span style={{ ...styles.fieldHint, wordBreak: "break-all" }}>{shareUrl}</span>
                      <button type="button" style={styles.copyButton} onClick={handleCopyShareLink}>
                        <CopyIcon />
                        {linkCopied ? "Copied" : "Copy"}
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>

        <div style={styles.field}>
          <label style={styles.label}>Google Drive</label>
          {!driveEmail ? (
            <p style={styles.fieldHint}>
              Connect Google Drive in Settings first, then come back here to create this project's folders.
            </p>
          ) : isNew ? (
            <p style={styles.fieldHint}>Save this project first, then folders can be created for it.</p>
          ) : form.driveFolderUrl ? (
            <a
              href={form.driveFolderUrl}
              target="_blank"
              rel="noreferrer"
              style={{ ...styles.fieldHint, color: teal }}
            >
              Open Drive folder
            </a>
          ) : (
            <button
              type="button"
              style={styles.addRevisionButton}
              onClick={handleCreateFolders}
              disabled={creatingFolders}
            >
              {creatingFolders ? "Creating..." : "Create Drive folders"}
            </button>
          )}
          {driveError && <p style={{ ...styles.fieldHint, color: "#FF4D4D" }}>{driveError}</p>}
        </div>

        <div style={styles.field}>
          <label style={styles.label}>Budget mode</label>
          <div style={styles.reviewStatusRow}>
            <button
              type="button"
              style={{
                ...styles.reviewStatusButton,
                borderColor: (form.budgetMode || "manual") === "manual" ? teal : border,
                color: (form.budgetMode || "manual") === "manual" ? teal : textMuted,
                background: (form.budgetMode || "manual") === "manual" ? "rgba(47,191,166,0.1)" : "transparent",
              }}
              onClick={() => setForm({ ...form, budgetMode: "manual" })}
            >
              Manual
            </button>
            <button
              type="button"
              style={{
                ...styles.reviewStatusButton,
                borderColor: form.budgetMode === "auto" ? teal : border,
                color: form.budgetMode === "auto" ? teal : textMuted,
                background: form.budgetMode === "auto" ? "rgba(47,191,166,0.1)" : "transparent",
              }}
              onClick={() => setForm({ ...form, budgetMode: "auto" })}
            >
              Auto from shot rates
            </button>
          </div>
        </div>

        <div style={styles.fieldRow}>
          <div style={styles.field}>
            <label style={styles.label}>Budget</label>
            <input
              style={styles.input}
              value={form.budget || ""}
              onChange={set("budget")}
              placeholder="e.g. 2000"
              disabled={form.budgetMode === "auto"}
            />
            {form.budgetMode === "auto" && (
              <p style={styles.fieldHint}>Calculated automatically from each shot's rate.</p>
            )}
          </div>
          <div style={styles.field}>
            <label style={styles.label}>
              Currency {!hasProAccess && <span style={styles.proBadge}>PRO</span>}
            </label>
            {hasProAccess ? (
              <select style={styles.input} value={form.currency || "$"} onChange={set("currency")}>
                {CURRENCIES.map((c) => (
                  <option key={c.code} value={c.symbol}>
                    {c.label}
                  </option>
                ))}
              </select>
            ) : (
              <>
                <p style={styles.fieldHint}>{form.currency || "$"} (studio default)</p>
                <p style={styles.fieldHint}>Multiple currencies are a Pro feature.</p>
              </>
            )}
          </div>
        </div>

        <div style={styles.field}>
          <label style={styles.label}>Deadline</label>
          <input
            type="date"
            style={styles.input}
            // A plain text field let this column accumulate values like "Aug 15",
            // "15/08", "next Friday" - impossible to sort or compare reliably.
            // A native date input always writes/reads ISO (YYYY-MM-DD), so every
            // deadline set from here on is consistent without needing a data
            // migration for existing rows: the column stays `text`, this just
            // standardizes what new values look like. An old free-text value
            // that isn't ISO-formatted shows the field as blank (the browser
            // can't parse it into the picker) rather than crashing, and the
            // hint below covers that case instead of the value silently
            // appearing to disappear.
            value={/^\d{4}-\d{2}-\d{2}$/.test(form.deadline || "") ? form.deadline : ""}
            onChange={set("deadline")}
          />
          {form.deadline && !/^\d{4}-\d{2}-\d{2}$/.test(form.deadline) && (
            <p style={styles.fieldHint}>
              Currently set to "{form.deadline}" - pick a date above to replace it.
            </p>
          )}
        </div>

        <div style={styles.field}>
          <label style={styles.label}>Priority</label>
          <select style={styles.input} value={form.priority || "normal"} onChange={set("priority")}>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="rush">Rush</option>
          </select>
        </div>

        <div style={styles.field}>
          <label style={styles.label}>Notes</label>
          <textarea
            style={styles.textarea}
            value={form.notes}
            onChange={set("notes")}
            placeholder="Scope, deadlines, contract terms..."
            rows={3}
          />
        </div>

        <div style={styles.modalFooter}>
          {!isNew && (
            <button
              style={styles.deleteButton}
              onClick={() => {
                // Deletion cascades into every shot, invoice, and activity
                // entry on this project (and trashes its Drive folder), so
                // an accidental click here is much more destructive than
                // most other deletes in the app - it needs a confirmation
                // that actually says what's about to be removed.
                const parts = [];
                if (shotCount > 0) parts.push(`${shotCount} shot${shotCount === 1 ? "" : "s"}`);
                if (invoiceCount > 0) parts.push(`${invoiceCount} invoice${invoiceCount === 1 ? "" : "s"}`);
                const detail = parts.length > 0 ? ` This will also delete ${parts.join(" and ")}.` : "";
                const driveNote = form.driveFolderId ? " Its Google Drive folder will be moved to trash." : "";
                if (
                  window.confirm(
                    `Delete "${form.name || "Untitled project"}"?${detail}${driveNote} This action cannot be undone.`
                  )
                ) {
                  onDelete(form.id);
                }
              }}
            >
              <TrashIcon />
              Delete
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button style={styles.cancelButton} onClick={onCancel}>
            Cancel
          </button>
          <button
            style={styles.saveButton}
            disabled={saving}
            onClick={async () => {
              if (saveLockRef.current) return;

              saveLockRef.current = true;
              setSaving(true);

              try {
                await onSave({
                  ...form,
                  name: form.name || "Untitled project",
                });
              } finally {
                saveLockRef.current = false;
                setSaving(false);
              }
            }}
          >
            {saving ? "Saving..." : "Save project"}
          </button>
        </div>
        </>
        )}
      </div>
    </div>
  );
}

function LeadEditor({
  lead,
  onCancel,
  onSave,
  onDelete,
  onMarkWon,
  onMarkLost,
  onArchive,
  onRestore,
  isNew,
  leadChannels = [],
  onAddChannel,
  leads = [],
  followupSchedule = DEFAULT_FOLLOWUP_SCHEDULE,
}) {
  const [form, setForm] = useState(lead);
  const [isEditing, setIsEditing] = useState(isNew);
  // Quick-pick reason list shown by the "Mark lost" button specifically.
  // Separate from the inline "Outcome reason" picker below (which handles
  // every terminal stage, including ones reached via the Status grid
  // rather than this button).
  const [showLostReasons, setShowLostReasons] = useState(false);
  const [addingChannel, setAddingChannel] = useState(false);
  const [newChannelName, setNewChannelName] = useState("");
  const [copiedEmail, setCopiedEmail] = useState(false);
  const [confirmingDuplicate, setConfirmingDuplicate] = useState(false);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  const handleCopyEmail = () => {
    if (!form.email) return;
    navigator.clipboard?.writeText(form.email).then(() => {
      setCopiedEmail(true);
      setTimeout(() => setCopiedEmail(false), 1500);
    });
  };

  const handleCancelEdit = () => {
    if (isNew) {
      onCancel();
      return;
    }
    setForm(lead);
    setIsEditing(false);
    setShowLostReasons(false);
    setConfirmingDuplicate(false);
  };

  const duplicates = useMemo(
    () => findPossibleDuplicates(form, leads, form.id),
    // Re-check whenever the fields that matter for matching change.
    [form.companyName, form.email, form.website, form.contactPerson, leads, form.id]
  );
  const blockingDuplicates = duplicates.filter((d) => d.confidence !== "medium");
  const softDuplicates = duplicates.filter((d) => d.confidence === "medium");

  const attemptSave = () => {
    if (!confirmingDuplicate && blockingDuplicates.length > 0) {
      setConfirmingDuplicate(true);
      return;
    }
    setConfirmingDuplicate(false);
    onSave({ ...form, companyName: form.companyName || "Untitled lead" });
  };

  const followupStatus = computeFollowupStatus(form, followupSchedule);
  const isTerminal = isLeadStageTerminal(form.stage);

  const handleAddChannelSubmit = () => {
    const trimmed = newChannelName.trim();
    if (!trimmed) {
      setAddingChannel(false);
      return;
    }
    onAddChannel && onAddChannel(trimmed);
    setForm({ ...form, channel: trimmed });
    setNewChannelName("");
    setAddingChannel(false);
  };

  const updateEmail = (index, patch) => {
    let justSent = false;
    const nextEmails = form.emails.map((em, i) => {
      if (i !== index) return em;
      const updated = { ...em, ...patch };
      if (patch.sent === true && !em.sent) {
        updated.dateSent = new Date().toISOString().slice(0, 10);
        justSent = true;
      }
      if (patch.sent === false) {
        updated.dateSent = null;
      }
      return updated;
    });

    // Automation: sending the initial email moves a lead out of the pool,
    // and sending the final follow-up assumes no reply yet, so it moves to
    // No Response. Either can always be corrected manually afterward.
    let nextStage = form.stage;
    if (index === 0 && patch.sent === true && form.stage === "pool") {
      nextStage = "cold_email";
    }
    if (index === 4 && patch.sent === true && form.stage === "cold_email") {
      nextStage = "no_response";
    }
    setForm({
      ...form,
      emails: nextEmails,
      stage: nextStage,
      lastContactedAt: justSent ? new Date().toISOString() : form.lastContactedAt,
    });
  };

  const showNegotiation = !["pool", "cold_email"].includes(form.stage);
  const priorityMeta = LEAD_PRIORITIES.find((p) => p.id === form.priority) || LEAD_PRIORITIES[1];
  const stageMeta = ALL_LEAD_STAGES.find((s) => s.id === form.stage);

  return (
    <div style={styles.overlay} onClick={onCancel}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <span style={styles.modalTitle}>
            {isNew ? "New lead" : isEditing ? "Edit lead" : form.companyName || "Untitled lead"}
          </span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {!isNew && !isEditing && (
              <button type="button" style={styles.copyButton} onClick={() => setIsEditing(true)}>
                <EditIcon />
                Edit
              </button>
            )}
            <button style={styles.iconButton} onClick={onCancel}>
              <CloseIcon />
            </button>
          </div>
        </div>

        {form.archivedAt && (
          <div style={styles.archivedBanner}>
            Archived {formatShortDate(form.archivedAt)}.
            <button type="button" style={styles.linkButton} onClick={() => onRestore(form)}>
              Restore lead
            </button>
          </div>
        )}

        {!isEditing ? (
          <>
            <div style={styles.badgeRow}>
              <span style={styles.cardTag}>
                {priorityMeta.icon} {priorityMeta.label}
              </span>
              <span style={styles.cardTag}>{stageMeta ? stageMeta.label : form.stage}</span>
              {form.channel && <span style={styles.cardTag}>{form.channel}</span>}
              {form.needsFollowup && <span style={{ ...styles.cardTag, color: "#F2A65A" }}>Needs follow-up</span>}
            </div>

            <div style={styles.fieldRow}>
              <div style={styles.field}>
                <label style={styles.label}>Contact</label>
                <p style={styles.readOnlyValue}>{form.contactPerson || "\u2014"}</p>
              </div>
              <div style={styles.field}>
                <label style={styles.label}>Email</label>
                <p style={styles.readOnlyValue}>
                  {form.email || "\u2014"}
                  {form.email && (
                    <button type="button" style={styles.copyIconButton} onClick={handleCopyEmail} title="Copy email">
                      <CopyIcon />
                    </button>
                  )}
                  {copiedEmail && <span style={styles.copiedTag}>Copied</span>}
                </p>
              </div>
            </div>

            <div style={styles.fieldRow}>
              <div style={styles.field}>
                <label style={styles.label}>Website</label>
                <p style={styles.readOnlyValue}>{form.website || "\u2014"}</p>
              </div>
              <div style={styles.field}>
                <label style={styles.label}>Country</label>
                <p style={styles.readOnlyValue}>{form.country || "\u2014"}</p>
              </div>
            </div>

            {(form.billingAddress || form.taxId) && (
              <div style={styles.fieldRow}>
                <div style={styles.field}>
                  <label style={styles.label}>Billing address</label>
                  <p style={styles.readOnlyValue}>{form.billingAddress || "\u2014"}</p>
                </div>
                <div style={styles.field}>
                  <label style={styles.label}>Tax ID / VAT number</label>
                  <p style={styles.readOnlyValue}>{form.taxId || "\u2014"}</p>
                </div>
              </div>
            )}

            {form.notes && (
              <div style={styles.field}>
                <label style={styles.label}>Client notes</label>
                <p style={styles.readOnlyValue}>{form.notes}</p>
              </div>
            )}

            <div style={styles.fieldDivider}>Follow-up</div>
            <p style={styles.readOnlyValue}>
              {followupStatus.dueLabel || followupStatus.nextActionLabel || "Outreach complete"}
              {followupStatus.lastContactedLabel && ` \u00b7 Last contacted: ${followupStatus.lastContactedLabel}`}
            </p>
            {!isTerminal && !form.needsFollowup && (
              <button
                type="button"
                style={{ ...styles.copyButton, marginTop: 4 }}
                onClick={() => onSave({ ...form, needsFollowup: true })}
              >
                Needs follow-up
              </button>
            )}

            {stageTakesOutcomeReason(form.stage) && form.outcomeReason && (
              <p style={styles.fieldHint}>Reason: {form.outcomeReason}</p>
            )}
            {form.linkedProjectId && <p style={styles.fieldHint}>Linked to an active project.</p>}

            {isTerminal && !form.archivedAt && (
              <button type="button" style={{ ...styles.copyButton, marginTop: 8 }} onClick={() => onArchive(form)}>
                Archive lead
              </button>
            )}

            <div style={styles.fieldDivider}>Activity</div>
            <div style={styles.timeline}>
              {(form.activityLog || []).length === 0 && (
                <p style={styles.fieldHint}>No activity recorded yet.</p>
              )}
              {[...(form.activityLog || [])]
                .reverse()
                .map((entry, i) => (
                  <div key={i} style={styles.timelineItem}>
                    <span style={styles.timelineDate}>{formatShortDate(entry.ts)}</span>
                    <span>{entry.note}</span>
                  </div>
                ))}
            </div>

            <div style={styles.modalFooter}>
              {!isNew && (
                <button style={styles.deleteButton} onClick={() => onDelete(form.id)}>
                  <TrashIcon />
                  Delete
                </button>
              )}
              <div style={{ flex: 1 }} />
              <button style={styles.cancelButton} onClick={onCancel}>
                Close
              </button>
              <button style={styles.saveButton} onClick={() => setIsEditing(true)}>
                Edit
              </button>
            </div>
          </>
        ) : (
          <>
            {softDuplicates.length > 0 && !confirmingDuplicate && (
              <div style={styles.duplicateBanner}>
                Possible existing lead: <strong>{softDuplicates[0].lead.companyName}</strong>
                {softDuplicates[0].lead.email ? ` \u00b7 ${softDuplicates[0].lead.email}` : ""}
                {" \u00b7 "}
                {ALL_LEAD_STAGES.find((s) => s.id === softDuplicates[0].lead.stage)?.label || softDuplicates[0].lead.stage}
              </div>
            )}

            <div style={styles.field}>
              <label style={styles.label}>Company name</label>
              <input
                style={styles.input}
                value={form.companyName}
                onChange={set("companyName")}
                placeholder="e.g. Nightfall Games"
                autoFocus
              />
            </div>

            <div style={styles.fieldRow}>
              <div style={styles.field}>
                <label style={styles.label}>Contact person</label>
                <input
                  style={styles.input}
                  value={form.contactPerson}
                  onChange={set("contactPerson")}
                  placeholder="e.g. Jamie Fox"
                />
              </div>
              <div style={styles.field}>
                <label style={styles.label}>Email</label>
                <div style={{ ...styles.fileNameRow, gap: 6 }}>
                  <input
                    style={styles.input}
                    value={form.email}
                    onChange={set("email")}
                    placeholder="jamie@studio.com"
                  />
                  {form.email && (
                    <button type="button" style={styles.copyIconButton} onClick={handleCopyEmail} title="Copy email">
                      <CopyIcon />
                    </button>
                  )}
                  {copiedEmail && <span style={styles.copiedTag}>Copied</span>}
                </div>
              </div>
            </div>

            <div style={styles.fieldRow}>
              <div style={styles.field}>
                <label style={styles.label}>Website</label>
                <input
                  style={styles.input}
                  value={form.website}
                  onChange={set("website")}
                  placeholder="nightfallgames.com"
                />
              </div>
              <div style={styles.field}>
                <label style={styles.label}>Country</label>
                <input
                  style={styles.input}
                  value={form.country}
                  onChange={set("country")}
                  placeholder="e.g. United States"
                />
              </div>
            </div>

            <div style={styles.field}>
              <label style={styles.label}>Billing address (optional)</label>
              <textarea
                style={{ ...styles.input, minHeight: 60, resize: "vertical" }}
                value={form.billingAddress || ""}
                onChange={set("billingAddress")}
                placeholder="For invoices, if you have it yet"
              />
            </div>

            <div style={styles.field}>
              <label style={styles.label}>Tax ID / VAT number (optional)</label>
              <input
                style={styles.input}
                value={form.taxId || ""}
                onChange={set("taxId")}
              />
              <p style={styles.fieldHint}>
                Carried over automatically when this lead is marked Won and becomes a project.
              </p>
            </div>

            <div style={styles.field}>
              <label style={styles.label}>Client notes</label>
              <textarea
                style={styles.textarea}
                value={form.notes}
                onChange={set("notes")}
                placeholder="What they do, style, references, budget signals, source of lead..."
                rows={3}
              />
            </div>

            <div style={styles.fieldRow}>
              <div style={styles.field}>
                <label style={styles.label}>Priority</label>
                <div style={styles.lostReasonGrid}>
                  {LEAD_PRIORITIES.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      style={{
                        ...styles.reviewStatusButton,
                        borderColor: form.priority === p.id ? teal : border,
                        color: form.priority === p.id ? tealLight : textMuted,
                        background: form.priority === p.id ? "rgba(47,191,166,0.1)" : "transparent",
                      }}
                      onClick={() => setForm({ ...form, priority: p.id })}
                    >
                      {p.icon} {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <div style={styles.field}>
                <label style={styles.label}>Follow-up</label>
                <button
                  type="button"
                  style={{
                    ...styles.reviewStatusButton,
                    borderColor: form.needsFollowup ? teal : border,
                    color: form.needsFollowup ? tealLight : textMuted,
                    background: form.needsFollowup ? "rgba(47,191,166,0.1)" : "transparent",
                  }}
                  onClick={() => setForm({ ...form, needsFollowup: !form.needsFollowup })}
                >
                  Needs follow-up
                </button>
              </div>
            </div>

            <div style={styles.field}>
              <label style={styles.label}>Status</label>
              <div style={styles.lostReasonGrid}>
                {ALL_LEAD_STAGES.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    style={{
                      ...styles.reviewStatusButton,
                      borderColor: form.stage === s.id ? teal : border,
                      color: form.stage === s.id ? tealLight : textMuted,
                      background: form.stage === s.id ? "rgba(47,191,166,0.1)" : "transparent",
                    }}
                    onClick={() => setForm({ ...form, stage: s.id })}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <p style={styles.fieldHint}>
                No Response and Lost are tracked separately: one means they went quiet, the other means they said no.
              </p>
            </div>

            {stageTakesOutcomeReason(form.stage) && (
              <div style={styles.field}>
                <label style={styles.label}>Reason</label>
                <div style={styles.lostReasonGrid}>
                  {outcomeReasonsForStage(form.stage).map((reason) => (
                    <button
                      key={reason}
                      type="button"
                      style={{
                        ...styles.reviewStatusButton,
                        borderColor: form.outcomeReason === reason ? teal : border,
                        color: form.outcomeReason === reason ? tealLight : textMuted,
                        background: form.outcomeReason === reason ? "rgba(47,191,166,0.1)" : "transparent",
                      }}
                      onClick={() =>
                        setForm({ ...form, outcomeReason: form.outcomeReason === reason ? "" : reason })
                      }
                    >
                      {reason}
                    </button>
                  ))}
                </div>
                <p style={styles.fieldHint}>
                  Why the lead ended up here - separate from the status itself, so "No budget" or "Not now" never
                  gets counted as a pipeline stage.
                </p>
              </div>
            )}

            <div style={styles.field}>
              <label style={styles.label}>Channel</label>
              <div style={styles.lostReasonGrid}>
                {leadChannels.map((channel) => (
                  <button
                    key={channel}
                    type="button"
                    style={{
                      ...styles.reviewStatusButton,
                      borderColor: form.channel === channel ? teal : border,
                      color: form.channel === channel ? tealLight : textMuted,
                      background: form.channel === channel ? "rgba(47,191,166,0.1)" : "transparent",
                    }}
                    onClick={() => setForm({ ...form, channel: form.channel === channel ? "" : channel })}
                  >
                    {channel}
                  </button>
                ))}
                {addingChannel ? (
                  <div style={{ ...styles.fileNameRow, gap: 6 }}>
                    <input
                      style={{ ...styles.input, maxWidth: 140, padding: "6px 10px" }}
                      autoFocus
                      value={newChannelName}
                      onChange={(e) => setNewChannelName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleAddChannelSubmit();
                        if (e.key === "Escape") {
                          setAddingChannel(false);
                          setNewChannelName("");
                        }
                      }}
                      placeholder="e.g. TikTok"
                    />
                    <button type="button" style={styles.copyButton} onClick={handleAddChannelSubmit}>
                      Add
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    style={{ ...styles.reviewStatusButton, borderColor: border, color: teal, borderStyle: "dashed" }}
                    onClick={() => setAddingChannel(true)}
                  >
                    <PlusIcon />
                    New channel
                  </button>
                )}
              </div>
              <p style={styles.fieldHint}>Where this lead came from. Add as many channels as you want to track.</p>
            </div>

            <div style={styles.fieldDivider}>Outreach</div>
            <p style={styles.fieldHint}>
              {followupStatus.dueLabel || followupStatus.nextActionLabel || "Outreach complete."}
              {followupStatus.lastContactedLabel && ` \u00b7 Last contacted: ${followupStatus.lastContactedLabel}`}
            </p>

            {form.emails.map((em, i) => (
              <div key={i} style={styles.emailRow}>
                <div style={styles.emailRowHeader}>
                  <label style={styles.checkboxLabel}>
                    <input
                      type="checkbox"
                      checked={em.sent}
                      onChange={(e) => updateEmail(i, { sent: e.target.checked })}
                    />
                    {em.label}
                  </label>
                  {em.sent && em.dateSent && (
                    <span style={styles.fieldHint}>Sent {em.dateSent}</span>
                  )}
                  {!em.sent && i > 0 && (
                    <span style={styles.fieldHint}>Day {followupSchedule[i]?.dayOffset ?? "-"}</span>
                  )}
                </div>
                <textarea
                  style={styles.textarea}
                  value={em.message}
                  onChange={(e) => updateEmail(i, { message: e.target.value })}
                  placeholder={`${em.label} draft...`}
                  rows={2}
                />
              </div>
            ))}

            {showNegotiation && (
              <>
                <div style={styles.fieldDivider}>Negotiation</div>
                <div style={styles.fieldRow}>
                  <div style={styles.field}>
                    <label style={styles.label}>Proposed budget</label>
                    <input
                      style={styles.input}
                      value={form.proposedBudget}
                      onChange={set("proposedBudget")}
                      placeholder="e.g. $2,500"
                    />
                  </div>
                  <div style={styles.field}>
                    <label style={styles.label}>Estimated deadline</label>
                    <input
                      style={styles.input}
                      value={form.estimatedDeadline}
                      onChange={set("estimatedDeadline")}
                      placeholder="e.g. Sept 1"
                    />
                  </div>
                </div>
                <div style={styles.field}>
                  <label style={styles.label}>Project notes</label>
                  <textarea
                    style={styles.textarea}
                    value={form.projectNotes}
                    onChange={set("projectNotes")}
                    placeholder="Scope discussed, expectations..."
                    rows={2}
                  />
                </div>
              </>
            )}

            {form.linkedProjectId && (
              <p style={styles.fieldHint}>Linked to an active project.</p>
            )}

            {showLostReasons && (
              <div style={styles.field}>
                <label style={styles.label}>Reason lost</label>
                <div style={styles.lostReasonGrid}>
                  {LOST_REASONS.map((reason) => (
                    <button
                      key={reason}
                      style={styles.lostReasonButton}
                      onClick={() => onMarkLost(form, reason)}
                    >
                      {reason}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {confirmingDuplicate && (
              <div style={styles.duplicateBannerHard}>
                <strong>\u26a0\ufe0f Possible duplicate lead</strong>
                <p style={{ margin: "4px 0" }}>This lead appears to already exist:</p>
                {blockingDuplicates.slice(0, 2).map((d) => (
                  <p key={d.lead.id} style={{ margin: "2px 0" }}>
                    {d.lead.companyName}
                    {d.lead.email ? ` \u00b7 ${d.lead.email}` : ""}
                    {" \u00b7 "}
                    {ALL_LEAD_STAGES.find((s) => s.id === d.lead.stage)?.label || d.lead.stage}
                  </p>
                ))}
                <p style={{ margin: "4px 0" }}>Are you sure you want to create another lead?</p>
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button style={styles.cancelButton} onClick={() => setConfirmingDuplicate(false)}>
                    Cancel
                  </button>
                  <button style={styles.saveButton} onClick={attemptSave}>
                    Create anyway
                  </button>
                </div>
              </div>
            )}

            <div style={styles.modalFooter}>
              {!isNew && (
                <button style={styles.deleteButton} onClick={() => onDelete(form.id)}>
                  <TrashIcon />
                  Delete
                </button>
              )}
              <div style={{ flex: 1 }} />
              <button style={styles.cancelButton} onClick={handleCancelEdit}>
                Cancel
              </button>
              {!showLostReasons && form.stage !== "won" && form.stage !== "closed" && (
                <button style={styles.cancelButton} onClick={() => setShowLostReasons(true)}>
                  Mark lost
                </button>
              )}
              {form.stage !== "won" && form.stage !== "closed" && (
                <button style={styles.wonButton} onClick={() => onMarkWon(form)}>
                  Mark won
                </button>
              )}
              <button style={styles.saveButton} onClick={attemptSave}>
                Save lead
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function CardEditor({ card, onCancel, onSave, onDelete, isNew, onPersistShareToken, onLogExpense, hasProAccess, teamMembers = [] }) {
  const [form, setForm] = useState(card);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  const duplicateMemberNames = findDuplicateMemberNames(teamMembers);

  const handleSetStatus = (status) => {
    if (status === "revisions" && form.reviewStatus !== "revisions" && form.revisions.length === 0) {
      setForm({
        ...form,
        reviewStatus: status,
        revisions: [""],
        revisionVersion: (form.revisionVersion || 1) + 1,
      });
    } else {
      setForm({ ...form, reviewStatus: status });
    }
  };

  const addRevision = () => {
    setForm({
      ...form,
      revisions: [...form.revisions, ""],
      revisionVersion: (form.revisionVersion || 1) + 1,
    });
  };

  const updateRevisionText = (index, text) => {
    setForm({
      ...form,
      revisions: form.revisions.map((r, i) => (i === index ? text : r)),
    });
  };

  const [copied, setCopied] = useState(false);
  const handleCopyFileName = async () => {
    const name = shotFileName(form);
    try {
      await navigator.clipboard.writeText(name);
    } catch (e) {
      // clipboard API unavailable, fall back to a manual select prompt
      window.prompt("Copy the file name:", name);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const [linkCopied, setLinkCopied] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const fileInputRef = useRef(null);

  const handleGenerateShareLink = async () => {
    const token = form.shareToken || genShareToken();
    setForm({ ...form, shareToken: token });
    if (onPersistShareToken) {
      await onPersistShareToken(form.id, token);
    }
  };

  const shareUrl = form.shareToken
    ? `${window.location.origin}${window.location.pathname}?share=shot&token=${form.shareToken}`
    : "";

  const handleCopyShareLink = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch (e) {
      window.prompt("Copy the freelancer link:", shareUrl);
    }
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 1500);
  };

  const handleFileSelected = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploadError("");
    setUploading(true);
    try {
      if (!form.id) throw new Error("Save the shot before adding attachments.");
      const {
        data: { session: currentSession },
      } = await supabase.auth.getSession();
      if (!currentSession) throw new Error("Not signed in");

      const body = new FormData();
      body.append("projectId", form.projectId);
      if (form.id) body.append("shotId", form.id);
      body.append("file", file);

      const res = await fetch(functionUrl("studio-drive-upload"), {
        method: "POST",
        headers: { Authorization: `Bearer ${currentSession.access_token}` },
        body,
      });
      const result = await res.json();
      if (!res.ok || !result?.success) {
        if (result?.error === "not_connected") {
          throw new Error(result?.message || "Connect Google Drive and create this project's folders first (from the project card), then try again.");
        }
        throw new Error(result?.error || "Upload failed");
      }

      const newAttachment = { name: result.name, url: result.url, driveFileId: result.driveFileId };
      const nextAttachments = [...(form.attachments || []), newAttachment];
      setForm({ ...form, attachments: nextAttachments });
      // studio-drive-upload already persisted the attachment atomically via
      // append_shot_file - a follow-up whole-array write from this local
      // snapshot is exactly the read-modify-write race append_shot_file
      // was built to avoid (e.g. a second upload, or the same shot open in
      // another tab, landing between this upload's request and response).
      // The local setForm above is enough for this session's own UI; nothing
      // else here needs to re-persist attachments.
    } catch (err) {
      console.error("Upload failed:", err);
      setUploadError(err.message || "Upload failed");
    }
    setUploading(false);
  };

  const removeAttachment = async (index) => {
    const target = form.attachments[index];
    const nextAttachments = form.attachments.filter((_, i) => i !== index);
    setForm({ ...form, attachments: nextAttachments });
    // Same race as the upload path: writing the whole (locally-snapshotted)
    // array back would silently drop anything appended by a concurrent
    // upload since this editor loaded. remove_shot_file matches and
    // removes by url in a single atomic UPDATE instead.
    //
    // For Drive-backed attachments this needs to go through the
    // studio-drive-delete edge function rather than calling remove_shot_file
    // directly - calling the RPC alone only dropped the metadata entry and
    // left the actual file sitting in Drive forever ("Attachment removed"
    // in the UI while the file quietly stuck around). The edge function
    // trashes the Drive file (when there is one) and then performs the same
    // metadata removal server-side.
    if (form.id && target?.url) {
      try {
        const {
          data: { session: currentSession },
        } = await supabase.auth.getSession();
        if (!currentSession) throw new Error("Not signed in");
        const res = await fetch(functionUrl("studio-drive-delete"), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${currentSession.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ shotId: form.id, driveFileId: target.driveFileId || null, url: target.url }),
        });
        const result = await res.json();
        if (!res.ok || !result?.success) throw new Error(result?.error || "Couldn't remove attachment");
      } catch (err) {
        console.error("Removing attachment failed:", err);
      }
    }
  };

  return (
    <div style={styles.overlay} onClick={onCancel}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <span style={styles.modalTitle}>{isNew ? "New shot" : "Edit shot"}</span>
          <button style={styles.iconButton} onClick={onCancel}>
            <CloseIcon />
          </button>
        </div>

        <div style={styles.field}>
          <label style={styles.label}>Shot name</label>
          <input
            style={styles.input}
            value={form.title}
            onChange={set("title")}
            placeholder="e.g. Trailer opening pan"
            autoFocus
          />
        </div>

        <div style={styles.fieldRow}>
          <div style={styles.field}>
            <label style={styles.label}>Client</label>
            <input
              style={styles.input}
              value={form.client}
              onChange={set("client")}
              placeholder="e.g. Vicente Carro"
            />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Rate</label>
            <input
              style={styles.input}
              value={form.rate}
              onChange={set("rate")}
              placeholder="e.g. $300"
            />
          </div>
        </div>

        <div style={styles.fieldRow}>
          <div style={styles.field}>
            <label style={styles.label}>Due date</label>
            <input
              style={styles.input}
              value={form.due}
              onChange={set("due")}
              placeholder="e.g. Jul 12"
            />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Priority</label>
            <select style={styles.input} value={form.priority} onChange={set("priority")}>
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="rush">Rush</option>
            </select>
          </div>
        </div>

        <div style={styles.field}>
          <label style={styles.label}>Notes</label>
          <textarea
            style={styles.textarea}
            value={form.notes}
            onChange={set("notes")}
            placeholder="Specs, revision notes, reference links..."
            rows={3}
          />
        </div>

        <div style={styles.fieldDivider}>Client Review</div>
        <div style={styles.reviewStatusRow}>
          {REVIEW_STATUS_ORDER.map((status) => {
            const active = form.reviewStatus === status;
            return (
              <button
                key={status}
                type="button"
                style={{
                  ...styles.reviewStatusButton,
                  borderColor: active ? REVIEW_COLORS[status] : border,
                  color: active ? REVIEW_COLORS[status] : textMuted,
                  background: active ? `${REVIEW_COLORS[status]}1a` : "transparent",
                }}
                onClick={() => handleSetStatus(status)}
              >
                <span style={{ ...styles.reviewDot, background: REVIEW_COLORS[status] }} />
                {REVIEW_LABELS[status]}
              </button>
            );
          })}
        </div>
        <div style={styles.fileNameRow}>
          <span style={styles.fieldHint}>{shotFileName(form)}</span>
          <button type="button" style={styles.copyButton} onClick={handleCopyFileName}>
            <CopyIcon />
            {copied ? "Copied" : "Copy"}
          </button>
        </div>

        {form.reviewStatus === "revisions" && (
          <div style={styles.field}>
            <label style={styles.label}>Revisions requested</label>
            {form.revisions.map((text, i) => (
              <textarea
                key={i}
                style={{ ...styles.textarea, marginBottom: 6 }}
                value={text}
                onChange={(e) => updateRevisionText(i, e.target.value)}
                placeholder={`Revision ${i + 1} notes...`}
                rows={2}
              />
            ))}
            <button type="button" style={styles.addRevisionButton} onClick={addRevision}>
              <PlusIcon />
              Add another revision
            </button>
          </div>
        )}

        <div style={styles.fieldDivider}>Freelancer</div>

        <div style={styles.field}>
          <label style={styles.label}>Assigned to</label>
          <select
            style={styles.input}
            value={form.assignedMemberId || ""}
            onChange={(e) => {
              const member = teamMembers.find((tm) => tm.id === e.target.value);
              setForm({
                ...form,
                assignedMemberId: member?.id || "",
                assignedTo: member?.name || "",
                // Prefill the pay field from the member's current rate, but
                // only when the field is still empty - once a project-
                // specific rate has been entered (by the user, or by an
                // earlier prefill they may have already edited), switching
                // the assigned member again must never silently overwrite
                // it. A later change to the member's own rate can't touch
                // this shot's assignedPay either way, since it's stored
                // here rather than looked up live (brief §10 / §31).
                assignedPay:
                  parseMoney(form.assignedPay) > 0
                    ? form.assignedPay
                    : member?.rateAmount
                    ? String(member.rateAmount)
                    : form.assignedPay,
              });
            }}
          >
            <option value="">Unassigned</option>
            {teamMembers
              /* Archived members drop out of the normal assignment picker,
                 but if this shot is already assigned to one, keep that
                 option visible so the field doesn't silently blank out. */
              .filter((tm) => tm.status !== "archived" || tm.id === form.assignedMemberId)
              .map((tm) => (
                <option key={tm.id} value={tm.id}>
                  {disambiguatedMemberLabel(tm, duplicateMemberNames)}
                  {!duplicateMemberNames.has((tm.name || "").trim().toLowerCase()) && tm.role ? ` � ${tm.role}` : ""}
                  {tm.status === "archived" ? " (archived)" : ""}
                </option>
              ))}
          </select>
        </div>

        <div style={styles.fieldRow}>
          <div style={styles.field}>
            <label style={styles.label}>Payment amount</label>
            <input
              style={styles.input}
              value={form.assignedPay || ""}
              onChange={set("assignedPay")}
              placeholder="e.g. 40"
            />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Status</label>
            {form.assignedPaid ? (
              <p style={{ ...styles.fieldHint, color: "#3DDC84" }}>Paid</p>
            ) : (
              <button
                type="button"
                style={styles.addRevisionButton}
                disabled={!form.assignedTo || !parseMoney(form.assignedPay) || isNew}
                onClick={async () => {
                  await onLogExpense(form);
                  setForm({ ...form, assignedPaid: true });
                }}
              >
                Log as expense
              </button>
            )}
          </div>
        </div>
        {isNew && form.assignedPay && (
          <p style={styles.fieldHint}>Save this shot first before logging the payment as an expense.</p>
        )}

        <div style={styles.fieldDivider}>
          Freelancer link <span style={styles.proBadge}>PRO</span>
        </div>
        {!hasProAccess ? (
          <ProUpgradePrompt feature="Freelancer links" inline />
        ) : isNew ? (
          <p style={styles.fieldHint}>Save this shot first, then a freelancer link can be generated.</p>
        ) : !form.shareToken ? (
          <button type="button" style={styles.addRevisionButton} onClick={handleGenerateShareLink}>
            <PlusIcon />
            Generate freelancer link
          </button>
        ) : (
          <div style={styles.fileNameRow}>
            <span style={{ ...styles.fieldHint, wordBreak: "break-all" }}>{shareUrl}</span>
            <button type="button" style={styles.copyButton} onClick={handleCopyShareLink}>
              <CopyIcon />
              {linkCopied ? "Copied" : "Copy"}
            </button>
          </div>
        )}

        <div style={styles.fieldDivider}>Attachments</div>

        {(form.attachments || []).length === 0 && (
          <p style={styles.fieldHint}>No files attached yet.</p>
        )}
        {(form.attachments || []).map((file, i) => (
          <div key={i} style={styles.fileNameRow}>
            <a href={file.url} target="_blank" rel="noreferrer" style={{ ...styles.fieldHint, color: teal }}>
              {file.name}
            </a>
            <button type="button" style={styles.iconButton} onClick={() => removeAttachment(i)}>
              <TrashIcon />
            </button>
          </div>
        ))}

        {isNew ? (
          <p style={styles.fieldHint}>Save this shot first, then you can add attachments.</p>
        ) : (
          <>
            <input
              ref={fileInputRef}
              type="file"
              style={{ display: "none" }}
              onChange={handleFileSelected}
            />
            <button
              type="button"
              style={styles.addRevisionButton}
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              <PlusIcon />
              {uploading ? "Uploading..." : "Add attachment"}
            </button>
            {uploadError && <p style={{ ...styles.fieldHint, color: "#FF4D4D" }}>{uploadError}</p>}
          </>
        )}

        {(form.deliverables || []).length > 0 && (
          <>
            <div style={styles.fieldDivider}>Freelancer submissions</div>
            {form.deliverables.map((file, i) => (
              <div key={i} style={styles.fileNameRow}>
                <a href={file.url} target="_blank" rel="noreferrer" style={{ ...styles.fieldHint, color: teal }}>
                  {file.name}
                </a>
                <span style={styles.fieldHint}>
                  {file.uploadedAt ? new Date(file.uploadedAt).toLocaleString() : ""}
                </span>
              </div>
            ))}
          </>
        )}

        <div style={styles.modalFooter}>
          {!isNew && (
            <button style={styles.deleteButton} onClick={() => onDelete(form.id)}>
              <TrashIcon />
              Delete
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button style={styles.cancelButton} onClick={onCancel}>
            Cancel
          </button>
          <button
            style={styles.saveButton}
            onClick={() => onSave({ ...form, title: form.title || "Untitled shot" })}
          >
            Save shot
          </button>
        </div>
      </div>
    </div>
  );
}

function ExpenseEditor({ expense, projects, onCancel, onSave, onDelete, isNew }) {
  const [form, setForm] = useState(expense);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  return (
    <div style={styles.overlay} onClick={onCancel}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <span style={styles.modalTitle}>{isNew ? "New expense" : "Edit expense"}</span>
          <button style={styles.iconButton} onClick={onCancel}>
            <CloseIcon />
          </button>
        </div>

        <div style={styles.field}>
          <label style={styles.label}>Category</label>
          <select style={styles.input} value={form.category} onChange={set("category")}>
            {EXPENSE_CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>
        </div>

        <div style={styles.field}>
          <label style={styles.label}>Project (optional)</label>
          <select
            style={styles.input}
            value={form.projectId || ""}
            onChange={(e) => setForm({ ...form, projectId: e.target.value || null })}
          >
            <option value="">General studio expense</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div style={styles.field}>
          <label style={styles.label}>Description</label>
          <input
            style={styles.input}
            value={form.description}
            onChange={set("description")}
            placeholder="e.g. CSP license renewal"
          />
        </div>

        <div style={styles.fieldRow}>
          <div style={styles.field}>
            <label style={styles.label}>Amount</label>
            <input
              style={styles.input}
              value={form.amount}
              onChange={set("amount")}
              placeholder="e.g. 50"
            />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Currency</label>
            <select style={styles.input} value={form.currency || "$"} onChange={set("currency")}>
              {CURRENCIES.map((c) => (
                <option key={c.code} value={c.symbol}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div style={styles.field}>
          <label style={styles.label}>Date</label>
          <input style={styles.input} type="date" value={form.date || ""} onChange={set("date")} />
        </div>

        <div style={styles.modalFooter}>
          {!isNew && (
            <button style={styles.deleteButton} onClick={() => onDelete(form.id)}>
              <TrashIcon />
              Delete
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button style={styles.cancelButton} onClick={onCancel}>
            Cancel
          </button>
          <button style={styles.saveButton} onClick={() => onSave(form)}>
            Save expense
          </button>
        </div>
      </div>
    </div>
  );
}

// Full-page Planner workspace (replaces the old pop-out editor). Organized
// into visually distinct sections rather than one long form, per the
// planner_ui.txt architecture spec. Financial summary stays visible near
// the top while the rest of the sections are worked on below it.
function PlannerWorkspace({
  plan, isNew, settings, hasProAccess, templates, projects, teamMembers,
  onSave, onDelete, onDuplicate, onSaveAsTemplate, onConvertToProject, onClose,
}) {
  const [form, setForm] = useState(plan);
  const [showWarnings, setShowWarnings] = useState(false);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  const setPreset = (percent) => setForm({ ...form, targetProfitPercent: percent });
  const duplicateMemberNames = findDuplicateMemberNames(teamMembers || []);
  const [showStaleFor, setShowStaleFor] = useState(null); // crew row id currently showing its roster-diff panel

  const setDept = (deptId) => (e) => {
    setForm({
      ...form,
      departmentAllocations: { ...(form.departmentAllocations || {}), [deptId]: e.target.value },
    });
  };

  const setScope = (key) => (e) => {
    const value = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    setForm({ ...form, scope: { ...(form.scope || {}), [key]: value } });
  };

  const addCrewMember = () => {
    setForm({
      ...form,
      crew: [
        ...(form.crew || []),
        {
          id: `c${Date.now()}`,
          name: "",
          role: "",
          department: PLANNER_DEPARTMENTS[0].id,
          rateType: "per_shot",
          rate: "",
          units: "",
          skillLevel: 3,
          dependability: 75,
          availability: "available",
          capacityUnits: "",
        },
      ],
    });
  };
  const updateCrewMember = (idx, key, value) => {
    const next = [...form.crew];
    next[idx] = { ...next[idx], [key]: value };
    setForm({ ...form, crew: next });
  };
  const removeCrewMember = (idx) => {
    setForm({ ...form, crew: form.crew.filter((_, i) => i !== idx) });
  };
  const addCrewMemberFromRoster = (teamMemberId) => {
    const tm = (teamMembers || []).find((m) => m.id === teamMemberId);
    if (!tm) return;
    setForm({ ...form, crew: [...(form.crew || []), crewRowFromTeamMember(tm)] });
  };

  const calc = computeBudgetPlan(form);
  const cur = form.currency || "$";
  const intel = computePlannerIntelligence(form);
  const healthColor = intel.financial.state === "green" ? "#3DDC84" : intel.financial.state === "yellow" ? "#F2A65A" : "#FF4D4D";
  const healthLabel = intel.financial.state === "green" ? "Healthy" : intel.financial.state === "yellow" ? "Tight" : "Critical";
  const allocation = intel.allocation;
  const convertedProject = form.convertedProjectId ? projects.find((p) => p.id === form.convertedProjectId) : null;

  // Sort red before yellow so a genuinely critical warning can't get
  // pushed past the top-3 cutoff just because it happens to be pushed
  // later in computePlannerIntelligence's fixed sequence than several
  // yellow ones - push-order isn't the same as priority-order.
  const topWarnings = [...intel.warnings].sort((a, b) => (a.level === "red" ? 0 : 1) - (b.level === "red" ? 0 : 1)).slice(0, 3);
  const restWarnings = intel.warnings.slice(3);

  return (
    <div style={styles.invoicesWrap}>
      {/* Project Information */}
      <div style={styles.plannerSection}>
        <div style={styles.plannerSectionTitle}>Project</div>
        <div style={styles.field}>
          <label style={styles.label}>Plan name</label>
          <input style={styles.input} value={form.name} onChange={set("name")} placeholder="e.g. 15s Anime Trailer" autoFocus />
        </div>
        <div style={styles.fieldRow}>
          <div style={styles.field}>
            <label style={styles.label}>Client name</label>
            <input style={styles.input} value={form.clientName} onChange={set("clientName")} placeholder="Optional" />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Project type</label>
            <input style={styles.input} value={form.projectType} onChange={set("projectType")} placeholder="e.g. Trailer" />
          </div>
        </div>
        <div style={styles.fieldRow}>
          <div style={styles.field}>
            <label style={styles.label}>Start date</label>
            <input type="date" style={styles.input} value={form.startDate || ""} onChange={set("startDate")} />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Deadline</label>
            <input type="date" style={styles.input} value={form.deadline || ""} onChange={set("deadline")} />
          </div>
        </div>
        <div style={styles.field}>
          <label style={styles.label}>Status</label>
          <div style={styles.reviewStatusRow}>
            {PLANNER_STATUSES.filter((s) => s.id !== "converted" || form.status === "converted").map((s) => (
              <button
                key={s.id}
                type="button"
                style={{ ...styles.reviewStatusButton, ...(form.status === s.id ? { borderColor: teal, color: teal } : {}) }}
                onClick={() => setForm({ ...form, status: s.id })}
                disabled={s.id === "converted"}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Intelligence panel */}
      <div style={{ ...styles.plannerSection, borderColor: `${healthColor}55` }}>
        <div style={styles.plannerSectionTitle}>Planner Intelligence</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
          <span style={{ ...styles.budgetStatValue, color: healthColor }}>{intel.dealScore.score} — {intel.dealScore.label}</span>
          <span style={{ ...styles.fieldHint, color: healthColor }}>{healthLabel} margin · {intel.financial.actualMargin.toFixed(1)}%</span>
        </div>
        {topWarnings.length === 0 ? (
          <p style={styles.fieldHint}>No issues detected against your current inputs.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {topWarnings.map((w, i) => (
              <p key={i} style={{ ...styles.fieldHint, color: w.level === "red" ? "#FF4D4D" : "#F2A65A" }}>
                {w.level === "red" ? "\u{1F534}" : "\u{1F7E1}"} {w.text}
              </p>
            ))}
          </div>
        )}
        {restWarnings.length > 0 && (
          <button type="button" style={{ ...styles.fieldHint, background: "none", border: "none", cursor: "pointer", color: teal, padding: 0, marginTop: 4 }} onClick={() => setShowWarnings((v) => !v)}>
            {showWarnings ? "Show less" : `+${restWarnings.length} more`}
          </button>
        )}
        {showWarnings && restWarnings.map((w, i) => (
          <p key={i} style={{ ...styles.fieldHint, color: w.level === "red" ? "#FF4D4D" : "#F2A65A" }}>
            {w.level === "red" ? "\u{1F534}" : "\u{1F7E1}"} {w.text}
          </p>
        ))}
      </div>

      {/* Financial Summary + Profit Target */}
      <div style={styles.plannerSection}>
        <div style={styles.plannerSectionTitle}>Financial Summary</div>
        <div style={styles.fieldRow}>
          <div style={styles.field}>
            <label style={styles.label}>Budget</label>
            <input style={styles.input} value={form.budget} onChange={set("budget")} placeholder="e.g. 5000" />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Currency</label>
            <select style={styles.input} value={form.currency || "$"} onChange={set("currency")}>
              {CURRENCIES.map((c) => (<option key={c.code} value={c.symbol}>{c.label}</option>))}
            </select>
          </div>
        </div>
        <div style={styles.field}>
          <label style={styles.label}>Target profit</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            {PROFIT_PRESETS.map((p) => (
              <button key={p} type="button" style={{ ...styles.tabButton, ...(Number(form.targetProfitPercent) === p ? styles.tabButtonActive : {}) }} onClick={() => setPreset(p)}>
                {p}%{p === 25 ? " (recommended)" : ""}
              </button>
            ))}
          </div>
          <input style={styles.input} value={form.targetProfitPercent} onChange={set("targetProfitPercent")} placeholder="Custom %" />
        </div>
        <div style={styles.field}>
          <label style={styles.label}>Contingency reserve %</label>
          <input style={styles.input} value={form.contingencyPercent} onChange={set("contingencyPercent")} placeholder={`Recommended ${intel.contingency.recommended}%`} />
          <p style={{ ...styles.fieldHint, color: intel.contingency.state === "none" ? "#FF4D4D" : intel.contingency.state === "below" ? "#F2A65A" : undefined }}>
            {intel.contingency.state === "none" && "No contingency reserve — any revision or issue reduces profit directly."}
            {intel.contingency.state === "below" && `Below the ${intel.contingency.recommended}% recommended for this project's complexity.`}
            {intel.contingency.state === "ok" && `At or above the ${intel.contingency.recommended}% recommended level.`}
          </p>
        </div>
        <div style={styles.budgetSummaryRow}>
          <div style={styles.budgetStat}>
            <span style={styles.label}>Production budget</span>
            <span style={styles.budgetStatValue}>{cur}{formatMoney(calc.productionBudget)}</span>
          </div>
          <div style={styles.budgetStat}>
            <span style={styles.label}>Expected profit</span>
            <span style={{ ...styles.budgetStatValue, color: healthColor }}>{cur}{formatMoney(calc.profit)}</span>
          </div>
          <div style={styles.budgetStat}>
            <span style={styles.label}>Crew cost so far</span>
            <span style={styles.budgetStatValue}>{cur}{formatMoney(intel.totalCrewCost)}</span>
          </div>
          <div style={styles.budgetStat}>
            <span style={styles.label}>Margin after crew costs</span>
            <span style={{ ...styles.budgetStatValue, color: healthColor }}>{intel.financial.actualMargin.toFixed(1)}%</span>
          </div>
        </div>
        {intel.minimumPrice !== null && (
          <p style={styles.fieldHint}>
            Estimated minimum project price at this margin: <strong>{cur}{formatMoney(intel.minimumPrice)}</strong> (estimate based on current assumptions).
          </p>
        )}
        <p style={styles.fieldHint}>
          "Margin after crew costs" only subtracts planned crew spend from
          the budget - it doesn't yet account for backgrounds, software,
          outsourcing, or other production expenses, so treat it as a
          floor on your real margin, not the final number.
        </p>
      </div>

      {/* Department Budget */}
      <div style={styles.plannerSection}>
        <div style={styles.plannerSectionTitle}>Department Budget</div>
        <p style={styles.fieldHint}>Percent of the {cur}{formatMoney(calc.productionBudget)} production budget. Override any row.</p>
        {PLANNER_DEPARTMENTS.map((dept) => {
          const pct = parseMoney((form.departmentAllocations || {})[dept.id]);
          const amount = (pct / 100) * calc.productionBudget;
          return (
            <div key={dept.id} style={styles.plannerDeptRow}>
              <span style={{ flex: 1 }}>{dept.label}</span>
              <input
                style={{ ...styles.input, width: 70 }}
                value={(form.departmentAllocations || {})[dept.id] ?? ""}
                onChange={setDept(dept.id)}
              />
              <span style={{ ...styles.fieldHint, width: 90, textAlign: "right" }}>{cur}{formatMoney(amount)}</span>
            </div>
          );
        })}
        <div style={{ ...styles.plannerDeptRow, fontWeight: 600 }}>
          <span style={{ flex: 1 }}>Allocated</span>
          <span style={{ width: 70, textAlign: "center" }}>{allocation.totalPercent}%</span>
          <span
            style={{
              ...styles.fieldHint, width: 90, textAlign: "right",
              color: allocation.state === "over" ? "#FF4D4D" : allocation.state === "under" ? "#F2A65A" : "#3DDC84",
            }}
          >
            {allocation.state === "over" && `Over by ${allocation.diffPercent.toFixed(1)}%`}
            {allocation.state === "under" && `${allocation.diffPercent.toFixed(1)}% unallocated`}
            {allocation.state === "exact" && "Fully allocated"}
          </span>
        </div>
      </div>

      {/* Crew */}
      {!hasProAccess ? (
        <div style={styles.plannerSection}>
          <div style={styles.plannerSectionTitle}>Crew / Person Costs</div>
          <ProUpgradePrompt feature="Crew cost planning" inline />
        </div>
      ) : (
        <div style={styles.plannerSection}>
          <div style={styles.plannerSectionTitle}>Crew / Person Costs</div>
          {(form.crew || []).map((person, idx) => {
            const cost = computeCrewMemberCost(person);
            const fitEntry = intel.crewFit.find((c) => c.person === person) || { fit: computeCrewMemberFit(person, intel.deadlineRisk.state) };
            const fit = fitEntry.fit;
            const capacityBad = fit.capacity.state === "over";
            return (
              <div key={person.id || idx} style={{ borderBottom: "1px solid rgba(127,224,208,0.08)", padding: "8px 0" }}>
                <div style={styles.plannerCrewRow}>
                  <input style={{ ...styles.input, flex: 1 }} placeholder="Name" value={person.name} onChange={(e) => updateCrewMember(idx, "name", e.target.value)} />
                  <input style={{ ...styles.input, flex: 1 }} placeholder="Role" value={person.role} onChange={(e) => updateCrewMember(idx, "role", e.target.value)} />
                  <select style={{ ...styles.input, width: 150, ...(person.department === "unmapped" ? { borderColor: "#F2A65A" } : {}) }} value={person.department} onChange={(e) => updateCrewMember(idx, "department", e.target.value)}>
                    {person.department === "unmapped" && (
                      <option value="unmapped">{"Unmapped \u2014 pick a department"}</option>
                    )}
                    {PLANNER_DEPARTMENTS.map((d) => (<option key={d.id} value={d.id}>{d.label}</option>))}
                  </select>
                  <select style={{ ...styles.input, width: 120 }} value={person.rateType} onChange={(e) => updateCrewMember(idx, "rateType", e.target.value)}>
                    {CREW_RATE_TYPES.map((r) => (<option key={r.id} value={r.id}>{r.label}</option>))}
                  </select>
                  <input style={{ ...styles.input, width: 80 }} placeholder="Rate" value={person.rate} onChange={(e) => updateCrewMember(idx, "rate", e.target.value)} />
                  {person.rateType !== "fixed" && (
                    <input style={{ ...styles.input, width: 70 }} placeholder="Units" value={person.units} onChange={(e) => updateCrewMember(idx, "units", e.target.value)} />
                  )}
                  <span style={{ ...styles.fieldHint, width: 90, textAlign: "right" }}>{cur}{formatMoney(cost)}</span>
                  <button type="button" style={styles.iconButton} onClick={() => removeCrewMember(idx)}><TrashIcon /></button>
                </div>
                <div style={styles.plannerCrewRow}>
                  <select style={{ ...styles.input, width: 130 }} value={person.skillLevel ?? 3} onChange={(e) => updateCrewMember(idx, "skillLevel", e.target.value)}>
                    {SKILL_LEVELS.map((s) => (<option key={s.value} value={s.value}>{s.label}</option>))}
                  </select>
                  <div style={styles.field}>
                    <input
                      style={{ ...styles.input, width: 90 }}
                      placeholder="Dependability"
                      value={person.dependability ?? ""}
                      onChange={(e) => updateCrewMember(idx, "dependability", e.target.value)}
                      title="Dependability score, 0-100"
                    />
                  </div>
                  <select style={{ ...styles.input, width: 160 }} value={person.availability || "available"} onChange={(e) => updateCrewMember(idx, "availability", e.target.value)}>
                    {CREW_AVAILABILITY_OPTIONS.map((a) => (<option key={a.id} value={a.id}>{a.label}</option>))}
                  </select>
                  <input
                    style={{ ...styles.input, width: 100 }}
                    placeholder="Max capacity"
                    value={person.capacityUnits ?? ""}
                    onChange={(e) => updateCrewMember(idx, "capacityUnits", e.target.value)}
                    title="Maximum units this person can take on for this plan"
                  />
                  <span style={{ ...styles.fieldHint, color: capacityBad ? "#FF4D4D" : undefined }}>
                    Fit score {fit.score} {"\u00b7"} {fit.dependabilityInfo.label}
                    {capacityBad && ` \u00b7 \u{1F534} over capacity by ${fit.capacity.overBy}`}
                    {person.teamMemberId && ` \u00b7 linked to roster`}
                  </span>
                </div>
                {person.department === "unmapped" && (
                  <div style={{ ...styles.fieldHint, color: "#F2A65A", marginTop: 2 }}>
                    {"No matching Planner department for this person's Team department \u2014 pick one above so they show up correctly in department-level totals."}
                  </div>
                )}
                {(() => {
                  const staleness = computeCrewStaleness(person, teamMembers);
                  if (!staleness) return null;
                  return (
                    <>
                      {staleness.archived && (
                        <div style={{ ...styles.fieldHint, marginTop: 2 }}>
                          This person has since been archived on the roster &mdash; they stay on this plan as-is.
                        </div>
                      )}
                      {staleness.diffs.length > 0 && (
                        <div style={{ marginTop: 2 }}>
                          <button
                            type="button"
                            style={{ ...styles.fieldHint, background: "none", border: "none", padding: 0, color: "#F2A65A", cursor: "pointer", textDecoration: "underline" }}
                            onClick={() => setShowStaleFor(showStaleFor === person.id ? null : person.id)}
                          >
                            Roster data has changed since this plan was created ({staleness.diffs.length})
                          </button>
                          {showStaleFor === person.id && (
                            <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 4 }}>
                              {staleness.diffs.map((d) => (
                                <div key={d.field} style={{ ...styles.invoiceAmountsRow }}>
                                  <span style={styles.fieldHint}>
                                    {d.label}: this plan has "{String(person[d.field] ?? "")}", roster now says "{String(d.newValue)}"
                                  </span>
                                  <button
                                    type="button"
                                    style={styles.tabButton}
                                    onClick={() => updateCrewMember(idx, d.field, d.newValue)}
                                  >
                                    Use roster value
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            );
          })}
          <button type="button" style={styles.tabButton} onClick={addCrewMember}>
            <PlusIcon /> Add crew member
          </button>
          {(teamMembers || []).length > 0 && (
            <select
              style={{ ...styles.input, width: 220, marginLeft: 8 }}
              value=""
              onChange={(e) => {
                if (e.target.value) addCrewMemberFromRoster(e.target.value);
                e.target.value = "";
              }}
            >
              <option value="">+ Add from Team roster…</option>
              {teamMembers
                // Archived members must not be offered when adding new
                // crew to a plan (they can still exist inside historical
                // Planner snapshots already saved before archiving).
                .filter((tm) => tm.status !== "archived")
                .map((tm) => (
                  <option key={tm.id} value={tm.id}>
                    {disambiguatedMemberLabel(tm, duplicateMemberNames)}
                    {!duplicateMemberNames.has((tm.name || "").trim().toLowerCase()) && tm.role ? ` · ${tm.role}` : ""}
                  </option>
                ))}
            </select>
          )}
          <div style={styles.budgetSummaryRow}>
            <div style={styles.budgetStat}>
              <span style={styles.label}>Total crew cost</span>
              <span style={styles.budgetStatValue}>{cur}{formatMoney(intel.totalCrewCost)}</span>
            </div>
            <div style={styles.budgetStat}>
              <span style={styles.label}>Crew cost ratio</span>
              <span style={{ ...styles.budgetStatValue, color: intel.crewCostRatio.state === "critical" ? "#FF4D4D" : intel.crewCostRatio.state === "watch" ? "#F2A65A" : "#3DDC84" }}>
                {intel.crewCostRatio.ratio.toFixed(0)}% of production budget
              </span>
            </div>
          </div>
          {intel.departmentSpend.filter((d) => d.crewCost > 0 && d.state !== "ok").map((d) => (
            <p key={d.id} style={{ ...styles.fieldHint, color: d.state === "over" ? "#FF4D4D" : "#F2A65A" }}>
              {d.state === "over"
                ? `Crew costs exceed the ${d.label} allocation by ${cur}${formatMoney(d.crewCost - d.allocatedAmount)}.`
                : `${d.label} has very little budget remaining for other expenses.`}
            </p>
          ))}
        </div>
      )}

      {/* Production Scope + Timeline */}
      {!hasProAccess ? (
        <div style={styles.plannerSection}>
          <div style={styles.plannerSectionTitle}>Production Scope & Timeline</div>
          <ProUpgradePrompt feature="Timeline estimation" inline />
        </div>
      ) : (
        <div style={styles.plannerSection}>
          <div style={styles.plannerSectionTitle}>Production Scope</div>
          <div style={styles.fieldRow}>
            <div style={styles.field}>
              <label style={styles.label}>Duration (seconds)</label>
              <input style={styles.input} value={form.scope?.durationSeconds || ""} onChange={setScope("durationSeconds")} />
            </div>
            <div style={styles.field}>
              <label style={styles.label}>Estimated shots</label>
              <input style={styles.input} value={form.scope?.estimatedShots || ""} onChange={setScope("estimatedShots")} />
            </div>
          </div>
          <div style={styles.fieldRow}>
            <div style={styles.field}>
              <label style={styles.label}>Characters</label>
              <input style={styles.input} value={form.scope?.characters || ""} onChange={setScope("characters")} />
            </div>
            <div style={styles.field}>
              <label style={styles.label}>Backgrounds</label>
              <input style={styles.input} value={form.scope?.backgrounds || ""} onChange={setScope("backgrounds")} />
            </div>
            <div style={styles.field}>
              <label style={styles.label}>Target FPS</label>
              <input style={styles.input} value={form.scope?.targetFps || ""} onChange={setScope("targetFps")} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 10 }}>
            {[
              ["complexMovement", "Complex character movement"],
              ["heavyEffects", "Heavy effects"],
              ["cameraMovement", "Significant camera movement"],
              ["dialogueHeavy", "Dialogue-heavy"],
            ].map(([key, label]) => (
              <label key={key} style={{ ...styles.fieldHint, display: "flex", alignItems: "center", gap: 6 }}>
                <input type="checkbox" checked={!!form.scope?.[key]} onChange={setScope(key)} />
                {label}
              </label>
            ))}
          </div>
          <p style={styles.fieldHint}>
            Complexity: <strong>{intel.complexity.label}</strong> ({intel.complexity.score.toFixed(1)}){intel.complexity.factors.length > 0 && ` — ${intel.complexity.factors.join(", ")}`}
          </p>
          {intel.shotsPerSecond !== null && (
            <p style={styles.fieldHint}>Shot density: {intel.shotsPerSecond.toFixed(2)} shots/sec.</p>
          )}

          <div style={styles.fieldDivider}>Timeline (estimated starting point)</div>
          <p style={styles.fieldHint}>Estimated production: {intel.timeline.estimatedDays} days.</p>
          {intel.timeline.phases.map((phase) => (
            <div key={phase.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ ...styles.fieldHint, width: 150 }}>{phase.label}</span>
              <div style={styles.plannerTimelineTrack}>
                <div style={{ ...styles.plannerTimelineFill, width: `${Math.min(100, (phase.days / intel.timeline.estimatedDays) * 100)}%` }} />
              </div>
              <span style={{ ...styles.fieldHint, width: 46, textAlign: "right" }}>{phase.days}d</span>
            </div>
          ))}
          {intel.deadlineRisk.state !== "unknown" && (
            <p style={{ ...styles.fieldHint, marginTop: 8, color: intel.deadlineRisk.state === "risk" ? "#FF4D4D" : intel.deadlineRisk.state === "tight" ? "#F2A65A" : "#3DDC84" }}>
              {intel.deadlineRisk.state === "healthy" && `\u{1F7E2} Healthy schedule — ${intel.deadlineRisk.availableDays - intel.timeline.estimatedDays} day buffer.`}
              {intel.deadlineRisk.state === "tight" && `\u{1F7E1} Tight schedule — ${intel.deadlineRisk.availableDays - intel.timeline.estimatedDays} day(s) of buffer.`}
              {intel.deadlineRisk.state === "risk" && `\u{1F534} Deadline risk — estimated ${intel.timeline.estimatedDays} production days vs ${intel.deadlineRisk.availableDays} available.`}
            </p>
          )}
        </div>
      )}

      {/* Notes */}
      <div style={styles.plannerSection}>
        <div style={styles.plannerSectionTitle}>Notes</div>
        <textarea style={styles.textarea} rows={3} value={form.notes} onChange={set("notes")} placeholder="Anything worth remembering about this plan..." />
      </div>

      {/* Actions */}
      <div style={styles.plannerSection}>
        <div style={styles.plannerSectionTitle}>Actions</div>
        {convertedProject && (
          <p style={styles.fieldHint}>
            This plan has already been converted to project "{convertedProject.name}".
          </p>
        )}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button style={styles.saveButton} onClick={() => onSave({ ...form, name: form.name || "Untitled plan" })}>
            Save
          </button>
          {!isNew && (
            <button style={styles.tabButton} onClick={() => onDuplicate(form)}>
              Duplicate
            </button>
          )}
          {!isNew && (
            hasProAccess ? (
              <button style={styles.tabButton} onClick={() => onSaveAsTemplate(form)}>
                Save as Template
              </button>
            ) : (
              <button style={styles.tabButton} disabled title="Pro feature">
                Save as Template <span style={styles.proBadge}>PRO</span>
              </button>
            )
          )}
          {!isNew && (
            hasProAccess ? (
              <button
                style={styles.tabButton}
                disabled={!!form.convertedProjectId}
                onClick={async () => {
                  if (form.convertedProjectId) {
                    window.alert("This plan has already been converted to a project.");
                    return;
                  }
                  const result = await onConvertToProject(form);
                  if (result?.project) setForm({ ...form, status: "converted", convertedProjectId: result.project.id });
                  else if (result?.limitReached) window.alert(`Free plan is limited to ${FREE_PROJECT_LIMIT} active projects. Archive one or upgrade to Pro.`);
                  else if (result?.alreadyConverted) window.alert("This plan has already been converted to a project.");
                  else if (result?.error) window.alert(result.error.message || "Couldn't convert this plan to a project, please try again.");
                }}
              >
                {form.convertedProjectId ? "Already converted" : "Convert to Project"}
              </button>
            ) : (
              <button style={styles.tabButton} disabled title="Pro feature">
                Convert to Project <span style={styles.proBadge}>PRO</span>
              </button>
            )
          )}
          <div style={{ flex: 1 }} />
          {!isNew && (
            <button style={styles.deleteButton} onClick={() => onDelete(form.id)}>
              Delete
            </button>
          )}
          <button style={styles.cancelButton} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function TeamMemberEditor({ member, onCancel, onSave, onArchive, isNew, currencySymbol, saveError, paymentMethodOptions, teamMembers, cards, projects }) {
  const [form, setForm] = useState({ ...emptyTeamMember(), ...member });
  const [customSkill, setCustomSkill] = useState("");
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  const cur = currencySymbol || "$";

  // Payment details and rate history live in their own tables (brief
  // §9/§12) and are fetched only when this specific member's editor is
  // open - never as part of the bulk roster load - so a normal roster
  // view never even receives this data over the wire.
  const [paymentDetails, setPaymentDetails] = useState({ accountHolderName: "", paymentDetails: "" });
  const [paymentDetailsLoaded, setPaymentDetailsLoaded] = useState(false);
  const [revealPaymentDetails, setRevealPaymentDetails] = useState(false);
  const [paymentSaveState, setPaymentSaveState] = useState("idle"); // idle | saving | saved | error
  const [rateHistory, setRateHistory] = useState([]);
  const [portfolioItems, setPortfolioItems] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [addingPortfolioItem, setAddingPortfolioItem] = useState(false);
  const [newPortfolioItem, setNewPortfolioItem] = useState(emptyPortfolioItem());
  const [addingReview, setAddingReview] = useState(false);
  const [newReview, setNewReview] = useState(emptyReview());

  useEffect(() => {
    if (isNew || !member.id) return;
    let cancelled = false;
    (async () => {
      const [paymentRes, historyRes, portfolioRes, reviewsRes] = await Promise.all([
        supabase.from("team_member_payment_details").select("*").eq("team_member_id", member.id).maybeSingle(),
        supabase
          .from("team_member_rate_history")
          .select("*")
          .eq("team_member_id", member.id)
          .order("effective_date", { ascending: false }),
        supabase
          .from("team_member_portfolio_items")
          .select("*")
          .eq("team_member_id", member.id)
          .order("created_at", { ascending: false }),
        supabase
          .from("team_member_reviews")
          .select("*")
          .eq("team_member_id", member.id)
          .order("review_date", { ascending: false }),
      ]);
      if (cancelled) return;
      if (!paymentRes.error) {
        setPaymentDetails(paymentDetailsFromRow(paymentRes.data));
        setPaymentDetailsLoaded(true);
      }
      if (!historyRes.error) {
        setRateHistory((historyRes.data || []).map(rateHistoryFromRow));
      }
      if (!portfolioRes.error) {
        setPortfolioItems((portfolioRes.data || []).map(portfolioItemFromRow));
      }
      if (!reviewsRes.error) {
        setReviews((reviewsRes.data || []).map(reviewFromRow));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [member.id, isNew]);

  const savePaymentDetails = async () => {
    setPaymentSaveState("saving");
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const userId = session?.user?.id;
      const { error } = await supabase
        .from("team_member_payment_details")
        .upsert(paymentDetailsToRow(form.id, userId, paymentDetails));
      if (error) throw error;
      setPaymentSaveState("saved");
    } catch (e) {
      console.error("Saving payment details failed:", e);
      setPaymentSaveState("error");
    }
  };

  const savePortfolioItem = async () => {
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const userId = session?.user?.id;
      const { data: inserted, error } = await supabase
        .from("team_member_portfolio_items")
        .insert(portfolioItemToRow(form.id, userId, newPortfolioItem))
        .select()
        .single();
      if (error) throw error;
      setPortfolioItems([portfolioItemFromRow(inserted), ...portfolioItems]);
      setNewPortfolioItem(emptyPortfolioItem());
      setAddingPortfolioItem(false);
    } catch (e) {
      console.error("Saving portfolio item failed:", e);
    }
  };

  const deletePortfolioItem = async (id) => {
    try {
      const { error } = await supabase.from("team_member_portfolio_items").delete().eq("id", id);
      if (error) throw error;
      setPortfolioItems(portfolioItems.filter((p) => p.id !== id));
    } catch (e) {
      console.error("Deleting portfolio item failed:", e);
    }
  };

  const saveReview = async () => {
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const userId = session?.user?.id;
      const { data: inserted, error } = await supabase
        .from("team_member_reviews")
        .insert(reviewToRow(form.id, userId, newReview))
        .select()
        .single();
      if (error) throw error;
      setReviews([reviewFromRow(inserted), ...reviews]);
      setNewReview(emptyReview());
      setAddingReview(false);
    } catch (e) {
      console.error("Saving review failed:", e);
    }
  };

  const deleteReview = async (id) => {
    try {
      const { error } = await supabase.from("team_member_reviews").delete().eq("id", id);
      if (error) throw error;
      setReviews(reviews.filter((r) => r.id !== id));
    } catch (e) {
      console.error("Deleting review failed:", e);
    }
  };

  const toggleSkill = (skill) => {
    const has = (form.skills || []).includes(skill);
    setForm({
      ...form,
      skills: has ? form.skills.filter((s) => s !== skill) : [...(form.skills || []), skill],
    });
  };

  const addCustomSkill = () => {
    const trimmed = customSkill.trim();
    if (!trimmed || (form.skills || []).includes(trimmed)) {
      setCustomSkill("");
      return;
    }
    setForm({ ...form, skills: [...(form.skills || []), trimmed] });
    setCustomSkill("");
  };

  const extraSkills = (form.skills || []).filter((s) => !TEAM_SKILL_OPTIONS.includes(s));
  const dependability = dependabilityTier(form.dependabilityScore ?? 80);

  return (
    <div style={styles.overlay} onClick={onCancel}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <span style={styles.modalTitle}>{isNew ? "New team member" : "Edit team member"}</span>
          <button style={styles.iconButton} onClick={onCancel}>
            <CloseIcon />
          </button>
        </div>

        <div style={styles.field}>
          <label style={styles.label}>Name</label>
          <input
            style={styles.input}
            value={form.name}
            onChange={set("name")}
            placeholder="e.g. Kevin Otieno"
            autoFocus
          />
          <p style={styles.fieldHint}>
            Match this exactly to the "Assigned to" name on shots to link their work here.
          </p>
        </div>

        <div style={styles.fieldRow}>
          <div style={styles.field}>
            <label style={styles.label}>Role</label>
            <input
              style={styles.input}
              value={form.role}
              onChange={set("role")}
              placeholder="e.g. In-betweener"
            />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Department</label>
            <select style={styles.input} value={form.department || ""} onChange={set("department")}>
              <option value="">Unassigned</option>
              {TEAM_DEPARTMENT_OPTIONS.map((dept) => (
                <option key={dept} value={dept}>
                  {dept}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div style={styles.field}>
          <label style={styles.label}>Email</label>
          <input
            style={styles.input}
            value={form.email}
            onChange={set("email")}
            placeholder="kevin@example.com"
          />
        </div>

        <div style={styles.fieldDivider}>Skills &amp; level</div>

        <div style={styles.field}>
          <label style={styles.label}>Skills</label>
          <div style={styles.reviewStatusRow}>
            {TEAM_SKILL_OPTIONS.map((skill) => {
              const active = (form.skills || []).includes(skill);
              return (
                <button
                  key={skill}
                  type="button"
                  style={active ? { ...styles.skillChip, ...styles.skillChipActive } : styles.skillChip}
                  onClick={() => toggleSkill(skill)}
                >
                  {skill}
                </button>
              );
            })}
            {extraSkills.map((skill) => (
              <button
                key={skill}
                type="button"
                style={{ ...styles.skillChip, ...styles.skillChipActive }}
                onClick={() => toggleSkill(skill)}
              >
                {skill}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <input
              style={styles.input}
              value={customSkill}
              onChange={(e) => setCustomSkill(e.target.value)}
              placeholder="Add a custom skill..."
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addCustomSkill();
                }
              }}
            />
            <button type="button" style={styles.cancelButton} onClick={addCustomSkill}>
              Add
            </button>
          </div>
        </div>

        <div style={styles.field}>
          <label style={styles.label}>Skill level</label>
          <div style={styles.reviewStatusRow}>
            {[1, 2, 3, 4, 5].map((level) => {
              const active = Number(form.skillLevel) === level;
              return (
                <button
                  key={level}
                  type="button"
                  style={{
                    ...styles.reviewStatusButton,
                    borderColor: active ? teal : border,
                    color: active ? tealLight : textMuted,
                    background: active ? "rgba(47,191,166,0.14)" : "transparent",
                  }}
                  onClick={() => setForm({ ...form, skillLevel: level })}
                >
                  {level} &middot; {skillLevelLabel(level)}
                </button>
              );
            })}
          </div>
          <p style={styles.fieldHint}>
            A senior/expert isn't automatically the right pick for simple, repetitive work &mdash; this just
            tells the Planner what this person is capable of.
          </p>
        </div>

        <div style={styles.fieldDivider}>Rate</div>

        <div style={styles.fieldRow}>
          <div style={styles.field}>
            <label style={styles.label}>Rate type</label>
            <select style={styles.input} value={form.rateType || "hour"} onChange={set("rateType")}>
              {RATE_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Rate amount</label>
            <input
              style={styles.input}
              type="number"
              min="0"
              step="0.01"
              value={form.rateAmount || ""}
              onChange={set("rateAmount")}
              placeholder="e.g. 150"
            />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Currency</label>
            <input
              style={styles.input}
              value={form.rateCurrency || "$"}
              onChange={set("rateCurrency")}
              placeholder={cur}
            />
          </div>
        </div>
        {!isNew && rateHistory.length > 0 && (
          <div style={styles.field}>
            <label style={styles.label}>Rate history</label>
            <p style={styles.fieldHint}>
              Read-only record of past rates &mdash; changing the rate above only affects future assignments;
              it never rewrites what a past assignment was actually paid.
            </p>
            {rateHistory.slice(0, 5).map((h) => (
              <p key={h.id} style={styles.fieldHint}>
                {h.effectiveDate}: {h.rateCurrency}{formatMoney(h.rateAmount)} ({rateTypeLabel(h.rateType)})
              </p>
            ))}
          </div>
        )}
        <div style={styles.field}>
          <label style={styles.label}>Rate note (optional)</label>
          <input
            style={styles.input}
            value={form.rate}
            onChange={set("rate")}
            placeholder="e.g. negotiable, rush jobs only, $15/cut for simple inbetweens"
          />
          <p style={styles.fieldHint}>
            Used as a fallback label if no rate amount is set above, and useful for caveats the Planner
            can't calculate on its own.
          </p>
        </div>

        <div style={styles.fieldDivider}>Freelancer info</div>

        <div style={styles.fieldRow}>
          <div style={styles.field}>
            <label style={styles.label}>Member type</label>
            <select style={styles.input} value={form.memberType || "freelancer"} onChange={set("memberType")}>
              <option value="freelancer">Freelancer</option>
              <option value="internal">Internal</option>
            </select>
          </div>
        </div>
        {form.memberType === "freelancer" && (
          <>
            <div style={styles.fieldRow}>
              <div style={styles.field}>
                <label style={styles.label}>Upwork rating (0&ndash;5)</label>
                <input
                  style={styles.input}
                  type="number"
                  min="0"
                  max="5"
                  step="0.1"
                  value={form.upworkRating ?? ""}
                  onChange={set("upworkRating")}
                  placeholder="e.g. 4.8"
                />
              </div>
              <div style={styles.field}>
                <label style={styles.label}>Review count</label>
                <input
                  style={styles.input}
                  type="number"
                  min="0"
                  value={form.upworkReviewCount ?? ""}
                  onChange={set("upworkReviewCount")}
                  placeholder="e.g. 32"
                />
              </div>
            </div>\n<p style={styles.fieldHint}>
              External reputation only &mdash; kept separate from this studio's own internal performance
              rating and never blended into it.
            </p>
          </>
        )}

        <div style={styles.fieldDivider}>Payments</div>

        <div style={styles.fieldRow}>
          <div style={styles.field}>
            <label style={styles.label}>Payment method</label>
            <select style={styles.input} value={form.paymentMethod || ""} onChange={set("paymentMethod")}>
              <option value="">Not set</option>
              {(paymentMethodOptions || []).map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Payment currency</label>
            <input
              style={styles.input}
              value={form.paymentCurrency || ""}
              onChange={set("paymentCurrency")}
              placeholder={cur}
            />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Payment country</label>
            <input style={styles.input} value={form.paymentCountry || ""} onChange={set("paymentCountry")} />
          </div>
        </div>

        {isNew ? (
          <p style={styles.fieldHint}>Save this member first, then come back to add payment account details.</p>
        ) : (
          <>
            <div style={styles.field}>
              <label style={styles.label}>Account holder name</label>
              <input
                style={styles.input}
                value={paymentDetails.accountHolderName}
                onChange={(e) => setPaymentDetails({ ...paymentDetails, accountHolderName: e.target.value })}
              />
            </div>
            <div style={styles.field}>
              <label style={styles.label}>Account / phone / IBAN details</label>
              {revealPaymentDetails ? (
                <input
                  style={styles.input}
                  value={paymentDetails.paymentDetails}
                  onChange={(e) => setPaymentDetails({ ...paymentDetails, paymentDetails: e.target.value })}
                  placeholder="e.g. M-Pesa number, IBAN, PayPal email"
                  autoFocus
                />
              ) : (
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={styles.input}>
                    {paymentDetails.paymentDetails ? maskPaymentDetails(paymentDetails.paymentDetails) : "Not set"}
                  </span>
                  <button type="button" style={styles.tabButton} onClick={() => setRevealPaymentDetails(true)}>
                    {paymentDetails.paymentDetails ? "Edit" : "Add"}
                  </button>
                </div>
              )}
              <p style={styles.fieldHint}>
                Never shown on roster cards, and only fetched when this profile is opened &mdash; not as part
                of the normal roster list.
              </p>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button type="button" style={styles.tabButton} onClick={savePaymentDetails} disabled={paymentSaveState === "saving"}>
                {paymentSaveState === "saving" ? "Saving\u2026" : "Save payment details"}
              </button>
              {paymentSaveState === "saved" && <span style={styles.fieldHint}>Saved.</span>}
              {paymentSaveState === "error" && (
                <span style={{ ...styles.fieldHint, color: "#FF4D4D" }}>Failed to save &mdash; try again.</span>
              )}
            </div>
          </>
        )}

        <div style={styles.fieldDivider}>Availability &amp; capacity</div>

        <div style={styles.field}>
          <label style={styles.label}>Availability</label>
          <div style={styles.reviewStatusRow}>
            {AVAILABILITY_OPTIONS.map((status) => {
              const active = form.availability === status;
              return (
                <button
                  key={status}
                  type="button"
                  style={{
                    ...styles.reviewStatusButton,
                    borderColor: active ? AVAILABILITY_COLORS[status] : border,
                    color: active ? AVAILABILITY_COLORS[status] : textMuted,
                    background: active ? `${AVAILABILITY_COLORS[status]}1a` : "transparent",
                  }}
                  onClick={() => setForm({ ...form, availability: status })}
                >
                  {AVAILABILITY_LABELS[status]}
                </button>
              );
            })}
          </div>
        </div>

        <div style={styles.fieldRow}>
          <div style={styles.field}>
            <label style={styles.label}>Available from</label>
            <input
              style={styles.input}
              type="date"
              value={form.availableStartDate || ""}
              onChange={set("availableStartDate")}
            />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Available until</label>
            <input
              style={styles.input}
              type="date"
              value={form.availableEndDate || ""}
              onChange={set("availableEndDate")}
            />
          </div>
        </div>

        <div style={styles.fieldRow}>
          <div style={styles.field}>
            <label style={styles.label}>Max workload</label>
            <input
              style={styles.input}
              type="number"
              min="0"
              value={form.capacityValue || ""}
              onChange={set("capacityValue")}
              placeholder="e.g. 30"
            />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Capacity unit</label>
            <select style={styles.input} value={form.capacityUnit || "hours/week"} onChange={set("capacityUnit")}>
              {CAPACITY_UNIT_OPTIONS.map((unit) => (
                <option key={unit} value={unit}>
                  {unit}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div style={styles.fieldDivider}>Dependability &amp; speed</div>

        <div style={styles.field}>
          <label style={styles.label}>Dependability score (0-100)</label>
          <input
            style={styles.input}
            type="number"
            min="0"
            max="100"
            value={form.dependabilityScore ?? ""}
            onChange={set("dependabilityScore")}
            placeholder="e.g. 85"
          />
          <p style={{ ...styles.fieldHint, color: dependability.color }}>
            {dependability.label} &middot; 90-100 highly dependable, 75-89 reliable, 60-74 variable, below 60
            risky.
          </p>
        </div>

        <div style={styles.fieldRow}>
          <div style={styles.field}>
            <label style={styles.label}>Default speed</label>
            <input
              style={styles.input}
              type="number"
              min="0"
              step="0.1"
              value={form.defaultSpeedValue || ""}
              onChange={set("defaultSpeedValue")}
              placeholder="e.g. 3"
            />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Unit</label>
            <input
              style={styles.input}
              value={form.defaultSpeedUnit || ""}
              onChange={set("defaultSpeedUnit")}
              placeholder="e.g. shots/day, seconds/day"
            />
          </div>
        </div>
        <p style={styles.fieldHint}>
          A starting estimate to use until there's enough completed-project history to calculate a real
          average &mdash; the Planner won't invent a track record that doesn't exist yet.
        </p>

        <div style={styles.field}>
          <label style={styles.label}>Notes</label>
          <textarea
            style={styles.textarea}
            value={form.notes}
            onChange={set("notes")}
            placeholder="Strengths, timezone, contact preferences..."
            rows={2}
          />
        </div>

        {!isNew && (
          <>
            {cards && projects && (() => {
              const { shots } = computeMemberShots(form, cards, projects, teamMembers);
              if (shots.length === 0) {
                return (
                  <>
                    <div style={styles.fieldDivider}>Work history</div>
                    <p style={styles.fieldHint}>No shots assigned to this person yet.</p>
                  </>
                );
              }
              const projectCounts = new Map();
              for (const s of shots) {
                projectCounts.set(s.projectName, (projectCounts.get(s.projectName) || 0) + 1);
              }
              const active = shots.filter((s) => s.reviewStatus !== "approved");
              const completed = shots.filter((s) => s.reviewStatus === "approved");
              return (
                <>
                  <div style={styles.fieldDivider}>Work history</div>
                  <p style={styles.fieldHint}>
                    {[...projectCounts.entries()].map(([name, n]) => `${name} (${n})`).join(", ")}
                  </p>
                  <p style={styles.fieldHint}>
                    {active.length} active {"\u00b7"} {completed.length} completed
                  </p>
                  {shots.slice(0, 8).map((s) => (
                    <div key={s.id} style={{ ...styles.invoiceAmountsRow, marginBottom: 2 }}>
                      <span style={styles.fieldHint}>
                        {s.title || "Untitled shot"} {"\u00b7"} {s.projectName}
                      </span>
                      <span style={{ ...styles.fieldHint, color: REVIEW_COLORS[s.reviewStatus] }}>
                        {REVIEW_LABELS[s.reviewStatus] || s.reviewStatus}
                        {s.assignedPaid ? " \u00b7 paid" : ""}
                      </span>
                    </div>
                  ))}
                  {shots.length > 8 && <p style={styles.fieldHint}>+{shots.length - 8} more</p>}
                </>
              );
            })()}

            <div style={styles.fieldDivider}>Portfolio</div>
            {portfolioItems.length === 0 && !addingPortfolioItem && (
              <p style={styles.fieldHint}>No portfolio items yet.</p>
            )}
            {portfolioItems.map((item) => (
              <div key={item.id} style={{ ...styles.invoiceAmountsRow, marginBottom: 4 }}>
                <span style={styles.fieldHint}>
                  {item.title}
                  {item.rolePerformed ? ` \u00b7 ${item.rolePerformed}` : ""}
                  {item.projectCategory ? ` \u00b7 ${item.projectCategory}` : ""}
                  {item.externalUrl ? (
                    <>
                      {" "}
                      &middot;{" "}
                      <a href={item.externalUrl} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
                        link
                      </a>
                    </>
                  ) : null}
                </span>
                <button type="button" style={styles.tabButton} onClick={() => deletePortfolioItem(item.id)}>
                  Remove
                </button>
              </div>
            ))}
            {addingPortfolioItem ? (
              <div style={{ border: "1px solid #2a3634", borderRadius: 8, padding: 10, marginTop: 6 }}>
                <div style={styles.fieldRow}>
                  <div style={styles.field}>
                    <label style={styles.label}>Title</label>
                    <input
                      style={styles.input}
                      value={newPortfolioItem.title}
                      onChange={(e) => setNewPortfolioItem({ ...newPortfolioItem, title: e.target.value })}
                    />
                  </div>
                  <div style={styles.field}>
                    <label style={styles.label}>Role performed</label>
                    <input
                      style={styles.input}
                      value={newPortfolioItem.rolePerformed}
                      onChange={(e) => setNewPortfolioItem({ ...newPortfolioItem, rolePerformed: e.target.value })}
                    />
                  </div>
                </div>
                <div style={styles.field}>
                  <label style={styles.label}>Description</label>
                  <textarea
                    style={styles.textarea}
                    rows={2}
                    value={newPortfolioItem.description}
                    onChange={(e) => setNewPortfolioItem({ ...newPortfolioItem, description: e.target.value })}
                  />
                </div>
                <div style={styles.fieldRow}>
                  <div style={styles.field}>
                    <label style={styles.label}>External URL</label>
                    <input
                      style={styles.input}
                      value={newPortfolioItem.externalUrl}
                      onChange={(e) => setNewPortfolioItem({ ...newPortfolioItem, externalUrl: e.target.value })}
                      placeholder="https://..."
                    />
                  </div>
                  <div style={styles.field}>
                    <label style={styles.label}>Category</label>
                    <input
                      style={styles.input}
                      value={newPortfolioItem.projectCategory}
                      onChange={(e) => setNewPortfolioItem({ ...newPortfolioItem, projectCategory: e.target.value })}
                    />
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                  <button type="button" style={styles.tabButton} onClick={() => setAddingPortfolioItem(false)}>
                    Cancel
                  </button>
                  <button type="button" style={styles.saveButton} onClick={savePortfolioItem}>
                    Add item
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" style={styles.tabButton} onClick={() => setAddingPortfolioItem(true)}>
                <PlusIcon /> Add portfolio item
              </button>
            )}

            <div style={styles.fieldDivider}>Performance</div>
            <p style={styles.fieldHint}>
              Studio rating {averageInternalRating(reviews) != null ? (
                <>
                  {starRating(averageInternalRating(reviews))} {averageInternalRating(reviews).toFixed(1)} (
                  {reviews.length} review{reviews.length === 1 ? "" : "s"})
                </>
              ) : (
                "No internal reviews yet"
              )}
              {" \u2014 kept separate from the Upwork rating above; neither is derived from the other."}
            </p>
            {reviews.map((r) => (
              <div key={r.id} style={{ ...styles.invoiceAmountsRow, marginBottom: 4 }}>
                <span style={styles.fieldHint}>
                  {starRating(r.rating)} {r.reviewDate}
                  {r.reviewer ? ` \u00b7 ${r.reviewer}` : ""}
                  {r.reviewText ? ` \u00b7 ${r.reviewText}` : ""}
                </span>
                <button type="button" style={styles.tabButton} onClick={() => deleteReview(r.id)}>
                  Remove
                </button>
              </div>
            ))}
            {addingReview ? (
              <div style={{ border: "1px solid #2a3634", borderRadius: 8, padding: 10, marginTop: 6 }}>
                <div style={styles.fieldRow}>
                  <div style={styles.field}>
                    <label style={styles.label}>Rating</label>
                    <select
                      style={styles.input}
                      value={newReview.rating}
                      onChange={(e) => setNewReview({ ...newReview, rating: e.target.value })}
                    >
                      {[5, 4, 3, 2, 1].map((n) => (
                        <option key={n} value={n}>{n} star{n === 1 ? "" : "s"}</option>
                      ))}
                    </select>
                  </div>
                  <div style={styles.field}>
                    <label style={styles.label}>Reviewer</label>
                    <input
                      style={styles.input}
                      value={newReview.reviewer}
                      onChange={(e) => setNewReview({ ...newReview, reviewer: e.target.value })}
                    />
                  </div>
                </div>
                <div style={styles.field}>
                  <label style={styles.label}>Review</label>
                  <textarea
                    style={styles.textarea}
                    rows={2}
                    value={newReview.reviewText}
                    onChange={(e) => setNewReview({ ...newReview, reviewText: e.target.value })}
                  />
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                  <button type="button" style={styles.tabButton} onClick={() => setAddingReview(false)}>
                    Cancel
                  </button>
                  <button type="button" style={styles.saveButton} onClick={saveReview}>
                    Add review
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" style={styles.tabButton} onClick={() => setAddingReview(true)}>
                <PlusIcon /> Add review
              </button>
            )}
          </>
        )}

        {saveError && (
          <p style={{ ...styles.fieldHint, color: "#FF4D4D" }} role="alert">
            {saveError}
          </p>
        )}

        <div style={styles.modalFooter}>
          {!isNew && form.status !== "archived" && !confirmingArchive && (
            <button style={styles.deleteButton} onClick={() => setConfirmingArchive(true)}>
              <TrashIcon />
              Archive
            </button>
          )}
          {!isNew && confirmingArchive && (
            <>
              <span style={{ ...styles.fieldHint, marginRight: 8 }}>
                Archive {form.name || "this member"}? Their history is kept — this just removes them from
                the active roster and assignment lists.
              </span>
              <button style={styles.cancelButton} onClick={() => setConfirmingArchive(false)}>
                Never mind
              </button>
              <button style={styles.deleteButton} onClick={() => onArchive(form.id)}>
                <TrashIcon />
                Confirm archive
              </button>
            </>
          )}
          {!isNew && form.status === "archived" && (
            <span style={styles.fieldHint}>Archived{form.archivedAt ? ` ${new Date(form.archivedAt).toLocaleDateString()}` : ""}</span>
          )}
          <div style={{ flex: 1 }} />
          <button style={styles.cancelButton} onClick={onCancel}>
            Cancel
          </button>
          <button
            style={styles.saveButton}
            onClick={() => onSave({ ...form, name: form.name || "Untitled member" })}
          >
            Save member
          </button>
        </div>
      </div>
    </div>
  );
}

function InvoiceEditor({ invoice, onCancel, onSave, onDelete, isNew, currencySymbol, hasProAccess }) {
  const [form, setForm] = useState({ currency: currencySymbol || "$", amountMode: "manual", ...invoice });
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  const docType = form.docType || "invoice";
  const hasLineItems = form.amountMode === "items";
  const computedTotal = hasLineItems ? lineItemsTotal(form.lineItems) : parseMoney(form.amount);
  const balance = computedTotal - parseMoney(form.amountPaid);
  const cur = form.currency || currencySymbol || "$";

  useEffect(() => {
    if (!hasProAccess && form.currency !== (currencySymbol || "$")) {
      setForm((f) => ({ ...f, currency: currencySymbol || "$" }));
    }
  }, [hasProAccess]);

  const setLineItem = (idx, patch) => {
    const next = [...(form.lineItems || [])];
    next[idx] = { ...next[idx], ...patch };
    setForm({ ...form, lineItems: next });
  };

  const handlePickDocType = (targetType) => {
    setForm((f) => {
      // Only a still-unsaved document's number follows the type around -
      // once it's saved, switching the type shouldn't silently renumber
      // something that might already be on a document the client has.
      const nextNumber = isNew ? numberForDocType(f.invoiceNumber, targetType) || f.invoiceNumber : f.invoiceNumber;
      if (targetType === "receipt") {
        const total = f.amountMode === "items" ? lineItemsTotal(f.lineItems) : parseMoney(f.amount);
        return {
          ...f,
          docType: targetType,
          invoiceNumber: nextNumber,
          status: "paid",
          amountPaid: f.amountPaid || String(total),
          paidDate: f.paidDate || new Date().toISOString().slice(0, 10),
        };
      }
      return { ...f, docType: targetType, invoiceNumber: nextNumber };
    });
  };

  return (
    <div style={styles.overlay} onClick={onCancel}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <span style={styles.modalTitle}>
            {isNew ? `New ${DOC_TYPES.find((t) => t.id === docType)?.label.toLowerCase() || "invoice"}` : "Edit document"}
          </span>
          <button style={styles.iconButton} onClick={onCancel}>
            <CloseIcon />
          </button>
        </div>

        <div style={styles.field}>
          <label style={styles.label}>Document type</label>
          <div style={styles.reviewStatusRow}>
            {DOC_TYPES.map((t) => (
              <button
                key={t.id}
                type="button"
                style={{
                  ...styles.reviewStatusButton,
                  borderColor: docType === t.id ? teal : border,
                  color: docType === t.id ? teal : textMuted,
                  background: docType === t.id ? "rgba(47,191,166,0.1)" : "transparent",
                }}
                onClick={() => handlePickDocType(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          {docType === "proforma" && (
            <p style={styles.fieldHint}>An advance payment request - not the final invoice yet.</p>
          )}
          {docType === "receipt" && (
            <p style={styles.fieldHint}>Confirms payment already received, so it won't ask Paid/Unpaid below.</p>
          )}
        </div>

        <div style={styles.fieldRow}>
          <div style={styles.field}>
            <label style={styles.label}>Document number</label>
            <input
              style={styles.input}
              value={form.invoiceNumber}
              onChange={set("invoiceNumber")}
              placeholder="e.g. INV-0001"
              autoFocus
            />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>
              Currency {!hasProAccess && <span style={styles.proBadge}>PRO</span>}
            </label>
            {hasProAccess ? (
              <select style={styles.input} value={form.currency || "$"} onChange={set("currency")}>
                {CURRENCIES.map((c) => (
                  <option key={c.code} value={c.symbol}>
                    {c.label}
                  </option>
                ))}
              </select>
            ) : (
              <>
                <p style={styles.fieldHint}>{currencySymbol} (studio default)</p>
                <p style={styles.fieldHint}>Multiple currencies are a Pro feature.</p>
              </>
            )}
          </div>
        </div>

        <div style={styles.field}>
          <label style={styles.label}>Amount mode</label>
          <div style={styles.reviewStatusRow}>
            <button
              type="button"
              style={{
                ...styles.reviewStatusButton,
                borderColor: !hasLineItems ? teal : border,
                color: !hasLineItems ? teal : textMuted,
                background: !hasLineItems ? "rgba(47,191,166,0.1)" : "transparent",
              }}
              onClick={() => setForm({ ...form, amountMode: "manual" })}
            >
              Single amount
            </button>
            <button
              type="button"
              style={{
                ...styles.reviewStatusButton,
                borderColor: hasLineItems ? teal : border,
                color: hasLineItems ? teal : textMuted,
                background: hasLineItems ? "rgba(47,191,166,0.1)" : "transparent",
              }}
              onClick={() =>
                setForm({
                  ...form,
                  amountMode: "items",
                  lineItems: form.lineItems && form.lineItems.length ? form.lineItems : [emptyLineItem()],
                })
              }
            >
              Line items
            </button>
          </div>
        </div>

        {hasLineItems ? (
          <div style={styles.field}>
            <label style={styles.label}>Line items</label>
            {(form.lineItems || []).map((li, idx) => (
              <div key={li.id} style={styles.lineItemRow}>
                <input
                  style={{ ...styles.input, flex: 3 }}
                  value={li.description}
                  onChange={(e) => setLineItem(idx, { description: e.target.value })}
                  placeholder="e.g. Genga -> douga cleanup, set 1"
                />
                <input
                  style={{ ...styles.input, flex: 1, minWidth: 50 }}
                  value={li.qty}
                  onChange={(e) => setLineItem(idx, { qty: e.target.value })}
                  placeholder="Qty"
                />
                <input
                  style={{ ...styles.input, flex: 1, minWidth: 70 }}
                  value={li.unitPrice}
                  onChange={(e) => setLineItem(idx, { unitPrice: e.target.value })}
                  placeholder="Unit price"
                />
                <span style={{ ...styles.fieldHint, minWidth: 70, textAlign: "right" }}>
                  {cur}{formatMoney(parseMoney(li.qty) * parseMoney(li.unitPrice))}
                </span>
                {form.lineItems.length > 1 && (
                  <button
                    type="button"
                    style={styles.iconButton}
                    onClick={() => setForm({ ...form, lineItems: form.lineItems.filter((_, i) => i !== idx) })}
                  >
                    <TrashIcon />
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              style={styles.addRevisionButton}
              onClick={() => setForm({ ...form, lineItems: [...(form.lineItems || []), emptyLineItem()] })}
            >
              + Add line
            </button>
          </div>
        ) : (
          <div style={styles.field}>
            <label style={styles.label}>Description</label>
            <textarea
              style={styles.textarea}
              value={form.description}
              onChange={set("description")}
              placeholder="e.g. Cleanup and compositing, Cuts 01-12"
              rows={2}
            />
          </div>
        )}

        <div style={styles.fieldRow}>
          <div style={styles.field}>
            <label style={styles.label}>Amount</label>
            <input
              style={styles.input}
              value={hasLineItems ? formatMoney(computedTotal) : form.amount}
              onChange={hasLineItems ? undefined : set("amount")}
              disabled={hasLineItems}
              placeholder="e.g. 500"
            />
            {hasLineItems && <p style={styles.fieldHint}>Calculated from line items above.</p>}
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Amount paid</label>
            <input
              style={styles.input}
              value={form.amountPaid}
              onChange={set("amountPaid")}
              placeholder="e.g. 0"
            />
          </div>
        </div>

        <div style={styles.fieldRow}>
          <div style={styles.field}>
            <label style={styles.label}>Issue date</label>
            <input
              style={styles.input}
              type="date"
              value={form.issueDate || ""}
              onChange={set("issueDate")}
            />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Due date</label>
            <input
              style={styles.input}
              type="date"
              value={form.dueDate || ""}
              onChange={set("dueDate")}
            />
          </div>
        </div>

        <p style={styles.fieldHint}>
          {docType === "receipt"
            ? `Amount received: ${cur}${formatMoney(parseMoney(form.amountPaid))}`
            : `Balance due: ${cur}${formatMoney(balance)}`}
        </p>

        {docType === "receipt" ? (
          <div style={styles.field}>
            <label style={styles.label}>Payment date</label>
            <input
              style={styles.input}
              type="date"
              value={form.paidDate || ""}
              onChange={set("paidDate")}
            />
          </div>
        ) : (
          <div style={styles.field}>
            <label style={styles.label}>Status</label>
            <div style={styles.reviewStatusRow}>
              <button
                type="button"
                style={{
                  ...styles.reviewStatusButton,
                  borderColor: form.status !== "paid" ? "#F2A65A" : border,
                  color: form.status !== "paid" ? "#F2A65A" : textMuted,
                  background: form.status !== "paid" ? "rgba(242,166,90,0.1)" : "transparent",
                }}
                onClick={() => setForm({ ...form, status: "unpaid" })}
              >
                {docType === "proforma" ? "Awaiting payment" : "Unpaid"}
              </button>
              <button
                type="button"
                style={{
                  ...styles.reviewStatusButton,
                  borderColor: form.status === "paid" ? "#3DDC84" : border,
                  color: form.status === "paid" ? "#3DDC84" : textMuted,
                  background: form.status === "paid" ? "rgba(61,220,132,0.1)" : "transparent",
                }}
                onClick={() =>
                  setForm({
                    ...form,
                    status: "paid",
                    amountPaid: hasLineItems ? String(computedTotal) : form.amount,
                    paidDate: form.paidDate || new Date().toISOString().slice(0, 10),
                  })
                }
              >
                Paid
              </button>
            </div>
          </div>
        )}

        <div style={styles.modalFooter}>
          {!isNew && (
            <button style={styles.deleteButton} onClick={() => onDelete(form.id)}>
              <TrashIcon />
              Delete
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button style={styles.cancelButton} onClick={onCancel}>
            Cancel
          </button>
          <button
            style={styles.saveButton}
            onClick={() =>
              onSave({
                ...form,
                invoiceNumber: form.invoiceNumber || `${DOC_TYPE_PREFIX[docType] || "INV"}-0001`,
                amount: hasLineItems ? String(computedTotal) : form.amount,
              })
            }
          >
            Save {DOC_TYPES.find((t) => t.id === docType)?.label.toLowerCase() || "invoice"}
          </button>
        </div>
      </div>
    </div>
  );
}

function MilestoneModal({ totalBudget, onCancel, onCreate, defaultPercentages, currencySymbol }) {
  const cur = currencySymbol || "$";
  const [percentages, setPercentages] = useState(
    (defaultPercentages && defaultPercentages.length === 3 ? defaultPercentages : MILESTONE_DEFAULTS).map(String)
  );
  const totalPercent = percentages.reduce((sum, p) => sum + (parseFloat(p) || 0), 0);
  const setPct = (i) => (e) => {
    const next = [...percentages];
    next[i] = e.target.value;
    setPercentages(next);
  };

  return (
    <div style={styles.overlay} onClick={onCancel}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <span style={styles.modalTitle}>Set up milestone payments</span>
          <button style={styles.iconButton} onClick={onCancel}>
            <CloseIcon />
          </button>
        </div>

        <p style={styles.fieldHint}>
          Splits the project's {cur}{formatMoney(totalBudget)} budget into invoices.
        </p>

        {MILESTONE_LABELS.map((label, i) => (
          <div key={label} style={styles.fieldRow}>
            <div style={styles.field}>
              <label style={styles.label}>{label}</label>
              <input
                style={styles.input}
                type="number"
                min="0"
                max="100"
                value={percentages[i]}
                onChange={setPct(i)}
              />
            </div>
            <div style={styles.field}>
              <label style={styles.label}>Amount</label>
              <input
                style={styles.input}
                value={`${cur}${formatMoney((totalBudget * (parseFloat(percentages[i]) || 0)) / 100)}`}
                disabled
              />
            </div>
          </div>
        ))}

        <p style={{ ...styles.fieldHint, color: totalPercent === 100 ? "#3DDC84" : "#F2A65A" }}>
          Total: {totalPercent}%{totalPercent !== 100 ? " — doesn't add up to 100%, invoices will use these amounts anyway" : ""}
        </p>

        <div style={styles.modalFooter}>
          <div style={{ flex: 1 }} />
          <button style={styles.cancelButton} onClick={onCancel}>
            Cancel
          </button>
          <button style={styles.saveButton} onClick={() => onCreate(percentages)}>
            Create invoices
          </button>
        </div>
      </div>
    </div>
  );
}

const fontImport = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');

* {
  box-sizing: border-box;
}

::-webkit-scrollbar {
  width: 9px;
  height: 9px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
::-webkit-scrollbar-thumb {
  background: #33414a;
  border-radius: 999px;
}
::-webkit-scrollbar-thumb:hover {
  background: #3d4d57;
}

input, textarea, select {
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
input:focus, textarea:focus, select:focus {
  outline: none;
  border-color: #2FBFA6 !important;
  box-shadow: 0 0 0 3px rgba(47,191,166,0.16);
}

button {
  transition: filter 0.15s ease, transform 0.08s ease, box-shadow 0.15s ease;
}
button:hover:not(:disabled) {
  filter: brightness(1.08);
}
button:active:not(:disabled) {
  transform: scale(0.97);
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

a {
  transition: opacity 0.15s ease;
}
a:hover {
  opacity: 0.82;
}

.kf-card {
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.kf-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 16px 40px rgba(0,0,0,0.45), 0 4px 12px rgba(0,0,0,0.3);
}

@keyframes kf-spin {
  to { transform: rotate(360deg); }
}
.kf-spin {
  animation: kf-spin 0.8s linear infinite;
  transform-origin: center;
}

@keyframes kf-tutorial-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(47,191,166,0.55); }
  50% { box-shadow: 0 0 0 8px rgba(47,191,166,0); }
}
.kf-tutorial-highlight {
  position: relative;
  z-index: 101;
  border-color: #2FBFA6 !important;
  color: #7FE0D0 !important;
  animation: kf-tutorial-pulse 1.4s ease-in-out infinite;
}
`;

const ink = "#14191c";
const inkSoft = "#1c2327";
const inkElevated = "#232b30";
const paper = "#EDEAE3";
const teal = "#2FBFA6";
const tealLight = "#7FE0D0";
const border = "#2a3338";
const textMuted = "#8b9a98";
// Amber, not red: overtime is worth spotting at a glance, but it isn't an error.
const OVERTIME_COLOR = "#F2A65A";
const shadowSoft = "0 1px 3px rgba(0,0,0,0.24), 0 1px 2px rgba(0,0,0,0.16)";
const shadowLifted = "0 12px 32px rgba(0,0,0,0.4), 0 2px 8px rgba(0,0,0,0.24)";
const shadowGlow = "0 4px 14px rgba(47,191,166,0.28)";

const styles = {
  app: {
    minHeight: "100vh",
    background: ink,
    color: paper,
    fontFamily: "'Inter', sans-serif",
    display: "flex",
    flexDirection: "column",
  },
  loadingScreen: {
    minHeight: "100vh",
    background: ink,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: teal,
  },
  loadingClap: {
    animation: "pulse 1.4s ease-in-out infinite",
  },
  lockScreen: {
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    padding: "40px 24px",
    textAlign: "center",
  },
  lockForm: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    width: "100%",
    maxWidth: 320,
    marginTop: 4,
  },
  lockError: {
    color: "#E07A5F",
    fontSize: 12.5,
    margin: 0,
    maxWidth: 320,
  },
  lockNotice: {
    color: tealLight,
    fontSize: 12.5,
    margin: 0,
    maxWidth: 320,
  },
  googleButton: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    width: "100%",
    maxWidth: 320,
    background: "#ffffff",
    color: "#1f2623",
    border: "none",
    borderRadius: 999,
    padding: "11px 18px",
    fontSize: 13.5,
    fontWeight: 600,
    fontFamily: "'Inter', sans-serif",
    cursor: "pointer",
  },
  dividerRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    maxWidth: 320,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    background: border,
  },
  dividerText: {
    fontSize: 11.5,
    color: textMuted,
    fontFamily: "'IBM Plex Mono', monospace",
  },
  switchModeButton: {
    background: "transparent",
    border: "none",
    color: teal,
    fontSize: 12.5,
    cursor: "pointer",
    marginTop: 4,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "20px 28px",
    borderBottom: `1px solid ${border}`,
    boxShadow: "0 1px 0 rgba(0,0,0,0.3)",
    flexWrap: "wrap",
    gap: 12,
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  logoMark: {
    width: 38,
    height: 38,
    borderRadius: 10,
    background: "rgba(47,191,166,0.14)",
    border: "1px solid rgba(47,191,166,0.3)",
    boxShadow: "0 0 16px rgba(47,191,166,0.18)",
    color: teal,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  backButton: {
    width: 38,
    height: 38,
    borderRadius: 10,
    background: "rgba(255,255,255,0.05)",
    border: `1px solid ${border}`,
    color: paper,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    flexShrink: 0,
  },
  title: {
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: 20,
    fontWeight: 700,
    margin: 0,
    letterSpacing: "-0.015em",
  },
  subtitle: {
    fontSize: 12.5,
    color: textMuted,
    margin: "2px 0 0",
    fontFamily: "'IBM Plex Mono', monospace",
  },
  headerRight: {
    display: "flex",
    alignItems: "center",
    gap: 14,
  },
  saveIndicator: {
    fontSize: 12,
    color: textMuted,
    fontFamily: "'IBM Plex Mono', monospace",
    minWidth: 60,
    textAlign: "right",
  },
  newButton: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    background: teal,
    color: ink,
    border: "none",
    borderRadius: 999,
    padding: "10px 18px",
    fontSize: 13.5,
    fontWeight: 600,
    fontFamily: "'Inter', sans-serif",
    cursor: "pointer",
    boxShadow: shadowGlow,
  },
  iconButtonGhost: {
    width: 36,
    height: 36,
    borderRadius: 999,
    background: "rgba(255,255,255,0.05)",
    border: `1px solid ${border}`,
    color: paper,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    flexShrink: 0,
  },
  importToast: {
    margin: "0 28px 14px",
    background: "rgba(47,191,166,0.1)",
    border: `1px solid ${teal}`,
    color: tealLight,
    borderRadius: 10,
    padding: "10px 14px",
    fontSize: 12.5,
    fontFamily: "'IBM Plex Mono', monospace",
  },
  progressBar: {
    padding: "0 28px 18px",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  progressLabelRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  progressLabel: {
    fontSize: 12.5,
    color: textMuted,
  },
  progressPercent: {
    fontSize: 13,
    fontFamily: "'IBM Plex Mono', monospace",
    color: teal,
    fontWeight: 500,
  },
  progressTrack: {
    height: 6,
    borderRadius: 999,
    background: "rgba(255,255,255,0.06)",
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: 999,
    background: `linear-gradient(90deg, ${teal}, ${tealLight})`,
    transition: "width 0.3s ease",
  },
  projectsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
    gap: 14,
    padding: "6px 28px 32px",
  },
  projectsEmpty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    padding: "60px 20px",
    color: textMuted,
  },
  projectsEmptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 16,
    background: "rgba(47,191,166,0.1)",
    border: "1px solid rgba(47,191,166,0.22)",
    color: teal,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  projectsEmptyText: {
    fontSize: 14,
    margin: 0,
  },
  projectCard: {
    background: inkSoft,
    border: `1px solid ${border}`,
    borderRadius: 16,
    padding: 18,
    display: "flex",
    flexDirection: "column",
    gap: 10,
    cursor: "pointer",
    boxShadow: shadowSoft,
    transition: "transform 0.15s ease, box-shadow 0.15s ease",
  },
  projectCardArchived: {
    opacity: 0.6,
  },
  projectCardTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  projectCardActions: {
    display: "flex",
    gap: 4,
    flexWrap: "wrap",
    justifyContent: "flex-end",
  },
  archiveSection: {
    padding: "8px 0 32px",
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  archiveToggle: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    alignSelf: "flex-start",
    marginLeft: 28,
    background: "transparent",
    border: `1px solid ${border}`,
    borderRadius: 999,
    color: textMuted,
    fontSize: 12.5,
    padding: "8px 14px",
    cursor: "pointer",
    fontFamily: "'Inter', sans-serif",
  },
  invoicesWrap: {
    padding: "0 28px 32px",
    display: "flex",
    flexDirection: "column",
    gap: 20,
  },
  settingsPageWrap: {
    padding: "8px 28px 32px",
    display: "flex",
    flexDirection: "column",
    gap: 20,
  },
  settingsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
    gap: 18,
    alignItems: "start",
  },
  settingsSection: {
    background: inkSoft,
    border: `1px solid ${border}`,
    borderRadius: 16,
    padding: 20,
    display: "flex",
    flexDirection: "column",
    gap: 16,
    boxShadow: shadowSoft,
  },
  settingsSectionTitle: {
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: 14,
    fontWeight: 600,
    color: paper,
    margin: 0,
    paddingBottom: 4,
    borderBottom: `1px solid ${border}`,
  },
  settingsFooterBar: {
    display: "flex",
    justifyContent: "flex-end",
    position: "sticky",
    bottom: 0,
    background: ink,
    borderTop: `1px solid ${border}`,
    padding: "14px 0 4px",
  },
  greetingTitle: {
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: 24,
    fontWeight: 700,
    margin: 0,
    letterSpacing: "-0.015em",
    color: paper,
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  studioTimeActionsRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    marginTop: 8,
    flexWrap: "wrap",
  },
  studioTimeValue: {
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 20,
    fontWeight: 600,
    color: paper,
    letterSpacing: "0.02em",
    marginTop: 2,
  },
  studioTimeStatus: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    fontSize: 10.5,
    color: "#3DDC84",
    fontWeight: 600,
    fontFamily: "'Inter', sans-serif",
    margin: "3px 0 0",
  },
  studioTimeStatusDot: {
    width: 7,
    height: 7,
    borderRadius: "50%",
    background: "#3DDC84",
    boxShadow: "0 0 6px rgba(61,220,132,0.6)",
    flexShrink: 0,
  },
  pomodoroLinkButton: {
    background: "transparent",
    border: "none",
    color: teal,
    fontSize: 12.5,
    fontFamily: "'Inter', sans-serif",
    cursor: "pointer",
    padding: "10px 0",
  },
  pomodoroSetup: {
    marginTop: 10,
    paddingTop: 10,
    borderTop: `1px solid ${border}`,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  pomodoroSetupGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 10,
  },
  pomodoroField: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  pomodoroControls: {
    display: "flex",
    gap: 6,
    marginTop: 8,
  },
  pomodoroSecondaryButton: {
    background: "transparent",
    border: `1px solid ${border}`,
    borderRadius: 999,
    color: textMuted,
    padding: "5px 10px",
    fontSize: 11,
    fontFamily: "'Inter', sans-serif",
    cursor: "pointer",
  },
  pipContent: {
    padding: 0,
    width: "100%",
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: paper,
    fontFamily: "'Inter', sans-serif",
  },
  // Sized for the 180x180 pop-out window itself: no card chrome, no status
  // line, just the number and one action, centered with minimal margin
  // around the content instead of card padding meant for a much bigger
  // surface.
  pipInner: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  pipValue: {
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 26,
    fontWeight: 600,
    color: paper,
    letterSpacing: 0.5,
  },
  pipButton: {
    background: "transparent",
    border: `1px solid ${border}`,
    borderRadius: 999,
    color: textMuted,
    padding: "5px 16px",
    fontSize: 12,
    fontFamily: "'Inter', sans-serif",
    cursor: "pointer",
  },
  dayBreakdownList: {
    marginTop: 8,
    display: "flex",
    flexDirection: "column",
    border: `1px solid ${border}`,
    borderRadius: 12,
    overflowY: "auto",
    maxHeight: 260,
  },
  dayBreakdownRow: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 10,
    padding: "7px 12px",
    borderBottom: `1px solid ${border}`,
    fontSize: 13,
  },
  dayBreakdownDay: {
    color: textMuted,
    display: "flex",
    alignItems: "baseline",
    gap: 6,
  },
  dayBreakdownDayToday: {
    color: tealLight,
    fontWeight: 600,
  },
  dayBreakdownValues: {
    display: "flex",
    alignItems: "baseline",
    gap: 8,
    flexWrap: "wrap",
    justifyContent: "flex-end",
  },
  dayBreakdownHours: {
    fontFamily: "'Space Grotesk', sans-serif",
    fontWeight: 600,
    color: paper,
  },
  dayBreakdownHoursZero: {
    fontFamily: "'Space Grotesk', sans-serif",
    fontWeight: 600,
    color: textMuted,
  },
  dayBreakdownOvertime: {
    fontSize: 11.5,
    fontWeight: 600,
    color: OVERTIME_COLOR,
  },
  dayBreakdownShortfall: {
    fontSize: 11.5,
    color: textMuted,
  },
  dayBreakdownNote: {
    fontSize: 11,
    color: textMuted,
  },
  dayBreakdownFuture: {
    color: textMuted,
    opacity: 0.6,
  },
  summaryStatsRow: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
    gap: 16,
  },
  summaryStat: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  summaryStatValue: {
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: 18,
    fontWeight: 600,
    color: paper,
  },
  summaryStatHint: {
    fontSize: 10.5,
    color: textMuted,
    lineHeight: 1.35,
  },
  budgetSummaryRow: {
    display: "flex",
    gap: 14,
    flexWrap: "wrap",
  },
  dashboardGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
    gap: 14,
  },

  // ---------------------------------------------------------------------
  // Compact "at a glance" dashboard — designed to fit within the viewport
  // on desktop with no page scroll. Long lists (Needs Attention, Near
  // Deadline) scroll within their own card instead of the whole page
  // growing. See dashboardCardHeaderRow -> dashboardCardHeader for labels.
  // ---------------------------------------------------------------------
  dashboardShell: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    padding: "14px 24px 16px",
    height: "calc(100vh - 130px)",
    minHeight: 520,
    overflow: "hidden",
  },
  dashboardTopStrip: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 10,
    flexShrink: 0,
  },
  dashboardGreetingCompact: {
    display: "flex",
    alignItems: "baseline",
    gap: 10,
    flexWrap: "wrap",
  },
  dashboardGreetingCompactTitle: {
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: 18,
    fontWeight: 600,
    color: paper,
  },
  dashboardGreetingCompactDate: {
    fontSize: 12,
    color: textMuted,
  },
  // Right-aligned to match the original layout: this renders as its own
  // full-width row between the header and the tabs (see the mount comment
  // at its call site), so without an explicit right alignment here it just
  // falls to the block's natural left edge - which is what was squeezing
  // it left. flex-end on both axes keeps the pill and any error/notice
  // text under it flush to the right edge instead.
  studioTimeCompactWrap: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: 6,
    width: "100%",
    padding: "0 28px",
    marginTop: 10,
  },
  studioTimeCompact: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 12px",
    borderRadius: 999,
    border: `1px solid ${border}`,
    background: inkSoft,
  },
  studioTimeCompactActive: {
    borderColor: "rgba(47,191,166,0.5)",
    boxShadow: "0 0 0 3px rgba(47,191,166,0.1)",
  },
  studioTimeCompactValue: {
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 13,
    fontWeight: 600,
    color: paper,
    minWidth: 62,
  },
  dashboardCompactButton: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 11.5,
    fontWeight: 600,
    padding: "5px 10px",
    borderRadius: 999,
    border: "none",
    background: teal,
    color: "#08211c",
    cursor: "pointer",
  },
  dashboardKpiStrip: {
    display: "grid",
    gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
    gap: 10,
    flexShrink: 0,
  },
  dashboardKpiTile: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    padding: "10px 12px",
    borderRadius: 12,
  },
  dashboardKpiTop: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 2,
  },
  dashboardKpiIcon: {
    width: 26,
    height: 26,
    borderRadius: 8,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  dashboardKpiValue: {
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: 19,
    fontWeight: 700,
    color: paper,
    lineHeight: 1.1,
  },
  dashboardKpiLabel: {
    fontSize: 11,
    color: textMuted,
  },
  dashboardKpiSub: {
    fontSize: 10.5,
    color: textMuted,
  },
  dashboardMainGrid: {
    display: "grid",
    gridTemplateColumns: "1.15fr 1fr 0.9fr",
    gap: 12,
    flex: 1,
    minHeight: 0,
  },
  dashboardCol: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    minHeight: 0,
  },
  dashboardCard: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minHeight: 0,
    padding: "12px 14px",
    borderRadius: 14,
    border: `1px solid ${border}`,
    background: inkSoft,
  },
  dashboardCardHeaderRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexShrink: 0,
    marginBottom: 6,
  },
  // Plain heading treatment, matching columnLabel (the Kanban column
  // headers) elsewhere in the app - normal weight, paper color, no
  // uppercase/letter-spacing/monospace/bright-teal combination. That
  // combination is what read as a decorative "glowing" header; this is
  // the same plain style the rest of the dashboard already uses for
  // section titles.
  dashboardCardHeader: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: 13,
    fontWeight: 600,
    color: paper,
  },
  dashboardCardHeaderHint: {
    fontSize: 11,
    color: textMuted,
    margin: 0,
  },
  dashboardChartFill: {
    flex: 1,
    minHeight: 0,
  },
  dashboardPeriodSelect: {
    background: "#171d20",
    border: `1px solid ${border}`,
    borderRadius: 6,
    padding: "3px 6px",
    color: textMuted,
    fontSize: 10.5,
    fontFamily: "'Inter', sans-serif",
    outline: "none",
    cursor: "pointer",
    flexShrink: 0,
  },
  dashboardSuccessBig: {
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: 30,
    fontWeight: 700,
    color: teal,
    lineHeight: 1.1,
  },
  dashboardRateRow: {
    display: "flex",
    alignItems: "baseline",
    flexWrap: "wrap",
    gap: 8,
    rowGap: 4,
  },
  dashboardWinRateBadge: {
    fontSize: 11.5,
    fontWeight: 600,
    color: "#4A90D9",
    background: "rgba(74,144,217,0.12)",
    borderRadius: 999,
    padding: "3px 9px",
  },
  dashboardTodayRow: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 8,
    paddingTop: 8,
    borderTop: `1px solid ${border}`,
    flexShrink: 0,
  },
  dashboardTodayLabel: {
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 0.3,
    textTransform: "uppercase",
    color: tealLight,
  },
  dashboardMiniFunnelGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 8,
    marginTop: 10,
  },
  dashboardMiniFunnelItem: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    padding: "6px 8px",
    borderRadius: 8,
    background: "rgba(255,255,255,0.03)",
    fontSize: 14,
    fontWeight: 600,
    color: paper,
  },
  dashboardDonutRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: 6,
    flex: 1,
    minHeight: 0,
    alignItems: "center",
  },
  dashboardScrollList: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    paddingRight: 2,
  },
  dashboardEmptyState: {
    fontSize: 12,
    color: textMuted,
    margin: 0,
  },
  dashboardNotifRow: {
    textAlign: "left",
    fontSize: 12.5,
    color: paper,
    background: "rgba(242,166,90,0.08)",
    border: "1px solid rgba(242,166,90,0.25)",
    borderRadius: 8,
    padding: "8px 10px",
    cursor: "pointer",
    flexShrink: 0,
  },
  dashboardDeadlineRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 12.5,
    color: paper,
    background: "rgba(255,255,255,0.03)",
    borderRadius: 8,
    padding: "7px 10px",
    cursor: "pointer",
    flexShrink: 0,
  },
  dashboardDeadlineName: {
    fontWeight: 600,
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  dashboardDeadlineDate: {
    fontSize: 11,
    color: "#F2A65A",
    flexShrink: 0,
  },
  dashboardFooterHint: {
    fontSize: 10.5,
    color: textMuted,
    margin: 0,
    flexShrink: 0,
  },
  plannerPageHeader: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 10,
  },
  plannerPageTitle: {
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 20,
    fontWeight: 600,
    color: "#EAF6F4",
    margin: "0 0 4px",
  },
  plannerToolbar: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
  },
  plannerTemplateRow: {
    display: "flex",
    gap: 10,
    flexWrap: "wrap",
  },
  plannerTemplateCard: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    padding: "12px 14px",
    minWidth: 150,
    textAlign: "left",
    cursor: "pointer",
    background: "none",
    border: "1px solid rgba(127,224,208,0.18)",
    borderRadius: 10,
  },
  plannerSection: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    padding: "18px 20px",
    borderRadius: 14,
    border: "1px solid rgba(127,224,208,0.14)",
    background: "rgba(20,32,34,0.4)",
  },
  plannerSectionTitle: {
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 13,
    fontWeight: 600,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    color: tealLight,
  },
  plannerDeptRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "4px 0",
    borderBottom: "1px solid rgba(127,224,208,0.08)",
  },
  plannerCrewRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
    padding: "6px 0",
    borderBottom: "1px solid rgba(127,224,208,0.08)",
  },
  plannerTimelineTrack: {
    flex: 1,
    height: 8,
    borderRadius: 4,
    background: "rgba(127,224,208,0.1)",
    overflow: "hidden",
  },
  plannerTimelineFill: {
    height: "100%",
    background: teal,
    borderRadius: 4,
  },
  proLockWrap: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    padding: "48px 20px",
    textAlign: "center",
  },
  proLockIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    background: "rgba(47,191,166,0.14)",
    border: "1px solid rgba(47,191,166,0.32)",
    boxShadow: "0 0 16px rgba(47,191,166,0.18)",
    color: teal,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  proBadge: {
    fontSize: 10.5,
    fontFamily: "'IBM Plex Mono', monospace",
    fontWeight: 600,
    color: tealLight,
    background: "rgba(47,191,166,0.14)",
    border: "1px solid rgba(47,191,166,0.32)",
    borderRadius: 999,
    padding: "2px 8px",
    letterSpacing: "0.04em",
  },
  dashboardChartsRow: {
    display: "flex",
    gap: 24,
    flexWrap: "wrap",
  },
  dashboardStatTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 2,
  },
  dashboardStatIcon: {
    width: 30,
    height: 30,
    borderRadius: 9,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  dashboardDelta: {
    display: "flex",
    alignItems: "center",
    gap: 3,
    fontSize: 11.5,
    fontFamily: "'IBM Plex Mono', monospace",
    fontWeight: 500,
  },
  budgetStat: {
    flex: "1 1 160px",
    background: inkSoft,
    border: `1px solid ${border}`,
    borderRadius: 14,
    padding: "14px 16px",
    display: "flex",
    flexDirection: "column",
    gap: 4,
    boxShadow: shadowSoft,
  },
  budgetStatValue: {
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: 20,
    fontWeight: 600,
    color: paper,
  },
  invoiceList: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  invoiceCard: {
    background: inkSoft,
    border: `1px solid ${border}`,
    borderRadius: 14,
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 8,
    cursor: "pointer",
    boxShadow: shadowSoft,
  },
  invoiceCardTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  invoiceNumber: {
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 13,
    color: paper,
  },
  invoiceStatusTag: {
    fontSize: 11,
    border: "1px solid",
    borderRadius: 999,
    padding: "2px 10px",
    fontFamily: "'IBM Plex Mono', monospace",
  },
  docTypeTag: {
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: textMuted,
    border: `1px solid ${border}`,
    borderRadius: 999,
    padding: "2px 8px",
  },
  invoiceAmountsRow: {
    display: "flex",
    gap: 16,
  },
  invoiceActionsRow: {
    display: "flex",
    gap: 8,
    marginTop: 4,
  },
  lineItemRow: {
    display: "flex",
    gap: 8,
    alignItems: "center",
    marginBottom: 8,
  },
  projectIconMark: {
    width: 32,
    height: 32,
    borderRadius: 9,
    background: "rgba(47,191,166,0.12)",
    color: teal,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  projectName: {
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: 15.5,
    fontWeight: 600,
  },
  projectClient: {
    fontSize: 12.5,
    color: textMuted,
    marginTop: -6,
  },
  projectStats: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginTop: 4,
  },
  board: {
    display: "flex",
    gap: 10,
    padding: "0 20px 32px",
    overflowX: "auto",
    flex: 1,
    userSelect: "none",
    WebkitUserSelect: "none",
  },
  column: {
    background: inkSoft,
    borderRadius: 16,
    flex: "1 1 0",
    minWidth: 168,
    maxWidth: 280,
    display: "flex",
    flexDirection: "column",
    border: `1px solid ${border}`,
    transition: "border-color 0.15s ease",
  },
  columnOver: {
    borderColor: teal,
  },
  columnHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 12px",
    borderBottom: `1px solid ${border}`,
  },
  columnLabel: {
    fontSize: 12,
    fontWeight: 600,
    fontFamily: "'Space Grotesk', sans-serif",
    letterSpacing: "0.01em",
  },
  columnCount: {
    fontSize: 11,
    color: textMuted,
    fontFamily: "'IBM Plex Mono', monospace",
    background: "rgba(255,255,255,0.04)",
    borderRadius: 999,
    padding: "2px 8px",
  },
  columnBody: {
    padding: 8,
    display: "flex",
    flexDirection: "column",
    gap: 6,
    flex: 1,
    minHeight: 80,
  },
  emptyAdd: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    border: `1px dashed ${border}`,
    borderRadius: 12,
    background: "transparent",
    color: textMuted,
    fontSize: 12.5,
    padding: "18px 0",
    cursor: "pointer",
    fontFamily: "'Inter', sans-serif",
  },
  card: {
    background: "#20282c",
    border: `1px solid ${border}`,
    borderRadius: 12,
    padding: "10px 12px",
    cursor: "grab",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    userSelect: "none",
    WebkitUserSelect: "none",
    WebkitTouchCallout: "none",
    boxShadow: shadowSoft,
  },
  dragGhost: {
    position: "fixed",
    background: "#263135",
    border: `1px solid ${teal}`,
    borderRadius: 12,
    padding: "12px 14px",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    pointerEvents: "none",
    zIndex: 200,
    boxShadow: "0 12px 28px rgba(0,0,0,0.4)",
    transform: "rotate(-1.5deg)",
    userSelect: "none",
    WebkitUserSelect: "none",
  },
  cardTop: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  priorityDot: {
    width: 7,
    height: 7,
    borderRadius: "50%",
    flexShrink: 0,
  },
  reviewDot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    flexShrink: 0,
    cursor: "default",
  },
  cardTitle: {
    fontSize: 13.5,
    fontWeight: 500,
    lineHeight: 1.3,
  },
  cardMeta: {
    fontSize: 12,
    color: textMuted,
  },
  cardFooter: {
    display: "flex",
    gap: 6,
    flexWrap: "wrap",
    marginTop: 2,
  },
  cardTag: {
    fontSize: 10.5,
    fontFamily: "'IBM Plex Mono', monospace",
    color: tealLight,
    background: "rgba(47,191,166,0.1)",
    borderRadius: 999,
    padding: "3px 8px",
  },
  needsAttentionBox: {
    border: "1px solid rgba(242,166,90,0.35)",
    background: "rgba(242,166,90,0.06)",
    borderRadius: 12,
    padding: "4px 16px 16px",
  },
  needsAttentionList: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  needsAttentionItem: {
    textAlign: "left",
    background: "transparent",
    border: "none",
    color: "#F2A65A",
    fontSize: 13.5,
    cursor: "pointer",
    padding: "4px 0",
  },
  successRateCard: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    border: `1px solid ${border}`,
    borderRadius: 12,
    padding: 16,
    cursor: "pointer",
  },
  successRateValue: {
    fontSize: 32,
    fontFamily: "'IBM Plex Mono', monospace",
    color: teal,
  },
  readOnlyValue: {
    fontSize: 14,
    color: paper,
    margin: 0,
    display: "flex",
    alignItems: "center",
    gap: 6,
    wordBreak: "break-word",
  },
  copyIconButton: {
    background: "transparent",
    border: "none",
    color: textMuted,
    cursor: "pointer",
    display: "inline-flex",
    padding: 2,
  },
  copiedTag: {
    fontSize: 10.5,
    color: teal,
    fontFamily: "'IBM Plex Mono', monospace",
  },
  badgeRow: {
    display: "flex",
    gap: 6,
    flexWrap: "wrap",
    marginBottom: 4,
  },
  archivedBanner: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 12.5,
    color: textMuted,
    background: "rgba(255,255,255,0.04)",
    border: `1px solid ${border}`,
    borderRadius: 8,
    padding: "8px 12px",
    marginBottom: 4,
  },
  linkButton: {
    background: "transparent",
    border: "none",
    color: teal,
    cursor: "pointer",
    fontSize: 12.5,
    textDecoration: "underline",
    padding: 0,
  },
  timeline: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    maxHeight: 220,
    overflowY: "auto",
    paddingRight: 4,
  },
  timelineItem: {
    display: "flex",
    gap: 10,
    fontSize: 13,
    color: paper,
  },
  timelineDate: {
    color: textMuted,
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 11.5,
    minWidth: 52,
  },
  duplicateBanner: {
    fontSize: 12.5,
    color: "#F2A65A",
    background: "rgba(242,166,90,0.1)",
    border: "1px solid rgba(242,166,90,0.3)",
    borderRadius: 8,
    padding: "8px 12px",
    marginBottom: 4,
  },
  duplicateBannerHard: {
    fontSize: 13,
    color: paper,
    background: "rgba(255,77,77,0.08)",
    border: "1px solid rgba(255,77,77,0.35)",
    borderRadius: 10,
    padding: "10px 14px",
    marginTop: 8,
  },
  cardProgressTrack: {
    height: 4,
    borderRadius: 999,
    background: "rgba(255,255,255,0.06)",
    overflow: "hidden",
    marginTop: 2,
  },
  cardProgressFill: {
    height: "100%",
    borderRadius: 999,
    background: teal,
    transition: "width 0.3s ease",
  },
  driveToast: {
    position: "fixed",
    top: 16,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 200,
    display: "flex",
    alignItems: "center",
    gap: 10,
    background: inkElevated,
    border: `1px solid ${teal}`,
    borderRadius: 12,
    padding: "10px 14px",
    boxShadow: shadowLifted,
    fontSize: 13,
    color: paper,
    maxWidth: "90vw",
  },
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(8,11,12,0.78)",
    backdropFilter: "blur(2px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
    zIndex: 100,
  },
  modal: {
    background: inkElevated,
    borderRadius: 18,
    border: `1px solid ${border}`,
    width: "100%",
    maxWidth: 420,
    maxHeight: "88vh",
    overflowY: "auto",
    padding: 22,
    display: "flex",
    flexDirection: "column",
    gap: 14,
    boxShadow: shadowLifted,
  },
  modalHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  modalTitle: {
    fontFamily: "'Space Grotesk', sans-serif",
    fontSize: 16,
    fontWeight: 600,
  },
  iconButton: {
    background: "transparent",
    border: "none",
    color: textMuted,
    cursor: "pointer",
    display: "flex",
    padding: 4,
  },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    flex: 1,
  },
  fieldRow: {
    display: "flex",
    gap: 12,
  },
  label: {
    fontSize: 11.5,
    color: textMuted,
    fontFamily: "'IBM Plex Mono', monospace",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  fieldHint: {
    fontSize: 11.5,
    color: textMuted,
    margin: "2px 0 0",
    lineHeight: 1.4,
  },
  tabRow: {
    display: "flex",
    gap: 8,
    padding: "0 28px 16px",
  },
  tabRow2: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
  },
  miniChart: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  miniChartRow: {
    display: "grid",
    gridTemplateColumns: "60px 1fr 70px",
    alignItems: "center",
    gap: 10,
  },
  miniChartLabel: {
    fontSize: 11.5,
    color: textMuted,
    fontFamily: "'IBM Plex Mono', monospace",
  },
  miniChartTrack: {
    height: 8,
    borderRadius: 999,
    background: "rgba(255,255,255,0.06)",
    overflow: "hidden",
  },
  miniChartFill: {
    height: "100%",
    borderRadius: 999,
  },
  miniChartValue: {
    fontSize: 11.5,
    color: paper,
    fontFamily: "'IBM Plex Mono', monospace",
    textAlign: "right",
  },
  tabButton: {
    background: "transparent",
    border: `1px solid ${border}`,
    borderRadius: 999,
    color: textMuted,
    fontSize: 13,
    fontWeight: 500,
    padding: "8px 16px",
    cursor: "pointer",
    fontFamily: "'Inter', sans-serif",
  },
  tabButtonActive: {
    background: "rgba(47,191,166,0.14)",
    borderColor: teal,
    color: tealLight,
    fontWeight: 600,
    boxShadow: "0 0 0 1px rgba(47,191,166,0.25)",
  },
  fieldDivider: {
    fontSize: 11.5,
    fontFamily: "'IBM Plex Mono', monospace",
    color: teal,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    borderTop: `1px solid ${border}`,
    paddingTop: 12,
    marginTop: 4,
  },
  emailRow: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  emailRowHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  checkboxLabel: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13,
    color: paper,
  },
  skillChip: {
    display: "inline-flex",
    alignItems: "center",
    border: `1px solid ${border}`,
    borderRadius: 999,
    color: textMuted,
    fontSize: 11,
    padding: "3px 9px",
    fontFamily: "'IBM Plex Mono', monospace",
  },
  skillChipActive: {
    border: `1px solid ${teal}`,
    background: "rgba(47,191,166,0.14)",
    color: tealLight,
  },
  lostReasonGrid: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
  },
  lostReasonButton: {
    background: "rgba(224,122,95,0.1)",
    border: "1px solid #E07A5F",
    color: "#E07A5F",
    borderRadius: 999,
    padding: "7px 14px",
    fontSize: 12.5,
    cursor: "pointer",
    fontFamily: "'Inter', sans-serif",
  },
  wonButton: {
    background: "rgba(47,191,166,0.15)",
    border: `1px solid ${teal}`,
    borderRadius: 999,
    color: tealLight,
    fontSize: 13,
    fontWeight: 600,
    padding: "9px 16px",
    cursor: "pointer",
    fontFamily: "'Inter', sans-serif",
  },
  reviewStatusRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
  },
  fileNameRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    justifyContent: "space-between",
  },
  copyButton: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    background: "transparent",
    border: `1px solid ${border}`,
    borderRadius: 999,
    color: teal,
    fontSize: 11,
    padding: "4px 10px",
    cursor: "pointer",
    fontFamily: "'IBM Plex Mono', monospace",
    flexShrink: 0,
  },
  reviewStatusButton: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    border: "1px solid",
    borderRadius: 999,
    fontSize: 12.5,
    padding: "7px 13px",
    cursor: "pointer",
    fontFamily: "'Inter', sans-serif",
  },
  addRevisionButton: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    background: "transparent",
    border: `1px dashed ${border}`,
    borderRadius: 999,
    color: teal,
    fontSize: 12.5,
    padding: "8px 14px",
    cursor: "pointer",
    fontFamily: "'Inter', sans-serif",
  },
  input: {
    background: "#171d20",
    border: `1px solid ${border}`,
    borderRadius: 10,
    padding: "10px 12px",
    color: paper,
    fontSize: 13.5,
    fontFamily: "'Inter', sans-serif",
    outline: "none",
  },
  textarea: {
    background: "#171d20",
    border: `1px solid ${border}`,
    borderRadius: 10,
    padding: "10px 12px",
    color: paper,
    fontSize: 13.5,
    fontFamily: "'Inter', sans-serif",
    outline: "none",
    resize: "vertical",
  },
  modalFooter: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginTop: 4,
  },
  deleteButton: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    background: "transparent",
    border: "none",
    color: "#E07A5F",
    fontSize: 13,
    cursor: "pointer",
    padding: "8px 4px",
  },
  cancelButton: {
    background: "transparent",
    border: `1px solid ${border}`,
    borderRadius: 999,
    color: paper,
    fontSize: 13,
    padding: "9px 16px",
    cursor: "pointer",
  },
  saveButton: {
    background: teal,
    border: "none",
    borderRadius: 999,
    color: ink,
    fontWeight: 600,
    fontSize: 13,
    padding: "9px 18px",
    cursor: "pointer",
  },
};

