-- Enable only the reviewed server-side Gmail/Zoho manual-send adapters.
-- Account identity and OAuth credentials remain in intel_provider_accounts.
-- Mailbox receive/sync and other capabilities stay disabled until their adapters are complete.
begin;

do $$
begin
  if to_regclass('public.email_provider_registry') is null
     or to_regclass('public.intel_provider_accounts') is null then
    raise exception 'Shared Intelligence mailbox foundation must be applied first';
  end if;
end $$;

update public.email_provider_registry
   set adapter_key = 'gmail', display_name = 'Gmail', enabled = true,
       capabilities = jsonb_build_object(
         'send', true, 'oauth', true, 'threading_headers', true,
         'attachments_send', false, 'attachments_receive', false,
         'remote_sync', false, 'remote_search', false, 'remote_folders', false,
         'remote_drafts', false, 'remote_state', false, 'delivery_events', false
       ),
       note = 'Existing Settings/Intelligence OAuth account; server-side Inbox send adapter installed. Mailbox sync remains disabled pending acceptance.',
       updated_at = now()
 where provider_key = 'gmail';

update public.email_provider_registry
   set adapter_key = 'zoho', display_name = 'Zoho Mail', enabled = true,
       capabilities = jsonb_build_object(
         'send', true, 'oauth', true, 'threading_headers', true,
         'attachments_send', false, 'attachments_receive', false,
         'remote_sync', false, 'remote_search', false, 'remote_folders', false,
         'remote_drafts', false, 'remote_state', false, 'delivery_events', false
       ),
       note = 'Existing Settings/Intelligence OAuth account; manual correspondence only. Campaign/outreach remains prohibited. Mailbox sync remains disabled pending acceptance.',
       updated_at = now()
 where provider_key = 'zoho';

-- Return the provider-native parent ID and provider thread ID alongside RFC headers.
-- This is scoped by organization, conversation and the exact connected account.
create or replace function public.email_get_thread_parent(
  p_organization_id uuid, p_conversation_id uuid, p_account_id uuid
) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_row record;
begin
  select m.rfc_message_id, m.references_ids, m.provider_message_id,
         nullif(m.headers->>'x-kairflow-provider-thread-id', '') as provider_thread_id, m.direction as parent_direction
    into v_row
    from public.email_messages m
    join public.email_conversations c on c.id = m.conversation_id
   where m.organization_id = p_organization_id
     and m.account_id = p_account_id
     and m.conversation_id = p_conversation_id
     and c.organization_id = p_organization_id
     and c.account_id = p_account_id
     and m.status <> 'draft'
     and (nullif(btrim(m.rfc_message_id), '') is not null or nullif(btrim(m.provider_message_id), '') is not null or nullif(btrim(m.headers->>'x-kairflow-provider-thread-id'), '') is not null)
   order by coalesce(m.received_at, m.sent_at, m.created_at) desc, m.created_at desc
   limit 1;
  if not found then return null; end if;
  return jsonb_build_object(
    'rfc_message_id', v_row.rfc_message_id,
    'references_ids', v_row.references_ids,
    'provider_message_id', v_row.provider_message_id,
    'provider_thread_id', v_row.provider_thread_id,
    'parent_direction', v_row.parent_direction
  );
end $$;
revoke all on function public.email_get_thread_parent(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.email_get_thread_parent(uuid,uuid,uuid) to service_role;

commit;

-- Rollback (only before this send gateway is used): disable Gmail/Zoho in the Inbox registry and restore the prior two-field email_get_thread_parent() body from 20261211100000_email_inbox_conversation_consistency.sql. No account, credential, message or conversation rows are deleted.
