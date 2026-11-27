import test from "node:test";
import assert from "node:assert/strict";
import { dispatchDue, buildPayload, splitSender, ensureRendered } from "../../../supabase/functions/_shared/finance_v3_email_service.ts";

const ORG = "11111111-1111-4111-8111-111111111111", INV = "22222222-2222-4222-8222-222222222222", MID = "33333333-3333-4333-8333-333333333333";
const SNAP = { invoice_no: "INV-000001", currency: "KES", issue_date: "2026-11-23", due_date: "2026-12-07", studio: { name: "Studio" }, client: { name: "Acme" }, lines: [],
  subtotal: "10.00", discount_total: "0.00", tax_total: "0.00", total: "10.00" };

/** Minimal in-memory model of the service RPCs the dispatcher uses (state machine only; the SQL is tested in phase3.test.sql). */
function world(over = {}) {
  const msg = { id: MID, organization_id: ORG, invoice_id: INV, email_type: "invoice", recipient: "pay@acme.test", sender: "Studio <billing@studio.test>", reply_to: "hello@studio.test",
    payload: { invoice_id: INV, invoice_no: "INV-000001", currency: "KES", outstanding: "10.00", due_date: "2026-12-07", studio: { name: "Studio" }, client: { name: "Acme" }, view_token: "a".repeat(64),
      attachments_plan: [{ kind: "invoice_pdf", entity_id: INV }] },
    status: "queued", attempt_count: 0, unknown_outcome: false, subject: null, body_html: null, body_text: null, rendered_at: null, attachments: [], idempotency_key: "k", ...over };
  const docs = new Map(); const calls = []; const finishes = [];
  const rpc = async (name, a) => {
    calls.push(name);
    switch (name) {
      case "fin3svc_list_unapplied_email_events": return [];
      case "fin3svc_expire_unknown_emails": return 0;
      case "fin3svc_claim_emails": if (msg.status === "queued" || (msg.status === "sending" && msg.lease === "expired")) { msg.status = "sending"; msg.attempt_count++; return [{ id: MID, attempt_no: msg.attempt_count }]; } return [];
      case "fin3svc_get_email": return { ...msg };
      case "fin3svc_get_snapshot": return SNAP;
      case "fin3svc_get_document": return docs.get(`${a.p_kind}:${a.p_entity}`) || null;
      case "fin3svc_store_document": { const k = `${a.p_kind}:${a.p_entity}`; if (!docs.has(k)) docs.set(k, { id: "d1", sha256: "f".repeat(64), bytes: 10, content_base64: a.p_content_base64 }); return docs.get(k); }
      case "fin3svc_save_rendered": if (!msg.rendered_at) { Object.assign(msg, { subject: a.p_subject, body_html: a.p_html, body_text: a.p_text, attachments: a.p_attachments, rendered_at: "now" }); } return { subject: msg.subject, body_html: msg.body_html, body_text: msg.body_text, attachments: msg.attachments };
      case "fin3svc_finish_attempt": finishes.push(a); if (a.p_outcome === "accepted") msg.status = "sent"; else if (a.p_outcome === "rejected") msg.status = "failed"; else if (a.p_outcome === "unknown") { msg.status = "sending"; msg.unknown_outcome = true; msg.lease = "expired"; } else msg.status = "queued"; return { status: msg.status }; 
      default: throw new Error("unexpected rpc " + name);
    }
  };
  return { msg, docs, calls, finishes, rpc };
}
const ok = { ok: true, id: "re_1" };

test("happy path: renders once, attaches the stored PDF, sends with a stable idempotency key and a Finance correlation tag", async () => {
  const w = world(); const sent = [];
  const stats = await dispatchDue({ rpc: w.rpc, linkBase: "https://x.test/f", send: async (p, k) => { sent.push({ p, k }); return ok; } });
  assert.equal(stats.sent, 1); assert.equal(w.msg.status, "sent");
  assert.equal(sent[0].k, `fin3-${MID}`);
  assert.deepEqual(sent[0].p.tags, [{ name: "kf_finance_message_id", value: MID }]);
  assert.equal(sent[0].p.from, "Studio <billing@studio.test>"); assert.deepEqual(sent[0].p.to, ["pay@acme.test"]);
  assert.equal(sent[0].p.attachments.length, 1); assert.equal(sent[0].p.attachments[0].content_type, "application/pdf");
  assert.match(sent[0].p.attachments[0].filename, /^Invoice-INV-000001\.pdf$/);
  assert.equal(Buffer.from(sent[0].p.attachments[0].content, "base64").subarray(0, 5).toString(), "%PDF-");
  assert.ok(sent[0].p.html.includes(`?t=${"a".repeat(64)}`));
});

