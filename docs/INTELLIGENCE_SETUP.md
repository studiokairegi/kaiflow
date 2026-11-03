# KairFlow Intelligence: setup and deployment checklist

Nothing below has been applied, deployed or run against your real Supabase project or Zoho account. Do these in order, and stop at
the first thing that fails.

## A. Before anything
1. Back up the database (Supabase dashboard).
2. Confirm `trg_protect_privileged_user_settings` exists (see `docs/INTELLIGENCE_AUTHORIZATION.md`). The first migration warns if not.
3. Run the SQL tests on a throwaway local Postgres 16: `PGUSER=postgres ./supabase/tests/run_intelligence_auth.sh`. They have never been run.

## B. Database (apply in this order; each is safe to run twice)
`20261107090000_intelligence_authorization.sql`, `20261108090000_intelligence_core_tables.sql`,
`20261108100000_intelligence_crm_notifications.sql`, `20261108110000_intelligence_rpcs.sql`, `20261108120000_intelligence_zoho_oauth.sql`.
They only add tables, functions, an index and three columns on `leads` (`source_kind` defaults to `manual`, the other two are NULL for every existing lead).

## C. App code
Copy the new files over your repo, then apply the three patches in `patches/` (`git apply patches/*.patch`, or by hand). They touch `src/App.jsx`
(about 70 lines, wiring only), `src/notifications/logic.js` (adds the Intelligence event types) and its test. Then `npm run build` and `npm test`.
Python tests: `cd intelligence-worker && python -m unittest discover -s tests -t .`

## D. Zoho Mail (server side)
1. Check your Zoho plan allows API access (Zoho says availability depends on plan and permissions). If it does not, stop here: Intelligence still
   researches and drafts, and you can send manually.
2. In Zoho's API console (use your data center's console) create a **Server-based** client. Redirect URI =
   `https://<project>.supabase.co/functions/v1/intel-zoho-callback`.
3. Supabase Edge Function secrets (names only): `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REDIRECT_URI`, `INTEL_TOKEN_ENCRYPTION_KEY`
   (new random 32-byte key, base64; do not reuse the Drive key), `APP_URL`.
4. Deploy: `supabase functions deploy intel-zoho-connect`, `supabase functions deploy intel-zoho-token`,
   `supabase functions deploy intel-zoho-callback --no-verify-jwt`.
5. In the app: Intelligence > Settings > Connect Zoho Mail.
6. Add DNS records for your sending domain if not already present (SPF, DKIM, DMARC) before sending anything.

## E. First run (nothing is sent)
1. Intelligence > Setup: sender name, Zoho address, postal address, time zone.
2. Settings > Knowledge base: write and approve `studio.about`, `services.indie_game_developer`, `services.animation_studio_support`, `portfolio.main`.
3. Register the agent account; start the worker (see `intelligence-worker/README.md`).
4. Activate a campaign and press Run discovery. Review what it finds. Sending stays OFF and every email needs your approval.
5. Only when you are happy with the drafts: Overview > Enable sending. It starts at 5 introductions a day and rises weekly (warm-up) up to your limit (max 30).

## F. Legal and platform
Public email addresses are not blanket permission to send marketing. Before enabling sending, get short advice for the regions you will write to
(US CAN-SPAM, EU/UK GDPR/PECR, Kenya's Data Protection Act, Japan's email law). Every message carries your postal address and an opt-out line, and opt-outs are honored automatically.
Check each source's terms (Steam, itch.io) before enabling it. Kickstarter and X are intentionally not implemented.
