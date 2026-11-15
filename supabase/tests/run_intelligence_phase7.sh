#!/usr/bin/env bash
# Apply the Phase 7 grant migration twice to a disposable/staging database, then run its SQL contract.
# Requires a database already prepared by run_intelligence_auth.sh (migrations through 20270103090000 or later, plus the fixtures and ti.* helpers
# from intelligence_authorization.test.sql) and a superuser connection. NOT run in the session that wrote it.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$here/../.."
: "${DATABASE_URL:?Set DATABASE_URL to a disposable PostgreSQL database with the earlier migrations applied}"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tAc "select 1 from pg_namespace where nspname = 'ti'" | grep -q 1 \
  || { echo "Schema ti (test helpers) not found: run run_intelligence_auth.sh against this database first." >&2; exit 1; }
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$root/supabase/migrations/20270105090000_intelligence_phase7_service_role_grants.sql"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$root/supabase/migrations/20270105090000_intelligence_phase7_service_role_grants.sql"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$here/intelligence_phase7_service_role_grants.test.sql"
