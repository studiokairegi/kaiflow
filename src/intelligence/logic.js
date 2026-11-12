// Pure helpers for the Intelligence screens (no React, no network) so they can be unit tested.

export const PROSPECT_TYPES = Object.freeze({
  indie_game_developer: "Indie Game Developers",
  animation_studio_support: "Animation Studio Support",
});

export const PROSPECT_STATUS = Object.freeze({
  discovered: { label: "Discovered", tone: "muted" },
  researched: { label: "Researched", tone: "info" },
  qualified: { label: "Qualified", tone: "ok" },
  needs_review: { label: "Needs review", tone: "warn" },
  rejected: { label: "Rejected", tone: "muted" },
  lead_linked: { label: "Lead created", tone: "ok" },
  contacted: { label: "Contacted", tone: "info" },
  replied: { label: "Replied", tone: "ok" },
  closed: { label: "Closed", tone: "muted" },
  suppressed: { label: "Suppressed", tone: "bad" },
});

export const MESSAGE_STATE = Object.freeze({
  draft: { label: "Draft", tone: "muted" },
  pending_approval: { label: "Needs your approval", tone: "warn" },
  approved: { label: "Approved, queued", tone: "info" },
  reserved: { label: "Sending soon", tone: "info" },
  sending: { label: "Sending", tone: "info" },
  sent: { label: "Sent", tone: "ok" },
  failed: { label: "Failed", tone: "bad" },
  unknown: { label: "Delivery unverified", tone: "bad" },
  received: { label: "Received", tone: "ok" },
  discarded: { label: "Discarded", tone: "muted" },
});

export const CLASS_LABEL = Object.freeze({
  positive: "Positive", meeting_request: "Meeting request", pricing: "Pricing", negotiation: "Negotiation",
  portfolio_request: "Portfolio request", project_opportunity: "Project opportunity", rejection: "Declined",
  unsubscribe: "Unsubscribe", ambiguous: "Needs review", complaint: "Complaint", bounce: "Bounce",
  out_of_office: "Out of office", auto_reply: "Auto-reply", other: "Other",
});

export const AUTONOMY = Object.freeze({
  shadow: "Shadow: every email waits for your approval",
  assisted: "Assisted: follow-ups and simple replies send themselves; introductions need approval",
  autonomous: "Autonomous: approved-policy emails send themselves",
});

export const statusInfo = (s) => PROSPECT_STATUS[s] || { label: s || "-", tone: "muted" };
export const stateInfo = (s) => MESSAGE_STATE[s] || { label: s || "-", tone: "muted" };

/** Worker health from the last heartbeat age in seconds (null = never seen). */
export function workerState(seconds) {
  if (seconds === null || seconds === undefined) return { tone: "warn", label: "Emma has never connected" };
  if (seconds <= 120) return { tone: "ok", label: "Emma is online" };
  if (seconds <= 900) return { tone: "warn", label: `Emma is quiet for ${Math.round(seconds / 60)} min` };
  return { tone: "bad", label: "Emma is offline" };
}

/** Everything that needs the administrator's attention, in order of urgency. */
export function attentionItems(o) {
  if (!o || !o.configured) return [];
  const out = [];
  if (o.unknown_sends > 0) out.push({ tone: "bad", text: `${o.unknown_sends} email(s) have unverified delivery. Nothing will be resent until you resolve them (Outreach).` });
  if (o.dead_jobs > 0) out.push({ tone: "bad", text: `${o.dead_jobs} job(s) failed permanently (Agent Activity Logs).` });
  if (o.expired_leases > 0) out.push({ tone: "warn", text: `${o.expired_leases} worker job lease(s) expired. A job may have stalled; the worker should recover it (Agent Activity Logs).` });
  if (o.failed_jobs > 0) out.push({ tone: "warn", text: `${o.failed_jobs} job(s) failed and are waiting to be retried (Agent Activity Logs).` });
  if (o.pending_approval > 0) out.push({ tone: "warn", text: `${o.pending_approval} message(s) are waiting for your approval.` });
  const needs = o.prospects_by_status?.needs_review || 0;
  if (needs > 0) out.push({ tone: "warn", text: `${needs} prospect(s) need a decision (possible duplicate or no verified email).` });
  return out;
}

/**
 * Sending status for the Overview banner. The kill switch is only ONE gate: when it is off, sending can still be
 * blocked by mail connectivity, the worker, or the daily limits. `ready` is true only when the dashboard can see
 * no blocker; it never claims a delivery guarantee.
 */
