// Emma (the Agent Chat): pure rules for what runs by itself, what waits for a tap, and how an action is carried out.
// No React and no network here except through the injected `api` and `mail` objects, so every rule is unit tested.
// The database is the authority: it enforces which categories may auto-run and re-validates every action when it runs.
import { accountCanSend, composeProblem, textToHtml } from "../email/lib/logic.js";

/** What the administrator can let Emma do without asking. Everything not listed here (see PROTECTED) always waits for Confirm. */
export const EMMA_CATEGORIES = Object.freeze([
  { key: "knowledge", label: "Knowledge base", detail: "Add, replace or retire entries (saved entries are approved at once and shape later outreach, so check them)." },
  { key: "messages", label: "Drafted messages", detail: "Rewrite, approve or discard drafts. Approved drafts are sent by the worker within the usual limits." },
  { key: "prospects", label: "Prospects and campaigns", detail: "Approve or reject discovered prospects, start a paused campaign." },
  { key: "email", label: "Send an email", detail: "Send an email you asked for to the address you gave, from your studio mailbox." },
]);
export const PROTECTED = Object.freeze(["Turning sending on", "Changing autonomy", "Do-not-contact entries", "Sender name, email, address and legal footer", "Send window, time zone, warm-up and every daily limit"]);
/** A fresh install runs nothing by itself: the administrator opts in per category. */
export const DEFAULT_AUTHORITY = Object.freeze({ knowledge: "ask", messages: "ask", prospects: "ask", email: "ask" });
/** Settings that decide who may be emailed, when and how much, or who the sender is. Mirrors the database: always "protected". */
export const PROTECTED_SETTINGS = Object.freeze(["sender_name", "sender_email", "physical_address", "opt_out_text", "timezone", "send_start_hour", "send_end_hour",
  "send_weekdays_only", "warmup_enabled", "allow_cap_shift", "daily_followup_cap", "max_auto_replies_per_thread"]);

/** Stored permissions merged over the defaults; anything but "auto" means "ask". */
export function authorityOf(settings) {
  const stored = settings && typeof settings.emma_authority === "object" && settings.emma_authority ? settings.emma_authority : DEFAULT_AUTHORITY;
  return Object.fromEntries(EMMA_CATEGORIES.map((c) => [c.key, stored[c.key] === "auto" ? "auto" : "ask"]));
}

/** Mirrors public._intel_chat_category in the database (a test keeps them identical). */
export function categoryOf(tool, args) {
  if (tool === "save_knowledge" || tool === "retire_knowledge") return "knowledge";
  if (tool === "change_setting") return PROTECTED_SETTINGS.includes(args?.setting) ? "protected" : "settings";
  if (tool === "update_limits" || tool === "set_campaign_cap") return "protected";
  if (tool === "approve_messages" || tool === "discard_messages" || tool === "edit_message") return "messages";
  if (tool === "review_prospect" || tool === "resume_campaign") return "prospects";
  if (tool === "send_email") return "email";
  return "protected";
}
// Always derived from the tool and its arguments, never from the stored column: a wrong stored value cannot unlock anything.
export const actionCategory = (a) => categoryOf(a?.tool, a?.args);
/** Email is sent from the browser (through the same sender as the Inbox); every other action runs in the database. */
export const executorOf = (tool) => (tool === "send_email" ? "browser" : "database");

const live = (a, now) => !!a && a.status === "pending" && new Date(a.expires_at).getTime() > now;
export const isRunning = (a) => !!a && a.status === "running";
/** An email that was claimed but never reported back (tab closed, network lost) is resolved by the database after this long. */
export const STUCK_MS = 5 * 60 * 1000;
export const isStuck = (a, now = Date.now()) => isRunning(a) && Number.isFinite(Date.parse(a.decided_at)) && now - Date.parse(a.decided_at) > STUCK_MS;
export const stuckRunning = (actions, now = Date.now()) => (actions || []).filter((a) => isStuck(a, now));
/** Polling stays quick while something is pending or being carried out (a stuck card no longer counts: it is being recovered). */
export const hasInFlight = (actions, now = Date.now()) => (actions || []).some((a) => live(a, now) || (isRunning(a) && !isStuck(a, now)));

/** May the open window run this card by itself? Only a live pending card of a category the administrator set to "auto". Never a protected one. */
export function canAutoRun(action, authority, now = Date.now()) {
  if (!live(action, now)) return false;
  const cat = actionCategory(action);
  return cat !== "protected" && authority?.[cat] === "auto";
}

/** Cards to run by themselves right now: new since this thread was opened (baseline), not tried before. Old pending cards always wait for a tap. */
export function autoRunQueue(actions, authority, baseline, tried, now = Date.now()) {
  return (actions || []).filter((a) => !baseline.has(a.id) && !tried.has(a.id) && canAutoRun(a, authority, now));
}

/** "Confirm all" covers live cards that are not protected and are not outgoing email; those always need their own tap, so one click can never send mail unreviewed. */
export const confirmAllCandidates = (actions, now = Date.now()) => (actions || []).filter((a) => {
  const cat = actionCategory(a);
  return live(a, now) && cat !== "protected" && cat !== "email";
});

/** Prefer the studio's manual-correspondence mailbox (Zoho), then the default account, among accounts that can send right now. */
export function pickSendAccount(accounts, providers) {
  const ok = (Array.isArray(accounts) ? accounts : []).filter((a) => accountCanSend(a, providers));
  return ok.find((a) => a.provider === "zoho") || ok.find((a) => a.is_default) || ok[0] || null;
}
export const sendableAccounts = (accounts, providers) => (Array.isArray(accounts) ? accounts : []).filter((a) => accountCanSend(a, providers));

