// Thin server-side Paystack client. The secret key only ever lives in this process:
// it is passed in by the caller, sent as a Bearer header, and never logged or returned.
import { type SandboxConfig } from "./paystack_core.ts";

const API = "https://api.paystack.co";

export type PaystackResult = { ok: boolean; httpStatus: number; body: any; networkError?: string };

export async function paystackFetch(cfg: Extract<SandboxConfig, { ok: true }>, path: string, init: { method?: string; body?: unknown } = {}): Promise<PaystackResult> {
  // Defence in depth: this module can only talk to Paystack's API host, and only with a test key.
  if (!/^sk_test_/.test(cfg.secretKey)) return { ok: false, httpStatus: 0, body: null, networkError: "Refusing to call Paystack without a test key." };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${API}${path}`, {
      method: init.method || "GET",
      headers: { Authorization: `Bearer ${cfg.secretKey}`, "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: ctrl.signal,
    });
    let body: any = null;
    try { body = await res.json(); } catch { body = null; }
    return { ok: res.ok, httpStatus: res.status, body };
  } catch (e) {
    return { ok: false, httpStatus: 0, body: null, networkError: e instanceof Error ? e.message : "Network error" };
  } finally {
    clearTimeout(timer);
  }
}

// Message that is safe to show a user (Paystack's own message, or a generic one).
export function paystackMessage(r: PaystackResult): string {
  if (r.networkError) return "Could not reach Paystack. Try again in a moment.";
  const m = r.body?.message;
  return typeof m === "string" && m ? m.slice(0, 200) : `Paystack returned HTTP ${r.httpStatus}.`;
}
