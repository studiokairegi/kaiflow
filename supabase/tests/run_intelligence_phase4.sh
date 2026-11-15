#!/usr/bin/env bash
# Apply the Phase 4 migration twice to a disposable/staging database, then run its SQL contract.
# Requires a database already prepared by run_intelligence_auth.sh (all migrations through 20270102090000, plus the fixtures and ti.* helpers
# from intelligence_authorization.test.sql) and a superuser connection. NOT run in the session that wrote it.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$here/../.."
: "${DATABASE_URL:?Set DATABASE_URL to a disposable PostgreSQL database with the earlier migrations applied}"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$root/supabase/migrations/20270103090000_intelligence_phase4_job_reliability.sql"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$root/supabase/migrations/20270103090000_intelligence_phase4_job_reliability.sql"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$here/intelligence_phase4_job_reliability.test.sql"
