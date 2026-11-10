// Gmail constants shared by the account-scoped provider OAuth flow (intel_provider_oauth.ts).
// Google specifics (hosts, scopes) follow Google's public OAuth/Gmail docs.

// Least privilege that still lets the agent send and read replies. gmail.readonly is a "restricted" scope: for ONE personal account an
// unverified app is allowed (publish the consent screen to "In production" so refresh tokens do not expire after 7 days).
export const GMAIL_SCOPE_LIST = ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.readonly"];
export const GMAIL_SCOPES = GMAIL_SCOPE_LIST.join(" ");
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";

/** True only when Google confirms BOTH scopes were granted (people can untick one on the consent screen). */
export const hasAllScopes = (granted: unknown): boolean => {
  const set = new Set(String(granted || "").split(/\s+/).filter(Boolean));
  return GMAIL_SCOPE_LIST.every((s) => set.has(s));
};
