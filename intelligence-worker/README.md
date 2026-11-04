# KairFlow Intelligence worker (Windows)

A background process on your own computer. It signs in to Supabase as its own limited **agent account**, reads public pages,
asks your **local Ollama** model to read and draft, and talks to Zoho Mail through your server-side connection. It never holds
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
   (`selftest zoho` is read-only: it lists Zoho folders, nothing else).

## Agent Chat and existing leads
The worker also answers Agent Chat messages and prepares follow-up drafts for existing CRM leads you bring in. Neither can send email: sending is only ever
done from an approved message in the Outreach tab, subject to the daily limits, warm-up, suppression list and emergency stop.

## 2. Run
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
  unfinished jobs return to the queue when their lease expires, and a message that might have been sent is **never** sent again
  (the worker checks Zoho's Sent folder first; if it cannot tell, it stays "Delivery unverified" until you decide).

## 3. Phase 0 feasibility spike (once, optional but recommended)
`python spikes/phase0_feasibility.py` makes about 60 small, polite, read-only requests to Wikidata, AniList, GDELT and Common Crawl, checks robots.txt on sample studios, and writes `phase0_report.json`. It needs no keys and does not touch Supabase.

## 4. Tests (no network, no Ollama, no Zoho or Gmail needed)
`python -m unittest discover -s tests -t .`

## What is NOT verified here
The Zoho Mail endpoints in `kairflow_intel/zoho.py` follow Zoho's public documentation but have not been run against a real account.
Run `selftest zoho` after connecting and adjust response parsing in that one file if anything differs.
