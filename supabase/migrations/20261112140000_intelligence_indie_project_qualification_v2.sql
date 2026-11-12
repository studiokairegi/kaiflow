-- Indie Game Developers V2: project-first qualification, date facts, and database gates.
-- Additive schema changes plus Indie-only guards; preserves Studio scoring and provider-neutral email architecture.
begin;

-- Keep this migration independent of shared-domain helpers introduced by later migrations.
create or replace function public._intel_indie_domain(p_value text)
returns text language sql immutable set search_path = pg_catalog as $$
  select regexp_replace(
    split_part(split_part(regexp_replace(lower(btrim(coalesce(p_value, ''))), '^https?://', ''), '/', 1), ':', 1),
    '^www\.', '')
$$;

alter table public.intel_prospects
  add column if not exists project_title text not null default '',
  add column if not exists project_source_url text not null default '',
  add column if not exists project_announcement_date date,
  add column if not exists project_campaign_date date,
  add column if not exists project_expected_release_date date,
  add column if not exists project_actual_release_date date,
  add column if not exists project_latest_activity_date date,
  add column if not exists project_marketing_milestones jsonb not null default '[]'::jsonb;

create or replace function public._intel_try_project_date(p_value text)
returns date language plpgsql immutable set search_path = pg_catalog as $$
begin
  if p_value is null or btrim(p_value) = '' then return null; end if;
  if btrim(p_value) ~ '^[0-9]{4}$' then
    begin return make_date(btrim(p_value)::integer, 7, 1); exception when others then return null; end;
  end if;
  begin return btrim(p_value)::date; exception when others then null; end;
  begin return left(btrim(p_value), 10)::date; exception when others then null; end;
  begin return to_date(btrim(p_value), 'YYYY-MM'); exception when others then null; end;
  begin return to_date(btrim(p_value), 'Mon YYYY'); exception when others then null; end;
  begin return to_date(btrim(p_value), 'Month YYYY'); exception when others then null; end;
  begin return to_date(btrim(p_value), 'Mon DD, YYYY'); exception when others then null; end;
  return null;
end $$;

create or replace function public._intel_is_protected_indie_entity(p_developer text, p_project text)
returns boolean language sql immutable set search_path = pg_catalog as $$
  select regexp_replace(lower(coalesce(p_developer, '')), '[^a-z0-9]', '', 'g') = any(array['brainjargames','brainjargamesllc','brainjargamesinc','silverlineinteractive','silverlineinteractiveinc','silverlineinteractivellc','thermitegames','thermitegamesllc','thermitegamesinc','lieofcaelumspirit'])
      or regexp_replace(lower(coalesce(p_project, '')), '[^a-z0-9]', '', 'g') = any(array['brainjargames','brainjargamesllc','brainjargamesinc','silverlineinteractive','silverlineinteractiveinc','silverlineinteractivellc','thermitegames','thermitegamesllc','thermitegamesinc','lieofcaelumspirit']);
$$;

