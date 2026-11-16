#!/usr/bin/env bash
# Replays the Intelligence migrations through 20270110090000 on a DATABASE prepared by run_intelligence_auth.sh, then runs the Emma SQL contract.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; root="$here/../.."
: "${DATABASE_URL:?Set DATABASE_URL to a disposable PostgreSQL 16 database prepared by run_intelligence_auth.sh}"
for m in 20261112140000_intelligence_indie_project_qualification_v2 20270101100000_intelligence_indie_campaign_safety_hardening 20270102090000_intelligence_phase3_chat_provenance \
         20270103100000_intelligence_emma_actions 20270105090000_intelligence_phase7_service_role_grants 20270109110000_intelligence_chat_recover_stuck 20270110090000_intelligence_chat_snapshot; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$root/supabase/migrations/$m.sql" >/dev/null
done
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$root/supabase/migrations/20270103100000_intelligence_emma_actions.sql" >/dev/null   # applied twice: idempotent
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$here/intelligence_emma_actions.test.sql"
