# Phase 5 bug check: fixes applied

Python worker suite: 1064 passed (1059 original + 5 regression tests). Not run: Node tests, SQL tests, frontend build, any live source.

| # | Issue | Fix | File |
|---|---|---|---|
| 1 | Negated or ended sentences ("not looking for an animator", "no longer hiring", "already hired") detected as `seeking_animation`; "animated trailer" alone reported as an evidenced need | Negation guard in the detector; the report treats the need as `evidenced` only for an explicit, non-negated request. "Animated trailer" alone is supporting evidence only | `signals.py`, `research_report.py` |
| 3 | Future-dated page update shown as "0 days ago" | Future dates ignored and listed as a gap | `research_report.py` |
| 4 | Failed report build stored an error stub with no summary; `summarize()` raised KeyError; exception not logged | `failure_stub()`, `is_usable()`, safe `summarize()`, warning logged | `research_report.py`, `research.py` |
| 5 | `by_source` / `duplicate_rate` ignored protected and no-URL candidates | Counted as `skipped` per source | `jobs.py` |
| 6 | String "false" counted as verified; local-date default | Strict boolean check; UTC date | `research_report.py` |

Not changed: a normal research run still reports all stored evidence, including sentences a site later removed. Expiring old evidence is a product decision. The studio re-evaluation path passes no stored evidence, so it is unaffected.

Open: the negation guard is in the shared detector. Check whether scoring reads `seeking_animation` and re-run the 20-prospect check. Outbound sending is untouched and remains disabled.
