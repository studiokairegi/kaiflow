# KairFlow Email on Resend: setup and status

Resend is the only active email provider. Cloudflare is used for DNS only. Gmail and Zoho Mail are **paused, not removed**.

## 1. What is built, and what is verified

| Area | State |
|---|---|
| Database (`20261110090000_email_resend_core.sql`): accounts, conversations, messages, attachments, participants, events, webhook log, sync state, provider flags, RLS, private attachment bucket | Written. SQL tests written (`supabase/tests/email_resend.test.sql`) but **not run** (no PostgreSQL where this was built). Run them first. |
| `email-send` Edge Function (validation, threading headers, retries with idempotency key, daily limit) | Logic unit tested with a fake Resend and fake database (28 tests). **Never called against live Resend.** |
| `resend-webhook` Edge Function (Svix signature check, duplicate-safe log, inbound fetch + attachments, delivery/bounce/complaint events) | Logic unit tested the same way. **Never received a real Resend event.** |
| Inbox screen (CRM > Inbox): folders, search, threads, reply / reply all / forward, compose, Cc/Bcc, attachments, drafts, read/unread, archive, link to lead | Written, syntax checked, logic tested. **Not run in a browser** (no `node_modules` here). |
| Gmail / Zoho pause | Flags seeded OFF; all six Gmail/Zoho Edge Functions answer 410; Settings hides their connect controls; worker defaults to `KAIRFLOW_MAIL_PROVIDER=none`. Tested. |
| Intelligence access | Read-only agent functions + AI drafts that can never be sent by the agent. Written; SQL not run. |

Things that need your account: Resend API key, verified domain, webhook secret, DNS records. Until those exist, sending and receiving cannot work.

## 2. Apply order (nothing here has been applied for you)

1. Merge this repo into your branch. Do not apply anything to production before the checks in section 8.
2. Run `PGUSER=postgres ./supabase/tests/run_intelligence_auth.sh` and `npm run build` on your machine.
3. Apply `supabase/migrations/20261110090000_email_resend_core.sql` (it needs the Intelligence `20261109*` migrations first; it checks and stops if they are missing).
4. Set secrets (section 3), deploy the two functions (section 4), then do the Resend and DNS steps.

Rollback: the last lines of the migration list the exact `drop` statements. They remove only the `email_*` objects.

## 3. Secrets (Supabase, never in the browser or the repo)

```
supabase secrets set RESEND_API_KEY=...            # Resend > API Keys (sending access is enough)
supabase secrets set RESEND_WEBHOOK_SECRET=whsec_...   # Resend > Webhooks > your endpoint > Signing secret
supabase secrets set EMAIL_DAILY_LIMIT=100         # optional; free plan allows 100 a day
supabase secrets set EMAIL_THREAD_TOKENS=on        # optional; "off" disables the reply-to plus-address (see section 7)
```

The sender address and display name are not environment variables: they are stored per studio in `email_accounts` (CRM > Inbox > "Add your sending address"). The suggested first address is `john@studiokairegi.com`, which is only a placeholder until you verify the domain. `RESEND_FROM_EMAIL` / `RESEND_FROM_NAME` from the original brief are therefore replaced by that table so the address is never hardcoded.

Cloudflare needs no token: the DNS records are added by hand (section 6).

## 4. Deploy the functions

```
supabase functions deploy email-send
supabase functions deploy resend-webhook --no-verify-jwt   # Resend sends no Supabase JWT; the Svix signature is the check
```

The webhook URL is `https://<project-ref>.supabase.co/functions/v1/resend-webhook`.

## 5. Resend dashboard

1. **Domains > Add domain**: `studiokairegi.com`. Resend then shows the exact DNS records (section 6). Wait for "Verified".
2. **API Keys**: create one, set it as `RESEND_API_KEY`.
3. **Receiving**: turn on receiving for the domain (adds the inbound MX record).
4. **Webhooks > Add endpoint**: the URL above, with these events: `email.received`, `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed`, `email.suppressed`. Copy the signing secret into `RESEND_WEBHOOK_SECRET`.
5. Free plan: 3,000 emails a month, 100 a day. Sources disagreed on how many domains and webhook endpoints the free plan includes; check your dashboard allows the domain and the endpoint before relying on this. Resend keeps received mail only for a limited time: KairFlow copies every message and attachment into Supabase on arrival.

## 6. DNS (Cloudflare). Add by hand; nothing changes automatically

Before adding anything, open Cloudflare > DNS > Records for `studiokairegi.com` and look for existing `MX` records, any `TXT` starting `v=spf1`, and `_dmarc`.