export function sendingReadiness(o, mail) {
  if (!o || !o.configured) return { state: "unknown", tone: "muted", text: "", reasons: [] };
  if (o.kill_switch) return { state: "stopped", tone: "warn", text: "Outgoing email is OFF. The agent can research and draft, but nothing is sent.", reasons: [] };
  const reasons = [];
  if (!mail) reasons.push("mail status is still loading");
  else if (mail.status === "check_failed" || mail.status === "error") reasons.push("the mail status check failed");
  else if (mail.status !== "connected") reasons.push("no mail account is connected");
  else if (Array.isArray(mail.accounts) && mail.accounts.length > 0 && !mail.accounts.some((a) => a.status === "connected")) reasons.push("no provider account is connected");
  const seen = o.worker_last_seen_seconds;
  if (seen === null || seen === undefined) reasons.push("the worker has never connected");
  else if (seen > 900) reasons.push("the worker is offline");
  const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== undefined && v !== "" ? Number(v) : null);
  const [is, ic, fs, fc] = [num(o.initial_sent_today), num(o.initial_cap), num(o.followup_sent_today), num(o.followup_cap)];
  if (is !== null && ic !== null && fs !== null && fc !== null && is >= ic && fs >= fc) reasons.push("today's introduction and follow-up limits are both reached");
  if (reasons.length) return { state: "blocked", tone: "warn", text: `Outgoing email is switched ON, but sending is not ready: ${reasons.join("; ")}.`, reasons };
  const approval = o.autonomy === "shadow" ? " Every email still waits for your approval." : "";
  return { state: "ready", tone: "ok", text: `Outgoing email is ON and no sending blockers are showing.${approval}`, reasons };
}

export const DISCOVERY_TYPES = Object.freeze(["indie_game_developer", "animation_studio_support"]);

/**
 * Queue discovery for each campaign type independently so one failure cannot hide the other's result, and report
 * exactly what happened. Callers retry only `failed` types, so a retry never re-queues one that already queued.
 */
export async function queueDiscovery(enqueue, types = DISCOVERY_TYPES) {
  const queued = [];
  const failed = [];
  for (const type of types) {
    try { await enqueue("discover", { type }); queued.push(type); }
    catch (e) { failed.push({ type, error: e?.message || "request failed" }); }
  }
  return { queued, failed };
}

/** Group messages into conversations keyed by prospect, newest activity first. */
export function conversations(messages, prospects) {
  const byId = new Map((prospects || []).map((p) => [p.id, p]));
  const groups = new Map();
  for (const m of messages || []) {
    if (!m.prospect_id) continue;
    if (!groups.has(m.prospect_id)) groups.set(m.prospect_id, []);
    groups.get(m.prospect_id).push(m);
  }
  const t = (m) => Date.parse(m.sent_at || m.received_at || m.created_at) || 0;
  return [...groups.entries()]
    .map(([id, msgs]) => {
      const sorted = [...msgs].sort((a, b) => t(a) - t(b));
      const last = sorted[sorted.length - 1];
      return {
        prospectId: id, prospect: byId.get(id) || null, messages: sorted, lastAt: t(last),
        inbound: sorted.some((m) => m.direction === "inbound"),
        needsAttention: sorted.some((m) => m.state === "pending_approval" || m.state === "unknown" || (m.direction === "inbound" && m.escalated)),
      };
    })
    .sort((a, b) => b.lastAt - a.lastAt);
}

/** Resolve a notification target ({prospectId, leadId, messageId}) to a prospect id. */
export function findTargetProspect(target, prospects, messages) {
  if (!target) return null;
  if (target.prospectId && (prospects || []).some((p) => p.id === target.prospectId)) return target.prospectId;
  if (target.messageId) {
    const m = (messages || []).find((x) => x.id === target.messageId);
    if (m?.prospect_id) return m.prospect_id;
  }
  if (target.leadId) return (prospects || []).find((p) => p.lead_id === target.leadId)?.id || null;
  return null;
}

export const splitLines = (text) => String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
export const joinLines = (arr) => (Array.isArray(arr) ? arr.join("\n") : "");

