// Pure Intelligence-specific normalization. Kept separate from normal Inbox routing.
import { htmlToText, normalizeHeaders, parseAddress, parseMessageIds } from "./email_resend_logic.ts";

const TOKEN = /\bkf[0-9a-f]{32}\b/i;
const asText = (v: unknown): string => typeof v === "string" ? v : v == null ? "" : String(v);
const addressValues = (v: unknown): string[] => (Array.isArray(v) ? v : v ? [v] : []).map((x: any) => {
  if (typeof x === "string") return x;
  const email = asText(x?.email || x?.address);
  return email ? `${asText(x?.name)} <${email}>` : "";
}).map((x) => parseAddress(x).email).filter(Boolean);

export interface IntelInbound {
  p_provider_message_id: string;
  p_rfc_message_id: string;
  p_in_reply_to: string;
  p_references: string;
  p_from_email: string;
  p_subject: string;
  p_body_text: string;
  p_received_at: string;
  p_token: string;
}

/** Returns null for normal Inbox mail: only exact kf + 32-hex token replies are eligible. */
export function normalizeIntelReply(full: any, eventData: any): IntelInbound | null {
  const providerId = asText(eventData?.email_id || eventData?.id || full?.id);
  if (!providerId) return null;
  const headers = normalizeHeaders(full?.headers);
  const fromValue: any = full?.from || eventData?.from;
  const fromRaw = asText(headers.from || (typeof fromValue === "object"
    ? `${asText(fromValue?.name)} <${asText(fromValue?.email || fromValue?.address)}>` : fromValue));
  const from = parseAddress(fromRaw).email;
  const to = addressValues(full?.to || eventData?.to || headers.to);
  const subject = asText(full?.subject || eventData?.subject || headers.subject);
  const body = asText(full?.text) || htmlToText(asText(full?.html));
  const token = TOKEN.exec(`${subject}\n${body}`)?.[0]?.toLowerCase() || "";
  if (!token || !from || !to.length) return null;
  return {
    p_provider_message_id: providerId,
    p_rfc_message_id: parseMessageIds(headers["message-id"] || full?.message_id)[0] || "",
    p_in_reply_to: parseMessageIds(headers["in-reply-to"])[0] || "",
    p_references: headers.references || "",
    p_from_email: from,
    p_subject: subject,
    p_body_text: body,
    p_received_at: asText(full?.created_at || eventData?.created_at) || new Date().toISOString(),
    p_token: token,
  };
}

/** Injected store keeps duplicate behavior testable without a live Supabase project. */
export async function ingestIntelReply(input: IntelInbound | null, record: (p: IntelInbound) => Promise<unknown>) {
  if (!input) return { ignored: true };
  return await record(input);
}
