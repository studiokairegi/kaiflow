-- ROLLBACK for migration_contract_language.sql.
-- Restores the original create_client_contract (10 arguments) and _contract_public_json (no language), then removes
-- the language columns.
-- DATA LOSS: each contract's language and the studio's Japanese template text are discarded. The text of a Japanese
-- contract that was already sent or signed is NOT deleted (it lives in client_contracts.body), but after the
-- rollback its signing page and PDF are shown with the English layout.
-- Roll the frontend back FIRST (the new frontend sends p_language and reads the language column).
-- Safe to re-run.

begin;

drop function if exists create_client_contract(uuid, uuid, text, text, jsonb, text, text, text, text, int, text);

create or replace function create_client_contract(
  p_contact_id uuid, p_project_id uuid, p_title text, p_body text, p_terms jsonb,
  p_signer_name text, p_signer_email text, p_studio_name text, p_studio_signatory text,
  p_expires_days int default 30
) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare v_token text; v_id uuid; v_proj_contact uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not exists (select 1 from contacts where id = p_contact_id and user_id = auth.uid()) then
    raise exception 'Client not found';
  end if;
  select contact_id into v_proj_contact from projects where id = p_project_id and user_id = auth.uid();
  if not found then raise exception 'Project not found'; end if;
  if v_proj_contact is not null and v_proj_contact <> p_contact_id then
    raise exception 'That project belongs to a different client';
  end if;
  if coalesce(btrim(p_body), '') = '' then raise exception 'Contract text is empty'; end if;
  if coalesce(btrim(p_signer_name), '') = '' then raise exception 'Signer name is required'; end if;

  -- A contract is tied to the project it was written for: link the project to this client.
  if v_proj_contact is null then
    update projects set contact_id = p_contact_id where id = p_project_id and user_id = auth.uid();
  end if;

  -- one open contract per project: a new link replaces any unsigned one
  update client_contracts set status = 'voided', voided_at = now()
   where project_id = p_project_id and user_id = auth.uid() and status in ('sent','viewed');

  v_token := encode(gen_random_bytes(32), 'hex');
  insert into client_contracts (user_id, contact_id, project_id, title, body, body_hash, terms,
                                token_hash, studio_name, studio_signatory, signer_name,
                                signer_email, expires_at)
  values (auth.uid(), p_contact_id, p_project_id,
          coalesce(nullif(btrim(p_title), ''), 'Services Agreement'),
          p_body, _nda_hash(p_body), coalesce(p_terms, '{}'::jsonb), _nda_hash(v_token),
          coalesce(p_studio_name, ''), coalesce(btrim(p_studio_signatory), ''),
          btrim(p_signer_name), coalesce(btrim(p_signer_email), ''),
          now() + make_interval(days => greatest(1, least(coalesce(p_expires_days, 30), 365))))
  returning id into v_id;

  insert into contract_events (contract_id, user_id, event) values (v_id, auth.uid(), 'created');
  return json_build_object('id', v_id, 'token', v_token);
end $$;

create or replace function _contract_public_json(r client_contracts) returns json
language sql stable as $$
  select json_build_object(
    'id', r.id, 'status', r.status, 'title', r.title, 'body', r.body,
    'body_hash', r.body_hash, 'terms', r.terms, 'studio_name', r.studio_name,
    'studio_signatory', r.studio_signatory,
    'signer_name', r.signer_name, 'signer_email', r.signer_email,
    'expires_at', r.expires_at, 'created_at', r.created_at,
    'signed_at', r.signed_at, 'typed_name', r.typed_name,
    'signature_png', r.signature_png, 'signature_method', r.signature_method,
    'consent_text', r.consent_text, 'signer_ip', r.signer_ip)
$$;

revoke all on function create_client_contract(uuid,uuid,text,text,jsonb,text,text,text,text,int) from public, anon;
grant execute on function create_client_contract(uuid,uuid,text,text,jsonb,text,text,text,text,int) to authenticated;

alter table client_contracts drop constraint if exists client_contracts_language_check;
alter table client_contracts drop column if exists language;
alter table contract_templates drop column if exists body_ja;
alter table contract_templates drop column if exists governing_law_ja;

commit;
