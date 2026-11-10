-- Phase 4F validation correction.
-- Phase 4E's counter trigger referenced an undeclared timestamp variable. This replacement
-- also recomputes unread counts when read state changes and uses an explicit regex escape.
-- Nothing is sent by applying this migration. No messages are deleted or rewritten.
begin;

create or replace function public._email_message_counters() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_count integer := 0;
  v_unread integer := 0;
  v_direction text;
  v_snippet text;
  v_at timestamptz;
begin
  select count(*) filter (where m.status <> 'draft')::integer,
         count(*) filter (where m.status <> 'draft' and m.direction = 'inbound' and not m.is_read)::integer,
         (array_agg(m.direction order by coalesce(m.received_at, m.sent_at, m.created_at) desc, m.created_at desc)
           filter (where m.status <> 'draft'))[1],
         (array_agg(left(regexp_replace(coalesce(m.body_text, ''), E'\\s+', ' ', 'g'),  200)
           order by coalesce(m.received_at, m.sent_at, m.created_at) desc, m.created_at desc)
           filter (where m.status <> 'draft'))[1],
         max(coalesce(m.received_at, m.sent_at, m.created_at)) filter (where m.status <> 'draft')
    into v_count, v_unread, v_direction, v_snippet, v_at
    from public.email_messages m
   where m.conversation_id = new.conversation_id;

  update public.email_conversations
     set message_count = coalesce(v_count, 0),
         unread_count = coalesce(v_unread, 0),
         last_message_at = v_at,
         last_direction = v_direction,
         snippet = coalesce(v_snippet, ''),
         status = case
           when tg_op = 'INSERT' and new.direction = 'inbound' and new.status <> 'draft' then 'open'
           when tg_op = 'UPDATE' and old.status = 'draft' and new.status <> 'draft' and new.direction = 'inbound' then 'open'
           else status
         end
   where id = new.conversation_id;

  return new;
end $$;

revoke all on function public._email_message_counters() from public, anon, authenticated;

drop trigger if exists email_messages_counters on public.email_messages;
create trigger email_messages_counters
  after insert or update of status, sent_at, received_at, is_read on public.email_messages
  for each row execute function public._email_message_counters();

-- Recalculate existing denormalized Inbox metadata using the same rules as the trigger.
update public.email_conversations c
   set message_count = x.message_count,
       unread_count = x.unread_count,
       last_message_at = x.last_message_at,
       last_direction = x.last_direction,
       snippet = coalesce(x.snippet, '')
  from (
    select c0.id,
           count(m.id) filter (where m.status <> 'draft')::integer as message_count,
           count(m.id) filter (where m.status <> 'draft' and m.direction = 'inbound' and not m.is_read)::integer as unread_count,
           (array_agg(coalesce(m.received_at, m.sent_at, m.created_at)
             order by coalesce(m.received_at, m.sent_at, m.created_at) desc, m.created_at desc)
             filter (where m.status <> 'draft'))[1] as last_message_at,
           (array_agg(m.direction
             order by coalesce(m.received_at, m.sent_at, m.created_at) desc, m.created_at desc)
             filter (where m.status <> 'draft'))[1] as last_direction,
           (array_agg(left(regexp_replace(coalesce(m.body_text, ''), E'\\s+', ' ', 'g'), 200)
             order by coalesce(m.received_at, m.sent_at, m.created_at) desc, m.created_at desc)
             filter (where m.status <> 'draft'))[1] as snippet
      from public.email_conversations c0
      left join public.email_messages m on m.conversation_id = c0.id
     group by c0.id
  ) x
 where c.id = x.id;

commit;

-- Rollback: restore the function and trigger definitions from
-- 20261211100000_email_inbox_conversation_consistency.sql. Existing message data is unchanged.
