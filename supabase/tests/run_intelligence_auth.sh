#!/usr/bin/env bash
# Applies the studio migrations + the Intelligence authorization migration (twice, to prove it is
# idempotent) to a throwaway Postgres 16 database and runs the authorization SQL tests.
# Needs a superuser connection:   PGUSER=postgres ./supabase/tests/run_intelligence_auth.sh
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; root="$here/../.."
DB="${INTEL_TEST_DB:-intel_auth_sql_test}"
psql -v ON_ERROR_STOP=1 -qc "drop database if exists $DB" postgres >/dev/null 2>&1 || exit 2
psql -v ON_ERROR_STOP=1 -qc "create database $DB" postgres || exit 2
run() { psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$1" >/dev/null 2>/tmp/intel_auth_err.txt || { echo "FAILED to apply $1"; head -8 /tmp/intel_auth_err.txt; exit 2; }; }
run "$here/00_bootstrap_stubs.sql"
run "$here/storage_stub.sql"
run "$here/auth_extra_stub.sql"
run "$root/schema.sql"
run "$here/01_app_tables_stub.sql"
run "$here/intelligence_stub.sql"
run "$root/migration_review.sql"
run "$root/migration_sharing.sql"
run "$root/migration_activity_uploads.sql"
run "$root/supabase/migrations/20261012090000_cut_review_final_delivery.sql"
run "$root/supabase/migrations/20261012120000_contacts_clients.sql"
for m in 20261029090000_chat_collaboration 20261030090000_studio_multiuser_core \
         20261031090000_studio_team_invites_and_bootstrap 20261031100000_multi_organization_memberships \
         20261101090000_frictionless_team_invites 20261102090000_access_overrides_directory_privacy; do
  [ -f "$root/supabase/migrations/$m.sql" ] || continue
  run "$root/supabase/migrations/$m.sql"
done
run "$root/supabase/migrations/20261107090000_intelligence_authorization.sql"
run "$root/supabase/migrations/20261107090000_intelligence_authorization.sql"   # idempotent re-run
for m in 20261108090000_intelligence_core_tables 20261108100000_intelligence_crm_notifications 20261108110000_intelligence_rpcs 20261108120000_intelligence_zoho_oauth; do
  run "$root/supabase/migrations/$m.sql"; run "$root/supabase/migrations/$m.sql"   # applied twice: idempotent
done
echo "migrations applied (authorization migration applied twice)"
out="$(psql -v ON_ERROR_STOP=1 -d "$DB" -f "$here/intelligence_authorization.test.sql" 2>&1)"; code=$?
echo "$out" | grep -E "PASS|FAIL|SKIP|ERROR" | sed 's/^psql:[^ ]* //'
[ $code -eq 0 ] || { echo "TEST FILE FAILED: intelligence_authorization.test.sql"; exit 1; }
out="$(psql -v ON_ERROR_STOP=1 -d "$DB" -f "$here/intelligence_core.test.sql" 2>&1)"; code=$?
echo "$out" | grep -E "PASS|FAIL|SKIP|ERROR" | sed 's/^psql:[^ ]* //'
[ $code -eq 0 ] || { echo "TEST FILE FAILED: intelligence_core.test.sql"; exit 1; }
