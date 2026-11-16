# Press kits: research step and discovery source

Press kits usually name the developer and publisher, link the official site and stores, and give the release date, platforms and a press contact. This closes several Phase 5 gaps (identity not confirmed, no named contact, no sourced email) without any model call.

Tests: Python worker suite 1102 passed (1064 + 22 press-kit tests + 16 review-pass regression tests). Not run: Node tests, SQL tests, frontend build, any live page. **Fixtures are synthetic; selectors are untested against real press kits** (the free presskit() layout, plain `/press` pages and dt/dd or table layouts are handled).

## What was built
| Part | File | Behavior |
|---|---|---|
| Parser | `kairflow_intel/presskit.py` | Pure function over HTML. Reads "Label: value" facts (developer, publisher, website, release, platforms, founded, press contact). Every fact is re-checked against the visible page text. Hidden text is ignored. An email is reported only from a labelled press / business / contact field. Social and store links are recorded as text, never fetched. |
| Research step | `research.py` | Indie only. Pages already fetched that look like a press kit are parsed. If none, up to 2 same-host press-kit links, else the conventional `/presskit/`, `/press/`, `/press-kit/` paths, are fetched through the same fetcher. Facts are stored as evidence (`presskit_developer`, `_publisher`, `_website`, `_release`, `_platforms`, `_founded`, `_contact`) and in `facts.verified.presskit_*`. The press kit also feeds the existing developer/project identity mentions. |
| Report | `research_report.py` | New `press_kit` section and `contact.press_contact_email`, a "Press kit:" summary line, and gaps: "no press kit found", "only a press contact address ... not a verified business contact". |
| Discovery source | `sources.py`, `jobs.py` | New source key `presskit`. Reads only the URLs the administrator lists in the indie campaign criteria. Candidates need a developer name and a game title read from the page. Identity status is `presskit_listed_developer` (not confirmed). No email is passed at discovery. Keywords are not required when `presskit` is the only source. |
| Registry | `supabase/migrations/20270104090000_intelligence_presskit_source.sql` | Adds the key and registers it **disabled and unverified**. Local file, **not applied**. |

## Behavior change to know about
Addresses read from a page that parses as a press kit are no longer used to pick the prospect's business contact. Before, a press page linked from the home page could supply that contact, including an unlabelled address in its footer. The same address on another page of the site still counts. A press address is stored as a press contact only; `contactability.py` is unchanged.

## Turning the source on (owner steps)
1. Apply the migration deliberately (do not run a blanket `supabase db push`; the hosted ledger is unknown).
2. Add `"presskit"` to the indie campaign `criteria.sources` and list URLs in `criteria.presskit_urls` (http/https only; Kickstarter URLs are rejected).
3. Confirm the terms of the sites you list, set the source to confirmed, then enable it. Default daily budget is 50 fetches.

Example criteria: `{"sources": ["steam", "itch", "presskit"], "keywords": ["anime"], "presskit_urls": ["https://example-studio.com/presskit/"]}`

## Rollback
`delete from public.intel_sources where key = 'presskit';` then restore the previous key check (the list in the migration without `'presskit'`). Remove `presskit` from the campaign criteria. The code ignores an unlisted source.

## Not done
No live fetch, no crawling for press kits, no press-kit directory sources, and no use of the report by the drafting step yet. Outbound sending is untouched and disabled.

## Review pass (bugs found and fixed after the update was merged)
Found by running the update against realistic pages, not by reading alone. Each has a regression test in `tests/test_presskit_review_fixes.py` that fails on the unreviewed code.

| # | Defect | Fix |
|---|---|---|
| 1 | `scoring.indie_mandatory_gates` treated only `itch` and `kickstarter_manual` as unverified-identity sources, so a `presskit` candidate (`presskit_listed_developer`) **passed the project-identity gate as if confirmed**, against the update's own "not confirmed" intent. | `presskit` added to that set (`scoring.py`). It passes once research sets `independently_verified`, like itch. |
| 2 | `presskit._registrable` took the last two labels, so `press@other.co.uk` was marked "own domain" for `tinymoon.co.uk`. | Uses `entity.registrable_domain` (multi-part suffixes). |
| 3 | `candidate_urls` / `looks_like_presskit_url` accepted `/presskit.zip`, `/media/hero.png`, `/media/trailer.mp4` and `/pressure-washers/` as press-kit pages; with a limit of 2 fetches they could crowd out the real page. | Non-page extensions are rejected; `/press` must be a real segment (`/press`, `/press-room`, `/press_kit`), not a prefix. |
| 4 | A link to `www.site.com/press/` was dropped for site `site.com`, and `research.py` rejected a press page that redirected apex to www. | www-insensitive same-site check in both places. Other hosts are still rejected. |
| 5 | Labels were matched too loosely: "Social media" and "Press quotes" became press contacts, "Launch trailer" and "Available on" became release, "Developed with" became developer. | Stricter label rules; non-fact labels are ignored; "Available on" is platforms. |
| 6 | `Press Kit - Tiny Quest` gave an empty title (first segment was the kit word), which dropped the discovery candidate. | The first segment that is not just a press-kit word is used. |
| 7 | In `research.py`, developer/publisher/release/platforms came from the **last** press page while the URL, website and email came from the **first**. | First page wins for all of them. |

Still true: fixtures are synthetic. The selectors, and the label rules above, are untested against real press kits.