| Record | Where | Notes |
|---|---|---|
| DKIM (TXT) | `resend._domainkey` | Copy the value from Resend. |
| SPF (TXT) and return-path MX | the sending subdomain Resend shows (usually `send`) | Copy from Resend. Because it is on a subdomain it does not collide with a root SPF record. If you ever add Resend to the root SPF, merge it into the single existing `v=spf1` record: never create a second one. |
| Inbound MX | the domain Resend shows for receiving | See the choice below. Priority and host come from Resend. |
| DMARC (TXT) | `_dmarc` | Start monitor-only, e.g. `v=DMARC1; p=none; rua=mailto:<an address you read>`. Tighten later once reports look clean. Skip if you already have one. |

**Inbound choice.** Receiving on the root domain makes Resend receive mail for *every* address at `studiokairegi.com`. That is fine today (the address is a placeholder with no mailbox), but if you later want ordinary mailboxes on that domain, receive on a subdomain instead (for example `mail.studiokairegi.com`) and use an address on it as the sending address. Do not enable Cloudflare Email Routing for any address Resend receives, and keep MX/TXT records "DNS only" (they cannot be proxied anyway).

## 7. How threading works

- Replying to a received message sets `In-Reply-To` and `References` from the stored Message-ID (the method in Resend's reply guide), so external clients keep the thread.
- Mail servers (Resend runs on Amazon SES) may replace the Message-ID on mail *you send*, so a client's reply may point at an id KairFlow never saw. To stay reliable, each outgoing message gets `Reply-To: john+k<12 characters>@yourdomain`, which names the conversation. Replies to that address are filed by the token first, then by In-Reply-To/References, then by same subject + same sender within 30 days.
- If you set your own Reply-To in an email, or `EMAIL_THREAD_TOKENS=off`, only the header and subject fallbacks apply.
- Duplicate webhook deliveries are safe: the Svix id is unique in `email_webhook_events`, and each message also has unique indexes on its Resend id and its Message-ID.

## 8. First live test (do this before trusting it)

1. Add the sending address in CRM > Inbox, compose a message to an address you own, send. Expect status Sent, then Delivered after a webhook arrives.
2. Reply from that mailbox to the message. Expect it to appear in the same thread within a minute, with unread count 1.
3. Reply from KairFlow; check the external client threads it.
4. Send yourself a message with an attachment; open it from the thread.
5. In Resend, resend the same webhook delivery; expect no second message.
6. Check `select * from email_webhook_events order by received_at desc` shows `processed` for each.
7. Confirm CRM > Intelligence > Settings shows no Gmail/Zoho connect buttons.

Unverified assumptions to watch in step 1-2: the exact shape of Resend's receiving responses (`headers`, `attachments` list fields) follows their published docs but was never exercised; the attachment `download_url` expires after an hour, which is why attachments are downloaded immediately.

## 9. Gmail and Zoho: paused, how to resume

`select * from public.email_provider_flags;` shows `resend = true`, `gmail = false`, `zoho = false`. To resume a provider: `update public.email_provider_flags set enabled = true where provider = 'gmail';`, and set `KAIRFLOW_MAIL_PROVIDER=gmail` on the worker. Nothing was deleted: code, migrations, stored tokens and history are untouched. If the flag cannot be read, the provider counts as paused.

**Known consequence:** Intelligence cold outreach sends through the Gmail/Zoho client. While they are paused the worker does not send or sync mail (its jobs report "mail provider paused" and drafts stay approved). Replies to Intelligence outreach now arrive in the Inbox through Resend, but sending Intelligence drafts through Resend is not wired yet.

## 10. Intelligence interface

Read-only functions for the worker identity: `intel_agent_email_recent_inbound(limit)` and `intel_agent_email_thread(conversation_id)` (no Bcc, headers or raw HTML). `intel_agent_email_save_draft(...)` stores a draft flagged `ai_generated`; only a person pressing Send in the Inbox can send it, because `email-send` runs only for a signed-in admin + Master User.

## 11. Limits and open items

- Sending uses the free 100/day cap; the function stops at `EMAIL_DAILY_LIMIT` with a clear message.
- Attachments: 10 files and 10 MB total per outgoing message; incoming files over 25 MB are recorded without a stored copy.
- Message bodies show as plain text in the Inbox (HTML is stored but not rendered, on purpose).
- Reading Resend Inboxes (the beta product) is not used; this relies only on the standard receiving API.
- Drafts exist; scheduled send, signatures, templates, and a manual "re-fetch from Resend" button do not.
- Access is admin + Master User only, same as Intelligence (one function, `email_can_access`, to change later).
