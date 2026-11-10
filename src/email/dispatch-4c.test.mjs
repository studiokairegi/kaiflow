import test from "node:test";
import assert from "node:assert/strict";
import { shouldRotateSendKey } from "./lib/helpers.js";

test("4C composer key policy: only confirmed provider rejection/failure rotates the logical send key", () => {
  assert.equal(shouldRotateSendKey({ outcome: "rejected", retry_with_same_key: false }), true);
  assert.equal(shouldRotateSendKey({ outcome: "failed", retry_with_same_key: false }), true);
  for (const e of [
    { outcome: "unknown", retry_with_same_key: true },
    { outcome: "accepted" },
    { outcome: "duplicate" },
    { code: "not_configured" },
    { code: "invalid_request" },
    { code: "internal_error" },
    new Error("network timeout"),
    { outcome: "failed", retry_with_same_key: true },
  ]) assert.equal(shouldRotateSendKey(e), false, JSON.stringify(e));
});

import { emailApi } from "./lib/api.js";

const sendInput = { accountId: "30000000-0000-0000-0000-00000000000b", to: ["test@example.com"], cc: [], bcc: [], subject: "Test", text: "Body", html: "", key: "kf-test-key-123456", files: [] };

test("4C API: non-2xx Edge Function responses preserve the server outcome and retry policy", async () => {
  const payload = { ok: false, outcome: "unknown", code: "outcome_unknown", retry_with_same_key: true, message_id: "M1", error: "Check Sent before retrying" };
  const supabase = { functions: { invoke: async () => ({ data: null, error: { message: "Edge Function returned a non-2xx status", context: { json: async () => payload } } }) } };
  await assert.rejects(emailApi.send(supabase, sendInput), (error) => {
    assert.equal(error.outcome, "unknown");
    assert.equal(error.code, "outcome_unknown");
    assert.equal(error.retry_with_same_key, true);
    assert.equal(error.message_id, "M1");
    return true;
  });
});

test("4C API: HTTP 202 unknown data is surfaced with the same retry metadata", async () => {
  const payload = { ok: false, outcome: "unknown", code: "outcome_unknown", retry_with_same_key: true, error: "Still unconfirmed" };
  const supabase = { functions: { invoke: async () => ({ data: payload, error: null }) } };
  await assert.rejects(emailApi.send(supabase, sendInput), (error) => {
    assert.equal(error.outcome, "unknown");
    assert.equal(error.retry_with_same_key, true);
    assert.equal(error.message, "Still unconfirmed");
    return true;
  });
});
