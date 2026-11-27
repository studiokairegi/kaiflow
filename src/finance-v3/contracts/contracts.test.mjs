import test from "node:test";
import assert from "node:assert/strict";
import * as c from "./index.js";

test("error codes are unique and in custom SQLSTATE class V3", () => {
  const vals = Object.values(c.ERROR_CODES);
  assert.equal(new Set(vals).size, vals.length);
  for (const v of vals) assert.match(v, /^V3\d{3}$/);
});

test("every account type has a normal balance and vice versa", () => {
  assert.deepEqual([...c.ACCOUNT_TYPES].sort(), Object.keys(c.NORMAL_BALANCE).sort());
  for (const side of Object.values(c.NORMAL_BALANCE)) assert.ok(c.LINE_SIDE.includes(side));
});

test("contract enumerations are frozen", () => {
  for (const o of [c.ACCOUNT_TYPES, c.ENTRY_STATUS, c.FX_STATUS, c.UI_MODES, c.ERROR_CODES, c.MONEY, c.V2_PROTECTED_TABLES]) {
    assert.ok(Object.isFrozen(o));
  }
});

test("default UI mode is simple and is a valid mode", () => {
  assert.equal(c.DEFAULT_UI_MODE, "simple");
  assert.ok(c.UI_MODES.includes(c.DEFAULT_UI_MODE));
});

test("money wire format accepts decimal strings and rejects exponents, separators and over-scale", () => {
  for (const ok of ["0", "12", "-12.5", "1234567.1234", "999999999999999.9999"]) assert.match(ok, c.MONEY.amountPattern);
  for (const bad of ["007", "-01", "00.5", "1e3", "1,000.00", ".5", "12.34567", "", "abc", "1234567890123456"]) assert.doesNotMatch(bad, c.MONEY.amountPattern);
  assert.equal(c.MONEY.storageScale, 4);
});

test("schema and RPC namespace do not collide with protected V2 names", () => {
  assert.notEqual(c.DB_SCHEMA, "public");
  assert.ok(c.RPC_PREFIX.startsWith("fin3_"));
  assert.ok(!c.V2_PROTECTED_TABLES.some((t) => t.startsWith(c.RPC_PREFIX)));
});

// ---- Phase 1 rev. 1.1: integration contracts -----------------------------------------------------

test("integration enumerations are frozen", () => {
  for (const o of [c.ENGINES, c.PAYMENT_PROVIDERS, c.PAYMENT_ENVIRONMENTS, c.FINANCE_EMAIL_TYPES, c.FINANCE_EMAIL_STATUS,
    c.FINANCE_EMAIL_STATUS_RANK, c.FINANCE_EMAIL_DELIVERY_FLAGS, c.FINANCE_EMAIL_EMAILED_STATES, c.PAYMENT_INTENT_STATUS,
    c.OPEN_PAYMENT_INTENT_STATUS, c.PAYMENT_VERIFICATION_STATUS, c.PAYMENT_METHODS, c.REFUND_STATUS, c.PROVIDER_EVENT_STATUS,
    c.PAYSTACK_HANDLED_EVENTS, c.IDEMPOTENCY_KINDS, c.INTEGRATION_PERMISSIONS, c.PROTECTED_INTEGRATION_TABLES,
    c.PROTECTED_INTEGRATION_TABLE_PREFIXES, c.ALLOWED_PAYSTACK_WEBHOOK_FUNCTIONS, c.ALLOWED_RESEND_WEBHOOK_FUNCTIONS,
    c.FINANCE_EMAIL_BACKOFF_SECONDS]) assert.ok(Object.isFrozen(o));
});

test("Finance email has exactly the six user-visible states and every state has a rank", () => {
  assert.deepEqual([...c.FINANCE_EMAIL_STATUS], ["queued", "sending", "sent", "delivered", "bounced", "failed"]);
  assert.deepEqual(Object.keys(c.FINANCE_EMAIL_STATUS_RANK).sort(), [...c.FINANCE_EMAIL_STATUS].sort());
  assert.deepEqual([...c.FINANCE_EMAIL_EMAILED_STATES], ["sent", "delivered"]);
  assert.ok(!c.FINANCE_EMAIL_EMAILED_STATES.includes("queued") && !c.FINANCE_EMAIL_EMAILED_STATES.includes("sending"));
});

