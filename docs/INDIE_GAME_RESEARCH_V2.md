# Indie Game Developers V2 — Research and Verified Contact Workflow

## Session 5 scope

Session 5 adds evidence-backed developer/studio verification, project activity and opportunity evidence, human visual review, and administrator-confirmed contact details. It does not implement outreach, reply-state handling, follow-up scheduling, or the Session 7 frontend/E2E release work.

## Research sources and boundaries

- Research continues to use the prospect's separately supplied official developer website, with same-host internal pages selected by the existing bounded page-ranker.
- Kickstarter remains manual provenance only. The Kickstarter URL is never fetched. For Kickstarter imports, research can run only against the separate official developer website supplied during intake.
- No Steam, itch.io, Kickstarter, social-profile, search-engine, or contact-data source was enabled by this session. Existing Steam/itch sources remain disabled/unverified pending administrator terms review.
- AI extraction is still limited to the named contact and role. AI output does not establish developer identity, project identity, activity dates, visual style, or email ownership.

## Deterministic evidence collection

`intelligence-worker/kairflow_intel/indie_evidence.py` adds bounded deterministic extraction:

1. **Identity evidence candidates:** exact literal mentions of the recorded developer/studio name and game title on the official developer site are stored as source-backed evidence. A mention is not itself a verified identity decision.
2. **Dated activity:** a `<time datetime>` value is accepted only when its nearby article content explicitly describes a devlog, development/progress update, build, playtest, patch, or similar development event. JSON-LD is accepted only for Article/BlogPosting/NewsArticle objects with an explicit `datePublished` and matching activity language. Generic CMS `dateModified`, crawl time, newest-list position, and release date do not count as activity.
3. **Announcement and marketing timing:** explicit dated announcements are recorded separately from development activity. Explicit upcoming demo, launch, campaign, DLC, expansion, relaunch, or console opportunity dates are recorded as marketing milestones. Dates are not guessed from relative phrases.
4. **Visual assets:** public image/video references found on the official developer site are stored as `visual_asset_candidate` with `verified=false`. The worker does not classify anime aesthetics from filenames, alt text, genre labels, or AI output. An administrator must inspect the actual asset and add a reviewed visual evidence row before the scorer can use it.

## Administrator evidence actions

Migration `20261112180000_intelligence_indie_research_verification_v5.sql` adds three authenticated, Master User-only RPCs:

- `intel_admin_add_indie_evidence(...)`: records a reviewed evidence snippet against the official developer website or a separately identified non-Kickstarter project source. Visual evidence requires a media URL. Activity/announcement/marketing evidence requires an explicit date. Only the allowlisted fact types can be added.
- `intel_admin_verify_indie_identity(...)`: verifies the responsible developer/studio only after two separate administrator-reviewed evidence rows exist: one identifying the developer/studio and one identifying the exact game title, both on the official developer website. The RPC records reviewer/time/evidence IDs and updates the prospect name to the verified developer/studio. It separately records a Kickstarter creator role only when explicitly supplied.
- `intel_admin_verify_indie_contact(...)`: confirms the exact email only when it appears in an administrator-reviewed evidence row on the official developer website. It rejects protected entities and all prospect/email/domain suppression, bounce, complaint, unsubscribe, and DNC conflicts.

The RPCs are organization-scoped through `intel_admin_org()`, revoked from `public`/`anon`, and granted only to `authenticated`. They do not qualify a prospect, create a CRM lead, draft an email, or send anything.

## Contact policy

- Extract only addresses actually published on the developer's own pages. Never synthesize or pattern-guess an address.
- A contact form without a usable email remains not contactable.
- Official-domain addresses require exact source evidence and human confirmation or provider delivery evidence.
- Gmail, Outlook, Proton, iCloud, Yahoo, and other listed personal mailboxes remain Indie-only. They can pass only when the exact address is published on the official developer site and human-confirmed, or when a separate source documents the exact address and the named developer's affiliation, plus deliverability evidence. A bare affiliation boolean is insufficient.
- Bounce, complaint, unsubscribe, DNC, and domain/email suppression remain hard blocks. Suppression lookup failures continue to fail closed during qualification.

## Qualification behavior

- The existing 100-point `indie-project-v2` scorer and seven mandatory gates remain authoritative.
- Kickstarter creator attribution stays `admin_attributed_unverified` until the identity RPC succeeds. A creator, publisher, or campaign organizer is not assumed to be the developer.
- Visual candidates remain unverified and do not satisfy the anime-visual gate. Only a human-reviewed `anime_visual_*` evidence type or an explicit anime/manga visual-style description from an official source can satisfy it.
- Dated development evidence uses `development_update`/related fact types already recognized by the scorer. Upcoming marketing evidence is attached to a dated milestone. Discovery recency and generic page freshness never qualify as activity.
- Existing suppression, protected-account, contactability, qualification, CRM approval, and outbound send gates are unchanged.

## Deployment and safety

The migration is **not applied**. Reconcile the deployed Supabase migration ledger first because this repository contains later-dated migrations through December 2026. Apply only in a reviewed staging database and verify RPC grants, RLS, date synchronization triggers, and the contact/suppression gates before deployment.

No live platform requests, database writes, CRM operations, outbound email, or production deployment were performed for this session.
