#!/usr/bin/env bash
# Apply Phase 12 migration twice to a disposable/staging database, then run SQL contracts.
# Requires an already migrated Phase 11 database and a superuser/migration connection.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$here/../.."
: "${DATABASE_URL:?Set DATABASE_URL to a disposable PostgreSQL database with Phase 11 migrations applied}"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$root/supabase/migrations/20261202090000_intelligence_phase12_worker_reliability.sql"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$root/supabase/migrations/20261202090000_intelligence_phase12_worker_reliability.sql"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$here/intelligence_phase12_worker.test.sql"