create or replace function public._intel_sync_project_facts()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare v jsonb := coalesce(new.facts -> 'verified', '{}'::jsonb); v_coming boolean; v_project_url text;
begin
  if new.type <> 'indie_game_developer' then return new; end if;
  new.project_title := coalesce(nullif(v ->> 'project_title', ''), nullif(v ->> 'game', ''), new.project_title);
  new.project_source_url := coalesce(nullif(v ->> 'project_url', ''), nullif(v ->> 'game_url', ''),
    case when coalesce(v ->> 'steam_appid', '') ~ '^[0-9]+$' then 'https://store.steampowered.com/app/' || (v ->> 'steam_appid') || '/' else null end, new.project_source_url);
  if btrim(new.project_source_url) <> '' and new.project_source_url !~* '^https?://' then
    new.project_source_url := 'https://' || btrim(new.project_source_url);
  end if;
  if (btrim(new.project_source_url) = '' or new.project_source_url !~* '^https?://[^/[:space:]]*\.[^/[:space:]]+')
     and coalesce(v ->> 'steam_appid', '') ~ '^[0-9]+$' then
    new.project_source_url := 'https://store.steampowered.com/app/' || (v ->> 'steam_appid') || '/';
  end if;
  if btrim(new.project_source_url) = '' or new.project_source_url !~* '^https?://[^/[:space:]]*\.[^/[:space:]]+' then
    select e.url into v_project_url from public.intel_evidence e
     where e.prospect_id = new.id and e.verified and e.url ~* '^https?://[^/[:space:]]*\.[^/[:space:]]+' and coalesce(e.snippet, '') <> ''
       and (e.fact_type in ('game_store_page','steam_project','itch_project','kickstarter_project')
         or (e.fact_type in ('project_identity','project_description') and (public._intel_indie_domain(e.url) = public._intel_indie_domain(new.website)
           or public._intel_indie_domain(e.url) = public._intel_indie_domain(new.project_source_url))))
     order by e.fetched_at desc limit 1;
    new.project_source_url := coalesce(v_project_url, new.project_source_url);
  end if;
  new.project_announcement_date := coalesce(public._intel_try_project_date(v ->> 'project_announcement_date'), public._intel_try_project_date(v ->> 'announcement_date'), new.project_announcement_date);
  new.project_campaign_date := coalesce(public._intel_try_project_date(v ->> 'project_campaign_date'), public._intel_try_project_date(v ->> 'campaign_date'), new.project_campaign_date);
  v_coming := (v ->> 'coming_soon') = 'true';
  new.project_expected_release_date := coalesce(public._intel_try_project_date(v ->> 'project_expected_release_date'), public._intel_try_project_date(v ->> 'expected_release_date'), new.project_expected_release_date,
    case when v_coming then public._intel_try_project_date(v ->> 'release_date') else null end);
  new.project_actual_release_date := coalesce(public._intel_try_project_date(v ->> 'project_actual_release_date'), public._intel_try_project_date(v ->> 'actual_release_date'), new.project_actual_release_date,
    case when (v ->> 'coming_soon') = 'false' then public._intel_try_project_date(v ->> 'release_date') else null end);
  new.project_latest_activity_date := coalesce(public._intel_try_project_date(v ->> 'project_latest_activity_date'), public._intel_try_project_date(v ->> 'latest_activity_date'), new.project_latest_activity_date);
  if jsonb_typeof(v -> 'project_marketing_milestones') = 'array' then
    new.project_marketing_milestones := v -> 'project_marketing_milestones';
  elsif jsonb_typeof(v -> 'marketing_milestones') = 'array' then
    new.project_marketing_milestones := v -> 'marketing_milestones';
  end if;
  if exists (select 1 from public.intel_suppressions x where x.organization_id = new.organization_id
      and ((x.kind = 'email' and x.value = public.intel_norm_email(new.contact_email) and public.intel_norm_email(new.contact_email) <> '')
        or (x.kind = 'domain' and (x.value = public._intel_indie_domain(new.domain)
          or public.intel_norm_email(new.contact_email) like '%@' || x.value)))) then
    new.status := 'suppressed';
    new.review_reason := 'Existing email/domain suppression conflict';
  end if;
  if public._intel_is_protected_indie_entity(new.name, coalesce(nullif(new.project_title, ''), v ->> 'project_title', v ->> 'game')) then
    new.status := 'rejected';
    new.review_reason := 'Protected Studio Kairegi account';
  end if;
  return new;
end $$;

drop trigger if exists intel_sync_project_facts on public.intel_prospects;
drop trigger if exists intel_00_sync_project_facts on public.intel_prospects;
create trigger intel_00_sync_project_facts
before insert or update of facts on public.intel_prospects
for each row execute function public._intel_sync_project_facts();

-- Populate typed project fields before installing the status guard. This backfill
-- reads only explicit verified source facts; it never derives announcement/activity
-- dates from prospect discovery or row creation timestamps.
update public.intel_prospects set facts = facts where type = 'indie_game_developer';

create or replace function public._intel_enforce_indie_qualification_status()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_gates jsonb;
  v_gate text;
  v_required text[] := array['project_identity','active_or_marketing_opportunity','anime_visual_identity','verified_usable_email','suppression_clear','protected_account_clear','sufficient_evidence'];
  v_email text;
  v_project_url text;
