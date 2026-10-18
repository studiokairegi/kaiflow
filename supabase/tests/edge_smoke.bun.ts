// Smoke test of the Edge Function handlers under Bun with Deno + supabase-js stubbed.
// Run: bun supabase/tests/edge_smoke.bun.ts   (checks only paths that must not reach the database)
import { plugin } from "bun";
import { createHmac } from "node:crypto";
plugin({ name: "stub-esm", setup(b) {
  b.module("https://esm.sh/@supabase/supabase-js@2.45.0", () => ({ exports: { createClient: () => { throw new Error("database must not be reached in these cases"); } }, loader: "object" }));
} });
const handlers: Record<string, (r: Request) => Promise<Response>> = {};
let env: Record<string, string> = {};
(globalThis as any).Deno = { env: { get: (k: string) => env[k] }, serve: (fn: any) => { (globalThis as any).__h = fn; } };
let fails = 0;
const check = (name: string, ok: boolean) => { console.log(`${ok ? "PASS" : "FAIL"}: ${name}`); if (!ok) fails++; };
for (const name of ["paystack-payments", "paystack-webhook"]) {
  await import(`../functions/${name}/index.ts?${name}`); handlers[name] = (globalThis as any).__h;
}
const post = (name: string, body: string, headers: Record<string, string> = {}) =>
  handlers[name](new Request("http://x/", { method: "POST", body, headers: { "content-type": "application/json", ...headers } }));
const KEY = "sk_test_abcdefghijklmnop1234";

env = {};
let r = await post("paystack-payments", JSON.stringify({ action: "status" }));
check("status: disabled without PAYMENTS_MODE", (await r.json()).ok === false);
r = await post("paystack-payments", JSON.stringify({ action: "init", invoice_id: "x" }));
check("init refused (503) while disabled", r.status === 503);
r = await post("paystack-webhook", "{}", {});
check("webhook refused (503) while disabled", r.status === 503);

env = { PAYMENTS_MODE: "sandbox", PAYSTACK_SECRET_KEY: "sk_live_REALKEY123456" };
r = await post("paystack-payments", JSON.stringify({ action: "verify", reference: "KRL-123456" }));
const live = await r.json();
check("live key: refused (503) and key not echoed", r.status === 503 && live.code === "live_key_rejected" && !JSON.stringify(live).includes("REALKEY"));
r = await post("paystack-webhook", "{}");
check("live key: webhook refused", r.status === 503);

env = { PAYMENTS_MODE: "sandbox", PAYSTACK_SECRET_KEY: KEY };
r = await post("paystack-payments", JSON.stringify({ action: "status" }));
check("status: ok with test key", (await r.json()).ok === true);
const body = JSON.stringify({ event: "charge.success", data: { id: 1, reference: "KRL-1" } });
r = await post("paystack-webhook", body, { "x-paystack-signature": "deadbeef" });
check("webhook: bad signature -> 401, database untouched", r.status === 401);
r = await post("paystack-webhook", body);
check("webhook: missing signature -> 401", r.status === 401);
const wrong = createHmac("sha512", "sk_test_someotherkey12345").update(body).digest("hex");
r = await post("paystack-webhook", body, { "x-paystack-signature": wrong });
check("webhook: signature from another key -> 401", r.status === 401);
r = await handlers["paystack-webhook"](new Request("http://x/", { method: "GET" }));
check("webhook: GET -> 405", r.status === 405);
console.log(fails ? `${fails} FAILED` : "ALL PASSED"); process.exit(fails ? 1 : 0);
