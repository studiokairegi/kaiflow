// Runs the REAL supabase/functions/paystack-checkout handler under Node with:
//   - Deno and supabase-js replaced by in-memory fakes (the RPC results are scripted per test), and
//   - Paystack's API replaced by a mocked fetch that records every request.
// It proves the function's own rules: amounts come from the database row, nothing is marked paid
// without matching server-side verification, a timeout is not a failure, and an unresolved attempt
// is verified (never duplicated) before another charge may start. The SQL side (locks, unique
// indexes, ledger posting) is covered by supabase/tests/payments_live.test.sql, which needs Postgres.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "../../supabase/functions");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kairil-fn-"));
fs.cpSync(path.join(root, "_shared"), path.join(tmp, "_shared"), { recursive: true });
fs.mkdirSync(path.join(tmp, "paystack-checkout"));
const stub = "data:text/javascript,export const createClient = (...a) => globalThis.__fake.client(...a);";
fs.writeFileSync(
  path.join(tmp, "paystack-checkout", "index.ts"),
  fs.readFileSync(path.join(root, "paystack-checkout/index.ts"), "utf8").replace("https://esm.sh/@supabase/supabase-js@2.45.0", stub),
);

const TOKEN = "b".repeat(64);
const LIVE = "sk_live_ABCDEFGHIJKLMNOP1234";
const ENV = { PAYSTACK_MODE: "live", PAYSTACK_LIVE_SECRET_KEY: LIVE, APP_URL: "https://app.example.com", SUPABASE_URL: "http://db", SUPABASE_SERVICE_ROLE_KEY: "svc" };

let handler;
globalThis.Deno = { env: { get: (k) => globalThis.__env[k] }, serve: (fn) => { handler = fn; } };
await import(pathToFileURL(path.join(tmp, "paystack-checkout", "index.ts")).href);

