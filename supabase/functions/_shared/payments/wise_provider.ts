// Wise Embedded Solutions: FIRST and PRIMARY provider. PLACEHOLDER ONLY.
//
// Wise Embedded Solutions / Embedded Flows is NOT a plain card-checkout API. The customer pays
// through a Wise-provided embedded or hosted flow, so the capabilities below describe a flow
// ("embedded"), not a card form. The real implementation must follow Wise's Embedded Solutions
// documentation and onboarding for this account. Open questions to answer from that
// documentation before writing any call (deliberately NOT guessed here):
//   - which currencies / payer countries / payment methods the flow supports for our account
//   - how a payment is confirmed (webhook event names, signature scheme, status lookup)
//   - sandbox vs live credentials and how they are scoped
//   - refund and reconciliation endpoints, if any
import { PlaceholderProvider, type ProviderCapabilities } from "./provider.ts";

export class WiseProvider extends PlaceholderProvider {
  readonly capabilities: ProviderCapabilities = {
    id: "wise",
    displayName: "Wise",
    flow: "embedded",
    supportedCurrencies: null,   // unknown until confirmed with Wise
    supportsRefunds: false,      // unknown until confirmed with Wise
    supportsWebhooks: true,
    implemented: false,
  };
}
