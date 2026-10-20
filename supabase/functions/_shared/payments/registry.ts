// Provider registry + the ONLY place that decides which payment methods a client sees.
// The public checkout page calls availablePaymentMethods(); it contains no provider-specific logic.
import { PROVIDER_IDS, type PaymentProvider, type ProviderConfig, type ProviderId } from "./provider.ts";
import { WiseProvider } from "./wise_provider.ts";
import { MpesaProvider, PayPalProvider, PayoneerProvider, PaystackProvider } from "./placeholder_providers.ts";

const REGISTRY: Record<ProviderId, PaymentProvider> = {
  wise: new WiseProvider(),
  paystack: new PaystackProvider(),
  paypal: new PayPalProvider(),
  payoneer: new PayoneerProvider(),
  mpesa: new MpesaProvider(),
};

export function getProvider(id: string): PaymentProvider | null {
  return (PROVIDER_IDS as readonly string[]).includes(id) ? REGISTRY[id as ProviderId] : null;
}
export function allProviders(): PaymentProvider[] { return PROVIDER_IDS.map((id) => REGISTRY[id]); }

export interface PaymentMethod { provider: ProviderId; name: string; primary: boolean; flow: string }

// A provider is offered only if ALL hold: it is implemented in code, the admin enabled it, it is
// connected, and it can take this currency (unknown currency support = no restriction, since the
// real check happens when the provider is implemented). Primary first, then alphabetical.
export function availablePaymentMethods(configs: ProviderConfig[], currency: string): PaymentMethod[] {
  const ccy = String(currency || "").toUpperCase();
  const out: PaymentMethod[] = [];
  for (const c of configs) {
    const p = getProvider(c.provider);
    if (!p || !p.capabilities.implemented) continue;
    if (!c.isEnabled || c.status !== "connected") continue;
    const list = p.capabilities.supportedCurrencies;
    if (list && !list.includes(ccy)) continue;
    out.push({ provider: p.capabilities.id, name: p.capabilities.displayName, primary: c.isPrimary, flow: p.capabilities.flow });
  }
  return out.sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
}
