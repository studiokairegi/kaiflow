# Source Integration Report — Phase 5

**No live request was made to any source in this session.** The workspace shell can reach only package registries and GitHub. Everything below comes from reading source code and mocked fixtures. Extraction against real Steam, itch.io, Wikidata, AniList, GDELT or Common Crawl responses is unverified.

| Source | Campaign | Status in code | Registry gate | Notes and risks |
|---|---|---|---|---|
| Steam store search and app pages | Indie | Implemented, project-level identity, developer and publisher kept separate, resumable cursor | Disabled by default until `tos_status` is confirmed by the owner | HTML selectors are untested against live pages and will break silently if Steam changes markup; the adapter then yields nothing rather than guessing |
| itch.io tag browse pages | Indie | Implemented, creator and project, multiple projects per creator kept | Same | Creator identity is `platform_creator_unverified`; no website until research finds one |
| Kickstarter | Indie | **Manual intake only**, deliberately | Source stays disabled and cannot be enabled by RPC | Kickstarter's terms forbid crawling and commercial reuse without written permission. The roadmap asks for Kickstarter; the repo's earlier decision stands and is preserved. A person adds a project URL with a permission reference. Research refuses to fetch kickstarter.com |
| Official developer and studio sites | Both | Implemented through the metered site crawler | `site_crawler` | Robots respected, same-host pages only, 8 page cap |
| Wikidata, AniList | Studio | Implemented | each source | Seed lists and official website lookup |
| GDELT news | Studio | Implemented; only numbered headlines leave the machine; the organization must be quoted from the headline | `gdelt` | |
| RSS feeds, Common Crawl | Studio | Implemented | each source | Evidence only after a feed is attached to a prospect |
| Industry directories and communities | Both | **Not implemented** | | Needs a named source and a terms check before any adapter |

## Before any production discovery

1. Confirm terms for Steam and itch.io yourself, then set the registry flags. The code will not do it for you.
2. Run one manual discover job with `limit` 5 and a small daily budget. Check `by_source` in the job result and open each prospect's report.
3. Compare 20 reports with the real pages. Record misses in DISCOVERY_QUALITY_TESTS.md.
