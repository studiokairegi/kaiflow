# Indie Game Developers — Project-First Qualification V2

**Model:** `indie-project-v2`  
**Qualification threshold:** 75/100  
**Review threshold:** 55/100  
**Scope:** Session 2 — prospect qualification and scoring only

## 1. Decision policy

The score is a deterministic suitability ranking. It is not permission to create a CRM lead or contact a developer. Every mandatory gate must pass before a prospect is `qualified`.

- **75–100:** Qualified only when all seven mandatory gates pass.
- **55–74:** Needs Review.
- **0–54:** Low priority / Rejected.
- A protected account, active suppression, bounce/complaint, or invalid contact is rejected regardless of score.
- A missing or uncertain project, activity, visual, or evidence requirement prevents qualification. Scores at or above 55 remain in Needs Review while those facts are unresolved.
- A suppression lookup failure fails closed to Needs Review; it cannot produce a qualified prospect.

The campaign UI cannot lower the 75/55 thresholds. Database checks enforce the same policy if a stale client or worker attempts to override it.

## 2. Scoring categories

| Category | Maximum | Evidence and scoring |
|---|---:|---|
| Anime visual identity | 30 | 30 for verified official anime-compatible visual assets. 24 for an explicit anime/manga visual-style description on an official developer/project page. 12 for weaker text-only wording that remains unverified. 0 otherwise. Generic text mentions alone cannot pass the visual gate. |
| Active development evidence | 25 | 25 for dated development evidence (such as devlogs, progress updates, demos, playtests, builds or patches) within 180 days; 18 for evidence 181–365 days old; 0 otherwise. Upcoming release/store metadata is evaluated under timing and the activity-or-opportunity gate, not as proof of active development. Generic campaign/news announcements and discovery recency alone earn no points. |
| Release and marketing timing | 25 | 25 for an announcement 120–240 days old or an expected release within about six months; 18 for an expected release within twelve months; 5 when the expected release is more than twelve months away; 12 for an unknown release date with recent dated activity or a source-backed marketing opportunity; 15–18 for a released game with a verified new promotional opportunity; 0 when timing is unsupported. |
| Indie partnership opportunity | 10 | 10 for a verified independent team of 1–10; 8 for a verified independent team of 11–25; 4 for a larger verified independent team (deprioritized, not disqualified); 6 when independence is verified but team size is unknown; 0 when independence is unestablished. A discovery source label or team size alone is not proof of independence. No penalty for a publisher, one published game, or no published games. |
| Project identity and research confidence | 10 | 10 for at least three verified evidence types across multiple source URLs; 7 for at least two verified evidence types with source provenance; 4 for a named project with a project source but limited corroboration; 0 otherwise. |

The five category maxima total exactly 100. Every category produces a points/max/reason row and carries the model version.

### Signals that do not earn points by themselves

- Publisher presence or publisher reputation.
- Wishlist count or funding totals.
- Multiple previously published games.
- Established studio reputation.
- Existing animator recruitment or animation budget.
- A generic trailer, cutscene, or animation requirement.
- `recent_activity` set by a discovery adapter.
- JRPG or visual-novel genre labels.

These facts may be retained as research context, but they are not qualification shortcuts.

## 3. Mandatory gates

The worker stores each gate as `{passed, reason}` under `facts.estimates.qualification_v2.mandatory_gates`.

1. **Project identity:** identifiable game title, a project source URL/identifier, and a developer identity. An official project/store page is sufficient to begin research; a separate developer website is not mandatory.
2. **Active development or marketing opportunity:** dated recent development activity, a credible expected release within twelve months, the approximately six-month announcement window when the expected release is not stale, a verified upcoming campaign milestone, or explicit source-backed upcoming marketing evidence. A released game requires a separate new opportunity such as DLC, a major update, relaunch, console release, or a new campaign.
3. **Anime visual identity:** an official screenshot, artwork, or trailer explicitly verified as anime-compatible, or an explicit anime/manga visual-style description on the official developer/project page. Evidence must be linked to the official source URL. JRPG/VN labels and generic stylization do not pass.
4. **Verified usable email:** exact-address syntax, provenance, developer association, and human confirmation or positive provider-delivery evidence. A contact form or merely published address does not pass.
5. **Suppression clear:** no email/domain suppression, unsubscribe, bounce, complaint, or other suppression conflict. Suppression lookup errors fail closed.
6. **Protected account clear:** no match for Brain Jar Games, Silver Line Interactive, Thermite Games, or Lie of Caelum: Spirit. Exact normalized developer/project-name checks exist in the worker and database qualification/status enforcement. An outbound-message trigger blocks protected accounts, persisted suppression flags, and live email/domain suppression conflicts. A prospect already marked suppressed cannot be manually requalified or linked into a new outreach path.
7. **Sufficient evidence:** at least two distinct verified evidence types with source URLs.

