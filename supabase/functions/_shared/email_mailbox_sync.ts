// Provider-neutral mailbox synchronization coordinator (Phase 5).
// Provider adapters fetch/normalize; this module owns ordering, idempotency, checkpoint safety and partial-failure semantics.
import type { AdapterAccount, AdapterContext, AdapterSyncMessage, AdapterSyncPage, EmailAdapter } from "./email_adapter.ts";
import { AdapterError, CapabilityError } from "./email_adapter.ts";

export type NormalizedMailboxMessage = AdapterSyncMessage;

export interface MailboxSyncStore {
  claimSync(accountId: string, leaseSeconds: number): Promise<{ claimed: boolean; leaseToken?: string; checkpoint: unknown; reason?: string; retryAt?: string; consecutiveFailures?: number }>;
  persistMessage(account: AdapterAccount, message: NormalizedMailboxMessage): Promise<{ inserted: boolean; updated: boolean }>;
  renewSync(accountId: string, leaseToken: string, leaseSeconds: number): Promise<boolean>;
  commitCheckpoint(accountId: string, leaseToken: string, checkpoint: unknown, pages: number, messages: number): Promise<boolean>;
  finishSync(accountId: string, leaseToken: string, result: { pages: number; messages: number; inserted: number; updated: number; partial: boolean }): Promise<boolean>;
  failSync(accountId: string, leaseToken: string, safeError: string, retryAt: string): Promise<void>;
}

export interface SyncResult {
  ok: boolean;
  pages: number;
  messages_seen: number;
  messages_inserted: number;
  messages_updated: number;
  checkpoint_committed: boolean;
  has_more: boolean;
  error?: string;
  status: "completed" | "partial" | "skipped" | "failed";
  skip_reason?: string;
  retry_at?: string;
}

const MAX_PAGES_PER_RUN = 8;
const LEASE_SECONDS = 180;
const safeError = (e: unknown): string => {
  // Persist a fixed operational message only. Provider/database exceptions may contain addresses,
  // message fragments, response bodies, headers or credentials and are never copied to sync state.
  return e instanceof AdapterError ? `Mailbox provider operation failed (${e.code})` : "Mailbox synchronization failed; retry is required";
};

