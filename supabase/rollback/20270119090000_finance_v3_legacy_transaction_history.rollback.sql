-- Rollback for 20270119090000_finance_v3_legacy_transaction_history.sql.
-- This removes only the archive objects added by that migration. It does not touch V2,
-- V3 ledger entries, receivables, payments, expenses, or the engine setting.

begin;

drop function if exists public.fin3_migration_legacy_history_report(uuid);
drop function if exists public.fin3_migration_import_legacy_history(uuid);
drop function if exists public.fin3_migration_extract_legacy_history(uuid);
drop table if exists finance_v3.legacy_transaction_history;
delete from finance_v3.schema_version where version = '20270119090000';

commit;
