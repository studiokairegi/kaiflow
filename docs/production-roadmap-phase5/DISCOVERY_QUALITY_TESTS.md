# Discovery Quality Tests — Phase 5

## Automated, mocked

`intelligence-worker/tests/test_phase5_research_report.py`, 20 tests, all pass.

- Inference labelled, lists basis; `evidenced` only when the team says so.
- Unverified candidates never counted as confirmed.
- Gaps reported, nothing filled; no email or name appears that is not already on record.
- Identity confirmation rules; stale activity called out.
- Studio report; report bounded and JSON-safe.
- Research writes the report from this run's evidence; identical across model answers; a report failure cannot lose the research.
- Discovery result reports new, already known and suppressed per source, and a duplicate rate.

Existing suites that already cover this area and still pass: source adapters, protected accounts, Kickstarter manual intake and refusal to fetch, indie evidence and research integrity, entity resolution, provider-independent outcomes.

## Results, 13 Nov 2026

| Suite | Result |
|---|---|
| Python worker | 1059 passed, 425 subtests |
| Node, `npm test` | 1191 passed, 0 failed |
| SQL, build, browser | **not run** |
| Live sources, live Gemini, live Ollama | **not run** |

## Completion gate: NOT met

The gate asks for a test campaign that discovers genuine prospects with traceable evidence. That needs real Steam and itch.io pages and the owner's terms confirmation. The manual procedure is in SOURCE_INTEGRATION_REPORT.md. Pass criteria suggested for the first 20 prospects: at least 90 percent have the correct developer, none has an invented contact, every confirmed fact opens to a page that says it, duplicate rate under 15 percent.

## Recheck, 13 Nov 2026
A second review of the new code found and fixed four bugs, each now covered by a regression test: a legacy or unverified contact email was shown as sourced; internal bookkeeping evidence rows were listed as confirmed facts; recent events were not sorted by date; the publisher field was always empty because research does not keep it. Note: in a normal run the report also includes earlier evidence rows for the prospect, matching what qualification reads; it is not limited to the current run.

## Deeper check, 13 Nov 2026
Three more fixes, each with a test: a studio hiring sentence such as "looking for freelance animators" could make outsourcing capacity read as `evidenced`; the report now ignores recruitment wording the way the scorer does. Future-dated activity no longer gives a negative age. Malformed stored values, such as an object where text is expected, crashed the builder; a 400-case fuzz test now confirms it never raises and always serialises. Verified against the SQL: the indie key is developer name plus title first, so Steam and itch discoveries of the same pair do dedupe; the platform-id keys apply only when a title is missing.
Reminder for the UI step: snippets are text copied from third-party pages, so any screen that shows the report must render them as plain text, never HTML.
