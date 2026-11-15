-- Inbox search: email_list_conversations matches lower(column) LIKE '%text%' on message bodies, subjects, snippets and participants.
-- Without a trigram index every search (and every 20-second refresh while a search is active) scanned every message body.
-- These GIN indexes let the planner use the existing predicates unchanged (lower(...) like '%q%'); no function body changes.
-- Notes: patterns shorter than 3 characters still scan (a trigram limit). Building the message-body index on a large table takes a write lock for
-- the duration; run this migration in a quiet window, or create the indexes by hand with CREATE INDEX CONCURRENTLY (not allowed inside a migration transaction).
do $$
declare v_schema text;
begin
  select n.nspname into v_schema from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pg_trgm';
  if v_schema is null then
    begin
      create extension if not exists pg_trgm with schema extensions;
    exception when others then
      create extension if not exists pg_trgm;
    end;
    select n.nspname into v_schema from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pg_trgm';
  end if;
  if v_schema is null then raise exception 'pg_trgm is not available'; end if;
  execute format('create index if not exists email_messages_body_trgm_idx on public.email_messages using gin (lower(body_text) %I.gin_trgm_ops)', v_schema);
  execute format('create index if not exists email_conversations_subject_trgm_idx on public.email_conversations using gin (lower(subject) %I.gin_trgm_ops)', v_schema);
  execute format('create index if not exists email_conversations_snippet_trgm_idx on public.email_conversations using gin (lower(snippet) %I.gin_trgm_ops)', v_schema);
  execute format('create index if not exists email_participants_email_trgm_idx on public.email_participants using gin (lower(email) %I.gin_trgm_ops)', v_schema);
  execute format('create index if not exists email_participants_name_trgm_idx on public.email_participants using gin (lower(name) %I.gin_trgm_ops)', v_schema);
end $$;

-- Rollback:
--   drop index if exists public.email_messages_body_trgm_idx, public.email_conversations_subject_trgm_idx, public.email_conversations_snippet_trgm_idx,
--                        public.email_participants_email_trgm_idx, public.email_participants_name_trgm_idx;