// ---- scripted world ---------------------------------------------------------------------------
function world({ prepare = [], status = [], paystack = [], tx = {}, custom = {}, fxPayload = null, fxError = false } = {}) {
  const defaultFxPayload = { result: "success", time_last_update_unix: Math.floor(Date.now() / 1000), rates: { USD: 1, EUR: 0.92, GBP: 0.79, JPY: 150, KES: 129 } };
  const w = { rpcs: [], updates: [], fetches: [], fxFetches: [], prepare: [...prepare], status: [...status], paystack: [...paystack], tx, custom, fxPayload: fxPayload || defaultFxPayload, fxError };
  globalThis.__env = { ...ENV };
  globalThis.__fake = {
    client: () => ({
      rpc: async (name, args) => {
        w.rpcs.push({ name, args });
        if (w.custom[name]) return w.custom[name](args);
        if (name === "payments_checkout_prepare") { const n = w.prepare.shift(); return n?.error ? { data: null, error: { message: n.error, details: n.details } } : { data: [n], error: null }; }
        if (name === "payments_checkout_status") return { data: w.status.length > 1 ? w.status.shift() : w.status[0], error: null };
        if (name === "payments_apply_verification") return { data: { applied: args.p_outcome === "success", status: args.p_outcome }, error: null };
        if (name === "payments_checkout_fx_snapshot_save") return { data: true, error: null };
        return { data: null, error: null };
      },
      from: (table) => {
        const q = { table, _eq: [] };
        q.select = () => q;
        q.update = (v) => { q._update = v; return q; };
        q.eq = (k, v) => { q._eq.push([k, v]); if (q._update) w.updates.push({ table, update: q._update, eq: q._eq }); return q; };
        q.maybeSingle = async () => ({ data: w.tx });
        return q;
      },
    }),
  };
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes("open.er-api.com")) {
      w.fxFetches.push({ url: target, method: init?.method || "GET" });
      if (w.fxError) throw new Error("FX provider unavailable");
      return { ok: true, status: 200, json: async () => w.fxPayload };
    }
    w.fetches.push({ url: target, method: init?.method || "GET", body: init?.body ? JSON.parse(init.body) : null, auth: init?.headers?.Authorization });
    const next = w.paystack.shift();
    if (next === "NETWORK") throw new Error("socket hang up");
    return { ok: next.status < 300, status: next.status, json: async () => next.body };
  };
  return w;
}
const call = (body) => handler(new Request("http://x/", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
const newRow = { action: "new", transaction_id: "tx1", reference: "KRL-L-ABCD1234-0000000001", amount: 1500.5, currency: "KES", authorization_url: null, invoice_number: "INV-7" };
const initOk = { status: 200, body: { status: true, data: { authorization_url: "https://checkout.paystack.com/abc123", access_code: "ac" } } };
const verifyBody = (o = {}) => ({ status: 200, body: { status: true, data: { status: "success", reference: newRow.reference, amount: 150050, currency: "KES", fees: 2300, channel: "card", id: 99, paid_at: "2026-10-24T10:00:00Z", gateway_response: "Successful", domain: "live", ...o } } });
const oldTx = (ageMin) => ({ id: "tx1", reference: newRow.reference, amount: 1500.5, currency: "KES", status: "initialized", created_at: new Date(Date.now() - ageMin * 60000).toISOString() });
const applied = (w) => w.rpcs.filter((r) => r.name === "payments_apply_verification");

test("start: amount, currency and reference come from the database row; browser values are ignored", async () => {
  const w = world({ prepare: [newRow], paystack: [initOk] });
  const res = await call({ action: "start", token: TOKEN, email: "Client@Example.com", channel: "card", amount: 1, currency: "USD", invoice_id: "evil", environment: "test" });
  const out = await res.json();
  assert.equal(res.status, 200); assert.equal(out.status, "redirect"); assert.equal(out.authorization_url, "https://checkout.paystack.com/abc123");
  const init = w.fetches[0];
  assert.equal(init.url, "https://api.paystack.co/transaction/initialize");
  assert.equal(init.auth, `Bearer ${LIVE}`);
  assert.equal(init.body.amount, 150050); assert.equal(init.body.currency, "KES"); assert.equal(init.body.reference, newRow.reference);
  assert.deepEqual(init.body.channels, ["card"]);
  assert.equal(init.body.callback_url, `https://app.example.com/pay/${TOKEN}/return`);
  assert.equal(init.body.email, "client@example.com");
  assert.equal(init.body.metadata.kairil_environment, "live");
  const prep = w.rpcs.find((r) => r.name === "payments_checkout_prepare").args;
  assert.deepEqual(Object.keys(prep).sort(), ["p_channel", "p_email", "p_environment", "p_quote", "p_token"]);   // a quote id, never an amount/currency/invoice/rate parameter
  assert.equal(prep.p_quote, null);
  assert.equal(prep.p_environment, "live");                                                             // from the server secret, not the request
});

test("start: bank transfer asks Paystack for the bank_transfer channel only; PayPal/Payoneer are refused before any call", async () => {
  let w = world({ prepare: [newRow], paystack: [initOk] });
  await call({ action: "start", token: TOKEN, email: "a@b.co", channel: "bank_transfer" });
  assert.deepEqual(w.fetches[0].body.channels, ["bank_transfer"]);
  w = world({ prepare: [newRow], paystack: [initOk] });
  await call({ action: "start", token: TOKEN, email: "a@b.co", channel: "apple_pay" });
  assert.deepEqual(w.fetches[0].body.channels, ["apple_pay"]);
  for (const channel of ["paypal", "payoneer", ""]) {
    w = world({});
    const res = await call({ action: "start", token: TOKEN, email: "a@b.co", channel });
    assert.equal(res.status, 400); assert.equal(w.fetches.length, 0); assert.equal(w.rpcs.length, 0);
  }
});

test("start: Paystack rejects initialisation -> attempt closed as failed, nothing marked paid", async () => {
  const w = world({ prepare: [newRow], paystack: [{ status: 400, body: { status: false, message: "Currency not supported by merchant" } }] });
  const res = await call({ action: "start", token: TOKEN, email: "a@b.co", channel: "card" });
  assert.equal(res.status, 502);
  assert.ok(w.updates.some((u) => u.update.status === "failed" && u.eq.some(([k, v]) => k === "status" && v === "initialized")));
  assert.equal(applied(w).length, 0);
  assert.ok(!JSON.stringify(await res.clone().json()).includes("merchant"));      // provider detail is not leaked to the client
});

test("start: a network timeout is NOT treated as failure; the attempt stays open for verification", async () => {
  const w = world({ prepare: [newRow], paystack: ["NETWORK"] });
  const res = await call({ action: "start", token: TOKEN, email: "a@b.co", channel: "card" });
  assert.equal(res.status, 202); assert.equal((await res.json()).status, "pending");
  assert.equal(w.updates.filter((u) => u.update.status === "failed").length, 0);
});

test("start: an unexpected checkout address from the provider is refused", async () => {
  world({ prepare: [newRow], paystack: [{ status: 200, body: { status: true, data: { authorization_url: "https://evil.example/pay" } } }] });
  const res = await call({ action: "start", token: TOKEN, email: "a@b.co", channel: "card" });
  assert.equal(res.status, 502);
});

test("start: refresh / second click on a recent attempt reuses the same checkout and never calls initialize", async () => {
  const w = world({ prepare: [{ ...newRow, action: "reuse", authorization_url: "https://checkout.paystack.com/abc123" }] });
  const res = await call({ action: "start", token: TOKEN, email: "a@b.co", channel: "card" });
  const out = await res.json();
  assert.equal(out.reused, true); assert.equal(out.authorization_url, "https://checkout.paystack.com/abc123");
  assert.equal(w.fetches.length, 0);
});

test("start: database refusals (expired, already paid, ...) are passed on as 409 without calling Paystack", async () => {
  const w = world({ prepare: [{ error: "This invoice has already been paid." }] });
  const res = await call({ action: "start", token: TOKEN, email: "a@b.co", channel: "card" });
  assert.equal(res.status, 409); assert.match((await res.json()).error, /already been paid/); assert.equal(w.fetches.length, 0);
});

test("start: an unresolved earlier attempt that Paystack says SUCCEEDED is applied; no second charge is started", async () => {
  const w = world({ prepare: [{ ...newRow, action: "verify_first" }], tx: oldTx(45), paystack: [verifyBody()] });
  const res = await call({ action: "start", token: TOKEN, email: "a@b.co", channel: "card" });
  assert.equal((await res.json()).status, "paid");
  assert.equal(w.fetches.length, 1); assert.match(w.fetches[0].url, /\/transaction\/verify\//);
  const a = applied(w); assert.equal(a.length, 1);
  assert.equal(a[0].args.p_outcome, "success"); assert.equal(a[0].args.p_environment, "live"); assert.equal(a[0].args.p_amount_minor, 150050); assert.equal(a[0].args.p_fee_minor, 2300);
  assert.equal(w.rpcs.filter((r) => r.name === "payments_checkout_prepare").length, 1);
});

test("start: a YOUNG unpaid attempt is left open (could still be paid in another tab); no new charge", async () => {
  const w = world({ prepare: [{ ...newRow, action: "verify_first" }], tx: oldTx(3), paystack: [verifyBody({ status: "abandoned" })] });
  const res = await call({ action: "start", token: TOKEN, email: "a@b.co", channel: "bank_transfer" });
  assert.equal(res.status, 202);
  assert.equal(applied(w).length, 0);                         // not even recorded as abandoned
  assert.ok(!w.fetches.some((f) => f.url.endsWith("/transaction/initialize")));
});

test("start: an OLD abandoned attempt is retired, then exactly one fresh attempt is initialised", async () => {
  const fresh = { ...newRow, transaction_id: "tx2", reference: "KRL-L-ABCD1234-0000000002" };
  const w = world({ prepare: [{ ...newRow, action: "verify_first" }, fresh], tx: oldTx(45), paystack: [verifyBody({ status: "abandoned" }), initOk] });
  const res = await call({ action: "start", token: TOKEN, email: "a@b.co", channel: "card" });
  assert.equal((await res.json()).status, "redirect");
  assert.deepEqual(applied(w).map((r) => r.args.p_outcome), ["abandoned"]);
  assert.equal(w.fetches.filter((f) => f.url.endsWith("/transaction/initialize")).length, 1);
  assert.equal(w.fetches.find((f) => f.url.endsWith("/transaction/initialize")).body.reference, fresh.reference);
});

test("start: if Paystack can't be asked about an earlier attempt, nothing new is started", async () => {
  const w = world({ prepare: [{ ...newRow, action: "verify_first" }], tx: oldTx(60), paystack: ["NETWORK"] });
  const res = await call({ action: "start", token: TOKEN, email: "a@b.co", channel: "card" });
  assert.equal(res.status, 202);
  assert.ok(!w.fetches.some((f) => f.url.endsWith("/transaction/initialize"))); assert.equal(applied(w).length, 0);
});

const st = (o) => ({ found: true, environment: "live", session_status: "open", invoice_number: "INV-7", amount: 1500.5, currency: "KES", invoice_paid: false, reference: newRow.reference, transaction_status: "initialized", applied: false, ...o });

test("confirm: the return page proves nothing; success needs matching Paystack verification, then the database confirms it applied", async () => {
  const w = world({ status: [st({}), st({ transaction_status: "success", applied: true, invoice_paid: true })], tx: oldTx(5), paystack: [verifyBody()] });
  const res = await call({ action: "confirm", token: TOKEN, reference: newRow.reference });
  const out = await res.json();
  assert.equal(out.status, "paid");
  assert.equal(applied(w).length, 1); assert.equal(applied(w)[0].args.p_outcome, "success");
  assert.match(w.fetches[0].url, /transaction\/verify\/KRL-L-ABCD1234-0000000001$/);
});

test("confirm: a Paystack amount or currency that differs from OUR row is rejected and never applied", async () => {
  for (const o of [{ amount: 100 }, { currency: "USD" }, { reference: "SOMEONE-ELSES-REF" }, { domain: "test" }]) {
    const w = world({ status: [st({})], tx: oldTx(5), paystack: [verifyBody(o)] });
    const out = await (await call({ action: "confirm", token: TOKEN, reference: newRow.reference })).json();
    assert.equal(out.status, "review", JSON.stringify(o)); assert.equal(applied(w).length, 0);
  }
});

test("confirm: customer came back without paying -> 'incomplete', no money recorded", async () => {
  const w = world({ status: [st({})], tx: oldTx(2), paystack: [verifyBody({ status: "abandoned" })] });
  const out = await (await call({ action: "confirm", token: TOKEN, reference: newRow.reference })).json();
  assert.equal(out.status, "incomplete"); assert.equal(applied(w).length, 0);
});

test("confirm: declined payment is reported as failed and recorded as failed", async () => {
  const w = world({ status: [st({}), st({ transaction_status: "failed" })], tx: oldTx(2), paystack: [verifyBody({ status: "failed", gateway_response: "Declined" })] });
  const out = await (await call({ action: "confirm", token: TOKEN, reference: newRow.reference })).json();
  assert.equal(out.status, "failed"); assert.deepEqual(applied(w).map((r) => r.args.p_outcome), ["failed"]);
});

test("confirm: an already-settled invoice does not call Paystack again", async () => {
  const w = world({ status: [st({ transaction_status: "success", applied: true, invoice_paid: true })] });
  const out = await (await call({ action: "confirm", token: TOKEN, reference: newRow.reference })).json();
  assert.equal(out.status, "paid"); assert.equal(w.fetches.length, 0);
});

test("confirm: a pending bank transfer stays pending (customer is told to wait, not to pay again)", async () => {
  const w = world({ status: [st({})], tx: oldTx(5), paystack: [verifyBody({ status: "ongoing" })] });
  const out = await (await call({ action: "confirm", token: TOKEN, reference: newRow.reference })).json();
  assert.equal(out.status, "pending");
});

test("confirm: an unknown token is 404 and never reaches Paystack", async () => {
  const w = world({ status: [{ found: false }] });
  const res = await call({ action: "confirm", token: TOKEN });
  assert.equal(res.status, 404); assert.equal(w.fetches.length, 0);
});

test("a test-key-only server in live mode stays disabled: no database, no Paystack", async () => {
  const w = world({});
  globalThis.__env = { PAYSTACK_MODE: "live", PAYSTACK_TEST_SECRET_KEY: "sk_test_abcdefghijklmnop1234", APP_URL: "https://app.example.com" };
  const res = await call({ action: "start", token: TOKEN, email: "a@b.co", channel: "card" });
  assert.equal(res.status, 503); assert.equal(w.fetches.length, 0); assert.equal(w.rpcs.length, 0);
});

test("malformed tokens are rejected before anything else", async () => {
  const w = world({});
  for (const token of ["", "abc", "A".repeat(64), "123e4567-e89b-12d3-a456-426614174000"]) {
    const res = await call({ action: "start", token, email: "a@b.co", channel: "card" });
    assert.equal(res.status, 400);
  }
  assert.equal(w.rpcs.length, 0);
});


// ---- FX quote + confirmation (new) ------------------------------------------------------------------
const QID = "11111111-1111-4111-8111-111111111111";
const convRow = { ...newRow, amount: 127685.19, currency: "KES", invoice_amount: 150000, invoice_currency: "JPY", quote_id: QID };

test("quote: the browser can only name a channel; the server's quote is returned as-is", async () => {
  const quote = { quote_id: QID, converted: true, charge_amount: 127685.19, charge_currency: "KES" };
  const w = world({ custom: { payments_quote_create: () => ({ data: quote, error: null }) } });
  const res = await call({ action: "quote", token: TOKEN, channel: "card", amount: 1, rate: 99, currency: "JPY", fx_rate: 1 });
  assert.equal(res.status, 200); assert.deepEqual((await res.json()).quote, quote);
  assert.deepEqual(Object.keys(w.rpcs.find((r) => r.name === "payments_quote_create").args).sort(), ["p_channel", "p_token"]);
  assert.equal(w.fetches.length, 0);
});

test("quote refreshes server-side FX snapshots before SQL creates the quote", async () => {
  const quote = { quote_id: QID, converted: true, charge_amount: 127685.19, charge_currency: "KES" };
  const w = world({ custom: { payments_quote_create: () => ({ data: quote, error: null }) } });
  const res = await call({ action: "quote", token: TOKEN, channel: "card" });
  assert.equal(res.status, 200);
  assert.equal(w.fxFetches.length, 1);
  const save = w.rpcs.find((r) => r.name === "payments_checkout_fx_snapshot_save");
  assert.ok(save);
  assert.deepEqual(save.args.p_rates, { EUR: 0.92, GBP: 0.79, JPY: 150, KES: 129 });
  assert.equal(save.args.p_token, TOKEN);
  assert.equal(save.args.p_fetched_at, new Date(w.fxPayload.time_last_update_unix * 1000).toISOString());
});

test("quote rejects stale provider data and does not store it", async () => {
  const stale = { result: "success", time_last_update_unix: Math.floor(Date.now() / 1000) - 40 * 60 * 60, rates: { EUR: 0.92, JPY: 150, KES: 129 } };
  const w = world({ fxPayload: stale, custom: { payments_quote_create: () => ({ data: null, error: { message: "No reliable FX", details: "fx_unavailable" } }) } });
  const res = await call({ action: "quote", token: TOKEN, channel: "card" });
  assert.equal(res.status, 503);
  assert.equal(w.rpcs.some((r) => r.name === "payments_checkout_fx_snapshot_save"), false);
  assert.equal(w.rpcs.find((r) => r.name === "payments_quote_create") !== undefined, true);
});

test("quote provider outage still allows a valid recent stored snapshot to be used", async () => {
  const quote = { quote_id: QID, converted: true, charge_amount: 129, charge_currency: "KES" };
  const w = world({ fxError: true, custom: { payments_quote_create: () => ({ data: quote, error: null }) } });
  const res = await call({ action: "quote", token: TOKEN, channel: "card" });
  assert.equal(res.status, 200);
  assert.equal(w.rpcs.some((r) => r.name === "payments_checkout_fx_snapshot_save"), false);
  assert.equal(w.rpcs.some((r) => r.name === "payments_quote_create"), true);
});

test("quote: no reliable rate -> 503 fx_unavailable and nothing else happens", async () => {
  const w = world({ custom: { payments_quote_create: () => ({ data: null, error: { message: "We can’t show a reliable currency conversion right now.", details: "fx_unavailable" } }) } });
  const res = await call({ action: "quote", token: TOKEN, channel: "card" });
  assert.equal(res.status, 503); assert.equal((await res.json()).code, "fx_unavailable"); assert.equal(w.fetches.length, 0);
  const bad = world({});
  assert.equal((await call({ action: "quote", token: TOKEN, channel: "paypal" })).status, 400); assert.equal(bad.rpcs.length, 0);
});

test("start with a quote: Paystack is asked for exactly the server-approved charge, in the charge currency", async () => {
  const w = world({ prepare: [convRow], paystack: [initOk] });
  const res = await call({ action: "start", token: TOKEN, email: "a@b.co", channel: "card", quote_id: QID, amount: 5, currency: "JPY" });
  assert.equal(res.status, 200);
  assert.equal(w.fetches[0].body.amount, 12768519); assert.equal(w.fetches[0].body.currency, "KES");
  assert.equal(w.fetches[0].body.metadata.invoice_currency, "JPY");
  assert.equal(w.rpcs.find((r) => r.name === "payments_checkout_prepare").args.p_quote, QID);
});

test("start: expired / superseded / foreign quote -> 409 with a requote code, Paystack never called", async () => {
  for (const code of ["quote_expired", "quote_superseded", "quote_invalid", "quote_used", "quote_required"]) {
    const w = world({ prepare: [{ error: "price changed", details: code }] });
    const res = await call({ action: "start", token: TOKEN, email: "a@b.co", channel: "card", quote_id: QID });
    assert.equal(res.status, 409); assert.equal((await res.json()).code, code); assert.equal(w.fetches.length, 0);
  }
  const w = world({});
  const res = await call({ action: "start", token: TOKEN, email: "a@b.co", channel: "card", quote_id: "not-a-uuid" });
  assert.equal(res.status, 409); assert.equal(w.rpcs.length, 0); assert.equal(w.fetches.length, 0);
});

test("start: an invalid or non-live link is refused before any database or provider call", async () => {
  const w = world({});
  assert.equal((await call({ action: "start", token: "short", email: "a@b.co", channel: "card" })).status, 400);
  assert.equal(w.rpcs.length, 0); assert.equal(w.fetches.length, 0);
});

// ---- Wise manual flow (new) -------------------------------------------------------------------------
test("wise_start / wise_submit never touch Paystack and never mark anything paid", async () => {
  const transfer = { reference: "KRL-W-ABCD1234-0000000001", status: "pending", amount: 150000, currency: "JPY" };
  const w = world({ custom: {
    payments_manual_start: () => ({ data: transfer, error: null }),
    payments_manual_submit: () => ({ data: { status: "submitted" }, error: null }),
  } });
  globalThis.__env = { ...ENV, PAYSTACK_MODE: "test" };                      // even with Paystack misconfigured, Wise works and stays manual
  let res = await call({ action: "wise_start", token: TOKEN, email: "a@b.co" });
  assert.equal(res.status, 200); assert.equal((await res.json()).status, "wise_instructions");
  res = await call({ action: "wise_submit", token: TOKEN, reference: transfer.reference, transfer_reference: "W-998877" });
  assert.equal(res.status, 200); assert.equal((await res.json()).status, "submitted");
  assert.equal(w.fetches.length, 0);
  assert.equal(w.rpcs.filter((r) => /apply|settle|review/.test(r.name)).length, 0);
});

test("wise_submit: a malformed reference is rejected; a database refusal (duplicate reference) is a clean 409", async () => {
  let w = world({});
  assert.equal((await call({ action: "wise_submit", token: TOKEN, reference: "x y", transfer_reference: "W-1234" })).status, 400);
  assert.equal(w.rpcs.length, 0);
  w = world({ custom: { payments_manual_submit: () => ({ data: null, error: { message: "That transfer reference has already been submitted." } }) } });
  const res = await call({ action: "wise_submit", token: TOKEN, reference: "KRL-W-ABCD1234-0000000001", transfer_reference: "W-1234" });
  assert.equal(res.status, 409);
});
