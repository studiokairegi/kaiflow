-- Indie Game Developers V2 / Phase 5: evidence-backed identity, visual review and contact verification.
-- No automated Kickstarter access. Admin attestations must cite exact, already-reviewed evidence rows.
begin;

create or replace function public.intel_admin_add_indie_evidence(
  p_prospect_id uuid, p_fact_type text, p_source_url text, p_snippet text,
  p_event_date date default null, p_media_url text default ''
) returns uuid
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.intel_admin_org();
  p public.intel_prospects;
  v_id uuid;
  v_type text := lower(btrim(coalesce(p_fact_type,'')));
  v_url text := btrim(coalesce(p_source_url,''));
  v_media text := btrim(coalesce(p_media_url,''));
  v_hash text;
  v_verified jsonb;
  v_milestones jsonb;
  v_allowed text[] := array[
    'developer_identity','project_identity','contact_email','anime_style_description','official_anime_style_description',
    'anime_visual_screenshot','anime_visual_artwork','anime_visual_trailer','anime_character_art',
    'devlog','development_log','development_update','developer_progress_update','project_update',
    'demo_update','playtest_update','build_update','patch_update','project_announcement',
    'marketing_opportunity','dlc_announcement','major_update_announcement','relaunch_announcement','console_release_announcement'
  ];
  v_date_types text[] := array['devlog','development_log','development_update','developer_progress_update','project_update',
    'demo_update','playtest_update','build_update','patch_update','project_announcement','marketing_opportunity',
    'dlc_announcement','major_update_announcement','relaunch_announcement','console_release_announcement'];
  v_domain text;
