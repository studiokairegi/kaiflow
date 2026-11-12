import test from "node:test";
import assert from "node:assert/strict";
import { gmailAdapter, buildGmailMime } from "../../supabase/functions/_shared/email_adapter_gmail.ts";
import { zohoAdapter } from "../../supabase/functions/_shared/email_adapter_zoho.ts";

const account = (provider, address = "studio@example.com") => ({ id: "22222222-2222-4222-8222-222222222222", organization_id: "11111111-1111-4111-8111-111111111111", provider, address, display_name: "Studio", status: "active", connection_status: "connected" });
const input = (extra = {}) => ({ fromEmail: "studio@example.com", fromName: "Studio", to: ["client@example.net"], cc: [], bcc: [], subject: "A subject", text: "Hello", html: "", replyTo: "", thread: null, attachments: [], idempotencyKey: "idempotency-12345678", correlationId: "message-1", ...extra });

test("Gmail MIME is safe, threaded and supports base64 attachments", () => {
  const mime = buildGmailMime(account("gmail"), input({ thread: { in_reply_to: "<parent@example.net>", references: "<parent@example.net>", provider_thread_id: "thread-1" }, attachments: [{ filename: "brief.txt", content_type: "text/plain", content_base64: "SGVsbG8=" }] }), "<new@example.com>");
  assert.match(mime, /Message-ID: <new@example.com>/);
  assert.match(mime, /In-Reply-To: <parent@example.net>/);
  assert.match(mime, /multipart\/mixed/);
  assert.match(mime, /filename="brief.txt"/);
  assert.match(mime, /SGVsbG8=/);
  assert.throws(() => buildGmailMime(account("gmail"), input({ subject: "bad\r\nBcc: victim@example.net" }), "<x@example.com>"), /line break/);
});

test("Gmail adapter uses only the shared account token gateway and sends through Gmail API", async () => {
  const calls = [];
  const ctx = { env: () => undefined, now: () => Date.now(), getProviderAccessToken: async (a, op) => { assert.equal(a.id, account("gmail").id); assert.equal(op, "send"); return { provider: "gmail", access_token: "short-lived", api_base: "https://gmail.googleapis.com/gmail/v1", external_account_id: "me", mailbox: a.address, expires_in: 3600 }; }, fetch: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ id: "gmail-id", threadId: "gmail-thread" }), { status: 200 }); } };
  const out = await gmailAdapter.send(ctx, account("gmail"), input());
  assert.equal(out.ok, true);
  assert.equal(out.providerMessageId, "gmail-id");
  assert.equal(out.providerThreadId, "gmail-thread");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
  assert.match(calls[0].init.headers.Authorization, /^Bearer short-lived$/);
  assert.equal(JSON.parse(calls[0].init.body).raw.includes("Hello"), false);
});

test("Zoho adapter sends manual correspondence through the existing regional token gateway", async () => {
  const calls = [];
  const ctx = { env: () => undefined, now: () => Date.now(), getProviderAccessToken: async (_a, op) => { assert.equal(op, "send"); return { provider: "zoho", access_token: "short-lived", api_base: "https://mail.zoho.eu/api", external_account_id: "123456789", mailbox: "studio@example.com", expires_in: 3600 }; }, fetch: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ data: { messageId: "987654321", threadId: "thread-zoho" } }), { status: 200 }); } };
  const out = await zohoAdapter.send(ctx, account("zoho"), input());
  assert.equal(out.ok, true);
  assert.equal(out.providerMessageId, "987654321");
  assert.equal(out.providerThreadId, "thread-zoho");
  assert.equal(calls[0].url, "https://mail.zoho.eu/api/accounts/123456789/messages");
  assert.equal(calls[0].init.headers.Authorization, "Zoho-oauthtoken short-lived");
  assert.equal(JSON.parse(calls[0].init.body).toAddress, "client@example.net");
});

