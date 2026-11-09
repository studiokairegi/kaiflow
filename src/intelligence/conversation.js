// Pasted conversations for CRM take-over. Everything here is pure (no React, no network) so it is unit-tested.
//
// An administrator pastes an earlier email thread (sent by hand or from another mailbox). parseConversation() makes a best
// guess at the individual messages, who wrote each one and when. The person ALWAYS reviews that guess before it is saved:
// the database refuses a message without a direction, and nothing is ever sent from here.

export const MAX_MESSAGES = 60;
export const MAX_BODY = 8000;
export const MAX_TOTAL = 100000;
export const MAX_PASTE = 120000;

export const normEmail = (v) => String(v || "").trim().toLowerCase();
export const isUsableEmail = (v) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(normEmail(v));
const domainOf = (e) => normEmail(e).split("@")[1] || "";

// ---- dates -----------------------------------------------------------------------------------------------------------------
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const monthNo = (w) => MONTHS[String(w || "").slice(0, 4).toLowerCase()] || MONTHS[String(w || "").slice(0, 3).toLowerCase()] || 0;

function iso(y, m, d) {
  y = Number(y); m = Number(m); d = Number(d);
  if (!(y >= 1990 && y <= 2100) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** First calendar date found in a piece of text as YYYY-MM-DD, or null. Ambiguous day/month numbers (04/05/2026) return null. */
export function toIsoDate(text) {
  const s = String(text || "");
  let m;
  if ((m = s.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/))) return iso(m[1], m[2], m[3]);
  if ((m = s.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/))) return iso(m[1], m[2], m[3]);
  if ((m = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})\b/i))) return iso(m[3], monthNo(m[2]), m[1]);
  if ((m = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i))) return iso(m[3], monthNo(m[1]), m[2]);
  if ((m = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/))) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a > 12 && b <= 12) return iso(m[3], b, a);
    if (b > 12 && a <= 12) return iso(m[3], a, b);
    return null;
  }
  return null;
}

