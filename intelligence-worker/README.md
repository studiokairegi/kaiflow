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

## 2. Run
- Try it in a console: `python -m kairflow_intel run` (Ctrl+C stops it cleanly). `python -m kairflow_intel once` drains the queue once.
- Keep it running across restarts with NSSM (free):
  `nssm install KairFlowIntelligence "C:\path\.venv\Scripts\python.exe" "-m kairflow_intel run"`
  `nssm set KairFlowIntelligence AppDirectory C:\path\intelligence-worker`
  `nssm set KairFlowIntelligence AppExit Default Restart`
  Also turn off sleep and hibernate while plugged in. A crash, reboot or lost connection is safe: the job queue lives in Supabase,
  unfinished jobs return to the queue when their lease expires, and a message that might have been sent is **never** sent again
  (the worker checks Zoho's Sent folder first; if it cannot tell, it stays "Delivery unverified" until you decide).

## 3. Tests (no network, no Ollama, no Zoho needed)
`python -m unittest discover -s tests -t .`

## What is NOT verified here
The Zoho Mail endpoints in `kairflow_intel/zoho.py` follow Zoho's public documentation but have not been run against a real account.
Run `selftest zoho` after connecting and adjust response parsing in that one file if anything differs.
