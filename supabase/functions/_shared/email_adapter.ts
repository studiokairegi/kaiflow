// General Email (CRM > Inbox) mailbox adapter contract. Multi-provider plan, phase 3.
// Provider-specific API calls live ONLY in adapters that implement this contract. Shared services (email_resend_logic.ts today,
// renamed later) never call a provider directly: they validate, authorize, rate limit, persist, then ask the adapter.
// This is separate from KairFlow Intelligence (intel_* providers) and shares nothing with it.
// Erasable TypeScript only (types and interfaces), so Node's test runner can load it directly.

/** Every operation a mailbox adapter may offer. `send` is the only REQUIRED one; the rest are optional capabilities. */
export const ADAPTER_OPERATIONS = Object.freeze([
  "send", "validate_connection", "connect", "disconnect", "list_folders", "sync", "fetch_message", "search",
  "save_draft", "reply", "forward", "fetch_attachment", "upload_attachment", "mark_read", "archive", "move", "delivery_status",
] as const);
export type AdapterOperation = (typeof ADAPTER_OPERATIONS)[number];
export const REQUIRED_OPERATIONS: readonly AdapterOperation[] = Object.freeze(["send"] as AdapterOperation[]);

/** Capability keys as stored in public.email_provider_registry.capabilities (Phase 2). The registry row is the declaration;
 *  the adapter object must agree with it (see assertAdapterMatchesRegistry in email_adapter_registry.ts). */
export const CAPABILITY_FOR_OPERATION: Readonly<Record<AdapterOperation, string>> = Object.freeze({
  send: "send", validate_connection: "validate_connection", connect: "oauth", disconnect: "oauth", list_folders: "remote_folders",
  sync: "remote_sync", fetch_message: "remote_sync", search: "remote_search", save_draft: "remote_drafts", reply: "send", forward: "send",
  fetch_attachment: "attachments_receive", upload_attachment: "attachments_send", mark_read: "remote_state", archive: "remote_state",
  move: "remote_state", delivery_status: "delivery_events",
});

/** Normalised error codes. A caller can branch on `code`; `message` is safe to show a person (never contains secrets or bodies). */
export type AdapterErrorCode =
  | "unsupported_operation"     // the provider does not offer this operation (CapabilityError)
  | "provider_not_registered"   // account's provider is not in the registry
  | "provider_disabled"         // registry/flag says the provider may not be used right now
  | "adapter_unavailable"       // registry names an adapter this deployment does not contain
  | "not_configured"            // server-side secret/config missing
  | "account_not_usable"        // account disconnected, expired or not active
  | "rate_limited" | "provider_rejected" | "provider_unavailable" | "outcome_unknown" | "sync_deadline";

/** Provider refresh responses that definitively indicate a revoked user grant. */
export function isRevokedProviderRefresh(provider: string, status: number, data: unknown): boolean {
  const body = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const code = String(body.error || body.code || "").toLowerCase();
  if (status === 401) return true;
  if (provider === "gmail") return status === 400 && code === "invalid_grant";
  // Zoho's token endpoint may return an OAuth error code in its JSON body.
  // invalid_client is deliberately excluded: it indicates app configuration, not user revocation.
  return provider === "zoho" && ["invalid_grant", "invalid_code"].includes(code);
}

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly status: number;                 // suggested HTTP status for the browser-facing answer
  readonly provider: string;
  readonly operation: AdapterOperation | null;
  constructor(code: AdapterErrorCode, message: string, o: { status?: number; provider?: string; operation?: AdapterOperation | null } = {}) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
    this.status = o.status ?? STATUS_FOR_CODE[code];
    this.provider = o.provider ?? "";
    this.operation = o.operation ?? null;
  }
}
const STATUS_FOR_CODE: Record<AdapterErrorCode, number> = {
  unsupported_operation: 501, provider_not_registered: 409, provider_disabled: 503, adapter_unavailable: 503, not_configured: 503,
  account_not_usable: 409, rate_limited: 429, provider_rejected: 422, provider_unavailable: 502, outcome_unknown: 202, sync_deadline: 202,
};

/** Thrown, never silently ignored, when an operation the provider does not support is requested. */
export class CapabilityError extends AdapterError {
  constructor(provider: string, operation: AdapterOperation) {
    super("unsupported_operation", `${provider} does not support "${operation}" for mailbox accounts`, { provider, operation });
    this.name = "CapabilityError";
  }
}

