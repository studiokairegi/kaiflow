import React, { useState, useEffect, useCallback, useRef } from "react";
import { supabase, functionUrl } from "./supabaseClient";
import { jsPDF } from "jspdf";
import { genShareToken } from "./SharedViews.jsx";
import { DonutBreakdown, RevenueTrendChart } from "./DashboardCharts.jsx";

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

const LEAD_STAGES = [
  { id: "pool", label: "Email Pool" },
  { id: "cold_email", label: "Cold Email" },
  { id: "no_response", label: "No Response" },
  { id: "responded", label: "Responded" },
  { id: "successful", label: "Successful Leads" },
  { id: "lost", label: "Lost Leads" },
  { id: "won", label: "Deal Won" },
  { id: "closed", label: "Deal Closed" },
];

const LOST_REASONS = [
  "Budget",
  "Timing",
  "Chose another studio",
  "No longer producing",
  "No response",
  "Other",
];

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

function projectBudgetSummary(project, projectCards, projectInvoices) {
  const totalBudget =
    project.budgetMode === "auto"
      ? calculateAutoBudget(projectCards)
      : parseMoney(project.budget);
  const amountPaid = projectInvoices.reduce((sum, inv) => sum + parseMoney(inv.amountPaid), 0);
  const outstanding = Math.max(0, totalBudget - amountPaid);
  return { totalBudget, amountPaid, outstanding };
}

function emptyInvoice(projectId, suggestedNumber, currency = "$") {
  return {
    projectId,
    invoiceNumber: suggestedNumber,
    description: "",
    amount: "",
    amountPaid: "",
    currency,
    issueDate: new Date().toISOString().slice(0, 10),
    dueDate: "",
    status: "unpaid",
    paidDate: "",
  };
}

function invoiceFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    invoiceNumber: row.invoice_number,
    description: row.description,
    amount: row.amount,
    amountPaid: row.amount_paid,
    currency: row.currency || "$",
    issueDate: row.issue_date,
    dueDate: row.due_date,
    status: row.status,
    paidDate: row.paid_date || "",
  };
}

function invoiceToRow(invoice, userId) {
  return {
    project_id: invoice.projectId,
    invoice_number: invoice.invoiceNumber,
    description: invoice.description,
    amount: parseMoney(invoice.amount),
    amount_paid: parseMoney(invoice.amountPaid),
    currency: invoice.currency || "$",
    issue_date: invoice.issueDate,
    due_date: invoice.dueDate,
    status: invoice.status,
    paid_date: invoice.paidDate || "",
    user_id: userId,
  };
}

function nextInvoiceNumber(existingInvoices) {
  const max = existingInvoices.reduce((m, inv) => {
    const match = String(inv.invoiceNumber || "").match(/(\d+)$/);
    const n = match ? parseInt(match[1], 10) : 0;
    return Math.max(m, n);
  }, 0);
  return `INV-${String(max + 1).padStart(4, "0")}`;
}

function nextInvoiceNumbers(existingInvoices, count) {
  const max = existingInvoices.reduce((m, inv) => {
    const match = String(inv.invoiceNumber || "").match(/(\d+)$/);
    const n = match ? parseInt(match[1], 10) : 0;
    return Math.max(m, n);
  }, 0);
  return Array.from({ length: count }, (_, i) => `INV-${String(max + i + 1).padStart(4, "0")}`);
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

const FX_CACHE_KEY = "kaiflow-fx-rates";
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

const AVAILABILITY_OPTIONS = ["available", "busy", "unavailable"];
const AVAILABILITY_COLORS = {
  available: "#3DDC84",
  busy: "#F2A65A",
  unavailable: "#FF4D4D",
};

function emptyTeamMember() {
  return {
    name: "",
    role: "",
    email: "",
    rate: "",
    availability: "available",
    notes: "",
  };
}

function teamMemberFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    email: row.email,
    rate: row.rate,
    availability: row.availability || "available",
    notes: row.notes,
  };
}

function teamMemberToRow(member, userId) {
  return {
    name: member.name,
    role: member.role,
    email: member.email,
    rate: member.rate,
    availability: member.availability || "available",
    notes: member.notes,
    user_id: userId,
  };
}

function computeMemberShots(member, cards, projects) {
  const matching = cards.filter(
    (c) => (c.assignedTo || "").trim().toLowerCase() === member.name.trim().toLowerCase() && member.name.trim()
  );
  const pending = matching
    .filter((c) => !c.assignedPaid && parseMoney(c.assignedPay) > 0)
    .reduce((sum, c) => sum + parseMoney(c.assignedPay), 0);
  const paid = matching
    .filter((c) => c.assignedPaid)
    .reduce((sum, c) => sum + parseMoney(c.assignedPay), 0);
  const withProjectNames = matching.map((c) => ({
    ...c,
    projectName: projects.find((p) => p.id === c.projectId)?.name || "-",
  }));
  return { shots: withProjectNames, pending, paid };
}

