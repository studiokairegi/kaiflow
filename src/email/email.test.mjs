import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  parseAddress, normalizeSubject, buildThreadHeaders, withThreadToken, extractThreadToken, baseAddress, threadToken, parseMessageIds, pickConversation,
  verifySvixSignature, validateSendRequest, buildResendPayload, sendViaResend, handleSend, handleWebhook, statusForEvent, htmlToText, safeFileName,
} from "../../supabase/functions/_shared/email_resend_logic.ts";
import { providerPausedResponse } from "../../supabase/functions/_shared/provider_guard.ts";
import { parseRecipients, replyRecipients, buildReply, buildForward, composeProblem, participantLabel, activeMailProviders, normalizeSubject as uiNorm, attachmentProblem, statusLabel } from "./logic.js";

const ORG = "20000000-0000-0000-0000-00000000000a";
const ACC = "30000000-0000-0000-0000-00000000000b";
const CONV = "aaaaaaaa-1111-2222-3333-444444444444";
const SECRET_BYTES = "test-secret-bytes-0123456789abcd";
const SECRET = "whsec_" + Buffer.from(SECRET_BYTES).toString("base64");
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);

async function sign(body, { id = "msg_1", ts = Math.floor(NOW / 1000), secret = SECRET } = {}) {
  const key = await crypto.subtle.importKey("raw", Buffer.from(secret.replace(/^whsec_/, ""), "base64"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`))).toString("base64");
  return { "svix-id": id, "svix-timestamp": String(ts), "svix-signature": `v1,${mac}` };
}
const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers });

// ---------------------------------------------------------------- helpers
test("subjects, addresses and message ids are normalised", () => {
  assert.equal(normalizeSubject("Re: RE: Fwd: Hello  World"), "hello world");
  assert.equal(uiNorm("AW: Re: Quote"), "quote");
  assert.deepEqual(parseAddress('"Ada L." <Ada@X.com>'), { name: "Ada L.", email: "ada@x.com" });
  assert.deepEqual(parseAddress("bob@y.com"), { name: "", email: "bob@y.com" });
  assert.deepEqual(parseMessageIds("<a@x> junk <b@y>"), ["<a@x>", "<b@y>"]);
  assert.equal(htmlToText("<p>Hi&nbsp;<b>there</b></p><style>x{}</style>"), "Hi there");
  assert.equal(safeFileName("../a/b:c.pdf"), "_a_b_c.pdf");
});

test("reply headers chain the previous References and end with the parent's Message-ID", () => {
  assert.deepEqual(buildThreadHeaders({ rfc_message_id: "<c@x>", references_ids: "<a@x> <b@x>" }), { in_reply_to: "<c@x>", references: "<a@x> <b@x> <c@x>" });
  assert.equal(buildThreadHeaders({ rfc_message_id: null }), null);
  assert.equal(buildThreadHeaders(null), null);
  assert.equal(buildThreadHeaders({ rfc_message_id: "<c@x>", references_ids: "<c@x>" }).references, "<c@x>");   // no duplicates
});

test("thread tokens survive plus-addressing round trips", () => {
  const addr = withThreadToken("John@StudioKairegi.com", CONV);
  assert.equal(addr, `john+k${threadToken(CONV)}@studiokairegi.com`);
  assert.equal(extractThreadToken(["someone@x.com", addr]), "aaaaaaaa1111");
  assert.equal(baseAddress(addr), "john@studiokairegi.com");
  assert.equal(withThreadToken("john+old@d.com", CONV), `john+k${threadToken(CONV)}@d.com`);
  assert.equal(extractThreadToken(["john@d.com"]), null);
});

// ---------------------------------------------------------------- threading
test("incoming mail joins a conversation by token, then headers, then subject+sender within 30 days", () => {
  const base = { inReplyTo: null, references: null, rfcMap: {}, normalizedSubject: "quote", sender: "Ada@x.com", candidates: [], nowMs: NOW };
  assert.deepEqual(pickConversation({ ...base, tokenConversationId: "T" }), { conversationId: "T", via: "token" });
  assert.deepEqual(pickConversation({ ...base, tokenConversationId: null, inReplyTo: "<m2@x>", rfcMap: { "<m2@x>": "H" } }), { conversationId: "H", via: "header" });
  // References: newest id wins over older ones
  assert.equal(pickConversation({ ...base, tokenConversationId: null, references: "<old@x> <new@x>", rfcMap: { "<old@x>": "O", "<new@x>": "N" } }).conversationId, "N");
  const recent = new Date(NOW - 5 * 86_400_000).toISOString();
  const old = new Date(NOW - 45 * 86_400_000).toISOString();
  const cand = (id, subj, who, at) => ({ conversation_id: id, normalized_subject: subj, participants: who, last_message_at: at });
  assert.equal(pickConversation({ ...base, tokenConversationId: null, candidates: [cand("S", "quote", ["ada@x.com"], recent)] }).via, "subject");
  assert.equal(pickConversation({ ...base, tokenConversationId: null, candidates: [cand("S", "quote", ["ada@x.com"], old)] }).conversationId, null);        // too old
  assert.equal(pickConversation({ ...base, tokenConversationId: null, candidates: [cand("S", "quote", ["other@x.com"], recent)] }).conversationId, null);   // different person
  assert.equal(pickConversation({ ...base, tokenConversationId: null, candidates: [cand("S", "other subject", ["ada@x.com"], recent)] }).conversationId, null);
  assert.equal(pickConversation({ ...base, tokenConversationId: null, normalizedSubject: "", candidates: [cand("S", "", ["ada@x.com"], recent)] }).conversationId, null);   // empty subjects never match
});

test("delivery events map to statuses; opens and clicks do not", () => {
  assert.equal(statusForEvent("email.delivered"), "delivered");
  assert.equal(statusForEvent("email.bounced"), "bounced");
  assert.equal(statusForEvent("email.complained"), "complained");
  assert.equal(statusForEvent("email.suppressed"), "rejected");
  assert.equal(statusForEvent("email.opened"), null);
});

// ---------------------------------------------------------------- webhook signature
test("webhook signatures: valid, tampered, wrong secret, stale, replayed id, missing parts", async () => {
  const body = '{"type":"email.received"}';
  const h = await sign(body);
  const ok = (over = {}) => verifySvixSignature({ secret: SECRET, id: h["svix-id"], timestamp: h["svix-timestamp"], signature: h["svix-signature"], body, nowMs: NOW, ...over });
  assert.equal(await ok(), true);
  assert.equal(await ok({ body: body + " " }), false);
  assert.equal(await ok({ secret: "whsec_" + Buffer.from("another-secret-another-secret-12").toString("base64") }), false);
  assert.equal(await ok({ nowMs: NOW + 10 * 60_000 }), false);              // older than 5 minutes
  assert.equal(await ok({ id: "msg_other" }), false);                         // signature is bound to the delivery id
  assert.equal(await ok({ signature: "" }), false);
  assert.equal(await ok({ secret: "" }), false);
  assert.equal(await ok({ secret: "%%%not-base64%%%" }), false);              // fails closed, never throws
  assert.equal(await ok({ signature: `v2,abc ${h["svix-signature"]}` }), true);   // several signatures: any valid v1 passes
});

// ---------------------------------------------------------------- send request validation and payload
const goodReq = (o = {}) => ({ account_id: ACC, to: ["a@x.com"], subject: "Hello", text: "Body", idempotency_key: "key-12345678", ...o });
test("send requests are validated", () => {
  assert.equal(validateSendRequest(goodReq()).ok, true);
  assert.match(validateSendRequest(goodReq({ to: [] })).error, /recipient/);
  assert.match(validateSendRequest(goodReq({ to: ["not an email"] })).error, /valid email/);
  assert.match(validateSendRequest(goodReq({ cc: ["x@y.com\r\nBcc: z@z.com"] })).error, /valid email/);   // header injection
  assert.match(validateSendRequest(goodReq({ subject: "a\r\nBcc: evil@x.com" })).error, /Subject/);
  assert.match(validateSendRequest(goodReq({ subject: "  " })).error, /subject/);
  assert.match(validateSendRequest(goodReq({ text: "", html: "" })).error, /message/);
  assert.match(validateSendRequest(goodReq({ idempotency_key: "x" })).error, /key/);
  assert.match(validateSendRequest(goodReq({ account_id: "nope" })).error, /sender/);
  assert.match(validateSendRequest(goodReq({ to: Array.from({ length: 51 }, (_, i) => `u${i}@x.com`) })).error, /Too many/);
  const big = Buffer.alloc(11 * 1024 * 1024).toString("base64");
  assert.match(validateSendRequest(goodReq({ attachments: [{ filename: "a.bin", content_base64: big }] })).error, /10 MB/);
  const v = validateSendRequest(goodReq({ to: ["A@x.com", "a@X.com"], attachments: [{ filename: "../evil.pdf", content_base64: "aGk=" }] }));
  assert.deepEqual(v.value.to, ["A@x.com"]);                                   // duplicates removed
  assert.equal(v.value.attachments[0].filename, "_evil.pdf");
});

test("Resend payload carries sender, threading, reply-to, cc/bcc and attachments, and never a hardcoded address", () => {
  const req = validateSendRequest(goodReq({ cc: ["c@x.com"], bcc: ["b@x.com"], html: "<p>Hi</p>", attachments: [{ filename: "a.txt", content_base64: "aGk=" }] })).value;
  const p = buildResendPayload({ fromEmail: "john@studiokairegi.com", fromName: 'Studio "Kairegi"', req, thread: { in_reply_to: "<p@x>", references: "<p@x>" }, replyTo: "john+kabc@studiokairegi.com" });
  assert.equal(p.from, "Studio Kairegi <john@studiokairegi.com>");
  assert.deepEqual(p.headers, { "In-Reply-To": "<p@x>", References: "<p@x>" });
  assert.equal(p.reply_to, "john+kabc@studiokairegi.com");
  assert.deepEqual([p.cc, p.bcc], [["c@x.com"], ["b@x.com"]]);
  assert.equal(p.attachments[0].content, "aGk=");
  assert.equal(p.text, "Body");
  assert.equal(buildResendPayload({ fromEmail: "j@x.com", fromName: "", req: validateSendRequest(goodReq({ text: "", html: "<p>Only html</p>" })).value, thread: null, replyTo: "" }).text, "Only html");
  const src = fs.readFileSync(new URL("../../supabase/functions/_shared/email_resend_logic.ts", import.meta.url), "utf8");
  assert.equal(/studiokairegi\.com/i.test(src.replace(/\/\/.*$/gm, "")), false, "sender address must come from configuration, not code");
});

// ---------------------------------------------------------------- sending with retries
const noSleep = async () => {};
test("sending retries 429/5xx with the same Idempotency-Key and stops on 4xx", async () => {
  const calls = [];
  const seq = [json({ message: "slow down" }, 429, { "retry-after": "1" }), json({ message: "boom" }, 503), json({ id: "re_123" }, 200)];
  const f = async (url, init) => { calls.push({ url, init }); return seq.shift(); };
  const out = await sendViaResend(f, "re_key", { to: ["a@x.com"] }, "key-12345678", { sleep: noSleep });
  assert.deepEqual(out, { ok: true, id: "re_123", attempts: 3 });
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.init.headers["Idempotency-Key"] === "kf-key-12345678"));
  assert.equal(calls[0].init.headers.Authorization, "Bearer re_key");
  assert.equal(calls[0].url, "https://api.resend.com/emails");

  const bad = await sendViaResend(async () => json({ message: "domain not verified" }, 403), "k", {}, "key-12345678", { sleep: noSleep });
  assert.equal(bad.ok, false); assert.equal(bad.retryable, false); assert.equal(bad.unknown, false); assert.equal(bad.attempts, 1);

  const exhausted = await sendViaResend(async () => json({ message: "x" }, 500), "k", {}, "key-12345678", { sleep: noSleep, maxAttempts: 2 });
  assert.equal(exhausted.ok, false); assert.equal(exhausted.retryable, true); assert.equal(exhausted.attempts, 2);

  const net = await sendViaResend(async () => { throw new Error("socket hang up"); }, "k", {}, "key-12345678", { sleep: noSleep });
  assert.equal(net.ok, false); assert.equal(net.unknown, true);               // outcome unknown: never reported as a clean failure
  const odd = await sendViaResend(async () => json({}, 200), "k", {}, "key-12345678", { sleep: noSleep });
  assert.equal(odd.unknown, true);
});

// ---------------------------------------------------------------- handleSend end to end with a fake store
function sendHarness(over = {}) {
  const log = { created: [], marks: [], attachments: [], fetches: [] };
  const rows = [];
  const store = {
    providerEnabled: async () => over.enabled ?? true,
    getAccount: async (org, id) => (org === ORG && id === ACC ? { id: ACC, address: "john@studiokairegi.com", display_name: "Studio Kairegi", status: "active" } : null),
    getThreadParent: async () => over.parent ?? null,
    countOutboundSince: async (_o, since) => (Date.parse(since) > NOW - 120_000 ? (over.perMinute ?? 0) : (over.perDay ?? 0)),
    createOutbound: async (p) => {
      const dup = rows.find((r) => r.idempotency_key === p.idempotency_key);
      if (dup) return { duplicate: true, message_id: "M1", conversation_id: CONV, status: "sent" };
      rows.push(p); log.created.push(p);
      return { duplicate: false, message_id: "M1", conversation_id: p.conversation_id || CONV, status: "queued" };
    },
    markResult: async (id, patch) => { log.marks.push(patch); },
    saveAttachments: async (...a) => { if (over.attachFails) throw new Error("storage down"); log.attachments.push(a); },
  };
  const deps = {
    env: (k) => ({ RESEND_API_KEY: "re_secret_key", ...(over.env || {}) })[k],
    fetch: over.fetch || (async (url, init) => { log.fetches.push({ url, init }); return json({ id: "re_sent_1" }); }),
    now: () => NOW, sleep: noSleep, store,
    authenticate: async (req) => (req.headers.get("authorization") === "Bearer good" ? { ok: true, userId: "U1", organizationId: ORG } : { ok: false, status: over.denyStatus ?? 401, error: "Not authenticated" }),
  };
  return { deps, log };
}
const post = (body, token = "good") => new Request("https://x/functions/v1/email-send", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

test("email-send: success stores the Resend id, threads the reply and sends a plus-address reply-to", async () => {
  const { deps, log } = sendHarness({ parent: { rfc_message_id: "<inbound@client.com>", references_ids: "<first@client.com>" } });
  const res = await handleSend(post(goodReq({ conversation_id: CONV, subject: "Re: Hello" })), deps);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "sent");
  const sent = JSON.parse(log.fetches[0].init.body);
  assert.deepEqual(sent.headers, { "In-Reply-To": "<inbound@client.com>", References: "<first@client.com> <inbound@client.com>" });
  assert.equal(sent.reply_to, `john+k${threadToken(CONV)}@studiokairegi.com`);
  assert.equal(sent.from, "Studio Kairegi <john@studiokairegi.com>");
  assert.deepEqual(log.marks.map((m) => m.status), ["sending", "sent"]);
  assert.equal(log.marks[1].provider_message_id, "re_sent_1");
  assert.equal(log.created[0].in_reply_to, "<inbound@client.com>");
});

test("email-send: a chosen reply-to wins; EMAIL_THREAD_TOKENS=off disables the token", async () => {
  const a = sendHarness();
  await handleSend(post(goodReq({ reply_to: "Me <me@elsewhere.com>" })), a.deps);
  assert.equal(JSON.parse(a.log.fetches[0].init.body).reply_to, "Me <me@elsewhere.com>");
  const b = sendHarness({ env: { EMAIL_THREAD_TOKENS: "off" } });
  await handleSend(post(goodReq()), b.deps);
  assert.equal("reply_to" in JSON.parse(b.log.fetches[0].init.body), false);
});

test("email-send: double submit with the same key sends once", async () => {
  const { deps, log } = sendHarness();
  const r1 = await handleSend(post(goodReq()), deps);
  const r2 = await handleSend(post(goodReq()), deps);
  assert.equal((await r1.json()).status, "sent");
  assert.equal((await r2.json()).duplicate, true);
  assert.equal(log.fetches.length, 1);
});

test("email-send: refuses callers, missing config, disabled provider, unknown sender and limits", async () => {
  const noAuth = await handleSend(post(goodReq(), "bad"), sendHarness().deps);
  assert.equal(noAuth.status, 401);
  assert.equal((await handleSend(post(goodReq(), "bad"), sendHarness({ denyStatus: 403 }).deps)).status, 403);
  const noKey = sendHarness({ env: { RESEND_API_KEY: "" } });
  assert.equal((await handleSend(post(goodReq()), noKey.deps)).status, 503);
  assert.equal(noKey.log.fetches.length, 0);
  assert.equal((await handleSend(post(goodReq()), sendHarness({ enabled: false }).deps)).status, 503);
  assert.equal((await handleSend(post(goodReq({ account_id: "30000000-0000-0000-0000-0000000000ff" })), sendHarness().deps)).status, 404);
  const day = await handleSend(post(goodReq()), sendHarness({ perDay: 100 }).deps);
  assert.equal(day.status, 429); assert.match((await day.json()).error, /Daily sending limit/);
  assert.equal((await handleSend(post(goodReq()), sendHarness({ perMinute: 20 }).deps)).status, 429);
  assert.equal((await handleSend(post({ nonsense: true }), sendHarness().deps)).status, 400);
  assert.equal((await handleSend(new Request("https://x", { method: "POST", headers: { authorization: "Bearer good" }, body: "{not json" }), sendHarness().deps)).status, 400);
  assert.equal((await handleSend(new Request("https://x", { method: "GET" }), sendHarness().deps)).status, 405);
});

test("email-send: provider rejection is recorded as rejected, unknown outcome is never retried, secrets never leak", async () => {
  const rejected = sendHarness({ fetch: async () => json({ message: "The domain is not verified" }, 403) });
  const r = await handleSend(post(goodReq()), rejected.deps);
  assert.equal(r.status, 422);
  assert.equal(rejected.log.marks.at(-1).status, "rejected");
  assert.equal(JSON.stringify(await r.json()).includes("re_secret_key"), false);

  let calls = 0;
  const unknown = sendHarness({ fetch: async () => { calls++; throw new Error("reset"); } });
  const u = await handleSend(post(goodReq()), unknown.deps);
  assert.equal(u.status, 202);
  assert.equal((await u.json()).status, "unknown");
  assert.equal(unknown.log.marks.at(-1).status, "sending");          // stays visible for a person to check
  assert.equal(calls, 3);                                             // retried with the same key only, then stopped
});

test("email-send: attachments are copied after sending and a storage failure cannot turn a sent mail into an error", async () => {
  const ok = sendHarness();
  await handleSend(post(goodReq({ attachments: [{ filename: "a.txt", content_base64: "aGk=" }] })), ok.deps);
  assert.equal(ok.log.attachments.length, 1);
  const broken = sendHarness({ attachFails: true });
  const r = await handleSend(post(goodReq({ attachments: [{ filename: "a.txt", content_base64: "aGk=" }] })), broken.deps);
  assert.equal((await r.json()).status, "sent");
});

// ---------------------------------------------------------------- handleWebhook end to end with a fake store
function hookHarness(over = {}) {
  const log = { webhooks: new Map(), ingested: [], uploads: [], events: [], fetches: [] };
  const store = {
    providerEnabled: async () => over.enabled ?? true,
    beginWebhook: async (id, type) => {
      const ex = log.webhooks.get(id);
      if (ex && ["processed", "ignored"].includes(ex.status)) return "done";
      log.webhooks.set(id, { type, status: "received" });
      return ex ? "retry" : "new";
    },
    finishWebhook: async (id, status, error) => { log.webhooks.set(id, { ...log.webhooks.get(id), status, error }); },
    findAccount: async (addrs) => (addrs.map(baseAddress).includes("john@studiokairegi.com") ? { id: ACC, organization_id: ORG, address: "john@studiokairegi.com" } : null),
    threadLookup: async (_o, q) => { log.lookup = q; return over.lookup || { tokenConversationId: null, rfcMap: {}, candidates: [] }; },
    uploadAttachment: async (path, bytes, type) => { log.uploads.push({ path, size: bytes.length, type }); },
    ingestInbound: async (p) => { log.ingested.push(p); return { duplicate: false, message_id: "IN1", conversation_id: p.conversation_id || "NEWCONV" }; },
    applyDeliveryEvent: async (a) => { log.events.push(a); return over.eventFound ?? true; },
  };
  const received = { id: "rx_1", to: ["John <john+kaaaaaaaa1111@studiokairegi.com>"], cc: [], bcc: [], from: "Ada <ada@client.com>", subject: "Re: Quote", message_id: "<abc@client.com>",
    created_at: new Date(NOW).toISOString(), html: "<p>Thanks!</p>", text: null,
    headers: { from: "Ada Lovelace <ada@client.com>", "in-reply-to": "<sent@studiokairegi.com>", references: "<a@x> <sent@studiokairegi.com>" },
    authentication: { spf: "pass", dkim: "pass", dmarc: "pass" }, attachments: [{ id: "att1" }] };
  const fetchFn = over.fetch || (async (url) => {
    log.fetches.push(String(url));
    if (url === "https://api.resend.com/emails/receiving/rx_1") return json(over.received || received);
    if (url === "https://api.resend.com/emails/receiving/rx_1/attachments") return json({ data: [{ id: "att1", filename: "brief.pdf", content_type: "application/pdf", size: 4, download_url: "https://files.example/att1", content_disposition: null }] });
    if (url === "https://files.example/att1") return new Response(new Uint8Array([1, 2, 3, 4]));
    return json({ message: "unexpected " + url }, 404);
  });
  return { deps: { env: (k) => ({ RESEND_API_KEY: "re_secret_key", RESEND_WEBHOOK_SECRET: SECRET, ...(over.env || {}) })[k], fetch: fetchFn, now: () => NOW, sleep: noSleep, store }, log };
}
async function hook(event, deps, opts = {}) {
  const body = JSON.stringify(event);
  const headers = opts.headers || (await sign(body, { id: opts.id || "msg_1" }));
  return handleWebhook(new Request("https://x/functions/v1/resend-webhook", { method: "POST", headers, body }), deps);
}
const receivedEvent = { type: "email.received", created_at: new Date(NOW).toISOString(), data: { email_id: "rx_1", to: ["john+kaaaaaaaa1111@studiokairegi.com"], attachments: [{ id: "att1" }] } };

test("webhook: rejects unsigned, forged and unconfigured requests before touching anything", async () => {
  const h = hookHarness();
  assert.equal((await handleWebhook(new Request("https://x", { method: "POST", body: "{}" }), h.deps)).status, 401);
  assert.equal((await hook(receivedEvent, h.deps, { headers: { "svix-id": "m", "svix-timestamp": String(Math.floor(NOW / 1000)), "svix-signature": "v1,AAAA" } })).status, 401);
  assert.equal(h.log.webhooks.size, 0);
  assert.equal(h.log.fetches.length, 0);
  assert.equal((await hook(receivedEvent, hookHarness({ env: { RESEND_WEBHOOK_SECRET: "" } }).deps)).status, 503);
  assert.equal((await handleWebhook(new Request("https://x", { method: "GET" }), h.deps)).status, 405);
});

test("webhook: an incoming reply is fetched, threaded by token, stored with its attachment and acknowledged", async () => {
  const h = hookHarness({ lookup: { tokenConversationId: CONV, rfcMap: {}, candidates: [] } });
  const res = await hook(receivedEvent, h.deps);
  assert.equal(res.status, 200);
  assert.equal(h.log.ingested.length, 1);
  const m = h.log.ingested[0];
  assert.equal(m.conversation_id, CONV);
  assert.equal(m.organization_id, ORG);
  assert.equal(m.provider_message_id, "rx_1");
  assert.equal(m.rfc_message_id, "<abc@client.com>");
  assert.equal(m.in_reply_to, "<sent@studiokairegi.com>");
  assert.equal(m.references_ids, "<a@x> <sent@studiokairegi.com>");
  assert.equal(m.from_email, "ada@client.com"); assert.equal(m.from_name, "Ada Lovelace");
  assert.equal(m.body_text, "Thanks!");                                   // text derived from html when the sender sent none
  assert.equal(m.body_html, "<p>Thanks!</p>");
  assert.equal(m.attachments[0].storage_path, `${ORG}/rx_1/att1-brief.pdf`);
  assert.equal(m.attachments[0].size_bytes, 4);
  assert.deepEqual(h.log.uploads, [{ path: `${ORG}/rx_1/att1-brief.pdf`, size: 4, type: "application/pdf" }]);
  assert.equal(h.log.lookup.token, "aaaaaaaa1111");
  assert.deepEqual(h.log.lookup.rfcIds, ["<sent@studiokairegi.com>", "<a@x>", "<sent@studiokairegi.com>"]);
  assert.deepEqual(m.participants.map((p) => p.email), ["ada@client.com", "john+kaaaaaaaa1111@studiokairegi.com"]);
  assert.equal(h.log.webhooks.get("msg_1").status, "processed");
});

test("webhook: a duplicate delivery is acknowledged without processing twice", async () => {
  const h = hookHarness();
  await hook(receivedEvent, h.deps, { id: "msg_dup" });
  const again = await hook(receivedEvent, h.deps, { id: "msg_dup" });
  assert.equal((await again.json()).duplicate, true);
  assert.equal(h.log.ingested.length, 1);
});

test("webhook: mail for no known inbox is ignored (acknowledged, nothing stored)", async () => {
  const h = hookHarness({ received: { id: "rx_1", to: ["stranger@elsewhere.com"], from: "x@y.com", subject: "s", headers: {} } });
  const res = await hook(receivedEvent, h.deps);
  assert.equal(res.status, 200);
  assert.equal(h.log.ingested.length, 0);
  assert.equal(h.log.webhooks.get("msg_1").status, "ignored");
});

test("webhook: a failure answers 500 so Resend retries, logs the failure, and the retry then succeeds", async () => {
  let down = true;
  const h = hookHarness({ fetch: async (url) => {
    if (String(url).endsWith("/rx_1") && down) return json({ message: "upstream" }, 503);
    if (String(url).endsWith("/rx_1")) return json({ id: "rx_1", to: ["john@studiokairegi.com"], from: "a@b.com", subject: "Hi", text: "yo", message_id: "<z@b.com>", headers: {} });
    return json({}, 404);
  } });
  const first = await hook({ ...receivedEvent, data: { email_id: "rx_1" } }, h.deps, { id: "msg_retry" });
  assert.equal(first.status, 500);
  assert.equal(h.log.webhooks.get("msg_retry").status, "failed");
  assert.equal(JSON.stringify(await first.json()).includes("re_secret_key"), false);
  down = false;
  const second = await hook({ ...receivedEvent, data: { email_id: "rx_1" } }, h.deps, { id: "msg_retry" });
  assert.equal(second.status, 200);
  assert.equal(h.log.webhooks.get("msg_retry").status, "processed");
  assert.equal(h.log.ingested.length, 1);
});

test("webhook: delivery, bounce and complaint events update the message; unrelated old events are ignored", async () => {
  const h = hookHarness();
  const ev = (type, extra = {}) => ({ type, created_at: new Date(NOW).toISOString(), data: { email_id: "re_sent_1", ...extra } });
  assert.equal((await hook(ev("email.delivered"), h.deps, { id: "e1" })).status, 200);
  assert.equal((await hook(ev("email.bounced", { bounce: { message: "Mailbox full", type: "Transient" } }), h.deps, { id: "e2" })).status, 200);
  assert.equal((await hook(ev("email.complained"), h.deps, { id: "e3" })).status, 200);
  assert.deepEqual(h.log.events.map((e) => [e.status, e.provider_event_id]), [["delivered", "e1"], ["bounced", "e2"], ["complained", "e3"]]);
  assert.equal(h.log.events[1].detail.reason, "Mailbox full");
  assert.equal((await hook(ev("email.opened"), h.deps, { id: "e4" })).status, 200);
  assert.equal(h.log.events.length, 3);                                    // opens are not stored as status changes

  const unknownRecent = hookHarness({ eventFound: false });
  assert.equal((await hook(ev("email.delivered"), unknownRecent.deps, { id: "e5" })).status, 500);   // our DB write may not have landed yet: retry
  const unknownOld = hookHarness({ eventFound: false });
  const old = { ...ev("email.delivered"), created_at: new Date(NOW - 10 * 60_000).toISOString() };
  assert.equal((await hook(old, unknownOld.deps, { id: "e6" })).status, 200);
  assert.equal(unknownOld.log.webhooks.get("e6").status, "ignored");
});

test("webhook: acknowledged and ignored while Resend is switched off", async () => {
  const h = hookHarness({ enabled: false });
  const res = await hook(receivedEvent, h.deps);
  assert.equal(res.status, 200);
  assert.equal(h.log.ingested.length, 0);
});

// ---------------------------------------------------------------- Gmail / Zoho are paused
test("Gmail and Zoho are refused with 410 unless their flag is on; unreadable flags count as paused", async () => {
  const svc = (enabled, error = null) => ({ rpc: async (name, args) => { assert.equal(name, "email_provider_enabled"); return { data: enabled[args.p_provider] ?? false, error }; } });
  const off = await providerPausedResponse(svc({ gmail: false, zoho: false }), "gmail");
  assert.equal(off.status, 410);
  assert.equal((await providerPausedResponse(svc({ zoho: true }), "gmail")).status, 410);
  assert.equal(await providerPausedResponse(svc({ gmail: true }), "gmail"), null);
  assert.equal((await providerPausedResponse(svc({ gmail: true }, { message: "function does not exist" }), "gmail")).status, 410);
  assert.equal((await providerPausedResponse({ rpc: async () => { throw new Error("down"); } }, "zoho")).status, 410);
});

test("every Gmail and Zoho Edge Function checks the pause flag first, and none was deleted", () => {
  for (const [prov, name] of [["gmail", "connect"], ["gmail", "callback"], ["gmail", "token"], ["zoho", "connect"], ["zoho", "callback"], ["zoho", "token"]]) {
    const src = fs.readFileSync(new URL(`../../supabase/functions/intel-${prov}-${name}/index.ts`, import.meta.url), "utf8");
    assert.match(src, new RegExp(`providerPausedResponse\\(pauseGuard, "${prov}"\\)\\) \\?\\? handle`), `${prov}-${name} must be guarded`);
  }
  for (const f of ["intel_gmail_logic.ts", "intel_zoho_logic.ts"]) assert.ok(fs.existsSync(new URL(`../../supabase/functions/_shared/${f}`, import.meta.url)), `${f} must be kept`);
  for (const f of ["gmail.py", "zoho.py"]) assert.ok(fs.existsSync(new URL(`../../intelligence-worker/kairflow_intel/${f}`, import.meta.url)), `${f} must be kept`);
});

test("the migration seeds Resend on and Gmail/Zoho off, never flips an existing flag, and deletes no Gmail/Zoho data", () => {
  const sql = fs.readFileSync(new URL("../../supabase/migrations/20261110090000_email_resend_core.sql", import.meta.url), "utf8");
  assert.match(sql, /\('resend', true/); assert.match(sql, /\('gmail',\s+false/); assert.match(sql, /\('zoho',\s+false/);
  assert.match(sql, /on conflict \(provider\) do nothing/);
  const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.equal(/intel_mail_account|intel_mail_oauth|drop\s+table\s+(if exists\s+)?public\.intel_/i.test(code), false);
  assert.equal(/\balter\s+table\s+public\.intel_/i.test(code), false);
  // every email table has RLS on and the webhook log is service-role only
  for (const t of ["email_accounts", "email_conversations", "email_messages", "email_attachments", "email_participants", "email_events", "email_sync_state", "email_webhook_events", "email_provider_flags"]) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${t}\\b`));
  }
  assert.match(sql, /alter table public\.email_webhook_events enable row level security/);
  assert.match(sql, /email_messages_provider_uidx/); assert.match(sql, /email_messages_rfc_uidx/); assert.match(sql, /email_messages_idem_uidx/);
  assert.match(sql, /svix_id text not null unique/);
});

