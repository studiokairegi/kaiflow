# Gemini confirmed-bug fix handoff

## Scope

Applied the confirmed Gemini API configuration correction from the end-to-end audit. Per user instruction, Agent Chat privacy findings were explicitly excluded and remain unchanged.

## Fixed finding

### G-03 — P2: unsupported sampling override on Gemini 3.x

Google's current Gemini 3.8 Flash documentation states that `temperature`, `topP`, and `topK` overrides are ignored. The client previously sent `temperature: 0` for Gemini 3.x requests and tests asserted its presence, implying a deterministic behavior that the model does not honor.

Changes:
- Removed `temperature` from Gemini 3.x Agent Chat generation configuration.
- Removed `temperature` from Gemini 3.x structured generation configuration.
- Retained `temperature: 0` for explicitly configured legacy Gemini models, preserving their previous request behavior.
- Updated tests to assert that Gemini 3.x requests omit `temperature`, while legacy model compatibility remains intact.

## Explicitly excluded

The following Agent Chat privacy findings were not changed, per user instruction:
- G-01: CRM tool result sanitization does not cover all private fields.
- G-02: historical Agent Chat messages are not privacy-sanitized before Gemini requests.

These remain confirmed outstanding issues and must be fixed before enabling Gemini for privacy-restricted Agent Chat contexts.

## Verification

- Focused tests: `python -m unittest tests.test_ai_router tests.test_phase6_routing -q` — 111 passed.
- Full worker suite: `python -m unittest discover -s tests -t . -q` — 747 passed.
- Python compile check: `python -m compileall -q kairflow_intel` — see delivery verification.
- Test harness live preflight diagnostics still report local Ollama structured-output/model availability inconsistencies and a draft RPC signature probe failure in one environment. These are not unit-test failures and were not modified.
- No live Gemini API request was made; no API quota was consumed.

## Operational boundaries

No migrations were applied, no Git push/deploy was performed, no worker was activated, and no email was sent. This package contains source changes only. Agent Chat privacy findings remain open.
