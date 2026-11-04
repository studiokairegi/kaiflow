import test from "node:test";
import assert from "node:assert/strict";
import { normalizeIntelReply, ingestIntelReply } from "../../supabase/functions/_shared/intel_resend_logic.ts";

const token = `kf${"a".repeat(32)}`;
const fixture = {
  id: "rx_123",
  from: "Rina <rina@prospect.test>",
  to: ["hello@studio.test"],
  subject: "Re: Intro",
  text: `Thanks for reaching out.\n\nRef: ${token}`,
  created_at: "2026-11-04T12:00:00.000Z",
  headers: {
    "Message-ID": "<reply@prospect.test>",
    "In-Reply-To": "<outbound@studio.test>",
    References: "<older@studio.test> <outbound@studio.test>",
  },
};

test("Resend received payload normalizes sender, recipients, body, timestamp and RFC threading", () => {
  const m = normalizeIntelReply(fixture, { email_id: "rx_123" });
  assert.equal(m.p_provider_message_id, "rx_123");
  assert.equal(m.p_from_email, "rina@prospect.test");
  assert.equal(m.p_token, token);
  assert.equal(m.p_subject, "Re: Intro");
  assert.match(m.p_body_text, /Thanks for reaching out/);
  assert.equal(m.p_received_at, fixture.created_at);
  assert.equal(m.p_rfc_message_id, "<reply@prospect.test>");
  assert.equal(m.p_in_reply_to, "<outbound@studio.test>");
  assert.equal(m.p_references, "<older@studio.test> <outbound@studio.test>");
});

test("ordinary Inbox messages without a KairFlow token are not Intelligence messages", () => {
  assert.equal(normalizeIntelReply({ ...fixture, text: "A normal customer message" }, { email_id: "rx_other" }), null);
});

test("replayed inbound webhook delivery is idempotent at the provider-message boundary", async () => {
  const m = normalizeIntelReply(fixture, { email_id: "rx_123" });
  const seen = new Map();
  let inserts = 0;
  const record = async (p) => {
    if (seen.has(p.p_provider_message_id)) return { duplicate: true, message_id: seen.get(p.p_provider_message_id) };
    const id = `intel-${++inserts}`;
    seen.set(p.p_provider_message_id, id);
    return { duplicate: false, message_id: id };
  };
  const first = await ingestIntelReply(m, record);
  const second = await ingestIntelReply(m, record);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(inserts, 1);
});
