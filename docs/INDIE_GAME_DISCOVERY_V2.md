# Indie Game Developers — Discovery V2 (Phase 3)

## Scope

This phase improves candidate discovery from Steam and itch.io. Discovery gathers projects and source evidence; it does **not** qualify a prospect. The Phase 2 `indie-project-v2` scorer, seven mandatory gates, suppression checks, protected-account rules, contact verification, and human approval remain authoritative.

## Source policy and access

### Steam

- The adapter uses public Steam Store search HTML and public Steam app pages (`store.steampowered.com`).
- It does not use Steam partner endpoints, authenticated pages, private APIs, account cookies, CAPTCHAs, proxy rotation, or access-control workarounds.
- Search pagination uses the Store search page's `start` and `count` parameters and the public result-count marker where present. Page markup can change; a parse failure produces no candidate rather than guessing.
- App details are extracted from the public page DOM and public structured metadata. Developer and publisher names are stored separately. A third-party publisher does not exclude the developer.
- The documented Steamworks Web API is a separate interface. Its public/partner method distinctions are described in Valve's documentation; this adapter does not claim that Store search HTML is an official documented Web API.
- The Phase 3 migration explicitly disables Steam and resets its terms status to unverified (while preserving an explicit excluded state). An administrator must review current Valve terms, robots rules, and allowed automated access before re-enabling it.

### itch.io

- The adapter reads public newest/tag browse pages only and follows ordinary page pagination.
- It records each project separately. Several games by the same creator are not collapsed into one candidate.
- The creator label/profile is stored as platform attribution, not proof that the creator is the actual developer or authorized business contact. That attribution must be researched in Session 5.
- The adapter does not crawl private/restricted/unlisted pages, sign in, bypass rate limits, or harvest contact details from creator profiles.
- itch.io's published Terms of Service include restrictions concerning collecting information about others. The Phase 3 migration explicitly disables itch.io and resets its terms status to unverified (while preserving an explicit excluded state). The source remains off until the administrator reviews the current terms and confirms the narrow project-metadata use is permitted. Contact discovery is not performed by this adapter.

### Other sources

No additional automated platform was enabled in Phase 3. Search-engine-indexed results, development communities, and other public sources need a source-specific terms/robots/access review and a documented rate limit before implementation. Session 4 added Kickstarter as manual-only intake; it is not an automated discovery source.

## Search strategy

The seeded Indie keyword list is broadened to include anime games, anime-inspired games, 2D RPGs, JRPGs, pixel-art RPGs, action RPGs, indie adventures, story-driven games, visual novels, upcoming PC games, demos, early access, devlogs, hand-drawn games, and 2D indie games. The migration updates only the untouched original seed list; administrator-customized campaign keywords are preserved. It also forces both Steam and itch source rows to disabled/unverified (except an explicit excluded status) so the changed access methods receive a fresh terms review.

The Python starter terms include corresponding English and Japanese variants. Proposed profile terms still require administrator approval before they are used.

## Candidate fields and evidence

Each Steam/itch candidate retains:

- `source` / `source_key`;
- `source_url` and `project_url`;
- `project_id` (`steam:<appid>` or `itch:<host>/<slug>`);
- `project_title` and developer/creator attribution;
- publisher identity where Steam exposes it;
- available release date, `coming_soon`, genres/tags, description, and public artwork/trailer indicators;
- `discovered_at` timestamp.

The discovery adapter does not set `recent_activity`, `latest_activity_date`, or a development-activity signal. A discovery timestamp is not a project activity date. itch creator attribution is explicitly marked unverified.

The worker writes a `game_project` source item for each project URL, including source metadata. Repeated observations refresh `last_seen` and merge metadata. The source item retains provenance independently of the prospect record.

## Project identity and deduplication

- The Phase 3 upsert uses a project-scoped canonical key derived from normalized developer name + project title. This prevents multiple games from one developer being collapsed by a shared developer domain.
- The same developer/title pair found on Steam and itch.io maps to one project prospect; each source URL remains a separate `intel_source_items` record.
- Steam App IDs and itch project IDs provide fallback project identifiers when a title is missing.
- Title/developer spelling differences can still prevent automatic cross-source deduplication. Research/manual review must reconcile uncertain matches rather than aggressively merging unrelated projects.
- Existing Phase 2 prospects retain their existing canonical keys. No automatic destructive merge of historic prospect/CRM rows is attempted in this migration. A legacy prospect may coexist with a newly project-keyed candidate until an explicit safe reconciliation is designed.

## Pagination, incremental runs, and recovery

