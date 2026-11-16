-- Client language for contracts (English / Japanese). Run once in the Supabase SQL editor,
-- AFTER migration_client_contracts.sql. Safe to re-run. Runs as ONE transaction: if any statement fails nothing is
-- changed (in particular the old create_client_contract is not left dropped). Rollback: migration_contract_language.rollback.sql.
--
--  * client_contracts.language        what the signer receives: signing page, key terms, signed PDF.
--                                     Set when the contract is created and frozen with it (like the body).
--  * contract_templates.body_ja /     the studio's own Japanese template text and governing-law wording.
--    governing_law_ja                 Empty = the app uses its built-in Japanese template.
--
-- Existing contracts become 'en', exactly how they behaved before. Only the database decides which language a
-- contract carries: an unknown value is refused. The old 10-argument create_client_contract call still works
-- (p_language defaults to 'en'), so the previous frontend keeps working after this migration.

begin;

do $$
begin
  if to_regclass('public.client_contracts') is null then
    raise exception 'Run migration_client_contracts.sql first (client_contracts does not exist).';
  end if;
end
$$;

alter table client_contracts add column if not exists language text not null default 'en';
alter table contract_templates add column if not exists body_ja text not null default '';
alter table contract_templates add column if not exists governing_law_ja text not null default '';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'client_contracts_language_check' and conrelid = 'public.client_contracts'::regclass) then
    alter table client_contracts add constraint client_contracts_language_check check (language in ('en', 'ja'));
  end if;
end
$$;

-- What the signer's browser receives now includes the language.
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
    'consent_text', r.consent_text, 'signer_ip', r.signer_ip,
    'language', r.language)
$$;

-- The return type is unchanged but the argument list gains p_language: replace the old function rather than
-- overloading it (an overload would make named-argument RPC calls ambiguous).
drop function if exists create_client_contract(uuid, uuid, text, text, jsonb, text, text, text, text, int);

create or replace function create_client_contract(
  p_contact_id uuid, p_project_id uuid, p_title text, p_body text, p_terms jsonb,
  p_signer_name text, p_signer_email text, p_studio_name text, p_studio_signatory text,
  p_expires_days int default 30, p_language text default 'en'
) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare v_token text; v_id uuid; v_proj_contact uuid; v_lang text;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  v_lang := lower(coalesce(nullif(btrim(p_language), ''), 'en'));
  if v_lang not in ('en', 'ja') then raise exception 'Unsupported contract language'; end if;
  if not exists (select 1 from contacts where id = p_contact_id and user_id = auth.uid()) then
    raise exception 'Client not found';
  end if;
  -- FOR UPDATE: two simultaneous creates for one project queue here, so the second voids the first instead of both
  -- ending up open.
  select contact_id into v_proj_contact from projects where id = p_project_id and user_id = auth.uid() for update;
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
                                signer_email, expires_at, language)
  values (auth.uid(), p_contact_id, p_project_id,
          coalesce(nullif(btrim(p_title), ''), case when v_lang = 'ja' then '業務委託契約書' else 'Services Agreement' end),
          p_body, _nda_hash(p_body), coalesce(p_terms, '{}'::jsonb), _nda_hash(v_token),
          coalesce(p_studio_name, ''), coalesce(btrim(p_studio_signatory), ''),
          btrim(p_signer_name), coalesce(btrim(p_signer_email), ''),
          now() + make_interval(days => greatest(1, least(coalesce(p_expires_days, 30), 365))),
          v_lang)
  returning id into v_id;

  insert into contract_events (contract_id, user_id, event) values (v_id, auth.uid(), 'created');
  return json_build_object('id', v_id, 'token', v_token);
end $$;

revoke all on function create_client_contract(uuid,uuid,text,text,jsonb,text,text,text,text,int,text) from public, anon;
grant execute on function create_client_contract(uuid,uuid,text,text,jsonb,text,text,text,text,int,text) to authenticated;

commit;
