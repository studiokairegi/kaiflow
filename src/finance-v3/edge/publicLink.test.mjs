import test from "node:test";
import assert from "node:assert/strict";
import { handleFinancePublic } from "../../../supabase/functions/_shared/finance_v3_public.ts";

const TOKEN = "c".repeat(64), HASH = "h(" + TOKEN + ")";
const LINK = { kind: "pay", organization_id: "11111111-1111-4111-8111-111111111111", invoice_id: "22222222-2222-4222-8222-222222222222", invoice_no: "INV-000001", status: "issued", currency: "KES", total: "254.39", outstanding: "154.39", due_date: "2026-12-07", payable: true,
  snapshot: { invoice_no: "INV-000001", currency: "KES", issue_date: "2026-11-23", due_date: "2026-12-07", studio: { name: "Studio" }, client: { name: "Acme <b>x</b>" }, lines: [{ description: "Work <script>", quantity: "1", unit_price: "154.39", net_amount: "154.39" }], payment_instructions: "Bank 123" } };

function deps(over = {}) {
  const calls = []; const docs = new Map();
  const d = {
    rpc: async (n, a) => { calls.push([n, a]); if (n === "fin3svc_resolve_link") return a.p_token_hash === HASH ? (over.link === undefined ? LINK : over.link) : null;
      if (n === "fin3svc_get_document") return docs.get(a.p_entity) || null; if (n === "fin3svc_get_snapshot") return LINK.snapshot;
      if (n === "fin3svc_store_document") { docs.set(a.p_entity, { id: "d", sha256: "f".repeat(64), bytes: 9, content_base64: a.p_content_base64 }); return docs.get(a.p_entity); } throw new Error("unexpected " + n); },
    rpcRaw: async (n, a) => { calls.push([n, a]);
      if (n === "fin3svc_prepare_intent") return over.prepare ?? { data: { intent_id: "i1", reference: "KRL3-T-ABCDEFGHJKLM-ABCD", charge_amount_minor: "15439", currency: "KES", customer_email: "pay@acme.test", authorization_url: null }, error: null };
      if (n === "fin3svc_intent_initialized") return { data: null, error: null }; throw new Error("unexpected " + n); },
    paystack: over.paystack ?? { ok: true, environment: "test", initialize: async (b) => { calls.push(["init", b]); return { ok: true, httpStatus: 200, body: { status: true, data: { authorization_url: "https://checkout.paystack.test/z" } } }; } },
    publicUrl: () => "https://x.test/functions/v1/finance-public", sha256Hex: async (s) => "h(" + s + ")", rateLimit: over.rateLimit,
  };
  return { d, calls };
}
const get = (q) => new Request(`https://x.test/p?${q}`, { method: "GET" });
const post = (q) => new Request(`https://x.test/p?${q}`, { method: "POST" });

test("anything wrong with a token yields the same 404 page (no probing): malformed, unknown, expired/void", async () => {
  const { d } = deps({ link: null });
  for (const q of ["", "t=abc", `t=${"d".repeat(64)}`, `t=${TOKEN}`]) {
    const r = await handleFinancePublic(get(q), d);
    assert.equal(r.status, 404); assert.match(await r.text(), /not valid or has expired/);
  }
});

test("the invoice page escapes everything, shows the live balance, sets no-store and a locked-down CSP", async () => {
  const { d } = deps();
  const r = await handleFinancePublic(get(`t=${TOKEN}`), d);
  const t = await r.text();
  assert.equal(r.status, 200);
  assert.ok(!t.includes("<script>") && !t.includes("<b>x</b>"));
  assert.match(t, /Acme &lt;b&gt;x&lt;\/b&gt;/); assert.match(t, /Outstanding KES 154\.39/); assert.match(t, /Pay KES 154\.39 now/);
  assert.equal(r.headers.get("cache-control"), "no-store"); assert.match(r.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
});

test("POST creates the attempt from the DATABASE amount, initializes Paystack and redirects; no amount is read from the request", async () => {
  const { d, calls } = deps();
  const req = new Request(`https://x.test/p?t=${TOKEN}&amount=1`, { method: "POST", body: "amount=1&currency=USD", headers: { "content-type": "application/x-www-form-urlencoded" } });
  const r = await handleFinancePublic(req, d);
  assert.equal(r.status, 303); assert.equal(r.headers.get("location"), "https://checkout.paystack.test/z");
  const init = calls.find((c) => c[0] === "init")[1];
  assert.equal(init.amount, 15439); assert.equal(init.currency, "KES"); assert.equal(init.email, "pay@acme.test");
  assert.equal(calls.find((c) => c[0] === "fin3svc_prepare_intent")[1].p_environment, "test");
  assert.ok(init.callback_url.includes(`t=${TOKEN}&paid=1`));
});

test("business refusals from the database are shown as plain messages, never as raw errors", async () => {
  for (const [code, text] of [["V3017", /nothing left to pay/], ["V3019", /not available right now/], ["V3018", /email address/]]) {
    const { d } = deps({ prepare: { data: null, error: { message: "internal detail", code } } });
    const r = await handleFinancePublic(post(`t=${TOKEN}`), d);
    const t = await r.text();
    assert.equal(r.status, 409); assert.match(t, text); assert.ok(!t.includes("internal detail"));
  }
});

test("a view-only link cannot start a payment; with Paystack not configured the page says so", async () => {
  let { d } = deps({ link: { ...LINK, kind: "view" } });
  assert.equal((await handleFinancePublic(post(`t=${TOKEN}`), d)).status, 404);
  ({ d } = deps({ paystack: { ok: false } }));
  assert.equal((await handleFinancePublic(post(`t=${TOKEN}`), d)).status, 503);
  const page = await (await handleFinancePublic(get(`t=${TOKEN}`), d)).text();
  assert.ok(!/Pay KES/.test(page));
});

test("a provider failure keeps the attempt retryable and exposes no provider detail", async () => {
  const { d } = deps({ paystack: { ok: true, environment: "test", initialize: async () => ({ ok: false, httpStatus: 500, body: { message: "secret provider internals" } }) } });
  const r = await handleFinancePublic(post(`t=${TOKEN}`), d);
  assert.equal(r.status, 502); assert.ok(!(await r.text()).includes("secret provider internals"));
});

test("PDF download goes through the stored document and is served as an attachment", async () => {
  const { d, calls } = deps();
  const r = await handleFinancePublic(get(`t=${TOKEN}&pdf=1`), d);
  assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "application/pdf");
  assert.match(r.headers.get("content-disposition"), /attachment; filename="Invoice-INV-000001\.pdf"/);
  assert.ok(calls.some((c) => c[0] === "fin3svc_store_document"));
});

test("rate limiting and method restrictions", async () => {
  let { d } = deps({ rateLimit: () => false });
  assert.equal((await handleFinancePublic(get(`t=${TOKEN}`), d)).status, 429);
  ({ d } = deps());
  assert.equal((await handleFinancePublic(new Request(`https://x.test/p?t=${TOKEN}`, { method: "DELETE" }), d)).status, 405);
});