- Each discovery job processes a bounded slice per authorized source.
- Steam cursors contain `keyword_index` and `start`; itch cursors contain `keyword_index`, `page`, and `offset`.
- Continuation jobs are persisted through the existing `intel_jobs` queue and use deterministic cursor-derived idempotency keys. A cursor continuation has a time-bucketed idempotency key so a budget hold can enqueue the same cursor for the next budget window without colliding with the currently running job.
- The source registry reserves budget immediately before every network request, including individual Steam app pages. The agent-only status endpoint returns remaining budget and circuit retry timing so the cursor can survive the daily budget reset.
- A transient fetch failure bubbles to the existing job retry mechanism; the cursor is not advanced. Permanent source errors are reported to the registry and the source is held rather than retried indefinitely. A new agent-only source-status RPC distinguishes disabled/unconfirmed sources from budget exhaustion and an open circuit. Budget/circuit holds retain the cursor and schedule a later retry without counting a budget hold as a source failure.
- A pending-cursor RPC prevents the daily initial scan from restarting the first keyword while a continuation is queued or running. Existing leases and idempotent queue semantics provide recovery after worker restart. No separate in-memory cursor is required.
- Candidate upserts are project-idempotent. Source-item URL hashes prevent repeated rows for the same URL.

## Known limitations

1. Steam Store HTML is not a versioned discovery API. Result markup, pagination controls, developer/publisher selectors, and structured data may change.
2. The adapter depends on the public Store search page exposing a result count or a full page to decide whether to continue. If markup changes, it may stop early or request one harmless empty page.
3. Steam app pages may omit developer or publisher information; candidates without a defensible developer identity are skipped for research/manual handling.
4. itch browse visibility is controlled by platform indexing and creator visibility settings. Restricted and unlisted projects are not discoverable through these pages.
5. itch creator identity is not necessarily the actual developer. No claim of developer status is made until research.
6. Cross-source deduplication is conservative and depends on matching developer/title text. It does not fuzzy-merge ambiguous titles.
7. No contact email is verified by discovery. Contact forms are not converted to email addresses.
8. Steam and itch remain disabled until terms are reviewed and confirmed by an administrator. The implementation does not turn them on automatically.

## Deployment

1. Review the Supabase migration ledger before applying `20261112160000_intelligence_indie_project_discovery_v3.sql`. The repository contains later-dated migrations; do not blindly apply migrations out of order.
2. Apply and test the migration in staging. It replaces the prospect upsert function with project-aware keys and adds `game_project` to source-item types.
3. Confirm the worker's service role can call `intel_agent_record_item` and the existing upsert RPC under the current RLS/grant model.
4. Review Steam and itch terms/robots/access policies and only then confirm/enable the source rows in the admin UI.
5. Start with low daily budgets and monitor parse success, circuit-breaker reports, cursor continuation, and duplicate rates.
6. Do not deploy with sending enabled as part of this phase; this phase only discovers and queues research.

## External policy references reviewed

- Valve, [Steamworks Web API Overview](https://partner.steamgames.com/doc/webapi_overview) and [IStoreService Interface](https://partner.steamgames.com/doc/webapi/IStoreService). These describe Valve's documented Web API surface and the separate partner service. The Phase 3 adapter does not call the partner service; it reads public Store HTML and must be separately reviewed for terms/robots permission.
- itch.io, [Terms of Service](https://itch.io/docs/legal/terms). The acceptable-use section includes restrictions concerning soliciting, harvesting, or collecting information about others; do not enable automated discovery without a specific terms review.
- itch.io, [Getting Indexed on Search & Browse](https://itch.io/docs/creators/getting-indexed). This explains public project indexing and the effects of unlisted/restricted visibility, which limits what public browse discovery can find.


## Kickstarter (Session 4)

Kickstarter is a manual-only project intake source in this release. Its published Terms prohibit automated crawling/spidering and require prior written permission for commercial use of site content. The platform registry row is therefore disabled and unverified, and the source-admin RPC blocks automated enablement. Manual intake requires an administrator attestation of prior written permission plus an internal reference. KairFlow stores the submitted URL/metadata and queues a durable worker job without fetching Kickstarter. Creator/developer attribution remains unverified and the Phase 2 project-identity gate stays closed until independently verified. Automated research, if requested, is limited to a separate official developer website supplied by the administrator. See `KICKSTARTER_DISCOVERY_V2.md` for the full terms rationale and workflow.

## Session 5 — Research enrichment and verified contact discovery

See `docs/INDIE_GAME_RESEARCH_V2.md` for the evidence rules, administrator verification RPCs, date handling, visual-review queue, and personal-email eligibility policy. Key constraints: Kickstarter remains manual-only and is never fetched; visual assets are unverified until human review; only explicit dated update/announcement content counts as activity; contact addresses are never synthesized; suppression and protected-account gates remain fail-closed.
