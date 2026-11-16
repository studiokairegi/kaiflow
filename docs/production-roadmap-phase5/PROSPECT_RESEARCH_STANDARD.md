# Prospect Research Standard — Phase 5

Every research run produces a report in `facts.verified.research_report`. The report explains; qualification and contactability decide.

## Statement classes

| Class | Meaning | Example |
|---|---|---|
| confirmed | A verified evidence row: a sentence read from a fetched page, stored with its URL. Or a platform-listed or human-confirmed fact | "We are looking for an animator for our trailer" with the page URL |
| unverified | A candidate nobody has checked | An image URL awaiting a human look. Never counted as confirmed |
| inference | A rule-based reading of confirmed facts. Always labelled, always lists its basis | Animation need: `evidenced`, `plausible`, `possible` or `unknown` |
| gap | Looked for and not found | No verified contact email; latest dated update 316 days old |

## Rules

1. No model writes a report. It is built from stored rows, so it cannot invent an email address, contact name, budget, production requirement or relationship.
2. `evidenced` animation need requires the prospect's own page to say it is seeking animation help. Release or marketing activity plus a fitting visual style gives only `plausible`. One weak signal gives `possible`.
3. Identity is confirmed only when the platform lists the developer, a person verified it, or the official site names both developer and project. A matching name alone is not confirmation.
4. The report must be identical whichever AI provider answered. It therefore excludes the model-extracted contact name and role. This is enforced by a test.
5. Dates count only when explicit on the page. Fetch time, release dates and modified timestamps are never activity.
6. The report records what is missing so nobody fills it from a guess.

## Report fields

`identity`, `contact`, `activity`, `confirmed_facts`, `inferences`, `unverified_for_review`, `gaps`, `sources`, `evidence_counts`, `summary` as plain text. Bounded: 16 facts, 8 items per other section, 240 characters per snippet, 30 sources.

## Duplicates

Studios: resolved by domain, domain alias or normalized name before creation. Indie: SQL key from developer name plus title, case and whitespace folded only. Known weakness: a title written differently on two platforms, for example punctuation, a trademark sign or a subtitle, can create two prospects, and one developer with several games gets several prospects. Proposed fix, not built: an `intel_agent_find_indie_duplicates` RPC and a normalizer shared with `entity.norm_name`, which needs a migration and a database to test.
