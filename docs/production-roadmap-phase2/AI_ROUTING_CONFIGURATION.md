# AI Routing Configuration

Template: `intelligence-worker/.env.example` (the template itself is parsed and validated by a test).

| Setting | Template value | Meaning |
|---|---|---|
| `KAIRFLOW_GEMINI_API_KEY` | blank | blank = Ollama only; never commit |
| `KAIRFLOW_GEMINI_MODEL` / `_JSON_MODEL` | `gemini-3.8-flash` | exact IDs, no aliases (model name carried over from the repo; availability on your key is **unverified**) |
| `KAIRFLOW_GEMINI_FAST_MODEL` | blank | optional model for fast structured calls |
| `KAIRFLOW_GEMINI_THINKING` | `low` | low/medium/high only |
| `KAIRFLOW_GEMINI_RPM` / `_RPD` | 10 / 200 | local request caps; every HTTP attempt counts |
| `KAIRFLOW_GEMINI_DRAFT_RESERVE` | 0.25 | share of RPD only drafting may use (when drafting can reach Gemini) |
| `KAIRFLOW_GEMINI_DAILY_COOLDOWN_SECONDS` | 10800 | skip Gemini after daily quota exhaustion |
| `KAIRFLOW_AI_D1` | `C` | private groups *may* use Gemini |
| `KAIRFLOW_AI_POLICY` | blank | opt-in per group/site, e.g. `chat=gemini_first,drafting=gemini_first,classification=gemini_first` |
| `KAIRFLOW_AI_FORCE_OLLAMA` | 0 | 1 = emergency rollback |

**Effective routing with the template as shipped:** discovery and research: Gemini then Ollama. Drafting, classification, chat: D1 permits Gemini, but only `chat.plan` defaults to Gemini-first; drafting and classification stay on Ollama until you add them to `KAIRFLOW_AI_POLICY`. Health checks: one pinned to each provider.

**Spend:** none possible in code (no billing path; tested). Local caps are conservative estimates, not your account's verified quotas: compare with AI Studio and lower them if needed. Budget is in-memory per worker process; it resets on restart (known limitation, P1-05 partially closed).

**Not done:** per-task model assignment (needs benchmark); persistent budget counters; a spend/usage dashboard.
