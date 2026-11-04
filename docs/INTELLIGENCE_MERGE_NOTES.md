# KairFlow Intelligence: merged build

Two separate builds were combined into this one package.

| Came from | What it contributed |
|---|---|
| Build 1 (chat / V1 completion) | Agent Chat (propose-then-confirm), Existing Leads follow-up review, AI Generated dashboard chip and lead filter, Gmail provider, email threading headers, Windows service scripts, the renumbered migrations and the authorization fix for `crm_find_lead_duplicates` |
| Build 2 (discovery) | Autonomous discovery: Wikidata, AniList, GDELT, Common Crawl, RSS/feeds, site analysis, manual "Add from an X post", customer-profile editor, Discovery sources card (terms confirmation, budgets, circuit breaker), sending window (08:00-18:00 weekdays, editable), Disconnect mailbox, Phase 0 feasibility spike |

## Placement change
Intelligence is now **CRM > Intelligence**, a sub-tab beside Pipeline / Contacts / Portfolio, and is no longer its own top-level module.
Changes in `src/App.jsx`: the top-level "Intelligence" button and the `"intelligence"` workspace are removed; `crmTab` gains an `"intelligence"` value; the sub-tab is listed and rendered only when `canAccessIntelligence(intelAccess)` (admin AND active Master User, unchanged rule); a revoked permission drops the user back to Pipeline; notification click-through opens CRM > Intelligence; "Open lead" from Intelligence returns to the Pipeline tab; the dashboard "AI generated" shortcut now always opens the Pipeline tab. Because it is inside CRM, it is reachable only by someone who can see the CRM (Leads) workspace.

## Conflicts resolved
- **Migration numbers.** Build 2's migrations used the same timestamps as the renumbered Build 1 set. Build 1's numbering was kept; discovery became `20261109170000_intelligence_discovery.sql` (runs last). The sending-window columns and functions and `intel_admin_disconnect_mail` were folded into the core-tables and RPC migrations (those functions are not redefined later, so nothing overrides them).
- **Job kinds.** The database check list is the union of both sets (`chat` plus the discovery kinds), and the allowed-kinds list in `intel_admin_enqueue_job` includes the discovery kinds.
- **Worker.** Build 1's worker is the base (Gmail, chat, threading). Discovery handlers, the `api` client, weekly/daily/6-hourly/monthly scheduling and the robots sitemap helper were added. Research of a prospect with no website now flags it for review and otherwise continues through site analysis before qualification.
- **Settings UI.** Provider-neutral wording is kept (Gmail or Zoho). Disconnect works for either provider.
- **Tests.** Both suites were merged; two count/wiring assertions were updated (migration list, CRM placement).

## Test results in the build environment
| Check | Result |
|---|---|
| `node --test` (whole repo) | 639 of 639 pass |
| Python worker `unittest` | 111 of 111 pass (85 + 26 discovery) |
| JSX syntax, 17 files incl. `App.jsx` | OK |
| esbuild bundle of `src/main.jsx` (every import resolves) | OK |
| PostgreSQL SQL tests, `npm run build` (Vite), browser, Windows scripts, Ollama, Gmail/Zoho, live discovery APIs | **Not executed** (not available here). Commands are in `INTELLIGENCE_SETUP.md` |

Run the SQL tests (`PGUSER=postgres ./supabase/tests/run_intelligence_auth.sh`) before applying anything to Supabase. The merged core test file now includes the discovery and sending-window checks.
