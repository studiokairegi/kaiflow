-- Phase 8: atomically revalidate every mutable send permission immediately before
-- the provider call. The worker's intel_agent_mark_sending RPC is the final gate.
-- This deliberately requires a human-approved message (auto_sent=false) for every
-- outbound message; autonomous/assisted drafts must be explicitly reviewed first.
begin;

-- Serialize send checks with all suppression/permission mutations, including
-- inserts into previously empty keys. Advisory-lock collisions only add contention.
create or replace function public._intel_phase8_lock_policy_key()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_old_key bigint;
  v_new_key bigint;
begin
  if tg_op <> 'INSERT' then
    v_old_key := hashtextextended(old.organization_id::text ||
      case when tg_table_name = 'intel_suppressions' then ':suppression:' || old.kind || ':' || old.value
           else ':permission:' || old.purpose || ':' || old.email end, 0);
  end if;
  if tg_op <> 'DELETE' then
    v_new_key := hashtextextended(new.organization_id::text ||
      case when tg_table_name = 'intel_suppressions' then ':suppression:' || new.kind || ':' || new.value
           else ':permission:' || new.purpose || ':' || new.email end, 0);
  end if;
  if v_old_key is not null and v_new_key is not null then
    if v_old_key <= v_new_key then
      perform pg_advisory_xact_lock(v_old_key);
      if v_new_key <> v_old_key then perform pg_advisory_xact_lock(v_new_key); end if;
    else
      perform pg_advisory_xact_lock(v_new_key);
      perform pg_advisory_xact_lock(v_old_key);
    end if;
  elsif v_old_key is not null then
    perform pg_advisory_xact_lock(v_old_key);
  elsif v_new_key is not null then
    perform pg_advisory_xact_lock(v_new_key);
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public._intel_phase8_lock_policy_key() from public, anon, authenticated;
drop trigger if exists intel_phase8_suppression_lock on public.intel_suppressions;
create trigger intel_phase8_suppression_lock before insert or update or delete on public.intel_suppressions
for each row execute function public._intel_phase8_lock_policy_key();
drop trigger if exists intel_phase8_contact_permission_lock on public.intel_contact_permissions;
create trigger intel_phase8_contact_permission_lock before insert or update or delete on public.intel_contact_permissions
for each row execute function public._intel_phase8_lock_policy_key();