/** The shared request every adapter's `send` receives. Already validated, authorised and persisted by the shared service. */
export interface AdapterSendInput {
  fromEmail: string;
  fromName: string;
  to: string[]; cc: string[]; bcc: string[];
  subject: string; text: string; html: string;
  replyTo: string;
  thread: { in_reply_to: string; references: string; provider_message_id?: string | null; provider_thread_id?: string | null; parent_direction?: "inbound" | "outbound" | null } | null;
  attachments: { filename: string; content_base64: string; content_type?: string }[];
  idempotencyKey: string;
  /** Persisted server-generated email_messages.id used to reconcile a provider-accepted send from signed webhooks. */
  correlationId: string;
  /** Shared send endpoint mode: adapters receive explicit semantics for reply/forward instead of treating them as indistinguishable sends. */
  mode?: "new" | "reply" | "forward";
}

/** What a provider answers to `send`. `unknown` means the provider may have accepted the message: never resent automatically. */
export type AdapterSendOutcome =
  | { ok: true; providerMessageId: string; rfcMessageId?: string; providerThreadId?: string; attempts: number }
  | { ok: false; unknown: boolean; retryable: boolean; status: number; message: string; attempts: number };

/** Account as read from the DATABASE by the shared service. Never constructed from browser input. */
export interface AdapterAccount { id: string; organization_id?: string; provider: string; address: string; display_name: string; status: string; connection_status?: string }

export interface AdapterContext {
  env: (k: string) => string | undefined;
  fetch: typeof fetch;
  now: () => number;
  /** Absolute epoch deadline for the currently leased account sync. */
  deadlineAt?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Server-only credential resolver. Never pass this context or its result to a browser. */
  getCredentials?: (account: AdapterAccount) => Promise<unknown | null>;
  /** Obtain a short-lived provider token from the existing Intelligence OAuth lifecycle. Server-only. */
  getProviderAccessToken?: (account: AdapterAccount, operation: "send" | "sync") => Promise<{ provider: string; access_token: string; api_base: string; external_account_id: string; mailbox: string; expires_in: number }>;
}

export interface AdapterSyncMessage {
  provider_message_id: string;
  provider_thread_id?: string | null;
  rfc_message_id?: string | null;
  in_reply_to?: string | null;
  references_ids?: string | null;
  direction: "inbound" | "outbound";
  from_email: string;
  from_name?: string;
  to_emails: string[];
  cc_emails?: string[];
  bcc_emails?: string[];
  reply_to?: string;
  subject: string;
  body_text?: string;
  body_html?: string;
  headers?: Record<string, string>;
  is_read: boolean;
  /** Provider folder/label membership; identifiers are provider-scoped. */
  folder_ids?: string[];
  /** True only when the provider explicitly reports this message as deleted/trash-removed. */
  is_deleted?: boolean;
  provider_updated_at?: string | null;
  sent_at?: string | null;
  received_at?: string | null;
  attachments?: Array<{ provider_attachment_id?: string; filename: string; content_type: string; size_bytes?: number; is_inline?: boolean; content_id?: string }>;
  provider_metadata?: Record<string, unknown>;
}

export interface AdapterSyncPage {
  messages: AdapterSyncMessage[];
  next_checkpoint: unknown;
  has_more: boolean;
  complete: boolean;
  /** True when the provider page was only partially fetched; persist messages but never advance its checkpoint. */
  partial?: boolean;
}