test("Zoho replies use the stored provider parent ID and never downgrade to a new message", async () => {
  const calls = [];
  const ctx = { env: () => undefined, now: () => Date.now(), getProviderAccessToken: async () => ({ provider: "zoho", access_token: "short-lived", api_base: "https://mail.zoho.com/api", external_account_id: "123456789", mailbox: "studio@example.com", expires_in: 3600 }), fetch: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ data: { messageId: "new-id", threadId: "thread" } }), { status: 200 }); } };
  const out = await zohoAdapter.send(ctx, account("zoho"), input({ thread: { in_reply_to: "<parent@example.net>", references: "<parent@example.net>", provider_message_id: "parent-provider-id", parent_direction: "inbound" } }));
  assert.equal(out.ok, true);
  assert.equal(calls[0].url, "https://mail.zoho.com/api/accounts/123456789/messages/parent-provider-id");
  assert.equal(JSON.parse(calls[0].init.body).action, "reply");
  const noParent = await zohoAdapter.send(ctx, account("zoho"), input({ thread: { in_reply_to: "<parent@example.net>", references: "<parent@example.net>" } }));
  assert.equal(noParent.ok, false);
  assert.equal(calls.length, 1);
  const outboundParent = await zohoAdapter.send(ctx, account("zoho"), input({ thread: { in_reply_to: "<sent@example.net>", references: "<sent@example.net>", provider_message_id: "own-sent-id", parent_direction: "outbound" } }));
  assert.equal(outboundParent.ok, false);
  assert.equal(calls.length, 1);
});

test("Zoho attachment sends fail closed until the provider attachment workflow is implemented", async () => {
  let called = false;
  const ctx = { env: () => undefined, now: () => Date.now(), getProviderAccessToken: async () => { throw new Error("should not be called"); }, fetch: async () => { called = true; } };
  const out = await zohoAdapter.send(ctx, account("zoho"), input({ attachments: [{ filename: "x", content_type: "text/plain", content_base64: "eA==" }] }));
  assert.equal(out.ok, false);
  assert.equal(out.status, 501);
  assert.equal(called, false);
});

test("Gmail sync pages Inbox then Sent and normalizes headers, body, unread state and provider thread IDs", async () => {
  const calls = [];
  const full = (id, label) => ({ id, threadId: `thread-${id}`, internalDate: "1794400000000", labelIds: [label, ...(label === "INBOX" ? ["UNREAD"] : [])], payload: {
    mimeType: "text/plain", headers: [{ name: "From", value: "Prospect <prospect@example.net>" }, { name: "To", value: "Studio <studio@example.com>" }, { name: "Subject", value: "Hello" }, { name: "Message-ID", value: `<${id}@example.net>` }],
    body: { data: Buffer.from("Hello from provider").toString("base64url") },
  } });
  const ctx = { env: () => undefined, now: () => Date.now(), getProviderAccessToken: async (_a, op) => { assert.equal(op, "sync"); return { provider: "gmail", access_token: "access", api_base: "https://gmail.googleapis.com/gmail/v1", external_account_id: "me", mailbox: "studio@example.com", expires_in: 3600 }; }, fetch: async (url) => {
    calls.push(url);
    if (url.includes("labelIds=INBOX")) return new Response(JSON.stringify({ messages: [{ id: "in-1" }] }), { status: 200 });
    if (url.includes("labelIds=SENT")) return new Response(JSON.stringify({ messages: [{ id: "out-1" }] }), { status: 200 });
    if (url.includes("/messages/in-1?")) return new Response(JSON.stringify(full("in-1", "INBOX")), { status: 200 });
    if (url.includes("/messages/out-1?")) return new Response(JSON.stringify(full("out-1", "SENT")), { status: 200 });
    throw new Error(`unexpected Gmail URL ${url}`);
  } };
  const first = await gmailAdapter.sync(ctx, account("gmail"), {});
  assert.equal(first.messages[0].direction, "inbound");
  assert.equal(first.messages[0].is_read, false);
  assert.equal(first.messages[0].body_text, "Hello from provider");
  assert.equal(first.messages[0].provider_thread_id, "thread-in-1");
  assert.equal(first.has_more, true);
  const second = await gmailAdapter.sync(ctx, account("gmail"), first.next_checkpoint);
  assert.equal(second.messages[0].direction, "outbound");
  assert.equal(second.has_more, false);
  assert.equal(second.complete, true);
});

