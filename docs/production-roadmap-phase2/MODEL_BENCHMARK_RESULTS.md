# Model Benchmark Results

**Status: NOT RUN.** This session had no network access and no Gemini key, so no Gemini request of any kind was made. No latency, quality, quota or availability number exists, and none is claimed. Model IDs in the repo (`gemini-3.8-flash`) are unverified against your account.

## How to run (on the worker machine, free-tier key in `worker.env`)
1. `python -m kairflow_intel.main selftest gemini` for the connectivity/quota check through the real router (needs the key; reports PASS only if Gemini served the call).
2. `python scripts/phase2_gemini_benchmark.py --models gemini-3.8-flash,<candidate flash-lite id> --repeats 2`
   Covers research extraction, prospect evaluation, drafting, chat and instruction following; records outcome class, latency, tokens. At most 30 requests, paced under the RPM cap, synthetic prompts only.
3. Paste the output into this file, judge drafting quality by eye, then set `KAIRFLOW_GEMINI_FAST_MODEL` / per-task choices.
4. Check AI Studio for your real RPM/RPD and adjust `KAIRFLOW_GEMINI_RPM/RPD`.