/** An adapter owns ONE provider key. Optional members are optional capabilities: the registry (database) says which are on. */
export interface EmailAdapter {
  readonly providerKey: string;
  readonly adapterKey: string;
  readonly displayName: string;
  /** What this adapter implements. Must be a subset of the registry row's capabilities for the provider to be used. */
  readonly operations: readonly AdapterOperation[];
  /** Server-side configuration check (for example RESEND_API_KEY present). Returns null when ready, else a message safe to show. */
  configurationProblem(env: AdapterContext["env"]): string | null;
  /** Legacy shared kill switch to honour in addition to the registry, if the provider has one (Resend: email_provider_flags). */
  readonly legacyFlagKey: string | null;
  /** Provider quota the shared service enforces per organization per 24 h. `dailyLimitEnv` (if set) overrides it; both are optional. */
  readonly defaultDailyLimit?: number;
  readonly dailyLimitEnv?: string;
  /** REQUIRED. */
  send(ctx: AdapterContext, account: AdapterAccount, input: AdapterSendInput): Promise<AdapterSendOutcome>;
  // ---- optional capabilities (phase 4/5 providers implement these; Resend does not) ----
  validateConnection?(ctx: AdapterContext, account: AdapterAccount): Promise<{ ok: boolean; reason?: string }>;
  connect?(ctx: AdapterContext, input: { authorizationCode: string; redirectUri: string; state: string; codeVerifier?: string }): Promise<{ credentials: unknown; address: string; displayName?: string; scopes?: string[]; expiresAt?: string | null }>;
  disconnect?(ctx: AdapterContext, account: AdapterAccount): Promise<void>;
  deliveryStatus?(ctx: AdapterContext, account: AdapterAccount, messageId: string): Promise<{ status: string; occurredAt?: string; detail?: Record<string, unknown> }>;
  listFolders?(ctx: AdapterContext, account: AdapterAccount): Promise<unknown[]>;
  sync?(ctx: AdapterContext, account: AdapterAccount, checkpoint: unknown): Promise<AdapterSyncPage>;
  fetchMessage?(ctx: AdapterContext, account: AdapterAccount, messageId: string): Promise<AdapterSyncMessage>;
  search?(ctx: AdapterContext, account: AdapterAccount, query: string): Promise<unknown[]>;
  saveDraft?(ctx: AdapterContext, account: AdapterAccount, draft: unknown): Promise<unknown>;
  markRead?(ctx: AdapterContext, account: AdapterAccount, ids: string[], read: boolean): Promise<void>;
  archive?(ctx: AdapterContext, account: AdapterAccount, ids: string[]): Promise<void>;
  fetchAttachment?(ctx: AdapterContext, account: AdapterAccount, ref: unknown): Promise<Uint8Array>;
  uploadAttachment?(ctx: AdapterContext, account: AdapterAccount, input: { filename: string; contentType: string; bytes: Uint8Array }): Promise<unknown>;
  move?(ctx: AdapterContext, account: AdapterAccount, ids: string[], folderId: string): Promise<void>;
}

/** Does the adapter implement `op`? (Declared operations AND an actual function, so a declaration can never lie.) */
export function adapterSupports(a: EmailAdapter, op: AdapterOperation): boolean {
  if (!a.operations.includes(op)) return false;
  const fn: Record<AdapterOperation, unknown> = {
    send: a.send, validate_connection: a.validateConnection, connect: a.connect, disconnect: a.disconnect, list_folders: a.listFolders,
    sync: a.sync, fetch_message: a.fetchMessage, search: a.search, save_draft: a.saveDraft, reply: a.send, forward: a.send,
    fetch_attachment: a.fetchAttachment, upload_attachment: a.uploadAttachment, mark_read: a.markRead, archive: a.archive, move: a.move, delivery_status: a.deliveryStatus,
  };
  // Operations with no dedicated optional method (connect, move, ...) are phase 4/5: declared support alone is not accepted.
  return typeof fn[op] === "function";
}

/** Normalised capability gate for shared services. Throws CapabilityError; never pretends an operation worked. */
export function requireOperation(a: EmailAdapter, op: AdapterOperation): void {
  if (!adapterSupports(a, op)) throw new CapabilityError(a.providerKey, op);
}

/** Structural check that an object really is a usable adapter: required operations present, keys well formed. Returns problems. */
export function adapterProblems(a: EmailAdapter): string[] {
  const out: string[] = [];
  if (!/^[a-z][a-z0-9_]{1,31}$/.test(a?.providerKey || "")) out.push("providerKey is not a valid key");
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(a?.adapterKey || "")) out.push("adapterKey is not a valid key");
  for (const op of REQUIRED_OPERATIONS) if (!adapterSupports(a, op)) out.push(`required operation "${op}" is missing`);
  for (const op of a?.operations || []) if (!(ADAPTER_OPERATIONS as readonly string[]).includes(op)) out.push(`unknown operation "${op}"`);
  return out;
}
