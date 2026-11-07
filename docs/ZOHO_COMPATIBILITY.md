# Zoho Mail compatibility report

**Status: NOT verified against your real account.** No OAuth was started, no Zoho call was made, and no email was sent (as instructed).
This report separates what is documented, what is only reported by third parties, and what only a read-only test on your account can settle.

## What Intelligence uses (Zoho Mail REST API, not Zoho CRM and not SMTP/IMAP)
| Operation | Endpoint (per account id) | Scope |
|---|---|---|
| Look up account id | `GET /api/accounts` | `ZohoMail.accounts.READ` |
| List folders (find Inbox / Sent ids) | `GET /api/accounts/{id}/folders` | `ZohoMail.folders.READ` |
| Read replies, find the sent copy | `GET /api/accounts/{id}/messages/view` | `ZohoMail.messages.READ` |
| Send | `POST /api/accounts/{id}/messages` | `ZohoMail.messages.CREATE` |
| Send as a threaded reply | `POST /api/accounts/{id}/messages/{messageId}` with `action: "reply"` | `ZohoMail.messages.CREATE` |

Nothing else is requested: no delete, no settings, no contacts. Scopes live in `supabase/functions/_shared/intel_zoho_logic.ts` (`ZOHO_SCOPES`).
Because the integration is REST, it does **not** need IMAP, POP or SMTP.

## What the Free plan is reported to restrict
- Zoho's Free plan is described across several sources as **webmail only: no IMAP, POP3 or ActiveSync, and SMTP sending from other apps is not included** (Zoho community threads, Ghost forum, Capterra, review sites). Those restrictions do not by themselves matter to a REST integration.
- **Unknown: whether OAuth + REST calls are permitted on a Free mailbox.** I found no authoritative Zoho statement either way, and some sources conflict. Treat it as unproven until the read-only test below passes.
- Free-plan sending limits for a single mailbox are Zoho's and are not documented in a form the code can read. Intelligence's own cap is 30 introductions a day with warm-up, which is deliberately conservative; Zoho may block earlier ("554 5.1.8 outgoing blocked" style errors are reported in the community). The worker treats any such response as a failure for that message, not as "sent".
- The 25 MB attachment limit and 5 GB mailbox are irrelevant (text-only email, no attachments).

## What only a test on your account can answer (read-only first)
1. **Data centre.** Zoho accounts live in a region (`.com`, `.eu`, `.in`, `.com.au`, `.jp`, `.ca`, `.sa`, `.zoho.com.cn`). Tokens from one region are rejected by another. The connect function takes the data centre suffix (`com`, `eu`, `in`, `com.au`, `jp`, `ca`, `sa`, ...) from an allowlist; pick the one shown in your Zoho URL.
2. **OAuth works at all** for the Free mailbox (consent screen, refresh token issued; the client must be Server-based with Access Type *Offline*).
3. **`GET /accounts` and `GET /folders` succeed** (that is exactly what `python -m kairflow_intel selftest zoho` does: it reads folders and nothing else).
4. **Reading the Inbox works** (`messages/view`), including the fields used to match replies (`messageId`, `subject`, `fromAddress`, `receivedTime`).
5. **Rate limits.** Zoho publishes per-minute and daily API call limits that depend on the plan; the client backs off on HTTP 429 and treats it as "unknown outcome" for sends (never retried blindly).

## Replies and threading (what is and is not guaranteed)
- Matching an incoming reply to its prospect uses, in order: the message reference token the worker adds to the body, then `In-Reply-To`/`References` Message-IDs, then the sender address matching the prospect's known contact address. The token match does not depend on threading headers being set.
- **Threading headers on outgoing follow-ups:** the Zoho REST send call has no field for arbitrary `In-Reply-To`/`References`. The worker therefore uses Zoho's *reply* action on the previous message, so Zoho sets the headers itself. **I could not confirm this endpoint behaves identically on the Free plan.** If Zoho refuses the reply action (HTTP 4xx), the worker fails the message for manual review and does not fall back to a new unthreaded message. This is deliberately fail-closed: a reply must not silently become a new conversation. Uncertain outcomes (timeouts, 429, 5xx) are never retried: the message is marked `unknown` and reconciled against the Sent folder.
- Follow-ups to leads you emailed by hand from the CRM have no Message-ID on file, so they are sent as new messages with the subject `Following up: ...` rather than a fake `Re:`.

## If the Free plan cannot do it
In order of least change:
1. **Upgrade the mailbox to Mail Lite** (the cheapest paid tier; unlocks IMAP/POP/SMTP and is the first thing to try if REST calls are refused). No code change.
2. Use a Zoho paid plan with higher sending limits if Zoho throttles you.
3. A different provider only with your explicit decision. Intelligence does **not** silently substitute one. The mail layer is isolated in `zoho.py`/`mailops.py`, so a replacement is a contained change.

## Test sequence (you run it; nothing here sends email)
1. Create the OAuth client in the Zoho API Console (Server-based, Offline), set the redirect URI to the `intel-zoho-callback` function URL, store `ZOHO_CLIENT_ID`/`ZOHO_CLIENT_SECRET` as Supabase function secrets.
2. In KairFlow > Intelligence > Settings, press **Connect Zoho** (this is the step that starts OAuth; it only happens when you press it).
3. `python -m kairflow_intel selftest zoho` must print `zoho folders readable: OK`.
4. Only after that, and only if you decide to, send a single test message from the Outreach tab to an address you own, with sending turned on for that one message.