begin
  select * into p from public.intel_prospects where id=p_prospect_id and organization_id=v_org and type='indie_game_developer' for update;
  if not found then raise exception 'indie prospect not found'; end if;
  if v_type <> all(v_allowed) then raise exception 'unsupported Indie evidence type'; end if;
  if v_url !~ '^https?://' or v_url ~* 'kickstarter\.com' then raise exception 'evidence must come from a reviewed non-Kickstarter HTTP(S) source'; end if;
  if length(btrim(coalesce(p_snippet,''))) < 20 or length(p_snippet) > 1800 then raise exception 'evidence description must be between 20 and 1800 characters'; end if;
  v_domain := public._intel_indie_domain(v_url);
  if v_domain = '' or not (
    (p.website <> '' and v_domain = public._intel_indie_domain(p.website))
    or (p.project_source_url <> '' and p.project_source_url !~* 'kickstarter\.com' and v_domain = public._intel_indie_domain(p.project_source_url))
  ) then raise exception 'evidence URL must match the prospect official website or non-Kickstarter project source'; end if;
  if v_type = any(v_date_types) and p_event_date is null then raise exception 'dated evidence requires an explicit event date'; end if;
  if v_type in ('devlog','development_log','development_update','developer_progress_update','project_update','demo_update','playtest_update','build_update','patch_update','project_announcement') and p_event_date > current_date then
    raise exception 'activity and announcement dates cannot be in the future';
  end if;
  if v_type in ('anime_visual_screenshot','anime_visual_artwork','anime_visual_trailer','anime_character_art') then
    if v_media !~ '^https?://' or v_media ~* 'kickstarter\.com' then raise exception 'visual review requires an HTTP(S) media URL'; end if;
  end if;
  if v_type in ('anime_style_description','official_anime_style_description') and p_snippet !~* '(anime|manga).{0,80}(style|inspired|art|visual|aesthetic|character)|(style|art|visual|aesthetic|character).{0,80}(anime|manga)' then
    raise exception 'style evidence must explicitly describe anime/manga visual style';
  end if;
  if v_type='developer_identity' and p_snippet !~* '[[:alnum:]]' then raise exception 'developer identity evidence is required'; end if;
  v_hash := md5(v_type || '|' || v_url || '|' || coalesce(p_snippet,'') || '|' || coalesce(p_event_date::text,'') || '|' || v_media);
  insert into public.intel_evidence(organization_id,prospect_id,source,url,fact_type,snippet,content_hash,verified)
  values(v_org,p.id,'admin_review',v_url,v_type,
    left(btrim(p_snippet) || case when v_media<>'' then ' | reviewed media: '||v_media else '' end,2000),v_hash,true)
  on conflict (prospect_id,fact_type,content_hash) do update set fetched_at=now()
  returning id into v_id;

  v_verified := coalesce(p.facts->'verified','{}'::jsonb);
  if v_type in ('devlog','development_log','development_update','developer_progress_update','project_update','demo_update','playtest_update','build_update','patch_update') then
    if p.project_latest_activity_date is null or p_event_date > p.project_latest_activity_date then
      v_verified := jsonb_set(v_verified,'{project_latest_activity_date}',to_jsonb(p_event_date::text),true);
      update public.intel_prospects set project_latest_activity_date=p_event_date where id=p.id;
    end if;
  elsif v_type='project_announcement' then
    if p.project_announcement_date is null or p_event_date < p.project_announcement_date then
      v_verified := jsonb_set(v_verified,'{project_announcement_date}',to_jsonb(p_event_date::text),true);
      update public.intel_prospects set project_announcement_date=p_event_date where id=p.id;
    end if;
  elsif v_type in ('marketing_opportunity','dlc_announcement','major_update_announcement','relaunch_announcement','console_release_announcement') then
    v_milestones := coalesce(p.facts #> '{verified,project_marketing_milestones}',p.project_marketing_milestones,'[]'::jsonb);
    if not exists (select 1 from jsonb_array_elements(v_milestones) m where m->>'date'=p_event_date::text and m->>'source_url'=v_url and m->>'kind'=v_type) then
      v_milestones := v_milestones || jsonb_build_array(jsonb_build_object(
        'date',p_event_date::text,'source_url',v_url,'kind',v_type,'verified',true,'evidence_id',v_id::text));
    end if;
    v_verified := jsonb_set(v_verified,'{project_marketing_milestones}',v_milestones,true);
    update public.intel_prospects set project_marketing_milestones=v_milestones where id=p.id;
  end if;
  update public.intel_prospects set facts=jsonb_set(facts,'{verified}',v_verified,true),updated_at=now() where id=p.id;
  perform public._intel_log(v_org,'admin','add_indie_evidence','prospect',p.id::text,jsonb_build_object('fact_type',v_type,'evidence_id',v_id,'source_url',v_url));
  return v_id;
end $$;

create or replace function public.intel_admin_verify_indie_identity(
  p_prospect_id uuid, p_developer_name text, p_developer_evidence_id uuid, p_project_evidence_id uuid,
  p_creator_role text default 'unknown'
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.intel_admin_org();
  p public.intel_prospects;
  d public.intel_evidence;
  g public.intel_evidence;
  v_name text := left(btrim(coalesce(p_developer_name,'')),160);
  v_domain text;
  v_verified jsonb;
  v_title text;
  v_role text := lower(btrim(coalesce(p_creator_role,'unknown')));
begin
  select * into p from public.intel_prospects where id=p_prospect_id and organization_id=v_org and type='indie_game_developer' for update;
  if not found then raise exception 'indie prospect not found'; end if;
  v_title := coalesce(nullif(p.project_title,''),p.facts #>> '{verified,project_title}',p.facts #>> '{verified,game}','');
  if v_name='' or length(v_name)<2 then raise exception 'verified developer/studio name is required'; end if;
  if public._intel_is_protected_indie_entity(v_name,v_title) then raise exception 'protected Studio Kairegi account cannot be verified or promoted'; end if;
  if p.website='' then raise exception 'an official developer website is required for identity verification'; end if;
  if v_role not in ('developer','studio_representative','publisher','organizer','unknown') then raise exception 'invalid creator role'; end if;
  if v_role<>'unknown' and coalesce(p.facts #>> '{verified,source_key}',p.facts #>> '{verified,source}')<>'kickstarter_manual' then
    raise exception 'creator role is only recorded for Kickstarter manual imports';
  end if;
  select * into d from public.intel_evidence where id=p_developer_evidence_id and prospect_id=p.id and organization_id=v_org and verified=true and source='admin_review' and fact_type='developer_identity';
  select * into g from public.intel_evidence where id=p_project_evidence_id and prospect_id=p.id and organization_id=v_org and verified=true and source='admin_review' and fact_type='project_identity';
  if d.id is null or g.id is null then raise exception 'identity verification requires separately reviewed developer and project evidence'; end if;
  v_domain := public._intel_indie_domain(p.website);
  if v_domain='' or public._intel_indie_domain(d.url)<>v_domain or public._intel_indie_domain(g.url)<>v_domain then
    raise exception 'identity evidence must be on the prospect official developer website';
  end if;
  if position(lower(v_name) in lower(d.snippet))=0 then raise exception 'developer evidence must contain the exact verified developer/studio name'; end if;
  if v_title='' or position(lower(v_title) in lower(g.snippet))=0 then raise exception 'project evidence must contain the exact project title'; end if;
  v_verified := coalesce(p.facts->'verified','{}'::jsonb) || jsonb_build_object(
    'developer_name',v_name,'developer_identity_status','independently_verified',
    'developer_identity_source_url',d.url,'developer_identity_evidence_ids',jsonb_build_array(d.id::text,g.id::text),
    'developer_identity_verified_at',now(),'developer_identity_verified_by',auth.uid(),
    'developer_identity_verification_method','admin_reviewed_official_site_evidence');
  if v_role<>'unknown' then
    v_verified := v_verified || jsonb_build_object('kickstarter_creator_role',v_role,'kickstarter_creator_role_verified',true);
  end if;
  update public.intel_prospects set name=v_name,facts=jsonb_set(facts,'{verified}',v_verified,true),updated_at=now() where id=p.id;
  perform public._intel_log(v_org,'admin','verify_indie_identity','prospect',p.id::text,jsonb_build_object('developer_name',v_name,'developer_evidence_id',d.id,'project_evidence_id',g.id,'creator_role',v_role));
  return jsonb_build_object('ok',true,'developer_identity_status','independently_verified','developer_name',v_name);
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
  v_verified jsonb;
begin
  select * into p from public.intel_prospects where id=p_prospect_id and organization_id=v_org and type='indie_game_developer' for update;
  if not found then raise exception 'indie prospect not found'; end if;
  if public._intel_is_protected_indie_entity(p.name,p.project_title) then raise exception 'protected Studio Kairegi account contact cannot be verified'; end if;
  if v_email='' or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'valid exact email address is required'; end if;
  select * into e from public.intel_evidence where id=p_evidence_id and prospect_id=p.id and organization_id=v_org and verified=true and source='admin_review' and fact_type='contact_email';
  if e.id is null or position(v_email in lower(e.snippet))=0 then raise exception 'reviewed contact evidence must contain the exact email address'; end if;
  v_domain := public._intel_indie_domain(p.website);
  if v_domain='' or public._intel_indie_domain(e.url)<>v_domain then raise exception 'contact email must be documented on the official developer website'; end if;
  if p.status='suppressed' or coalesce(p.facts #>> '{verified,suppressed}','false')='true' or coalesce(p.facts #>> '{verified,unsubscribed}','false')='true' or coalesce(p.facts #>> '{verified,do_not_contact}','false')='true' or coalesce(p.facts #>> '{verified,bounced}','false')='true' or coalesce(p.facts #>> '{verified,complained}','false')='true' or coalesce(p.facts #>> '{verified,complaint}','false')='true' then
    raise exception 'suppressed, bounced, complained or opted-out email cannot be verified';
  end if;
  if exists (select 1 from public.intel_suppressions s where s.organization_id=v_org and
      ((s.kind='email' and s.value=v_email) or (s.kind='domain' and (s.value=public._intel_indie_domain(coalesce(nullif(p.domain,''),p.website)) or v_email like '%@'||s.value or v_email like '%@%.'||s.value)))) then
    raise exception 'suppressed, bounced, complained or opted-out email cannot be verified';
  end if;
  v_verified := coalesce(p.facts->'verified','{}'::jsonb) || jsonb_build_object(
    'contact_verification','human_confirmed','contact_email',v_email,'contact_source_url',e.url,
    'personal_email_affiliation_evidence',e.snippet,'personal_email_affiliation_source_url',e.url,
    'contact_verification_method','admin_reviewed_official_site','contact_verified_at',now(),'contact_verified_by',auth.uid());
  update public.intel_prospects set contact_email=v_email,contact_source_url=e.url,
    facts=jsonb_set(facts,'{verified}',v_verified,true),updated_at=now() where id=p.id;
  perform public._intel_log(v_org,'admin','verify_indie_contact','prospect',p.id::text,jsonb_build_object('evidence_id',e.id,'source_url',e.url));
  return jsonb_build_object('ok',true,'contact_email',v_email,'contact_source_url',e.url,'verification','human_confirmed');
end $$;

revoke all on function public.intel_admin_add_indie_evidence(uuid,text,text,text,date,text) from public,anon;
revoke all on function public.intel_admin_verify_indie_identity(uuid,text,uuid,uuid,text) from public,anon;
revoke all on function public.intel_admin_verify_indie_contact(uuid,text,uuid) from public,anon;
grant execute on function public.intel_admin_add_indie_evidence(uuid,text,text,text,date,text) to authenticated;
grant execute on function public.intel_admin_verify_indie_identity(uuid,text,uuid,uuid,text) to authenticated;
grant execute on function public.intel_admin_verify_indie_contact(uuid,text,uuid) to authenticated;

commit;