test("the Resend migration follows every Intelligence migration", () => {
  const names = fs.readdirSync(new URL("../../supabase/migrations/", import.meta.url)).filter((n) => n.endsWith(".sql"));
  const intelLast = names.filter((n) => n.includes("_intelligence_")).map((n) => n.split("_")[0]).sort().at(-1);
  const email = names.filter((n) => n.includes("_email_resend_")).map((n) => n.split("_")[0]);
  assert.equal(email.length, 1);
  assert.ok(email[0] > intelLast);
});

test("browser code never contains provider secrets and Settings offers only providers the database flag enabled", () => {
  for (const f of ["logic.js", "api.js", "InboxModule.jsx"]) {
    const src = fs.readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
    assert.equal(/RESEND_API_KEY|RESEND_WEBHOOK_SECRET|api\.resend\.com|SERVICE_ROLE/.test(src), false, `${f} must not reference provider secrets`);
  }
  assert.deepEqual(activeMailProviders({ gmail: false, zoho: false, resend: true }, { gmail: "Gmail", zoho: "Zoho Mail" }), []);
  assert.deepEqual(activeMailProviders({ zoho: true }, { gmail: "Gmail", zoho: "Zoho Mail" }), [["zoho", "Zoho Mail"]]);
  assert.deepEqual(activeMailProviders(null, { gmail: "Gmail" }), []);                  // still loading = paused
  const settings = fs.readFileSync(new URL("../intelligence/SettingsView.jsx", import.meta.url), "utf8");
  assert.match(settings, /activeMailProviders\(flags\.data, MAIL_PROVIDERS\)/);
  assert.match(settings, /options=\{active\}/);
});

