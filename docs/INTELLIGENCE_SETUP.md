# KairFlow Intelligence: setup and deployment checklist

Nothing below has been applied, deployed or run against your real Supabase project, mailbox or Zoho/Google account. Do these in order, and stop at
the first thing that fails.

**Where it lives in the app:** **CRM > Intelligence** (a sub-tab next to Pipeline, Contacts and Portfolio). It is part of the CRM module, not a separate top-level module, and it is shown only to a user who is an admin AND an active Master User. Everywhere this doc says "Intelligence > X", read it as "CRM > Intelligence > X".

## A. Before anything
1. Back up the database (Supabase dashboard).
2. Confirm `trg_protect_privileged_user_settings` exists: run `docs/verify_live_database.sql` (read-only). The first migration only warns if it is missing, so do not skip this.
3. Run the SQL tests on a throwaway local Postgres 16: `PGUSER=postgres ./supabase/tests/run_intelligence_auth.sh`. They have never been run: run them before step B (they now also cover the V1 migration, `intelligence_v1.test.sql`).

## B. Database (apply in this order; each is safe to run twice)
`20261109090000_intelligence_authorization.sql`, `20261109100000_intelligence_core_tables.sql`,
`20261109110000_intelligence_crm_notifications.sql`, `20261109120000_intelligence_rpcs.sql`, `20261109130000_intelligence_zoho_oauth.sql`, `20261109140000_intelligence_v1_completion.sql`, `20261109150000_intelligence_gmail_provider.sql`, `20261109160000_intelligence_chat_actions.sql`, `20261109170000_intelligence_discovery.sql`.
The sixth adds the existing-lead review, Agent Chat, and tightens `crm_find_lead_duplicates` (see `INTELLIGENCE_V1_COMPLETION.md`). The last one adds autonomous discovery (sources, items, aliases, customer profile; section H). The core and RPC migrations also carry the sending window (08:00-18:00 weekdays by default, editable in Settings) and the Disconnect-mailbox function.
They all sort after your newest earlier migration (`20261108090000_portal_message_participant_identity`). Do not rename them.
They only add tables, functions, an index and three columns on `leads` (`source_kind` defaults to `manual`, the other two are NULL for every existing lead).

## C. App code
This repository already contains everything: the Intelligence files, the wiring in `src/App.jsx` and `src/notifications/logic.js`, the worker in
`intelligence-worker/`, and the Edge Functions in `supabase/functions/intel-zoho-*`. No patches to apply. Verify:
```
npm ci
npm test                 # 639 tests expected to pass
npm run build            # must finish without errors (not yet run: needs your machine)
cd intelligence-worker && python -m unittest discover -s tests -t .      # 111 tests
```

## D. Mailbox provider: Gmail (recommended, free) or Zoho Mail
For Gmail follow `docs/GMAIL_SETUP.md` and skip the rest of this section; set `KAIRFLOW_MAIL_PROVIDER=gmail` on the worker. For Zoho:
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
3. For Japanese animation-studio outreach, also add and approve these four separate entries in Settings > Knowledge base. Emma uses them only when an animation-support prospect's researched site language is Japanese or its country is Japan; if any is missing or unapproved, drafting stops rather than falling back to English. Keep the portfolio URL identical to an already-approved Studio Kairegi portfolio URL. Suggested concise copy (review and approve before use):
   - `studio.about.ja` (kind `studio`): `Studio Kairegiは、2Dアニメーション制作スタジオです。`
   - `services.animation_studio_support.ja` (kind `service`): `レイアウト（LO）、原画（Genga）、動画（Douga）、クリーンアップなどの作画工程に対応しています。`
   - `portfolio.main.ja` (kind `portfolio`): `制作実績はこちらからご覧いただけます：[approved Studio Kairegi portfolio URL]` (use the exact URL already approved in `portfolio.main`)
   - `policy.opt_out.ja` (kind `policy`): `今後のご案内が不要な場合は、このメールに「配信停止」とご返信ください。`
   The sender name and postal address remain in the compliance footer. The Japanese opt-out sentence is included from its separately approved entry; review the wording for your legal requirements before approving it.
3. Register the agent account; start the worker (see `intelligence-worker/README.md`).
4. Activate a campaign and press Run discovery. Review what it finds. Sending stays OFF and every email needs your approval.
5. Only when you are happy with the drafts: Overview > Enable sending. It starts at 5 introductions a day and rises weekly (warm-up) up to your limit (max 30).

## F. Legal and platform
Public email addresses are not blanket permission to send marketing. Before enabling sending, get short advice for the regions you will write to
(US CAN-SPAM, EU/UK GDPR/PECR, Kenya's Data Protection Act, Japan's email law). Every message carries your postal address and an opt-out line, and opt-outs are honored automatically.
Check each source's terms (Steam, itch.io) before enabling it. Kickstarter and X are intentionally not implemented.

