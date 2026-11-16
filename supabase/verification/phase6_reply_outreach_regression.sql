-- Phase 6 database-side regression contract.
-- Run against a staging database AFTER applying
-- 20261231100000_intelligence_phase6_reply_outreach_corrections.sql.
-- Read-only: inspects the actual installed RPC definitions and settings default.
do $$
declare
  v_classify text;
  v_candidates text;
  v_default text;
begin
  v_classify := pg_get_functiondef(
    'public.intel_agent_classify_inbound(uuid,text,numeric,boolean,text,text)'::regprocedure
  );
  v_candidates := pg_get_functiondef(
    'public.intel_agent_followup_candidates(integer)'::regprocedure
  );

  foreach v_default in array array[
    '''not_now''', '''not_interested''', '''already_has_trailer''',
    '''wrong_person''', '''referral''', '''tell_me_more'''
  ] loop
    if position(v_default in v_classify) = 0 then
      raise exception 'Phase 6 reply label missing from installed classify RPC: %', v_default;
    end if;
  end loop;

  if position('p_class in (''unsubscribe'',''complaint'')' in v_classify) = 0 then
    raise exception 'Only unsubscribe and complaint should create permanent reply suppressions';
  end if;
  if position('p_class in (''unsubscribe'',''rejection'')' in v_classify) > 0 then
    raise exception 'Legacy rejection must not create a permanent suppression';
  end if;
  if position('''not_interested''' in v_classify) = 0
     or position('''already_has_trailer''' in v_classify) = 0 then
    raise exception 'Sequence-stopping outcomes missing from the installed classify RPC';
  end if;
  if position('''reserved''' in v_classify) = 0
     or position('prospect replied' in v_classify) = 0 then
    raise exception 'Queued/reserved outbound messages are not discarded after a reply';
  end if;

  if position('coalesce(p.review_reason' in v_candidates) = 0
     or position('Draft is too similar' in v_candidates) = 0
     or position('Re-engagement held:' in v_candidates) = 0 then
    raise exception 'Candidate RPC is missing manual-review/held-draft safeguards';
  end if;
  if position('s.max_followups >= 2' in v_candidates) = 0
     or position('least(3, s.max_followups)' in v_candidates) = 0 then
    raise exception 'Non-Indie three-stage cap or max_followups guard is missing';
  end if;
  if position('interval ''3 months''' in v_candidates) = 0
     or position('interval ''6 months''' in v_candidates) = 0 then
    raise exception 'Indie month 3/month 6 re-engagement stages are missing';
  end if;
  if position('direction = ''inbound''' in v_candidates) = 0 then
    raise exception 'Candidate RPC no longer stops follow-ups after any inbound reply';
  end if;

  select column_default into v_default
    from information_schema.columns
   where table_schema = 'public' and table_name = 'intel_settings'
     and column_name = 'max_followups';
  if coalesce(v_default, '') not like '%3%' then
    raise exception 'max_followups default should remain three for existing non-Indie behavior; got %', v_default;
  end if;
end $$;