// ---- who wrote it ----------------------------------------------------------------------------------------------------------
const EMAIL_IN = /([A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/;

/** 'inbound' (the lead's side), 'outbound' (our side) or 'unknown' (the person must decide). */
export function directionOf(person, lead = {}) {
  const email = normEmail((String(person || "").match(EMAIL_IN) || [])[1]);
  const leadEmail = normEmail(lead.email);
  if (email) {
    if (leadEmail && email === leadEmail) return "inbound";
    if (leadEmail && domainOf(email) && domainOf(email) === domainOf(leadEmail)) return "inbound";
    return "outbound";
  }
  const name = String(person || "").replace(/["<>]/g, " ").trim().toLowerCase();
  const first = String(lead.name || "").trim().split(/\s+/)[0]?.toLowerCase() || "";
  if (name && first.length >= 3 && name.includes(first)) return "inbound";
  return "unknown";
}
const opposite = (d) => (d === "inbound" ? "outbound" : d === "outbound" ? "inbound" : "unknown");

// ---- splitting a paste into messages ---------------------------------------------------------------------------------------
const FROM_RE = /^\s*\**\s*(from|差出人|送信者)\s*\**\s*[:：]\s*(.*)$/i;
const SENT_RE = /^\s*\**\s*(sent|date|送信日時|日付|日時)\s*\**\s*[:：]\s*(.*)$/i;
const SUBJECT_RE = /^\s*\**\s*(subject|re|件名)\s*\**\s*[:：]\s*(.*)$/i;
const OTHER_HDR_RE = /^\s*\**\s*(to|cc|bcc|reply-to|宛先|cc|bcc)\s*\**\s*[:：]/i;
const SEPARATOR_RE = /^\s*(-{2,}\s*(original message|forwarded message|元のメッセージ)\s*-{2,}|_{8,}|-{8,}|begin forwarded message:?)\s*$/i;
const WROTE_RE = /^\s*(?:>+\s*)*(on\s.{3,240}?\bwrote\s*:|.{3,240}?\bwrote\s*:|\d{4}年.{3,200}?[:：]|.{3,200}?(?:さんが書きました|が書きました)\s*[:：]?)\s*$/i;
const NAME_EMAIL_LINE = /^\s*\**\s*(.{1,80}?)\s*<\s*([^<>\s]+@[^<>\s]+)\s*>\s*\**\s*$/;

const stripQuote = (line) => line.replace(/^(?:\s*>)+\s?/, "");
const isBlank = (l) => !String(l).trim();

function cleanBody(lines) {
  const out = [];
  let blanks = 0;
  for (const raw of lines) {
    const l = raw.replace(/\s+$/g, "");
    if (!l.trim()) { blanks += 1; if (blanks <= 1 && out.length) out.push(""); continue; }
    blanks = 0;
    out.push(l);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join("\n").trim().slice(0, MAX_BODY);
}

const WROTE_END = /(wrote\s*:|書きました\s*[:：]?|[:：])\s*$/i;

/** Marker lines like "On Tue, Oct 6, 2026 at 3:14 PM Name <a@b.c> wrote:", also when the client wrapped it over two lines. */
function findWroteMarkers(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const one = stripQuote(lines[i]);
    if (WROTE_RE.test(lines[i]) && WROTE_END.test(one)) { out.push({ i, len: 1, text: one.trim() }); continue; }
    const next = stripQuote(lines[i + 1] || "");
    if (/^\s*on\s.{3,240}$/i.test(one) && /^.{0,160}wrote\s*:\s*$/i.test(next)) { out.push({ i, len: 2, text: `${one} ${next}`.trim() }); i += 1; }
  }
  return out;
}
const wroteInfo = (m) => ({ person: m.text.replace(/^on\s.*?,\s*/i, ""), at: toIsoDate(m.text) });

/** Find message boundaries written as header blocks (From:/Sent:/Subject:) or as a "Name <email>" line followed by a date. */
function headerBoundaries(lines) {
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    let start = i, person = null, at = null, subject = "", end = i;
    const fm = lines[i].match(FROM_RE);
    if (fm) {
      let j = i + 1, sawMeta = false;
      person = fm[2];
      for (; j < lines.length && j <= i + 9 && !isBlank(lines[j]); j++) {
        const sm = lines[j].match(SENT_RE), sub = lines[j].match(SUBJECT_RE);
        if (sm) { at = toIsoDate(sm[2]) || at; sawMeta = true; }
        else if (sub && /^(subject|件名)$/i.test(sub[1])) { subject = sub[2].trim(); sawMeta = true; }
        else if (!OTHER_HDR_RE.test(lines[j])) break;
      }
      if (!sawMeta) continue;
      end = j;
      if (start > 0 && SEPARATOR_RE.test(lines[start - 1])) start -= 1;
    } else {
      const ne = lines[i].match(NAME_EMAIL_LINE);
      if (!ne || FROM_RE.test(lines[i]) || /wrote\s*:/i.test(lines[i])) continue;
      const d = toIsoDate(lines.slice(i + 1, i + 3).join(" "));
      if (!d) continue;
      person = `${ne[1]} <${ne[2]}>`; at = d; end = i + 2;
      while (end < lines.length && /^\s*(to|cc)\b.*$/i.test(lines[end]) && end < i + 5) end += 1;
    }
    found.push({ start, end, person, at, subject, kind: fm ? "header" : "gmail" });
    i = Math.max(i, end - 1);
  }
  return found;
}

/**
 * Best-effort split of a pasted thread. lead = { email, name }. Returns { entries, orientation, subject, warnings } where entries
 * are oldest first: { direction: 'outbound'|'inbound'|'unknown', at: 'YYYY-MM-DD'|null, subject, body }.
 */
export function parseConversation(text, lead = {}) {
  const src = String(text || "").replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").slice(0, MAX_PASTE);
  const lines = src.split("\n");
  const warnings = [];
  if (!src.trim()) return { entries: [], orientation: "oldest_first", subject: "", warnings };

  let segs = [];
  let orientation = "newest_first";

  const heads = headerBoundaries(lines);
  const wrote = findWroteMarkers(lines);

  if (heads.length) {
    if (heads.every((h) => h.kind === "gmail")) orientation = "oldest_first";
    const first = heads[0];
    const topLines = lines.slice(0, first.start);
    if (!isBlank(topLines.join("")) && first.kind === "header") {
      segs.push({ direction: opposite(directionOf(first.person, lead)), at: null, subject: "", lines: topLines });
    } else if (!isBlank(topLines.join(""))) {
      segs.push({ direction: "unknown", at: null, subject: "", lines: topLines });
    }
    heads.forEach((h, k) => {
      const next = heads[k + 1];
      segs.push({ direction: directionOf(h.person, lead), at: h.at, subject: h.subject, lines: lines.slice(h.end, next ? next.start : lines.length) });
    });
  } else if (wrote.length) {
    const info0 = wroteInfo(wrote[0]);
    const top = lines.slice(0, wrote[0].i);
    if (!isBlank(top.join(""))) segs.push({ direction: opposite(directionOf(info0.person, lead)), at: null, subject: "", lines: top });
    wrote.forEach((w, k) => {
      const info = wroteInfo(w);
      const from = w.i + w.len;
      const stop = wrote[k + 1] ? wrote[k + 1].i : lines.length;
      segs.push({ direction: directionOf(info.person, lead), at: info.at, subject: "", lines: lines.slice(from, Math.max(stop, from)).map(stripQuote) });
    });
  } else {
    segs = [{ direction: "unknown", at: toIsoDate(src.slice(0, 300)), subject: "", lines }];
    warnings.push("Could not find where one message ends and the next begins. Check the single block below, or split it by hand.");
  }

  let entries = segs.map((s) => ({ direction: s.direction, at: s.at, subject: s.subject || "", body: cleanBody(s.lines) })).filter((e) => e.body);
  if (entries.length > MAX_MESSAGES) { warnings.push(`Only the newest ${MAX_MESSAGES} messages were kept.`); entries = orientation === "newest_first" ? entries.slice(0, MAX_MESSAGES) : entries.slice(-MAX_MESSAGES); }

  // chronological: by date when every message has one, otherwise by the layout we detected
  const dated = entries.length > 1 && entries.every((e) => e.at);
  if (dated) {
    const idx = entries.map((e, i) => ({ e, i }));
    const dir = orientation === "newest_first" ? -1 : 1;
    idx.sort((a, b) => (a.e.at < b.e.at ? -1 : a.e.at > b.e.at ? 1 : dir * (a.i - b.i)));
    entries = idx.map((x) => x.e);
  } else if (orientation === "newest_first") {
    entries = entries.slice().reverse();
  }
  const subject = (entries.slice().reverse().find((e) => e.subject) || {}).subject || "";
  if (entries.some((e) => e.direction === "unknown")) warnings.push("Some messages could not be matched to the lead or to you. Mark each one as \"We sent\" or \"They replied\".");
  return { entries, orientation: dated ? "by_date" : orientation, subject, warnings };
}

export const reverseEntries = (entries) => (entries || []).slice().reverse();

// ---- review before saving --------------------------------------------------------------------------------------------------
/** Problems that stop the save, in plain words. Empty list = ready. */
export function entryProblems(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const out = [];
  if (!list.length) return ["Paste a conversation first."];
  if (list.length > MAX_MESSAGES) out.push(`At most ${MAX_MESSAGES} messages can be saved at once.`);
  let total = 0;
  list.forEach((e, i) => {
    if (e.direction !== "outbound" && e.direction !== "inbound") out.push(`Message ${i + 1}: choose who wrote it.`);
    if (!String(e.body || "").trim()) out.push(`Message ${i + 1} is empty.`);
    if (e.at && !toIsoDate(e.at)) out.push(`Message ${i + 1}: the date is not valid (use YYYY-MM-DD).`);
    total += String(e.body || "").length;
  });
  if (total > MAX_TOTAL) out.push("The conversation is too long. Remove old messages.");
  return out;
}

/** The date of the newest message: the newest dated entry, else the fallback (the lead's last recorded contact), else "". */
export function suggestedLastContact(entries, fallback) {
  const dates = (entries || []).map((e) => toIsoDate(e.at)).filter(Boolean).sort();
  return dates.length ? dates[dates.length - 1] : toIsoDate(fallback) || "";
}

export const lastSpeaker = (entries) => (entries && entries.length ? entries[entries.length - 1].direction : null);

/** Payload for intel_admin_crm_import_history: only the fields the database accepts, trimmed. */
export function cleanEntries(entries) {
  return (entries || []).map((e) => ({
    direction: e.direction,
    at: toIsoDate(e.at),
    subject: String(e.subject || "").trim().slice(0, 300),
    body: String(e.body || "").trim().slice(0, MAX_BODY),
  }));
}

// ---- which rows may do what ------------------------------------------------------------------------------------------------
/** Pasting a conversation is possible for any lead that has an email and is not closed, lost, a client or opted out. */
export const canImport = (row) => !!row && isUsableEmail(row.email) && !["do_not_contact", "no_email"].includes(row.bucket);
/** A never-contacted lead with an email can get an introduction DRAFT (still needs approval). */
export const canIntroduce = (row) => !!row && !row.tracked && row.bucket === "not_contacted" && isUsableEmail(row.email);

// ---- take-over status shown in the table -----------------------------------------------------------------------------------
export const TAKEOVER_ACTIONS = Object.freeze({
  follow_up: { label: "Follow-up drafted", tone: "ok", help: "A follow-up that continues your conversation is waiting for your approval in Outreach." },
  reply: { label: "Reply drafted", tone: "ok", help: "They wrote last. A reply is waiting for your approval in Outreach." },
  wait: { label: "Waiting", tone: "info", help: "Not due yet. Intelligence will draft a follow-up when enough business days have passed." },
  needs_human: { label: "Needs you", tone: "warn", help: "The last message needs a person (price, contract, meeting, deadline or unclear). No draft was written." },
  stop: { label: "Do not email", tone: "bad", help: "The conversation says to stop (declined, opted out, or the sequence is finished)." },
  none: { label: "No action", tone: "muted", help: "Nothing to send right now." },
});

export function takeoverInfo(t) {
  if (!t || typeof t !== "object" || !t.state) return null;
  if (t.state === "pending") return { label: "Reading…", tone: "info", help: "The worker is reading the pasted conversation. Emma starts automatically with Windows when the local controller is installed; Ollama must also be running.", detail: "" };
  if (t.state === "failed") return { label: "Could not analyse", tone: "bad", help: t.error || "The analysis failed. Use Re-analyse to try again.", detail: t.error || "" };
  const a = TAKEOVER_ACTIONS[t.next_action] || TAKEOVER_ACTIONS.none;
  return { label: a.label, tone: a.tone, help: a.help, detail: t.reason || "" };
}
