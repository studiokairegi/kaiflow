# KairFlow multi-user + chat + invoice reference overlay

This overlay contains only files that were added or changed relative to the KairFlow ZIP uploaded for the 2026-10-26 implementation request. It includes the chat collaboration feature, the multi-user migration, associated tests/docs, and the Invoice Ref. label changes.

## Integration safety

1. Make a backup of your current working tree first.
2. Compare every modified file in this overlay with the corresponding file in your actual current repository. The uploaded ZIP had pre-existing local changes; do not blindly overwrite a newer local edit made after that archive was prepared.
3. Copy/merge the paths under this folder into the repository root.
4. Review both new SQL migrations as a unit and compare them with the live Supabase schema and `supabase_migrations.schema_migrations` before applying anything.
5. Do not run production migrations until validated on a disposable/staging Supabase project.

No migration is applied by this bundle. Nothing is deployed, staged, committed, or pushed. Environment files, `.git`, dependencies, and build output are not included.
