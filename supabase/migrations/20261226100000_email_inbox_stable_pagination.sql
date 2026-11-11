-- Inbox pagination fix: ordering had no tiebreaker, so conversations sharing a timestamp could repeat or vanish between pages,
-- and the browser could never request more than the first 50. Same signature and grants as 20261111150000; replaced in place.
-- The row cap rises from 100 to 500 because the Inbox grows its page size ("Load more") instead of tracking offsets across polls.
create or replace function public.email_list_conversations(
  p_folder text default 'inbox',
  p_search text default null,
  p_limit int default 50,
  p_offset int default 0,
  p_account_id uuid default null,
  p_provider text default null
) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.email_require_access();
  v_q text := null;
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 500);
  v_provider text := nullif(lower(btrim(coalesce(p_provider, ''))), '');
begin
  if p_folder not in ('inbox', 'unread', 'sent', 'drafts', 'archived', 'all') then raise exception 'Unknown folder'; end if;
  if nullif(btrim(coalesce(p_search, '')), '') is not null then
    v_q := '%' || replace(replace(replace(lower(btrim(p_search)), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;
  return coalesce((
    select jsonb_agg(s.x order by s.sort_at desc nulls last, s.cid desc)
    from (
      select jsonb_build_object(
        'id', c.id, 'account_id', c.account_id, 'provider', a.provider,
        'subject', c.subject, 'snippet', c.snippet, 'status', c.status, 'lead_id', c.lead_id,
        'message_count', c.message_count, 'unread_count', c.unread_count, 'last_message_at', c.last_message_at,
        'last_direction', c.last_direction,
        'has_draft', exists (select 1 from public.email_messages d where d.conversation_id = c.id and d.status = 'draft'),
        'has_attachments', exists (select 1 from public.email_attachments at join public.email_messages m on m.id = at.message_id where m.conversation_id = c.id),
        'participants', coalesce((select jsonb_agg(jsonb_build_object('email', p.email, 'name', p.name) order by p.first_seen_at) from public.email_participants p where p.conversation_id = c.id), '[]'::jsonb)
      ) as x,
      coalesce(c.last_message_at, c.created_at) as sort_at,
      c.id as cid
      from public.email_conversations c
      join public.email_accounts a on a.id = c.account_id and a.organization_id = v_org
      where c.organization_id = v_org
        and (p_account_id is null or c.account_id = p_account_id)
        and (v_provider is null or a.provider = v_provider)
        and case p_folder
          when 'inbox' then c.status = 'open' and exists (select 1 from public.email_messages m where m.conversation_id = c.id and m.direction = 'inbound')
          when 'unread' then c.status = 'open' and c.unread_count > 0
          when 'sent' then exists (select 1 from public.email_messages m where m.conversation_id = c.id and m.direction = 'outbound' and m.status <> 'draft')
          when 'drafts' then exists (select 1 from public.email_messages m where m.conversation_id = c.id and m.status = 'draft')
          when 'archived' then c.status = 'archived'
          else true end
        and (v_q is null
          or lower(c.subject) like v_q escape '\'
          or lower(c.snippet) like v_q escape '\'
          or exists (select 1 from public.email_participants p where p.conversation_id = c.id and (lower(p.email) like v_q escape '\' or lower(p.name) like v_q escape '\'))
          or exists (select 1 from public.email_messages m where m.conversation_id = c.id and lower(m.body_text) like v_q escape '\'))
      order by sort_at desc nulls last, c.id desc
      limit v_limit offset greatest(coalesce(p_offset, 0), 0)
    ) s
  ), '[]'::jsonb);
end $$;
revoke all on function public.email_list_conversations(text,text,int,int,uuid,text) from public, anon;
grant execute on function public.email_list_conversations(text,text,int,int,uuid,text) to authenticated;
