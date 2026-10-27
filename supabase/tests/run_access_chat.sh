#!/usr/bin/env bash
# Applies the studio/chat/access/portal migrations to a throwaway Postgres 16 database and runs the
# access-control SQL tests against real RLS. Needs a superuser connection:
#   PGUSER=postgres ./supabase/tests/run_access_chat.sh
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; root="$here/../.."
DB="${ACCESS_TEST_DB:-access_chat_sql_test}"
psql -v ON_ERROR_STOP=1 -qc "drop database if exists $DB" postgres >/dev/null 2>&1 || exit 2
psql -v ON_ERROR_STOP=1 -qc "create database $DB" postgres || exit 2
run() { psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$1" >/dev/null 2>/tmp/access_chat_err.txt || { echo "FAILED to apply $1"; head -8 /tmp/access_chat_err.txt; exit 2; }; }
run "$here/00_bootstrap_stubs.sql"
run "$here/storage_stub.sql"
run "$here/auth_extra_stub.sql"
run "$root/schema.sql"
run "$here/01_app_tables_stub.sql"
run "$root/migration_review.sql"
run "$root/migration_sharing.sql"
run "$root/migration_activity_uploads.sql"
run "$root/supabase/migrations/20261012090000_cut_review_final_delivery.sql"
run "$root/supabase/migrations/20261012120000_contacts_clients.sql"
for m in 20261029090000_chat_collaboration 20261030090000_studio_multiuser_core \
         20261031090000_studio_team_invites_and_bootstrap 20261031100000_multi_organization_memberships \
         20261101090000_frictionless_team_invites 20261102090000_access_overrides_directory_privacy \
         20261102100000_portal_guest_client_chat 20261102110000_portal_freelancer_shot_chat; do
  [ -f "$root/supabase/migrations/$m.sql" ] || continue
  run "$root/supabase/migrations/$m.sql"
done
# The two new migrations must be safe to run again.
for m in 20261102090000_access_overrides_directory_privacy 20261102100000_portal_guest_client_chat 20261102110000_portal_freelancer_shot_chat; do
  [ -f "$root/supabase/migrations/$m.sql" ] && run "$root/supabase/migrations/$m.sql"
done
echo "migrations applied (new migrations applied twice)"
status=0
for t in "$here"/access_directory_groups.test.sql "$here"/portal_guest_client.test.sql "$here"/portal_freelancer_shot.test.sql; do
  [ -f "$t" ] || continue
  out="$(psql -v ON_ERROR_STOP=1 -d "$DB" -f "$t" 2>&1)"; code=$?
  echo "$out" | grep -E "PASS|FAIL|ERROR" | sed 's/^psql:[^ ]* //'
  [ $code -ne 0 ] && { echo "TEST FILE FAILED: $(basename "$t")"; status=1; }
done
exit $status
