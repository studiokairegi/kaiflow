create or replace function public.intel_admin_mark_prospect_review(
  p_prospect_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_org uuid := public.intel_admin_org();
  p public.intel_prospects;
begin
  select *
    into p
    from public.intel_prospects
   where id = p_prospect_id
     and organization_id = v_org
   for update;

  if not found then
    raise exception 'prospect not found';
  end if;

  if p.status not in ('discovered', 'researched') then
    raise exception 'prospect status cannot be manually changed to needs_review';
  end if;

  update public.intel_prospects
     set status = 'needs_review',
         review_reason = 'Manually flagged for review',
         updated_at = now()
   where id = p.id
     and organization_id = v_org;

  perform public._intel_log(
    v_org,
    'admin',
    'mark_prospect_for_review',
    'prospect',
    p.id::text,
    jsonb_build_object(
      'previous_status', p.status,
      'new_status', 'needs_review'
    )
  );

  return jsonb_build_object('ok', true);
end
$function$;

revoke all on function public.intel_admin_mark_prospect_review(uuid) from public;
revoke all on function public.intel_admin_mark_prospect_review(uuid) from anon;
grant execute on function public.intel_admin_mark_prospect_review(uuid) to authenticated;