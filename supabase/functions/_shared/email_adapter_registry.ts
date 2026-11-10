// Adapter selection for general Email (multi-provider plan, phase 3).
// RULE: the adapter is chosen from the provider stored on the ACCOUNT ROW in the database, then checked against the database registry
// (public.email_provider_registry, phase 2). A provider name supplied by the browser is never read here or anywhere in the send path.
// Pure: no database, no network. The store hands in the registry row; tests hand in fakes.
import { AdapterError, ADAPTER_OPERATIONS, CAPABILITY_FOR_OPERATION, adapterProblems, adapterSupports, requireOperation } from "./email_adapter.ts";
import type { AdapterOperation, EmailAdapter } from "./email_adapter.ts";
import { resendAdapter } from "./email_adapter_resend.ts";

/** Row of public.email_provider_registry as the store returns it. */
export interface RegistryRow { provider_key: string; adapter_key: string; display_name: string; capabilities: Record<string, unknown>; enabled: boolean }

/** Adapters compiled into this deployment, by adapter_key. Adding a provider = add its adapter file here AND insert its registry row
 *  (the row is inserted by a deliberate migration, never as a side effect of connecting an account). */
export const BUILTIN_ADAPTERS: Readonly<Record<string, EmailAdapter>> = Object.freeze({ [resendAdapter.adapterKey]: resendAdapter });

/** Validates the raw database row. Returns null when it is not usable as a registry row. */
export function normalizeRegistryRow(raw: unknown): RegistryRow | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  const caps = r.capabilities;
  if (typeof r.provider_key !== "string" || typeof r.adapter_key !== "string" || typeof r.enabled !== "boolean") return null;
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) return null;
  return { provider_key: r.provider_key, adapter_key: r.adapter_key, display_name: String(r.display_name ?? r.provider_key), capabilities: caps as Record<string, unknown>, enabled: r.enabled };
}

export interface ResolvedAdapter { adapter: EmailAdapter; row: RegistryRow; operations: readonly AdapterOperation[] }

/** Operations the provider may really perform now: the adapter implements them AND the registry row declares the capability true.
 *  Either side saying no means "unsupported". The registry can therefore only ever narrow what code offers, never widen it. */
export function effectiveOperations(adapter: EmailAdapter, row: RegistryRow): AdapterOperation[] {
  return ADAPTER_OPERATIONS.filter((op) => adapterSupports(adapter, op) && row.capabilities[CAPABILITY_FOR_OPERATION[op]] === true);
}

/**
 * Select the adapter for an account. `accountProvider` MUST come from the database account row.
 * Throws a normalised AdapterError (never returns a "best guess").
 *   provider_not_registered : no registry row, or the row is for another provider
 *   provider_disabled       : registry says enabled = false
 *   adapter_unavailable     : the row names an adapter this deployment does not contain, or the adapter is malformed / serves another provider
 */
export function resolveAdapter(accountProvider: unknown, rawRow: unknown, adapters: Readonly<Record<string, EmailAdapter>> = BUILTIN_ADAPTERS): ResolvedAdapter {
  const provider = typeof accountProvider === "string" ? accountProvider : "";
  if (!provider) throw new AdapterError("provider_not_registered", "This sender account has no provider", { provider });
  const row = normalizeRegistryRow(rawRow);
  if (!row || row.provider_key !== provider) throw new AdapterError("provider_not_registered", "This sender account uses a provider that is not set up", { provider });
  if (!row.enabled) throw new AdapterError("provider_disabled", `${row.display_name} is not the active email provider`, { provider });
  // Own-property lookup only: a hostile adapter_key such as "__proto__" or "constructor" must not resolve to anything.
  const adapter = Object.prototype.hasOwnProperty.call(adapters, row.adapter_key) ? adapters[row.adapter_key] : undefined;
  if (!adapter) throw new AdapterError("adapter_unavailable", `${row.display_name} is registered but its adapter is not installed`, { provider });
  if (adapter.providerKey !== provider || adapterProblems(adapter).length) {
    throw new AdapterError("adapter_unavailable", `${row.display_name} adapter is not usable`, { provider });
  }
  return { adapter, row, operations: effectiveOperations(adapter, row) };
}

/** Run-time capability gate used by shared services before any optional operation. Throws CapabilityError (501, unsupported_operation). */
export function requireResolvedOperation(r: ResolvedAdapter, op: AdapterOperation): void {
  requireOperation(r.adapter, op);
  if (!r.operations.includes(op)) {
    // implemented in code but switched off in the registry: same normalised answer
    requireOperation({ ...r.adapter, operations: [] } as EmailAdapter, op);
  }
}

/** Provider capabilities a browser may be told about (names only; no secrets, no adapter internals). */
export function publicCapabilities(r: ResolvedAdapter): { provider: string; display_name: string; operations: AdapterOperation[] } {
  return { provider: r.row.provider_key, display_name: r.row.display_name, operations: [...r.operations] };
}
