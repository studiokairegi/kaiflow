Owner: Phase 6. Read-only. Emma receives data via a dedicated authorized read RPC and can never post, pay or edit. Any proposed financial action returns a confirmation card handled by the normal secure workflow.

## Phase 6 (delivered)

- Database: `public.fin3_emma_snapshot(p_org)` (user-callable, `finance.read`) and `public.intel_agent_finance_read(thread, message, tool, args)` (migration `20270117091000`). The agent function re-checks the thread, the message, `intel_is_authorized_user` and `finance.read`, writes only the same tool-trace row as the existing chat read, and has one tool, `finance_insights`.
- Worker: `intelligence-worker/kairflow_intel/chat.py` routes finance questions to that tool. It has no write path to Finance.
- Emma never issues invoices, sends emails, pays, or edits records; a suggested action must go through the normal confirmation screens.
- Tests: `intelligence-worker/tests/test_finance_insights.py`, SQL in `phase6.test.sql`.
