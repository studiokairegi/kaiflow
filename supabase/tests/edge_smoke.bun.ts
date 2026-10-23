// Smoke test of the Edge Function handlers under Bun with Deno + supabase-js stubbed.
// Run: bun supabase/tests/edge_smoke.bun.ts   (checks only paths that must NOT reach the database)
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
for (const name of ["paystack-webhook", "paystack-checkout"]) {
  await import(`../functions/${name}/index.ts?${name}`); handlers[name] = (globalThis as any).__h;
}
const post = (name: string, body: string, headers: Record<string, string> = {}) =>
  handlers[name](new Request("http://x/", { method: "POST", body, headers: { "content-type": "application/json", ...headers } }));
const TEST = "sk_test_abcdefghijklmnop1234";
const LIVE = "sk_live_ABCDEFGHIJKLMNOP1234";
const TOKEN = "a".repeat(64);
const sign = (k: string, b: string) => createHmac("sha512", k).update(b).digest("hex");
const body = JSON.stringify({ event: "charge.success", data: { id: 1, reference: "KRL-1" } });

// ---- webhook, nothing configured
env = {};
let r = await post("paystack-webhook", "{}");
check("webhook: refused (503) while no key is configured", r.status === 503);

// ---- webhook, keys configured: authenticity only
env = { PAYSTACK_TEST_SECRET_KEY: TEST, PAYSTACK_LIVE_SECRET_KEY: LIVE };
r = await post("paystack-webhook", body, { "x-paystack-signature": "deadbeef" });
check("webhook: bad signature -> 401, database untouched", r.status === 401);
r = await post("paystack-webhook", body);
check("webhook: missing signature -> 401", r.status === 401);
r = await post("paystack-webhook", body, { "x-paystack-signature": sign("sk_live_someOtherKey123456", body) });
check("webhook: signature from another key -> 401", r.status === 401);
r = await handlers["paystack-webhook"](new Request("http://x/", { method: "GET" }));
check("webhook: GET -> 405", r.status === 405);
env = { PAYSTACK_TEST_SECRET_KEY: TEST };
r = await post("paystack-webhook", body, { "x-paystack-signature": sign(LIVE, body) });
check("webhook: live-signed request is rejected when no live key is configured", r.status === 401);

// ---- public checkout, before any database access
env = { PAYSTACK_MODE: "live", PAYSTACK_LIVE_SECRET_KEY: LIVE, APP_URL: "https://app.example.com" };
r = await post("paystack-checkout", JSON.stringify({ action: "start", token: "not-a-token", email: "a@b.co", channel: "card" }));
check("checkout: malformed token -> 400", r.status === 400);
env = {};
r = await post("paystack-checkout", JSON.stringify({ action: "start", token: TOKEN, email: "a@b.co", channel: "card" }));
const dis = await r.json();
check("checkout: disabled (503) when PAYSTACK_MODE is unset, no internals leaked", r.status === 503 && !JSON.stringify(dis).includes("PAYSTACK"));
env = { PAYSTACK_MODE: "live", PAYSTACK_TEST_SECRET_KEY: TEST, APP_URL: "https://app.example.com" };
r = await post("paystack-checkout", JSON.stringify({ action: "confirm", token: TOKEN }));
check("checkout: live mode with only a test key stays disabled (503)", r.status === 503);
r = await handlers["paystack-checkout"](new Request("http://x/", { method: "GET" }));
check("checkout: GET -> 405", r.status === 405);

console.log(fails ? `${fails} FAILED` : "ALL PASSED"); process.exit(fails ? 1 : 0);
