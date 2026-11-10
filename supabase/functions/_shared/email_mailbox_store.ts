// Service-role persistence for general Email mailbox operations.
// Never import this from a browser bundle. It uses only public.email_* objects, never intel_*.
import type { AdapterAccount } from "./email_adapter.ts";
import type { MailboxSyncStore, NormalizedMailboxMessage } from "./email_mailbox_sync.ts";
import { encryptEmailCredentials, decryptEmailCredentials, type EncryptedEnvelope } from "./email_token_vault.ts";

const must = <T>(r: { data: T; error: { message: string } | null }, label: string): T => {
  if (r.error) throw new Error(`${label}: ${r.error.message}`);
  return r.data;
};
const cleanAddress = (v: unknown) => String(v ?? "").trim().toLowerCase();
const uniqueAddresses = (values: unknown[]) => [...new Set(values.map(cleanAddress).filter((v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)))];
const normalizedSubject = (subject: string) => String(subject || "").replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 998);
const parseReferences = (value: string | null | undefined) => String(value || "").match(/<[^<>\s]+>/g)?.slice(-20) || [];

export function makeMailboxSyncStore(service: any): MailboxSyncStore {
  return {
    async claimSync(accountId, leaseSeconds) {
      const out = must(await service.rpc("email_claim_sync", { p_account_id: accountId, p_lease_seconds: leaseSeconds }), "claim mailbox sync") as any;
      if (out?.claimed !== true) return { claimed: false, checkpoint: out?.checkpoint ?? {}, reason: String(out?.reason || "sync_unavailable"), retryAt: out?.retry_at ? String(out.retry_at) : undefined, consecutiveFailures: Number(out?.consecutive_failures || 0) };
      return { claimed: true, leaseToken: String(out.lease_token), checkpoint: out.checkpoint ?? {} };
    },
    async renewSync(accountId, leaseToken, leaseSeconds) {
      return must(await service.rpc("email_renew_sync", { p_account_id: accountId, p_lease_token: leaseToken, p_lease_seconds: leaseSeconds }), "renew mailbox sync lease") === true;
    },
    async persistMessage(account: AdapterAccount, message: NormalizedMailboxMessage) {
      const references = uniqueAddresses([message.from_email, ...message.to_emails, ...(message.cc_emails || []), ...(message.bcc_emails || [])]);
      const participants = references.map((email) => ({ email, name: email === cleanAddress(message.from_email) ? String(message.from_name || "") : "" }));
      const rfcCandidates = [...new Set([message.in_reply_to, ...parseReferences(message.references_ids)].filter(Boolean) as string[])];
      let conversationId: string | null = null;
      if (message.provider_thread_id) {
        conversationId = must(await service.rpc("email_get_or_create_synced_conversation", {
          p_organization_id: account.organization_id, p_account_id: account.id, p_provider: account.provider,
          p_provider_thread_id: message.provider_thread_id, p_subject: message.subject,
          p_normalized_subject: normalizedSubject(message.subject),
        }), "resolve provider thread") as string;
      }
      if (!conversationId && rfcCandidates.length) {
        const lookup = await service.from("email_messages").select("conversation_id")
          .eq("organization_id", account.organization_id).eq("account_id", account.id)
          .in("rfc_message_id", rfcCandidates).limit(1).maybeSingle();
        if (lookup.error) throw new Error(`mailbox thread lookup: ${lookup.error.message}`);
        conversationId = lookup.data?.conversation_id || null;
      }
      const headers = { ...(message.headers || {}), ...(message.provider_thread_id ? { "x-kairflow-provider-thread-id": message.provider_thread_id } : {}) };
      const attachments = (message.attachments || []).map((a) => ({
        provider_attachment_id: a.provider_attachment_id || null,
        filename: String(a.filename || "attachment").slice(0, 300),
        content_type: String(a.content_type || "application/octet-stream").slice(0, 200),
        size_bytes: Math.max(0, Number(a.size_bytes || 0)), is_inline: a.is_inline === true, content_id: a.content_id || null,
      }));
      const base = {
        organization_id: account.organization_id, account_id: account.id, provider: account.provider,
        conversation_id: conversationId, provider_message_id: message.provider_message_id,
        rfc_message_id: message.rfc_message_id || null, in_reply_to: message.in_reply_to || null,
        references_ids: message.references_ids || null, from_email: cleanAddress(message.from_email),
        from_name: String(message.from_name || "").slice(0, 200), to_emails: uniqueAddresses(message.to_emails || []),
        cc_emails: uniqueAddresses(message.cc_emails || []), bcc_emails: uniqueAddresses(message.bcc_emails || []),
        reply_to: String(message.reply_to || "").slice(0, 500), subject: String(message.subject || "").slice(0, 998),
        normalized_subject: normalizedSubject(message.subject), body_text: String(message.body_text || "").slice(0, 400000),
        body_html: String(message.body_html || "").slice(0, 800000), headers, participants,
      };
      if (message.direction === "inbound") {
        const out = must(await service.rpc("email_ingest_inbound", { p: {
          ...base, received_at: message.received_at || message.sent_at || new Date().toISOString(),
          attachments, is_read: message.is_read, folder_ids: message.folder_ids || [], provider_metadata: message.provider_metadata || {},
        } }), "persist inbound mailbox message") as any;
        if (out?.message_id) {
          if (must(await service.rpc("email_reconcile_synced_message_state", {
            p_account_id: account.id, p_provider: account.provider, p_provider_message_id: message.provider_message_id,
            p_direction: "inbound", p_folder_ids: message.folder_ids || [], p_is_deleted: message.is_deleted === true,
            p_provider_updated_at: message.provider_updated_at || null,
          }), "reconcile inbound provider message state") !== true) throw new Error("Inbound provider message state could not be reconciled");
        }
        return { inserted: out?.inserted === true || (out?.duplicate !== true), updated: out?.updated === true };
      }
      const out = must(await service.rpc("email_ingest_synced_outbound", { p: {
        ...base, sent_at: message.sent_at || message.received_at || new Date().toISOString(), attachments, is_read: message.is_read,
        folder_ids: message.folder_ids || [], provider_metadata: message.provider_metadata || {},
      } }), "persist outbound mailbox message") as any;
      if (out?.message_id) {
        if (must(await service.rpc("email_reconcile_synced_message_state", {
          p_account_id: account.id, p_provider: account.provider, p_provider_message_id: message.provider_message_id,
          p_direction: "outbound", p_folder_ids: message.folder_ids || [], p_is_deleted: message.is_deleted === true,
          p_provider_updated_at: message.provider_updated_at || null,
        }), "reconcile outbound provider message state") !== true) throw new Error("Outbound provider message state could not be reconciled");
      }
      return { inserted: out?.inserted === true || (out?.duplicate !== true), updated: out?.updated === true };
    },
    async commitCheckpoint(accountId, leaseToken, checkpoint, pages, messages) {
      return must(await service.rpc("email_commit_sync_checkpoint", {
        p_account_id: accountId, p_lease_token: leaseToken, p_checkpoint: checkpoint ?? {}, p_pages: pages, p_messages: messages,
      }), "commit mailbox sync checkpoint") === true;
    },
    async finishSync(accountId, leaseToken, result) {
      return must(await service.rpc("email_finish_sync", { p_account_id: accountId, p_lease_token: leaseToken, p_pages: result.pages, p_messages: result.messages, p_inserted: result.inserted, p_updated: result.updated, p_partial: result.partial }), "finish mailbox sync") === true;
    },
    async failSync(accountId, leaseToken, safeError, retryAt) {
      must(await service.rpc("email_fail_sync", { p_account_id: accountId, p_lease_token: leaseToken, p_safe_error: safeError, p_retry_at: retryAt }), "record mailbox sync failure");
    },
  };
}

