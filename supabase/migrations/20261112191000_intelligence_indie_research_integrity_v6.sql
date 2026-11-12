-- Indie Game Developers V2 / Phase 5 corrective migration.
-- Adds a narrowly-scoped, administrator-reviewed external contact evidence path.
-- All other identity/style evidence remains restricted to official project/developer sources.
begin;

create or replace function public.intel_admin_add_indie_contact_evidence(
  p_prospect_id uuid, p_source_url text, p_snippet text
) returns uuid
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.intel_admin_org();
  p public.intel_prospects;
  v_url text := btrim(coalesce(p_source_url,''));
  v_snippet text := btrim(coalesce(p_snippet,''));
  v_email text;
  v_domain text;
  v_association_name text;
  v_hash text;
  v_id uuid;
begin
  select * into p from public.intel_prospects
   where id=p_prospect_id and organization_id=v_org and type='indie_game_developer' for update;
  if not found then raise exception 'indie prospect not found'; end if;
  if v_url !~ '^https?://' or v_url ~* 'kickstarter\.com' then
    raise exception 'contact evidence must use a public non-Kickstarter HTTP(S) source';
  end if;
  v_domain := public._intel_indie_domain(v_url);
  if v_domain='' or v_domain ~* '^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|0\.)' then
    raise exception 'contact evidence URL must have a public hostname';
  end if;
  if length(v_snippet)<20 or length(v_snippet)>1800 then
    raise exception 'contact evidence description must be between 20 and 1800 characters';
  end if;
  v_email := public.intel_norm_email(substring(v_snippet from '([A-Za-z0-9.!#$%&''*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})'));
  if v_email='' or position(v_email in lower(v_snippet))=0 then
    raise exception 'contact evidence must contain the exact email address';
  end if;
  v_association_name := coalesce(
    nullif(p.facts #>> '{verified,developer_name}',''),
    nullif(p.contact_name,''),
    nullif(p.name,''),
    ''
  );
  if v_association_name='' or position(lower(v_association_name) in lower(v_snippet))=0
     or v_snippet !~* '(developer|founder|owner|director|creator|team|member|studio|independent|representative|producer|lead)' then
    raise exception 'external contact evidence must link the exact email to a named developer or authorized team member';
  end if;
  if p.status='suppressed' or coalesce(p.facts #>> '{verified,suppressed}','false')='true'
     or coalesce(p.facts #>> '{verified,unsubscribed}','false')='true'
     or coalesce(p.facts #>> '{verified,do_not_contact}','false')='true'
     or coalesce(p.facts #>> '{verified,bounced}','false')='true'
     or coalesce(p.facts #>> '{verified,complained}','false')='true'
     or coalesce(p.facts #>> '{verified,complaint}','false')='true' then
    raise exception 'suppressed, bounced, complained or opted-out contact cannot be recorded as eligible';
  end if;
  if exists (select 1 from public.intel_suppressions s where s.organization_id=v_org and
      ((s.kind='email' and s.value=v_email) or
       (s.kind='domain' and (s.value=public._intel_indie_domain(coalesce(nullif(p.domain,''),p.website))
          or v_email like '%@'||s.value or v_email like '%@%.'||s.value)))) then
    raise exception 'suppressed, bounced, complained or opted-out contact cannot be recorded as eligible';
  end if;
  v_hash := md5('contact_email|'||v_url||'|'||v_snippet);
  insert into public.intel_evidence(organization_id,prospect_id,source,url,fact_type,snippet,content_hash,verified)
  values(v_org,p.id,'admin_review',v_url,'contact_email',v_snippet,v_hash,true)
  on conflict (prospect_id,fact_type,content_hash) do update set fetched_at=now()
  returning id into v_id;
  perform public._intel_log(v_org,'admin','add_indie_external_contact_evidence','prospect',p.id::text,
    jsonb_build_object('evidence_id',v_id,'source_url',v_url,'email_domain',split_part(v_email,'@',2)));
  return v_id;
end $$;

create or replace function public.intel_admin_verify_indie_contact(
  p_prospect_id uuid, p_email text, p_evidence_id uuid
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.intel_admin_org();
  p public.intel_prospects;
  e public.intel_evidence;
  v_email text := public.intel_norm_email(p_email);
  v_domain text;
  v_evidence_domain text;
  v_association_name text;
  v_external boolean := false;
  v_verified jsonb;
  v_method text;
begin
  select * into p from public.intel_prospects where id=p_prospect_id and organization_id=v_org and type='indie_game_developer' for update;
  if not found then raise exception 'indie prospect not found'; end if;
  if public._intel_is_protected_indie_entity(p.name,p.project_title) then raise exception 'protected Studio Kairegi account contact cannot be verified'; end if;
  if v_email='' or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'valid exact email address is required'; end if;
  select * into e from public.intel_evidence where id=p_evidence_id and prospect_id=p.id and organization_id=v_org and verified=true and source='admin_review' and fact_type='contact_email';
  if e.id is null or position(v_email in lower(e.snippet))=0 then raise exception 'reviewed contact evidence must contain the exact email address'; end if;
  v_domain := public._intel_indie_domain(coalesce(nullif(p.website,''),p.project_source_url));
  v_evidence_domain := public._intel_indie_domain(e.url);
  if v_domain='' then raise exception 'official developer or project domain is required'; end if;
  if v_evidence_domain<>v_domain then
    v_external := true;
    v_association_name := coalesce(nullif(p.facts #>> '{verified,developer_name}',''),nullif(p.contact_name,''),nullif(p.name,''),'');
    if e.url ~* 'kickstarter\.com' or e.url !~ '^https?://'
       or v_association_name='' or position(lower(v_association_name) in lower(e.snippet))=0
       or e.snippet !~* '(developer|founder|owner|director|creator|team|member|studio|independent|representative|producer|lead)' then
      raise exception 'external evidence must document the exact email and its association with a named developer or authorized team member';
    end if;
  end if;
  if p.status='suppressed' or coalesce(p.facts #>> '{verified,suppressed}','false')='true' or coalesce(p.facts #>> '{verified,unsubscribed}','false')='true' or coalesce(p.facts #>> '{verified,do_not_contact}','false')='true' or coalesce(p.facts #>> '{verified,bounced}','false')='true' or coalesce(p.facts #>> '{verified,complained}','false')='true' or coalesce(p.facts #>> '{verified,complaint}','false')='true' then
    raise exception 'suppressed, bounced, complained or opted-out email cannot be verified';
  end if;
  if exists (select 1 from public.intel_suppressions s where s.organization_id=v_org and
      ((s.kind='email' and s.value=v_email) or (s.kind='domain' and (s.value=public._intel_indie_domain(coalesce(nullif(p.domain,''),p.website)) or v_email like '%@'||s.value or v_email like '%@%.'||s.value)))) then
    raise exception 'suppressed, bounced, complained or opted-out email cannot be verified';
  end if;
  v_method := case when v_external then 'admin_reviewed_external_affiliation' else 'admin_reviewed_official_site' end;
  v_verified := coalesce(p.facts->'verified','{}'::jsonb) || jsonb_build_object(
    'contact_verification','human_confirmed','contact_email',v_email,'contact_source_url',e.url,
    'personal_email_affiliation_evidence',e.snippet,'personal_email_affiliation_source_url',e.url,
    'employee_affiliation_evidence',e.snippet,'employee_affiliation_snippet',e.snippet,
    'employee_affiliation_source_url',e.url,
    'contact_verification_method',v_method,'contact_verified_at',now(),'contact_verified_by',auth.uid());
  update public.intel_prospects set contact_email=v_email,contact_source_url=e.url,
    facts=jsonb_set(facts,'{verified}',v_verified,true),updated_at=now() where id=p.id;
  perform public._intel_log(v_org,'admin','verify_indie_contact','prospect',p.id::text,
    jsonb_build_object('evidence_id',e.id,'source_url',e.url,'verification_method',v_method));
  return jsonb_build_object('ok',true,'contact_email',v_email,'contact_source_url',e.url,'verification','human_confirmed','verification_method',v_method);
end $$;

revoke all on function public.intel_admin_add_indie_contact_evidence(uuid,text,text) from public,anon;
revoke all on function public.intel_admin_verify_indie_contact(uuid,text,uuid) from public,anon;
grant execute on function public.intel_admin_add_indie_contact_evidence(uuid,text,text) to authenticated;
grant execute on function public.intel_admin_verify_indie_contact(uuid,text,uuid) to authenticated;

commit;