// ---------------------------------------------------------------- Inbox UI logic
test("composer helpers: recipients, replies, forwards, validation", () => {
  assert.deepEqual(parseRecipients("A@x.com, Bob <b@y.com>; bad, a@x.com"), { valid: ["a@x.com", "b@y.com"], invalid: ["bad"] });
  const inbound = { direction: "inbound", from_email: "ada@client.com", from_name: "Ada", to_emails: ["john@studiokairegi.com", "team@client.com"], cc_emails: ["boss@client.com"], subject: "Quote", body_text: "Hi\nthere" };
  const own = ["john@studiokairegi.com"];
  assert.deepEqual(replyRecipients(inbound, own), { to: ["ada@client.com"], cc: [] });
  assert.deepEqual(replyRecipients(inbound, own, { all: true }), { to: ["ada@client.com"], cc: ["team@client.com", "boss@client.com"] });
  const r = buildReply(inbound, own, { all: false, when: "Nov 4" });
  assert.equal(r.subject, "Re: Quote");
  assert.match(r.body, /Ada <ada@client.com> wrote:\n> Hi\n> there/);
  assert.equal(buildReply({ ...inbound, subject: "Re: Quote" }, own).subject, "Re: Quote");
  assert.equal(buildForward(inbound).subject, "Fwd: Quote");
  assert.deepEqual(replyRecipients({ direction: "outbound", to_emails: ["ada@client.com"], cc_emails: [] }, own), { to: ["ada@client.com"], cc: [] });
  assert.equal(participantLabel({ participants: [{ email: "john@studiokairegi.com" }, { email: "ada@client.com", name: "Ada" }] }, own), "Ada");
  const ok = { accountId: ACC, to: "a@x.com", cc: "", bcc: "", subject: "S", body: "B" };
  assert.equal(composeProblem(ok), "");
  assert.match(composeProblem({ ...ok, accountId: "" }), /sender/);
  assert.match(composeProblem({ ...ok, to: "" }), /recipient/);
  assert.match(composeProblem({ ...ok, cc: "nope" }), /Cc/);
  assert.match(composeProblem({ ...ok, subject: " " }), /subject/);
  assert.match(composeProblem({ ...ok, body: "" }), /message/);
  assert.match(attachmentProblem([{ size: 11 * 1024 * 1024 }]), /10 MB/);
  assert.equal(attachmentProblem([{ size: 100 }]), "");
  assert.deepEqual(statusLabel("bounced"), ["Bounced", "bad"]);
});

test("the Inbox is wired into the CRM tabs only for people allowed into Intelligence", () => {
  const app = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(app, /canAccessIntelligence\(intelAccess\) \? \[\["inbox", "Inbox"\], \["intelligence", "Intelligence"\]\]/);
  assert.match(app, /crmTab === "inbox" && canAccessIntelligence\(intelAccess\) && <InboxModule/);
  assert.match(app, /\(crmTab === "intelligence" \|\| crmTab === "inbox"\) && intelAccess === false/);
});
