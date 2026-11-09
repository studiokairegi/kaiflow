# KairFlow Intelligence: setup and deployment checklist

Nothing below has been applied, deployed or run against your real Supabase project, mailbox or Zoho/Google account. Do these in order, and stop at
the first thing that fails.

**Where it lives in the app:** **CRM > Intelligence** (a sub-tab next to Pipeline, Contacts and Portfolio). It is part of the CRM module, not a separate top-level module, and it is shown only to a user who is an admin AND an active Master User. Everywhere this doc says "Intelligence > X", read it as "CRM > Intelligence > X".

## A. Before anything
1. Back up the database (Supabase dashboard).
2. The two historical Intelligence authorization migrations now install the `is_admin`/`plan` protection before defining Intelligence access functions. The later `20261201090000_intelligence_phase11_privileged_user_guard.sql` is retained as a corrective, idempotent guard migration for databases that already applied the older sequence.
3. Run `docs/verify_live_database.sql` against the target database and require the trigger check to pass. A migration file in Git is not proof that the live trigger exists.
4. Run the SQL tests on a throwaway local Postgres 16: `PGUSER=postgres ./supabase/tests/run_intelligence_auth.sh` before deployment.

## B. Database migrations

Do not deploy only the original nine-file Intelligence starter sequence. The repository now contains incremental migrations for CRM takeover, re-engagement, reevaluation, contactability, provider accounts, multi-account dispatch, SMTP, delivery events, the final-send boundary, source-registry enforcement, schema alignment, privileged-user protection, worker reliability, and multi-account inbound synchronization.

For a normal Supabase deployment, first run `supabase migration list` and review the local/remote history. Then apply **all pending repository migrations** in timestamp order using the project's standard migration workflow (for example, `supabase db push`) against staging first. Do not cherry-pick later phases or manually mark migrations applied without verifying their SQL effects. The required Intelligence sequence starts after the existing `20261108090000_portal_message_participant_identity` baseline and includes, in timestamp order:

- `20261108130000_intelligence_authorization.sql` (includes the privileged-user guard before access functions) and the corresponding `20261109*` canonical Intelligence base migrations
- `20261109140000_intelligence_v1_completion.sql` through `20261109170000_intelligence_discovery.sql`
- `20261110090000_email_resend_core.sql` through `20261112090000_email_resend_intelligence.sql` (separate transactional integration)
- All subsequent `20261113*` through `20261130*` Intelligence migrations, including the provider registry, multi-account dispatch, final-send boundary and source registry
- `20261201090000_intelligence_phase11_privileged_user_guard.sql`, `20261202090000_intelligence_phase12_worker_reliability.sql`, and `20261203090000_intelligence_multi_account_inbox_sync.sql`

The migration directory is the source of truth for the complete sequence; preserve filenames and timestamps. The Phase 13 migration adds account-scoped receive cursors and agent-only RPCs. It does not enable sending or change provider account gates. After deployment, verify the guard trigger, provider registry, receive-account RPCs and worker RPC signatures before starting Emma.

## C. App code
This repository already contains everything: the Intelligence files, the wiring in `src/App.jsx` and `src/notifications/logic.js`, the worker in
`intelligence-worker/`, and the Edge Functions in `supabase/functions/intel-zoho-*`. No patches to apply. Verify:
```
npm ci
npm test                 # 831 tests passed in the source-patch verification
npm run build            # run after npm ci; not verified in the patch environment
cd intelligence-worker && python -m unittest discover -s tests -t .      # 482 tests passed in the source-patch verification
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
3. For Japanese-language outreach, add and approve these five separate entries in Settings > Knowledge base. Language is selected from the prospect's researched site language/country and the recipient's current or established inbound conversation language. If a required entry is missing or unapproved, drafting stops for human review rather than falling back to English. Keep portfolio URLs identical to already-approved Studio Kairegi portfolio URLs. Translate the approved English service descriptions faithfully; do not invent services. Suggested entries:
   - `studio.about.ja` (kind `studio`): Japanese version of the approved `studio.about`.
   - `services.animation_studio_support.ja` (kind `service`): Japanese version of the approved animation-studio service description; distinguish レイアウト, 原画, 動画 and 仕上げ accurately.
   - `services.indie_game_developer.ja` (kind `service`): Japanese version of the approved indie-game developer service description.
   - `portfolio.main.ja` (kind `portfolio`): Japanese introduction using the exact URL already approved in `portfolio.main`.
   - `policy.opt_out.ja` (kind `policy`): Japanese opt-out sentence reviewed for your legal requirements.
   The sender name and postal address remain in the compliance footer. The Japanese opt-out sentence is included from its separately approved entry.
4. Register the agent account; start the worker (see `intelligence-worker/README.md`).
5. Activate a campaign and press Run discovery. Review what it finds. Sending stays OFF and every email needs your approval.
6. Only when you are happy with the drafts: Overview > Enable sending. It starts at 5 introductions a day and rises weekly (warm-up) up to your limit (max 30).

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

## Dynamic provider foundation (Phase 2)

The initial provider-registry and multi-account foundation is documented in [PHASE_2_PROVIDER_FOUNDATION.md](./PHASE_2_PROVIDER_FOUNDATION.md). The safe worker default remains `KAIRFLOW_MAIL_PROVIDER=none`. Gmail's new account-scoped adapter requires both `KAIRFLOW_MAIL_PROVIDER=gmail` and `KAIRFLOW_MAIL_ACCOUNT_ID`, and the provider/account sending gates remain disabled until the later dispatcher and management-interface increments are deployed. Do not enable sending by editing account rows manually.


### Multi-account provider management (Phase 2.4)

After applying the provider foundation and account-management migrations and deploying the three `intel-provider-*` Edge Functions, open Intelligence → Settings → Email provider accounts. Additional Gmail accounts can be connected independently. New accounts are intentionally sync-disabled and send-disabled until later dispatch/policy work is complete. Zoho multi-account OAuth is not yet available.

### Phase 2.5 multi-account dispatch

See `PHASE_2_5_MULTI_ACCOUNT_DISPATCH.md`. Apply migration `20261125090000_intelligence_multi_account_dispatch.sql` only after staging validation. New provider/account send gates are OFF by default. Prospecting requires an explicit exact-recipient permission record; business correspondence requires an inbound thread. Per-mailbox limits default to 25/day, 5/hour, and 1/minute. Do not enable sending until the staging checks and dedicated-mailbox end-to-end tests are complete.

### Phase 2.6 SMTP adapter

See [`PHASE_2_6_SMTP_ADAPTER.md`](./PHASE_2_6_SMTP_ADAPTER.md) for SMTP account setup, security behavior, deployment files, and the send-only limitations. SMTP cannot synchronize inbound replies; connect Gmail or Zoho for reply tracking.

### Phase 13 multi-account inbound synchronization

Apply `20261203090000_intelligence_multi_account_inbox_sync.sql` after the provider registry and Phase 10 schema-alignment migrations. The worker now enumerates connected, enabled Gmail/Zoho accounts and keeps an independent sync cursor per account. Provider-local message IDs are namespaced by provider and account before they enter the existing inbound idempotency path. SMTP remains send-only, and Resend remains outside the prospect dispatcher. Keep the kill switch ON until each mailbox has passed a read-only sync test and a controlled reply has been matched to the correct outbound conversation.
