// Provider-neutral pure helpers for the general Email module (moved verbatim from email_resend_logic.ts in multi-provider phase 3).
// No provider API, no database, no secrets. Erasable TypeScript only.
import { corsHeaders } from "./cors.ts";

export const safeMsg = (e: unknown): string => String((e as Error)?.message || "error").replace(/\s+/g, " ").slice(0, 200);   // never includes request bodies or keys
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

// ---------------------------------------------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
export const isValidEmail = (s: unknown): boolean => typeof s === "string" && s.length <= 254 && EMAIL_RE.test(s.trim());

/** "Ada <ada@x.com>" -> { name: "Ada", email: "ada@x.com" }. A bare address works too. */
export function parseAddress(input: unknown): { name: string; email: string } {
  const s = String(input ?? "").trim();
  const m = /^(.*?)<([^<>]+)>\s*$/.exec(s);
  if (m) return { name: m[1].trim().replace(/^"+|"+$/g, "").trim(), email: m[2].trim().toLowerCase() };
  return { name: "", email: s.toLowerCase() };
}

/** Lower-cased bare addresses from a list of strings or "Name <addr>" strings. */
export const addressList = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === "string" && v ? v.split(",") : []).map((x) => parseAddress(x).email).filter(Boolean);

/** "Re: Re: Fwd: Hello" -> "hello". Used to match a reply to its conversation when headers are missing. */
export function normalizeSubject(subject: unknown): string {
  let s = String(subject ?? "").trim();
  const re = /^\s*(re|fwd?|aw|sv|vs|rv|antw)(\[\d+\])?\s*:\s*/i;
  for (let i = 0; i < 10 && re.test(s); i++) s = s.replace(re, "");
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}
export const replySubject = (s: string): string => (/^\s*re\s*:/i.test(s) ? s : `Re: ${s}`.trim());
export const forwardSubject = (s: string): string => (/^\s*fwd?\s*:/i.test(s) ? s : `Fwd: ${s}`.trim());

/** Message-IDs in a header value, with their angle brackets, in order. */
export const parseMessageIds = (v: unknown): string[] => String(v ?? "").match(/<[^<>\s]+>/g) || [];

/** In-Reply-To / References for a reply to `parent`. Null when the parent has no Message-ID we know. */
export function buildThreadHeaders(parent: { rfc_message_id?: string | null; references_ids?: string | null } | null): { in_reply_to: string; references: string } | null {
  const id = parseMessageIds(parent?.rfc_message_id)[0];
  if (!id) return null;
  const chain = [...parseMessageIds(parent?.references_ids), id].filter((x, i, a) => a.indexOf(x) === i).slice(-20);
  return { in_reply_to: id, references: chain.join(" ") };
}

/** Plus-address token: replies to john+k1a2b3c4d5e6f@domain land in the right conversation even if a mail server rewrites Message-ID. */
export const threadToken = (conversationId: string): string => conversationId.replace(/-/g, "").slice(0, 12).toLowerCase();
/** `inboundDomain` lets replies land on a different domain than the one mail is sent from (for example when Zoho owns the root domain's MX). */
export function withThreadToken(address: string, conversationId: string, inboundDomain = ""): string {
  const [local, domain] = address.toLowerCase().split("@");
  return `${local.split("+")[0]}+k${threadToken(conversationId)}@${inboundDomain || domain}`;
}
export const cleanInboundDomain = (v: unknown): string => {
  const d = String(v ?? "").trim().toLowerCase();
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d) ? d : "";
};
export const baseAddress = (address: string): string => {
  const [local, domain] = String(address).toLowerCase().trim().split("@");
  return domain ? `${local.split("+")[0]}@${domain}` : String(address).toLowerCase();
};
export function extractThreadToken(addresses: string[]): string | null {
  for (const a of addresses) {
    const m = /\+k([0-9a-f]{12})@/i.exec(a);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

export function htmlToText(html: string): string {
  return String(html || "")
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n").trim();
}

export const safeFileName = (n: unknown): string =>
  String(n ?? "attachment").replace(/[\\/\u0000-\u001f"<>|?*:]/g, "_").replace(/^\.+/, "").slice(0, 200) || "attachment";

/** Event ids are stored in public.email_events.provider_event_id, which is globally unique in this phase.
 *  Every provider added after Resend stores `<provider_key>:<id>`. Resend keeps its bare Svix id: it is already stored that way,
 *  and prefixing it now would stop duplicate detection for events recorded before this change. */
export const providerEventId = (providerKey: string, id: string): string => (providerKey === "resend" ? id : `${providerKey}:${id}`);