test("Zoho sync reuses the regional account token, discovers Inbox/Sent folders and normalizes message bodies", async () => {
  const calls = [];
  const ctx = { env: () => undefined, now: () => Date.now(), getProviderAccessToken: async (_a, op) => { assert.equal(op, "sync"); return { provider: "zoho", access_token: "access", api_base: "https://mail.zoho.eu/api", external_account_id: "123456789", mailbox: "studio@example.com", expires_in: 3600 }; }, fetch: async (url) => {
    calls.push(url);
    if (url.endsWith("/folders")) return new Response(JSON.stringify({ data: [{ folderId: "inbox-id", folderName: "Inbox", folderType: "inbox" }, { folderId: "sent-id", folderName: "Sent", folderType: "sent" }] }), { status: 200 });
    if (url.includes("/messages/view?") && url.includes("folderId=inbox-id")) return new Response(JSON.stringify({ data: [{ messageId: "in-1", threadId: "th-in", fromAddress: "Prospect <prospect@example.net>", toAddress: "studio@example.com", subject: "Inquiry", receivedTime: "1794400000000", isRead: false }] }), { status: 200 });
    if (url.includes("/messages/view?") && url.includes("folderId=sent-id")) return new Response(JSON.stringify({ data: [{ messageId: "out-1", threadId: "th-out", fromAddress: "studio@example.com", toAddress: "Prospect <prospect@example.net>", subject: "Reply", sentDateInGMT: "1794400000000", isRead: true }] }), { status: 200 });
    if (url.includes("/messages/in-1/content") || url.includes("/messages/out-1/content")) return new Response(JSON.stringify({ data: { content: "<p>Provider body</p>" } }), { status: 200 });
    if (url.includes("/messages/in-1/header") || url.includes("/messages/out-1/header")) return new Response(JSON.stringify({ data: { headerContent: "Message-ID: <zoho@example.net>\\r\\nIn-Reply-To: <parent@example.net>" } }), { status: 200 });
    throw new Error(`unexpected Zoho URL ${url}`);
  } };
  const first = await zohoAdapter.sync(ctx, account("zoho"), {});
  assert.equal(first.messages[0].direction, "inbound");
  assert.equal(first.messages[0].is_read, false);
  assert.equal(first.messages[0].body_text, "Provider body");
  assert.equal(first.messages[0].provider_thread_id, "th-in");
  assert.equal(first.has_more, true);
  const second = await zohoAdapter.sync(ctx, account("zoho"), first.next_checkpoint);
  assert.equal(second.messages[0].direction, "outbound");
  assert.equal(second.has_more, false);
  assert.equal(second.complete, true);

  // A terminal checkpoint has an empty folder list. A subsequent sync must
  // rediscover folders instead of treating [] as a valid cached folder list.
  const third = await zohoAdapter.sync(ctx, account("zoho"), second.next_checkpoint);
  assert.equal(third.messages[0].direction, "inbound");
  assert.equal(third.has_more, true);
  assert.ok(calls.filter((url) => url.endsWith("/folders")).length >= 2);
  assert.ok(calls.every((url) => url.includes("mail.zoho.eu/api/accounts/123456789")));
});

test("provider authorization failures are definite pre-send failures, not unknown delivery outcomes", async () => {
  const denied = { env: () => undefined, now: () => Date.now(), getProviderAccessToken: async () => { throw new Error("revoked"); }, fetch: async () => { throw new Error("must not send"); } };
  const gmail = await gmailAdapter.send(denied, account("gmail"), input());
  const zoho = await zohoAdapter.send(denied, account("zoho"), input());
  assert.equal(gmail.ok, false); assert.equal(gmail.unknown, false); assert.equal(gmail.attempts, 0);
  assert.equal(zoho.ok, false); assert.equal(zoho.unknown, false); assert.equal(zoho.attempts, 0);
});

test("Zoho sync fails the page when message content cannot be retrieved instead of ingesting an empty message", async () => {
  const ctx = { env: () => undefined, now: () => Date.now(), getProviderAccessToken: async () => ({ provider: "zoho", access_token: "access", api_base: "https://mail.zoho.eu/api", external_account_id: "123456789", mailbox: "studio@example.com", expires_in: 3600 }), fetch: async (url) => {
    if (url.endsWith("/folders")) return new Response(JSON.stringify({ data: [{ folderId: "inbox-id", folderName: "Inbox", folderType: "inbox" }, { folderId: "sent-id", folderName: "Sent", folderType: "sent" }] }), { status: 200 });
    if (url.includes("/messages/view?")) return new Response(JSON.stringify({ data: [{ messageId: "in-1", fromAddress: "prospect@example.net", toAddress: "studio@example.com", subject: "Inquiry" }] }), { status: 200 });
    if (url.includes("/messages/in-1/content")) return new Response(JSON.stringify({ error: "temporary failure" }), { status: 503 });
    throw new Error(`unexpected Zoho URL ${url}`);
  } };
  await assert.rejects(() => zohoAdapter.sync(ctx, account("zoho"), {}), /temporarily unavailable/);
});


