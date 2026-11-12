// Scheduled runner for general Email mailbox synchronization. Provider-neutral: it only runs accounts whose adapter implements
// `sync` and whose registry row has remote_sync enabled. Pure apart from injected dependencies, so it is unit tested without a network.
// Erasable TypeScript only (Node's test runner loads it directly).
import type { AdapterAccount, AdapterContext, EmailAdapter } from "./email_adapter.ts";
import { resolveAdapter, BUILTIN_ADAPTERS } from "./email_adapter_registry.ts";
import { synchronizeMailbox } from "./email_mailbox_sync.ts";
import type { MailboxSyncStore, SyncResult } from "./email_mailbox_sync.ts";

export interface RunnerDeps {
  /** Active, connected accounts, least recently attempted first, already capped by the caller. */
  listAccounts(limit: number): Promise<AdapterAccount[]>;
  getRegistryRow(providerKey: string): Promise<unknown>;
  makeContext(): AdapterContext;
  store: MailboxSyncStore;
  adapters?: Readonly<Record<string, EmailAdapter>>;
}
export interface RunnerSummary { accounts: number; synced: number; skipped: number; failed: number; results: Array<{ account_id: string; provider: string; status: string }> }

export const MAX_ACCOUNTS_PER_RUN = 25;

/** Constant-time comparison for the shared cron secret. An empty expected secret never authenticates. */
export function secretMatches(expected: string | undefined, given: string | null): boolean {
  if (!expected || expected.length < 16 || given == null || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

/** One failing account (bad token, provider outage, unsupported provider) never prevents the others from syncing. */
export async function runMailboxSync(deps: RunnerDeps): Promise<RunnerSummary> {
  const accounts = await deps.listAccounts(MAX_ACCOUNTS_PER_RUN);
  const summary: RunnerSummary = { accounts: accounts.length, synced: 0, skipped: 0, failed: 0, results: [] };
  const runStartedAt = Date.now();
  const RUN_BUDGET_MS = 100_000;
  const ACCOUNT_BUDGET_MS = 40_000;
  const MIN_ACCOUNT_START_BUDGET_MS = 5_000;
  const context = deps.makeContext();
  const note = (a: AdapterAccount, status: string) => summary.results.push({ account_id: a.id, provider: a.provider, status });
  for (const account of accounts) {
    if (Date.now() - runStartedAt >= RUN_BUDGET_MS) {
      summary.skipped += accounts.length - summary.results.length;
      for (const pending of accounts.slice(summary.results.length)) note(pending, "deferred:run_deadline");
      break;
    }
    let result: SyncResult | null = null;
    const remainingRunBudget = runStartedAt + RUN_BUDGET_MS - Date.now();
    if (remainingRunBudget < MIN_ACCOUNT_START_BUDGET_MS) {
      summary.skipped++; note(account, "deferred:insufficient_run_budget"); continue;
    }
    // Adapters consult this before each provider request/message; cap the account by both budgets.
    context.deadlineAt = Math.min(runStartedAt + RUN_BUDGET_MS, Date.now() + ACCOUNT_BUDGET_MS);
    try {
      const resolved = resolveAdapter(account.provider, await deps.getRegistryRow(account.provider), deps.adapters ?? BUILTIN_ADAPTERS);
      if (!resolved.operations.includes("sync")) { summary.skipped++; note(account, "no_sync_capability"); continue; }
      result = await synchronizeMailbox({ account, adapter: resolved.adapter, context, store: deps.store });
    } catch {
      summary.failed++; note(account, "failed"); continue;
    }
    if (result.status === "failed") { summary.failed++; note(account, "failed"); }
    else if (result.status === "skipped") { summary.skipped++; note(account, `skipped:${result.skip_reason || "unavailable"}`); }
    else { summary.synced++; note(account, result.status); }
  }
  return summary;
}
