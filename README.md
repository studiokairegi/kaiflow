# KairFlow Intelligence worker (Windows)

A background process on your own computer. It signs in to Supabase as its own limited **agent account**, reads public pages,
asks your **local Ollama** model to read and draft, and talks to the selected mail provider through server-side connections. Resend credentials remain in Supabase Edge Function secrets. It never holds
the Supabase service-role key or any Zoho secret. It can only call `intel_agent_*` functions (enforced here and in the database).

## 1. One-time setup
1. Install Python 3.11+ and create the environment:
   `py -3.11 -m venv .venv` then `.venv\Scripts\pip install -r requirements.txt`
2. Install Ollama, then pull the two models (about 2 GB and 1 GB; both fit a 4 GB GPU):
   `ollama pull qwen2.5:3b-instruct` and `ollama pull qwen2.5:1.5b-instruct`.
   Leave Ollama on its default address `127.0.0.1:11434`. The worker refuses to start if it is configured for any other address.
   Do not open that port in the Windows firewall.
3. In Supabase Auth create a user such as `intelligence-agent@yourdomain` with a long random password. It must **not** be an
   administrator or a studio member. Copy its user id, then register it in the app: Intelligence > Settings > Connections.
4. Put the settings from `.env.example` into machine environment variables (or a file outside the repository). For the
   password, prefer Windows Credential Manager: `pip install keyring`, then
   `python -c "import keyring; keyring.set_password('kairflow-intelligence','AGENT_EMAIL','PASSWORD')"` and leave `KAIRFLOW_AGENT_PASSWORD` unset.
5. Optional, Gemini for Agent Chat: set `KAIRFLOW_GEMINI_API_KEY` (and optionally `KAIRFLOW_GEMINI_MODEL`, default `gemini-2.5-flash`) in worker.env, or store the key in Windows Credential Manager under service `kairflow-intelligence-gemini`, user `api-key`. Gemini then plans Agent Chat turns and Ollama is the automatic fallback (a bad key or model pauses Gemini for 10 minutes). Research, classification and drafting stay on local Ollama. Chat text and tool results (prospect names, statuses, counts) are sent to Google, so use a billing-enabled project key. The worker heartbeat reports which backend answered last as `chat_llm`. Check it with `python -m kairflow_intel selftest gemini`.
5. Check everything without sending anything: `python -m kairflow_intel selftest`
   (`selftest gmail` and `selftest zoho` are read-only mailbox checks; neither sends email.)

## Phase 2 production hardening migration

Before deploying the Phase 2 worker update, apply `supabase/migrations/20261119090000_intelligence_phase2_global_send_pacing.sql` after the existing Intelligence migrations. This migration adds the organization-wide send-spacing reservation, an emergency-stop recheck immediately before the provider-call state, and the bounded outbound-history RPC used for cross-recipient duplicate checks. If the migration is not applied, the worker intentionally fails closed rather than sending without the new coordination contract.


## Phase 3 — Japanese-language drafting

Japanese-language prospects and Japanese inbound conversations use the Japanese model composer for initial outreach, follow-ups, re-engagement and replies. The composer uses the same local Ollama client, verified-evidence trace, organization-wide similarity history, one-regeneration rule, outbound policy validation and human-approval boundary as Phase 2. It does not use fixed Japanese email templates.

Before Japanese drafting is available, approve these Knowledge base entries in Intelligence > Settings:
- `studio.about.ja`
- `services.animation_studio_support.ja`
- `services.indie_game_developer.ja`
- `portfolio.main.ja` (must use an already-approved Studio Kairegi URL)
- `policy.opt_out.ja`

The service entry matching the prospect type is required. If any required entry or verified prospect research is missing, the draft is flagged for human review; English fallback is not used. Japanese pricing, contract, deadline, capacity, complaint and opt-out replies remain human-review cases. All model-written drafts stay pending approval (`auto_ok=false`).

## Resend responsibility boundary

Resend is **not** an installed prospect-outreach adapter in this worker. The prospect dispatcher supports account-scoped Gmail and Zoho Mail receive/send adapters and SMTP send-only accounts. The provider registry intentionally excludes Resend; `KAIRFLOW_MAIL_PROVIDER=resend` is therefore invalid and must not be configured.