export const emailFields = (action) => ({ to: String(action?.args?.to || ""), subject: String(action?.args?.subject || ""), body: String(action?.args?.body || "") });

/** Database reasons (snake_case codes) in words the administrator can act on. */
const REASON_TEXT = Object.freeze({
  sending_is_stopped: "Sending is stopped (the emergency stop is on). Turn sending back on in Overview, then press Send again.",
  sending_is_stopped_emergency_stop_is_on: "Sending is stopped (the emergency stop is on). Turn sending back on, then ask Emma again.",
  recipient_is_on_the_do_not_contact_list: "That address is on the do-not-contact list, so nothing was sent.",
});
export function friendlyError(text) {
  const raw = String(text || "").replace(/^no longer valid:\s*/i, "").trim();
  return REASON_TEXT[raw] || (/^[a-z0-9_]+$/.test(raw) && raw.includes("_") ? raw.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) + "." : String(text || ""));
}

/** One line for a finished card. */
export function resultLine(action) {
  const r = action?.result || {};
  if (action?.status === "failed") return r.error ? friendlyError(r.error) : "It could not be completed.";
  if (action?.status !== "confirmed") return "";
  const how = action.auto ? "Done automatically" : "Done";
  if (action.tool === "send_email") return `${how}: email sent.${r.note ? ` ${r.note}` : ""}${r.edited ? " (you edited it first)" : ""}`;
  if (action.tool === "save_knowledge") return `${how}: saved and approved.`;
  if (action.tool === "retire_knowledge") return `${how}: retired.`;
  return `${how}.`;
}

const CLAIM_TEXT = { expired: "That request expired. Ask Emma again.", running: "It is already being sent.", confirmed: "It was already done.", cancelled: "It was cancelled.", failed: "It could not be completed." };

/**
 * Carries out one card. Database actions run through chat_confirm. Email is claimed once in the database (so it can never send twice), sent through
 * the existing email-send function with a key derived from the card, then reported back. Returns { skipped: true } when the database says an
 * automatic run is not allowed (the card stays for a manual tap).
 */
export async function runEmmaAction({ supabase, action, auto = false, edits = null, sender, api, mail, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (executorOf(action.tool) === "database") {
    const r = await api.chatConfirm(supabase, action.id, auto);
    if (r && r.error === "auto_not_allowed") return { skipped: true };
    if (r && r.ok === false) throw new Error(r.status === "expired" ? CLAIM_TEXT.expired : (r.error ? friendlyError(r.error) : "") || CLAIM_TEXT[r.status] || CLAIM_TEXT.failed);
    return r;
  }
  if (!sender) throw new Error("No connected sending account. Connect one in the Email settings, then try again.");
  const claim = await api.chatClaim(supabase, action.id, auto);
  if (claim && claim.error === "auto_not_allowed") return { skipped: true };
  // Another open window already took this card: nothing to report, and no error to show for an automatic run.
  if (auto && claim && claim.ok === false && (claim.status === "running" || claim.status === "confirmed")) return { skipped: true };
  if (!claim || claim.ok !== true) throw new Error(friendlyError(claim?.error) || CLAIM_TEXT[claim?.status] || CLAIM_TEXT.failed);
  const a = claim.args || {};
  const subject = String(edits?.subject ?? a.subject ?? "").trim();
  const body = String(edits?.body ?? a.body ?? "");
  const edited = subject !== String(a.subject || "").trim() || body !== String(a.body || "");
  const problem = composeProblem({ accountId: sender.id, to: a.to, cc: "", bcc: "", subject, body });
  // The email outcome matters more than the bookkeeping, but a lost report leaves the card "running", so retry a few times.
  const finish = async (ok, result) => {
    for (let i = 0; i < 3; i++) {
      try { await api.chatFinish(supabase, action.id, ok, result); return true; } catch { if (i < 2) await sleep(400 * (i + 1)); }
    }
    return false;
  };
  if (problem) { await finish(false, { error: problem }); throw new Error(problem); }
  let sent;
  try {
    sent = await mail.send(supabase, { accountId: sender.id, to: [a.to], cc: [], bcc: [], subject, text: body, html: textToHtml(body), conversationId: null, draftId: null, key: `emma-${action.id}`, files: [], crmLeadId: null });
  } catch (e) {
    await finish(false, { error: String(e?.message || "Could not send").slice(0, 280), outcome: e?.outcome });
    throw e;
  }
  const warning = sent?.warning === "crm_activity_pending" || sent?.warning === "sent_status_not_saved";
  const recorded = await finish(true, { message_id: sent?.message_id, edited, note: warning ? "Sent, but a follow-up record is still pending; check the Sent folder." : undefined });
  return recorded ? { ok: true, sent: true } : { ok: true, sent: true, unrecorded: true };
}

/** Starters: `send` ones go straight to Emma, the others fill the box so the person can finish the sentence. */
export const EMMA_STARTERS = Object.freeze([
  { label: "Who needs a follow-up?", text: "Show me prospects who need follow-ups", send: true },
  { label: "Drafts waiting for me", text: "What drafts are waiting for my approval?", send: true },
  { label: "My sending settings", text: "Show me my current sending settings", send: true },
  { label: "Email someone…", text: "Email name@example.com and tell them ", send: false },
  { label: "Add to knowledge base…", text: "Add to the knowledge base: ", send: false },
  { label: "Change a setting…", text: "Change the send window to ", send: false },
]);
