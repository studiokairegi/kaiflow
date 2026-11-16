# Phase 5 Handoff: Intelligent Prospect Discovery and Evidence-Based Research

**Status: PARTIAL.** Code, tests and documents are complete for what could be done offline. The completion gate, a test campaign that discovers genuine prospects with traceable evidence, is **not met**: no live source was fetched.

## Starting point
Repository snapshot `KairFlow_Phase4_plus_Emma_Merged_Full_Repo_controller_audit_fixed_6.zip`. It has no `.git`, so branch, commit and dirty state are unknown. Phase 1 to 4 handoffs were read. The Phase 4 live checks and the Phase 2 and 3 live gates are still open.

## Findings
The discovery and research code was already mature and heavily audited. Strong: source registry gates, per-request budgets, protected accounts, suppression, Kickstarter manual-only intake, literal quote checks on model output, contact and identity rules. Gaps against the roadmap:

| Roadmap task | Finding | Action |
|---|---|---|
| 11 Research report per prospect | **Did not exist** anywhere in code or UI | Built `research_report.py` |
| 7, 8 Confirmed versus inferred, store evidence | Evidence stored, but nothing separated fact from inference | Report classes confirmed, unverified, inference, gap |
| 12 Measurable discovery | Job result had only totals | `by_source` and `duplicate_rate` added |
| 9 Cross-source duplicates | Indie key is developer plus title with case and whitespace folding only; one prospect per game | **Not changed.** Needs SQL and a database. Proposed in PROSPECT_RESEARCH_STANDARD.md |
| 1 Source coverage | Directories and communities not implemented | Not built; needs named sources and terms checks |
| Kickstarter | Roadmap lists it; repo excludes automation for terms reasons | **Preserved as manual-only.** Not crawled |

## Files
- **Created:** `intelligence-worker/kairflow_intel/research_report.py`; `intelligence-worker/tests/test_phase5_research_report.py`; `docs/production-roadmap-phase5/` with this handoff, the four deliverables and the updated master roadmap.
- **Changed:** `kairflow_intel/research.py` (collects this run's evidence, builds the report, failure-safe); `kairflow_intel/jobs.py` (`h_discover` result gains `by_source`, `duplicate_rate`).
- **Removed:** none.

## Migrations and deployment
No migration. The report lives in the existing `facts.verified` JSON and is rebuilt each research run. Restart the worker to pick it up. Existing prospects get a report only after their next research run.

## Tests actually run
Python worker 1059 passed. Node 1191 passed. Not run: SQL tests, frontend build, browser, any live source, live Gemini, live Ollama.

## Known bugs, risks, unresolved
- Steam and itch.io HTML selectors are untested against live pages.
- The report is stored but **not yet shown in the app** and **not yet read by the drafting step**. Next small step: render `research_report.summary` and `gaps` in the prospect panel.
- Indie duplicate weakness, above. I did not audit whether `intel_agent_resolve_lead` merges several games by one developer into one CRM lead.
- Carried from Phase 4: dead scheduled jobs block their idempotency bucket until requeued, which affects scheduled discovery.
- Carried: hosted migration ledger unknown; do not run a blanket `supabase db push`.
- Carried from today's side work, outside Phase 5: controller v1.2.5 and the Gemini client review are in the same snapshot; Windows behaviour of the controller is unverified.

## Configuration and secrets
None new. Owner action: confirm Steam and itch.io terms and enable each in the source registry. No secret values were touched or written.

## Next: Phase 6
Read the roadmap and all handoffs. First do the owner steps in SOURCE_INTEGRATION_REPORT.md and run the 20-prospect check, because Phase 6 builds on prospect quality. Then: advisory AI explanation of ambiguous qualification, personalised drafts that read `research_report`, follow-ups, reply handling.

## Outbound sending
Untouched and disabled. No send path was changed. The deployed kill-switch state was not verified.