create or replace function public.intel_agent_mark_sending(p_message_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org uuid := public.intel_agent_org();
  s public.intel_settings;
  m public.intel_messages;
  p public.intel_prospects;
  l public.leads;
  c public.intel_campaigns;
  a public.intel_provider_accounts;
  r public.intel_email_provider_registry;
  v_provider_flag boolean;
  v_purpose text;
  v_today date;
  v_domain text;
  v_used integer;
  v_cap integer;
  v_contactability text;
  v_latest_inbound timestamptz;
  v_now timestamptz := clock_timestamp();
begin
  -- Stable lock order: organization settings -> message -> prospect -> lead -> campaign -> account.
  -- Settings lock serializes organization caps and kill-switch changes with this transition.
  select * into s from public.intel_settings
   where organization_id = v_org for update;
  if not found then return false; end if;

  select * into m from public.intel_messages
   where id = p_message_id and organization_id = v_org for update;
  if not found or m.direction <> 'outbound' or m.state <> 'reserved' then return false; end if;

  -- A reservation is not approval. auto_sent is set on automatically approved drafts;
  -- only the explicit administrator review path clears it.
  if coalesce(m.auto_sent, false) then
    update public.intel_messages
       set state = 'pending_approval', send_day = null, reserved_at = null,
           error = 'Phase 8: explicit human approval required before provider submission'
     where id = m.id and state = 'reserved';
    update public.intel_settings set send_slot_message_id = null, send_slot_until = null
     where organization_id = v_org and send_slot_message_id = m.id;
    return false;
  end if;

  if s.kill_switch then
    update public.intel_messages set state = 'approved', send_day = null, reserved_at = null,
      error = 'emergency stop enabled at final send boundary'
     where id = m.id and state = 'reserved';
    update public.intel_settings set send_slot_message_id = null, send_slot_until = null
     where organization_id = v_org and send_slot_message_id = m.id;
    return false;
  end if;

  if nullif(btrim(m.to_email), '') is null
     or public.intel_norm_email(m.to_email) = ''
     or public.intel_norm_email(m.to_email) !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    update public.intel_messages set state = 'discarded', send_day = null, reserved_at = null,
      error = 'invalid or missing recipient at final send boundary' where id = m.id;
    update public.intel_settings set send_slot_message_id = null, send_slot_until = null
     where organization_id = v_org and send_slot_message_id = m.id;
    return false;
  end if;

  v_domain := split_part(public.intel_norm_email(m.to_email), '@', 2);
  -- Advisory locks serialize this check with every suppression and permission
  -- mutation, including insertions where no row existed to lock beforehand.
  perform pg_advisory_xact_lock(hashtextextended(v_org::text || ':suppression:email:' || public.intel_norm_email(m.to_email), 0));
  perform pg_advisory_xact_lock(hashtextextended(v_org::text || ':suppression:domain:' || v_domain, 0));
  if exists (
    select 1 from public.intel_suppressions x
     where x.organization_id = v_org
       and ((x.kind = 'email' and x.value = public.intel_norm_email(m.to_email))
         or (x.kind = 'domain' and x.value = v_domain))
  ) then
    update public.intel_messages set state = 'discarded', send_day = null, reserved_at = null,
      error = 'recipient is suppressed or unsubscribed' where id = m.id;
    update public.intel_settings set send_slot_message_id = null, send_slot_until = null
     where organization_id = v_org and send_slot_message_id = m.id;
    return false;
  end if;

  v_purpose := case when m.kind in ('initial','followup') then 'consented_prospecting' else 'business_correspondence' end;
  if v_purpose = 'consented_prospecting' then
    perform pg_advisory_xact_lock(hashtextextended(v_org::text || ':permission:' || v_purpose || ':' || public.intel_norm_email(m.to_email), 0));
    perform 1 from public.intel_contact_permissions cp
     where cp.organization_id = v_org
       and cp.email = public.intel_norm_email(m.to_email)
       and cp.purpose = v_purpose and cp.status = 'granted'
       and cp.revoked_at is null and cp.granted_at <= v_now
     order by cp.granted_at desc limit 1 for share;
    if not found then
      update public.intel_messages set state = 'discarded', send_day = null, reserved_at = null,
        error = 'prospecting permission missing or revoked at final send boundary' where id = m.id;
      update public.intel_settings set send_slot_message_id = null, send_slot_until = null
       where organization_id = v_org and send_slot_message_id = m.id;
      return false;
    end if;
  elsif not exists (
    select 1 from public.intel_messages inbound
     where inbound.organization_id = v_org and inbound.direction = 'inbound'
       and public.intel_norm_email(inbound.from_email) = public.intel_norm_email(m.to_email)
  ) then
    update public.intel_messages set state = 'discarded', send_day = null, reserved_at = null,
      error = 'no inbound correspondence context at final send boundary' where id = m.id;
    update public.intel_settings set send_slot_message_id = null, send_slot_until = null
     where organization_id = v_org and send_slot_message_id = m.id;
    return false;
  end if;

  if m.prospect_id is not null then
    select * into p from public.intel_prospects
     where id = m.prospect_id and organization_id = v_org for update;
    if not found then
      update public.intel_messages set state = 'discarded', send_day = null, reserved_at = null,
        error = 'prospect ownership could not be verified at final send boundary' where id = m.id;
      update public.intel_settings set send_slot_message_id = null, send_slot_until = null
       where organization_id = v_org and send_slot_message_id = m.id;
      return false;
    end if;

    if p.status in ('rejected','closed','suppressed','needs_review','discovered','researched')
       or (m.kind in ('initial','followup') and p.status = 'replied') then
      update public.intel_messages set state = 'discarded', send_day = null, reserved_at = null,
        error = 'prospect is no longer eligible at final send boundary' where id = m.id;
      update public.intel_settings set send_slot_message_id = null, send_slot_until = null
       where organization_id = v_org and send_slot_message_id = m.id;
      return false;
    end if;

    -- CRM-origin/manual/taken-over prospects are owned by the CRM workflow, not
    -- the discovery outreach agent. Pending or recorded takeover history also blocks.
    if m.kind in ('initial','followup') and (
         p.origin = 'crm_existing'
         or coalesce(p.origin_detail ->> 'kind','') in ('manual','taken_over')
         or coalesce(p.takeover ->> 'state','') = 'pending'
         or exists (select 1 from public.intel_lead_history h
                     where h.organization_id = v_org and h.prospect_id = p.id)
       ) then
      update public.intel_messages set state = 'discarded', send_day = null, reserved_at = null,
        error = 'CRM ownership or takeover state blocks automated outreach' where id = m.id;
      update public.intel_settings set send_slot_message_id = null, send_slot_until = null
       where organization_id = v_org and send_slot_message_id = m.id;
      return false;
    end if;

    if m.kind = 'initial' and p.status not in ('qualified','lead_linked') then
      update public.intel_messages set state = 'discarded', send_day = null, reserved_at = null,
        error = 'initial outreach requires a qualified prospect' where id = m.id;
      update public.intel_settings set send_slot_message_id = null, send_slot_until = null
       where organization_id = v_org and send_slot_message_id = m.id;
      return false;
    end if;
    if m.kind in ('initial','followup') then
      -- Only current, verified evidence can authorize outreach. Estimated or
      -- stale contactability is never a substitute for exact-address verification.
      v_contactability := coalesce(p.facts #>> '{verified,contactability,status}', 'needs_review');
      if v_contactability <> 'pass' or public.intel_norm_email(p.contact_email) <> public.intel_norm_email(m.to_email) then
        update public.intel_messages set state = 'pending_approval', send_day = null, reserved_at = null,
          error = 'contactability must pass for this exact address before sending' where id = m.id;
        update public.intel_settings set send_slot_message_id = null, send_slot_until = null
         where organization_id = v_org and send_slot_message_id = m.id;
        return false;
      end if;
    end if;
    if m.kind = 'followup' and p.status <> 'contacted' then
      update public.intel_messages set state = 'discarded', send_day = null, reserved_at = null,
        error = 'follow-up requires an already contacted prospect' where id = m.id;
      update public.intel_settings set send_slot_message_id = null, send_slot_until = null
       where organization_id = v_org and send_slot_message_id = m.id;
      return false;
    end if;
  elsif m.kind in ('initial','followup') then
    update public.intel_messages set state = 'discarded', send_day = null, reserved_at = null,
      error = 'prospecting message has no prospect record' where id = m.id;
    update public.intel_settings set send_slot_message_id = null, send_slot_until = null
     where organization_id = v_org and send_slot_message_id = m.id;
    return false;
  end if;

  -- Recheck conversation state after reservation. A newly received reply blocks
  -- initial/follow-up sends; a reply must target the latest inbound turn.
  if m.kind in ('initial','followup') and exists (
    select 1 from public.intel_messages inbound
     where inbound.organization_id = v_org and inbound.direction = 'inbound'
       and ((m.prospect_id is not null and inbound.prospect_id = m.prospect_id)
         or public.intel_norm_email(inbound.from_email) = public.intel_norm_email(m.to_email))
  ) then
    update public.intel_messages set state = 'discarded', send_day = null, reserved_at = null,
      error = 'new inbound reply received before send' where id = m.id;
    update public.intel_settings set send_slot_message_id = null, send_slot_until = null
     where organization_id = v_org and send_slot_message_id = m.id;
    return false;
  elsif m.kind = 'reply' then
    select max(coalesce(inbound.received_at,inbound.created_at)) into v_latest_inbound
      from public.intel_messages inbound
     where inbound.organization_id = v_org and inbound.direction = 'inbound'
       and public.intel_norm_email(inbound.from_email) = public.intel_norm_email(m.to_email)
       and (m.prospect_id is null or inbound.prospect_id = m.prospect_id);
    if v_latest_inbound is null
       or (m.in_reply_to is not null and not exists (
          select 1 from public.intel_messages inbound
           where inbound.organization_id = v_org and inbound.direction = 'inbound'
             and inbound.rfc_message_id = m.in_reply_to
             and public.intel_norm_email(inbound.from_email) = public.intel_norm_email(m.to_email)
       ))
       or exists (
          select 1 from public.intel_messages later
           where later.organization_id = v_org and later.direction = 'outbound'
             and later.prospect_id is not distinct from m.prospect_id
             and later.id <> m.id and later.state in ('sending','sent','unknown')
             and coalesce(later.sent_at,later.reserved_at,later.created_at) > v_latest_inbound
       ) then
      update public.intel_messages set state = 'discarded', send_day = null, reserved_at = null,
        error = 'reply conversation is stale or already answered' where id = m.id;
      update public.intel_settings set send_slot_message_id = null, send_slot_until = null
       where organization_id = v_org and send_slot_message_id = m.id;
      return false;
    end if;
  end if;

  if m.kind in ('initial','followup') then
    select * into c from public.intel_campaigns
     where organization_id = v_org and type = m.campaign_type for update;
    if not found or c.status <> 'active' then
      update public.intel_messages set state = 'approved', send_day = null, reserved_at = null,
        error = 'campaign paused or unavailable at final send boundary' where id = m.id;
      update public.intel_settings set send_slot_message_id = null, send_slot_until = null
       where organization_id = v_org and send_slot_message_id = m.id;
      return false;
    end if;
    if extract(hour from (v_now at time zone s.timezone)) < s.send_start_hour
       or extract(hour from (v_now at time zone s.timezone)) >= s.send_end_hour
       or (s.send_weekdays_only and extract(isodow from (v_now at time zone s.timezone)) > 5) then
      update public.intel_messages set state = 'approved', send_day = null, reserved_at = null,
        error = 'outside send window at final send boundary' where id = m.id;
      update public.intel_settings set send_slot_message_id = null, send_slot_until = null
       where organization_id = v_org and send_slot_message_id = m.id;
      return false;
    end if;
    if btrim(coalesce(s.sender_email,'')) = '' or btrim(coalesce(s.physical_address,'')) = ''
       or btrim(coalesce(s.opt_out_text,'')) = ''
       or position(lower(btrim(s.opt_out_text)) in lower(m.body_text)) = 0
       or position(lower(btrim(s.physical_address)) in lower(m.body_text)) = 0 then
      update public.intel_messages set state = 'pending_approval', send_day = null, reserved_at = null,
        error = 'required compliance footer missing at final send boundary' where id = m.id;
      update public.intel_settings set send_slot_message_id = null, send_slot_until = null
       where organization_id = v_org and send_slot_message_id = m.id;
      return false;
    end if;
  end if;

  -- Lock and revalidate CRM ownership/contact state. Initial mail may only target
  -- an untouched AI-created pool lead; manual CRM records and takeover history fail closed.
  if m.lead_id is not null then
    select * into l from public.leads where id = m.lead_id for update;
    if not found or (p.id is not null and l.intel_prospect_id is distinct from p.id) then
      update public.intel_messages set state = 'discarded', send_day = null, reserved_at = null,
        error = 'CRM lead ownership could not be verified' where id = m.id;
      update public.intel_settings set send_slot_message_id = null, send_slot_until = null
       where organization_id = v_org and send_slot_message_id = m.id;
      return false;
    end if;
    if m.kind = 'initial' and (l.source_kind <> 'ai_intelligence' or l.last_contacted_at is not null
       or l.stage <> 'pool' or coalesce((l.emails -> 0 ->> 'sent')::boolean,false)) then
      update public.intel_messages set state = 'discarded', send_day = null, reserved_at = null,
        error = 'CRM lead is no longer eligible for initial outreach' where id = m.id;
      update public.intel_settings set send_slot_message_id = null, send_slot_until = null
       where organization_id = v_org and send_slot_message_id = m.id;
      return false;
    end if;
    if m.kind in ('initial','followup') and (l.source_kind = 'manual' or (p.id is not null and p.origin = 'crm_existing')) then
      update public.intel_messages set state = 'discarded', send_day = null, reserved_at = null,
        error = 'manual CRM lead ownership blocks Intelligence outreach' where id = m.id;
      update public.intel_settings set send_slot_message_id = null, send_slot_until = null
       where organization_id = v_org and send_slot_message_id = m.id;
      return false;
    end if;
  end if;

  -- Organization and campaign caps are recalculated against current rows, excluding
  -- this reservation, while the settings row remains locked.
  v_today := public._intel_today(v_org);
  if m.send_day is distinct from v_today then
    update public.intel_messages set send_day = v_today where id = m.id;
  end if;
  if m.kind = 'initial' then
    v_cap := public._intel_effective_initial_cap(v_org);
    select count(*) into v_used from public.intel_messages
     where organization_id = v_org and kind = 'initial' and send_day = v_today
       and state in ('reserved','sending','sent','unknown') and id <> m.id;
    if v_used >= v_cap then
      update public.intel_messages set state = 'approved', send_day = null, reserved_at = null, error = 'organization daily cap reached at final send boundary' where id = m.id;
      update public.intel_settings set send_slot_message_id = null, send_slot_until = null where organization_id = v_org and send_slot_message_id = m.id;
      return false;
    end if;
    if not s.allow_cap_shift then
      select count(*) into v_used from public.intel_messages
       where organization_id = v_org and kind = 'initial' and send_day = v_today
         and campaign_type = m.campaign_type and state in ('reserved','sending','sent','unknown') and id <> m.id;
      if v_used >= c.daily_cap then
        update public.intel_messages set state = 'approved', send_day = null, reserved_at = null, error = 'campaign daily cap reached at final send boundary' where id = m.id;
        update public.intel_settings set send_slot_message_id = null, send_slot_until = null where organization_id = v_org and send_slot_message_id = m.id;
        return false;
      end if;
    end if;
  elsif m.kind = 'followup' then
    select count(*) into v_used from public.intel_messages
     where organization_id = v_org and kind = 'followup' and send_day = v_today
       and state in ('reserved','sending','sent','unknown') and id <> m.id;
    if v_used >= s.daily_followup_cap then
      update public.intel_messages set state = 'approved', send_day = null, reserved_at = null, error = 'follow-up daily cap reached at final send boundary' where id = m.id;
      update public.intel_settings set send_slot_message_id = null, send_slot_until = null where organization_id = v_org and send_slot_message_id = m.id;
      return false;
    end if;
    select count(*) into v_used from public.intel_messages
     where prospect_id = m.prospect_id and kind = 'followup'
       and state in ('reserved','sending','sent','unknown') and id <> m.id;
    if v_used >= s.max_followups then
      update public.intel_messages set state = 'discarded', send_day = null, reserved_at = null, error = 'maximum follow-ups reached at final send boundary' where id = m.id;
      update public.intel_settings set send_slot_message_id = null, send_slot_until = null where organization_id = v_org and send_slot_message_id = m.id;
      return false;
    end if;
  end if;

  -- No legacy/unassigned adapter path at the final boundary. The exact selected
  -- account, provider, purpose, registry gates and reserved quota must still agree.
  if m.provider_account_id is null or nullif(m.provider_key,'') is null then
    update public.intel_messages set state = 'approved', send_day = null, reserved_at = null, error = 'provider account assignment missing at final send boundary' where id = m.id;
    update public.intel_settings set send_slot_message_id = null, send_slot_until = null where organization_id = v_org and send_slot_message_id = m.id;
    return false;
  end if;
  select * into a from public.intel_provider_accounts
   where organization_id = v_org and id = m.provider_account_id for update;
  if not found or a.provider_key <> m.provider_key or a.status <> 'connected'
     or not a.is_enabled or not a.send_enabled
     or not (v_purpose = any(a.allowed_message_purposes)) then
    update public.intel_messages set state = 'approved', send_day = null, reserved_at = null,
      error = 'provider account changed before submission' where id = m.id;
    update public.intel_settings set send_slot_message_id = null, send_slot_until = null
     where organization_id = v_org and send_slot_message_id = m.id;
    return false;
  end if;
  select * into r from public.intel_email_provider_registry
   where provider_key = m.provider_key for share;
  if not found or not r.enabled or not r.sending_enabled
     or not (coalesce(r.manifest -> 'message_purposes','[]'::jsonb) ? v_purpose) then
    update public.intel_messages set state = 'approved', send_day = null, reserved_at = null,
      error = 'provider registry capability changed before submission' where id = m.id;
    update public.intel_settings set send_slot_message_id = null, send_slot_until = null
     where organization_id = v_org and send_slot_message_id = m.id;
    return false;
  end if;
  select f.enabled into v_provider_flag from public.email_provider_flags f
   where f.provider = m.provider_key for share;
  if (found and not v_provider_flag) or (not found and not r.sending_enabled) or not public.email_provider_enabled(m.provider_key) then
    update public.intel_messages set state = 'approved', send_day = null, reserved_at = null,
      error = 'provider account or provider gate changed before submission' where id = m.id;
    update public.intel_settings set send_slot_message_id = null, send_slot_until = null
     where organization_id = v_org and send_slot_message_id = m.id;
    return false;
  end if;
  if not exists (select 1 from public.intel_provider_account_usage u
                  where u.organization_id = v_org and u.provider_account_id = a.id and u.message_id = m.id) then
    update public.intel_messages set state = 'approved', send_day = null, reserved_at = null, error = 'provider quota reservation missing' where id = m.id;
    update public.intel_settings set send_slot_message_id = null, send_slot_until = null where organization_id = v_org and send_slot_message_id = m.id;
    return false;
  end if;
  select count(*) into v_used from public.intel_provider_account_usage u
   where u.organization_id = v_org and u.provider_account_id = a.id and u.reserved_at >= v_now - interval '24 hours';
  if a.daily_send_limit is not null and v_used > a.daily_send_limit then
    update public.intel_messages set state = 'approved', send_day = null, reserved_at = null, error = 'provider daily quota changed before submission' where id = m.id;
    update public.intel_settings set send_slot_message_id = null, send_slot_until = null where organization_id = v_org and send_slot_message_id = m.id;
    return false;
  end if;
  select count(*) into v_used from public.intel_provider_account_usage u
   where u.organization_id = v_org and u.provider_account_id = a.id and u.reserved_at >= v_now - interval '1 hour';
  if a.hourly_send_limit is not null and v_used > a.hourly_send_limit then
    update public.intel_messages set state = 'approved', send_day = null, reserved_at = null, error = 'provider hourly quota changed before submission' where id = m.id;
    update public.intel_settings set send_slot_message_id = null, send_slot_until = null where organization_id = v_org and send_slot_message_id = m.id;
    return false;
  end if;
  select count(*) into v_used from public.intel_provider_account_usage u
   where u.organization_id = v_org and u.provider_account_id = a.id and u.reserved_at >= v_now - interval '1 minute';
  if a.minute_send_limit is not null and v_used > a.minute_send_limit then
    update public.intel_messages set state = 'approved', send_day = null, reserved_at = null, error = 'provider minute quota changed before submission' where id = m.id;
    update public.intel_settings set send_slot_message_id = null, send_slot_until = null where organization_id = v_org and send_slot_message_id = m.id;
    return false;
  end if;

  -- Zoho prospecting is covered by the explicit human-approval check above.

  -- Refresh wall-clock time after all row/advisory locks and immediately before
  -- expiry-sensitive validation; the initial timestamp may be stale after waits.
  v_now := clock_timestamp();
  -- The send slot must still belong to this exact message and be unexpired.
  if s.send_slot_message_id is distinct from m.id
     or s.send_slot_until is null or s.send_slot_until <= v_now then
    update public.intel_messages set state = 'approved', send_day = null, reserved_at = null,
      error = 'send slot expired or ownership changed before provider submission' where id = m.id;
    update public.intel_settings set send_slot_message_id = null, send_slot_until = null
     where organization_id = v_org and send_slot_message_id = m.id;
    return false;
  end if;

  update public.intel_messages set state = 'sending', error = null
   where id = m.id and organization_id = v_org and state = 'reserved';
  if not found then return false; end if;
  perform public._intel_log(v_org,'agent','phase8_final_send_approved','message',m.id::text,
    jsonb_build_object('provider_key',m.provider_key,'provider_account_id',m.provider_account_id,'purpose',v_purpose));
  return true;
end;
$$;

revoke all on function public.intel_agent_mark_sending(uuid) from public, anon;
grant execute on function public.intel_agent_mark_sending(uuid) to authenticated;

-- A confirmation is only valid after the final gate transitioned the message to
-- sending, or after it entered unknown and provider evidence reconciled it. A mere
-- reservation can no longer be promoted to sent by bypassing the final boundary.
create or replace function public.intel_agent_confirm_send(
  p_message_id uuid,
  p_zoho_message_id text,
  p_rfc_message_id text,
  p_thread_id text,
  p_sent_at timestamptz default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org uuid := public.intel_agent_org();
  m public.intel_messages;
  v_when timestamptz := coalesce(p_sent_at,now());
  v_emails jsonb;
  v_slot jsonb;
begin
  select * into m from public.intel_messages
   where id = p_message_id and organization_id = v_org for update;
  if not found then raise exception 'message not found'; end if;
  if m.state = 'sent' then
    update public.intel_messages
       set provider_message_id = coalesce(provider_message_id,nullif(p_zoho_message_id,'')),
           zoho_message_id = coalesce(zoho_message_id,nullif(p_zoho_message_id,'')),
           rfc_message_id = coalesce(rfc_message_id,nullif(p_rfc_message_id,'')),
           zoho_thread_id = coalesce(zoho_thread_id,nullif(p_thread_id,''))
     where id = m.id;
    return jsonb_build_object('ok',true,'idempotent',true);
  end if;
  if m.state not in ('sending','unknown') then
    raise exception 'message is % and cannot be confirmed without final send authorization',m.state;
  end if;

  update public.intel_messages
     set state = 'sent', sent_at = v_when,
         provider_message_id = coalesce(provider_message_id,nullif(p_zoho_message_id,'')),
         zoho_message_id = nullif(p_zoho_message_id,''),
         rfc_message_id = nullif(p_rfc_message_id,''),
         zoho_thread_id = nullif(p_thread_id,''), error = null
   where id = m.id;

  if m.kind in ('initial','followup') then
    update public.intel_prospects
       set status = case when status in ('replied','closed') then status else 'contacted' end,
           updated_at = now()
     where id = m.prospect_id;
    if m.lead_id is not null then
      select case when jsonb_typeof(l.emails) = 'array' then l.emails else '[]'::jsonb end
        into v_emails from public.leads l where l.id = m.lead_id for update;
      if found then
        if m.step < 0 or m.step > 100 then raise exception 'message step is outside the supported range'; end if;
        while jsonb_array_length(v_emails) <= m.step loop
          if jsonb_array_length(v_emails) = 0 then
            v_slot := jsonb_build_object('label','Initial Email','message','','sent',false,'dateSent',null);
          else
            v_slot := jsonb_build_object('label','Follow-up ' || jsonb_array_length(v_emails)::text,'message','','sent',false,'dateSent',null);
          end if;
          v_emails := v_emails || jsonb_build_array(v_slot);
        end loop;
        v_slot := coalesce(v_emails -> m.step,'{}'::jsonb)
          || jsonb_build_object('sent',true,'dateSent',to_char(v_when,'YYYY-MM-DD'),'message',m.body_text);
        v_emails := jsonb_set(v_emails,array[m.step::text],v_slot,true);
        update public.leads set emails = v_emails,last_contacted_at = v_when,
          stage = case when m.kind = 'initial' and stage = 'pool' then 'cold_email' else stage end,
          stage_changed_at = case when m.kind = 'initial' and stage = 'pool' then now() else stage_changed_at end
         where id = m.lead_id;
      end if;
    end if;
  end if;
  perform public._intel_log(v_org,'agent','confirm_send','message',m.id::text,jsonb_build_object('kind',m.kind));
  return jsonb_build_object('ok',true);
end;
$$;
revoke all on function public.intel_agent_confirm_send(uuid,text,text,text,timestamptz) from public, anon;
grant execute on function public.intel_agent_confirm_send(uuid,text,text,text,timestamptz) to authenticated;

-- Release a mailbox quota reservation whenever a reserved message is definitively
-- returned to a non-dispatch state before provider submission. A transition from
-- sending/unknown is deliberately excluded because the provider may have accepted it.
create or replace function public._intel_phase8_release_pre_send_quota()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if old.state = 'reserved' and new.state is distinct from old.state
     and new.state in ('approved','pending_approval','discarded','failed') then
    delete from public.intel_provider_account_usage
     where organization_id = old.organization_id and message_id = old.id;
  end if;
  return new;
end;
$$;
revoke all on function public._intel_phase8_release_pre_send_quota() from public, anon, authenticated;
drop trigger if exists intel_phase8_release_pre_send_quota on public.intel_messages;
create trigger intel_phase8_release_pre_send_quota after update of state on public.intel_messages
for each row execute function public._intel_phase8_release_pre_send_quota();

-- Serialize inbound insertion with the final outbound gate on the prospect row.
-- If inbound commits first, the final gate observes it; if final gate owns the lock
-- first, the inbound event is ordered after that final transition.
create or replace function public.intel_agent_record_inbound(
  p_zoho_message_id text, p_rfc_message_id text, p_in_reply_to text, p_references text, p_from_email text,
  p_subject text, p_body_text text, p_received_at timestamptz, p_thread_id text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org uuid := public.intel_agent_org();
  v_from text := public.intel_norm_email(p_from_email);
  v_prospect uuid;
  v_lead uuid;
  v_type text;
  v_id uuid;
  p public.intel_prospects;
begin
  if coalesce(p_zoho_message_id,'') = '' then raise exception 'provider message id required'; end if;
  select id into v_id from public.intel_messages
   where organization_id = v_org and zoho_message_id = p_zoho_message_id;
  if v_id is not null then return jsonb_build_object('message_id',v_id,'duplicate',true); end if;

  if coalesce(p_token,'') <> '' then
    select prospect_id into v_prospect from public.intel_messages
     where organization_id = v_org and token = p_token;
  end if;
  if v_prospect is null then
    select m.prospect_id into v_prospect from public.intel_messages m
     where m.organization_id = v_org and m.direction = 'outbound' and m.rfc_message_id is not null
       and (m.rfc_message_id = p_in_reply_to or position(m.rfc_message_id in coalesce(p_references,'')) > 0)
     limit 1;
  end if;
  if v_prospect is null and v_from <> '' then
    select p0.id into v_prospect from public.intel_prospects p0
     where p0.organization_id = v_org and p0.contact_email = v_from
       and exists (select 1 from public.intel_messages m where m.prospect_id = p0.id and m.direction = 'outbound' and m.state in ('sent','unknown'))
     limit 1;
  end if;
  if v_prospect is not null then
    select * into p from public.intel_prospects
     where id = v_prospect and organization_id = v_org for update;
    if found then v_lead := p.lead_id; v_type := p.type; else v_prospect := null; end if;
  end if;

  insert into public.intel_messages(organization_id,prospect_id,lead_id,campaign_type,direction,kind,state,to_email,from_email,subject,body_text,
                                    idempotency_key,rfc_message_id,in_reply_to,references_ids,zoho_message_id,zoho_thread_id,received_at)
  values(v_org,v_prospect,v_lead,v_type,'inbound','inbound','received','',v_from,left(coalesce(p_subject,''),300),left(coalesce(p_body_text,''),20000),
         'in:' || p_zoho_message_id,nullif(p_rfc_message_id,''),nullif(p_in_reply_to,''),nullif(p_references,''),p_zoho_message_id,nullif(p_thread_id,''),coalesce(p_received_at,now()))
  returning id into v_id;
  return jsonb_build_object('message_id',v_id,'duplicate',false,'prospect_id',v_prospect,'matched',v_prospect is not null);
exception when unique_violation then
  select id into v_id from public.intel_messages where organization_id = v_org
   and (zoho_message_id = p_zoho_message_id or rfc_message_id = nullif(p_rfc_message_id,''));
  return jsonb_build_object('message_id',v_id,'duplicate',true);
end;
$$;
revoke all on function public.intel_agent_record_inbound(text,text,text,text,text,text,text,timestamptz,text,text) from public, anon;
grant execute on function public.intel_agent_record_inbound(text,text,text,text,text,text,text,timestamptz,text,text) to authenticated;

-- Unknown outcomes are terminal for automatic dispatch. Only provider evidence or
-- explicit administrator resolution may move them; this function never resets them.
create or replace function public.intel_agent_mark_unknown(p_message_id uuid, p_error text default '')
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_org uuid := public.intel_agent_org(); m public.intel_messages;
begin
  update public.intel_messages
     set state = 'unknown', error = left(p_error,500)
   where id = p_message_id and organization_id = v_org and state = 'sending'
   returning * into m;
  if found then
    update public.intel_settings set send_slot_message_id = null, send_slot_until = null
     where organization_id = v_org and send_slot_message_id = m.id;
    perform public._intel_notify(v_org,'intel_send_unknown','Email delivery needs checking',
      'An email to ' || m.to_email || ' may or may not have been sent. KairFlow Intelligence will not resend it until verified.',
      m.lead_id,m.prospect_id,m.id,'unknown:' || m.id::text);
  end if;
end;
$$;
revoke all on function public.intel_agent_mark_unknown(uuid,text) from public, anon;
grant execute on function public.intel_agent_mark_unknown(uuid,text) to authenticated;

commit;
