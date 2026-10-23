// Pure, dependency-free Paystack helpers shared by the Payments Edge Functions.
// No Deno or Node globals beyond Web Crypto, so the same file is unit-tested under
// `node --test` (see src/payments/payments.test.mjs).
//
// TEST and LIVE are kept apart structurally:
//   * the active environment comes from the server secret PAYSTACK_MODE ("test" | "live");
//     nothing the browser sends can change it;
//   * the secret key's prefix must match that environment (sk_test_ for test, sk_live_ for live),
//     otherwise payments stay disabled and the key is never echoed;
//   * every transaction row is tagged with its environment and a verification made in one
//     environment can never settle a row from the other (enforced here AND in SQL);
//   * the webhook decides the environment from WHICH key produced the signature, so a live
//     event is never verified with a test key or the reverse.

export type PaystackEnvironment = "test" | "live";

// Currencies Paystack can collect in principle. Whether THIS merchant account can collect a
// currency or channel is configuration (payment_providers.settings), not an assumption made here.
export const PAYSTACK_CURRENCIES = ["NGN", "GHS", "ZAR", "KES", "USD"] as const;
export const PAYSTACK_CHANNELS = ["card", "bank_transfer"] as const;
export type PaystackChannel = (typeof PAYSTACK_CHANNELS)[number];

export type EnvReader = { get(key: string): string | undefined };

export type ConfigErrorCode = "mode_not_set" | "missing_secret_key" | "key_mode_mismatch" | "invalid_key_format" | "app_url_required";

export type PaystackConfig =
  | { ok: true; secretKey: string; environment: PaystackEnvironment; appUrl: string }
  | { ok: false; code: ConfigErrorCode; message: string };

const KEY_RE: Record<PaystackEnvironment, RegExp> = {
  test: /^sk_test_[A-Za-z0-9]{8,}$/,
  live: /^sk_live_[A-Za-z0-9]{8,}$/,
};

export type KeyRing = { test?: string; live?: string; invalid: boolean };

// Collects every configured secret key, sorted by its prefix. PAYSTACK_SECRET_KEY (single key) is
// accepted and filed under whichever environment its prefix says.
export function loadKeyRing(env: EnvReader): KeyRing {
  const ring: KeyRing = { invalid: false };
  const candidates = [env.get("PAYSTACK_TEST_SECRET_KEY"), env.get("PAYSTACK_LIVE_SECRET_KEY"), env.get("PAYSTACK_SECRET_KEY")];
  for (const raw of candidates) {
    const key = (raw || "").trim();
    if (!key) continue;
    if (KEY_RE["test"].test(key)) ring.test = key;
    else if (KEY_RE["live"].test(key)) ring.live = key;
    else ring.invalid = true;
  }
  return ring;
}

export function activeMode(env: EnvReader): PaystackEnvironment | null {
  const raw = (env.get("PAYSTACK_MODE") || "").trim().toLowerCase();
  if (raw === "test" || raw === "live") return raw;
  // Legacy sandbox switch from the first version of this module.
  if ((env.get("PAYMENTS_MODE") || "").trim() === "sandbox") return "test";
  return null;
}

// Decides whether payment OPERATIONS (start a checkout, verify) may run, and with which key.
// Never returns a secret inside an error, and never falls back from one environment to the other.
export function resolvePaystackConfig(env: EnvReader): PaystackConfig {
  const mode = activeMode(env);
  if (!mode) {
    return { ok: false, code: "mode_not_set", message: 'Payments are disabled. Set the server secret PAYSTACK_MODE to "test" or "live".' };
  }
  const ring = loadKeyRing(env);
  const key = ring[mode];
  if (!key) {
    if (ring.invalid) return { ok: false, code: "invalid_key_format", message: "A configured Paystack secret key is not in the expected sk_test_… / sk_live_… format." };
    if (ring.test || ring.live) {
      return { ok: false, code: "key_mode_mismatch", message: `PAYSTACK_MODE is "${mode}" but only a ${mode === "live" ? "test" : "live"} key is configured. Payments stay disabled.` };
    }
    return { ok: false, code: "missing_secret_key", message: `No Paystack ${mode} secret key is configured on the server.` };
  }
  const appUrl = (env.get("APP_URL") || "").trim().replace(/\/+$/, "");
  if (mode === "live" && !/^https:\/\//.test(appUrl)) {
    return { ok: false, code: "app_url_required", message: "APP_URL must be set to the https:// address of Kairil before live payments can start." };
  }
  return { ok: true, secretKey: key, environment: mode, appUrl };
}

// Webhook: the environment is whichever configured key reproduces the signature. A request signed
// with neither key is rejected. Constant-time comparison; nothing about the keys is returned.
export async function identifyWebhookEnvironment(
  ring: KeyRing, rawBody: string, signatureHeader: string | null | undefined,
): Promise<{ environment: PaystackEnvironment; secretKey: string } | null> {
  for (const environment of ["live", "test"] as const) {
    const key = ring[environment];
    if (key && (await verifyWebhookSignature(key, rawBody, signatureHeader))) return { environment, secretKey: key };
  }
  return null;
}

// Paystack hosted-checkout channels for a request. Card -> card only; bank transfer -> bank_transfer only.
export function channelsFor(channel: string): PaystackChannel[] | null {
  if (channel === "card") return ["card"];
  if (channel === "bank_transfer") return ["bank_transfer"];
  return null;
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
export type Expected = { reference: string; amountMinor: number; currency: string; environment: PaystackEnvironment };

export type VerifyOutcome =
  | { kind: "success"; feeMinor: number | null; channel: string; paystackId: string; paidAt: string | null; gateway: string }
  | { kind: "failed" | "abandoned" | "pending" | "reversed"; gateway: string }
  | { kind: "rejected"; reason: string };

export function interpretVerification(resp: any, expected: Expected): VerifyOutcome {
  const d = resp?.data;
  if (!resp || resp.status !== true || !d) return { kind: "rejected", reason: "Paystack did not return a verified transaction." };
  // Paystack labels every transaction with its domain. A live key must only ever confirm live
  // transactions and a test key test ones; a missing domain is not accepted for live money.
  const domain = String(d.domain || "").toLowerCase();
  if (domain ? domain !== expected.environment : expected.environment === "live") {
    return { kind: "rejected", reason: `Transaction domain does not match the ${expected.environment} environment. Refusing to process it.` };
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