The separate Resend transactional/Inbox Edge Functions remain independent of Emma's prospect dispatcher. Their credentials belong only in Supabase Edge Function secrets, never in the worker environment. Intelligence cold-outreach drafts must use an enabled Gmail/Zoho/SMTP account, and inbound replies to those accounts are synchronized by the worker. Resend webhooks do not substitute for syncing those mailboxes.

## Agent Chat and existing leads
The worker also answers Agent Chat messages and prepares follow-up drafts for existing CRM leads you bring in. Neither can send email: sending is only ever
done from an approved message in the Outreach tab, subject to the daily limits, warm-up, suppression list and emergency stop.

## Taking over existing CRM leads from a pasted conversation (phase 1)
Leads you already contacted by hand, or from another mailbox, have no history in Intelligence's own mailbox. In **Intelligence > Existing Leads**, use **Paste conversation** on a lead:
1. Paste the earlier email thread. KairFlow splits it into messages (quoted replies, Outlook/Gmail headers and Japanese headers are recognised). You confirm who wrote each message and the date of the newest one.
2. Saving stores the conversation and queues a `takeover` job. The worker reads the thread and decides one step: **follow up** (you wrote last and it is due), **reply** (they showed interest), **wait** (not due yet or an automatic reply), **needs you** (price, contract, meeting, deadline, availability or anything unclear) or **stop** (declined, opted out, or the 4-email sequence is finished). A pasted unsubscribe or complaint suppresses the address.
3. The only text the model writes is one middle paragraph, which must refer to the real conversation and contain no link, price or unverifiable claim; otherwise a safe template is used. Greeting, studio facts, links, opt-out sentence, postal address and sign-off come from approved text. Take-over drafts always wait for your approval in Outreach, whatever the autonomy setting.
4. Once a follow-up is due later, the hourly follow-up scan hands the lead back to the same take-over logic, so the draft continues your conversation instead of using the generic template.

**Email rule:** a lead is only followed up or contacted if it has an email address in the CRM, and the message goes to exactly that address. This is enforced when a draft is created and again when a send is reserved. A lead whose email is removed or changed stops receiving anything until fixed.
Never-contacted CRM leads with an email can also get an introduction draft from the same screen (**Draft introductions**).

Apply `supabase/migrations/20261116090000_intelligence_crm_takeover.sql`, then restart the worker (Settings > Stop Emma / Start Emma). Needs Ollama running and the approved knowledge base filled in, as for other drafts.

## 2. Run from the KairFlow app (Windows, recommended)

The browser cannot launch a Python process on your computer by itself. Install the small local controller once; it runs on `127.0.0.1` only and accepts control requests only from `https://app.studiokairegi.com` (plus the local Vite development origin). It requires a per-install bearer token in addition to exact Origin/Host checks, and never returns or logs worker credentials or the controller token.

1. Complete the Python environment setup above.
2. In a normal PowerShell window, run `.\windows\install-controller.ps1` from this folder. It creates `%LOCALAPPDATA%\KairFlowIntelligence\worker.env` and a random per-install `controller.token`; fill in the Supabase URL, anon key and agent email. Prefer storing the agent password in Windows Credential Manager using the `keyring` instructions above, leaving `KAIRFLOW_AGENT_PASSWORD` blank. If you put the password in the file instead, keep the file private.
3. The controller starts automatically at Windows sign-in and launches Emma automatically (`--auto-start`). Complete `worker.env` first; if it is incomplete, the controller keeps the automatic-start request and retries periodically. Open KairFlow → Intelligence → Settings and pair this browser once by pasting `%LOCALAPPDATA%\KairFlowIntelligence\controller.token`. KairFlow remembers the token in this browser profile on this computer, so you do not need to enter it again. The token is not uploaded to Supabase or your account. Use **Stop Emma** only when you intentionally want to pause the worker; the controller will not restart it after a manual stop. Chrome may ask permission for KairFlow to access your local network; allow it.
   To update an already-installed controller after updating the worker files, first use **Stop Emma** in Settings, then rerun the installer. It safely stops and replaces the old scheduled controller task.
4. Starting Emma resumes queued worker activity. If sending is enabled and the emergency stop is OFF, approved messages may be sent under the existing rules.

