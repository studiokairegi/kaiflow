// Browser client for the two token-based audiences (Client Portal visitors and freelancer guests).
// It only ever talks to the portal-chat Edge Function; there is no Supabase session and no direct
// table access. Credentials are sent in the request body, never in a URL.
import { functionUrl } from "../supabaseClient";

export const PORTAL_MAX_FILES = 5;
export const PORTAL_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const PORTAL_FILE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"];

export const PORTAL_ACCEPT = PORTAL_FILE_TYPES.join(",");

export function portalErrorText(code) {
  switch (String(code || "")) {
    case "invalid_credential": return "This link is no longer valid. Ask the studio for a new one.";
    case "rate_limited": return "Too many requests. Please wait a minute and try again.";
    case "message_too_long": return "That message is too long (4,000 characters maximum).";
    case "empty_message": return "Write a message or attach a file.";
    case "too_many_attachments": return `Attach up to ${PORTAL_MAX_FILES} files at a time.`;
    case "unsupported_file_type": case "file_content_mismatch": return "That file type isn't supported. Use an image, PDF or text file.";
    case "file_too_large": return "Files must be smaller than 10 MB.";
    case "not_authorized": return "You don't have access to this conversation.";
    case "not_found": return "That file is no longer available.";
    default: return "Something went wrong. Please try again.";
  }
}

async function call(payload, files = []) {
  let response;
  try {
    if (files.length) {
      const form = new FormData();
      for (const [key, value] of Object.entries(payload)) if (value != null) form.append(key, value);
      for (const file of files) form.append("files", file);
      response = await fetch(functionUrl("portal-chat"), { method: "POST", body: form });
    } else {
      response = await fetch(functionUrl("portal-chat"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
    }
  } catch {
    const error = new Error("You appear to be offline. Check your connection and try again.");
    error.code = "offline";
    throw error;
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.error) {
    const error = new Error(portalErrorText(result.error));
    error.code = result.error || `http_${response.status}`;
    error.status = response.status;
    throw error;
  }
  return result;
}

export const guestApi = {
  claim: (inviteToken, displayName, accessToken = "") =>
    fetch(functionUrl("portal-chat"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
      body: JSON.stringify({ mode: "guest", action: "guest_claim", invite_token: inviteToken, display_name: displayName }),
    }).then(async (response) => {
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.error) { const error = new Error(portalErrorText(result.error || "invalid_credential")); error.code = result.error; throw error; }
      return result;
    }),
  list: (session, after = null) => call({ mode: "guest", action: "list", session, after }),
  send: (session, body, idempotencyKey, files = []) => call({ mode: "guest", action: "send", session, body, idempotency_key: idempotencyKey }, files),
  download: (session, attachmentId) => call({ mode: "guest", action: "download", session, attachment_id: attachmentId }),
};

export const clientApi = {
  list: (shareToken, after = null) => call({ mode: "client", action: "list", share_token: shareToken, after }),
  send: (shareToken, displayName, body, idempotencyKey, files = []) =>
    call({ mode: "client", action: "send", share_token: shareToken, display_name: displayName, body, idempotency_key: idempotencyKey }, files),
  download: (shareToken, attachmentId) => call({ mode: "client", action: "download", share_token: shareToken, attachment_id: attachmentId }),
};

export function validatePortalFiles(files) {
  if (files.length > PORTAL_MAX_FILES) return `Attach up to ${PORTAL_MAX_FILES} files at a time.`;
  for (const file of files) {
    if (!PORTAL_FILE_TYPES.includes(String(file.type || "").toLowerCase())) return `${file.name}: only images, PDFs and text files are supported.`;
    if (file.size < 1 || file.size > PORTAL_MAX_FILE_BYTES) return `${file.name}: files must be smaller than 10 MB.`;
  }
  return "";
}

// The freelancer's existing per-shot link is the credential (one private thread per shot).
export const freelancerApi = {
  list: (shareToken, after = null) => call({ mode: "freelancer", action: "list", share_token: shareToken, after }),
  send: (shareToken, displayName, body, idempotencyKey, files = []) =>
    call({ mode: "freelancer", action: "send", share_token: shareToken, display_name: displayName, body, idempotency_key: idempotencyKey }, files),
  download: (shareToken, attachmentId) => call({ mode: "freelancer", action: "download", share_token: shareToken, attachment_id: attachmentId }),
};
