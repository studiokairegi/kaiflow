// Provider-neutral payment contract. NOTHING here talks to a payment provider.
//
//   Invoice -> Checkout Session -> PaymentProvider -> Payment Transaction -> Invoice Payment -> Ledger
//
// Every provider (Wise, Paystack, PayPal, Payoneer, M-Pesa) implements PaymentProvider. The
// checkout page and the Payments UI only ever see these neutral types, never a provider's own
// objects. Pure TypeScript with no Deno/Node globals, so it is unit-tested under `node --test`.

export const PROVIDER_IDS = ["wise", "paystack", "paypal", "payoneer", "mpesa"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export type ProviderStatus = "coming_soon" | "not_connected" | "connected" | "error";

export type TransactionStatus =
  | "initiated" | "pending" | "succeeded" | "failed" | "cancelled" | "refunded" | "partially_refunded";

// Static facts about a provider, independent of any user's configuration.
export interface ProviderCapabilities {
  id: ProviderId;
  displayName: string;
  // How the customer pays: a provider-hosted page, an embedded flow on our page, or a redirect.
  flow: "embedded" | "hosted_redirect" | "none";
  // null = not decided/unknown yet. Do NOT guess: fill in from the provider's documentation.
  supportedCurrencies: readonly string[] | null;
  supportsRefunds: boolean;
  supportsWebhooks: boolean;
  // false until the real integration exists. An unimplemented provider is never offered to clients.
  implemented: boolean;
}

// A user's configuration of a provider (one row of payment_providers).
export interface ProviderConfig {
  provider: ProviderId;
  status: ProviderStatus;
  isEnabled: boolean;
  isPrimary: boolean;
}

// What the checkout page is allowed to know about the thing being paid.
export interface CheckoutRequest {
  sessionId: string;
  invoiceNumber: string;
  amount: number;      // decimal major units, derived server-side from the invoice
  currency: string;    // ISO 4217
  returnUrl: string;
}

export type CheckoutInstruction =
  | { kind: "redirect"; url: string; providerReference: string }
  | { kind: "embedded"; providerReference: string; clientConfig: Record<string, unknown> };

export interface CheckoutStatus {
  status: TransactionStatus;
  providerReference: string;
  amount: number;
  currency: string;
  feeAmount: number | null;
  paidAt: string | null;
}

export interface WebhookResult {
  eventKey: string;                 // stable de-duplication key
  eventType: string;
  providerReference: string | null;
  handled: boolean;
}

// Everything a provider must be able to do. Do not implement all of it up front: an adapter may
// throw ProviderNotImplementedError for operations it cannot do yet.
export interface PaymentProvider {
  readonly capabilities: ProviderCapabilities;
  createCheckout(req: CheckoutRequest): Promise<CheckoutInstruction>;
  getCheckoutStatus(providerReference: string): Promise<CheckoutStatus>;
  // Must authenticate the event (signature etc.) BEFORE trusting any field of it.
  handleWebhook(rawBody: string, headers: Record<string, string | undefined>): Promise<WebhookResult>;
  // Server-to-server confirmation. Success is decided here, never by a browser redirect.
  verifyPayment(providerReference: string, expected: { amount: number; currency: string }): Promise<CheckoutStatus>;
  refundPayment(providerReference: string, amount: number): Promise<{ providerRefundReference: string }>;
  reconcilePayment(providerReference: string): Promise<CheckoutStatus>;
}

export class ProviderNotImplementedError extends Error {
  readonly provider: ProviderId;
  readonly operation: string;
  constructor(provider: ProviderId, operation: string) {
    super(`${provider}.${operation} is not implemented yet.`);
    this.name = "ProviderNotImplementedError";
    this.provider = provider;
    this.operation = operation;
  }
}

// Base class for adapters that exist only as a placeholder. Every operation throws, so a
// half-wired provider cannot silently "succeed".
export abstract class PlaceholderProvider implements PaymentProvider {
  abstract readonly capabilities: ProviderCapabilities;
  private nope(op: string): never { throw new ProviderNotImplementedError(this.capabilities.id, op); }
  createCheckout(_req: CheckoutRequest): Promise<CheckoutInstruction> { return this.nope("createCheckout"); }
  getCheckoutStatus(_ref: string): Promise<CheckoutStatus> { return this.nope("getCheckoutStatus"); }
  handleWebhook(_raw: string, _h: Record<string, string | undefined>): Promise<WebhookResult> { return this.nope("handleWebhook"); }
  verifyPayment(_ref: string, _e: { amount: number; currency: string }): Promise<CheckoutStatus> { return this.nope("verifyPayment"); }
  refundPayment(_ref: string, _amount: number): Promise<{ providerRefundReference: string }> { return this.nope("refundPayment"); }
  reconcilePayment(_ref: string): Promise<CheckoutStatus> { return this.nope("reconcilePayment"); }
}
