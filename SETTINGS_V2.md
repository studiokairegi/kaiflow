# Settings v2

Implements `kairil-settings-audit.md`. Sign out and Export backup moved from the top bar into Settings; the two supplied sounds are wired in as notification chimes.

## What changed

| Area | Result |
|---|---|
| Layout | 7 tabs (General, CRM, Production, Teams, Finance, Alerts & display, Integrations & account). Sticky save bar with Discard, per-tab unsaved dots, inline validation, tab flagged `!` when it has an error, browser warning if you leave with unsaved changes. Saving no longer navigates away (Close does). |
| Top bar | Export backup and Sign out removed; both live in Integrations & account. Gear remains. |
| Write path | The form no longer sends `plan`, `is_admin` or `has_seen_tutorial` (the tutorial flag has its own narrow write). |
| CRM follow-ups | Choose 1-6 follow-ups, **default 2** (days 0/3/7). Leads keep their own email slots; slots beyond the schedule are never "due". Auto No Response fires on the last *scheduled* follow-up and can be switched off. Studios still on the untouched old 5-step default move to the new default; customised schedules are left alone. |
| Archive | Windows (won/lost/no response/disqualified/closed) are per-studio; `archive_stale_leads()` reads them. |
| Outcome reasons | Hide defaults, add your own; a reason already on a lead is always kept. |
| Production | Default pipeline (Full / Custom + stages), planner defaults (profit, reserve, fps) used by new plans, focus timer saved to the account (localStorage kept as cache), working days + hours per day drive overtime. |
| Finance | Base currency shown (managed in Finance, locks after real postings), milestone split (must total 100), invoice prefixes, payment terms (pre-fills due date), tax details, privacy mode. |
| Alerts | Master switch, six category switches (each digest line and each timer/upload notification honours its own), sound on/off with **Glass tap** / **Water droplet**, volume, preview; dashboard default period. |
| Integrations & account | Drive and Patreon status, Reconnect and **Disconnect**, Export backup, Sign out, tutorial, support, admin inbox, typed-email **Delete account**. |
| Timezone / date format | New setting. "Today" in Finance and new-invoice dates follow the timezone; Finance tables use the date format. |
| Data | `user_settings` evolved additively + a small `user_prefs` jsonb restricted to known keys by a CHECK. Invoice numbers get a unique index (skipped with a notice if duplicates exist). |

## Deploy
1. Back up. Run `migration_settings_v2.sql`.
2. Deploy the edge function: `supabase functions deploy account-manage` (needs the existing `DRIVE_TOKEN_ENCRYPTION_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` secrets). Without it Disconnect and Delete account show an error; everything else works.
3. Copy `src/` and `public/sounds/` into the project and build.

## Verification
* 16 settings tests (schema, validation, follow-up cadence, workweek, timezone, notification categories, reasons), 23 finance tests, existing pipeline test: all pass.
* App builds; TypeScript scan found no undefined identifiers.
* The Settings page was driven in Chromium (22 checks): tabs, dirty/saved state, validation blocking save, error-tab flag, stepper, reasons, sounds listed/preview, Export/Sign out present and wired, delete needs the exact email, discard, no mobile overflow.
* **Not run:** `migration_settings_v2.sql` and the `account-manage` edge function (no Postgres/Deno/deployment here), and real audio playback with the shipped mp3s in a browser.

## Known limits / decisions
* Sounds play only while a Kairil tab is open and may be blocked by the browser until you've interacted with the page; a web page cannot change the OS notification sound.
* The studio **currency symbol** stays a symbol ("Default currency for new projects"). Changing it to a code would touch `enforce_project_currency_plan`, `CURRENCY_CODE_BY_SYMBOL` and every symbol column together; the audit said to wait for the Finance v2 contract. The accounting base currency is separate and read from Finance.
* Privacy mode lives in `finance_settings` (the Finance v2 contract), not `user_prefs`.
* Timezone/date format are applied in Finance and invoice dates, not yet to every date label in CRM/Projects.
* Disconnecting Drive deletes the stored token and asks Google to revoke it (best effort); files in Drive are untouched. Disconnecting a Pro Patreon account returns it to Free (server-side), unless it is an admin.
* `archive_stale_leads()` is now per-studio, but whether `pg_cron` actually schedules it can't be seen from the project files; check it is scheduled.
* Invoice numbering still uses one shared counter across document types (as before); only uniqueness is enforced.
* Scope per setting (studio / user / account) is recorded in `SETTING_REGISTRY` but not enforced; today one row serves all three.
