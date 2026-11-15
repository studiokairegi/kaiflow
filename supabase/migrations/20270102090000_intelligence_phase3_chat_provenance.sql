-- Phase 3: per-message AI provenance for Agent Chat (finding P1-04). Additive only: nullable columns, no data is rewritten.
-- Which provider and exact model produced each assistant answer, why Ollama served it when it did, how long it took, which approved
-- knowledge-base entries were quoted, and whether the answer was AI-written at all (ai) or a deterministic fallback / draft-handler / error text.
-- No prompt text, history or key is ever stored here.
-- ROLLBACK (manual, only if needed): restore the 4-argument function from 20261109140000_intelligence_v1_completion.sql, then
--   alter table public.intel_chat_messages drop column if exists ai_provider, drop column if exists ai_model, drop column if exists ai_route_reason,
--     drop column if exists ai_latency_ms, drop column if exists ai_mode, drop column if exists kb_keys;
-- The worker tolerates the old function: if p_meta is rejected it saves the answer without provenance.

alter table public.intel_chat_messages
  add column if not exists ai_provider text check (ai_provider is null or ai_provider in ('gemini', 'ollama')),
  add column if not exists ai_model text check (ai_model is null or char_length(ai_model) <= 80),
  add column if not exists ai_route_reason text check (ai_route_reason is null or char_length(ai_route_reason) <= 60),
  add column if not exists ai_latency_ms integer check (ai_latency_ms is null or ai_latency_ms >= 0),
  add column if not exists ai_mode text check (ai_mode is null or ai_mode in ('ai', 'deterministic_fallback', 'draft_handler', 'unavailable')),
  add column if not exists kb_keys text[];

-- PostgREST cannot choose between a 4-argument function and a 5-argument one with a default, so the old signature is replaced, not overloaded.
drop function if exists public.intel_agent_chat_reply(uuid, bigint, text, text);

create or replace function public.intel_agent_chat_reply(p_thread_id uuid, p_message_id bigint, p_text text, p_status text default 'done', p_meta jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_org uuid := public.intel_agent_org(); t public.intel_chat_threads;
  m jsonb := case when jsonb_typeof(p_meta) = 'object' then p_meta else '{}'::jsonb end;
  v_kb text[];
begin
  select * into t from public.intel_chat_threads where id = p_thread_id and organization_id = v_org;
  if not found then raise exception 'thread not found'; end if;
  if p_status not in ('done', 'error') then raise exception 'bad status'; end if;
  if not exists (select 1 from public.intel_chat_messages x where x.id = p_message_id and x.thread_id = t.id and x.role = 'user') then raise exception 'message not found'; end if;
  if jsonb_typeof(m -> 'kb_keys') = 'array' then
    select array_agg(left(e, 80)) into v_kb from (select e from jsonb_array_elements_text(m -> 'kb_keys') e limit 10) s;
  end if;
  insert into public.intel_chat_messages(thread_id, organization_id, role, content, status, reply_to,
                                          ai_provider, ai_model, ai_route_reason, ai_latency_ms, ai_mode, kb_keys)
  values (t.id, v_org, 'assistant', left(coalesce(p_text, ''), 8000), p_status, p_message_id,
          case when m ->> 'provider' in ('gemini', 'ollama') then m ->> 'provider' end,
          left(m ->> 'model', 80),
          left(m ->> 'route_reason', 60),
          case when (m ->> 'latency_ms') ~ '^\d{1,8}$' then least((m ->> 'latency_ms')::int, 3600000) end,
          case when m ->> 'mode' in ('ai', 'deterministic_fallback', 'draft_handler', 'unavailable') then m ->> 'mode' end,
          v_kb)
  on conflict (thread_id, reply_to) where role = 'assistant' and reply_to is not null do nothing;
  update public.intel_chat_threads set updated_at = now() where id = t.id;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.intel_agent_chat_reply(uuid, bigint, text, text, jsonb) from public, anon;
grant execute on function public.intel_agent_chat_reply(uuid, bigint, text, text, jsonb) to authenticated;
