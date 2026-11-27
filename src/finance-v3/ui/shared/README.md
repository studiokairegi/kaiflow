Phase 5 (built). Components and hooks used by both modes: `kit.jsx` (cards, tables that become cards on phones, dialogs with focus trap, tabs, async states), `parts.jsx` (ActionDialog with V3007 handling), `format.js` (exact decimal-string money), `errors.js` (plain-language errors).
The mode switch is a UI preference (`fin3_set_ui_prefs`) and never changes financial records.
Tests: `../__tests__/ui.test.mjs` (esbuild + Playwright Chromium, real client API, fixtures recorded from the real database: regenerate with `supabase/tests/finance_v3/harness/dump_ui_fixtures.sql`).
