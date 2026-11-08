# Phase 13 — Evidence and message retention proposal

## Executive recommendation

Do not introduce any new evidence or message deletion in Phase 13. Preserve evidence as the default because it supports qualification provenance, re-evaluation, contactability decisions, CRM ownership disputes, outbound personalization, and delivery/compliance investigations. Collect read-only database size and age metrics first, then approve a separate retention policy with legal/business input before any cleanup implementation.

## Existing behavior discovered in the codebase

The daily worker enqueues a `retention` job. `h_retention` calls `intel_agent_prune(p_evidence_days = 45)`. The currently installed definition in the Phase 1 RPC migration:

- Deletes `intel_evidence` older than 45 days only when its prospect is `rejected` or `suppressed` (the function clamps the threshold to at least 7 days).
- Deletes `intel_jobs` in `succeeded` or `cancelled` state when `finished_at` is older than 14 days.
- Returns the number of evidence rows deleted; the job handler reports that as `pruned`.

There is no equivalent age-based deletion for `intel_messages` in the reviewed migrations. Messages include outbound/inbound bodies, provider assignment, RFC threading metadata, state and delivery lifecycle fields. `intel_actions` is an append-only audit trail. `intel_delivery_events` carries delivery/bounce/complaint evidence. These records should not be treated as disposable logs.

**Phase 13 did not execute the retention job, call the prune RPC, delete rows, or change the existing retention function.** The existing 45-day evidence deletion is a pre-existing behavior and must be explicitly considered before any deployment that relies on it. This phase intentionally leaves it unchanged pending an approved policy decision.

## Proposed policy for review (not applied)

| Data class | Proposed default | Rationale |
|---|---|---|
| Verified and unverified `intel_evidence` | Retain while prospect/lead relationship exists; no automatic age deletion | Provenance, re-evaluation and defensible personalization |
| Evidence for rejected/suppressed prospects | Retain until explicit policy review; suppression records must outlive outreach eligibility | Avoid loss of provenance and suppression context |
| `intel_messages` bodies and thread headers | Retain while prospect/lead relationship and compliance needs exist; restrict access | Replies, follow-ups, audit and dispute resolution |
| `intel_delivery_events` | Retain with associated message lifecycle record | Bounce, complaint and delivery evidence |
| `intel_actions` | Append-only; separate long-term audit policy | Accountability and incident review |
| Terminal `intel_jobs` | Short operational retention may be appropriate; preserve failure summaries and job IDs in audit | Queue rows are operational, not source evidence |
| Raw crawl/page payloads (if added later) | Avoid storing by default; store minimal attributable snippets and hashes | Reduce personal data and storage footprint |

No period in this table is an approved legal retention schedule. Obtain applicable legal, contractual and customer requirements before setting durations. Suppression and opt-out records must not be removed merely because message bodies expire.

## Database growth and indexing observations

The current schema has a prospect index on `intel_evidence(prospect_id)`, a message index on `(prospect_id, created_at)`, an organization/day/kind message index, an organization/state/run_after job-claim index, and a partial expired-lease index from Phase 12. Delivery events have a message lookup index. These are reasonable starting points, but actual row counts, index sizes, query plans and index usage were not available because no database connection was used.

Before adding indexes, run `supabase/diagnostics/phase13_retention_diagnostics.sql` and capture `EXPLAIN (ANALYZE, BUFFERS)` for the actual evidence-by-prospect, message-thread, delivery-event and job-claim queries in staging. Candidate indexes to evaluate only if plans show a bottleneck:

- `intel_evidence (organization_id, prospect_id, fetched_at DESC)` for org-scoped evidence history.
- `intel_messages (organization_id, prospect_id, created_at DESC)` if thread queries consistently scope by organization and prospect.
- `intel_delivery_events (organization_id, message_id, received_at DESC)` if event history is queried by org/message and chronological order.

Do not create these blindly: compare query plans and index write/storage cost, and check for equivalent existing indexes first. Avoid indexing large message body/snippet text; use existing hashes and bounded snippets.

## Read-only measurement procedure

1. Run the diagnostic SQL as an authorized database operator in staging.
2. Record heap, index and total table sizes, live/dead row estimates, age histograms and index scan counts.
3. Compare snapshots over at least 2–4 weeks to estimate growth rates; do not infer a production growth rate from a single snapshot.
4. Run `EXPLAIN (ANALYZE, BUFFERS)` only on representative staging data and inspect for sequential scans, sort spills and excessive heap fetches.
5. Prepare a separate policy decision and migration only after approval. Any cleanup must be dry-run/report-only first, bounded, tenant-scoped, audited and reversible where possible.

## Safety decision

Phase 13 introduces no retention migration, no cleanup SQL and no delete operation. The diagnostic SQL contains SELECT statements only. Evidence and message rows remain untouched.