test("an ambiguous result is recorded as unknown and the retry reuses the SAME key, content and PDF bytes (never a fresh send)", async () => {
  const w = world(); const sent = [];
  let n = 0;
  const send = async (p, k) => { sent.push({ p, k }); return n++ === 0 ? { ok: false, unknown: true, retryable: true, status: 0, message: "timeout" } : ok; };
  let s = await dispatchDue({ rpc: w.rpc, linkBase: "l", send });
  assert.equal(s.unknown, 1); assert.equal(w.msg.unknown_outcome, true); assert.equal(w.msg.status, "sending");
  s = await dispatchDue({ rpc: w.rpc, linkBase: "l", send });
  assert.equal(s.sent, 1);
  assert.equal(sent.length, 2); assert.equal(sent[0].k, sent[1].k);
  assert.equal(sent[0].p.html, sent[1].p.html); assert.equal(sent[0].p.attachments[0].content, sent[1].p.attachments[0].content);
  assert.equal(w.calls.filter((c) => c === "fin3svc_store_document").length, 1, "the PDF is stored once");
});

test("a definitive rejection fails the message; a rate limit is retryable; neither is treated as unknown", async () => {
  let w = world();
  let s = await dispatchDue({ rpc: w.rpc, linkBase: "l", send: async () => ({ ok: false, unknown: false, retryable: false, status: 422, message: "invalid" }) });
  assert.equal(s.rejected, 1); assert.equal(w.msg.status, "failed"); assert.equal(w.finishes.at(-1).p_outcome, "rejected");
  w = world();
  s = await dispatchDue({ rpc: w.rpc, linkBase: "l", send: async () => ({ ok: false, unknown: false, retryable: true, status: 429, message: "slow down" }) });
  assert.equal(s.retry, 1); assert.equal(w.msg.status, "queued"); assert.equal(w.finishes.at(-1).p_outcome, "retryable");
});

test("a rendering/PDF failure sends nothing and is retryable", async () => {
  const w = world(); let sent = 0;
  const rpc = async (n, a) => (n === "fin3svc_get_snapshot" ? null : w.rpc(n, a));
  const s = await dispatchDue({ rpc, linkBase: "l", send: async () => { sent++; return ok; } });
  assert.equal(sent, 0); assert.equal(s.retry, 1);
});

test("an unexpected dispatcher exception after a possible send is recorded as unknown, not lost", async () => {
  const w = world();
  const rpc = async (n, a) => { if (n === "fin3svc_finish_attempt" && a.p_outcome === "accepted") throw new Error("db down"); return w.rpc(n, a); };
  const s = await dispatchDue({ rpc, linkBase: "l", send: async () => ok });
  assert.equal(s.errors, 1);
  assert.equal(w.finishes.at(-1).p_outcome, "unknown");
});

test("a message that is already rendered is reused verbatim, never re-rendered", async () => {
  const w = world({ rendered_at: "t", subject: "Stored subject", body_html: "<p>stored</p>", body_text: "stored" }); const sent = [];
  await dispatchDue({ rpc: w.rpc, linkBase: "l", send: async (p) => { sent.push(p); return ok; } });
  assert.equal(sent[0].subject, "Stored subject"); assert.equal(sent[0].html, "<p>stored</p>");
  assert.ok(!w.calls.includes("fin3svc_save_rendered"));
});

test("the dispatcher touches no money function", async () => {
  const w = world();
  await dispatchDue({ rpc: w.rpc, linkBase: "l", send: async () => ok });
  for (const c of w.calls) assert.match(c, /^fin3svc_(list_unapplied_email_events|expire_unknown_emails|claim_emails|get_email|get_snapshot|get_document|store_document|save_rendered|finish_attempt|apply_email_event|mark_email_event_error)$/);
});

test("early delivery events are reconciled before sending, and a failing event is marked, not thrown", async () => {
  const w = world(); const marked = [];
  const rpc = async (n, a) => {
    if (n === "fin3svc_list_unapplied_email_events") return [7, 8];
    if (n === "fin3svc_apply_email_event") { if (a.p_event === 8) throw new Error("boom"); return { applied: true }; }
    if (n === "fin3svc_mark_email_event_error") { marked.push(a.p_event); return null; }
    return w.rpc(n, a);
  };
  await dispatchDue({ rpc, linkBase: "l", send: async () => ok });
  assert.deepEqual(marked, [8]);
});

test("sender parsing and payload shape", () => {
  assert.deepEqual(splitSender('"Studio Name" <a@b.test>'), { name: "Studio Name", email: "a@b.test" });
  assert.deepEqual(splitSender("a@b.test"), { name: "", email: "a@b.test" });
  const p = buildPayload({ id: MID, sender: 'Evil"<x> <a@b.test>', recipient: "r@x.test", reply_to: null }, { subject: "s", html: "h", text: "t", attachments: [] });
  assert.ok(!/["<>]\s*</.test(String(p.from).split("<")[0]) );
  assert.ok(!("attachments" in p) && !("reply_to" in p));
});