## G. Run everything locally (nothing is deployed, nothing is sent)
```
# 1. database tests on a throwaway Postgres 16 (needs psql and a superuser)
PGUSER=postgres ./supabase/tests/run_intelligence_auth.sh

# 2. the app
npm ci && npm run dev            # then open the Intelligence tab as a user who is admin AND an active Master User

# 3. the worker (Windows PowerShell)
cd intelligence-worker
py -3.11 -m venv .venv ; .\.venv\Scripts\pip install -r requirements.txt
copy .env.example ..\worker.env      # keep it OUTSIDE the repo; fill in the values
ollama pull <your model>               # Ollama must listen on 127.0.0.1 only (default); never expose port 11434
.\.venv\Scripts\python -m kairflow_intel selftest          # checks Supabase and Ollama (add `zoho` only after you approve OAuth)
.\.venv\Scripts\python -m kairflow_intel run
# start at every boot instead: see intelligence-worker\README.md (windows\install-task.ps1)
```
Environment variables are listed in `intelligence-worker/.env.example`; Supabase function secrets (`ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, token encryption key) are in section D.

## H. Deployment checklist (only when you decide to deploy)
1. [ ] `docs/verify_live_database.sql` shows every row OK (guard trigger present).
2. [ ] Database backup taken.
3. [ ] SQL tests pass on a disposable PG16, `npm test`, `npm run build`, worker tests all pass.
4. [ ] Apply migrations B in order to a **staging** Supabase project first; click through every Intelligence tab as the admin Master User, as a Master User who is not admin (must see nothing), and as an ordinary member (must see nothing).
5. [ ] Run `intel_admin_bootstrap`, register the agent account (a separate Supabase user, not an admin), leave sending **OFF** and autonomy at **shadow**.
6. [ ] Deploy the Edge Functions for your provider (`intel-gmail-*` or `intel-zoho-*`); set secrets.
7. [ ] Existing Leads tab: review the counts. Bring in a handful, check the drafts read well. Sending stays off.
8. [ ] Mailbox: read-only `selftest gmail` or `selftest zoho` (see `GMAIL_SETUP.md` / `ZOHO_COMPATIBILITY.md`). Decide separately about one test send to your own address.
9. [ ] Only then consider enabling sending: warm-up and the 30/day cap apply; keep approvals on.
10. [ ] Agent Chat on staging: ask it to prepare an approval and to turn sending on; check the card text, that nothing changes until you press Confirm, and that asking it to make someone an admin is refused.
11. [ ] Production: repeat 4 to 9 against production after staging is clean. Rollback notes are at the end of each migration.

## I. Autonomous discovery (Animation Studio Support first)
Zero cost: no paid search, lead, AI or proxy service is used anywhere. There is no free general web-search API in 2026, so discovery works from open data and
polite link-following instead of a search engine. Expect solid coverage of studios that are listed in open data or linked from other studios, and gaps for
small studios nobody links to.

1. **Run Phase 0 first** (about 3 minutes, free, read-only, writes nothing to Supabase): `python spikes/phase0_feasibility.py` from `intelligence-worker`.
   It counts how many studios Wikidata can give you, how many AniList shows in production, what GDELT returns in English and Japanese, how many recruit-style pages
   Common Crawl has for sample studios, and what the studios' robots.txt files allow. Share `phase0_report.json` and the plan gets tuned to those real numbers.
2. **CRM > Intelligence > Settings > Discovery sources.** Wikidata, the studio-site crawler, feeds and X manual assist start on. AniList, GDELT, Common Crawl, Steam and itch.io start OFF:
   read each service's terms, then press "Terms confirmed, turn on". A source that keeps failing pauses itself for an hour or more.
3. **CRM > Intelligence > Animation Studio Support > Who you want to find.** Describe the customer, press "Suggest phrases" (the local model proposes English and Japanese phrases;
   if Ollama is down, starter phrases are used), edit, Save, then Approve. News and archive discovery use only approved phrases.
4. **X:** there is no free X API, so nothing is fetched from X. Paste a recruitment post you find under "Add from an X post". The agent tells a studio from an
   individual, finds the studio's own website, and investigates it like any other prospect.
5. What runs by itself once the worker is up: weekly studio seeding (Wikidata, AniList), daily news scan (GDELT), 6-hourly feed polling, monthly archive check
   (Common Crawl), and per-studio site analysis (sitemaps, recruitment pages, feeds, credits links to other studios, 2 levels deep).
Bluesky is intentionally not included, per your decision.