/** Campaign form -> criteria patch (the database merges it into the stored criteria). */
export function criteriaPatch({ keywords, seedUrls, qualifyMin, reviewMin, prospectType }) {
  // Both V2 scoring models have server-enforced bands; campaign settings cannot
  // weaken the qualification floor for either campaign.
  const isStudio = prospectType === "animation_studio_support";
  const isIndie = prospectType === "indie_game_developer";
  const q = isStudio ? 70 : isIndie ? 75 : Math.max(0, Math.min(100, Math.round(Number(qualifyMin))));
  const r = isStudio ? 50 : isIndie ? 55 : Math.max(0, Math.min(q, Math.round(Number(reviewMin))));
  if (!Number.isFinite(q) || !Number.isFinite(r)) throw new Error("Scores must be numbers between 0 and 100.");
  return { keywords: splitLines(keywords).map((k) => k.toLowerCase()), seed_urls: splitLines(seedUrls), qualify_min: q, review_min: r };
}

export function isHttpUrl(s) {
  try { const u = new URL(s); return u.protocol === "http:" || u.protocol === "https:"; } catch { return false; }
}

export const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString() : "-");

/** Knowledge-base entries the agent needs before it may draft anything. It never invents studio facts. */
export const REQUIRED_KB = Object.freeze([
  { key: "studio.about", kind: "studio", label: "Short studio description" },
  { key: "services.indie_game_developer", kind: "service", label: "Services for indie game developers" },
  { key: "services.animation_studio_support", kind: "service", label: "Services for animation studios" },
  { key: "portfolio.main", kind: "portfolio", label: "Approved portfolio link(s)" },
]);
export const KB_KINDS = Object.freeze(["studio", "service", "portfolio", "faq", "policy", "template", "pricing_guidance", "availability"]);

export function missingKb(entries) {
  const ok = new Set((entries || []).filter((e) => e.approved && String(e.body || "").trim()).map((e) => e.key));
  return REQUIRED_KB.filter((r) => !ok.has(r.key));
}

export const REQUIRED_JAPANESE_KB = Object.freeze([
  { key: "studio.about.ja", kind: "studio", label: "Japanese studio description" },
  { key: "services.animation_studio_support.ja", kind: "service", label: "Japanese animation-studio services" },
  { key: "services.indie_game_developer.ja", kind: "service", label: "Japanese indie-game developer services" },
  { key: "portfolio.main.ja", kind: "portfolio", label: "Japanese portfolio link(s)" },
  { key: "policy.opt_out.ja", kind: "policy", label: "Japanese opt-out sentence" },
]);
export function missingJapaneseKb(entries) {
 const ok = new Set((entries || []).filter(e => e.approved && String(e.body || "").trim()).map(e => e.key));
 return REQUIRED_JAPANESE_KB.filter(r => !ok.has(r.key));
}
export const AI_SOURCE_KIND = "ai_intelligence";
/** True only for leads KairFlow Intelligence created: driven by the immutable leads.source_kind, nothing else. */
export const isAiGeneratedLead = (lead) => lead?.sourceKind === AI_SOURCE_KIND;

// ---- Existing CRM leads (follow-up review) --------------------------------------------------------------------------------
export const CRM_BUCKETS = Object.freeze({
  follow_up_due: { label: "Follow-up due", tone: "warn", help: "Contacted, no reply, and enough business days have passed." },
  replied: { label: "Already replied", tone: "ok", help: "In conversation: handle personally. Intelligence will not email these." },
  waiting: { label: "Not due yet", tone: "info", help: "Contacted recently." },
  needs_review: { label: "Needs a look", tone: "warn", help: "No contact date recorded." },
  not_contacted: { label: "Never contacted", tone: "muted", help: "Not a follow-up. Use the Qualified Leads flow for introductions." },
  no_email: { label: "No email", tone: "muted", help: "Nothing can be sent without an address." },
  do_not_contact: { label: "Do not contact", tone: "bad", help: "Lost, closed, client, opted out, or sequence finished." },
});
export const CRM_ORDER = Object.freeze(["follow_up_due", "replied", "waiting", "needs_review", "not_contacted", "no_email", "do_not_contact"]);
export const MAX_ADOPT = 25;
export const bucketInfo = (b) => CRM_BUCKETS[b] || { label: b || "-", tone: "muted", help: "" };

/** Only leads that were contacted, have not replied, and are not already tracked may be brought into Intelligence. */
export const canAdopt = (row) => !!row && !row.tracked && (row.bucket === "follow_up_due" || row.bucket === "waiting");

/** Add or remove an id from the selection, never exceeding MAX_ADOPT and never selecting a row that cannot be adopted. */
export function toggleSelection(selected, row) {
  const next = new Set(selected || []);
  if (next.has(row.lead_id)) { next.delete(row.lead_id); return next; }
  if (!canAdopt(row) || next.size >= MAX_ADOPT) return next;
  next.add(row.lead_id);
  return next;
}

