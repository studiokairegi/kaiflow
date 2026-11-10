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

Multi-provider foundation (plan phase 2): after the hardening migration, `20261204090000_email_provider_registry.sql` and `20261204100000_email_provider_scoping.sql` add the provider registry and per-provider account/message scoping. See `docs/EMAIL_PROVIDER_FOUNDATION.md`. They change no Resend behaviour; apply them in order.

Adapter layer (plan phase 3): the Resend code now sits behind a provider adapter (`_shared/email_adapter_resend.ts`) and the shared send service picks the adapter from the sender account's provider in the database. **Apply the two phase 2 migrations BEFORE deploying `email-send` and `resend-webhook`**: the new code reads `email_provider_registry`, and without that table sending answers 500 and the webhook answers 500 (Resend retries; nothing is lost). Deploy the two functions together. No new secrets or environment variables. See `docs/EMAIL_ADAPTER_ARCHITECTURE.md`.

## 3. Secrets (Supabase, never in the browser or the repo)

```
supabase secrets set RESEND_API_KEY=...            # Resend > API Keys (sending access is enough)
supabase secrets set RESEND_WEBHOOK_SECRET=whsec_...   # Resend > Webhooks > your endpoint > Signing secret
supabase secrets set EMAIL_DAILY_LIMIT=100         # optional; free plan allows 100 a day
supabase secrets set EMAIL_THREAD_TOKENS=on        # optional; "off" disables the reply-to plus-address (see section 7)
supabase secrets set EMAIL_INBOUND_DOMAIN=<id>.resend.app   # where replies arrive; REQUIRED when another provider (Zoho) owns the sending domain's MX
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

**Studio Kairegi setup (Zoho owns the root MX).** The root `MX` records of `studiokairegi.com` point to Zoho, so do **not** add Resend's root receiving record: it would split Zoho mail. Mail is *sent* as `john@studiokairegi.com` (verified through the `resend._domainkey`, `send` and `rsend` records), while replies are routed to a Resend-only address: in Resend open Emails > Receiving > (three dots) > Receiving address to get `<id>.resend.app`, and set it as `EMAIL_INBOUND_DOMAIN`. Every outgoing message then carries `Reply-To: john+k<token>@<id>.resend.app`; the webhook matches that address to your sending address. Leave the root SPF (`include:zohomail.com`) and DMARC alone: Resend mail passes DMARC through its DKIM key. Later you can switch to a branded subdomain (add `mail.studiokairegi.com` in Resend, add its records, set `EMAIL_INBOUND_DOMAIN=mail.studiokairegi.com`).

**Inbound choice (only if nothing else owns the root MX).** Receiving on the root domain makes Resend receive mail for *every* address at `studiokairegi.com`. That is fine today (the address is a placeholder with no mailbox), but if you later want ordinary mailboxes on that domain, receive on a subdomain instead (for example `mail.studiokairegi.com`) and use an address on it as the sending address. Do not enable Cloudflare Email Routing for any address Resend receives, and keep MX/TXT records "DNS only" (they cannot be proxied anyway).

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


---

# Hardening pass (migration `20261111090000_email_resend_hardening.sql`)

**Status in one line: local source changes and tests only. Nothing in this section has been applied to Supabase, deployed, or tested against a real Resend account.**

## A. Webhook endpoint, events, secrets

- Endpoint: `https://hlplzosdgciavucaebfd.supabase.co/functions/v1/resend-webhook` (the project ref comes from your repo's Supabase link file; confirm it in the Supabase dashboard).
- Deploy it with `--no-verify-jwt`. Resend sends no Supabase JWT, so the **Svix signature is the only authentication** and must never be bypassed.
- Subscribe to: `email.received`, `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed`, `email.suppressed`. Anything else (opened, clicked, scheduled, unknown types) is acknowledged and ignored.
- Supabase secrets (names only, set them yourself, never paste values anywhere): `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` (the endpoint's `whsec_...` signing secret), `EMAIL_INBOUND_DOMAIN` (when replies arrive on a Resend address or subdomain), optional `EMAIL_DAILY_LIMIT`, `EMAIL_THREAD_TOKENS`.

## B. How a request is authenticated

1. Non-POST: 405. Missing `RESEND_WEBHOOK_SECRET` or `RESEND_API_KEY`: 503 (fails closed). A declared or actual body over 1 MB: 413.
2. The **raw** body text is read once and signed exactly as received: HMAC-SHA256 over `<svix-id>.<svix-timestamp>.<raw body>`, key = base64 decode of the secret without its `whsec_` prefix, result compared in constant time with every `v1,` signature in the header.
3. `svix-id`, `svix-timestamp` and `svix-signature` are all required. The timestamp must be plain integer seconds within 5 minutes of now (past or future), which stops replays.
4. Any failure answers 401 **before any database call**. Only then is the JSON parsed.

## C. Which inbox receives a message (organization / account routing)

Resend's webhook and receiving API carry no organization. Ownership is therefore decided from data already in the database, never guessed:

- Each recipient (To, then Cc, then Bcc; at most 20, invalid addresses dropped, `+tags` removed) is matched to **active Resend accounts** by exact address. If `EMAIL_INBOUND_DOMAIN` is set, a recipient at that domain also matches an account with the same local part (`john+k...@<id>.resend.app` -> `john@...`).
- There is **no** domain-wide catch-all and **no** default-account fallback any more.
- A recipient that matches more than one account, or matches that span more than one organization, is **ambiguous**: the event is acknowledged as *ignored* with the reason `ambiguous inbox` (visible in `email_webhook_events.error`) and nothing is stored. No match: ignored as `no matching inbox`.
- Within a single organization the first matching recipient wins (deterministic).
- Thread lookups (reply token, Message-ID headers, subject) are scoped to that organization **and** account. The database re-validates everything: `email_ingest_inbound()` refuses (raises, before inserting anything) an account that does not belong to the organization, is not active, is not a Resend account, or a conversation of another organization or another account. Composite foreign keys (added `NOT VALID`, so enforced for all new rows) make the same mismatch impossible even for a direct insert.
- **Configuration this needs:** every address you want to receive on must exist as an active row in `email_accounts` (add it in CRM > Inbox). The same address must not be active in two organizations; if it is, mail to it is ignored as ambiguous.

## D. Retry, idempotency and the claim state machine

Each Svix delivery id has one row in `email_webhook_events`. `email_webhook_claim()` takes a row lock, so only one request owns an event at a time, and `email_webhook_finish()` records a result only for the owner's claim token.

```
(no row)                  --claim--> processing   (new token, lease 5 min, attempts = 1)
processing, lease valid   --claim--> BUSY         HTTP 409: the sender retries later (so a crashed owner is still recovered)
processing, lease expired --claim--> processing   (new token, attempts + 1)   crashed worker recovered
failed (or legacy "received") --claim--> processing (new token, attempts + 1)
processed | ignored       --claim--> DONE         HTTP 200 duplicate, nothing runs
attempts >= 12, unfinished --claim--> EXHAUSTED   status failed, HTTP 200 so the sender stops
finish(token, ...)        succeeds only if this token still owns the row; otherwise HTTP 409 and the result is discarded
```

- Any processing error answers 500 and records `failed`, so Resend retries (its own schedule bounds this; the database stops at 12 attempts).
- A database failure at any step (flag read, claim, account lookup, thread lookup, ingest, finishing) answers 500. It is never read as "no result" and never acknowledged as success.
- Processing is idempotent even if two workers ever overlap: unique indexes on the Resend id and on the Message-ID, an event id applied once, and `ON CONFLICT` guards.
- To replay an event that reached the limit: `update public.email_webhook_events set attempts = 0, status = 'failed' where svix_id = '<id>';` then resend it from the Resend dashboard.
- Delivery events: only `provider = 'resend'` **outbound** messages are updated, and only when the provider id matches exactly one message (two matches are ignored and logged). Statuses move strictly forward (sent < delayed < delivered < bounced/failed/rejected < complained), so delivered never returns to sent and a bounce is never replaced by a later "failed". Unsupported statuses are refused. A delivery event for an id we do not have yet is retried if it is under 2 minutes old (our own write may not have landed), otherwise ignored.
- Events without an email id are ignored.

## E. Deployment (CMD, for the owner to run later; none of this was run)

Read-only checks first:

```
cd /d C:\path\to\kaiflow
supabase link --project-ref hlplzosdgciavucaebfd
supabase migration list
supabase secrets list
```

`supabase migration list` shows local versus remote history. The repository has an older duplicate timestamp (`20261012090000` is used by two files); do not rename anything to fix it. If `supabase db push --dry-run` complains about history, apply the single new file by pasting it into the Supabase SQL editor after reviewing it instead.

Verify in the SQL editor (read-only) that the first migration is applied and look at current data:

```
select to_regclass('public.email_webhook_events'), to_regprocedure('public.email_ingest_inbound(jsonb)');
select organization_id, address, status, provider from public.email_accounts order by 1, 2;
select m.id from public.email_messages m join public.email_conversations c on c.id = m.conversation_id where c.organization_id <> m.organization_id or c.account_id <> m.account_id;
select svix_id, event_type, status, attempts from public.email_webhook_events order by received_at desc limit 10;
```

The third query must return no rows; if it does, tell me before applying. Then:

```
supabase db push --dry-run
supabase db push
supabase functions deploy email-send --project-ref hlplzosdgciavucaebfd
supabase functions deploy resend-webhook --no-verify-jwt --project-ref hlplzosdgciavucaebfd
```

Apply the migration **before** deploying the new function code: the new webhook calls `email_webhook_claim`, which exists only after the migration. Order matters.

## F. Controlled test procedure (after deployment)

1. In Resend, send a test delivery to the endpoint, or send yourself a message from CRM > Inbox and reply from outside.
2. `select svix_id, event_type, status, attempts, error from public.email_webhook_events order by received_at desc limit 10;` should show `processed`. An `ignored` row shows its reason.
3. Resend the same delivery from the Resend dashboard: the response must be a duplicate success and no second message appears.
4. Optional concurrency check: in two SQL sessions run `begin; select public.email_webhook_claim('probe-1','x','{}'::jsonb);` in the first, then the same in the second; the second must wait until the first commits or rolls back, then report `busy`. Roll both back.
5. Confirm that Gmail and Zoho still show as paused.

## G. Rollback

- Functions: redeploy the previous versions of `email-send` and `resend-webhook` (note the previous webhook code expects no claim functions, so it keeps working with the new migration in place).
- Database: the commented rollback at the end of the migration drops only the new constraints and functions. The new columns and the widened status check are harmless to leave. To restore the previous function bodies, re-run the function definitions from `20261110090000_email_resend_core.sql`.
- `ALTER TABLE ... VALIDATE CONSTRAINT` for the two new foreign keys is left to the owner (see the notes at the end of the migration).

## H. Known limitations (honest list)

- The new SQL (`email_resend_hardening.test.sql`) and everything against real Resend responses have **not been run**. The JavaScript logic is tested with fakes (51 email tests), including a model of the claim state machine; the database enforces the real thing and needs its own run.
- True simultaneous claiming is guaranteed by PostgreSQL's row lock, which one in-memory test cannot prove; use step 4 above.
- Ambiguous inbound mail is acknowledged and dropped (logged as `ignored`), not queued for review.
- A mail accepted by Resend whose "sent" status could not be saved stays "sending"; delivery events for it are ignored after 2 minutes.
- `email-send` now requires the sending account to match the conversation's account (database constraint). Choosing a different "From" in an existing thread fails with a generic error.
- Webhook-only design: no polling backstop if Resend never delivers an event.
- Resend's received-email response shape follows their public docs and has **not** been seen from a real account. Parsing accepts common variants (headers as an object or list, recipients as strings or objects, snake/camel case names). If the essentials (sender, recipients) are missing, the event fails and `email_webhook_events.error` reads `Unexpected received-email shape ... Fields seen: ...` (field names only, never content), so a wrong assumption is visible instead of silently storing blank mail. Send that error text, not the message, when reporting it.
