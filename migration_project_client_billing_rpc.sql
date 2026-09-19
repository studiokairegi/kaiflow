-- =========================================================================
-- Extend create_project_with_shots for client billing details
-- =========================================================================
-- migration_billing_details.sql added projects.client_address and
-- projects.client_tax_id (billing details printed on that client's
-- invoices, under "Bill to"), but the atomic project-creation RPC from
-- migration_audit_fixes_8.sql predates those columns and never set them,
-- so a project created through the "New project" form (which always goes
-- through this RPC) silently dropped anything typed into those two
-- fields.
--
-- IMPORTANT: in PostgreSQL a different argument list is a different function,
-- so CREATE OR REPLACE below does NOT replace the eleven-argument version
-- from migration_audit_fixes_8.sql - it would sit next to it as an overload
-- (and a call with only the original eleven named args would then match both
-- candidates and fail as ambiguous, rather than reach the new one). The old
-- signature is therefore dropped explicitly first. This migration must run
-- AFTER migration_audit_fixes_8.sql, which (re)creates the eleven-argument
-- form; see README.md for the order.
drop function if exists public.create_project_with_shots(
  text, text, text, text, text, text, text, text, boolean, text, integer
);

create or replace function public.create_project_with_shots(
  p_name text,
  p_client text,
  p_notes text,
  p_budget text,
  p_budget_mode text,
  p_currency text,
  p_deadline text,
  p_priority text,
  p_share_enabled boolean,
  p_share_token text,
  p_shot_count int,
  p_client_address text default '',
  p_client_tax_id text default ''
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_project projects%rowtype;
  v_shots jsonb;
  v_total int := greatest(0, least(500, coalesce(p_shot_count, 0)));
  v_pad int := greatest(2, length(v_total::text));
begin
  insert into projects (
    name, client, client_address, client_tax_id, notes, budget, budget_mode, currency, deadline, priority,
    share_enabled, share_token, user_id
  ) values (
    coalesce(p_name, 'Untitled project'), coalesce(p_client, ''), coalesce(p_client_address, ''),
    coalesce(p_client_tax_id, ''), p_notes, coalesce(p_budget, ''),
    coalesce(p_budget_mode, 'manual'), coalesce(p_currency, '$'), nullif(p_deadline, ''),
    coalesce(p_priority, 'normal'), coalesce(p_share_enabled, false), p_share_token, auth.uid()
  )
  returning * into v_project;

  if v_total > 0 then
    insert into shots (project_id, title, client, rate, due, priority, notes, stage, user_id)
    select
      v_project.id,
      'Cut ' || lpad(gs::text, v_pad, '0'),
      coalesce(p_client, ''),
      '', '', 'normal', '',
      'character_design',
      auth.uid()
    from generate_series(1, v_total) as gs;
  end if;

  select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) into v_shots from shots s where s.project_id = v_project.id;

  return jsonb_build_object('project', to_jsonb(v_project), 'shots', v_shots);
end;
$$;

revoke all on function public.create_project_with_shots(text,text,text,text,text,text,text,text,boolean,text,int,text,text) from public;
grant execute on function public.create_project_with_shots(text,text,text,text,text,text,text,text,boolean,text,int,text,text) to authenticated;