// ---- Agent Chat ---------------------------------------------------------------------------------------------------------------
export const CHAT_SUGGESTIONS = Object.freeze([
  "Show me prospects who need follow-ups",
  "How many positive responses did we receive this week?",
  "Show me all active opportunities",
  "Find 10 indie game developers",
  "Pause the current campaign",
]);
export const TOOL_LABEL = Object.freeze({
  campaign_status: "Checked campaigns", list_prospects: "Listed prospects", prospect_detail: "Looked up a prospect", opportunities: "Checked opportunities",
  stats: "Pulled statistics", crm_followup_review: "Reviewed existing leads", start_discovery: "Queued discovery", research_prospect: "Queued research",
  set_campaign_status: "Paused campaign(s)", emergency_stop: "Stopped all sending", adopt_crm_leads: "Brought leads into Intelligence",
  prepare_followups: "Queued follow-up drafts", prepare_introductions: "Queued introduction drafts",
  approve_messages: "Prepared an approval", discard_messages: "Prepared a discard", resume_campaign: "Prepared starting a campaign", set_campaign_cap: "Prepared a campaign limit",
  enable_sending: "Prepared turning sending on", set_autonomy: "Prepared an autonomy change", update_limits: "Prepared new limits", add_suppression: "Prepared a suppression",
  review_prospect: "Prepared a prospect decision",
});

/** The conversation as the person sees it: user and assistant turns, with the tools used shown under the answer. */
export function chatTurns(messages) {
  const turns = [];
  const tools = new Map();
  for (const m of messages || []) if (m.role === "tool" && m.reply_to != null) tools.set(m.reply_to, [...(tools.get(m.reply_to) || []), m.tool_name]);
  for (const m of messages || []) {
    if (m.role === "user") turns.push({ id: m.id, role: "user", text: m.content });
    else if (m.role === "assistant") turns.push({ id: m.id, role: "assistant", replyTo: m.reply_to, text: m.content, error: m.status === "error", tools: (tools.get(m.reply_to) || []).map((t) => TOOL_LABEL[t] || t) });
  }
  return turns;
}
/** True while the newest user message has no assistant answer yet. */
export function awaitingAnswer(messages) {
  const users = (messages || []).filter((m) => m.role === "user");
  if (!users.length) return false;
  const last = users[users.length - 1];
  return !(messages || []).some((m) => m.role === "assistant" && m.reply_to === last.id);
}
/** How long the chat keeps showing "Working on it…" (and polling) before it tells the person the assistant has not answered. */
export const ANSWER_TIMEOUT_MS = 5 * 60 * 1000;
/** True when the newest user message is still unanswered AND is older than the timeout. */
export function answerOverdue(messages, now = Date.now()) {
  if (!awaitingAnswer(messages)) return false;
  const users = (messages || []).filter((m) => m.role === "user");
  const at = Date.parse(users[users.length - 1].created_at);
  return Number.isFinite(at) && now - at > ANSWER_TIMEOUT_MS;
}
export const newClientKey = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
export const countAiGeneratedLeads = (leads) => (leads || []).filter(isAiGeneratedLead).length;

// ---- Mail provider labels (Gmail, Zoho Mail, SMTP) ---------------------------------------------------------------------------------------
export const MAIL_PROVIDERS = Object.freeze({ gmail: "Gmail", zoho: "Zoho Mail" });
export const mailProviderName = (mail) => MAIL_PROVIDERS[mail?.provider] || MAIL_PROVIDERS.zoho;
/** "Gmail connected (studio@gmail.com)" / "Mail not connected". */
export const mailStatusLabel = (mail) => {
  if (!mail || mail.status === "disconnected" || !mail.status) return "Mail not connected";
  if (mail.status === "connected") {
    const accounts = Array.isArray(mail.accounts) ? mail.accounts : [];
    if (mail.provider === "multiple" || accounts.length > 1) {
      const connected = accounts.filter((a) => a.status === "connected").length;
      return `${connected} of ${accounts.length} provider accounts connected`;
    }
    return `${mailProviderName(mail)} connected (${mail.mailbox || "mailbox"})`;
  }
  if (mail.status === "error" || mail.status === "check_failed") return `${mailProviderName(mail)} status check failed`;
  return `${mailProviderName(mail)}: ${String(mail.status).replace(/[_-]+/g, " ")}`;
};
/** What the person sees after a provider sends them back to KairFlow (?intelligence=<flag>). Unknown flags show nothing. */
export const OAUTH_RESULTS = Object.freeze({
  provider_connected: { tone: "ok", text: "Mail account connected. Refresh provider accounts in Settings; outbound messages use their durable account assignment." },
  provider_cancelled: { tone: "warn", text: "Connection cancelled. Nothing was saved." },
  provider_denied: { tone: "bad", text: "Only an administrator who is also an active Master User can connect a mail account. Nothing was saved." },
  provider_disabled: { tone: "bad", text: "That provider is not enabled. Nothing was saved." },
  provider_adapter_missing: { tone: "bad", text: "That provider is not installed on the worker. Nothing was saved." },
  provider_save_error: { tone: "bad", text: "The account could not be saved. Nothing was saved. Try again." },
  provider_error: { tone: "bad", text: "The account could not be connected. Nothing was saved. Check the provider app settings and try again." },
});
export const oauthResult = (flag) => OAUTH_RESULTS[flag] || null;