function monthKey(dateStr) {
  const d = new Date(dateStr);
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

function computeFinanceData(projects, invoices, expenses, fxRates = {}) {
  const months = lastSixMonthKeys();

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
    .sort((a, b) => (b.daysOverdue || -999) - (a.daysOverdue || -999));

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
  currencySymbol: "$",
  milestoneDefaults: MILESTONE_DEFAULTS,
  defaultLandingTab: "dashboard",
  defaultShotPriority: "normal",
  logoUrl: "",
};

function settingsFromRow(row) {
  if (!row) return DEFAULT_SETTINGS;
  return {
    studioName: row.studio_name || DEFAULT_SETTINGS.studioName,
    studioTagline: row.studio_tagline || DEFAULT_SETTINGS.studioTagline,
    currencySymbol: row.currency_symbol || DEFAULT_SETTINGS.currencySymbol,
    milestoneDefaults:
      Array.isArray(row.milestone_defaults) && row.milestone_defaults.length === 3
        ? row.milestone_defaults
        : MILESTONE_DEFAULTS,
    defaultLandingTab: row.default_landing_tab || DEFAULT_SETTINGS.defaultLandingTab,
    defaultShotPriority: row.default_shot_priority || DEFAULT_SETTINGS.defaultShotPriority,
    logoUrl: row.logo_url || "",
  };
}

function settingsToRow(settings, userId) {
  return {
    user_id: userId,
    studio_name: settings.studioName,
    studio_tagline: settings.studioTagline,
    currency_symbol: settings.currencySymbol,
    milestone_defaults: settings.milestoneDefaults,
    default_landing_tab: settings.defaultLandingTab,
    default_shot_priority: settings.defaultShotPriority,
    logo_url: settings.logoUrl,
  };
}

function computeDashboardStats(projects, cards, leads, invoices, fxRates = {}) {
  const activeProjects = projects.filter((p) => !p.archived);
  const activeLeads = leads.filter((l) => !["won", "lost", "closed"].includes(l.stage));
  const dealsWon = leads.filter((l) => l.stage === "won" || l.stage === "closed").length;
  const dealsLost = leads.filter((l) => l.stage === "lost").length;

  const now = new Date();
  const nearDeadline = activeProjects.filter((p) => {
    if (!p.deadline) return false;
    const d = new Date(p.deadline);
    if (isNaN(d.getTime())) return false;
    const diffDays = (d - now) / 86400000;
    return diffDays <= 7;
  });

  const projectsCompleted = activeProjects.filter((p) => {
    const shots = cards.filter((c) => c.projectId === p.id);
    return shots.length > 0 && shots.every((s) => s.stage === "delivered");
  }).length;

  const thisMonth = now.getMonth();
  const thisYear = now.getFullYear();
  const revenueThisMonth = invoices.reduce((sum, inv) => {
    if (inv.status !== "paid" || !inv.paidDate) return sum;
    const d = new Date(inv.paidDate);
    if (d.getMonth() === thisMonth && d.getFullYear() === thisYear) {
      return sum + convertToUSD(inv.amountPaid, inv.currency, fxRates);
    }
    return sum;
  }, 0);

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

  doc.setFontSize(18);
  doc.text(settings.studioName || "Studio Kairegi", 20, 22);
  doc.setFontSize(11);
  doc.setTextColor(100);
  doc.text(settings.studioTagline || "Anime-style animation & production", 20, 29);

  doc.setTextColor(0);
  doc.setFontSize(14);
  doc.text(`Invoice ${invoice.invoiceNumber}`, 20, 45);

  doc.setFontSize(10);
  doc.text(`Issue date: ${invoice.issueDate || "-"}`, 20, 53);
  doc.text(`Due date: ${invoice.dueDate || "-"}`, 20, 59);
  doc.text(`Status: ${invoice.status === "paid" ? "Paid" : "Unpaid"}`, 20, 65);

  doc.text(`Bill to: ${project?.client || "-"}`, 130, 53);
  doc.text(`Project: ${project?.name || "-"}`, 130, 59);

  doc.setDrawColor(200);
  doc.line(20, 74, 190, 74);

  doc.setFontSize(11);
  doc.text("Description", 20, 84);
  doc.text("Amount", 170, 84, { align: "right" });
  doc.setFontSize(10);
  const descLines = doc.splitTextToSize(invoice.description || "Animation services", 140);
  doc.text(descLines, 20, 92);
  doc.text(`${cur}${formatMoney(invoice.amount)}`, 170, 92, { align: "right" });

  const lineY = 92 + descLines.length * 6 + 6;
  doc.line(20, lineY, 190, lineY);

  doc.setFontSize(10);
  doc.text("Amount paid", 130, lineY + 10);
  doc.text(`${cur}${formatMoney(invoice.amountPaid)}`, 170, lineY + 10, { align: "right" });
  doc.setFontSize(12);
  doc.text("Balance due", 130, lineY + 20);
  doc.text(`${cur}${formatMoney(balance)}`, 170, lineY + 20, { align: "right" });

  doc.setFontSize(9);
  doc.setTextColor(130);
  doc.text(`Thank you for working with ${settings.studioName || "Studio Kairegi"}.`, 20, lineY + 40);

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
    assigned_pay: parseMoney(card.assignedPay),
    assigned_paid: card.assignedPaid || false,
    share_token: card.shareToken || null,
    attachments: card.attachments || [],
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
  ];
}

function emptyLead(stage = "pool") {
  return {
    companyName: "",
    contactPerson: "",
    email: "",
    website: "",
    country: "",
    notes: "",
    stage,
    emails: emptyEmails(),
    proposedBudget: "",
    estimatedDeadline: "",
    projectNotes: "",
    lostReason: "",
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
    notes: row.notes,
    stage: row.stage,
    emails: row.emails && row.emails.length ? row.emails : emptyEmails(),
    proposedBudget: row.proposed_budget,
    estimatedDeadline: row.estimated_deadline,
    projectNotes: row.project_notes,
    lostReason: row.lost_reason,
    linkedProjectId: row.linked_project_id,
  };
}

