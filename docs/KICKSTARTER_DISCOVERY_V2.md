# Kickstarter discovery — Session 4 (manual-only implementation)

## Decision and terms gate

Kickstarter's current Terms of Use (effective February 11, 2025) prohibit software or devices, manual or automated, from crawling or spidering the site. The Terms also limit reproduction/use of Kickstarter site content to personal non-commercial purposes and require prior written permission for commercial use. KairFlow is a commercial intelligence workflow, so automated Kickstarter discovery, direct page parsing, creator-profile crawling, search-result crawling, and search-engine-indexed page harvesting are not implemented. See the [Kickstarter Privacy Center / Terms of Use](https://legal.kickstarter.com/) and [Kickstarter Discover](https://www.kickstarter.com/discover).

The public Discover interface exposes Games / Video Games and project-status filters (upcoming, live, late pledge, ended). Those UI capabilities are not permission for a third-party commercial crawler. The 2026 search/discovery redesign prioritizes live projects, late pledges, and upcoming projects; this can guide a human operator's manual review, not automated collection. Manual intake is also gated: the administrator must attest that prior written permission covers the commercial use and provide an internal permission reference. This self-attestation is not independently verified by KairFlow. See [Kickstarter Discover](https://www.kickstarter.com/discover) and [Kickstarter's June 29, 2026 search/discovery update](https://start.kickstarter.com/kickstarter-release-notes/smarter-search-discovery).

## What Session 4 implements

- Adds `kickstarter` to the source registry with `enabled=false`, `tos_status='unverified'`, and daily budget `0`. The source-admin RPC also rejects attempts to enable it; no automated adapter uses this key.
- Adds an administrator-only `intel_admin_add_kickstarter_project` RPC.
- Adds a manual intake panel for a canonical Kickstarter project URL, project title, creator name, optional developer/studio name, optional separate official website, short administrator notes, and a required prior-written-permission attestation plus internal reference.
- Stores each project as `game_project` with source key `kickstarter_manual`, canonical project URL, a stable URL hash, and the submitted attribution metadata.
- Enqueues the existing durable `manual_post` queue kind with an idempotency key based on item ID and submitted metadata. The worker recovers the stored item from the database after restarts; no process-local queue state is used.
- The manual worker validates the URL shape and never requests Kickstarter. It creates/updates the Indie project prospect using the existing developer/title project key and stores source provenance.
- The worker performs a fail-closed source-exclusion preflight. The final import is committed through a service-role-only database RPC that locks the Kickstarter source row while checking exclusion, upserting the prospect, and recording provenance. This serializes an in-flight import against an administrator exclusion change.
- Excluding Kickstarter cancels queued and running `manual_post` jobs for Kickstarter manual items and marks their intake metadata as blocked. Jobs that race with exclusion are rejected by the transactional commit boundary.
- Re-importing a project cannot downgrade an existing independently verified/human-confirmed developer identity or a verified Kickstarter creator-role fact. The database snapshots higher-confidence facts before merge and restores them after the unverified manual attribution is applied.
- Creator identity, developer identity, and creator role remain explicitly unverified. Administrator-entered values are leads, not platform-verified facts. The Phase 2 project-identity qualification gate now also fails for Kickstarter manual attribution until `developer_identity_status` is independently verified; a title/creator pair cannot qualify just because it was entered by an administrator.
- Automated research is queued only against the separate developer website entered by the administrator. The Kickstarter URL is never passed to the research fetcher. Without a separate official website, the prospect is held for manual review.
- Protected-entity and existing suppression checks remain in force. No email/contact scraping, outreach, or qualification bypass is added.

## Discovery workflow

1. A human reviews Kickstarter Discover / Games only where their use is authorized and identifies a potentially relevant video-game project.
2. Before entering any project data for this commercial workflow, the administrator confirms prior written permission covers the intended use and records an internal reference. The administrator then enters the canonical project URL and observed project/creator attribution in KairFlow. No page text is copied; notes should be the administrator's own short observations.
3. The server validates the URL and required metadata, upserts the source item, and queues a persistent worker job.
4. The worker revalidates the URL and submitted metadata, records the project and provenance, and leaves attribution unverified.
5. If the administrator supplies a separate official developer website, ordinary site research may run against that domain under the existing `site_crawler` registry, budget, robots, and safety gates. Otherwise the candidate is flagged for manual review.
6. Phase 2 qualification still requires dated opportunity evidence, anime-compatible visual evidence, developer identity and contact verification, suppression checks, and all existing human approval gates. A Kickstarter campaign being live, funded, upcoming, or ended is not by itself qualification evidence.

## Deduplication and provenance

The project upsert uses the Phase 3 developer-name + project-title key. Exact attribution/title matches can merge with Steam/itch discoveries. Creator names that differ from the actual developer name will not be fuzzy-merged; this is intentional until identity is verified. The `kickstarter_manual` source item remains separately stored with its project URL and intake metadata.

## Explicitly not implemented

- Automated Kickstarter search or Discover crawling.
- Automated category, status, date-window, or pagination scans.
- Kickstarter project-page parsing or creator-profile parsing.
- Search-engine result scraping or indexed Kickstarter page harvesting.
- Kickstarter contact-email extraction.
- API calls to undocumented or third-party Kickstarter APIs.
- Authentication, CAPTCHA, bot mitigation, or access-control bypass.

The manual intake itself requires prior written permission for the commercial use of the entered project information. A future automated connector additionally requires documented official API availability or written Kickstarter permission covering automated discovery, storage, and use. Legal/administrator review must record the precise allowed fields, purpose, rate limits, retention, and attribution requirements before any adapter is implemented or the source is enabled.
