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
  if (seconds === null || seconds === undefined) return { tone: "warn", label: "Worker has never connected" };
  if (seconds <= 120) return { tone: "ok", label: "Worker online" };
  if (seconds <= 900) return { tone: "warn", label: `Worker quiet for ${Math.round(seconds / 60)} min` };
  return { tone: "bad", label: "Worker offline" };
}

/** Everything that needs the administrator's attention, in order of urgency. */
export function attentionItems(o) {
  if (!o || !o.configured) return [];
  const out = [];
  if (o.unknown_sends > 0) out.push({ tone: "bad", text: `${o.unknown_sends} email(s) have unverified delivery. Nothing will be resent until you resolve them (Outreach).` });
  if (o.dead_jobs > 0) out.push({ tone: "bad", text: `${o.dead_jobs} job(s) failed permanently (Agent Activity Logs).` });
  if (o.pending_approval > 0) out.push({ tone: "warn", text: `${o.pending_approval} message(s) are waiting for your approval.` });
  const needs = o.prospects_by_status?.needs_review || 0;
  if (needs > 0) out.push({ tone: "warn", text: `${needs} prospect(s) need a decision (possible duplicate or no verified email).` });
  return out;
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
export function criteriaPatch({ keywords, seedUrls, qualifyMin, reviewMin }) {
  const q = Math.max(0, Math.min(100, Math.round(Number(qualifyMin))));
  const r = Math.max(0, Math.min(q, Math.round(Number(reviewMin))));
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

export const AI_SOURCE_KIND = "ai_intelligence";
/** True only for leads KairFlow Intelligence created: driven by the immutable leads.source_kind, nothing else. */
export const isAiGeneratedLead = (lead) => lead?.sourceKind === AI_SOURCE_KIND;