test("Finance email tag is distinct from the Inbox tag, so the two correlation paths cannot collide", () => {
  assert.notEqual(c.FINANCE_EMAIL_TAG, c.INBOX_EMAIL_TAG);
  assert.equal(c.FINANCE_EMAIL_TAG, "kf_finance_message_id");
});

test("Resend event mapping: delivered/sent/bounced/failed, delays and complaints are flags, soft bounces are delays", () => {
  const f = c.financeEmailOutcomeForResendEvent;
  assert.deepEqual(f("email.sent"), { status: "sent", flag: null });
  assert.deepEqual(f("email.delivered"), { status: "delivered", flag: null });
  assert.deepEqual(f("email.delivery_delayed"), { status: null, flag: "delayed" });
  assert.deepEqual(f("email.bounced", "Permanent"), { status: "bounced", flag: null });
  assert.deepEqual(f("email.bounced", "Transient"), { status: null, flag: "delayed" });
  assert.deepEqual(f("email.bounced", "soft"), { status: null, flag: "delayed" });
  assert.deepEqual(f("email.complained"), { status: null, flag: "complained" });
  assert.deepEqual(f("email.failed"), { status: "failed", flag: null });
  assert.deepEqual(f("email.suppressed"), { status: "failed", flag: "suppressed" });
  assert.deepEqual(f("email.rejected"), { status: "failed", flag: "suppressed" });
  assert.deepEqual(f("email.received"), { status: null, flag: null });
  assert.deepEqual(f(undefined), { status: null, flag: null });
  for (const e of ["email.sent", "email.delivered", "email.bounced", "email.failed", "email.suppressed", "email.rejected"]) {
    const { status, flag } = f(e, "Permanent");
    if (status) assert.ok(c.FINANCE_EMAIL_STATUS.includes(status));
    if (flag) assert.ok(c.FINANCE_EMAIL_DELIVERY_FLAGS.includes(flag));
  }
});

test("Finance email status only moves forward; a late 'sent' never regresses 'delivered'; terminal states are final", () => {
  const a = c.canAdvanceFinanceEmailStatus;
  assert.equal(a("queued", "sending"), true);
  assert.equal(a("sending", "sent"), true);
  assert.equal(a("sent", "delivered"), true);
  assert.equal(a("delivered", "sent"), false);
  assert.equal(a("sent", "sent"), false);
  assert.equal(a("sent", "bounced"), true);
  assert.equal(a("bounced", "delivered"), false);
  assert.equal(a("failed", "sent"), false);
  assert.equal(a("queued", "nonsense"), false);
});

test("payment intent statuses: open set is a subset, and there is exactly one terminal-success state", () => {
  for (const s of c.OPEN_PAYMENT_INTENT_STATUS) assert.ok(c.PAYMENT_INTENT_STATUS.includes(s));
  assert.ok(c.PAYMENT_INTENT_STATUS.includes("needs_review"));
  assert.equal(c.PAYMENT_INTENT_STATUS.filter((s) => s === "succeeded").length, 1);
  assert.ok(!c.OPEN_PAYMENT_INTENT_STATUS.includes("succeeded"));
});