function leadToRow(lead, userId) {
  return {
    company_name: lead.companyName,
    contact_person: lead.contactPerson,
    email: lead.email,
    website: lead.website,
    country: lead.country,
    notes: lead.notes,
    stage: lead.stage,
    emails: lead.emails,
    proposed_budget: lead.proposedBudget,
    estimated_deadline: lead.estimatedDeadline,
    project_notes: lead.projectNotes,
    lost_reason: lead.lostReason,
    linked_project_id: lead.linkedProjectId || null,
    user_id: userId,
  };
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

const GearIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

export default function ShotTracker() {
  const [session, setSession] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authMode, setAuthMode] = useState("signin");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authNotice, setAuthNotice] = useState("");

  const [data, setData] = useState({
    projects: [],
    cards: [],
    leads: [],
    invoices: [],
    expenses: [],
    teamMembers: [],
    activity: [],
  });
  const { projects, cards, leads, invoices, expenses, teamMembers, activity } = data;
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [fxRates, setFxRates] = useState({});
  const [fxUpdatedAt, setFxUpdatedAt] = useState(null);
  const [driveEmail, setDriveEmail] = useState(null);
  const [driveNotice, setDriveNotice] = useState("");
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
  const [editingTeamMember, setEditingTeamMember] = useState(null);
  const [showMilestoneModal, setShowMilestoneModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [pendingLeadLinkId, setPendingLeadLinkId] = useState(null);
  const [dragOverStage, setDragOverStage] = useState(null);
  const [dragVisual, setDragVisual] = useState(null);
  const [saveState, setSaveState] = useState("idle");

  const dataRef = useRef(data);
  const dragStateRef = useRef(null);
  const suppressClickRef = useRef(false);
  const hasAppliedLandingTab = useRef(false);

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
    });
    return () => listener.subscription.unsubscribe();
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
    window.location.href = `${functionUrl("google-drive-connect")}?token=${currentSession.access_token}`;
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
      } else {
        const { error: insertError } = await supabase
          .from("user_settings")
          .insert(settingsToRow(DEFAULT_SETTINGS, userId));
        if (insertError) throw insertError;
        setSettings(DEFAULT_SETTINGS);
        hasAppliedLandingTab.current = true;
      }
    } catch (e) {
      console.error("Settings load failed:", e);
    }
  }, [userId]);

  useEffect(() => {
    if (userId) loadSettings();
    else setSettings(DEFAULT_SETTINGS);
  }, [userId, loadSettings]);

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
    setShowSettingsModal(false);
  };

  const loadData = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const [projectsRes, shotsRes, leadsRes, invoicesRes, expensesRes, teamRes, activityRes] = await Promise.all([
        supabase.from("projects").select("*").order("created_at"),
        supabase.from("shots").select("*").order("created_at"),
        supabase.from("leads").select("*").order("created_at"),
        supabase.from("invoices").select("*").order("created_at"),
        supabase.from("expenses").select("*").order("created_at"),
        supabase.from("team_members").select("*").order("created_at"),
        supabase.from("activity_log").select("*").order("created_at", { ascending: false }),
      ]);
      if (projectsRes.error) throw projectsRes.error;
      if (shotsRes.error) throw shotsRes.error;
      if (leadsRes.error) throw leadsRes.error;
      if (invoicesRes.error) throw invoicesRes.error;
      if (expensesRes.error) throw expensesRes.error;
      if (teamRes.error) throw teamRes.error;
      if (activityRes.error) throw activityRes.error;
      const nextProjects = (projectsRes.data || []).map((p) => ({
        id: p.id,
        name: p.name,
        client: p.client,
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
      }));
      const nextCards = (shotsRes.data || []).map(cardFromRow);
      const nextLeads = (leadsRes.data || []).map(leadFromRow);
      const nextInvoices = (invoicesRes.data || []).map(invoiceFromRow);
      const nextExpenses = (expensesRes.data || []).map(expenseFromRow);
      const nextTeamMembers = (teamRes.data || []).map(teamMemberFromRow);
      const nextActivity = (activityRes.data || []).map((a) => ({
        id: a.id,
        projectId: a.project_id,
        shotId: a.shot_id,
        type: a.event_type,
        message: a.description,
        createdAt: a.created_at,
      }));
      setData({
        projects: nextProjects,
        cards: nextCards,
        leads: nextLeads,
        invoices: nextInvoices,
        expenses: nextExpenses,
        teamMembers: nextTeamMembers,
        activity: nextActivity,
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
      });
  }, [userId, loadData]);

  const flashSave = (ok) => {
    setSaveState(ok ? "saved" : "error");
    setTimeout(() => setSaveState("idle"), 1200);
  };

  const handleSaveProject = async (project) => {
    setSaveState("saving");
    try {
      const shareToken = project.shareEnabled ? project.shareToken || genShareToken() : project.shareToken;
      if (project.id) {
        const { error } = await supabase
          .from("projects")
          .update({
            name: project.name,
            client: project.client,
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
        const { data: inserted, error } = await supabase
          .from("projects")
          .insert({
            name: project.name,
            client: project.client,
            notes: project.notes,
            budget: project.budget,
            budget_mode: project.budgetMode,
            currency: project.currency,
            deadline: project.deadline,
            priority: project.priority,
            share_enabled: project.shareEnabled,
            share_token: shareToken,
            user_id: userId,
          })
          .select()
          .single();
        if (error) throw error;

        let newCards = [];
        const checklist = generateShotChecklist(project.shotCount, inserted.id, project.client);
        if (checklist.length > 0) {
          const rows = checklist.map((c) => cardToRow(c, userId));
          const { data: insertedShots, error: shotsError } = await supabase
            .from("shots")
            .insert(rows)
            .select();
          if (shotsError) throw shotsError;
          newCards = (insertedShots || []).map(cardFromRow);
        }

        setData((prev) => ({
          ...prev,
          projects: [
            ...prev.projects,
            {
              id: inserted.id,
              name: inserted.name,
              client: inserted.client,
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
            },
          ],
          cards: [...prev.cards, ...newCards],
        }));

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
    } catch (e) {
      console.error("Project save failed:", e);
      flashSave(false);
    }
    setEditingProject(null);
  };

  const handleDeleteProject = async (id) => {
    setSaveState("saving");
    try {
      const { error } = await supabase.from("projects").delete().eq("id", id);
      if (error) throw error;
      setData((prev) => ({
        ...prev,
        projects: prev.projects.filter((p) => p.id !== id),
        cards: prev.cards.filter((c) => c.projectId !== id),
      }));
      flashSave(true);
    } catch (e) {
      console.error("Project delete failed:", e);
      flashSave(false);
    }
    setEditingProject(null);
    if (selectedProjectId === id) {
      setView("projects");
      setSelectedProjectId(null);
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
    } catch (e) {
      console.error("Shot save failed:", e);
      flashSave(false);
    }
    setEditingCard(null);
  };

  const handleDeleteCard = async (id) => {
    setSaveState("saving");
    try {
      const { error } = await supabase.from("shots").delete().eq("id", id);
      if (error) throw error;
      setData((prev) => ({ ...prev, cards: prev.cards.filter((c) => c.id !== id) }));
      flashSave(true);
    } catch (e) {
      console.error("Shot delete failed:", e);
      flashSave(false);
    }
    setEditingCard(null);
  };

  const moveCardStage = async (id, stage) => {
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

  const handleSaveLead = async (lead) => {
    setSaveState("saving");
    try {
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
        setData((prev) => ({ ...prev, leads: [...prev.leads, leadFromRow(inserted)] }));
      }
      flashSave(true);
    } catch (e) {
      console.error("Lead save failed:", e);
      flashSave(false);
    }
    setEditingLead(null);
  };

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
    setData((prev) => ({
      ...prev,
      leads: prev.leads.map((l) => (l.id === id ? { ...l, stage } : l)),
    }));
    setSaveState("saving");
    try {
      const { error } = await supabase.from("leads").update({ stage }).eq("id", id);
      if (error) throw error;
      flashSave(true);
    } catch (e) {
      console.error("Lead stage move failed:", e);
      flashSave(false);
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
    await handleSaveLead(wonLead);
    setPendingLeadLinkId(lead.id || null);
    setWorkspace("projects");
    setView("projects");
    setEditingProject(
      emptyProject({
        name: lead.companyName,
        client: lead.contactPerson || lead.companyName,
        notes: lead.projectNotes || lead.notes,
        budget: lead.proposedBudget,
        currency: settings.currencySymbol,
        deadline: lead.estimatedDeadline,
      })
    );
  };

  const handleMarkLost = async (lead, reason) => {
    await handleSaveLead({ ...lead, stage: "lost", lostReason: reason });
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
    } catch (e) {
      console.error("Invoice save failed:", e);
      flashSave(false);
    }
    setEditingInvoice(null);
  };

  const handleDeleteInvoice = async (id) => {
    setSaveState("saving");
    try {
      const { error } = await supabase.from("invoices").delete().eq("id", id);
      if (error) throw error;
      setData((prev) => ({ ...prev, invoices: prev.invoices.filter((inv) => inv.id !== id) }));
      flashSave(true);
    } catch (e) {
      console.error("Invoice delete failed:", e);
      flashSave(false);
    }
    setEditingInvoice(null);
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

  const handleCreateMilestones = async (percentages) => {
    const projectInvoices = invoices.filter((inv) => inv.projectId === selectedProjectId);
    const project = projects.find((p) => p.id === selectedProjectId);
    const projectShots = cards.filter((c) => c.projectId === selectedProjectId);
    const { totalBudget } = projectBudgetSummary(project, projectShots, projectInvoices);
    const numbers = nextInvoiceNumbers(projectInvoices, 3);
    for (let i = 0; i < 3; i++) {
      const amount = ((totalBudget * (parseFloat(percentages[i]) || 0)) / 100).toFixed(2);
      await handleSaveInvoice({
        projectId: selectedProjectId,
        invoiceNumber: numbers[i],
        description: MILESTONE_LABELS[i],
        amount,
        amountPaid: "",
        currency: project?.currency || settings.currencySymbol,
        issueDate: new Date().toISOString().slice(0, 10),
        dueDate: "",
        status: "unpaid",
      });
    }
    setShowMilestoneModal(false);
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
    } catch (e) {
      console.error("Expense save failed:", e);
      flashSave(false);
    }
    setEditingExpense(null);
  };

  const handleLogShotExpense = async (card) => {
    await handleSaveExpense({
      projectId: card.projectId,
      category: "Animator Payments",
      description: `${card.title || "Shot"}${card.assignedTo ? " \u2014 " + card.assignedTo : ""}`,
      amount: card.assignedPay,
      date: new Date().toISOString().slice(0, 10),
    });
    try {
      const { error } = await supabase.from("shots").update({ assigned_paid: true }).eq("id", card.id);
      if (error) throw error;
      setData((prev) => ({
        ...prev,
        cards: prev.cards.map((c) => (c.id === card.id ? { ...c, assignedPaid: true } : c)),
      }));
    } catch (e) {
      console.error("Marking shot as paid failed:", e);
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
      flashSave(true);
    } catch (e) {
      console.error("Team member save failed:", e);
      flashSave(false);
    }
    setEditingTeamMember(null);
  };

  const handleDeleteTeamMember = async (id) => {
    setSaveState("saving");
    try {
      const { error } = await supabase.from("team_members").delete().eq("id", id);
      if (error) throw error;
      setData((prev) => ({ ...prev, teamMembers: prev.teamMembers.filter((m) => m.id !== id) }));
      flashSave(true);
    } catch (e) {
      console.error("Team member delete failed:", e);
      flashSave(false);
    }
    setEditingTeamMember(null);
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
    setData({ projects: [], cards: [], leads: [], invoices: [], expenses: [], teamMembers: [], activity: [] });
    setView("projects");
    setSelectedProjectId(null);
  };

  const endDrag = useCallback(() => {
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
    if (!ds.moved && Math.hypot(dx, dy) > 6) {
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
        if (stage) {
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
    dragStateRef.current = {
      kind,
      id: card.id,
      title: kind === "lead" ? card.companyName : card.title,
      client: kind === "lead" ? card.contactPerson : card.client,
      startX: e.clientX,
      startY: e.clientY,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      width: rect.width,
      moved: false,
    };
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

  if (authLoading) {
    return (
      <div style={styles.loadingScreen}>
        <div style={styles.loadingClap}><ClapperIcon /></div>
      </div>
    );
  }

  if (!session) {
    return (
      <div style={styles.app}>
        <style>{fontImport}</style>
        <div style={styles.lockScreen}>
          <div style={styles.logoMark}><ClapperIcon /></div>
          <h1 style={styles.title}>KaiFlow</h1>
          <p style={styles.subtitle}>CRM plus Shot Tracker</p>

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
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={styles.loadingScreen}>
        <div style={styles.loadingClap}><ClapperIcon /></div>
      </div>
    );
  }

  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const projectCards = cards.filter((c) => c.projectId === selectedProjectId);
  const { delivered: deliveredCount, percent: overallPercent } = projectProgress(projectCards);
  const showTabs = view !== "board";

  return (
    <div style={styles.app}>
      <style>{fontImport}</style>

      <header style={styles.header}>
        <div style={styles.headerLeft}>
          {view === "board" ? (
            <button style={styles.backButton} onClick={() => setView("projects")}>
              <BackIcon />
            </button>
          ) : (
            <div style={styles.logoMark}><ClapperIcon /></div>
          )}
          <div>
            <h1 style={styles.title}>
              {view === "board"
                ? selectedProject?.name || "Project"
                : workspace === "leads"
                ? "Leads"
                : workspace === "dashboard"
                ? "Dashboard"
                : workspace === "finance"
                ? "Finance"
                : workspace === "teams"
                ? "Teams"
                : "KaiFlow"}
            </h1>
            <p style={styles.subtitle}>
              {view === "board" ? selectedProject?.client || settings.studioName : session.user.email}
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
          <button style={styles.iconButtonGhost} onClick={() => setShowSettingsModal(true)} title="Settings">
            <GearIcon />
          </button>
          <button style={styles.iconButtonGhost} onClick={handleSignOut} title="Sign out">
            <SignOutIcon />
          </button>
          {view === "board" && boardTab === "invoices" ? (
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
          ) : workspace === "dashboard" ? null : (
            <button style={styles.newButton} onClick={() => setEditingProject(emptyProject({ currency: settings.currencySymbol }))}>
              <PlusIcon />
              New project
            </button>
          )}
        </div>
      </header>

      {showTabs && (
        <div style={styles.tabRow}>
          <button
            style={{ ...styles.tabButton, ...(workspace === "dashboard" ? styles.tabButtonActive : {}) }}
            onClick={() => setWorkspace("dashboard")}
          >
            Dashboard
          </button>
          <button
            style={{ ...styles.tabButton, ...(workspace === "projects" ? styles.tabButtonActive : {}) }}
            onClick={() => setWorkspace("projects")}
          >
            Projects
          </button>
          <button
            style={{ ...styles.tabButton, ...(workspace === "leads" ? styles.tabButtonActive : {}) }}
            onClick={() => setWorkspace("leads")}
          >
            Leads
          </button>
          <button
            style={{ ...styles.tabButton, ...(workspace === "finance" ? styles.tabButtonActive : {}) }}
            onClick={() => setWorkspace("finance")}
          >
            Finance
          </button>
          <button
            style={{ ...styles.tabButton, ...(workspace === "teams" ? styles.tabButtonActive : {}) }}
            onClick={() => setWorkspace("teams")}
          >
            Teams
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
          onGoToLeads={() => setWorkspace("leads")}
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
        />
      )}

      {view === "projects" && workspace === "leads" && (
        <div style={{ ...styles.board, touchAction: dragVisual ? "none" : "auto" }}>
          {LEAD_STAGES.map((stage) => {
            const stageLeads = leads.filter((l) => l.stage === stage.id);
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
                      onClick={() => setEditingLead(emptyLead(stage.id))}
                    >
                      <PlusIcon />
                      Add lead
                    </button>
                  )}
                  {stageLeads.map((lead) => {
                    const sentCount = lead.emails.filter((e) => e.sent).length;
                    return (
                      <div
                        key={lead.id}
                        onPointerDown={(e) => handlePointerDown(e, lead, "lead")}
                        onClick={() => handleLeadClick(lead)}
                        style={{
                          ...styles.card,
                          opacity: dragStateRef.current?.id === lead.id && dragVisual ? 0.4 : 1,
                          touchAction: "none",
                        }}
                      >
                        <div style={styles.cardTop}>
                          <span style={styles.cardTitle}>
                            {lead.companyName || "Untitled lead"}
                          </span>
                        </div>
                        {lead.contactPerson && (
                          <div style={styles.cardMeta}>{lead.contactPerson}</div>
                        )}
                        <div style={styles.cardFooter}>
                          {sentCount > 0 && (
                            <span style={styles.cardTag}>{sentCount}/4 emails sent</span>
                          )}
                          {lead.stage === "lost" && lead.lostReason && (
                            <span style={styles.cardTag}>{lead.lostReason}</span>
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

      {view === "projects" && workspace === "teams" && (
        <TeamsPanel
          teamMembers={teamMembers}
          cards={cards}
          projects={projects}
          settings={settings}
          onEdit={setEditingTeamMember}
          onNew={() => setEditingTeamMember(emptyTeamMember())}
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
                        touchAction: "none",
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
          onDownload={(inv) => downloadInvoicePDF(inv, selectedProject, settings)}
          onOpenMilestones={() => setShowMilestoneModal(true)}
          currencySymbol={selectedProject?.currency || settings.currencySymbol}
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

      {showSettingsModal && (
        <SettingsModal
          settings={settings}
          email={session.user.email}
          driveEmail={driveEmail}
          onConnectDrive={handleConnectDrive}
          onCancel={() => setShowSettingsModal(false)}
          onSave={handleSaveSettings}
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
          onCancel={() => setEditingTeamMember(null)}
          onSave={handleSaveTeamMember}
          onDelete={handleDeleteTeamMember}
          isNew={!editingTeamMember.id}
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
        />
      )}

      {editingProject && (
        <ProjectEditor
          project={editingProject}
          onCancel={() => setEditingProject(null)}
          onSave={handleSaveProject}
          onDelete={handleDeleteProject}
          isNew={!editingProject.id}
          driveEmail={driveEmail}
          onCreateDriveFolders={handleCreateDriveFolders}
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
          isNew={!editingLead.id}
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
        />
      )}
    </div>
  );
}

function ProjectsGrid({ projects, cards, onOpen, onEdit, onNew, onToggleArchive }) {
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

function ProjectCard({ project, cards, onOpen, onEdit, onToggleArchive, archived }) {
  const projectCards = cards.filter((c) => c.projectId === project.id);
  const { delivered, percent } = projectProgress(projectCards);
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

function MiniBarChart({ items, currencySymbol = "$", color = teal }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div style={styles.miniChart}>
      {items.map((item) => (
        <div key={item.label} style={styles.miniChartRow}>
          <span style={styles.miniChartLabel}>{item.label}</span>
          <div style={styles.miniChartTrack}>
            <div
              style={{
                ...styles.miniChartFill,
                width: `${Math.max(2, (item.value / max) * 100)}%`,
                background: color,
              }}
            />
          </div>
          <span style={styles.miniChartValue}>
            {currencySymbol}
            {formatMoney(item.value)}
          </span>
        </div>
      ))}
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
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div>
            <div style={styles.fieldDivider}>Revenue by month</div>
            <MiniBarChart items={finance.revenueByMonth} currencySymbol={cur} color="#3DDC84" />
          </div>
          <div>
            <div style={styles.fieldDivider}>Expenses by month</div>
            <MiniBarChart items={finance.expensesByMonth} currencySymbol={cur} color="#FF4D4D" />
          </div>
          <div>
            <div style={styles.fieldDivider}>Profit by month</div>
            <MiniBarChart items={finance.profitByMonth} currencySymbol={cur} color={teal} />
          </div>
          <div>
            <div style={styles.fieldDivider}>Revenue by client</div>
            {finance.revenueByClient.length === 0 ? (
              <p style={styles.fieldHint}>No revenue recorded yet.</p>
            ) : (
              <MiniBarChart items={finance.revenueByClient} currencySymbol={cur} color="#4A90D9" />
            )}
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

function TeamsPanel({ teamMembers, cards, projects, settings, onEdit, onNew }) {
  const cur = settings.currencySymbol || "$";

  if (teamMembers.length === 0) {
    return (
      <div style={styles.invoicesWrap}>
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
      <div style={styles.invoiceList}>
        {teamMembers.map((member) => {
          const { shots, pending, paid } = computeMemberShots(member, cards, projects);
          return (
            <div key={member.id} className="kf-card" style={styles.invoiceCard} onClick={() => onEdit(member)}>
              <div style={styles.invoiceCardTop}>
                <span style={styles.invoiceNumber}>{member.name || "Untitled member"}</span>
                <span
                  style={{
                    ...styles.invoiceStatusTag,
                    color: AVAILABILITY_COLORS[member.availability] || "#8b9a98",
                    borderColor: AVAILABILITY_COLORS[member.availability] || "#8b9a98",
                    textTransform: "capitalize",
                  }}
                >
                  {member.availability}
                </span>
              </div>
              {member.role && <div style={styles.cardMeta}>{member.role}</div>}
              <div style={styles.invoiceAmountsRow}>
                <span style={styles.fieldHint}>
                  {shots.length} shot{shots.length === 1 ? "" : "s"} assigned
                </span>
                {member.rate && <span style={styles.fieldHint}>Rate {member.rate}</span>}
              </div>
              <div style={styles.invoiceAmountsRow}>
                <span style={{ ...styles.fieldHint, color: "#F2A65A" }}>
                  Pending {cur}
                  {formatMoney(pending)}
                </span>
                <span style={{ ...styles.fieldHint, color: "#3DDC84" }}>
                  Paid {cur}
                  {formatMoney(paid)}
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
          );
        })}
      </div>
    </div>
  );
}

function DashboardPanel({ projects, cards, leads, invoices, settings, fxRates, onOpenProject, onGoToProjects, onGoToLeads }) {
  const stats = computeDashboardStats(projects, cards, leads, invoices, fxRates);
  const cur = "$"; // Dashboard totals are always USD-converted for cross-project consistency

  const statItems = [
    { label: "Active projects", value: stats.activeProjectsCount, onClick: onGoToProjects },
    { label: "Active leads", value: stats.activeLeadsCount, onClick: onGoToLeads },
    { label: "Total shots", value: stats.totalShots },
    { label: "Projects completed", value: stats.projectsCompleted },
    { label: "Deals won", value: stats.dealsWon, onClick: onGoToLeads },
    { label: "Deals lost", value: stats.dealsLost, onClick: onGoToLeads },
    { label: "Revenue this month", value: `${cur}${formatMoney(stats.revenueThisMonth)}` },
    {
      label: "Outstanding invoices",
      value: `${stats.outstandingCount} \u00b7 ${cur}${formatMoney(stats.outstandingTotal)}`,
    },
  ];

  const shotsByStage = STAGES.map((s) => ({
    label: s.label,
    value: cards.filter((c) => c.stage === s.id).length,
  }));

  const leadsByStage = LEAD_STAGES.map((s) => ({
    label: s.label,
    value: leads.filter((l) => l.stage === s.id).length,
  }));

  const months = lastSixMonthKeys();
  const revenueTrend = months.map(({ key, label }) => ({
    label,
    value: invoices
      .filter((inv) => inv.status === "paid" && monthKey(inv.paidDate) === key)
      .reduce((sum, inv) => sum + convertToUSD(inv.amountPaid, inv.currency, fxRates), 0),
  }));

  return (
    <div style={styles.invoicesWrap}>
      <p style={styles.fieldHint}>
        Dollar figures below are converted live from each project's own currency to USD.
      </p>
      <div style={styles.dashboardGrid}>
        {statItems.map((item) => (
          <div
            key={item.label}
            style={{ ...styles.budgetStat, cursor: item.onClick ? "pointer" : "default" }}
            onClick={item.onClick}
          >
            <span style={styles.label}>{item.label}</span>
            <span style={styles.budgetStatValue}>{item.value}</span>
          </div>
        ))}
      </div>

      <div>
        <div style={styles.fieldDivider}>Revenue trend (6 months)</div>
        <RevenueTrendChart data={revenueTrend} currencySymbol={cur} />
      </div>

      <div style={styles.dashboardChartsRow}>
        <div style={{ flex: "1 1 260px" }}>
          <div style={styles.fieldDivider}>Shots by stage</div>
          <DonutBreakdown data={shotsByStage} emptyLabel="No shots yet." />
        </div>
        <div style={{ flex: "1 1 260px" }}>
          <div style={styles.fieldDivider}>Leads by stage</div>
          <DonutBreakdown data={leadsByStage} emptyLabel="No leads yet." />
        </div>
      </div>

      <div>
        <div style={styles.fieldDivider}>Projects near deadline</div>
        {stats.nearDeadline.length === 0 ? (
          <p style={styles.fieldHint}>Nothing coming up in the next 7 days.</p>
        ) : (
          <div style={styles.invoiceList}>
            {stats.nearDeadline.map((p) => (
              <div key={p.id} className="kf-card" style={styles.invoiceCard} onClick={() => onOpenProject(p.id)}>
                <div style={styles.invoiceCardTop}>
                  <span style={styles.invoiceNumber}>{p.name}</span>
                  <span style={styles.fieldHint}>{p.deadline}</span>
                </div>
                {p.client && <div style={styles.cardMeta}>{p.client}</div>}
              </div>
            ))}
          </div>
        )}
      </div>

      <p style={styles.fieldHint}>
        For accounts receivable, per-project profitability, and client value, check the Finance tab.
      </p>
    </div>
  );
}

function SettingsModal({ settings, email, driveEmail, onConnectDrive, onCancel, onSave }) {
  const [form, setForm] = useState(settings);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  const setMilestone = (i) => (e) => {
    const next = [...form.milestoneDefaults];
    next[i] = e.target.value;
    setForm({ ...form, milestoneDefaults: next });
  };

  return (
    <div style={styles.overlay} onClick={onCancel}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <span style={styles.modalTitle}>Settings</span>
          <button style={styles.iconButton} onClick={onCancel}>
            <CloseIcon />
          </button>
        </div>

        <div style={styles.field}>
          <label style={styles.label}>Account email</label>
          <p style={styles.fieldHint}>{email}</p>
        </div>

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

        <div style={styles.modalFooter}>
          <div style={{ flex: 1 }} />
          <button style={styles.cancelButton} onClick={onCancel}>
            Cancel
          </button>
          <button style={styles.saveButton} onClick={() => onSave(form)}>
            Save settings
          </button>
        </div>
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

function InvoicesPanel({ project, projectCards, invoices, onNew, onEdit, onMarkPaid, onDownload, onOpenMilestones, currencySymbol }) {
  const cur = currencySymbol || "$";
  if (!project) return null;
  const { totalBudget, amountPaid, outstanding } = projectBudgetSummary(project, projectCards, invoices);

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
            <button style={styles.cancelButton} onClick={onOpenMilestones}>
              Set up milestones
            </button>
          </div>
        </div>
      ) : (
        <>
          <button style={{ ...styles.cancelButton, alignSelf: "flex-start" }} onClick={onOpenMilestones}>
            Set up milestones
          </button>
        </>
      )}

      {invoices.length > 0 && (
        <div style={styles.invoiceList}>
          {invoices.map((inv) => {
            const balance = parseMoney(inv.amount) - parseMoney(inv.amountPaid);
            return (
              <div key={inv.id} className="kf-card" style={styles.invoiceCard} onClick={() => onEdit(inv)}>
                <div style={styles.invoiceCardTop}>
                  <span style={styles.invoiceNumber}>{inv.invoiceNumber}</span>
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
                {inv.description && <div style={styles.cardMeta}>{inv.description}</div>}
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

function ProjectEditor({ project, onCancel, onSave, onDelete, isNew, driveEmail, onCreateDriveFolders }) {
  const [form, setForm] = useState(project);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  const [linkCopied, setLinkCopied] = useState(false);
  const [creatingFolders, setCreatingFolders] = useState(false);
  const [driveError, setDriveError] = useState("");

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
          <label style={styles.label}>Deadline</label>
          <input
            style={styles.input}
            value={form.deadline || ""}
            onChange={set("deadline")}
            placeholder="e.g. Aug 15"
          />
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
            onClick={() => onSave({ ...form, name: form.name || "Untitled project" })}
          >
            Save project
          </button>
        </div>
      </div>
    </div>
  );
}

function LeadEditor({ lead, onCancel, onSave, onDelete, onMarkWon, onMarkLost, isNew }) {
  const [form, setForm] = useState(lead);
  const [showLostReasons, setShowLostReasons] = useState(false);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  const updateEmail = (index, patch) => {
    const nextEmails = form.emails.map((em, i) => {
      if (i !== index) return em;
      const updated = { ...em, ...patch };
      if (patch.sent === true && !em.sent) {
        updated.dateSent = new Date().toISOString().slice(0, 10);
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
    if (index === 3 && patch.sent === true && (form.stage === "pool" || form.stage === "cold_email")) {
      nextStage = "no_response";
    }
    setForm({ ...form, emails: nextEmails, stage: nextStage });
  };

  const showNegotiation = !["pool", "cold_email"].includes(form.stage);

  return (
    <div style={styles.overlay} onClick={onCancel}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <span style={styles.modalTitle}>{isNew ? "New lead" : "Edit lead"}</span>
          <button style={styles.iconButton} onClick={onCancel}>
            <CloseIcon />
          </button>
        </div>

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
            <input
              style={styles.input}
              value={form.email}
              onChange={set("email")}
              placeholder="jamie@studio.com"
            />
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
          <label style={styles.label}>Client notes</label>
          <textarea
            style={styles.textarea}
            value={form.notes}
            onChange={set("notes")}
            placeholder="What they do, style, references, budget signals, source of lead..."
            rows={3}
          />
        </div>

        <div style={styles.fieldDivider}>Outreach</div>

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

        {form.stage === "lost" && form.lostReason && (
          <p style={styles.fieldHint}>Marked lost: {form.lostReason}</p>
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
          {!showLostReasons && form.stage !== "won" && form.stage !== "closed" && (
            <button
              style={styles.cancelButton}
              onClick={() => setShowLostReasons(true)}
            >
              Mark lost
            </button>
          )}
          {form.stage !== "won" && form.stage !== "closed" && (
            <button style={styles.wonButton} onClick={() => onMarkWon(form)}>
              Mark won
            </button>
          )}
          <button
            style={styles.saveButton}
            onClick={() => onSave({ ...form, companyName: form.companyName || "Untitled lead" })}
          >
            Save lead
          </button>
        </div>
      </div>
    </div>
  );
}

function CardEditor({ card, onCancel, onSave, onDelete, isNew, onPersistShareToken, onLogExpense }) {
  const [form, setForm] = useState(card);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

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
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const path = `${user.id}/${form.id || "new"}-${Date.now()}-${file.name}`;
      const { error: uploadErr } = await supabase.storage.from("attachments").upload(path, file);
      if (uploadErr) throw uploadErr;
      const { data: publicUrlData } = supabase.storage.from("attachments").getPublicUrl(path);
      const newAttachment = { name: file.name, path, url: publicUrlData.publicUrl };
      const nextAttachments = [...(form.attachments || []), newAttachment];
      setForm({ ...form, attachments: nextAttachments });
      if (onPersistShareToken && form.id) {
        await onPersistShareToken(form.id, form.shareToken, nextAttachments);
      }
    } catch (err) {
      console.error("Upload failed:", err);
      setUploadError(err.message || "Upload failed");
    }
    setUploading(false);
  };

  const removeAttachment = async (index) => {
    const nextAttachments = form.attachments.filter((_, i) => i !== index);
    setForm({ ...form, attachments: nextAttachments });
    if (onPersistShareToken && form.id) {
      await onPersistShareToken(form.id, form.shareToken, nextAttachments);
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
          <input
            style={styles.input}
            value={form.assignedTo || ""}
            onChange={set("assignedTo")}
            placeholder="e.g. Kevin (in-betweener)"
          />
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

        {isNew ? (
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

function TeamMemberEditor({ member, onCancel, onSave, onDelete, isNew }) {
  const [form, setForm] = useState(member);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

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
            <label style={styles.label}>Rate</label>
            <input
              style={styles.input}
              value={form.rate}
              onChange={set("rate")}
              placeholder="e.g. $15/cut"
            />
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
                    textTransform: "capitalize",
                  }}
                  onClick={() => setForm({ ...form, availability: status })}
                >
                  {status}
                </button>
              );
            })}
          </div>
        </div>

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
            onClick={() => onSave({ ...form, name: form.name || "Untitled member" })}
          >
            Save member
          </button>
        </div>
      </div>
    </div>
  );
}

function InvoiceEditor({ invoice, onCancel, onSave, onDelete, isNew, currencySymbol }) {
  const [form, setForm] = useState({ currency: currencySymbol || "$", ...invoice });
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  const balance = parseMoney(form.amount) - parseMoney(form.amountPaid);
  const cur = form.currency || currencySymbol || "$";

  return (
    <div style={styles.overlay} onClick={onCancel}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <span style={styles.modalTitle}>{isNew ? "New invoice" : "Edit invoice"}</span>
          <button style={styles.iconButton} onClick={onCancel}>
            <CloseIcon />
          </button>
        </div>

        <div style={styles.fieldRow}>
          <div style={styles.field}>
            <label style={styles.label}>Invoice number</label>
            <input
              style={styles.input}
              value={form.invoiceNumber}
              onChange={set("invoiceNumber")}
              placeholder="e.g. INV-0001"
              autoFocus
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
          <label style={styles.label}>Description</label>
          <textarea
            style={styles.textarea}
            value={form.description}
            onChange={set("description")}
            placeholder="e.g. Cleanup and compositing, Cuts 01-12"
            rows={2}
          />
        </div>

        <div style={styles.fieldRow}>
          <div style={styles.field}>
            <label style={styles.label}>Amount</label>
            <input
              style={styles.input}
              value={form.amount}
              onChange={set("amount")}
              placeholder="e.g. 500"
            />
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

        <p style={styles.fieldHint}>Balance due: {cur}{formatMoney(balance)}</p>

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
              Unpaid
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
                  amountPaid: form.amount,
                  paidDate: form.paidDate || new Date().toISOString().slice(0, 10),
                })
              }
            >
              Paid
            </button>
          </div>
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
          <button
            style={styles.saveButton}
            onClick={() => onSave({ ...form, invoiceNumber: form.invoiceNumber || "INV-0001" })}
          >
            Save invoice
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
`;

const ink = "#14191c";
const inkSoft = "#1c2327";
const inkElevated = "#232b30";
const paper = "#EDEAE3";
const teal = "#2FBFA6";
const tealLight = "#7FE0D0";
const border = "#2a3338";
const textMuted = "#8b9a98";
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
  dashboardChartsRow: {
    display: "flex",
    gap: 24,
    flexWrap: "wrap",
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
  invoiceAmountsRow: {
    display: "flex",
    gap: 16,
  },
  invoiceActionsRow: {
    display: "flex",
    gap: 8,
    marginTop: 4,
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
    gap: 16,
    padding: "0 28px 32px",
    overflowX: "auto",
    flex: 1,
    userSelect: "none",
    WebkitUserSelect: "none",
  },
  column: {
    background: inkSoft,
    borderRadius: 16,
    minWidth: 250,
    maxWidth: 250,
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
    padding: "14px 16px",
    borderBottom: `1px solid ${border}`,
  },
  columnLabel: {
    fontSize: 12.5,
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
    padding: 10,
    display: "flex",
    flexDirection: "column",
    gap: 8,
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
    padding: "12px 14px",
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