Choose exactly one worker installation mode: controller-managed (`install-controller.ps1`, recommended) OR the legacy SYSTEM scheduled worker (`install-task.ps1`). The installers refuse to coexist, and the worker also acquires a machine-wide singleton lock so manual starts cannot create a second instance. The scheduled-task wrapper runs the worker once; Task Scheduler is its only restart supervisor. NSSM/manual service mode is also mutually exclusive with these modes. The worker process rotates `worker.log` continuously at 5 MB with three retained backups.

To remove only the controller auto-start, run `.\windows\uninstall-controller.ps1`. This leaves the worker settings and logs in place.

## 3. Run manually (troubleshooting)
- Try it in a console: `python -m kairflow_intel run` (Ctrl+C stops it cleanly). `python -m kairflow_intel once` drains the queue once.
- Keep it running across reboots (recommended, no extra software): in an Administrator PowerShell run
  `.\windows\install-task.ps1 -ManageOllama`, fill in `C:\ProgramData\KairFlowIntelligence\worker.env`, then
  `Start-ScheduledTask -TaskName 'KairFlow Intelligence Worker'`. This mutually exclusive legacy mode starts at boot with no login, restarts on failure, keeps the password
  in a file only SYSTEM and Administrators can read, and `-ManageOllama` starts Ollama on 127.0.0.1 only and blocks inbound port 11434.
  (Windows Credential Manager is per-user, so it is not used by the boot task. These scripts were not run on a Windows machine while writing them: read them first.)
- Alternative with NSSM (free; do not use alongside either scheduled-task mode or the controller):
  `nssm install KairFlowIntelligence "C:\path\.venv\Scripts\python.exe" "-m kairflow_intel run"`
  `nssm set KairFlowIntelligence AppDirectory C:\path\intelligence-worker`
  `nssm set KairFlowIntelligence AppExit Default Restart`
  `nssm set KairFlowIntelligence AppEnvironmentExtra KAIRFLOW_WORKER_LOG_FILE=C:\ProgramData\KairFlowIntelligence\worker.log`
  Also turn off sleep and hibernate while plugged in. A crash, reboot or lost connection is safe: the job queue lives in Supabase,
  unfinished jobs return to the queue when their lease expires, and a message that might have been sent is **never** sent again. Gmail/Zoho use their Sent folders; SMTP outcomes that cannot be independently verified remain unknown for manual resolution. If delivery cannot be verified, it stays "Delivery unverified" until you decide.

## 4. Phase 0 feasibility spike (once, optional but recommended)
`python spikes/phase0_feasibility.py` makes about 60 small, polite, read-only requests to Wikidata, AniList, GDELT and Common Crawl, checks robots.txt on sample studios, and writes `phase0_report.json`. It needs no keys and does not touch Supabase.

## 5. Tests (no network, no Ollama, no Zoho or Gmail needed)
`python -m unittest discover -s tests -t .`

## What is NOT verified here
The Zoho Mail endpoints in `kairflow_intel/zoho.py` and Gmail endpoints in `kairflow_intel/gmail.py` follow their public API contracts but still require read-only acceptance tests against real connected accounts. SMTP is send-only; it does not synchronize inbound replies. The separate Resend transactional integration is not an Emma prospect-mail provider.
Run `selftest zoho` after connecting and adjust response parsing in that one file if anything differs.

## Phase 12 operations

- The Overview > Worker operations panel combines the last database heartbeat, active job, Ollama signal, queue counts, expired leases and dead/failed jobs.
- Jobs in `dead` or `failed` state can be manually requeued from Agent Activity Logs. Requeueing does not bypass message approval, recipient consent, kill-switch, provider assignment, quota or final send-boundary checks.
- Initial and follow-up messages outside the configured send window are deferred to the next local opening time; the database final-send gate remains authoritative. Replies are not subject to the initial/follow-up send window.
- Expired job leases are recovered by the next claim transaction, with a bounded lease-expiry diagnostic. A worker that loses/uncertainly renews a lease will not mark the job complete or failed as the former owner.
- RFC threading association checks exact Message-ID tokens, preferring `In-Reply-To` over `References`, and requires the inbound sender to match the outbound recipient before associating the reply.
