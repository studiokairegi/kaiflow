// finance-public: hosted invoice page, PDF download and "Pay now" for a Finance V3 secure link (?t=<token>).
// Deploy with --no-verify-jwt (clients open this from an email without a Supabase session). The 256-bit token is the credential.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { handleFinancePublic } from "../_shared/finance_v3_public.ts";
import { resolvePaystackConfig } from "../_shared/paystack_core.ts";
import { paystackFetch } from "../_shared/paystack_api.ts";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

// Best-effort per-isolate limiter (Edge isolates are short-lived; this only blunts casual abuse. Put a CDN/WAF rule in front for more).
const hits = new Map<string, number[]>();
const rateLimit = (key: string) => {
  const now = Date.now(), win = 5 * 60_000, max = key.endsWith(":POST") ? 20 : 120;
  const arr = (hits.get(key) || []).filter((t) => now - t < win);
  if (arr.length >= max) { hits.set(key, arr); return false; }
  arr.push(now); hits.set(key, arr);
  if (hits.size > 5000) hits.clear();
  return true;
};

const sha256Hex = async (s: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, "0")).join("");

Deno.serve((req) => {
  const cfg = resolvePaystackConfig(Deno.env);
  return handleFinancePublic(req, {
    rpc: async (name, args) => { const r = await service.rpc(name, args); if (r.error) throw new Error(`${name}: ${r.error.message}`); return r.data; },
    rpcRaw: async (name, args) => { const r = await service.rpc(name, args); return { data: r.data, error: r.error ? { message: r.error.message, code: (r.error as any).code } : null }; },
    paystack: cfg.ok
      ? { ok: true, environment: cfg.environment, initialize: (body) => paystackFetch(cfg, "/transaction/initialize", { method: "POST", body }) }
      : { ok: false },
    publicUrl: (r) => (Deno.env.get("FINANCE_PUBLIC_BASE_URL") || `${new URL(r.url).origin}${new URL(r.url).pathname}`).replace(/\/+$/, ""),
    sha256Hex, rateLimit,
  });
});
