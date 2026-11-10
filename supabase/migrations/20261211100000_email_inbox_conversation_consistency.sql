-- Phase 4E: shared Inbox ordering, conversation counters and RFC threading consistency.
-- Additive: no provider calls, no message deletion, and no changes to transactional Resend. Nothing is sent by applying this migration.
begin;

-- The previous trigger counted a message when it was first queued, but did not advance
-- last_message_at when the provider later confirmed sent_at. It also did not recompute the
-- latest snippet/direction when a delayed outbound status update supplied the authoritative
-- sent timestamp. Count only the first transition out of draft; always derive latest-message
-- metadata from persisted non-draft rows.
create or replace function public._email_message_counters() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_new_non_draft boolean := false;
  v_count integer;
  v_unread integer;
  v_direction text;
  v_snippet text;
  v_at timestamptz;
begin
  if tg_op = 'INSERT' then
    v_new_non_draft := new.status <> 'draft';
  elsif tg_op = 'UPDATE' then
    v_new_non_draft := old.status = 'draft' and new.status <> 'draft';
  end if;

  if v_new_non_draft then
    update public.email_conversations
       set message_count = message_count + 1,
           unread_count = unread_count + case when new.direction = 'inbound' and not new.is_read then 1 else 0 end,
           status = case when new.direction = 'inbound' then 'open' else status end
     where id = new.conversation_id;
  end if;

  -- Recalculate the visible latest-message fields after inserts and provider timestamp/status
  -- updates. This keeps inbound and outbound rows in one chronological ordering.
  select count(*)::integer,
         (array_agg(direction order by coalesce(received_at, sent_at, created_at) desc, created_at desc))[1],
         (array_agg(left(regexp_replace(body_text, '\\s+', ' ', 'g'), 200)
                    order by coalesce(received_at, sent_at, created_at) desc, created_at desc))[1],
         max(coalesce(received_at, sent_at, created_at))
    into v_count, v_direction, v_snippet, v_at
    from public.email_messages
   where conversation_id = new.conversation_id and status <> 'draft';

  update public.email_conversations
     set last_message_at = v_at,
         last_direction = v_direction,
         snippet = coalesce(v_snippet, ''),
         message_count = v_count
   where id = new.conversation_id;

  return new;
end $$;

drop trigger if exists email_messages_counters on public.email_messages;
create trigger email_messages_counters
  after insert or update of status, sent_at, received_at on public.email_messages
  for each row execute function public._email_message_counters();

-- Repair denormalized fields for existing conversations without changing message or CRM rows.
update public.email_conversations c
   set message_count = x.message_count,
       unread_count = x.unread_count,
       last_message_at = x.last_message_at,
       last_direction = x.last_direction,
       snippet = x.snippet
  from (
    select c0.id,
           count(m.id) filter (where m.status <> 'draft')::integer as message_count,
           count(m.id) filter (where m.status <> 'draft' and m.direction = 'inbound' and not m.is_read)::integer as unread_count,
           (array_agg(coalesce(m.received_at, m.sent_at, m.created_at) order by coalesce(m.received_at, m.sent_at, m.created_at) desc, m.created_at desc)
             filter (where m.status <> 'draft'))[1] as last_message_at,
           (array_agg(m.direction order by coalesce(m.received_at, m.sent_at, m.created_at) desc, m.created_at desc)
             filter (where m.status <> 'draft'))[1] as last_direction,
           (array_agg(left(regexp_replace(m.body_text, '\\s+', ' ', 'g'), 200)
                      order by coalesce(m.received_at, m.sent_at, m.created_at) desc, m.created_at desc)
             filter (where m.status <> 'draft'))[1] as snippet
      from public.email_conversations c0
      left join public.email_messages m on m.conversation_id = c0.id
     group by c0.id
  ) x
 where c.id = x.id;

-- Return the most recent message that actually has an RFC Message-ID, ordered by the
-- real timestamp for BOTH inbound and outbound messages. Service-role only: called by
-- email-send after account/conversation authorization has already been established.
create or replace function public.email_get_thread_parent(
  p_organization_id uuid, p_conversation_id uuid, p_account_id uuid
) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_row record;
begin
  select m.rfc_message_id, m.references_ids
    into v_row
    from public.email_messages m
    join public.email_conversations c on c.id = m.conversation_id
   where m.organization_id = p_organization_id
     and m.account_id = p_account_id
     and m.conversation_id = p_conversation_id
     and c.organization_id = p_organization_id
     and c.account_id = p_account_id
     and m.status <> 'draft'
     and nullif(btrim(m.rfc_message_id), '') is not null
   order by coalesce(m.received_at, m.sent_at, m.created_at) desc, m.created_at desc
   limit 1;
  if not found then return null; end if;
  return jsonb_build_object('rfc_message_id', v_row.rfc_message_id, 'references_ids', v_row.references_ids);
end $$;
revoke all on function public.email_get_thread_parent(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.email_get_thread_parent(uuid,uuid,uuid) to service_role;
revoke all on function public._email_message_counters() from public, anon, authenticated;

commit;

-- Rollback (only if Phase 4E is not in use): restore the _email_message_counters() body and
-- trigger definition from 20261110090000_email_resend_core.sql, then drop
-- public.email_get_thread_parent(uuid,uuid,uuid). Existing conversation counters are not destructive.
