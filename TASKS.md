# Tasks, Daily Planning & Recurring Tasks

## What it is
A **Tasks** section on the dashboard (above the business overview) with six views that switch in place: Today, Tomorrow, This week, Upcoming, Completed, Recurring. The last-used view is remembered per browser.

- **Today**: overdue first, then today's tasks; star priorities, reorder, see remaining / completed / estimated workload.
- **Tomorrow**: prepare in advance (quick add, priorities, durations).
- **This week**: Monday-Sunday agenda grouped by day; move tasks between days, carry unfinished work forward, heavy days (> 8h estimated) flagged, overdue and unscheduled shown.
- **Upcoming / Completed**: beyond this week; completed with completion dates.
- **Recurring**: series with next occurrence; edit, pause, resume, end.

Tasks can link to a lead/deal, contact, project or shot; clicking the link opens that record. Completing a task never sends email, changes a deal stage, approves work or touches finance.

## Files
- `src/tasks.js` - pure logic (validation, date math, selectors, recurrence). Never reads the clock; every function takes `today`.
- `src/tasksApi.js` / `src/tasksInstance.js` - Supabase access.
- `src/TasksPanel.jsx` - UI.
- `src/App.jsx` - wires the panel into `DashboardPanel`, passes lead/project/shot/contact open handlers and follow-up suggestions.
- `supabase/migrations/20261012180000_studio_tasks.sql` - new tables, RLS, guard triggers, functions.
- `src/tasks.test.mjs` (`node src/tasks.test.mjs`) and `tasks_tests.sql` (run on a non-production database).

## Data model (migration - NOT yet applied)
Additive and idempotent: new tables `studio_tasks` and `studio_task_series`, RLS (users only see/manage their own rows), a guard trigger (links/series must belong to the same user; completion timestamps follow status), and four functions (materialize, series sync, series status, reorder). Existing tables are untouched. A separate table was used because no existing table models due dates, priorities, recurrence or links to leads/projects/shots/contacts.

## Recurrence rules
- Dates are plain `YYYY-MM-DD` in the app's configured time zone (the client decides "today"; the database stores `date`, so DST and browser zone cannot shift a task).
- Occurrences are materialized 14 days ahead. A unique index on `(series_id, occurrence_date)` makes refreshes, second tabs and retries no-ops.
- Completing an occurrence completes only that row.
- Editing one occurrence marks it as an override; a later series edit leaves it alone. Editing the series updates untouched open occurrences from today on (schedule changes regenerate them).
- Monthly on day 31 falls on the last day of shorter months.
- **Catch-up**: after an absence, untouched, unstarted past occurrences are auto-skipped (cancelled, flagged) except the most recent one, so at most one overdue instance per series remains. Only recent misses are caught up (7 days; 31 for monthly). Anything you edited, moved, starred, started or completed is never swept.
- Pausing/ending removes untouched future occurrences; resuming never back-fills the paused period; ending is final.

## Suggested tasks
Shown only for leads genuinely due for follow-up (same conditions as the Needs Attention counts). Each has a stable key, so a lead/step that already has a task (open, done or dismissed) is never suggested again. Nothing is created until you click "Add task".

## Deploy
1. Apply `20261012180000_studio_tasks.sql` after the existing migrations (including the contacts one). Optionally run `tasks_tests.sql` on a non-production project first.
2. Deploy the front end. If the migration is missing the panel shows a friendly message instead of crashing.

## Limitations
- Reminders are not implemented (no reliable reminder infrastructure was found).
- Linking supports lead, contact, project, shot only (no invoice records).
- Custom interval is "every N days" (2-365).
