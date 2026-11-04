# Connecting Gmail to KairFlow Intelligence (free mailbox provider)

**Status: built and unit-tested, never run against a real Google account.** Nothing here starts OAuth or sends email until you press Connect and later turn sending on yourself.

## Why Gmail
It is the one free option that can send, read replies and set `In-Reply-To`/`References` exactly, all through one API. Consumer Gmail allows far more sends per day than Intelligence's own cap (30 introductions/day with warm-up). All safety rules are unchanged: approvals, caps, suppression list, one introduction per address, unknown-send handling, emergency stop.

## Before you start
- Create a **dedicated Gmail account** for outreach (not your personal one). Use it only for this.
- Mail goes out from an `@gmail.com` address. Deliverability to strangers is weaker than from your own domain, and Google may suspend accounts it sees sending bulk mail. Keep the 30/day cap and warm-up, keep the opt-out line and postal address footer (already enforced), and do not raise limits quickly.
- The **Sender email** in Intelligence > Settings must equal this Gmail address. The worker refuses to send otherwise (Gmail would silently rewrite the sender).
- Also set the account's profile name to your studio name so recipients see a real sender.

## 1. Google Cloud (about 10 minutes)
1. console.cloud.google.com > create a project (e.g. "KairFlow Intelligence").
2. **APIs & Services > Library**: enable **Gmail API**.
3. **OAuth consent screen**: user type **External**; app name, support email; add your Gmail address as a test user for now.
4. **Scopes**: add exactly `.../auth/gmail.send` and `.../auth/gmail.readonly`. Nothing else.
5. **Credentials > Create credentials > OAuth client ID > Web application**. Authorized redirect URI:
   `https://<your-project-ref>.supabase.co/functions/v1/intel-gmail-callback`
6. Copy the client ID and secret.
7. **Publish the consent screen to "In production".** While it is in *Testing*, Google expires refresh tokens after 7 days and the connection will break weekly. For one personal account you do not need Google's verification; Google shows an "unverified app" warning once at connect time (Advanced > continue). Confirm both points on your own consent screen: Google's rules change.

## 2. Supabase secrets and functions (run by you, staging first)
```
supabase secrets set GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \
  GOOGLE_REDIRECT_URI=https://<ref>.supabase.co/functions/v1/intel-gmail-callback \
  APP_URL=https://<your KairFlow URL> INTEL_TOKEN_ENCRYPTION_KEY=<same secret the Zoho functions use, 32 random bytes base64>
supabase db push        # applies 20261109150000_intelligence_gmail_provider.sql (after the earlier Intelligence migrations)
supabase functions deploy intel-gmail-connect
supabase functions deploy intel-gmail-token
supabase functions deploy intel-gmail-callback --no-verify-jwt     # Google's redirect carries no session; trust comes from the single-use state
```
The refresh token is encrypted with `INTEL_TOKEN_ENCRYPTION_KEY` and never leaves the server: the worker only receives short-lived access tokens, and only the registered agent account can ask for one.

## 3. Connect (this is the step that starts OAuth)
KairFlow > Intelligence > Settings > **Connections** > choose **Gmail** > **Connect Gmail**. Sign in with the dedicated account and leave **both** permissions ticked. KairFlow shows a result banner: connected / cancelled / missing permission / error. If only one permission is granted, nothing is saved.

## 4. Worker
Add to the worker env file: `KAIRFLOW_MAIL_PROVIDER=gmail`. Then, read-only:
```
python -m kairflow_intel selftest gmail      # expects: "gmail mailbox readable: OK (signed in as <your address>)"
```
It reads your profile and the newest inbox entry. It never sends. The token functions refuse a mismatch (worker says Gmail while Zoho is connected, or the reverse), so a wrong setting fails loudly instead of sending through the wrong account.

## 5. First real send (only when you decide)
Keep autonomy on *shadow*, approve **one** message to an address you own, check it arrives threaded and the Message-ID is stored, then continue. Turning sending on is a deliberate click on the Overview tab and is refused until a mailbox is connected, the agent is registered, and sender email, postal address and opt-out text are set.

## What can go wrong (and what you will see)
| Symptom | Cause | What happens |
|---|---|---|
| Mailbox shows an error, "Google revoked the Gmail connection" | password changed, access removed, 6 months unused, or app still in Testing (7-day tokens) | Sending pauses for that message (nothing marked sent); reconnect in Settings |
| "Sender email in Settings must equal the connected Gmail address" | settings mismatch | message fails before sending; fix Settings |
| HTTP 429 / network timeout while sending | Google throttling or outage | message marked **unknown**, never retried blindly; reconciled against the Sent label |
| Google disables the account | bulk-mail policy | all sends fail; stop, review volume and content; use a different mailbox only by your decision |

## Alternatives considered
- **Zoho Mail:** still supported; choose it in Settings. Free-plan API access is unverified (`ZOHO_COMPATIBILITY.md`).
- **Cloudflare:** Email Routing (free) only *receives and forwards* mail. Cloudflare's sending product is newer, aimed at transactional mail, and as far as I could tell needs a paid Workers plan to send to arbitrary recipients; the older `send_email` binding only sends to addresses you have verified. It has no mailbox to read replies from, so it cannot replace Gmail here, and I did not review its acceptable-use terms for cold outreach (check before considering it). It could later be useful for system notification emails, not prospecting.
- **Resend / Brevo / SES / Mailgun:** send-only, no mailbox; most restrict cold outreach in their terms.
- **Microsoft Graph (Outlook.com):** viable in principle, not built, free limits unverified.
