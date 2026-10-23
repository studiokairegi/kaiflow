#!/usr/bin/env bash
# Runs the Payments SQL tests on a throwaway database in a local Postgres (16+).
# Needs a superuser connection:  PGUSER=postgres ./supabase/tests/run.sh
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; root="$here/../.."
DB="${PAYMENTS_TEST_DB:-payments_sql_test}"
psql -v ON_ERROR_STOP=1 -qc "drop database if exists $DB" postgres >/dev/null 2>&1 || exit 2
psql -v ON_ERROR_STOP=1 -qc "create database $DB" postgres || exit 2
run() { psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$1" >/dev/null 2>&1 || { echo "FAILED to apply $1"; exit 2; }; }
run "$here/00_bootstrap_stubs.sql"
run "$root/schema.sql"
run "$here/01_app_tables_stub.sql"
run "$root/supabase/migrations/20261007215055_finance_v2.sql"
run "$root/supabase/migrations/20261012190000_finance_balance_trigger_security.sql"
run "$root/supabase/migrations/20261018090000_payments_paystack_sandbox.sql"
run "$root/supabase/migrations/20261018090000_payments_paystack_sandbox.sql"   # idempotent re-run
run "$root/supabase/migrations/20261021090000_payments_provider_neutral_admin_only.sql"
run "$root/supabase/migrations/20261021090000_payments_provider_neutral_admin_only.sql"   # idempotent re-run
run "$root/supabase/migrations/20261022090000_studio_portfolio.sql"
run "$root/supabase/migrations/20261022090000_studio_portfolio.sql"   # idempotent re-run
run "$root/supabase/migrations/20261023090000_portfolio_google_drive.sql"
run "$root/supabase/migrations/20261023090000_portfolio_google_drive.sql"   # idempotent re-run
run "$root/supabase/migrations/20261025090000_paystack_live_checkout.sql"
run "$root/supabase/migrations/20261025090000_paystack_live_checkout.sql"   # idempotent re-run
echo "migrations applied (payments + portfolio + live checkout migrations applied twice)"
out="$(psql -v ON_ERROR_STOP=1 -d "$DB" -f "$here/payments.test.sql" 2>&1)"; code=$?
echo "$out" | grep -E "PASS|FAIL|SUMMARY|ERROR" | sed 's/^psql:[^ ]* //'
[ $code -eq 0 ] || exit $code
out2="$(psql -v ON_ERROR_STOP=1 -d "$DB" -f "$here/payments_admin.test.sql" 2>&1)"; code2=$?
echo "$out2" | grep -E "PASS|FAIL|SUMMARY|ERROR" | sed 's/^psql:[^ ]* //'
[ $code2 -eq 0 ] || exit $code2
out3="$(psql -v ON_ERROR_STOP=1 -d "$DB" -f "$here/portfolio.test.sql" 2>&1)"; code3=$?
echo "$out3" | grep -E "PASS|FAIL|SUMMARY|ERROR" | sed 's/^psql:[^ ]* //'
[ $code3 -eq 0 ] || exit $code3
out4="$(psql -v ON_ERROR_STOP=1 -d "$DB" -f "$here/payments_live.test.sql" 2>&1)"; code4=$?
echo "$out4" | grep -E "PASS|FAIL|SUMMARY|ERROR" | sed 's/^psql:[^ ]* //'
exit $code4
