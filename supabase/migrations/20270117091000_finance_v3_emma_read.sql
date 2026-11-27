-- Finance V3, Phase 6 (migration 2 of 2): Emma's READ-ONLY window into Finance.
--
-- public.intel_agent_finance_read is the sibling of public.intel_agent_chat_read: the Intelligence agent calls it with a chat thread and
-- the user's message, and it answers only if (a) the thread belongs to the agent's organisation, (b) the message is the user's own,
-- (c) the person who asked is still an authorised Intelligence user, and (d) that same person holds finance.read in Finance V3.
-- It runs the read-only insight builder and writes nothing in Finance. There is no write, payment, invoice or email tool for Emma here.
-- The Intelligence tables / helpers it relies on live in earlier migrations; they are resolved at call time, so this file applies
-- cleanly even where Intelligence is not installed (the function then simply cannot be used).
-- Rollback: supabase/rollback/20270117091000_finance_v3_emma_read.rollback.sql

begin;

insert into finance_v3.schema_version (version, notes)
values ('20270117091000', 'phase 6: Emma read-only finance insights')
on conflict (version) do nothing;

create or replace function public.intel_agent_finance_read(p_thread_id uuid, p_message_id bigint, p_tool text, p_args jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_org uuid := public.intel_agent_org();
  t record;
  v_out jsonb; s record; v_n integer;
begin
  select * into t from public.intel_chat_threads where id = p_thread_id and organization_id = v_org;
  if not found then return public._intel_deny('thread_not_found'); end if;
  if not exists (select 1 from public.intel_chat_messages m where m.id = p_message_id and m.thread_id = t.id and m.role = 'user') then return public._intel_deny('message_not_found'); end if;
  if not public.intel_is_authorized_user(t.user_id, v_org) then
    perform public._intel_log(v_org, 'agent', 'chat_denied_unauthorized', 'chat', t.id::text, jsonb_build_object('tool', left(coalesce(p_tool, ''), 40)));
    return public._intel_deny('requester_not_authorized');
  end if;
  if p_tool is distinct from 'finance_insights' then
    perform public._intel_log(v_org, 'agent', 'chat_denied_unknown_tool', 'chat', t.id::text, jsonb_build_object('tool', left(coalesce(p_tool, ''), 40)));
    return public._intel_deny('unknown_tool');
  end if;
  select count(*) into v_n from public.intel_chat_messages m where m.thread_id = t.id and m.role = 'tool' and m.reply_to = p_message_id;
  if v_n >= 12 then return public._intel_deny('too_many_tool_calls'); end if;

  begin
    select * into s from finance_v3.org_settings where organization_id = v_org;
    if not found then return public._intel_deny('finance_not_enabled'); end if;
    if not finance_v3.has_permission_for(t.user_id, v_org, 'finance.read') then
      perform public._intel_log(v_org, 'agent', 'finance_denied_no_permission', 'chat', t.id::text, jsonb_build_object('requested_by', t.user_id));
      return public._intel_deny('requester_has_no_finance_access');
    end if;
    v_out := jsonb_build_object('ok', true, 'read_only', true, 'generated_at', now(), 'base_currency', s.base_currency,
      'safe_to_spend', finance_v3.safe_to_spend_json(v_org, s.base_currency),
      'insights', finance_v3.emma_insights(v_org, t.user_id),
      'note', 'Read-only figures from the Finance ledger. To pay, invoice, email or change anything the person must use Finance and confirm there.');
  exception when others then
    return public._intel_deny('tool_failed: ' || left(sqlerrm, 160));
  end;

  insert into public.intel_chat_messages(thread_id, organization_id, role, content, tool_name, tool_args, tool_result, reply_to)
  values (t.id, v_org, 'tool', '', p_tool, '{}'::jsonb, v_out, p_message_id);
  perform public._intel_log(v_org, 'agent', 'chat_read', 'chat', t.id::text, jsonb_build_object('tool', p_tool, 'message_id', p_message_id, 'requested_by', t.user_id));
  return v_out;
end $$;

revoke all on function public.intel_agent_finance_read(uuid, bigint, text, jsonb) from public, anon;
grant execute on function public.intel_agent_finance_read(uuid, bigint, text, jsonb) to authenticated;

notify pgrst, 'reload schema';

commit;
