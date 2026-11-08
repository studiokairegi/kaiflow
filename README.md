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
5. Check everything without sending anything: `python -m kairflow_intel selftest`
   (`selftest zoho` is read-only: it lists Zoho folders, nothing else. `selftest resend` checks local provider selection only; it does not send email.)

## Resend provider (server-side only)

- Keep `KAIRFLOW_MAIL_PROVIDER=none` until the local migration has been reviewed/applied and both Intelligence Edge Functions have been deployed.
- Configure `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` as Supabase Edge Function secrets; never add them to the worker environment.
- Configure a Resend webhook subscription for `email.received` to `/functions/v1/intel-resend-webhook`. Keep the existing `/functions/v1/resend-webhook` subscription for the normal Inbox.
- The worker calls `/functions/v1/intel-resend-send` using its limited agent JWT. That function loads the reserved/sending message from the agent RPC and refuses sends while the database kill switch is ON.
- Resend has no Sent mailbox. A saved Resend email id can be checked through the server-side verification proxy. If the id was not saved or cannot be verified, the message remains `unknown` for manual resolution; it is never automatically resent.
- `python -m kairflow_intel selftest resend` is read-only and does not contact Resend or send a message.

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

## Reevaluating rejected animation studios with studio-v2 (one-off)
Re-reads the sites of previously **rejected, discovered `animation_studio_support`** prospects and rescores them with studio-v2, using only evidence collected after the run began.
It never creates or links CRM leads, never drafts or sends, never changes `kill_switch`, autonomy, caps or sending permissions, and cannot reach `indie_game_developer` prospects (the database re-checks type and origin on every call).
A studio-v2 result of "qualified" is stored as **needs_review** (the true decision is kept in the run item), so a person approves it in the existing review queue. Prospects whose site cannot be read, whose website cannot be recovered with confidence, or whose research is incomplete keep their old status and score and are listed for manual review.

1. Review, then apply `supabase/migrations/20261117090000_intelligence_studio_reevaluation.sql` (not applied automatically). Restart the worker afterwards.
2. `python -m kairflow_intel reeval-studio preview` - counts only; creates nothing.
3. `python -m kairflow_intel reeval-studio start --limit 5` - a pilot of 5. Let the worker process them, then `reeval-studio status` and inspect `intel_reeval_items`.
4. `python -m kairflow_intel reeval-studio start --all --expect <eligible count from preview>` - queues the rest. Running `start` again with the same name is safe: it tops up missing items and re-queues dead jobs without duplicating anything.
5. `reeval-studio status [RUN_ID]` shows counts by state/outcome and any queued item without a live job; `reeval-studio cancel RUN_ID` cancels queued work.

Jobs live in the database queue, so a worker restart loses nothing. Missing websites are recovered only from URLs discovery already stored for that studio or an exact-name Wikidata match, and only if the page itself identifies the studio and a second independent cue agrees; two different matching sites mean manual review.

## 2. Run from the KairFlow app (Windows, recommended)

The browser cannot launch a Python process on your computer by itself. Install the small local controller once; it runs on `127.0.0.1` only and accepts control requests only from `https://app.studiokairegi.com` (plus the local Vite development origin). It requires a per-install bearer token in addition to exact Origin/Host checks, and never returns or logs worker credentials or the controller token.

1. Complete the Python environment setup above.
2. In a normal PowerShell window, run `.\windows\install-controller.ps1` from this folder. It creates `%LOCALAPPDATA%\KairFlowIntelligence\worker.env` and a random per-install `controller.token`; fill in the Supabase URL, anon key and agent email. Prefer storing the agent password in Windows Credential Manager using the `keyring` instructions above, leaving `KAIRFLOW_AGENT_PASSWORD` blank. If you put the password in the file instead, keep the file private.
3. The controller starts automatically at Windows sign-in. Open KairFlow → Intelligence → Settings, paste the contents of `%LOCALAPPDATA%\KairFlowIntelligence\controller.token` into the Local controller access token field, then use **Start Emma** / **Stop Emma**. The token stays in memory while this Settings view is open and is never persisted by the app; never share it. Chrome may ask permission for KairFlow to access your local network; allow it.
   To update an already-installed controller after updating the worker files, first use **Stop Emma** in Settings, then rerun the installer. It safely stops and replaces the old scheduled controller task.
4. Starting Emma resumes queued worker activity. If sending is enabled and the emergency stop is OFF, approved messages may be sent under the existing rules.

Do not run the older `KairFlow Intelligence Worker` scheduled task at the same time as the controller-managed worker; that would create two workers. If you previously installed that task, disable it before using the in-app controls. The older `run-worker.ps1` console method remains available for troubleshooting, but do not use it while the in-app worker is running.

To remove only the controller auto-start, run `.\windows\uninstall-controller.ps1`. This leaves the worker settings and logs in place.

## 3. Run manually (troubleshooting)
- Try it in a console: `python -m kairflow_intel run` (Ctrl+C stops it cleanly). `python -m kairflow_intel once` drains the queue once.
- Keep it running across reboots (recommended, no extra software): in an Administrator PowerShell run
  `.\windows\install-task.ps1 -ManageOllama`, fill in `C:\ProgramData\KairFlowIntelligence\worker.env`, then
  `Start-ScheduledTask -TaskName 'KairFlow Intelligence Worker'`. The task starts at boot with no login, restarts on failure, keeps the password
  in a file only SYSTEM and Administrators can read, and `-ManageOllama` starts Ollama on 127.0.0.1 only and blocks inbound port 11434.
  (Windows Credential Manager is per-user, so it is not used by the boot task. These scripts were not run on a Windows machine while writing them: read them first.)
- Alternative with NSSM (free):
  `nssm install KairFlowIntelligence "C:\path\.venv\Scripts\python.exe" "-m kairflow_intel run"`
  `nssm set KairFlowIntelligence AppDirectory C:\path\intelligence-worker`
  `nssm set KairFlowIntelligence AppExit Default Restart`
  Also turn off sleep and hibernate while plugged in. A crash, reboot or lost connection is safe: the job queue lives in Supabase,
  unfinished jobs return to the queue when their lease expires, and a message that might have been sent is **never** sent again. Mailbox providers use their Sent folder; Resend uses a saved provider id through the server-side verification proxy. If delivery cannot be verified, it stays "Delivery unverified" until you decide.

## 4. Phase 0 feasibility spike (once, optional but recommended)
`python spikes/phase0_feasibility.py` makes about 60 small, polite, read-only requests to Wikidata, AniList, GDELT and Common Crawl, checks robots.txt on sample studios, and writes `phase0_report.json`. It needs no keys and does not touch Supabase.

## 5. Tests (no network, no Ollama, no Zoho or Gmail needed)
`python -m unittest discover -s tests -t .`

## What is NOT verified here
The Zoho Mail endpoints in `kairflow_intel/zoho.py` follow Zoho's public documentation but have not been run against a real account. The Resend Intelligence transport uses `intel-resend-send` and `intel-resend-webhook`; its live API behavior must be verified against the actual Resend account before enabling it.
Run `selftest zoho` after connecting and adjust response parsing in that one file if anything differs.
