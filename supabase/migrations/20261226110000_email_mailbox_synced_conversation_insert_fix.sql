-- Fix: email_get_or_create_synced_conversation (20261214100000) listed five INSERT columns (including provider_thread_id) but
-- supplied only four values, so creating a conversation for any provider-synced thread failed with
-- "INSERT has more target columns than expressions". Every mailbox sync of a message that carries a provider thread id aborted.
-- Same signature, grants and behaviour otherwise. Existing rows are untouched.
create or replace function public.email_get_or_create_synced_conversation(
  p_organization_id uuid,p_account_id uuid,p_provider text,p_provider_thread_id text,p_subject text,p_normalized_subject text
) returns uuid language plpgsql security definer set search_path = pg_catalog, public as $$
declare a public.email_accounts; v_id uuid;
begin
  if nullif(btrim(coalesce(p_provider_thread_id,'')),'') is null or length(p_provider_thread_id)>500 then raise exception 'Provider thread id is invalid'; end if;
  select * into a from public.email_accounts where id=p_account_id and organization_id=p_organization_id and provider=p_provider and status='active';
  if not found then raise exception 'Mailbox account is not authorized' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtext(p_account_id::text),hashtext(p_provider||':'||p_provider_thread_id));
  select id into v_id from public.email_conversations where account_id=p_account_id and provider_thread_id=p_provider_thread_id;
  if v_id is not null then return v_id; end if;
  insert into public.email_conversations(organization_id,account_id,provider_thread_id,subject,normalized_subject)
  values(p_organization_id,p_account_id,p_provider_thread_id,left(coalesce(p_subject,''),998),left(coalesce(p_normalized_subject,''),998))
  on conflict(account_id,provider_thread_id) where provider_thread_id is not null do update
    set subject=case when public.email_conversations.subject='' then excluded.subject else public.email_conversations.subject end
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.email_get_or_create_synced_conversation(uuid,uuid,text,text,text,text) from public, anon, authenticated;
grant execute on function public.email_get_or_create_synced_conversation(uuid,uuid,text,text,text,text) to service_role;
