# KairFlow Intelligence merge notes

The Intelligence package has been merged into this repository.

## Integrated
- Added `src/intelligence/` UI, access controls, API helpers, logic, fixtures, and tests.
- Added `intelligence-worker/` Python worker and its unit tests.
- Added the Intelligence Supabase migrations, Edge Functions, shared helpers, and SQL tests.
- Added the Intelligence setup and authorization documentation.
- Wired the Intelligence workspace into `src/App.jsx`.
- Added Intelligence notification event types and notification navigation metadata.
- Updated `.gitignore` for the worker's local Python environment.
- Updated the `npm test` command to use Node's built-in TypeScript stripping for existing Supabase `.ts` helper imports.

## Verification performed
- `npm test`: 597 tests passed.
- `python -m unittest discover -s tests -t .` in `intelligence-worker/`: 45 tests passed.

## Still required before production use
- Install Node dependencies and run `npm run build`.
- Run the SQL test suite against a disposable local PostgreSQL 16 instance.
- Back up the production Supabase database, then apply the five Intelligence migrations in the order listed in `docs/INTELLIGENCE_SETUP.md`.
- Configure the Zoho/Supabase secrets and deploy the three Zoho Edge Functions only when ready.
- Set up and register the dedicated Intelligence agent account, install Ollama/models, and configure the worker environment.
- Review applicable email marketing/privacy requirements and DNS (SPF, DKIM, DMARC) before enabling sending.

No production database, Zoho account, secrets, or external services were changed by this merge. Email sending remains disabled until explicitly configured and approved in the app.
