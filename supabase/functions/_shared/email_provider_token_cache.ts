import type { AdapterAccount } from "./email_adapter.ts";

/** Per-invocation token memo. Keeps the existing OAuth gateway authoritative and coalesces concurrent lookups. */
export function createProviderTokenCache<T>(
  load: (account: AdapterAccount, operation: "send" | "sync") => Promise<T>,
): (account: AdapterAccount, operation: "send" | "sync") => Promise<T> {
  const cache = new Map<string, Promise<T>>();
  return (account, operation) => {
    const key = `${account.id}:${operation}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = load(account, operation);
      cache.set(key, pending);
    }
    return pending;
  };
}
