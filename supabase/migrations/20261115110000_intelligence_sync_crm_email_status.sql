-- Keep the CRM email sequence in sync with confirmed Intelligence sends.
-- AI-created leads start with an empty emails array in the database; the UI
-- synthesizes empty slots, so the previous confirm-send update silently did
-- nothing when slot 0 did not physically exist.
begin;

create or replace function public.intel_agent_confirm_send(
  p_message_id uuid,
  p_zoho_message_id text,
  p_rfc_message_id text,
  p_thread_id text,
  p_sent_at timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.intel_agent_org();
  m public.intel_messages;
  v_when timestamptz := coalesce(p_sent_at, now());
  v_emails jsonb;
  v_slot jsonb;
begin
  select * into m
    from public.intel_messages
   where id = p_message_id and organization_id = v_org
   for update;
  if not found then raise exception 'message not found'; end if;
  if m.state = 'sent' then return jsonb_build_object('ok', true, 'idempotent', true); end if;
  if m.state not in ('reserved','sending','unknown') then
    raise exception 'message is % and cannot be confirmed', m.state;
  end if;

  update public.intel_messages
     set state = 'sent', sent_at = v_when,
         zoho_message_id = nullif(p_zoho_message_id, ''),
         rfc_message_id = nullif(p_rfc_message_id, ''),
         zoho_thread_id = nullif(p_thread_id, ''), error = null
   where id = m.id;

  if m.kind in ('initial','followup') then
    update public.intel_prospects
       set status = case when status in ('replied','closed') then status else 'contacted' end,
           updated_at = now()
     where id = m.prospect_id;

    if m.lead_id is not null then
      -- Match the UI's normalizeEmails() behavior: materialize missing slots
      -- before marking the actual step sent. Never infer delivery from a
      -- reserved/sending/unknown message; this function is called only after
      -- the provider acceptance has been confirmed.
      select case when jsonb_typeof(l.emails) = 'array' then l.emails else '[]'::jsonb end
        into v_emails
        from public.leads l
       where l.id = m.lead_id
       for update;

      if found then
        if m.step < 0 or m.step > 100 then
          raise exception 'message step is outside the supported range';
        end if;
        while jsonb_array_length(v_emails) <= m.step loop
          if jsonb_array_length(v_emails) = 0 then
            v_slot := jsonb_build_object('label', 'Initial Email', 'message', '', 'sent', false, 'dateSent', null);
          else
            v_slot := jsonb_build_object(
              'label', 'Follow-up ' || jsonb_array_length(v_emails)::text,
              'message', '', 'sent', false, 'dateSent', null
            );
          end if;
          v_emails := v_emails || jsonb_build_array(v_slot);
        end loop;

        v_slot := coalesce(v_emails -> m.step, '{}'::jsonb)
          || jsonb_build_object(
            'sent', true,
            'dateSent', to_char(v_when, 'YYYY-MM-DD'),
            'message', m.body_text
          );
        v_emails := jsonb_set(v_emails, array[m.step::text], v_slot, true);

        update public.leads
           set emails = v_emails,
               last_contacted_at = v_when,
               stage = case when m.kind = 'initial' and stage = 'pool' then 'cold_email' else stage end,
               stage_changed_at = case when m.kind = 'initial' and stage = 'pool' then now() else stage_changed_at end
         where id = m.lead_id;
      end if;
    end if;
  end if;

  perform public._intel_log(v_org, 'agent', 'confirm_send', 'message', m.id::text,
    jsonb_build_object('kind', m.kind));
  return jsonb_build_object('ok', true);
end $$;

-- CREATE OR REPLACE preserves the existing function ACL; explicitly restate
-- the worker-only execution grant to make the security contract auditable.
revoke all on function public.intel_agent_confirm_send(uuid,text,text,text,timestamptz) from public, anon;
grant execute on function public.intel_agent_confirm_send(uuid,text,text,text,timestamptz) to authenticated;

commit;
