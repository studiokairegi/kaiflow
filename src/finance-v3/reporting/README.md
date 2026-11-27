Owner: Phase 6. Calls reporting RPCs (`fin3_report_*`) and formats results/CSV. The dashboard must read through this layer; it must not re-derive revenue, expenses or profit.

## Phase 6 (delivered)

Reports, dashboard, exports and notifications are database functions (migration `20270117090000`); the screens only display them. CSV text is built in `csv.js` (RFC 4180 quoting, spreadsheet-formula neutralisation); the database returns columns and rows, capped at 20,000 rows, and audits each export. UI: `ui/accountant/Reports.jsx` (More reports, Exports, Alerts), `ui/shared/Notifications.jsx`, Home "This month" card, project detail in `ui/simple/Projects.jsx`, app dashboard bridge `ui/useDashboardV3.js`.