import { isRevokedProviderRefresh } from "../../supabase/functions/_shared/email_adapter.ts";
import { createProviderTokenCache } from "../../supabase/functions/_shared/email_provider_token_cache.ts";
test("OAuth refresh only marks definitive revoked grants as revoked", () => {
  assert.equal(isRevokedProviderRefresh("gmail", 400, { error: "invalid_grant" }), true);
  assert.equal(isRevokedProviderRefresh("gmail", 429, { error: "rate_limit_exceeded" }), false);
  assert.equal(isRevokedProviderRefresh("zoho", 400, { error: "invalid_code" }), true);
  assert.equal(isRevokedProviderRefresh("zoho", 200, { error: "invalid_code" }), true);
  assert.equal(isRevokedProviderRefresh("zoho", 400, { error: "invalid_token" }), false);
  assert.equal(isRevokedProviderRefresh("zoho", 400, { error: "invalid_client" }), false);
  assert.equal(isRevokedProviderRefresh("zoho", 503, {}), false);
});


test("Gmail and Zoho adapters stop before provider page fetch when account deadline is exhausted", async () => {
  let calls = 0;
  const expired = { env: () => undefined, fetch: async () => { calls++; return new Response(JSON.stringify({ messages: [] }), { status: 200 }); }, now: () => 100, deadlineAt: 99, getProviderAccessToken: async (account) => ({ provider: account.provider, mailbox: account.address, access_token: "t", api_base: "https://mail.zoho.com/api", external_account_id: "z1", expires_in: 3600 }) };
  await assert.rejects(() => gmailAdapter.sync(expired, account("gmail"), {}), (e) => e.code === "sync_deadline");
  await assert.rejects(() => zohoAdapter.sync(expired, account("zoho"), {}), (e) => e.code === "sync_deadline");
  assert.equal(calls, 0);
});


test("per-run provider token cache coalesces repeated account/operation lookups", async () => {
  let calls = 0;
  const load = async (_account, _operation) => ({ access_token: `token-${++calls}` });
  const cached = createProviderTokenCache(load);
  const a = account("gmail");
  const [first, second] = await Promise.all([cached(a, "sync"), cached(a, "sync")]);
  assert.equal(first, second);
  assert.equal(calls, 1);
  await cached(a, "send");
  assert.equal(calls, 2);
  await cached({ ...account("gmail", "other@example.com"), id: "33333333-3333-4333-8333-333333333333" }, "sync");
  assert.equal(calls, 3);
});

test("Gmail and Zoho enforce deadlines inside a fetched page", async () => {
  for (const provider of ["gmail", "zoho"]) {
    let clock = 0;
    const calls = [];
    const ctx = {
      env: () => undefined,
      now: () => clock,
      deadlineAt: 40,
      getProviderAccessToken: async () => ({ provider, mailbox: "studio@example.com", access_token: "t", api_base: "https://mail.zoho.com/api", external_account_id: "z1", expires_in: 3600 }),
      fetch: async (url) => {
        calls.push(String(url));
        if (provider === "gmail") {
          if (String(url).includes("/messages?") || String(url).endsWith("/messages")) { clock = 50; return new Response(JSON.stringify({ messages: [{ id: "g1" }] }), { status: 200 }); }
        } else {
          if (String(url).endsWith("/folders")) return new Response(JSON.stringify({ data: [{ folderId: "f1", folderType: "inbox" }, { folderId: "f2", folderType: "sent" }] }), { status: 200 });
          if (String(url).includes("/messages/view")) { clock = 50; return new Response(JSON.stringify({ data: [{ messageId: "z1" }] }), { status: 200 }); }
        }
        return new Response(JSON.stringify({}), { status: 200 });
      },
    };
    const page = await (provider === "gmail" ? gmailAdapter.sync(ctx, account(provider), { cursor: "original" }) : zohoAdapter.sync(ctx, account(provider), { cursor: "original" }));
    assert.equal(page.partial, true);
    assert.deepEqual(page.messages, []);
    assert.deepEqual(page.next_checkpoint, { cursor: "original" });
    assert.equal(page.has_more, true);
    assert.equal(calls.some((url) => url.includes("/content") || /\/messages\/g1/.test(url)), false);
  }
});