test("V3 payment references: own prefix, disjoint from legacy prefixes, pattern accepts valid and rejects look-alikes", () => {
  assert.equal(c.V3_PAYMENT_REFERENCE_PREFIX, "KRL3-");
  for (const legacy of c.LEGACY_PAYMENT_REFERENCE_PREFIXES) {
    assert.ok(!c.V3_PAYMENT_REFERENCE_PREFIX.startsWith(legacy));
    assert.ok(!legacy.startsWith(c.V3_PAYMENT_REFERENCE_PREFIX));
    assert.equal(c.isV3PaymentReference(`${legacy}ABCD1234-DEADBEEF`), false);
  }
  assert.equal(c.isV3PaymentReference("KRL3-L-ABCDEFGHIJKL-ABCD"), true);
  assert.equal(c.isV3PaymentReference(undefined), false);
  assert.equal(c.isV3PaymentReference(42), false);
  assert.match("KRL3-L-ABCDEFGHIJKL-ABCD", c.V3_PAYMENT_REFERENCE_PATTERN);
  assert.match("KRL3-T-A2B3C4D5E6F7-XY7Z", c.V3_PAYMENT_REFERENCE_PATTERN);
  for (const bad of ["KRL-L-ABCDEFGHIJKL-ABCD", "KRL3-X-ABCDEFGHIJKL-ABCD", "KRL3-L-abcdefghijkl-ABCD", "KRL3-L-ABCDEFGHIJK-ABCD", "KRL3-L-ABCDEFGHIJKL-ABC1", "KRL3-L-ABCDEFGHIJKL-ABCD "]) {
    assert.doesNotMatch(bad, c.V3_PAYMENT_REFERENCE_PATTERN);
  }
});

test("idempotency keys: namespaced, deterministic, bounded, and reject injection characters", () => {
  const k = c.buildIdempotencyKey("email:receipt", "0b1c2d3e");
  assert.equal(k, "fin3:email:receipt:0b1c2d3e");
  assert.equal(c.buildIdempotencyKey("pay", "paystack", "KRL3-L-ABCDEFGHIJKL-ABCD"), "fin3:pay:paystack:KRL3-L-ABCDEFGHIJKL-ABCD");
  assert.equal(c.buildIdempotencyKey("email:receipt", "x"), c.buildIdempotencyKey("email:receipt", "x"));
  assert.throws(() => c.buildIdempotencyKey("unknown-kind", "x"));
  assert.throws(() => c.buildIdempotencyKey("pay"));
  for (const bad of ["a b", "a/b", "a\nb", "", "a'b", "a;b"]) assert.throws(() => c.buildIdempotencyKey("pay", bad), bad);
  assert.throws(() => c.buildIdempotencyKey("pay", "x".repeat(81)));
  assert.throws(() => c.buildIdempotencyKey("pay", ...Array.from({ length: 4 }, () => "y".repeat(80))));
});

test("integration error codes exist, are unique, and are in class V3", () => {
  for (const name of ["PAYMENT_AMOUNT_MISMATCH", "PAYMENT_CURRENCY_MISMATCH", "PAYMENT_NOT_VERIFIED", "ENGINE_MISMATCH",
    "INVOICE_STATE_INVALID", "EMAIL_RECIPIENT_INVALID", "ENVIRONMENT_NOT_ALLOWED"]) {
    assert.match(c.ERROR_CODES[name], /^V3\d{3}$/, name);
  }
  assert.equal(new Set(Object.values(c.ERROR_CODES)).size, Object.keys(c.ERROR_CODES).length);
});

test("protected integration objects cover every existing payment table and the Inbox and Intelligence families", () => {
  for (const t of ["paystack_transactions", "paystack_webhook_events", "payment_checkout_sessions", "payment_quotes", "payment_providers"]) {
    assert.ok(c.PROTECTED_INTEGRATION_TABLES.includes(t), t);
  }
  assert.deepEqual([...c.PROTECTED_INTEGRATION_TABLE_PREFIXES].sort(), ["email_", "intel_"]);
  assert.deepEqual([...c.ALLOWED_PAYSTACK_WEBHOOK_FUNCTIONS], ["paystack-webhook"]);
  assert.deepEqual([...c.ALLOWED_RESEND_WEBHOOK_FUNCTIONS].sort(), ["intel-resend-webhook", "resend-webhook"]);
});

test("engines are v2 and v3 and the provider set keeps the accounting engine provider-neutral", () => {
  assert.deepEqual([...c.ENGINES], ["v2", "v3"]);
  assert.deepEqual([...c.PAYMENT_PROVIDERS], ["paystack"]);
  assert.equal(c.EMAIL_PROVIDER, "resend");
  assert.ok(!c.ACCOUNT_TYPES.some((t) => /paystack|resend/.test(t)));
});