/** Run a bounded sync. Checkpoint advances only after every message in that page is durably persisted. */
export async function synchronizeMailbox(
  input: { account: AdapterAccount; adapter: EmailAdapter; context: AdapterContext; store: MailboxSyncStore; now?: () => number },
): Promise<SyncResult> {
  const { account, adapter, context, store } = input;
  const now = input.now ?? context.now;
  if (!adapter.operations.includes("sync") || typeof adapter.sync !== "function") throw new CapabilityError(adapter.providerKey, "sync");
  if (account.status !== "active" || account.connection_status !== "connected") throw new AdapterError("account_not_usable", "Mailbox account is not connected", { provider: adapter.providerKey, operation: "sync" });
  if (typeof context.getCredentials !== "function" || await context.getCredentials(account) == null) throw new AdapterError("not_configured", "Mailbox credentials are unavailable; reconnect the account", { provider: adapter.providerKey, operation: "sync" });
  const claim = await store.claimSync(account.id, LEASE_SECONDS);
  if (!claim.claimed || !claim.leaseToken) return { ok: false, status: "skipped", skip_reason: claim.reason || "sync_unavailable", retry_at: claim.retryAt, pages: 0, messages_seen: 0, messages_inserted: 0, messages_updated: 0, checkpoint_committed: false, has_more: true };

  let checkpoint = claim.checkpoint;
  let pages = 0, seen = 0, inserted = 0, updated = 0;
  let hasMore = true;
  let heartbeatBusy = false;
  let leaseLost = false;
  // Keep the lease alive while a provider request or persistence operation is pending.
  // A single slow page must not allow a second worker to claim the same mailbox.
  const heartbeat = setInterval(() => {
    if (heartbeatBusy || leaseLost) return;
    heartbeatBusy = true;
    void store.renewSync(account.id, claim.leaseToken!, LEASE_SECONDS)
      .then((renewed) => { if (!renewed) leaseLost = true; })
      .catch(() => { leaseLost = true; })
      .finally(() => { heartbeatBusy = false; });
  }, Math.floor(LEASE_SECONDS * 1000 / 3));
  try {
    while (hasMore && pages < MAX_PAGES_PER_RUN) {
      if (leaseLost || !await store.renewSync(account.id, claim.leaseToken, LEASE_SECONDS)) throw new AdapterError("account_not_usable", "Mailbox synchronization lease was lost; retry is required", { provider: adapter.providerKey, operation: "sync" });
      const raw = await adapter.sync(context, account, checkpoint) as AdapterSyncPage;
      if (leaseLost) throw new AdapterError("account_not_usable", "Mailbox synchronization lease was lost; retry is required", { provider: adapter.providerKey, operation: "sync" });
      if (!raw || !Array.isArray(raw.messages) || typeof raw.has_more !== "boolean" || typeof raw.complete !== "boolean" || !Object.prototype.hasOwnProperty.call(raw, "next_checkpoint")) {
        throw new AdapterError("provider_rejected", "The mailbox provider returned an invalid synchronization page", { provider: adapter.providerKey, operation: "sync" });
      }
      const pageIds = new Set<string>();
      for (const message of raw.messages) {
        if (!message || typeof message.provider_message_id !== "string" || !message.provider_message_id.trim() || !["inbound", "outbound"].includes(message.direction)) {
          throw new AdapterError("provider_rejected", "The mailbox provider returned a message without a valid identity", { provider: adapter.providerKey, operation: "sync" });
        }
        if (pageIds.has(message.provider_message_id)) continue;
        pageIds.add(message.provider_message_id);
        const result = await store.persistMessage(account, message);
        if (leaseLost) throw new AdapterError("account_not_usable", "Mailbox synchronization lease was lost; retry is required", { provider: adapter.providerKey, operation: "sync" });
        seen++;
        if (result.inserted) inserted++;
        else if (result.updated) updated++;
      }
      // A provider page is committed only after all message upserts succeeded.
      const committed = await store.commitCheckpoint(account.id, claim.leaseToken, raw.next_checkpoint, pages + 1, seen);
      if (!committed) throw new AdapterError("account_not_usable", "Mailbox synchronization lease expired; retry is required", { provider: adapter.providerKey, operation: "sync" });
      const previousCheckpoint = checkpoint;
      checkpoint = raw.next_checkpoint;
      if (raw.has_more && JSON.stringify(checkpoint) === JSON.stringify(previousCheckpoint)) throw new AdapterError("provider_rejected", "The provider returned a non-advancing synchronization checkpoint", { provider: adapter.providerKey, operation: "sync" });
      pages++;
      hasMore = raw.has_more;
      if (raw.complete && !raw.has_more) hasMore = false;
      if (raw.messages.length === 0 && raw.has_more) throw new AdapterError("provider_rejected", "The provider returned an empty page while claiming more results", { provider: adapter.providerKey, operation: "sync" });
    }
    const partial = hasMore;
    if (leaseLost) throw new AdapterError("account_not_usable", "Mailbox synchronization lease was lost; retry is required", { provider: adapter.providerKey, operation: "sync" });
    const released = await store.finishSync(account.id, claim.leaseToken, { pages, messages: seen, inserted, updated, partial });
    if (!released) throw new AdapterError("account_not_usable", "Mailbox synchronization lease expired before completion", { provider: adapter.providerKey, operation: "sync" });
    return { ok: true, status: partial ? "partial" : "completed", pages, messages_seen: seen, messages_inserted: inserted, messages_updated: updated, checkpoint_committed: pages > 0, has_more: hasMore };
  } catch (error) {
    const message = safeError(error);
    const retryDelayMs = Math.min(6 * 60 * 60_000, 60_000 * (2 ** Math.min(claim.consecutiveFailures ?? 0, 8)));
    // Recording the failure can itself fail (database unavailable). That must never turn a handled sync failure into a thrown error:
    // the lease then simply expires and the next run retries.
    try { await store.failSync(account.id, claim.leaseToken, message, new Date(now() + retryDelayMs).toISOString()); } catch { /* lease expiry is the fallback */ }
    return { ok: false, status: "failed", pages, messages_seen: seen, messages_inserted: inserted, messages_updated: updated, checkpoint_committed: pages > 0, has_more: true, error: message };
  } finally {
    clearInterval(heartbeat);
  }
}
