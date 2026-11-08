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
         20261102100000_portal_guest_client_chat 20261102110000_portal_freelancer_shot_chat \
         20261103090000_web_push 20261201100000_intelligence_phase11_atomic_portal_rate_limit; do
  [ -f "$root/supabase/migrations/$m.sql" ] || continue
  run "$root/supabase/migrations/$m.sql"
done
# The access/chat migrations, including the Phase 11 rate-limit correction, must be safe to run again.
for m in 20261102090000_access_overrides_directory_privacy 20261102100000_portal_guest_client_chat 20261102110000_portal_freelancer_shot_chat 20261103090000_web_push 20261201100000_intelligence_phase11_atomic_portal_rate_limit; do
  [ -f "$root/supabase/migrations/$m.sql" ] && run "$root/supabase/migrations/$m.sql"
done
echo "migrations applied (new migrations applied twice)"
# Exercise the count/insert race with independent concurrent PostgreSQL sessions.
rate_tmp="$(mktemp -d)"
rate_subject="phase11-concurrency-$(date +%s)-$$"
for i in $(seq 1 20); do
  psql -v ON_ERROR_STOP=1 -At -d "$DB" -c "select public.portal_rate_limit('phase11_concurrency', '$rate_subject', 5, 60)" >"$rate_tmp/$i" 2>/dev/null &
done
wait
for result in "$rate_tmp"/*; do
  if ! grep -qxE '[tf]' "$result"; then
    echo "FAIL: a concurrent rate-limit SQL request did not return a boolean result"
    rm -rf "$rate_tmp"
    exit 1
  fi
done
rate_allowed="$(grep -hxc 't' "$rate_tmp"/* | awk '{s += $1} END {print s+0}')"
rm -rf "$rate_tmp"
if [ "$rate_allowed" -ne 5 ]; then
  echo "FAIL: concurrent rate-limit requests admitted $rate_allowed; expected exactly 5"
  exit 1
fi
echo "PASS: concurrent rate-limit requests admitted exactly 5 of 20"
status=0
for t in "$here"/access_directory_groups.test.sql "$here"/portal_guest_client.test.sql "$here"/portal_freelancer_shot.test.sql "$here"/push_notifications.test.sql; do
  [ -f "$t" ] || continue
  out="$(psql -v ON_ERROR_STOP=1 -d "$DB" -f "$t" 2>&1)"; code=$?
  echo "$out" | grep -E "PASS|FAIL|ERROR" | sed 's/^psql:[^ ]* //'
  [ $code -ne 0 ] && { echo "TEST FILE FAILED: $(basename "$t")"; status=1; }
done
exit $status