Hard account/contact blocks reject the prospect. Other missing mandatory evidence keeps a sufficiently strong prospect in Needs Review rather than letting a high score override uncertainty.

## 4. Anime visual evidence contract

The scorer recognizes these evidence fact types as verified visual proof:

- `anime_visual_evidence`
- `anime_visual_screenshot`
- `anime_visual_artwork`
- `anime_visual_trailer`
- `anime_character_art`
- `official_anime_visuals_verified`

Official style-description evidence types are also accepted when the source host is the developer website or project source:

- `anime_style_description`
- `official_anime_style_description`
- `official_visual_style`

The evidence row must be verified, have a non-empty snippet, and include a source URL. The gate also accepts an explicit `anime_style_description`, `official_anime_style_description`, or `official_visual_style` fact when its URL belongs to the developer's official website or the project's official store/source and the snippet explicitly links anime/manga to style, art, visuals, aesthetic, character design, or illustration. A generic anime mention, JRPG/VN genre label, Japanese-inspired setting, or generic stylization does not pass. These are evidence contracts for later visual research; Session 2 does not claim to inspect images or infer visual style from genre labels.

## 5. Activity and timing semantics

The following project dates are separate typed fields on `intel_prospects` for this transition phase:

- `project_announcement_date`
- `project_campaign_date`
- `project_expected_release_date`
- `project_actual_release_date`
- `project_latest_activity_date`

The schema also stores `project_title`, `project_source_url`, and `project_marketing_milestones`. Milestone dates remain in the milestone collection; they are not collapsed into the distinct project campaign date. The migration derives dates only from explicitly supplied verified facts; it does not use discovery time as announcement or activity time. Common month/year dates are normalized to the first day of that month; year-only dates use a neutral July 1 midpoint. Unknown dates remain NULL. The research worker may use an official project/store page as its research starting point when no separate developer website exists.

Session 3 will introduce the first-class game-project entity and move project-specific fields into that project model. These Session 2 fields are a backward-compatible bridge while the current prospect table remains developer-centric.

## 6. Contact verification

Official-domain email remains supported. Indie campaign qualification additionally permits common personal mailbox providers (including Gmail, Outlook and Proton) only when:

- the exact address is human-confirmed or has positive provider-delivery evidence;
- a developer/studio association is documented on an official source or a cited professional/profile source; and
- the association evidence and source URL are retained.

A boolean affiliation flag without supporting evidence is insufficient. A personal address copied from an unrelated page, an unverified address, or a contact form cannot pass. This personal-email exception is enabled only for `indie_game_developer`; Animation Studio Support keeps its prior domain-association behavior.

## 7. Database and safety enforcement

Migration: `supabase/migrations/20261112140000_intelligence_indie_project_qualification_v2.sql`.

The additive migration:

- adds typed primary-project identity, date, and milestone columns;
- backfills only from explicit verified facts already stored;
- records scoring model, category breakdown, gate outcomes, evidence IDs, and contactability under estimates;
- adds a dedicated indie context RPC that returns stable evidence row IDs and a separate indie suppression lookup, leaving the existing Animation Studio Support context/contactability RPCs unchanged;
- prevents indie status from becoming `qualified` unless score, all mandatory gates, exact-address contactability, protected-account checks, and live suppression checks pass;
- prevents manual approval, lead creation, or linking to an existing lead from bypassing V2 gates;
- moves legacy `qualified` indie prospects to Needs Review until rescored under V2 (protected and suppressed prospects instead remain rejected/suppressed); existing CRM lead rows, sent messages, replies and conversation history are retained;
- orders project-fact synchronization before the database qualification/status guard so one update cannot validate stale typed project fields.

The existing final-send boundary remains authoritative. Protected accounts and persisted/live suppression conflicts are stopped before indie research/crawling, at qualification, during manual review, and at the outbound send boundary. Suppressed prospects are marked `suppressed`; protected prospects are marked `rejected`. The outbound trigger also blocks cold prospecting sends without V2 qualification, an active qualified state, and exact-address contactability. It still permits a properly verified reply to an existing conversation, subject to protected-account and suppression checks. V2 qualification does not replace send-time approval, contact-permission, provider-account, quota, or kill-switch checks.

## 8. Operational limitations and next phase

- Session 2 does not implement Steam, Kickstarter, or itch.io discovery redesign.
- Existing source adapters do not yet provide all date and project fields required for full scoring; unknowns remain unknown.
- Session 2 does not inspect image pixels or fabricate visual verification. The gate can accept explicit official visual-style descriptions; Session 5 must populate the visual-asset evidence contract for screenshot/artwork/trailer verification.
- The repository has no Git metadata. The migration history contains files dated later than the current audit date; production migration history must be reconciled before applying this migration.
- No production database migration was applied in this session.
