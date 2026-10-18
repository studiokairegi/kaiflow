// Pure, dependency-free Paystack helpers shared by the Payments Edge Functions.
// No Deno or Node globals beyond Web Crypto, so the same file is unit-tested under
// `node --test` (see src/payments/payments.test.mjs).
//
// SANDBOX ONLY. Nothing in here can be configured to touch live money:
//   * the secret key must be an `sk_test_...` key AND PAYMENTS_MODE must be the
//     literal string "sandbox" (a server-side secret, never a client flag);
//   * `sk_live_...` keys are rejected without ever being echoed or used;
//   * any provider response that says it belongs to the live domain is rejected.

export const SANDBOX_MODE = "sandbox";

// Currencies Paystack can collect. Anything else (EUR, GBP, JPY, ...) is refused
// up front instead of being sent to Paystack and failing later.
export const PAYSTACK_CURRENCIES = ["NGN", "GHS", "ZAR", "KES", "USD"] as const;

export type EnvReader = { get(key: string): string | undefined };

export type SandboxConfig =
  | { ok: true; secretKey: string; mode: "sandbox"; appUrl: string }
  | { ok: false; code: ConfigErrorCode; message: string };

export type ConfigErrorCode =
  | "payments_mode_not_sandbox"
  | "missing_secret_key"
  | "live_key_rejected"
  | "invalid_key_format";

// Decides whether payment operations may run at all. Never returns the secret
// inside an error, and never falls back from sandbox to anything else.
export function resolveSandboxConfig(env: EnvReader): SandboxConfig {
  const mode = (env.get("PAYMENTS_MODE") || "").trim();
  if (mode !== SANDBOX_MODE) {
    return {
      ok: false,
      code: "payments_mode_not_sandbox",
      message: 'Payments are disabled. Set the server secret PAYMENTS_MODE to "sandbox" to enable Paystack test mode.',
    };
  }
  const key = (env.get("PAYSTACK_SECRET_KEY") || "").trim();
  if (!key) {
    return { ok: false, code: "missing_secret_key", message: "PAYSTACK_SECRET_KEY is not set. Add your Paystack TEST secret key (sk_test_...) as a server secret." };
  }
  if (/^sk_live_/i.test(key)) {
    return {
      ok: false,
      code: "live_key_rejected",
      message: "A live Paystack key is configured. Payments stay disabled: this module only runs against test keys. Replace it with an sk_test_ key.",
    };
  }
  if (!/^sk_test_[A-Za-z0-9]{8,}$/.test(key)) {
    return { ok: false, code: "invalid_key_format", message: "PAYSTACK_SECRET_KEY is not a valid Paystack test secret key (expected sk_test_...)." };
  }
  return { ok: true, secretKey: key, mode: "sandbox", appUrl: (env.get("APP_URL") || "").trim().replace(/\/+$/, "") };
}

// ---------------------------------------------------------------------------
// Amounts. Paystack works in the smallest currency unit (kobo, pesewas, cents).
// ---------------------------------------------------------------------------
export function toMinor(amount: number | string): number {
  const n = Number(amount);
  if (!Number.isFinite(n)) throw new Error("Invalid amount");
  return Math.round(n * 100 + Number.EPSILON * Math.sign(n));
}

export function fromMinor(minor: number | string | null | undefined): number {
  const n = Number(minor);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n) / 100;
}

export function isSupportedCurrency(code: string): boolean {
  return (PAYSTACK_CURRENCIES as readonly string[]).includes(code);
}

export function isValidEmail(s: unknown): boolean {
  return typeof s === "string" && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}

// ---------------------------------------------------------------------------
// Webhook signature: HMAC-SHA512 (hex) of the RAW body, keyed with the secret key,
// sent as `x-paystack-signature`. Compared in constant time.
// ---------------------------------------------------------------------------
const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha512Hex(secret: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(rawBody)));
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyWebhookSignature(secret: string, rawBody: string, signatureHeader: string | null | undefined): Promise<boolean> {
  const sig = (signatureHeader || "").trim().toLowerCase();
  if (!secret || !sig) return false;
  const expected = await hmacSha512Hex(secret, rawBody);
  return constantTimeEqual(expected, sig);
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

// Stable de-duplication key for an event so retries collapse into one record.
export async function webhookEventKey(rawBody: string, parsed: any): Promise<string> {
  const event = String(parsed?.event || "unknown");
  const id = parsed?.data?.id;
  const ref = parsed?.data?.reference || parsed?.data?.transaction_reference;
  if (id !== undefined && id !== null) return `${event}:${id}`;
  if (ref) return `${event}:${ref}`;
  return `${event}:sha256:${await sha256Hex(rawBody)}`;
}

// ---------------------------------------------------------------------------
// Validation of a verify-transaction response against what WE stored.
// Never trusts anything the browser sent: expected values come from our own row.
// ---------------------------------------------------------------------------
export type Expected = { reference: string; amountMinor: number; currency: string };

export type VerifyOutcome =
  | { kind: "success"; feeMinor: number | null; channel: string; paystackId: string; paidAt: string | null; gateway: string }
  | { kind: "failed" | "abandoned" | "pending" | "reversed"; gateway: string }
  | { kind: "rejected"; reason: string };

export function interpretVerification(resp: any, expected: Expected): VerifyOutcome {
  const d = resp?.data;
  if (!resp || resp.status !== true || !d) return { kind: "rejected", reason: "Paystack did not return a verified transaction." };
  if (d.domain && String(d.domain).toLowerCase() !== "test") {
    return { kind: "rejected", reason: "Transaction belongs to a non-test Paystack domain. Refusing to process it." };
  }
  if (String(d.reference || "") !== expected.reference) return { kind: "rejected", reason: "Reference mismatch." };
  const gateway = String(d.gateway_response || "");
  const status = String(d.status || "").toLowerCase();
  if (status === "success") {
    if (String(d.currency || "").toUpperCase() !== expected.currency) return { kind: "rejected", reason: "Currency mismatch." };
    if (Number(d.amount) !== expected.amountMinor) return { kind: "rejected", reason: "Amount mismatch." };
    const fee = d.fees === undefined || d.fees === null ? null : Number(d.fees);
    return {
      kind: "success",
      feeMinor: fee !== null && Number.isFinite(fee) && fee >= 0 ? Math.round(fee) : null,
      channel: String(d.channel || ""),
      paystackId: String(d.id ?? ""),
      paidAt: d.paid_at ? String(d.paid_at) : null,
      gateway,
    };
  }
  if (status === "failed") return { kind: "failed", gateway };
  if (status === "abandoned") return { kind: "abandoned", gateway };
  if (status === "reversed") return { kind: "reversed", gateway };
  // ongoing / pending / processing / queued: customer still has to act.
  return { kind: "pending", gateway };
}

// Only these webhook events are acted on; everything else is stored and ignored.
export const HANDLED_EVENTS = ["charge.success", "refund.processed", "refund.failed", "refund.pending", "refund.processing"] as const;
export function isHandledEvent(event: string): boolean {
  return (HANDLED_EVENTS as readonly string[]).includes(event);
}
