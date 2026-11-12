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
  /**
   * Round 7.1: release the lease WITHOUT recording a failure when the account is no longer eligible.
   * Resolves true only when the database confirmed the account is ineligible now and released the lease.
   * It never changes failure counters, retry time, error text or checkpoint. False means the account is
   * still eligible, so the caller must treat the problem as a genuine failure.
   */
  releaseIneligibleSync(accountId: string, leaseToken: string): Promise<boolean>;
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
const MAX_ACCOUNT_RUNTIME_MS = 40_000;
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
  // The shared provider-token gateway is the authoritative credential check. Avoid a second
  // decrypt/read here; it would duplicate work on every account before the token refresh.
  const claim = await store.claimSync(account.id, LEASE_SECONDS);
  if (!claim.claimed || !claim.leaseToken) return { ok: false, status: "skipped", skip_reason: claim.reason || "sync_unavailable", retry_at: claim.retryAt, pages: 0, messages_seen: 0, messages_inserted: 0, messages_updated: 0, checkpoint_committed: false, has_more: true };

  let checkpoint = claim.checkpoint;
  let pages = 0, seen = 0, inserted = 0, updated = 0;
  let hasMore = true;
  const accountDeadline = now() + MAX_ACCOUNT_RUNTIME_MS;
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
      if (now() >= accountDeadline) break;
      if (leaseLost || !await store.renewSync(account.id, claim.leaseToken, LEASE_SECONDS)) throw new AdapterError("account_not_usable", "Mailbox synchronization lease was lost; retry is required", { provider: adapter.providerKey, operation: "sync" });
      let raw: AdapterSyncPage;
      try { raw = await adapter.sync(context, account, checkpoint) as AdapterSyncPage; }
      catch (error) {
        if (error instanceof AdapterError && error.code === "sync_deadline") {
          // A deadline before any message was recovered must back off visibly; otherwise the
          // same un-fetchable page could be retried on every scheduler tick with a healthy status.
          if (seen === 0 && pages === 0) throw error;
          hasMore = true; break;
        }
        throw error;
      }
      if (leaseLost) throw new AdapterError("account_not_usable", "Mailbox synchronization lease was lost; retry is required", { provider: adapter.providerKey, operation: "sync" });
      if (!raw || !Array.isArray(raw.messages) || typeof raw.has_more !== "boolean" || typeof raw.complete !== "boolean" || !Object.prototype.hasOwnProperty.call(raw, "next_checkpoint")) {
        throw new AdapterError("provider_rejected", "The mailbox provider returned an invalid synchronization page", { provider: adapter.providerKey, operation: "sync" });
      }
      // Round 7.2: re-check the lease, and with it current eligibility, BEFORE any fetched message is saved.
      // An account disabled during the provider request must not have this page ingested. A refusal
      // here flows to the ineligible-release check in the catch block; nothing from the page is written.
      if (!await store.renewSync(account.id, claim.leaseToken, LEASE_SECONDS)) throw new AdapterError("account_not_usable", "Mailbox synchronization lease was lost; retry is required", { provider: adapter.providerKey, operation: "sync" });
      const pageIds = new Set<string>();
      // Finish persisting the bounded provider response even if the provider deadline
      // expires after fetch. Interrupting local upserts would replay the same prefix
      // forever without a durable provider-row offset. Provider requests remain deadline-bound.
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
      // Partial provider pages carry an in-page resume cursor (Gmail pageToken+offset,
      // Zoho start+offset). Persist the recovered prefix first, then commit only that
      // safe prefix so the next run does not refetch it. A zero-progress partial must
      // enter normal failure/backoff rather than masquerading as healthy progress.
      if (raw.partial) {
        if (JSON.stringify(raw.next_checkpoint) === JSON.stringify(checkpoint)) {
          throw new AdapterError("sync_deadline", "Mailbox page made no resumable progress before its deadline", { provider: adapter.providerKey, operation: "sync" });
        }
        const partialCommitted = await store.commitCheckpoint(account.id, claim.leaseToken, raw.next_checkpoint, pages + 1, seen);
        if (!partialCommitted) throw new AdapterError("account_not_usable", "Mailbox synchronization lease expired while saving partial-page progress", { provider: adapter.providerKey, operation: "sync" });
        checkpoint = raw.next_checkpoint;
        pages++;
        hasMore = true;
        break;
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
    // Round 7.1: stop provider work and ask the database whether the account is ineligible NOW.
    // Losing eligibility is an operator action, not a provider failure: no failure count, no backoff.
    // The check runs for every error path, so a lost renewal, refused checkpoint, refused finish or a
    // provider error raised after the account was disabled are all handled identically. If the
    // database cannot answer, fall through to the normal failure path; lease expiry is the backstop.
    let releasedIneligible = false;
    try { releasedIneligible = (await store.releaseIneligibleSync(account.id, claim.leaseToken)) === true; } catch { releasedIneligible = false; }
    if (releasedIneligible) {
      return { ok: false, status: "skipped", skip_reason: "account_ineligible", pages, messages_seen: seen, messages_inserted: inserted, messages_updated: updated, checkpoint_committed: pages > 0, has_more: true };
    }
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