test("Gmail and Zoho timeouts bounded by the remaining deadline are classified as sync_deadline just before the clock reaches it", async () => {
  for (const provider of ["gmail", "zoho"]) {
    const ctx = { env: () => undefined, now: () => 100, deadlineAt: 101, getProviderAccessToken: async () => ({ provider, mailbox: "studio@example.com", access_token: "t", api_base: "https://mail.zoho.com/api", external_account_id: "me", expires_in: 3600 }), fetch: async () => { const error = new Error("timed out"); error.name = "TimeoutError"; throw error; } };
    await assert.rejects(() => (provider === "gmail" ? gmailAdapter.sync(ctx, account(provider), {}) : zohoAdapter.sync(ctx, account(provider), {})), (error) => error.code === "sync_deadline");
  }
});


test("Gmail and Zoho return partial pages with a resumable in-page offset", async () => {
  for (const provider of ["gmail", "zoho"]) {
    let clock = 0;
    const originalCheckpoint = { cursor: "resume-here" };
    const ctx = {
      env: () => undefined, now: () => clock, deadlineAt: 40,
      getProviderAccessToken: async () => ({ provider, mailbox: "studio@example.com", access_token: "t", api_base: "https://mail.zoho.com/api", external_account_id: "z1", expires_in: 3600 }),
      fetch: async (url) => {
        const u = String(url);
        if (provider === "gmail") {
          if (u.includes("/messages?") || u.endsWith("/messages")) return new Response(JSON.stringify({ messages: [{ id: "g1" }, { id: "g2" }], nextPageToken: "next" }), { status: 200 });
          if (u.includes("/messages/g1?")) {
            clock = 40;
            return new Response(JSON.stringify({ id: "g1", threadId: "thread-g1", internalDate: "1794400000000", labelIds: ["INBOX"], payload: { mimeType: "text/plain", headers: [{ name: "From", value: "client@example.net" }], body: { data: Buffer.from("hello").toString("base64url") } } }), { status: 200 });
          }
        } else {
          if (u.endsWith("/folders")) return new Response(JSON.stringify({ data: [{ folderId: "inbox", folderType: "inbox" }, { folderId: "sent", folderType: "sent" }] }), { status: 200 });
          if (u.includes("/messages/view?")) return new Response(JSON.stringify({ data: [{ messageId: "z1", fromAddress: "client@example.net", toAddress: "studio@example.com", subject: "hello" }, { messageId: "z2" }] }), { status: 200 });
          if (u.includes("/messages/z1/content")) return new Response(JSON.stringify({ data: { content: "hello" } }), { status: 200 });
          if (u.includes("/messages/z1/header")) { clock = 40; return new Response(JSON.stringify({ data: { headerContent: "From: client@example.net" } }), { status: 200 }); }
        }
        throw new Error(`unexpected request ${u}`);
      },
    };
    const page = await (provider === "gmail" ? gmailAdapter.sync(ctx, account(provider), originalCheckpoint) : zohoAdapter.sync(ctx, account(provider), originalCheckpoint));
    assert.equal(page.partial, true, provider);
    assert.equal(page.messages.length, 1, provider);
    assert.equal(page.next_checkpoint.offset, 1, provider);
    assert.equal(page.has_more, true, provider);
  }
});

const syncToken = (provider) => async (_account, operation) => {
  assert.equal(operation, "sync");
  return { provider, access_token: "access", api_base: "https://mail.zoho.eu/api", external_account_id: "123456789", mailbox: "studio@example.com", expires_in: 3600 };
};
const gmailFull = (id) => ({ id, threadId: `thread-${id}`, internalDate: "1794400000000", labelIds: ["INBOX"], payload: { mimeType: "text/plain", headers: [{ name: "From", value: "client@example.net" }], body: { data: Buffer.from(id).toString("base64url") } } });

