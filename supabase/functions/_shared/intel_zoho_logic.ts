// Zoho Mail constants shared by the account-scoped provider OAuth flow (intel_provider_oauth.ts).
// Zoho details (hosts, scopes) follow Zoho's public REST API documentation.

export const ZOHO_DATA_CENTERS = ["com", "eu", "in", "com.au", "jp", "ca", "sa", "com.cn"];
// Minimum scopes: list folders/accounts, read mail, send mail. Nothing else (no delete, no settings, no contacts).
export const ZOHO_SCOPES = "ZohoMail.accounts.READ,ZohoMail.folders.READ,ZohoMail.messages.READ,ZohoMail.messages.CREATE";

export const accountsHost = (dc: string) => `https://accounts.zoho.${dc}`;
export const apiBase = (dc: string) => `https://mail.zoho.${dc}/api`;
export const isDataCenter = (dc: unknown): dc is string => typeof dc === "string" && ZOHO_DATA_CENTERS.includes(dc);
