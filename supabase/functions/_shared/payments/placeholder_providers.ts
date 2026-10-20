// Future providers. Descriptors only: each is "Coming Soon" and can never be offered at checkout.
// Paystack has a sandbox implementation in ../paystack_*.ts (admin-only, test mode); it is NOT
// registered as a checkout provider until it is wrapped in a PaymentProvider adapter.
import { PlaceholderProvider, type ProviderCapabilities } from "./provider.ts";

const base = { supportedCurrencies: null, supportsRefunds: false, supportsWebhooks: true, implemented: false } as const;

export class PaystackProvider extends PlaceholderProvider {
  readonly capabilities: ProviderCapabilities = { ...base, id: "paystack", displayName: "Paystack", flow: "hosted_redirect" };
}
export class PayPalProvider extends PlaceholderProvider {
  readonly capabilities: ProviderCapabilities = { ...base, id: "paypal", displayName: "PayPal", flow: "hosted_redirect" };
}
export class PayoneerProvider extends PlaceholderProvider {
  readonly capabilities: ProviderCapabilities = { ...base, id: "payoneer", displayName: "Payoneer", flow: "hosted_redirect" };
}
export class MpesaProvider extends PlaceholderProvider {
  readonly capabilities: ProviderCapabilities = { ...base, id: "mpesa", displayName: "M-Pesa", flow: "none" };
}