test("Gmail resumes from the stable message anchor, preserves pageToken, and clears the in-page offset on completion", async () => {
  let clock = 0;
  let listing = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const calls = [];
  const ctx = {
    env: () => undefined, now: () => clock, deadlineAt: 10, getProviderAccessToken: syncToken("gmail"),
    fetch: async (url) => {
      const u = new URL(String(url)); calls.push(u);
      if (u.pathname.endsWith("/messages") && !u.pathname.match(/\/messages\/[^/]+$/)) return new Response(JSON.stringify({ messages: listing, nextPageToken: "next-page" }), { status: 200 });
      const id = decodeURIComponent(u.pathname.split("/").pop());
      clock = 10;
      return new Response(JSON.stringify(gmailFull(id)), { status: 200 });
    },
  };
  const first = await gmailAdapter.sync(ctx, account("gmail"), { folderIndex: 0, pageToken: "page-token" });
  assert.equal(first.partial, true);
  assert.equal(first.next_checkpoint.lastProcessedId, "a");
  assert.equal(first.next_checkpoint.offset, 1);

  listing = [{ id: "new" }, { id: "a" }, { id: "b" }, { id: "c" }];
  clock = 0; delete ctx.deadlineAt;
  ctx.fetch = async (url) => {
    const u = new URL(String(url)); calls.push(u);
    if (u.pathname.endsWith("/messages") && !u.pathname.match(/\/messages\/[^/]+$/)) return new Response(JSON.stringify({ messages: listing }), { status: 200 });
    const id = decodeURIComponent(u.pathname.split("/").pop());
    return new Response(JSON.stringify(gmailFull(id)), { status: 200 });
  };
  const resumed = await gmailAdapter.sync(ctx, account("gmail"), first.next_checkpoint);
  assert.deepEqual(resumed.messages.map((m) => m.provider_message_id), ["b", "c"]);
  assert.equal(calls.some((u) => u.searchParams.get("pageToken") === "page-token"), true);
  assert.equal(Object.hasOwn(resumed.next_checkpoint, "offset"), false);
});

test("Gmail restarts the page from row 0 when the resume anchor disappeared from the current listing", async () => {
  const calls = [];
  const ctx = { env: () => undefined, now: () => 0, getProviderAccessToken: syncToken("gmail"), fetch: async (url) => {
    const u = new URL(String(url)); calls.push(u);
    if (u.pathname.endsWith("/messages") && !u.pathname.match(/\/messages\/[^/]+$/)) return new Response(JSON.stringify({ messages: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }, { id: "f" }, { id: "g" }] }), { status: 200 });
    return new Response(JSON.stringify(gmailFull(decodeURIComponent(u.pathname.split("/").pop()))), { status: 200 });
  } };
  const page = await gmailAdapter.sync(ctx, account("gmail"), { folderIndex: 0, pageToken: null, offset: 6, lastProcessedId: "deleted-anchor" });
  assert.deepEqual(page.messages.map((m) => m.provider_message_id), ["a", "b", "c", "d", "e", "f", "g"]);
});

test("Gmail expired pageToken safely restarts the label listing without the stale token", async () => {
  const calls = [];
  const ctx = { env: () => undefined, now: () => 0, getProviderAccessToken: syncToken("gmail"), fetch: async (url) => {
    const u = new URL(String(url)); calls.push(u);
    if (u.pathname.endsWith("/messages") && u.searchParams.has("pageToken")) return new Response(JSON.stringify({ error: { message: "Invalid page token" } }), { status: 400 });
    if (u.pathname.endsWith("/messages") && !u.pathname.match(/\/messages\/[^/]+$/)) return new Response(JSON.stringify({ messages: [{ id: "replayed" }] }), { status: 200 });
    return new Response(JSON.stringify(gmailFull("replayed")), { status: 200 });
  } };
  const page = await gmailAdapter.sync(ctx, account("gmail"), { folderIndex: 0, pageToken: "expired-token", offset: 8, lastProcessedId: "old-id" });
  assert.deepEqual(page.messages.map((m) => m.provider_message_id), ["replayed"]);
  assert.equal(calls.filter((u) => u.pathname.endsWith("/messages") && u.searchParams.has("pageToken")).length, 1);
  assert.equal(Object.hasOwn(page.next_checkpoint, "offset"), false);
});

test("Zoho resumes after its stable message anchor and replays safely when that anchor is gone", async () => {
  const folders = [{ id: "inbox-id", name: "Inbox", type: "inbox" }, { id: "sent-id", name: "Sent", type: "sent" }];
  const makeContext = (rows) => ({ env: () => undefined, now: () => 0, getProviderAccessToken: syncToken("zoho"), fetch: async (url) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/messages/view")) return new Response(JSON.stringify({ data: rows }), { status: 200 });
    if (u.pathname.endsWith("/content")) return new Response(JSON.stringify({ data: { content: "body" } }), { status: 200 });
    if (u.pathname.endsWith("/header")) return new Response(JSON.stringify({ data: { headerContent: "From: client@example.net" } }), { status: 200 });
    throw new Error(`unexpected Zoho URL ${url}`);
  } });
  const checkpoint = { folders, folderIndex: 0, start: 1, offset: 2, lastProcessedId: "anchor" };
  const resumed = await zohoAdapter.sync(makeContext([{ messageId: "new" }, { messageId: "anchor" }, { messageId: "b" }, { messageId: "c" }]), account("zoho"), checkpoint);
  assert.deepEqual(resumed.messages.map((m) => m.provider_message_id), ["b", "c"]);
  const replayed = await zohoAdapter.sync(makeContext([{ messageId: "b" }, { messageId: "c" }]), account("zoho"), checkpoint);
  assert.deepEqual(replayed.messages.map((m) => m.provider_message_id), ["b", "c"]);
});

