import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  parseAddress, normalizeSubject, buildThreadHeaders, withThreadToken, extractThreadToken, baseAddress, threadToken, parseMessageIds, pickConversation,
  verifySvixSignature, cleanInboundDomain, resolveInboundAccount, routingRecipients, safeSegment, readCapped, validateSendRequest, buildResendPayload, sendViaResend, handleSend, handleWebhook, statusForEvent, htmlToText, safeFileName,
} from "../../supabase/functions/_shared/email_resend_logic.ts";
import { normalizeReceivedEmail, normalizeAttachment, normalizeHeaders } from "../../supabase/functions/_shared/email_resend_logic.ts";
import { providerPausedResponse } from "../../supabase/functions/_shared/provider_guard.ts";
import { makeWebhookStore } from "../../supabase/functions/_shared/email_resend_store.ts";
import { parseRecipients, replyRecipients, inlineReply, buildForward, composeProblem, participantLabel, activeMailProviders, normalizeSubject as uiNorm, attachmentProblem, statusLabel, newArrivals } from "./lib/logic.js";

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

test("replies can be routed to a separate inbound domain (when Zoho owns the root MX)", async () => {
  assert.equal(withThreadToken("john@studiokairegi.com", CONV, "abc123.resend.app"), `john+k${threadToken(CONV)}@abc123.resend.app`);
  assert.equal(cleanInboundDomain(" Mail.StudioKairegi.com "), "mail.studiokairegi.com");
  assert.equal(cleanInboundDomain("x@y.com"), ""); assert.equal(cleanInboundDomain("nodot"), ""); assert.equal(cleanInboundDomain("a b.com"), "");
  const { deps, log } = sendHarness({ env: { EMAIL_INBOUND_DOMAIN: "abc123.resend.app" } });
  await handleSend(post(goodReq()), deps);
  const sent = JSON.parse(log.fetches[0].init.body);
  assert.equal(sent.from, "Studio Kairegi <john@studiokairegi.com>");                  // still sent from the verified domain
  assert.match(sent.reply_to, /^john\+k[0-9a-f]{12}@abc123\.resend\.app$/);              // replies come back through Resend, not Zoho
  const bad = sendHarness({ env: { EMAIL_INBOUND_DOMAIN: "not a domain" } });
  await handleSend(post(goodReq()), bad.deps);
  assert.match(JSON.parse(bad.log.fetches[0].init.body).reply_to, /@studiokairegi\.com$/);   // an invalid setting is ignored, never used
  const hk = hookHarness({ env: { EMAIL_INBOUND_DOMAIN: "abc123.resend.app" }, lookup: { tokenConversationId: CONV, rfcMap: {}, candidates: [] } });
  await hook(receivedEvent, hk.deps);
  assert.equal(hk.log.inboundDomain, "abc123.resend.app");
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
/** In-memory model of public.email_webhook_claim / email_webhook_finish (same states and rules as the SQL). JS is single threaded, so each call is atomic like the row lock. */
function claimModel(nowFn, { leaseMs = 300_000, max = 12 } = {}) {
  const rows = new Map();
  let seq = 0;
  return {
    rows,
    claim(id, type) {
      const r = rows.get(id);
      if (!r) { const row = { type, status: "processing", attempts: 1, token: `t${++seq}`, lease: nowFn() + leaseMs, error: "" }; rows.set(id, row); return { state: "claimed", token: row.token, attempts: 1 }; }
      if (["processed", "ignored"].includes(r.status)) return { state: "done" };
      if (r.status === "processing" && r.lease > nowFn()) return { state: "busy" };
      if (r.attempts >= max) { r.status = "failed"; r.token = null; return { state: "exhausted" }; }
      r.status = "processing"; r.attempts++; r.token = `t${++seq}`; r.lease = nowFn() + leaseMs;
      return { state: "claimed", token: r.token, attempts: r.attempts };
    },
    finish(id, token, status, error = "") {
      const r = rows.get(id);
      if (!r || !token || r.status !== "processing" || r.token !== token) return false;
      Object.assign(r, { status, error, token: null, lease: null });
      return true;
    },
  };
}

function hookHarness(over = {}) {
  const clock = over.clock || (() => NOW);
  const model = claimModel(clock, over.claimOpts);
  const log = { webhooks: model.rows, ingested: [], uploads: [], events: [], intelEvents: [], fetches: [], finishCalls: [] };
  const accountsByAddress = over.accounts || { "john@studiokairegi.com": [{ id: ACC, organization_id: ORG, address: "john@studiokairegi.com" }] };
  const store = {
    providerEnabled: async () => { if (over.flagError) throw new Error("flag read failed"); return over.enabled ?? true; },
    claimWebhook: async (id, type) => { if (over.claimError) throw new Error("claim failed"); return model.claim(id, type); },
    finishWebhook: async (id, token, status, error) => { log.finishCalls.push([id, status]); if (over.finishError) throw new Error("finish failed"); return model.finish(id, token, status, error); },
    accountsForRecipient: async (addr, inbound) => { log.inboundDomain = inbound; if (over.accountError) throw new Error("account lookup failed"); return accountsByAddress[baseAddress(addr)] || []; },
    threadLookup: async (orgId, accountId, q) => { log.lookup = q; log.lookupScope = [orgId, accountId]; if (over.threadError) throw new Error("thread lookup failed"); return over.lookup || { tokenConversationId: null, rfcMap: {}, candidates: [] }; },
    uploadAttachment: async (path, bytes, type) => { log.uploads.push({ path, size: bytes.length, type }); },
    ingestInbound: async (p) => { if (over.ingestError) throw new Error("ingest failed"); log.ingested.push(p); return { duplicate: false, message_id: "IN1", conversation_id: p.conversation_id || "NEWCONV" }; },
    applyDeliveryEvent: async (a) => { log.events.push(a); return over.applyResult || { found: over.eventFound ?? true }; },
    applyIntelDeliveryEvent: async (a) => { log.intelEvents.push(a); if (over.intelError) throw new Error("intel rpc failure"); return over.intelResult || { found: over.intelFound ?? false }; },
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
  return { model, deps: { env: (k) => ({ RESEND_API_KEY: "re_secret_key", RESEND_WEBHOOK_SECRET: SECRET, ...(over.env || {}) })[k], fetch: fetchFn, now: clock, sleep: noSleep, store }, log };
}
async function hook(event, deps, opts = {}) {
  const body = JSON.stringify(event);
  const headers = opts.headers || (await sign(body, { id: opts.id || "msg_1", ts: opts.ts }));
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
  assert.deepEqual(h.log.intelEvents.map((e) => [e.event_type, e.provider_event_id]), [["email.delivered", "e1"], ["email.bounced", "e2"], ["email.complained", "e3"]]);
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

test("the Resend migrations follow every Intelligence migration and use unique new timestamps", () => {
  const names = fs.readdirSync(new URL("../../supabase/migrations/", import.meta.url)).filter((n) => n.endsWith(".sql"));
  const intelLast = names.filter((n) => n.includes("_intelligence_")).map((n) => n.split("_")[0]).sort().at(-1);
  const email = names.filter((n) => n.includes("_email_resend_")).map((n) => n.split("_")[0]);
  assert.ok(email.length >= 2);
  assert.deepEqual(email, [...email].sort(), "Resend migrations must be chronologically ordered");
  assert.equal(new Set(email).size, email.length, "email migration timestamps must be unique");
  for (const e of email) assert.equal(names.filter((n) => n.startsWith(e + "_")).length, 1, `timestamp ${e} is used by exactly one file`);
});

test("browser code never contains provider secrets and Intelligence Settings uses the dynamic provider registry", () => {
  const browserFiles = ["InboxModule.jsx", ...["lib", "components"].flatMap((d) => fs.readdirSync(new URL(`./${d}/`, import.meta.url)).filter((n) => /\.(js|jsx)$/.test(n)).map((n) => `${d}/${n}`))];
  assert.ok(browserFiles.length >= 8, "the Inbox browser code is scanned, including its subfolders");
  for (const f of browserFiles) {
    const src = fs.readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
    assert.equal(/RESEND_API_KEY|RESEND_WEBHOOK_SECRET|api\.resend\.com|SERVICE_ROLE/.test(src), false, `${f} must not reference provider secrets`);
  }
  const settings = fs.readFileSync(new URL("../intelligence/SettingsView.jsx", import.meta.url), "utf8");
  assert.match(settings, /intelApi\.providerCatalog\(supabase\)/);
  assert.match(settings, /intelApi\.providerAccounts\(supabase\)/);
  assert.match(settings, /supports_multiple_accounts === true/);
  assert.doesNotMatch(settings, /<AccessCard/);
  assert.doesNotMatch(settings, /activeMailProviders\(flags\.data, MAIL_PROVIDERS\)/);
});

// ---------------------------------------------------------------- Inbox UI logic
test("composer helpers: recipients, replies, forwards, validation", () => {
  assert.deepEqual(parseRecipients("A@x.com, Bob <b@y.com>; bad, a@x.com"), { valid: ["a@x.com", "b@y.com"], invalid: ["bad"] });
  const inbound = { direction: "inbound", from_email: "ada@client.com", from_name: "Ada", to_emails: ["john@studiokairegi.com", "team@client.com"], cc_emails: ["boss@client.com"], subject: "Quote", body_text: "Hi\nthere" };
  const own = ["john@studiokairegi.com"];
  assert.deepEqual(replyRecipients(inbound, own), { to: ["ada@client.com"] });
  // The inline reply box fills in recipients and "Re:" itself: the user only types the message.
  assert.deepEqual(inlineReply([inbound], own, { subject: "Quote" }), { to: ["ada@client.com"], subject: "Re: Quote" });
  assert.equal(inlineReply([inbound], own, { subject: "Re: Quote" }).subject, "Re: Quote");
  assert.deepEqual(inlineReply([inbound, { direction: "outbound", status: "sent", to_emails: ["ada@client.com"] }], own, { subject: "Quote" }).to, ["ada@client.com"]);
  assert.deepEqual(inlineReply([{ direction: "outbound", status: "draft", to_emails: ["x@y.com"] }], own, { subject: "Quote" }).to, []);
  assert.equal(buildForward(inbound).subject, "Fwd: Quote");
  assert.deepEqual(replyRecipients({ direction: "outbound", to_emails: ["ada@client.com"], cc_emails: [] }, own), { to: ["ada@client.com"] });
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

// =================================================================================================================
// HARDENING: organization isolation, atomic claims, database errors, delivery rules, signatures, attachments
// =================================================================================================================
const mkAcc = (id, org, address) => ({ id, organization_id: org, address });

test("account resolution is deterministic and never crosses an organization", () => {
  const a1 = mkAcc("a1", "orgA", "john@x.com"), b1 = mkAcc("b1", "orgB", "john@x.com"), a2 = mkAcc("a2", "orgA", "sales@x.com");
  assert.deepEqual(resolveInboundAccount([]), { status: "none" });
  assert.deepEqual(resolveInboundAccount([[], []]), { status: "none" });
  assert.equal(resolveInboundAccount([[a1]]).account.id, "a1");
  assert.equal(resolveInboundAccount([[a1], [a2]]).account.id, "a1");        // same organization: the first recipient wins, always the same answer
  assert.equal(resolveInboundAccount([[a2], [a1]]).account.id, "a2");
  assert.equal(resolveInboundAccount([[a1, a1]]).account.id, "a1");          // the same account twice is not ambiguity
  assert.equal(resolveInboundAccount([[a1, b1]]).status, "ambiguous");       // one recipient, two organizations
  assert.equal(resolveInboundAccount([[a1], [b1]]).status, "ambiguous");     // two recipients, two organizations
  assert.equal(resolveInboundAccount([[a1, a2]]).status, "ambiguous");       // one recipient, two accounts: never guessed
});

test("routing recipients are validated, plus-tags removed, de-duplicated and capped", () => {
  assert.deepEqual(routingRecipients(["John+k1@X.com", "john@x.com", "not-an-email", "a b@x.com"], ["c@y.org"]), ["john@x.com", "c@y.org"]);
  assert.equal(routingRecipients(Array.from({ length: 40 }, (_, i) => `u${i}@x.com`)).length, 20);
  assert.equal(safeSegment("../a/b c"), "___a_b_c");
  assert.equal(safeSegment(""), "x");
});

// A tiny in-memory Supabase stand-in: enough query-builder surface for the store, with injectable errors.
function fakeService(tables, { rpc = {}, errors = {} } = {}) {
  const calls = [];
  const like = (pat) => new RegExp("^" + pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$");
  const from = (name) => {
    const q = { filters: [], lim: null };
    const run = () => {
      if (errors[name]) return { data: null, error: { message: errors[name] } };
      const rows = (tables[name] || []).filter((r) => q.filters.every((f) => f(r)));
      return { data: q.lim == null ? rows : rows.slice(0, q.lim), error: null };
    };
    const api = {
      select: () => api,
      eq: (c, v) => { calls.push([name, "eq", c, v]); q.filters.push((r) => r[c] === v); return api; },
      neq: (c, v) => { q.filters.push((r) => r[c] !== v); return api; },
      in: (c, vs) => { q.filters.push((r) => vs.includes(r[c])); return api; },
      like: (c, pat) => { calls.push([name, "like", c, pat]); q.filters.push((r) => like(pat).test(String(r[c]))); return api; },
      order: () => api,
      limit: (n) => { q.lim = n; return api; },
      maybeSingle: async () => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
      then: (res, rej) => Promise.resolve(run()).then(res, rej),
    };
    return api;
  };
  const rpcFn = async (name, args) => { calls.push(["rpc", name, args]); const h = rpc[name]; return typeof h === "function" ? h(args) : (h ?? { data: null, error: null }); };
  return { from, rpc: rpcFn, calls, storage: { from: () => ({ upload: async () => ({ data: {}, error: null }) }) } };
}
const ORG_B = "20000000-0000-0000-0000-00000000000b";
const ACC_B = "30000000-0000-0000-0000-0000000000bb";
const accountTable = () => [
  { id: ACC, organization_id: ORG, address: "john@studiokairegi.com", status: "active", provider: "resend", is_default: true },
  { id: "30000000-0000-0000-0000-0000000000c1", organization_id: ORG_B, address: "paused@studiokairegi.com", status: "paused", provider: "resend", is_default: true },
  { id: ACC_B, organization_id: ORG_B, address: "sales@studiokairegi.com", status: "active", provider: "resend", is_default: true },
];

test("store: an inbox is found only by exact address; no domain catch-all and no default-account fallback", async () => {
  const store = makeWebhookStore(fakeService({ email_accounts: accountTable() }));
  assert.deepEqual((await store.accountsForRecipient("John+kabc@StudioKairegi.com", "")).map((a) => a.id), [ACC]);   // plus-tag removed
  assert.deepEqual(await store.accountsForRecipient("anyone@studiokairegi.com", ""), []);                           // another organization's default is never used
  assert.deepEqual(await store.accountsForRecipient("paused@studiokairegi.com", ""), []);                            // inactive accounts receive nothing
  assert.deepEqual(await store.accountsForRecipient("nobody@elsewhere.org", ""), []);
});

test("store: on the inbound domain the same local part matches, and two matches are reported (so resolution is ambiguous), never one picked", async () => {
  const tables = { email_accounts: [...accountTable(), { id: "30000000-0000-0000-0000-0000000000d1", organization_id: ORG_B, address: "john@other.com", status: "active", provider: "resend", is_default: false }] };
  const store = makeWebhookStore(fakeService(tables));
  const found = await store.accountsForRecipient("john+k1@abc.resend.app", "abc.resend.app");
  assert.equal(found.length, 2);
  assert.equal(resolveInboundAccount([found]).status, "ambiguous");
  const unique = await makeWebhookStore(fakeService({ email_accounts: accountTable() })).accountsForRecipient("sales+k1@abc.resend.app", "abc.resend.app");
  assert.deepEqual(unique.map((a) => a.id), [ACC_B]);
  assert.deepEqual(await makeWebhookStore(fakeService({ email_accounts: accountTable() })).accountsForRecipient("sales@abc.resend.app", ""), []);   // no inbound domain configured: no local-part matching
  assert.deepEqual(await makeWebhookStore(fakeService({ email_accounts: accountTable() })).accountsForRecipient("sa_es@abc.resend.app", "abc.resend.app"), []);   // LIKE wildcards cannot widen the match
});

test("store: thread lookups are scoped to the organization AND the account", async () => {
  const tables = {
    email_messages: [
      { rfc_message_id: "<x@y>", conversation_id: "C-A", organization_id: ORG, account_id: ACC },
      { rfc_message_id: "<x@y>", conversation_id: "C-B", organization_id: ORG_B, account_id: ACC_B },
    ],
    email_conversations: [
      { id: "C-A", organization_id: ORG, account_id: ACC, normalized_subject: "quote", last_message_at: "2026-11-01T00:00:00Z" },
      { id: "C-B", organization_id: ORG_B, account_id: ACC_B, normalized_subject: "quote", last_message_at: "2026-11-02T00:00:00Z" },
    ],
    email_participants: [{ conversation_id: "C-A", email: "ada@x.com" }, { conversation_id: "C-B", email: "ada@x.com" }],
  };
  const svc = fakeService(tables, { rpc: { email_find_conversation_by_token: (a) => ({ data: a.p_account_id === ACC ? "C-A" : null, error: null }) } });
  const store = makeWebhookStore(svc);
  const q = { token: "aaaaaaaaaaaa", rfcIds: ["<x@y>"], normalizedSubject: "quote", sender: "ada@x.com" };
  const a = await store.threadLookup(ORG, ACC, q);
  assert.deepEqual(a.rfcMap, { "<x@y>": "C-A" });
  assert.deepEqual(a.candidates.map((c) => c.conversation_id), ["C-A"]);
  assert.equal(a.tokenConversationId, "C-A");
  const b = await store.threadLookup(ORG_B, ACC_B, q);
  assert.deepEqual(b.rfcMap, { "<x@y>": "C-B" });
  assert.equal(b.tokenConversationId, null);
  const wrongAccount = await store.threadLookup(ORG, "30000000-0000-0000-0000-0000000000ee", q);
  assert.deepEqual(wrongAccount.rfcMap, {}); assert.deepEqual(wrongAccount.candidates, []);
  const tokenCall = svc.calls.find((c) => c[0] === "rpc" && c[1] === "email_find_conversation_by_token");
  assert.deepEqual([tokenCall[2].p_organization_id, tokenCall[2].p_account_id], [ORG, ACC]);
});

test("store: every database error is raised, never read as an empty result", async () => {
  const fails = (svc, fn, re) => assert.rejects(() => fn(makeWebhookStore(svc)), re);
  await fails(fakeService({}, { rpc: { email_provider_enabled: { data: null, error: { message: "db down" } } } }), (s) => s.providerEnabled(), /provider flag/);
  await fails(fakeService({}, { rpc: { email_webhook_claim: { data: null, error: { message: "db down" } } } }), (s) => s.claimWebhook("m", "t", {}), /webhook claim/);
  await fails(fakeService({}, { rpc: { email_webhook_claim: { data: { state: "weird" }, error: null } } }), (s) => s.claimWebhook("m", "t", {}), /unexpected answer/);
  await fails(fakeService({}, { rpc: { email_webhook_finish: { data: null, error: { message: "db down" } } } }), (s) => s.finishWebhook("m", "tok", "processed"), /webhook finish/);
  await fails(fakeService({}, { errors: { email_accounts: "db down" } }), (s) => s.accountsForRecipient("john@studiokairegi.com", ""), /account lookup/);
  await fails(fakeService({}, { errors: { email_messages: "db down" } }), (s) => s.threadLookup(ORG, ACC, { token: null, rfcIds: ["<a@b>"], normalizedSubject: "", sender: "x@y.com" }), /thread headers/);
  await fails(fakeService({}, { errors: { email_conversations: "db down" } }), (s) => s.threadLookup(ORG, ACC, { token: null, rfcIds: [], normalizedSubject: "q", sender: "x@y.com" }), /thread subject/);
  await fails(fakeService({}, { rpc: { email_find_conversation_by_token: { data: null, error: { message: "db down" } } } }), (s) => s.threadLookup(ORG, ACC, { token: "aaaaaaaaaaaa", rfcIds: [], normalizedSubject: "", sender: "x@y.com" }), /thread token/);
  await fails(fakeService({}, { rpc: { email_ingest_inbound: { data: null, error: { message: "Inbound account is not active" } } } }), (s) => s.ingestInbound({}), /not active/);
  await fails(fakeService({}, { rpc: { email_apply_delivery_event: { data: null, error: { message: "Unsupported delivery status" } } } }), (s) => s.applyDeliveryEvent({}), /Unsupported/);
  const ok = makeWebhookStore(fakeService({}, { rpc: { email_webhook_finish: { data: { ok: false }, error: null }, email_webhook_claim: { data: { state: "claimed", token: "T", attempts: 2 }, error: null } } }));
  assert.equal(await ok.finishWebhook("m", "tok", "processed"), false);                       // a lost claim is reported, not hidden
  assert.deepEqual(await ok.claimWebhook("m", "t", {}), { state: "claimed", token: "T", attempts: 2 });
});

test("webhook + real store: an address owned by two organizations is ignored, nothing is stored", async () => {
  const tables = { email_accounts: [
    { id: ACC, organization_id: ORG, address: "john@studiokairegi.com", status: "active", provider: "resend" },
    { id: ACC_B, organization_id: ORG_B, address: "john@studiokairegi.com", status: "active", provider: "resend" },
  ] };
  const claims = claimModel(() => NOW);
  const svc = fakeService(tables, { rpc: {
    email_provider_enabled: { data: true, error: null },
    email_webhook_claim: (a) => ({ data: claims.claim(a.p_svix_id, a.p_type), error: null }),
    email_webhook_finish: (a) => ({ data: { ok: claims.finish(a.p_svix_id, a.p_token, a.p_status, a.p_error) }, error: null }),
    email_ingest_inbound: () => { throw new Error("must not be called"); },
  } });
  const h = hookHarness();
  const deps = { ...h.deps, store: makeWebhookStore(svc) };
  const res = await hook(receivedEvent, deps);
  assert.equal(res.status, 200);
  assert.equal(claims.rows.get("msg_1").status, "ignored");
  assert.match(claims.rows.get("msg_1").error, /ambiguous inbox/);
  assert.equal(svc.calls.some((c) => c[1] === "email_ingest_inbound"), false);
});

test("webhook: ambiguous or unmatched inboxes are ignored with a reason and nothing is ingested", async () => {
  const two = { "john@studiokairegi.com": [mkAcc(ACC, ORG, "john@studiokairegi.com"), mkAcc(ACC_B, ORG_B, "john@studiokairegi.com")] };
  const amb = hookHarness({ accounts: two });
  assert.equal((await hook(receivedEvent, amb.deps)).status, 200);
  assert.equal(amb.log.ingested.length, 0);
  assert.equal(amb.log.webhooks.get("msg_1").status, "ignored");
  assert.match(amb.log.webhooks.get("msg_1").error, /ambiguous inbox/);
  const none = hookHarness({ accounts: {} });
  await hook(receivedEvent, none.deps);
  assert.equal(none.log.webhooks.get("msg_1").error, "no matching inbox");
  assert.deepEqual(amb.log.lookupScope, undefined);                                       // no thread lookup before an account is settled
});

test("webhook: thread lookups use the resolved organization and account", async () => {
  const h = hookHarness({ lookup: { tokenConversationId: CONV, rfcMap: {}, candidates: [] } });
  await hook(receivedEvent, h.deps);
  assert.deepEqual(h.log.lookupScope, [ORG, ACC]);
  assert.equal(h.log.ingested[0].organization_id, ORG); assert.equal(h.log.ingested[0].account_id, ACC);
});

// ---------------------------------------------------------------- claims and concurrency
test("claim state machine: completed, failed, busy, expired, stale owner, exhausted", () => {
  let t = NOW;
  const m = claimModel(() => t, { leaseMs: 100_000, max: 3 });
  const c1 = m.claim("e", "email.received");
  assert.equal(c1.state, "claimed");
  assert.equal(m.claim("e", "email.received").state, "busy");                 // a second delivery while the first is running
  t += 100_001;                                                              // the first worker crashed: its lease expired
  const c2 = m.claim("e", "email.received");
  assert.equal(c2.state, "claimed"); assert.equal(c2.attempts, 2);
  assert.equal(m.finish("e", c1.token, "processed"), false);                  // the old owner cannot overwrite the newer claim
  assert.equal(m.rows.get("e").status, "processing");
  assert.equal(m.finish("e", c2.token, "failed", "boom"), true);
  assert.equal(m.finish("e", c2.token, "processed"), false);                  // a claim can finish only once
  const c3 = m.claim("e", "email.received");                                  // failed events are retryable
  assert.equal(c3.state, "claimed"); assert.equal(c3.attempts, 3);
  assert.equal(m.finish("e", c3.token, "failed", "boom"), true);
  assert.equal(m.claim("e", "email.received").state, "exhausted");            // bounded: attempts reached the limit
  assert.equal(m.claim("other", "x").state, "claimed");
  const done = m.claim("d", "x"); m.finish("d", done.token, "processed");
  assert.equal(m.claim("d", "x").state, "done");
  assert.equal(m.finish("d", null, "processed"), false);
});

test("webhook: two simultaneous deliveries of one event process it once (the second is told to retry later)", async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const base = hookHarness();
  const inner = base.deps.fetch;
  base.deps.fetch = async (url, init) => { if (String(url).endsWith("/rx_1")) await gate; return inner(url, init); };
  const first = hook(receivedEvent, base.deps, { id: "msg_same" });
  for (let i = 0; i < 50 && base.log.webhooks.size === 0; i++) await new Promise((r) => setImmediate(r));
  const second = await hook(receivedEvent, base.deps, { id: "msg_same" });
  assert.equal(second.status, 409);                                           // busy: not 2xx, so a crash of the first still gets retried
  release();
  assert.equal((await first).status, 200);
  assert.equal(base.log.ingested.length, 1);
  assert.equal(base.log.webhooks.get("msg_same").status, "processed");
  const third = await hook(receivedEvent, base.deps, { id: "msg_same" });
  assert.equal((await third.json()).duplicate, true);                         // completed: idempotent success, nothing runs again
  assert.equal(base.log.ingested.length, 1);
});

test("webhook: a crashed worker's claim is recovered after the lease, not before", async () => {
  let t = NOW;
  const h = hookHarness({ clock: () => t, lookup: { tokenConversationId: CONV, rfcMap: {}, candidates: [] } });
  h.model.claim("msg_crash", "email.received");                               // worker A claims and dies
  assert.equal((await hook(receivedEvent, h.deps, { id: "msg_crash" })).status, 409);
  t += 301_000;
  const res = await hook(receivedEvent, h.deps, { id: "msg_crash", ts: Math.floor(t / 1000) });
  assert.equal(res.status, 200);
  assert.equal(h.log.webhooks.get("msg_crash").status, "processed");
  assert.equal(h.log.webhooks.get("msg_crash").attempts, 2);
});

test("webhook: a slow worker whose claim was taken over cannot overwrite the newer result", async () => {
  let t = NOW; let release; const gate = new Promise((r) => { release = r; });
  let markFetchStarted;
  const fetchStarted = new Promise((r) => { markFetchStarted = r; });
  const h = hookHarness({ clock: () => t });
  const inner = h.deps.fetch; let slow = true;
  h.deps.fetch = async (url, init) => {
    if (slow && String(url).endsWith("/rx_1")) { slow = false; markFetchStarted(); await gate; }
    return inner(url, init);
  };
  const first = hook(receivedEvent, h.deps, { id: "msg_slow" });
  // Wait for the first owner to enter its deliberately blocked provider call. Merely
  // observing the inserted claim row can race the first request's post-claim continuation.
  await fetchStarted;
  t += 301_000;                                                               // the first worker is still running but its lease has expired
  const second = await hook(receivedEvent, h.deps, { id: "msg_slow", ts: Math.floor(t / 1000) });
  assert.equal(second.status, 200);
  release();
  const late = await first;
  assert.equal(late.status, 409);                                             // its finish was refused: the claim is no longer its own
  assert.equal(h.log.webhooks.get("msg_slow").status, "processed");
  assert.equal(h.log.webhooks.get("msg_slow").attempts, 2);
});

test("webhook: failed events are retried, then stop at the attempt limit with an explicit acknowledgement", async () => {
  const h = hookHarness({ claimOpts: { max: 2 }, ingestError: true });
  assert.equal((await hook(receivedEvent, h.deps, { id: "msg_bad" })).status, 500);
  assert.equal((await hook(receivedEvent, h.deps, { id: "msg_bad" })).status, 500);
  assert.equal(h.log.webhooks.get("msg_bad").attempts, 2);
  const fetchesBefore = h.log.fetches.length;
  const third = await hook(receivedEvent, h.deps, { id: "msg_bad" });
  assert.equal(third.status, 200); assert.equal((await third.json()).exhausted, true);
  assert.equal(h.log.fetches.length, fetchesBefore);                          // nothing is processed once exhausted
  assert.equal(h.log.webhooks.get("msg_bad").status, "failed");
});

// ---------------------------------------------------------------- database failures are never acknowledged as success
test("webhook: a database failure at any step answers 500, never success", async () => {
  const cases = [
    ["flag read", { flagError: true }, 0],
    ["claim", { claimError: true }, 0],
    ["account lookup", { accountError: true }, 1],
    ["thread lookup", { threadError: true }, 1],
    ["ingest", { ingestError: true }, 1],
  ];
  for (const [name, over, claimedRows] of cases) {
    const h = hookHarness(over);
    const res = await hook(receivedEvent, h.deps);
    assert.equal(res.status, 500, `${name} must answer 500`);
    assert.equal(JSON.stringify(await res.json()).includes("re_secret_key"), false);
    assert.equal(h.log.webhooks.size, claimedRows, `${name}: claim rows`);
    if (claimedRows) assert.equal(h.log.webhooks.get("msg_1").status, "failed", `${name}: recorded as failed, retryable`);
    assert.equal(h.log.ingested.length, 0);
  }
  const fin = hookHarness({ finishError: true, lookup: { tokenConversationId: CONV, rfcMap: {}, candidates: [] } });
  assert.equal((await hook(receivedEvent, fin.deps)).status, 500);            // the work ran but its completion could not be recorded: not acknowledged
});

// ---------------------------------------------------------------- signatures at the HTTP boundary
test("webhook signatures: missing headers, wrong secret, stale timestamp, altered body and odd timestamps all fail before any database work", async () => {
  const body = JSON.stringify(receivedEvent);
  const good = await sign(body, { id: "msg_sig" });
  const run = async (headers, b = body, over = {}) => {
    const h = hookHarness({ flagError: true, ...over });               // flagError proves no database call happens before verification
    const res = await handleWebhook(new Request("https://x", { method: "POST", headers, body: b }), h.deps);
    return { status: res.status, h };
  };
  for (const drop of ["svix-id", "svix-timestamp", "svix-signature"]) {
    const headers = { ...good }; delete headers[drop];
    assert.equal((await run(headers)).status, 401, `missing ${drop}`);
  }
  assert.equal((await run(await sign(body, { id: "msg_sig", secret: "whsec_" + Buffer.from("a-different-secret-a-different-12").toString("base64") }))).status, 401);
  assert.equal((await run(await sign(body, { id: "msg_sig", ts: Math.floor(NOW / 1000) - 400 }))).status, 401);          // expired
  assert.equal((await run(await sign(body, { id: "msg_sig", ts: Math.floor(NOW / 1000) + 400 }))).status, 401);          // too far in the future
  assert.equal((await run(good, body.replace("rx_1", "rx_2"))).status, 401);                                             // modified body
  assert.equal((await run({ ...good, "svix-timestamp": "1e3" })).status, 401);
  assert.equal((await run({ ...good, "svix-timestamp": "0x10" })).status, 401);
  const r = await run(good);
  assert.equal(r.status, 500);                                            // a VALID signature reaches the database layer (here a simulated failure)
  assert.equal((await run(good, body, { env: { RESEND_WEBHOOK_SECRET: "" } })).status, 503);                             // missing secret fails closed
  assert.equal((await run(good, body, { env: { RESEND_API_KEY: "" } })).status, 503);
  const big = "x".repeat(1_000_001);
  assert.equal((await run(await sign(big, { id: "m" }), big)).status, 413);                                             // size limit
  assert.equal((await handleWebhook(new Request("https://x", { method: "POST", headers: { ...good, "content-length": "2000000" }, body }), hookHarness().deps)).status, 413);
  for (const method of ["GET", "PUT", "DELETE", "PATCH"]) assert.equal((await handleWebhook(new Request("https://x", { method }), hookHarness().deps)).status, 405);
});

// ---------------------------------------------------------------- delivery events
test("delivery: every supported event maps to the right status; unsupported or id-less events never touch the store", async () => {
  const map = { "email.sent": "sent", "email.delivered": "delivered", "email.delivery_delayed": "delivery_delayed", "email.bounced": "bounced", "email.complained": "complained", "email.failed": "failed", "email.suppressed": "rejected", "email.rejected": "rejected" };
  for (const [type, status] of Object.entries(map)) assert.equal(statusForEvent(type), status);
  const h = hookHarness();
  const ev = (type, data) => ({ type, created_at: new Date(NOW).toISOString(), data });
  for (const [i, e] of [ev("email.opened", { email_id: "re_1" }), ev("email.clicked", { email_id: "re_1" }), ev("email.scheduled", { email_id: "re_1" }), ev("something.else", { email_id: "re_1" }), ev("email.delivered", {}), ev("email.delivered", { email_id: "" })].entries()) {
    assert.equal((await hook(e, h.deps, { id: `u${i}` })).status, 200);
    assert.equal(h.log.webhooks.get(`u${i}`).status, "ignored");
  }
  assert.equal(h.log.events.length, 0);
  assert.equal(h.log.webhooks.get("u4").error, "missing email id");
  assert.equal(h.log.webhooks.get("u0").error, "unsupported event type");
});

test("delivery: ambiguous ids are ignored and logged, duplicate event ids are harmless, the event id is the Svix id", async () => {
  const ev = { type: "email.delivered", created_at: new Date(NOW).toISOString(), data: { email_id: "re_dup" } };
  const amb = hookHarness({ applyResult: { found: false, ambiguous: true } });
  assert.equal((await hook(ev, amb.deps, { id: "d1" })).status, 200);
  assert.equal(amb.log.webhooks.get("d1").status, "ignored");
  assert.equal(amb.log.webhooks.get("d1").error, "ambiguous provider message id");
  const dup = hookHarness({ applyResult: { found: true, duplicate: true, applied: false } });
  assert.equal((await hook(ev, dup.deps, { id: "d2" })).status, 200);
  assert.equal(dup.log.webhooks.get("d2").status, "processed");
  assert.equal(dup.log.events[0].provider_event_id, "d2");
  assert.equal(dup.log.events[0].status, "delivered");
});

// ---------------------------------------------------------------- attachments
test("attachments: size caps, safe storage paths, and a failed download leaves the event retryable", async () => {
  const mk = (n, headers = {}) => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(n)); c.close(); } }), { headers });
  assert.equal(await readCapped(mk(10), 100) instanceof Uint8Array, true);
  assert.equal(await readCapped(mk(200), 100), null);                                   // stream exceeds the cap
  assert.equal(await readCapped(mk(10, { "content-length": "500" }), 100), null);       // declared size over the cap: never read
  assert.equal((await readCapped(mk(100), 100)).length, 100);

  const weird = hookHarness({ lookup: { tokenConversationId: CONV, rfcMap: {}, candidates: [] } });
  const innerFetch = weird.deps.fetch;
  weird.deps.fetch = async (url, init) => String(url).endsWith("/attachments")
    ? json({ data: [{ id: "a/../b", filename: "../../etc/passwd", content_type: "text/plain", size: 4, download_url: "https://files.example/att1" }] })
    : innerFetch(url, init);
  await hook(receivedEvent, weird.deps);
  const path = weird.log.uploads[0].path;
  assert.equal(path.startsWith(`${ORG}/rx_1/`), true);
  const parts = path.split("/");
  assert.equal(parts.length, 3);                                                       // no extra folders can be smuggled in
  assert.equal(parts.some((x) => x === "." || x === ".." || x === ""), false);         // no traversal segment

  const over = hookHarness({ lookup: { tokenConversationId: CONV, rfcMap: {}, candidates: [] } });
  const f2 = over.deps.fetch; const seen = [];
  over.deps.fetch = async (url, init) => { seen.push(String(url)); return String(url).endsWith("/attachments") ? json({ data: [{ id: "big", filename: "huge.bin", size: 30 * 1024 * 1024, download_url: "https://files.example/huge" }] }) : f2(url, init); };
  await hook(receivedEvent, over.deps);
  assert.equal(seen.includes("https://files.example/huge"), false);                    // too big: not downloaded
  assert.equal(over.log.ingested[0].attachments[0].storage_path, null);                // recorded without a stored copy
  assert.equal(over.log.uploads.length, 0);

  const failing = hookHarness({ lookup: { tokenConversationId: CONV, rfcMap: {}, candidates: [] } });
  const f3 = failing.deps.fetch;
  failing.deps.fetch = async (url, init) => (String(url) === "https://files.example/att1" ? new Response("gone", { status: 404 }) : f3(url, init));
  assert.equal((await hook(receivedEvent, failing.deps)).status, 500);
  assert.equal(failing.log.ingested.length, 0);                                        // nothing stored without its attachment
  assert.equal(failing.log.webhooks.get("msg_1").status, "failed");                    // so the event is retried, not completed
});

// ---------------------------------------------------------------- sending never turns a database error into a false answer
test("email-send: a database failure is a safe 500, and a sent mail whose status could not be saved still reports success", async () => {
  const h = sendHarness();
  h.deps.store.getAccount = async () => { throw new Error("db down"); };
  const res = await handleSend(post(goodReq()), h.deps);
  assert.equal(res.status, 500);
  assert.equal(h.log.fetches.length, 0);
  assert.equal(JSON.stringify(await res.json()).includes("db down"), false);
  const s = sendHarness();
  const mark = s.deps.store.markResult;
  s.deps.store.markResult = async (id, patch) => { if (patch.status === "sent") throw new Error("db down"); return mark(id, patch); };
  const out = await handleSend(post(goodReq()), s.deps);
  assert.equal(out.status, 200);
  const body = await out.json();
  assert.equal(body.status, "sent"); assert.equal(body.warning, "sent_status_not_saved");
  assert.equal(s.log.fetches.length, 1);
});

// ---------------------------------------------------------------- migration contents (static; the SQL itself is exercised by supabase/tests/email_resend_hardening.test.sql)
test("hardening migration: ownership validation, strict delivery rules, atomic claims, service-only access, nothing destructive", () => {
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  const sql = fs.readFileSync(new URL("20261111090000_email_resend_hardening.sql", dir), "utf8");
  const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const original = fs.readFileSync(new URL("20261110090000_email_resend_core.sql", dir), "utf8");
  assert.equal(original.includes("email_webhook_claim"), false, "the first migration must stay untouched");
  for (const must of ["does not belong to this organization", "is not active", "is not a Resend account", "belongs to a different sender address", "Invalid inbound payload"]) assert.ok(code.includes(must), `ingest must check: ${must}`);
  assert.match(code, /provider = 'resend' and direction = 'outbound'/);
  assert.match(code, /Unsupported delivery status/);
  assert.match(code, /> public\._email_status_rank\(m\.status\)/);              // strictly forward
  assert.match(code, /'ambiguous', true/);
  assert.match(code, /for update/);
  assert.match(code, /claim_token is not distinct from p_token/);
  assert.match(code, /lease_expires_at > now\(\)/);
  assert.match(code, /not valid/);                                                // new constraints do not scan or rewrite existing rows
  assert.match(code, /status in \('received', 'processing', 'processed', 'failed', 'ignored'\)/);
  assert.match(code, /grant execute on function public\.%s to service_role/);
  const grants = code.match(/grant\s+[^;]*?\bto\s+\w+/gi) || [];
  assert.ok(grants.length >= 1 && grants.every((g) => /to service_role$/i.test(g)), "the only grants are to service_role");
  assert.match(code, /revoke all on function public\.%s from public, anon, authenticated/);
  assert.equal(/\bdrop\s+table\b|\btruncate\b|\bdelete\s+from\b/i.test(code), false);
  assert.equal(/intel_mail_account|intel_mail_oauth/.test(code), false);
});

// ---------------------------------------------------------------- tolerant reading of Resend's response (shapes are from the docs, never verified live)
test("received-email parsing accepts header objects or lists, recipient strings or objects, and snake or camel case names", () => {
  const base = { id: "rx_9", from: "Ada <ada@client.com>", to: ["john@studiokairegi.com"], subject: "Hi", message_id: "<m1@client.com>", created_at: "2026-11-04T10:00:00Z", text: "yo" };
  const a = normalizeReceivedEmail({ ...base, headers: { "In-Reply-To": "<p@x>", References: "<a@x> <p@x>", "List-Unsubscribe": "<u>" } }, {});
  const b = normalizeReceivedEmail({ ...base, headers: [{ name: "In-Reply-To", value: "<p@x>" }, { name: "References", value: "<a@x> <p@x>" }, { key: "List-Unsubscribe", value: "<u>" }] }, {});
  assert.deepEqual([a.inReplyTo, a.references, a.listUnsubscribe], ["<p@x>", "<a@x> <p@x>", "<u>"]);
  assert.deepEqual(b.headers, a.headers);
  const c = normalizeReceivedEmail({ ...base, to: [{ email: "John@StudioKairegi.com", name: "John" }], cc: "x@y.com, z@y.com", messageId: undefined, createdAt: "2026-11-04T11:00:00Z", created_at: undefined, from: { email: "ada@client.com", name: "Ada" } }, {});
  assert.deepEqual(c.to, ["john@studiokairegi.com"]); assert.deepEqual(c.cc, ["x@y.com", "z@y.com"]);
  assert.equal(c.createdAt, "2026-11-04T11:00:00Z"); assert.equal(parseAddress(c.fromRaw).email, "ada@client.com");
  assert.equal(normalizeReceivedEmail({ ...base, message_id: undefined, headers: { "message-id": "<h@x>" } }, {}).messageId, "<h@x>");
  assert.equal(normalizeReceivedEmail(base, { email_id: "rx_77" }).emailId, "rx_77");
  assert.deepEqual(normalizeHeaders(null), {});
  const att = normalizeAttachment({ attachment_id: "a1", name: "../x.pdf", contentType: "application/pdf", size_bytes: "12", downloadUrl: "https://f/x", contentDisposition: "inline", contentId: "cid1" });
  assert.deepEqual(att, { id: "a1", filename: "_x.pdf", contentType: "application/pdf", size: 12, contentId: "cid1", inline: true, url: "https://f/x" });
});

test("an unexpected received-email shape fails loudly with field NAMES only, and the event is retryable and not completed", () => {
  assert.throws(() => normalizeReceivedEmail({ foo: 1, secretBody: "do not leak" }, {}), (e) => /Unexpected received-email shape/.test(e.message) && /foo,secretBody/.test(e.message) && !e.message.includes("do not leak"));
  assert.throws(() => normalizeReceivedEmail({ from: "not-an-address", to: ["a@b.com"] }, {}), /Unexpected received-email shape/);
  assert.throws(() => normalizeReceivedEmail({ from: "a@b.com", to: [] }, {}), /Unexpected received-email shape/);
});

test("webhook: an odd-shaped Resend answer is recorded as failed (with a readable reason) instead of storing a blank message", async () => {
  const h = hookHarness({ received: { id: "rx_1", unexpected: true } });
  const res = await hook(receivedEvent, h.deps);
  assert.equal(res.status, 500);
  assert.equal(h.log.ingested.length, 0);
  assert.equal(h.log.webhooks.get("msg_1").status, "failed");
  assert.match(h.log.webhooks.get("msg_1").error, /Unexpected received-email shape/);
});

test("new-email detection: silent on the first poll, counts only increases", () => {
  assert.equal(newArrivals(null, 5), 0);       // opening the app never beeps for old mail
  assert.equal(newArrivals(2, 5), 3);
  assert.equal(newArrivals(5, 5), 0);
  assert.equal(newArrivals(5, 2), 0);          // reading mail lowers the count: no sound
  assert.equal(newArrivals(0, "1"), 1);
  assert.equal(newArrivals(undefined, 3), 0);
});

test("webhook: Intelligence delivery-event persistence failure is retried instead of acknowledged", async () => {
  const h = hookHarness({ intelError: true });
  const ev = { type: "email.bounced", created_at: new Date(NOW).toISOString(), data: { email_id: "resend_intel_1", to: ["producer@studio.test"], bounce: { message: "Mailbox unavailable" } } };
  const res = await hook(ev, h.deps, { id: "intel_retry_1" });
  assert.equal(res.status, 500);
  assert.equal(h.log.webhooks.get("intel_retry_1").status, "failed");
  assert.equal(h.log.intelEvents.length, 1);
});

test("webhook: Intelligence-only delivery event is accepted when CRM has no matching message", async () => {
  const h = hookHarness({ eventFound: false, intelFound: true });
  const ev = { type: "email.delivered", created_at: new Date(NOW - 5 * 60_000).toISOString(), data: { email_id: "resend_intel_only", to: ["artist@studio.test"] } };
  const res = await hook(ev, h.deps, { id: "intel_only_event" });
  assert.equal(res.status, 200);
  assert.equal(h.log.events.length, 1);
  assert.equal(h.log.intelEvents.length, 1);
  assert.equal(h.log.webhooks.get("intel_only_event").status, "processed");
});
