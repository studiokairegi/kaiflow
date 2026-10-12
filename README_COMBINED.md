# Combined changes: Cut review + Contacts + Tasks

Merged from three change sets. `src/App.jsx` is the Tasks version, which already contains the Cut-review and Contacts edits (verified by diff: each version is a strict superset of the previous one). No other file path overlaps.

## Apply order (migrations)
1. supabase/migrations/20261012090000_cut_review_final_delivery.sql
2. supabase/migrations/20261012120000_contacts_clients.sql
3. supabase/migrations/20261012180000_studio_tasks.sql
Edge functions (supabase/functions/*) belong to the Cut-review change; deploy them with it.

## Per-feature notes
CUT_REVIEW_WORKFLOW.md, CONTACTS.md, TASKS.md. Optional SQL checks: cut_review_tests.sql, contacts_tests.sql, tasks_tests.sql (non-production only).
Unit tests: node src/cutWorkflow.test.mjs, src/contacts.test.mjs, src/tasks.test.mjs
