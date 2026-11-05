-- Read-only, organization-scoped audit feed for Intelligence sends made through Resend.
-- The Edge Function performs the provider-side GET using its server-only RESEND_API_KEY.
-- This RPC returns only KairFlow's own sent records; it never changes message state or sends mail.
begin;

do $$ begin
  if to_regprocedure('public.intel_admin_org()') is null
     or to_regclass('public.intel_messages') is null then
    raise exception 'Apply the Intelligence core/RPC migrations before the Resend audit migration';
  end if;
end $$;

create or replace function public.intel_admin_resend_recent_sent(p_limit int default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org uuid := public.intel_admin_org();
begin
  -- intel_admin_org() enforces an authenticated, authorized active Master User.
  -- Keep the organization predicate explicit because SECURITY DEFINER bypasses table RLS.
  return coalesce((
    select jsonb_agg(to_jsonb(r) order by r.sent_at desc nulls last, r.id)
      from (
        select m.id, m.state, m.sent_at, m.provider_message_id
          from public.intel_messages m
         where m.organization_id = v_org
           and m.direction = 'outbound'
           and m.state = 'sent'
         order by m.sent_at desc nulls last, m.created_at desc
         limit greatest(1, least(coalesce(p_limit, 20), 100))
      ) r
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.intel_admin_resend_recent_sent(int) from public, anon;
grant execute on function public.intel_admin_resend_recent_sent(int) to authenticated;

commit;
