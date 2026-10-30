# KairFlow UI/UX audit — Phase 1

Scope: visual/interaction refinement only. No features, no changes to permissions, finance/ledger logic, RLS/RPC, Edge Functions or auth.

## Fixed
| Sev | Module | Issue | Fix |
|---|---|---|---|
| High | Dashboard | Cards overlapped at ≤1500px | Layout fixed in `refine.css` |
| High | Modals | Two-column rows (Email/Country etc.) clipped at the right edge | `min-width:0` on `fieldRow`/grid children |
| High | Mobile | Chat launcher covered modal actions and the Settings Save button | Launcher hidden while a modal is open (≤768px); save bar padded |
| High | Settings | No side gutter on mobile | Shared `--kf-gutter` |
| Med | Global | Inconsistent gutters, tabs, fonts (mono used for names/labels) | Shared gutter, underline tabs, Inter/Space Grotesk, tabular numerals |
| Med | Global | Emoji used as UI (priority, lock, greeting) | Replaced with `PriorityMark`/icons/text |
| Med | Buttons | Multiple competing primary styles | One teal primary, flat secondary (`secondaryButton`) |
| Med | Finance | Seven equal-weight KPI tiles | 4 headline + 3 quiet tiles |
| Med | Projects | Due/overdue not visible on cards | Meta line added |
| Med | Modals | Fixed `88vh` height on mobile browsers | `100dvh`-based bound; `role="dialog" aria-modal` on 11 overlays |
| Low | Header | Mobile header wrapped | Single row, full-width primary action |

## Remaining (not fixed)
- Tasks card (empty space under sticky card) still uses the older look. Planner KPIs and Teams group headings/cards refined.
- Settings shows a page title duplicating the app header title.
- Internal chat and client/freelancer portals were not re-rendered after the foundation changes.
- 1024px and 768px widths were not inspected; empty/error/loading states not audited.
- React warning about mixing `border` and `borderColor` — source not located.
- `FinanceModule` throws if `finance_init` returns null (fragility; not changed, security/business logic).
- Modal footers are inside the scroll area, not sticky.

## Verification limits
- `vite build` could not run (npm unreachable). Parse checks via esbuild only; 540/540 `node --test` pass.
- Screens were rendered in a Playwright harness with fake data; charts are stubs (not verified). Rendered: Dashboard, Leads, Projects, Teams, Finance overview, Settings, New-lead modal at 1440 and/or 390.
- Needs manual check in a real build: charts, chat, portals, all other modals, keyboard focus order, reduced motion.