begin
  if new.type <> 'indie_game_developer' or new.status <> 'qualified' then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'suppressed' then
    raise exception 'suppressed indie prospect cannot be requalified';
  end if;
  v_gates := new.facts #> '{estimates,qualification_v2,mandatory_gates}';
  v_email := public.intel_norm_email(new.contact_email);
  if new.score is null or new.score < 75 then raise exception 'indie V2 prospect cannot be qualified below 75 points'; end if;
  if coalesce(new.facts #>> '{estimates,qualification_v2,model}', '') <> 'indie-project-v2' then
    raise exception 'indie V2 qualification model version is required';
  end if;
  if v_gates is null then raise exception 'indie V2 mandatory qualification gates are required'; end if;
  foreach v_gate in array v_required loop
    if coalesce(v_gates -> v_gate ->> 'passed', 'false') <> 'true' then
      raise exception 'indie V2 mandatory gate failed: %', v_gate;
    end if;
  end loop;
  if coalesce(new.facts #>> '{verified,contactability,status}', '') <> 'pass'
     or coalesce(new.facts #>> '{verified,bounced}', 'false') = 'true'
     or coalesce(new.facts #>> '{verified,complained}', 'false') = 'true'
     or coalesce(new.facts #>> '{verified,complaint}', 'false') = 'true'
     or coalesce(new.facts #>> '{verified,unsubscribed}', 'false') = 'true'
     or coalesce(new.facts #>> '{verified,do_not_contact}', 'false') = 'true'
     or coalesce(new.facts #>> '{verified,suppressed}', 'false') = 'true'
     or v_email = ''
     or public.intel_norm_email(new.facts #>> '{verified,contactability,verified_email}') <> v_email
     or coalesce(new.facts #>> '{verified,contactability,evidence,source_url}', '') !~* '^https?://[^/[:space:]]*\.[^/[:space:]]+' then
    raise exception 'indie V2 verified contactability must pass for the exact sourced email';
  end if;
  if btrim(new.project_source_url) <> '' and new.project_source_url !~* '^https?://' then
    new.project_source_url := 'https://' || btrim(new.project_source_url);
  end if;
  if (btrim(new.project_source_url) = '' or new.project_source_url !~* '^https?://[^/[:space:]]*\.[^/[:space:]]+')
     and coalesce(new.facts #>> '{verified,steam_appid}', '') ~ '^[0-9]+$' then
    new.project_source_url := 'https://store.steampowered.com/app/' || (new.facts #>> '{verified,steam_appid}') || '/';
  end if;
  if btrim(new.project_source_url) = '' or new.project_source_url !~* '^https?://[^/[:space:]]*\.[^/[:space:]]+' then
    select e.url into v_project_url from public.intel_evidence e
     where e.prospect_id = new.id and e.verified and e.url ~* '^https?://[^/[:space:]]*\.[^/[:space:]]+' and coalesce(e.snippet, '') <> ''
       and (e.fact_type in ('game_store_page','steam_project','itch_project','kickstarter_project')
         or (e.fact_type in ('project_identity','project_description') and (public._intel_indie_domain(e.url) = public._intel_indie_domain(new.website)
           or public._intel_indie_domain(e.url) = public._intel_indie_domain(new.project_source_url))))
     order by e.fetched_at desc limit 1;
    new.project_source_url := coalesce(v_project_url, new.project_source_url);
  end if;
  if btrim(new.project_title) = '' or regexp_replace(lower(btrim(new.project_title)), '[^a-z0-9]', '', 'g') in ('unknown','unknowngame','tbd','na','notavailable','unannounced')
     or btrim(new.name) = '' or regexp_replace(lower(btrim(new.name)), '[^a-z0-9]', '', 'g') in ('unknown','unknowndeveloper','tbd','na','notavailable','anonymous')
     or new.project_source_url !~* '^https?://[^/[:space:]]*\.[^/[:space:]]+' then
    raise exception 'indie V2 project identity must include an identifiable developer, title and HTTP(S) project source';
  end if;
  if not exists (select 1 from public.intel_evidence e where e.prospect_id = new.id and e.verified and e.url ~* '^https?://[^/[:space:]]*\.[^/[:space:]]+' and coalesce(e.snippet, '') <> ''
      and e.fact_type in ('anime_visual_evidence','anime_visual_screenshot','anime_visual_artwork','anime_visual_trailer','anime_character_art','official_anime_visuals_verified'))
     and not exists (select 1 from public.intel_evidence e where e.prospect_id = new.id and e.verified and e.url ~* '^https?://[^/[:space:]]*\.[^/[:space:]]+' and coalesce(e.snippet, '') <> ''
       and e.fact_type in ('anime_style_description','official_anime_style_description','official_visual_style')
       and (public._intel_indie_domain(e.url) = public._intel_indie_domain(new.website) or public._intel_indie_domain(e.url) = public._intel_indie_domain(new.project_source_url))
       and coalesce(e.snippet, '') ~* '(anime|manga).{0,60}(style|inspired|art|visuals?|aesthetics?|character design|illustration)|(style|art|visuals?|aesthetics?).{0,60}(anime|manga)')) then
    raise exception 'indie V2 requires verified anime-compatible visual or explicit official style evidence';
  end if;
  if not (
      (new.project_actual_release_date is null and new.project_latest_activity_date is not null and new.project_latest_activity_date between current_date - 365 and current_date and exists (
        select 1 from public.intel_evidence e where e.prospect_id = new.id and e.verified and e.url ~* '^https?://[^/[:space:]]*\.[^/[:space:]]+' and coalesce(e.snippet, '') <> ''
          and e.fact_type in ('devlog','development_log','itch_devlog','steam_devlog','kickstarter_development_update','developer_progress_update','development_update','project_update','demo_update','playtest_update','build_update','patch_update')))
      or (new.project_actual_release_date is null and new.project_expected_release_date is not null and new.project_expected_release_date between current_date and current_date + 365)
      or (new.project_actual_release_date is null and coalesce(new.facts #>> '{verified,coming_soon}', 'false') = 'true'
          and (new.project_expected_release_date is null or new.project_expected_release_date between current_date and current_date + 365))
      or (new.project_actual_release_date is null and new.project_announcement_date between current_date - 240 and current_date - 120
          and (new.project_expected_release_date is null or new.project_expected_release_date >= current_date))
      or (new.project_campaign_date is not null and new.project_campaign_date between current_date - 30 and current_date + 365)
      or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(new.project_marketing_milestones) = 'array' then new.project_marketing_milestones else '[]'::jsonb end) as milestone(value)
        where milestone.value ->> 'verified' = 'true'
          and coalesce(milestone.value ->> 'source_url', milestone.value ->> 'url', '') <> ''
          and public._intel_try_project_date(coalesce(milestone.value ->> 'date', milestone.value ->> 'start_date', milestone.value ->> 'campaign_date')) between current_date - 30 and current_date + 365
          and exists (select 1 from public.intel_evidence e where e.prospect_id = new.id and e.verified
            and e.url ~* '^https?://[^/[:space:]]*\.[^/[:space:]]+' and coalesce(e.snippet, '') <> ''
            and e.fact_type in ('dlc_announcement','major_update_announcement','relaunch_announcement','console_release_announcement','marketing_campaign','marketing_opportunity')
            and rtrim(e.url, '/') = rtrim(coalesce(milestone.value ->> 'source_url', milestone.value ->> 'url'), '/')))
      or (new.project_actual_release_date is null and exists (select 1 from public.intel_evidence e where e.prospect_id = new.id and e.verified and e.url ~* '^https?://[^/[:space:]]*\.[^/[:space:]]+' and coalesce(e.snippet, '') <> ''
          and e.fact_type in ('dlc_announcement','major_update_announcement','relaunch_announcement','console_release_announcement','marketing_campaign','marketing_opportunity')
          and e.snippet ~* '(upcoming|coming soon|launch(es|ed)?|pre.?orders?|wishlists?|demos?|early access|campaigns?|DLC|major updates?|console releases?|relaunch(es|ed)?|expansions?)'))
    ) then
    raise exception 'indie V2 requires dated activity or a credible marketing opportunity';
  end if;
  if (select count(distinct e.fact_type) from public.intel_evidence e where e.prospect_id = new.id and e.verified and e.url ~* '^https?://[^/[:space:]]*\.[^/[:space:]]+' and coalesce(e.snippet, '') <> '') < 2 then
    raise exception 'indie V2 requires at least two distinct verified evidence types';
  end if;
  if public._intel_is_protected_indie_entity(new.name, coalesce(nullif(new.project_title, ''), new.facts #>> '{verified,project_title}', new.facts #>> '{verified,game}')) then
    raise exception 'protected Studio Kairegi account cannot be qualified';
  end if;
  if exists (select 1 from public.intel_suppressions x where x.organization_id = new.organization_id and
    ((x.kind = 'email' and x.value = v_email and v_email <> '') or (x.kind = 'domain' and (x.value = public._intel_indie_domain(new.domain) or v_email like '%@' || x.value)))) then
    raise exception 'indie V2 prospect has an active email or domain suppression';
  end if;
  return new;
end $$;

drop trigger if exists intel_enforce_indie_qualification_status on public.intel_prospects;
create trigger intel_enforce_indie_qualification_status
before insert or update on public.intel_prospects
for each row execute function public._intel_enforce_indie_qualification_status();

create or replace function public._intel_block_protected_indie_outbound()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_prospect public.intel_prospects;
  v_email text;
  v_lead_name text;
  v_gates jsonb;
  v_send_transition boolean := false;
begin
  if new.direction <> 'outbound' then return new; end if;
  if tg_op = 'INSERT' then
    v_send_transition := new.state in ('reserved','sending');
  else
    v_send_transition := new.state in ('reserved','sending') and old.state is distinct from new.state;
  end if;
  if not v_send_transition then return new; end if;

  if new.prospect_id is not null then
    select * into v_prospect from public.intel_prospects
     where id = new.prospect_id and organization_id = new.organization_id;
  elsif new.lead_id is not null then
    select * into v_prospect from public.intel_prospects
     where lead_id = new.lead_id and organization_id = new.organization_id and type = 'indie_game_developer'
     order by created_at desc limit 1;
  end if;
  if v_prospect.id is not null and new.campaign_type = 'indie_game_developer' and v_prospect.type <> 'indie_game_developer' then
    raise exception 'indie campaign message must reference an indie prospect';
  end if;
  if v_prospect.id is null and new.campaign_type = 'indie_game_developer' then
    if new.kind = 'reply' and new.lead_id is null then
      raise exception 'indie reply must be linked to an existing prospect or lead';
    end if;
    if new.lead_id is not null then
      select l.company_name into v_lead_name from public.leads l where l.id = new.lead_id;
    end if;
    if public._intel_is_protected_indie_entity(coalesce(v_lead_name, ''), '') then
      raise exception 'outbound contact to protected Studio Kairegi account is blocked';
    end if;
    v_email := public.intel_norm_email(new.to_email);
    if exists (select 1 from public.intel_suppressions x where x.organization_id = new.organization_id
      and ((x.kind = 'email' and x.value = v_email and v_email <> '')
        or (x.kind = 'domain' and (x.value = public._intel_indie_domain(split_part(v_email, '@', 2)) or v_email like '%@' || x.value)))) then
      raise exception 'outbound contact to suppressed indie developer is blocked';
    end if;
    if new.kind <> 'reply' then
      raise exception 'outbound indie prospecting requires a linked and qualified project';
    end if;
  end if;

  if v_prospect.id is not null and v_prospect.type = 'indie_game_developer' then
    v_email := public.intel_norm_email(v_prospect.contact_email);
    if public._intel_is_protected_indie_entity(v_prospect.name, coalesce(nullif(v_prospect.project_title, ''), v_prospect.facts #>> '{verified,project_title}', v_prospect.facts #>> '{verified,game}')) then
      raise exception 'outbound contact to protected Studio Kairegi account is blocked';
    end if;
    if v_prospect.status = 'suppressed'
       or coalesce(v_prospect.facts #>> '{verified,bounced}', 'false') = 'true'
       or coalesce(v_prospect.facts #>> '{verified,complained}', 'false') = 'true'
       or coalesce(v_prospect.facts #>> '{verified,complaint}', 'false') = 'true'
       or coalesce(v_prospect.facts #>> '{verified,unsubscribed}', 'false') = 'true'
       or coalesce(v_prospect.facts #>> '{verified,do_not_contact}', 'false') = 'true'
       or coalesce(v_prospect.facts #>> '{verified,suppressed}', 'false') = 'true'
       or exists (select 1 from public.intel_suppressions x where x.organization_id = v_prospect.organization_id
         and ((x.kind = 'email' and x.value = v_email and v_email <> '')
           or (x.kind = 'domain' and (x.value = public._intel_indie_domain(v_prospect.domain) or v_email like '%@' || x.value)))) then
      raise exception 'outbound contact to suppressed indie developer is blocked';
    end if;
    if coalesce(v_prospect.facts #>> '{verified,contactability,status}', '') <> 'pass'
       or v_email = ''
       or public.intel_norm_email(v_prospect.facts #>> '{verified,contactability,verified_email}') <> v_email
       or public.intel_norm_email(new.to_email) <> v_email
       or coalesce(v_prospect.facts #>> '{verified,contactability,evidence,source_url}', '') !~* '^https?://[^/[:space:]]*\.[^/[:space:]]+' then
      raise exception 'outbound indie contact requires exact-address verified contactability';
    end if;
    if new.kind <> 'reply' then
      if v_prospect.status not in ('qualified','lead_linked','contacted') then
        raise exception 'cold indie follow-up is blocked for a prospect outside an active qualified state';
      end if;
      v_gates := v_prospect.facts #> '{estimates,qualification_v2}';
      if coalesce(v_gates ->> 'model', '') <> 'indie-project-v2'
         or coalesce(v_prospect.score, 0) < 75
         or (select count(*) from jsonb_each(coalesce(v_gates -> 'mandatory_gates', '{}'::jsonb))) <> 7
         or exists (select 1 from jsonb_each(coalesce(v_gates -> 'mandatory_gates', '{}'::jsonb)) g where coalesce(g.value ->> 'passed', 'false') <> 'true') then
        raise exception 'outbound indie prospecting requires V2 score and all mandatory gates';
      end if;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists intel_block_protected_indie_outbound on public.intel_messages;
create trigger intel_block_protected_indie_outbound
before insert or update on public.intel_messages
for each row execute function public._intel_block_protected_indie_outbound();

-- Reconcile old approvals against current safety facts. CRM leads, messages and
-- conversation history are never deleted. Legacy qualified indie prospects are
-- moved to Needs Review until they are rescored under the V2 model.
update public.intel_prospects p set status = 'rejected', review_reason = 'Protected Studio Kairegi account', updated_at = now()
where p.type = 'indie_game_developer' and p.status <> 'rejected'
  and public._intel_is_protected_indie_entity(p.name, coalesce(nullif(p.project_title, ''), p.facts #>> '{verified,project_title}', p.facts #>> '{verified,game}'));

update public.intel_prospects p set status = 'suppressed', review_reason = 'Existing email/domain suppression conflict', updated_at = now()
where p.type = 'indie_game_developer' and p.status not in ('rejected','closed','suppressed')
  and exists (select 1 from public.intel_suppressions x where x.organization_id = p.organization_id
    and ((x.kind = 'email' and x.value = public.intel_norm_email(p.contact_email) and public.intel_norm_email(p.contact_email) <> '')
      or (x.kind = 'domain' and (x.value = public._intel_indie_domain(p.domain) or public.intel_norm_email(p.contact_email) like '%@' || x.value))));

update public.intel_prospects p set status = 'needs_review',
  review_reason = 'Legacy indie qualification must be re-evaluated under indie-project-v2', updated_at = now()
where p.type = 'indie_game_developer' and p.status = 'qualified';

-- This update fires the ordered project-fact sync trigger for existing rows.
update public.intel_prospects p set facts = p.facts
where p.type = 'indie_game_developer';

create or replace function public.intel_agent_set_score(
  p_prospect_id uuid, p_score int, p_breakdown jsonb, p_decision text,
  p_reason text default '', p_estimates jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.intel_agent_org();
  p public.intel_prospects;
  v_gates jsonb;
  v_gate_names text[] := array['project_identity','active_or_marketing_opportunity','anime_visual_identity','verified_usable_email','suppression_clear','protected_account_clear','sufficient_evidence'];
  v_gates_ok boolean := true;
  v_gate text;
  v_email text;
begin
  if p_decision not in ('qualified','needs_review','rejected') then raise exception 'bad decision'; end if;
  select * into p from public.intel_prospects where id = p_prospect_id and organization_id = v_org for update;
  if not found then raise exception 'prospect not found'; end if;
  if p.type = 'indie_game_developer' and p_decision = 'qualified' then
    v_gates := p_estimates #> '{qualification_v2,mandatory_gates}';
    if v_gates is null then raise exception 'indie V2 mandatory qualification gates are required'; end if;
    foreach v_gate in array v_gate_names loop
      if coalesce(v_gates -> v_gate ->> 'passed', 'false') <> 'true' then v_gates_ok := false; end if;
    end loop;
    v_email := public.intel_norm_email(p.contact_email);
    if not v_gates_ok then raise exception 'indie V2 mandatory qualification gates have not all passed'; end if;
    if coalesce(p_estimates #>> '{contactability,status}', '') <> 'pass'
       or coalesce(p.facts #>> '{verified,bounced}', 'false') = 'true'
       or coalesce(p.facts #>> '{verified,complained}', 'false') = 'true'
       or coalesce(p.facts #>> '{verified,complaint}', 'false') = 'true'
       or coalesce(p.facts #>> '{verified,unsubscribed}', 'false') = 'true'
       or coalesce(p.facts #>> '{verified,do_not_contact}', 'false') = 'true'
       or coalesce(p.facts #>> '{verified,suppressed}', 'false') = 'true'
       or v_email = ''
       or public.intel_norm_email(p_estimates #>> '{contactability,verified_email}') <> v_email then
      raise exception 'indie V2 exact-address contactability must pass';
    end if;
    if exists (select 1 from public.intel_suppressions s where s.organization_id = v_org and
      ((s.kind = 'email' and s.value = v_email and v_email <> '') or (s.kind = 'domain' and (s.value = public._intel_indie_domain(p.domain) or (v_email like '%@' || s.value))))) then
      raise exception 'indie V2 prospect has an active email or domain suppression';
    end if;
    if p_score < 75 then raise exception 'indie V2 qualification requires at least 75 points'; end if;
    if coalesce(p_estimates #>> '{qualification_v2,model}', '') <> 'indie-project-v2' then
      raise exception 'indie V2 qualification model version is required';
    end if;
  end if;
  update public.intel_prospects
     set score = least(100, greatest(0, p_score)), score_breakdown = coalesce(p_breakdown, '{}'::jsonb),
         status = case
           when p.type = 'indie_game_developer' and public._intel_is_protected_indie_entity(p.name, coalesce(nullif(p.project_title, ''), p.facts #>> '{verified,project_title}', p.facts #>> '{verified,game}')) then 'rejected'
           when p.type = 'indie_game_developer' and (coalesce(p_estimates #>> '{suppression,suppressed}', 'false') = 'true'
             or coalesce(p_estimates #>> '{suppression,bounced}', 'false') = 'true'
             or coalesce(p_estimates #>> '{suppression,complained}', 'false') = 'true') then 'suppressed'
           when status in ('suppressed','lead_linked','contacted','replied','closed') then status
           else p_decision end,
         review_reason = left(coalesce(p_reason, ''), 300),
         facts = case when p.type = 'indie_game_developer' then
           jsonb_set(
             jsonb_set(facts, '{estimates}', coalesce(facts -> 'estimates', '{}'::jsonb) || coalesce(p_estimates, '{}'::jsonb)),
             '{verified}', coalesce(facts -> 'verified', '{}'::jsonb) || jsonb_build_object(
               'contactability', coalesce(p_estimates -> 'contactability', facts #> '{verified,contactability}', '{}'::jsonb)), true)
           else jsonb_set(facts, '{estimates}', coalesce(p_estimates, '{}'::jsonb)) end,
         updated_at = now()
   where id = p_prospect_id and organization_id = v_org;
end $$;

-- The admin review button is not a way around mandatory gates or the 75-point bar.
-- Linking an already-existing CRM lead remains available for duplicate resolution.
create or replace function public.intel_admin_review_prospect(p_prospect_id uuid, p_action text, p_lead_id uuid default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.intel_admin_org();
  p public.intel_prospects;
  s public.intel_settings;
  v_lead uuid;
  v_gates jsonb;
  v_gate_names text[] := array['project_identity','active_or_marketing_opportunity','anime_visual_identity','verified_usable_email','suppression_clear','protected_account_clear','sufficient_evidence'];
  v_gate text;
  v_email text;
begin
  select * into p from public.intel_prospects where id = p_prospect_id and organization_id = v_org for update;
  if not found then raise exception 'prospect not found'; end if;
  select * into s from public.intel_settings where organization_id = v_org;
  if p.type = 'indie_game_developer' and p_action <> 'reject' then
    if public._intel_is_protected_indie_entity(p.name, coalesce(nullif(p.project_title, ''), p.facts #>> '{verified,project_title}', p.facts #>> '{verified,game}')) then
      raise exception 'protected Studio Kairegi account cannot be approved or linked';
    end if;
    if p.status = 'suppressed'
       or coalesce(p.facts #>> '{verified,bounced}', 'false') = 'true'
       or coalesce(p.facts #>> '{verified,complained}', 'false') = 'true'
       or coalesce(p.facts #>> '{verified,complaint}', 'false') = 'true'
       or coalesce(p.facts #>> '{verified,unsubscribed}', 'false') = 'true'
       or coalesce(p.facts #>> '{verified,do_not_contact}', 'false') = 'true'
       or coalesce(p.facts #>> '{verified,suppressed}', 'false') = 'true'
       or exists (select 1 from public.intel_suppressions x where x.organization_id = v_org
         and ((x.kind = 'email' and x.value = public.intel_norm_email(p.contact_email) and p.contact_email <> '')
           or (x.kind = 'domain' and (x.value = public._intel_indie_domain(p.domain) or public.intel_norm_email(p.contact_email) like '%@' || x.value)))) then
      raise exception 'suppressed indie prospect cannot be approved or linked';
    end if;
  end if;
  if p_action in ('approve','create_new','use_lead') and p.type = 'indie_game_developer' then
    if coalesce(p.facts #>> '{estimates,qualification_v2,model}', '') <> 'indie-project-v2' then
      raise exception 'indie V2 qualification model version is required';
    end if;
    v_gates := p.facts #> '{estimates,qualification_v2,mandatory_gates}';
    if v_gates is null then raise exception 'indie V2 qualification has not been completed'; end if;
    foreach v_gate in array v_gate_names loop
      if coalesce(v_gates -> v_gate ->> 'passed', 'false') <> 'true' then
        raise exception 'indie V2 mandatory gate failed: %', v_gate;
      end if;
    end loop;
    if p.score is null or p.score < 75 then raise exception 'indie V2 prospect must score at least 75 before approval'; end if;
    if public._intel_is_protected_indie_entity(p.name, coalesce(nullif(p.project_title, ''), p.facts #>> '{verified,project_title}', p.facts #>> '{verified,game}')) then raise exception 'protected Studio Kairegi account cannot be approved'; end if;
    if coalesce(p.facts #>> '{estimates,qualification_v2,contactability,status}', p.facts #>> '{estimates,contactability,status}', '') <> 'pass' then
      raise exception 'indie V2 contactability must pass before approval';
    end if;
    v_email := public.intel_norm_email(p.contact_email);
    if exists (select 1 from public.intel_suppressions x where x.organization_id = v_org and
      ((x.kind = 'email' and x.value = v_email and v_email <> '') or (x.kind = 'domain' and (x.value = public._intel_indie_domain(p.domain) or v_email like '%@' || x.value)))) then
      raise exception 'indie V2 prospect is suppressed';
    end if;
  end if;
  if p_action = 'approve' then
    update public.intel_prospects set status = 'qualified', review_reason = '', updated_at = now() where id = p.id;
  elsif p_action = 'reject' then
    if p.type = 'indie_game_developer' and p.status = 'suppressed' then
      update public.intel_prospects set review_reason = 'Suppression preserved; prospect remains suppressed', updated_at = now() where id = p.id;
    else
      update public.intel_prospects set status = 'rejected', updated_at = now() where id = p.id;
    end if;
  elsif p_action = 'use_lead' then
    if not exists (select 1 from public.leads l where l.id = p_lead_id and l.user_id = s.owner_user_id) then raise exception 'lead not found'; end if;
    update public.intel_prospects set lead_id = p_lead_id, status = 'lead_linked', review_reason = '', updated_at = now() where id = p.id;
    v_lead := p_lead_id;
  elsif p_action = 'create_new' then
    -- Force the same database qualification trigger used by the normal worker
    -- path before any new CRM lead is created.
    if p.type = 'indie_game_developer' then
      update public.intel_prospects set status = 'qualified', updated_at = now() where id = p.id;
    end if;
    v_lead := public._intel_create_ai_lead(v_org, p.id, auth.uid());
  else
    raise exception 'unknown action';
  end if;
  perform public._intel_log(v_org, 'admin', 'review_prospect_' || p_action, 'prospect', p.id::text, jsonb_build_object('lead_id', v_lead));
  return jsonb_build_object('ok', true, 'lead_id', v_lead);
end $$;

-- Indie qualification context includes immutable evidence row IDs. This dedicated
-- RPC avoids depending on the later general-context migration's rollout ordering.
create or replace function public.intel_agent_indie_context(p_prospect_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org();
begin
  return (select jsonb_build_object(
      'prospect', to_jsonb(p),
      'evidence', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'source', e.source, 'url', e.url,
        'fact_type', e.fact_type, 'snippet', e.snippet, 'verified', e.verified) order by e.fetched_at, e.id)
        from public.intel_evidence e where e.prospect_id = p.id), '[]'::jsonb))
    from public.intel_prospects p where p.id = p_prospect_id and p.organization_id = v_org and p.type = 'indie_game_developer');
end $$;

-- Dedicated indie lookup: the later, existing contactability RPC remains unchanged
-- for Animation Studio Support and its pre-existing bounce/complaint semantics.
create or replace function public.intel_agent_mark_indie_blocked(p_prospect_id uuid, p_status text, p_reason text) returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_org uuid := public.intel_agent_org();
begin
  if coalesce(p_status, '') not in ('rejected','suppressed') then raise exception 'invalid indie blocked status'; end if;
  update public.intel_prospects set status = p_status, review_reason = left(coalesce(p_reason, ''), 300), updated_at = now()
   where id = p_prospect_id and organization_id = v_org and type = 'indie_game_developer';
  if not found then raise exception 'indie prospect not found'; end if;
end $$;

create or replace function public.intel_agent_indie_suppression_facts(p_email text default '', p_domain text default '')
returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.intel_agent_org();
  v_email text := public.intel_norm_email(p_email);
  v_domain text := public._intel_indie_domain(p_domain);
  v_bounced boolean;
  v_complained boolean;
  v_suppressed boolean;
  v_reason text;
begin
  select
    coalesce(bool_or(lower(reason) like '%bounce%'), false),
    coalesce(bool_or(lower(reason) like '%complaint%'), false),
    coalesce(bool_or(true), false),
    string_agg(distinct nullif(reason, ''), '; ')
  into v_bounced, v_complained, v_suppressed, v_reason
  from public.intel_suppressions
  where organization_id = v_org
    and (
      (kind = 'email' and value = v_email and v_email <> '')
      or (kind = 'domain' and (value = v_domain or v_email like '%@' || value))
    );
  return jsonb_build_object('bounced', v_bounced, 'complained', v_complained,
    'suppressed', v_suppressed, 'suppression_reason', coalesce(v_reason, ''));
end $$;

revoke all on function public._intel_try_project_date(text) from public, anon, authenticated;
revoke all on function public._intel_indie_domain(text) from public, anon, authenticated;
revoke all on function public._intel_sync_project_facts() from public, anon, authenticated;
revoke all on function public._intel_is_protected_indie_entity(text,text) from public, anon, authenticated;
revoke all on function public._intel_enforce_indie_qualification_status() from public, anon, authenticated;
revoke all on function public._intel_block_protected_indie_outbound() from public, anon, authenticated;
revoke all on function public.intel_agent_set_score(uuid,int,jsonb,text,text,jsonb) from public, anon;
grant execute on function public.intel_agent_set_score(uuid,int,jsonb,text,text,jsonb) to authenticated;
revoke all on function public.intel_admin_review_prospect(uuid,text,uuid) from public, anon;
grant execute on function public.intel_admin_review_prospect(uuid,text,uuid) to authenticated;
revoke all on function public.intel_agent_indie_context(uuid) from public, anon;
grant execute on function public.intel_agent_indie_context(uuid) to authenticated;
revoke all on function public.intel_agent_indie_suppression_facts(text,text) from public, anon;
grant execute on function public.intel_agent_indie_suppression_facts(text,text) to authenticated;
revoke all on function public.intel_agent_mark_indie_blocked(uuid,text,text) from public, anon;
grant execute on function public.intel_agent_mark_indie_blocked(uuid,text,text) to authenticated;

commit;