// ---- Chat actions: the assistant PREPARES, the administrator CONFIRMS ----------------------------------------------------------
export const ACTION_STATUS = Object.freeze({
  pending: { label: "Waiting for you", tone: "warn" }, confirmed: { label: "Done", tone: "ok" }, cancelled: { label: "Cancelled", tone: "muted" },
  failed: { label: "Failed", tone: "bad" }, expired: { label: "Expired", tone: "muted" },
});
/** Cards are grouped under the request they answer. */
export function groupActions(actions) {
  const by = new Map();
  for (const a of actions || []) by.set(a.message_id, [...(by.get(a.message_id) || []), a]);
  return by;
}
/** A card can only be confirmed while it is pending and not past its expiry (the database enforces this too). */
export const isActionLive = (a, now = Date.now()) => !!a && a.status === "pending" && new Date(a.expires_at).getTime() > now;
/** What to show for a card right now: a pending card past its expiry reads as expired. */
export const actionStatus = (a, now = Date.now()) => ACTION_STATUS[a?.status === "pending" && !isActionLive(a, now) ? "expired" : a?.status] || ACTION_STATUS.failed;
export const hasPendingActions = (actions, now = Date.now()) => (actions || []).some((a) => isActionLive(a, now));

// ---- Discovery: sources and the customer profile -------------------------------------------------
export const SOURCE_STATE = Object.freeze({
  running: { label: "Running", tone: "ok" },
  off: { label: "Off", tone: "muted" },
  unverified: { label: "Terms not confirmed", tone: "warn" },
  excluded: { label: "Excluded", tone: "bad" },
  paused: { label: "Paused after errors", tone: "bad" },
  budget: { label: "Daily budget used", tone: "warn" },
});

/** One word for what a source is doing right now. A source with unconfirmed terms can never run. */
export function sourceState(src, now = Date.now()) {
  if (!src) return SOURCE_STATE.off;
  if (src.tos_status === "excluded") return SOURCE_STATE.excluded;
  if (src.tos_status !== "confirmed") return SOURCE_STATE.unverified;
  if (!src.enabled) return SOURCE_STATE.off;
  if (src.circuit_open_until && Date.parse(src.circuit_open_until) > now) return SOURCE_STATE.paused;
  if (src.used_today >= src.daily_budget && src.daily_budget > 0) return SOURCE_STATE.budget;
  return SOURCE_STATE.running;
}

/** profile jsonb -> editable form (text areas hold one term per line). */
export function profileToForm(profile) {
  const p = profile || {};
  return { description: p.description || "", termsEn: joinLines(p.terms_en), termsJa: joinLines(p.terms_ja), exclude: joinLines(p.exclude), approved: !!p.approved };
}

export function profileFromForm(f) {
  const clean = (t) => [...new Set(splitLines(t).map((x) => x.replace(/\s+/g, " ").slice(0, 60)))].slice(0, 12);
  const termsEn = clean(f.termsEn), termsJa = clean(f.termsJa);
  if (!termsEn.length && !termsJa.length) throw new Error("Add at least one search phrase, in English or Japanese.");
  return { description: String(f.description || "").slice(0, 2000), termsEn, termsJa, exclude: clean(f.exclude) };
}

export const proposedTerms = (profile) => {
  const p = profile || {};
  const any = (p.proposed_en || []).length || (p.proposed_ja || []).length;
  return any ? { termsEn: joinLines(p.proposed_en), termsJa: joinLines(p.proposed_ja), exclude: joinLines(p.proposed_exclude) } : null;
};