// Round 6: a fixed overlap cannot bound how many rows disappear between runs. Eight processed rows (including the anchor)
// vanish here; a five-row overlap would resume at index 5 and silently skip u1..u3.
test("Gmail does not skip unprocessed messages when more than five earlier rows disappear with the anchor", async () => {
  const listing = [{ id: "p1" }, { id: "p2" }, { id: "u1" }, { id: "u2" }, { id: "u3" }, { id: "u4" }, { id: "u5" }];
  const ctx = { env: () => undefined, now: () => 0, getProviderAccessToken: syncToken("gmail"), fetch: async (url) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/messages") && !u.pathname.match(/\/messages\/[^/]+$/)) return new Response(JSON.stringify({ messages: listing }), { status: 200 });
    return new Response(JSON.stringify(gmailFull(decodeURIComponent(u.pathname.split("/").pop()))), { status: 200 });
  } };
  const page = await gmailAdapter.sync(ctx, account("gmail"), { folderIndex: 0, pageToken: null, offset: 10, lastProcessedId: "p10" });
  const ids = page.messages.map((m) => m.provider_message_id);
  for (const id of ["u1", "u2", "u3", "u4", "u5"]) assert.ok(ids.includes(id), `${id} must not be skipped`);
  assert.deepEqual(ids, listing.map((r) => r.id));
  assert.equal(Object.hasOwn(page.next_checkpoint, "offset"), false);
});

test("Zoho does not skip unprocessed messages when more than five earlier rows disappear with the anchor", async () => {
  const folders = [{ id: "inbox-id", name: "Inbox", type: "inbox" }, { id: "sent-id", name: "Sent", type: "sent" }];
  const rows = ["p1", "p2", "u1", "u2", "u3", "u4", "u5"].map((messageId) => ({ messageId }));
  const ctx = { env: () => undefined, now: () => 0, getProviderAccessToken: syncToken("zoho"), fetch: async (url) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/messages/view")) return new Response(JSON.stringify({ data: rows }), { status: 200 });
    if (u.pathname.endsWith("/content")) return new Response(JSON.stringify({ data: { content: "body" } }), { status: 200 });
    if (u.pathname.endsWith("/header")) return new Response(JSON.stringify({ data: { headerContent: "From: client@example.net" } }), { status: 200 });
    throw new Error(`unexpected Zoho URL ${url}`);
  } };
  const page = await zohoAdapter.sync(ctx, account("zoho"), { folders, folderIndex: 0, start: 1, offset: 10, lastProcessedId: "p10" });
  const ids = page.messages.map((m) => m.provider_message_id);
  for (const id of ["u1", "u2", "u3", "u4", "u5"]) assert.ok(ids.includes(id), `${id} must not be skipped`);
  assert.deepEqual(ids, rows.map((r) => r.messageId));
});

test("Zoho does not send the generated thread-token ReplyTo (unverifiable at Zoho) but keeps an explicit one", async () => {
  const bodies = [];
  const ctx = { env: () => undefined, now: () => Date.now(), getProviderAccessToken: async () => ({ provider: "zoho", access_token: "short-lived", api_base: "https://mail.zoho.com/api", external_account_id: "123456789", mailbox: "studio@example.com", expires_in: 3600 }), fetch: async (url, init) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ data: { messageId: "m1" } }), { status: 200 }); } };
  await zohoAdapter.send(ctx, account("zoho"), input({ replyTo: "studio+k0123456789ab@example.com" }));
  assert.equal("replyTo" in bodies[0], false);
  await zohoAdapter.send(ctx, account("zoho"), input({ replyTo: "desk@example.com" }));
  assert.equal(bodies[1].replyTo, "desk@example.com");
});