/** Save an encrypted token set. Account/provider/organization are checked by database constraints and AES-GCM AAD. */
export async function saveEmailCredentials(service: any, input: {
  accountId: string; organizationId: string; provider: string; credentials: unknown; encryptionKey: string;
  expiresAt?: string | null; scopes?: string[];
}): Promise<void> {
  if (!input.accountId || !input.organizationId || !input.provider || !input.encryptionKey) throw new Error("Mailbox credential identity or encryption key is missing");
  const aad = `${input.organizationId}/${input.accountId}/${input.provider}`;
  const envelope = await encryptEmailCredentials(input.credentials, input.encryptionKey, aad);
  must(await service.from("email_provider_credentials").upsert({
    account_id: input.accountId, organization_id: input.organizationId, provider_key: input.provider,
    key_version: 1, algorithm: envelope.algorithm, nonce: envelope.nonce,
    ciphertext: envelope.ciphertext, token_expires_at: input.expiresAt || null, scopes: input.scopes || [], updated_at: new Date().toISOString(),
  }, { onConflict: "account_id" }), "save encrypted mailbox credentials");
}

/** Load and decrypt credentials only in a trusted Edge Function/worker process. */
export async function loadEmailCredentials(service: any, input: {
  accountId: string; organizationId: string; provider: string; encryptionKey: string;
}): Promise<unknown | null> {
  if (!input.accountId || !input.organizationId || !input.provider || !input.encryptionKey) throw new Error("Mailbox credential identity or encryption key is missing");
  const row = must(await service.from("email_provider_credentials").select("algorithm,nonce,ciphertext,key_version,token_expires_at")
    .eq("account_id", input.accountId).eq("organization_id", input.organizationId).eq("provider_key", input.provider).maybeSingle(), "load encrypted mailbox credentials") as any;
  if (!row) return null;
  if (row.token_expires_at && new Date(row.token_expires_at).getTime() <= Date.now()) throw new Error("Mailbox credentials have expired; reconnect the account");
  if (Number(row.key_version) !== 1) throw new Error("Unsupported email token encryption key version");
  const envelope: EncryptedEnvelope = { version: 1, algorithm: row.algorithm, nonce: row.nonce, ciphertext: row.ciphertext };
  return decryptEmailCredentials(envelope, input.encryptionKey, `${input.organizationId}/${input.accountId}/${input.provider}`);
}

export async function deleteEmailCredentials(service: any, accountId: string, organizationId: string, provider: string): Promise<void> {
  must(await service.from("email_provider_credentials").delete().eq("account_id", accountId).eq("organization_id", organizationId).eq("provider_key", provider), "delete mailbox credentials");
}
